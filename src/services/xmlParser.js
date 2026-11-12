import sax from 'sax';
import { pool } from '../db/index.js';
import { normalizeRow } from './normalizer.js';
import { ensureProvenanceColumns } from '../db/ingestionHelpers.js';

/**
 * XML Streaming Parser Service (Milestone B4.1 PR 2)
 *
 * Safely streams large XML feeds using a SAX parser to prevent memory exhaustion.
 * Extracts repeating item nodes based on `dialect_config.item_node_path` (or sensible defaults:
 * 'product', 'item', 'article', 'record', 'artikel', 'row').
 *
 * Provenance Mapping:
 * Maps the structural XML node path (e.g. '/catalog/products/product') directly to the
 * `source_metadata` JSONB column in `normalized_records`.
 */

/**
 * Determines whether a given open tag matches the item node selector.
 *
 * @param {string} nodeName - Current XML element tag name
 * @param {string} fullPath - Current slash-delimited tag path (e.g. '/catalog/products/product')
 * @param {string} [configuredPath] - Configured dialect_config.item_node_path
 * @returns {boolean}
 */
export function isItemNodeMatch(nodeName, fullPath, configuredPath) {
  if (configuredPath && typeof configuredPath === 'string') {
    const cleanConfig = configuredPath.replace(/^\/+|\/+$/g, '').toLowerCase();
    const cleanFull = fullPath.replace(/^\/+|\/+$/g, '').toLowerCase();

    if (cleanFull === cleanConfig || cleanFull.endsWith('/' + cleanConfig)) {
      return true;
    }
    if (!cleanConfig.includes('/') && nodeName.toLowerCase() === cleanConfig) {
      return true;
    }
    return false;
  }

  const defaultTags = ['product', 'item', 'article', 'record', 'artikel', 'row'];
  return defaultTags.includes(nodeName.toLowerCase());
}

/**
 * Parses an XML stream or buffer into an array of standardized JSON row objects
 * without inserting into the database (useful for unit testing or direct transformations).
 *
 * @param {import('stream').Readable|Buffer|string} streamOrTarget
 * @param {Object} [options]
 * @param {string} [options.itemNodePath] - Configured item node path (e.g. 'products/product')
 * @returns {Promise<Array<Object>>}
 */
export async function parseXmlStream(streamOrTarget, options = {}) {
  const configuredPath = options.itemNodePath || null;
  const records = [];

  let stream;
  if (Buffer.isBuffer(streamOrTarget) || typeof streamOrTarget === 'string') {
    const { Readable } = await import('stream');
    stream = Readable.from(Buffer.from(streamOrTarget));
  } else if (streamOrTarget && typeof streamOrTarget.pipe === 'function') {
    stream = streamOrTarget;
  } else {
    throw new Error('Invalid streamOrTarget passed to parseXmlStream');
  }

  return new Promise((resolve, reject) => {
    const parser = sax.createStream(true, { trim: true });

    const tagStack = [];
    let insideItem = false;
    let itemDepth = 0;
    let itemNodePath = '';
    let currentItem = null;
    let currentChildTag = null;

    stream.on('error', (err) => reject(err));
    parser.on('error', (err) => reject(err));

    parser.on('opentag', (node) => {
      tagStack.push(node.name);
      const currentPath = '/' + tagStack.join('/');

      if (!insideItem && isItemNodeMatch(node.name, currentPath, configuredPath)) {
        insideItem = true;
        itemDepth = tagStack.length;
        itemNodePath = currentPath;
        currentItem = {};

        // Merge any attributes on the item node (e.g. <product id="123" sku="ABC">)
        if (node.attributes && typeof node.attributes === 'object') {
          for (const [k, v] of Object.entries(node.attributes)) {
            currentItem[k.trim()] = typeof v === 'string' ? v.trim() : v;
          }
        }
      } else if (insideItem) {
        currentChildTag = node.name;
        // Merge child attributes if present
        if (node.attributes && typeof node.attributes === 'object') {
          for (const [k, v] of Object.entries(node.attributes)) {
            if (!currentItem[k]) {
              currentItem[k] = typeof v === 'string' ? v.trim() : v;
            }
          }
        }
      }
    });

    parser.on('text', (text) => {
      if (!insideItem || !currentChildTag) return;
      const trimmed = text.trim();
      if (!trimmed) return;

      const existing = currentItem[currentChildTag];
      currentItem[currentChildTag] = existing ? `${existing} ${trimmed}` : trimmed;
    });

    parser.on('closetag', (_tagName) => {
      if (insideItem && tagStack.length === itemDepth) {
        insideItem = false;
        if (currentItem) {
          currentItem._nodePath = itemNodePath;
          records.push(currentItem);
        }
        currentItem = null;
        currentChildTag = null;
      } else if (insideItem && tagStack.length > itemDepth) {
        currentChildTag = null;
      }
      tagStack.pop();
    });

    parser.on('end', () => {
      resolve(records);
    });

    stream.pipe(parser);
  });
}

