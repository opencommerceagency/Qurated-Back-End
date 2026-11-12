import { pool } from '../db/index.js';
import iconv from 'iconv-lite';
import csv from 'csv-parser';
import {
  normalizePrice,
  isValidEan,
  extractUnit,
  normalizeRow
} from './normalizer.js';

// Re-export normalization functions for backward compatibility
export { normalizePrice, isValidEan, extractUnit, normalizeRow };

/**
 * Inspects the initial chunk of a readable stream to detect the delimiter (',', ';', '\t')
 * without loading the entire stream into memory.
 * Pushes the chunk back to the stream head via unshift().
 * 
 * @param {import('stream').Readable} stream - Input readable stream
 * @param {string} encoding - Character encoding
 * @returns {Promise<string>} - Detected delimiter character
 */
export async function detectDelimiter(stream, encoding = 'utf-8') {
  return new Promise((resolve) => {
    // If stream is not readable, default to comma
    if (!stream.readable) {
      return resolve(',');
    }

    const onData = (chunk) => {
      cleanup();
      // Put chunk back so subsequent piped streams get complete data
      try {
        stream.pause();
        stream.unshift(chunk);
      } catch {
        // in case unshift fails on certain custom stream implementations
      }

      try {
        const decoded = iconv.decode(chunk.slice(0, 4096), encoding);
        const firstLine = decoded.split(/\r?\n/)[0] || '';

        const commas = (firstLine.match(/,/g) || []).length;
        const semicolons = (firstLine.match(/;/g) || []).length;
        const tabs = (firstLine.match(/\t/g) || []).length;

        if (semicolons > commas && semicolons > tabs) {
          resolve(';');
        } else if (tabs > commas && tabs > semicolons) {
          resolve('\t');
        } else {
          resolve(',');
        }
      } catch {
        resolve(',');
      }
    };

    const onError = () => {
      cleanup();
      resolve(',');
    };

    const onEnd = () => {
      cleanup();
      resolve(',');
    };

    function cleanup() {
      stream.removeListener('data', onData);
      stream.removeListener('error', onError);
      stream.removeListener('end', onEnd);
    }

    stream.once('data', onData);
    stream.once('error', onError);
    stream.once('end', onEnd);
  });
}

/**
 * Ingests a CSV stream line-by-line, normalizes each row, triages invalid rows,
 * and executes chunked batch inserts (500 rows at a time) to prevent memory bloat.
 * 
 * Tracks lifecycle in `ingestion_runs` table:
 * - Status: 'PROCESSING' -> 'COMPLETED' | 'FAILED'
 * - Strict metric consistency: total_rows === valid_rows + failed_rows
 * 
 * @param {import('stream').Readable} stream - Raw CSV data stream
 * @param {Object|string} source - Source DB record or configuration
 * @param {string} merchantId - Tenant merchant UUID
 * @param {string} [runId] - Optional existing ingestion_runs UUID
 * @returns {Promise<{ runId: string, totalRows: number, validRows: number, failedRows: number }>}
 */
export async function ingestCsvStream(stream, source, merchantId, runId) {
  const config = (typeof source === 'object' && source !== null)
    ? (source.connection_config || source)
    : {};

  const sourceId = (typeof source === 'object' && source !== null)
    ? (source.id || source.source_id || null)
    : (typeof source === 'string' ? source : null);

  const encoding = config.encoding || 'utf-8';
  let delimiter = config.delimiter;

  // Auto-detect delimiter if not specified
  if (!delimiter || delimiter === 'auto') {
    delimiter = await detectDelimiter(stream, encoding);
  }

  const skipRows = config.skip_rows ? parseInt(config.skip_rows, 10) : 0;

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

  // Chunked batch flush for valid normalized records
  const flushCleanBatch = async () => {
    if (cleanBatch.length === 0) return;
    const batch = [...cleanBatch];
    cleanBatch = [];

    const values = [];
    const placeholders = [];
    let paramIndex = 1;

    for (const rec of batch) {
      placeholders.push(
        `($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++})`
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
        JSON.stringify(rec.raw_data)
      );
    }

    const query = `
      INSERT INTO normalized_records (
        run_id, merchant_id, sku, name, price, currency, ean, unit_value, unit_type, raw_data
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

  try {
    const decoder = iconv.decodeStream(encoding);
    const parser = csv({
      separator: delimiter,
      skipLines: skipRows,
      mapHeaders: ({ header }) => (typeof header === 'string' ? header.trim() : header)
    });

    // Propagate upstream stream errors down to parser
    stream.on('error', (err) => parser.destroy(err));
    decoder.on('error', (err) => parser.destroy(err));

    const pipeline = stream.pipe(decoder).pipe(parser);

    for await (const row of pipeline) {
      // Skip empty or trailing blank lines without incrementing total_rows
      const hasData = Object.values(row).some(
        v => v !== null && v !== undefined && String(v).trim() !== ''
      );
      if (!hasData) {
        continue;
      }

      rowIndex++;
      totalRows++;

      // Evaluate row using dedicated normalizer module
      const result = normalizeRow(row);

      if (result.isValid) {
        validRowsCount++;
        cleanBatch.push(result.normalized);
      } else {
        failedRowsCount++;
        flaggedBatch.push({
          row_index: rowIndex,
          raw_row: row,
          error_reasons: result.reasons
        });
      }

      // Flush in batches of 500 to keep memory usage low
      if (cleanBatch.length >= BATCH_SIZE) {
        await flushCleanBatch();
      }
      if (flaggedBatch.length >= BATCH_SIZE) {
        await flushFlaggedBatch();
      }
    }

    // Flush any remaining items in both batches
    await flushCleanBatch();
    await flushFlaggedBatch();

    // Verify strict metric consistency
    if (totalRows !== validRowsCount + failedRowsCount) {
      throw new Error(`Metric mismatch: total_rows (${totalRows}) !== valid (${validRowsCount}) + failed (${failedRowsCount})`);
    }

    // Mark ingestion_runs record as COMPLETED
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

    return {
      runId,
      totalRows,
      validRows: validRowsCount,
      failedRows: failedRowsCount
    };

  } catch (err) {
    // On stream or database error, mark ingestion run as FAILED
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
      console.error('Failed to update ingestion_run status to FAILED:', dbErr);
    }

    throw err;
  }
}
