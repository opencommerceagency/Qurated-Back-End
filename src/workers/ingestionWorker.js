import { ingestCsvStream } from '../services/csvParser.js';
import { ingestXlsxStream, parseXlsxBuffer } from '../services/xlsxParser.js';
import { ingestXmlStream, parseXmlStream } from '../services/xmlParser.js';
import { detectFileType } from '../utils/fileValidator.js';

/**
 * Ingestion Worker & Parser Dispatcher (Milestone B4.1)
 *
 * Routes incoming streams to appropriate format parsers (CSV, XLSX, XML)
 * with unified error handling, metric consistency, and database tracking.
 */

/**
 * Dispatches an incoming source stream to the correct ingestion parser.
 *
 * @param {import('stream').Readable|Buffer} stream - Data stream or buffer
 * @param {Object} source - Source database record or configuration
 * @param {string} merchantId - Tenant UUID
 * @param {string} [runId] - Ingestion run UUID
 * @returns {Promise<{ runId: string, totalRows: number, validRows: number, failedRows: number }>}
 */
export async function ingestSourceStream(stream, source, merchantId, runId) {
  const type = (source?.type || '').toLowerCase();

  if (type === 'xlsx' || type === 'excel') {
    return ingestXlsxStream(stream, source, merchantId, runId);
  }

  if (type === 'xml') {
    return ingestXmlStream(stream, source, merchantId, runId);
  }

  if (type === 'csv') {
    return ingestCsvStream(stream, source, merchantId, runId);
  }

  // Fallback: detect format from filename / connection URL if available
  const detected = detectFileType(source?.connection_config?.url || source?.name);
  if (detected === 'xlsx') {
    return ingestXlsxStream(stream, source, merchantId, runId);
  }
  if (detected === 'xml') {
    return ingestXmlStream(stream, source, merchantId, runId);
  }

  // Default to CSV
  return ingestCsvStream(stream, source, merchantId, runId);
}

export {
  ingestXlsxStream,
  parseXlsxBuffer,
  ingestXmlStream,
  parseXmlStream,
  ingestCsvStream
};

export default {
  ingestSourceStream,
  ingestXlsxStream,
  parseXlsxBuffer,
  ingestXmlStream,
  parseXmlStream,
  ingestCsvStream
};