/**
 * Ingests an XML stream line-by-line using a streaming SAX parser, normalizes each item,
 * maps the XML node path to `source_column`, triages invalid items, and executes chunked
 * batch inserts (500 rows at a time).
 *
 * Enforces strict metric consistency in `ingestion_runs`:
 * - total_rows === valid_rows + failed_rows
 * - status: 'PROCESSING' -> 'COMPLETED' | 'FAILED'
 *
 * @param {import('stream').Readable|Buffer|string} streamOrTarget - Input XML stream or buffer
 * @param {Object|string} source - Source DB record or configuration
 * @param {string} merchantId - Tenant merchant UUID
 * @param {string} [runId] - Optional existing ingestion_runs UUID
 * @returns {Promise<{ runId: string, totalRows: number, validRows: number, failedRows: number }>}
 */
export async function ingestXmlStream(streamOrTarget, source, merchantId, runId) {
  const dialect = (typeof source === 'object' && source !== null)
    ? (source.dialect_config || {})
    : {};

  const sourceId = (typeof source === 'object' && source !== null)
    ? (source.id || source.source_id || null)
    : (typeof source === 'string' ? source : null);

  const configuredPath = dialect.item_node_path || null;

  // Ensure provenance columns exist in normalized_records
  await ensureProvenanceColumns();

  // 1. Ensure ingestion_runs record exists and is in 'PROCESSING' state
  if (!runId) {
    const runRes = await pool.query(
      `INSERT INTO ingestion_runs (source_id, merchant_id, status, started_at)
       VALUES ($1, $2, 'PROCESSING', NOW())
       RETURNING id`,
      [sourceId, merchantId]
    );
    runId = runRes.rows[0].id;
  }

  const BATCH_SIZE = 500;
  let cleanBatch = [];
  let flaggedBatch = [];

  let totalRows = 0;
  let validRowsCount = 0;
  let failedRowsCount = 0;
  let rowIndex = 0;

  // Chunked batch flush for valid normalized records (including source_metadata provenance)
  const flushCleanBatch = async () => {
    if (cleanBatch.length === 0) return;
    const batch = [...cleanBatch];
    cleanBatch = [];

    const values = [];
    const placeholders = [];
    let paramIndex = 1;

    for (const rec of batch) {
      placeholders.push(
        `($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++})`
      );
      values.push(
        runId,
        merchantId,
        rec.sku,
        rec.name,
        rec.price,
        rec.currency || 'EUR',
        rec.ean,
        rec.unit_value,
        rec.unit_type,
        JSON.stringify(rec.raw_data),
        JSON.stringify(rec.source_metadata || {})
      );
    }

    const query = `
      INSERT INTO normalized_records (
        run_id, merchant_id, sku, name, price, currency, ean, unit_value, unit_type, raw_data, source_metadata
      ) VALUES ${placeholders.join(', ')}
    `;
    await pool.query(query, values);
  };

  // Chunked batch flush for invalid flagged records
  const flushFlaggedBatch = async () => {
    if (flaggedBatch.length === 0) return;
    const batch = [...flaggedBatch];
    flaggedBatch = [];

    const values = [];
    const placeholders = [];
    let paramIndex = 1;

    for (const rec of batch) {
      placeholders.push(
        `($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++})`
      );
      values.push(
        runId,
        merchantId,
        rec.row_index,
        JSON.stringify(rec.raw_row),
        JSON.stringify(rec.error_reasons)
      );
    }

    const query = `
      INSERT INTO flagged_records (
        run_id, merchant_id, row_index, raw_row, error_reasons
      ) VALUES ${placeholders.join(', ')}
    `;
    await pool.query(query, values);
  };

  let stream;
  if (Buffer.isBuffer(streamOrTarget) || typeof streamOrTarget === 'string') {
    const { Readable } = await import('stream');
    stream = Readable.from(Buffer.from(streamOrTarget));
  } else if (streamOrTarget && typeof streamOrTarget.pipe === 'function') {
    stream = streamOrTarget;
  } else {
    throw new Error('Invalid streamOrTarget passed to ingestXmlStream');
  }

  return new Promise((resolve, reject) => {
    const parser = sax.createStream(true, { trim: true });

    const tagStack = [];
    let insideItem = false;
    let itemDepth = 0;
    let itemNodePath = '';
    let currentItem = null;
    let currentChildTag = null;
    let isFlushing = false;

    const cleanup = (err) => {
      (async () => {
        try {
          await pool.query(
            `UPDATE ingestion_runs 
             SET status = 'FAILED',
                 finished_at = NOW(),
                 total_rows = $1,
                 valid_rows = $2,
                 failed_rows = $3,
                 error_message = $4
             WHERE id = $5`,
            [totalRows, validRowsCount, failedRowsCount, err.message, runId]
          );
        } catch (dbErr) {
          console.error('Failed to update ingestion_run status to FAILED for XML:', dbErr);
        }
        reject(err);
      })();
    };

    stream.on('error', cleanup);
    parser.on('error', cleanup);

    parser.on('opentag', (node) => {
      tagStack.push(node.name);
      const currentPath = '/' + tagStack.join('/');

      if (!insideItem && isItemNodeMatch(node.name, currentPath, configuredPath)) {
        insideItem = true;
        itemDepth = tagStack.length;
        itemNodePath = currentPath;
        currentItem = {};

        if (node.attributes && typeof node.attributes === 'object') {
          for (const [k, v] of Object.entries(node.attributes)) {
            currentItem[k.trim()] = typeof v === 'string' ? v.trim() : v;
          }
        }
      } else if (insideItem) {
        currentChildTag = node.name;
        if (node.attributes && typeof node.attributes === 'object') {
          for (const [k, v] of Object.entries(node.attributes)) {
            if (!currentItem[k]) {
              currentItem[k] = typeof v === 'string' ? v.trim() : v;
            }
          }
        }
      }
    });

    parser.on('text', (text) => {
      if (!insideItem || !currentChildTag) return;
      const trimmed = text.trim();
      if (!trimmed) return;

      const existing = currentItem[currentChildTag];
      currentItem[currentChildTag] = existing ? `${existing} ${trimmed}` : trimmed;
    });

    parser.on('closetag', (_tagName) => {
      if (insideItem && tagStack.length === itemDepth) {
        insideItem = false;
        rowIndex++;
        totalRows++;

        const rowToEvaluate = { ...currentItem };
        const evaluated = normalizeRow(rowToEvaluate);

        if (evaluated.isValid) {
          validRowsCount++;
          cleanBatch.push({
            ...evaluated.normalized,
            source_metadata: { xml_path: itemNodePath }
          });
        } else {
          failedRowsCount++;
          flaggedBatch.push({
            row_index: rowIndex,
            raw_row: rowToEvaluate,
            error_reasons: evaluated.reasons
          });
        }

        currentItem = null;
        currentChildTag = null;

        // Check batch size thresholds with parser backpressure pause/resume
        if (cleanBatch.length >= BATCH_SIZE || flaggedBatch.length >= BATCH_SIZE) {
          if (!isFlushing) {
            isFlushing = true;
            parser.pause();
            Promise.all([flushCleanBatch(), flushFlaggedBatch()])
              .then(() => {
                isFlushing = false;
                parser.resume();
              })
              .catch(cleanup);
          }
        }
      } else if (insideItem && tagStack.length > itemDepth) {
        currentChildTag = null;
      }
      tagStack.pop();
    });

    parser.on('end', () => {
      (async () => {
        try {
          await flushCleanBatch();
          await flushFlaggedBatch();

          if (totalRows !== validRowsCount + failedRowsCount) {
            throw new Error(`Metric mismatch: total_rows (${totalRows}) !== valid (${validRowsCount}) + failed (${failedRowsCount})`);
          }

          await pool.query(
            `UPDATE ingestion_runs 
             SET status = 'COMPLETED',
                 finished_at = NOW(),
                 total_rows = $1,
                 valid_rows = $2,
                 failed_rows = $3
             WHERE id = $4`,
            [totalRows, validRowsCount, failedRowsCount, runId]
          );

          resolve({
            runId,
            totalRows,
            validRows: validRowsCount,
            failedRows: failedRowsCount
          });
        } catch (flushErr) {
          cleanup(flushErr);
        }
      })();
    });

    stream.pipe(parser);
  });
}

export default {
  isItemNodeMatch,
  parseXmlStream,
  ingestXmlStream
};
