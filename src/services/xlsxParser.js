import XLSX from 'xlsx';
import { pool } from '../db/index.js';
import { normalizeRow } from './normalizer.js';

/**
 * XLSX Ingestion & Parser Service (Milestone B4.1)
 *
 * Configured to read all spreadsheet cells strictly as formatted strings (raw: false)
 * to prevent Excel from coercing values, stripping leading zeros from SKUs, postal codes,
 * or truncated EAN barcodes.
 */

/**
 * Reads a stream completely and converts it into a Buffer.
 *
 * @param {import('stream').Readable} stream
 * @returns {Promise<Buffer>}
 */
export async function streamToBuffer(stream) {
  if (Buffer.isBuffer(stream)) {
    return stream;
  }
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Parses an XLSX buffer or file into an array of row objects, ensuring all cell values
 * are strictly strings (preserving leading zeros).
 *
 * @param {Buffer|ArrayBuffer} buffer - Raw file buffer
 * @param {Object} [options]
 * @param {string} [options.sheet] - Name of specific sheet to parse (defaults to first sheet)
 * @returns {Array<Object>} - Array of row objects with string values
 */
export function parseXlsxBuffer(buffer, options = {}) {
  // CRITICAL: raw: false instructs SheetJS to format all values as strings
  const workbook = XLSX.read(buffer, {
    type: 'buffer',
    raw: false,
    cellText: true,
    cellDates: false
  });

  const sheetNames = workbook.SheetNames || [];
  if (sheetNames.length === 0) {
    return [];
  }

  const targetSheetName = options.sheet && workbook.Sheets[options.sheet]
    ? options.sheet
    : sheetNames[0];

  const worksheet = workbook.Sheets[targetSheetName];
  if (!worksheet) {
    return [];
  }

  // raw: false ensures cell values are not converted to JS numbers
  // defval: '' ensures empty cells default to empty strings
  const rawRows = XLSX.utils.sheet_to_json(worksheet, {
    raw: false,
    defval: ''
  });

  // Clean keys and ensure all values are string-trimmed
  return rawRows.map((row) => {
    const cleaned = {};
    for (const [key, val] of Object.entries(row)) {
      const cleanKey = typeof key === 'string' ? key.trim() : key;
      cleaned[cleanKey] = val !== null && val !== undefined ? String(val).trim() : '';
    }
    return cleaned;
  });
}

/**
 * Ingests an XLSX stream or buffer, normalizes each row, triages invalid rows,
 * and executes chunked batch inserts (500 rows at a time).
 *
 * Enforces strict metric consistency in `ingestion_runs`:
 * - total_rows === valid_rows + failed_rows
 * - status: 'PROCESSING' -> 'COMPLETED' | 'FAILED'
 *
 * @param {import('stream').Readable|Buffer} streamOrBuffer - Input XLSX stream or buffer
 * @param {Object|string} source - Source DB record or configuration
 * @param {string} merchantId - Tenant merchant UUID
 * @param {string} [runId] - Optional existing ingestion_runs UUID
 * @returns {Promise<{ runId: string, totalRows: number, validRows: number, failedRows: number }>}
 */
export async function ingestXlsxStream(streamOrBuffer, source, merchantId, runId) {
  const config = (typeof source === 'object' && source !== null)
    ? (source.connection_config || source)
    : {};

  const dialect = (typeof source === 'object' && source !== null)
    ? (source.dialect_config || {})
    : {};

  const sourceId = (typeof source === 'object' && source !== null)
    ? (source.id || source.source_id || null)
    : (typeof source === 'string' ? source : null);

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
    const buffer = await streamToBuffer(streamOrBuffer);
    const targetSheet = dialect.sheet || config.sheet || null;
    const rows = parseXlsxBuffer(buffer, { sheet: targetSheet });

    for (const row of rows) {
      // Skip empty or blank lines
      const hasData = Object.values(row).some(
        v => v !== null && v !== undefined && String(v).trim() !== ''
      );
      if (!hasData) {
        continue;
      }

      rowIndex++;
      totalRows++;

      // Evaluate row using dedicated normalizer module (with 12-to-13 digit EAN auto-padding)
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

      if (cleanBatch.length >= BATCH_SIZE) {
        await flushCleanBatch();
      }
      if (flaggedBatch.length >= BATCH_SIZE) {
        await flushFlaggedBatch();
      }
    }

    // Flush any remaining records
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
      console.error('Failed to update ingestion_run status to FAILED for XLSX:', dbErr);
    }

    throw err;
  }
}

export default {
  streamToBuffer,
  parseXlsxBuffer,
  ingestXlsxStream
};

