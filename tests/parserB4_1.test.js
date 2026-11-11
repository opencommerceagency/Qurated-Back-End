import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import XLSX from 'xlsx';
import { Readable } from 'stream';
import {
  isValidFileExtension,
  isValidMimeType,
  detectFileType,
  validateFileType,
  BLOCKED_MIME_TYPES
} from '../src/utils/fileValidator.js';
import {
  padEan,
  eanPreProcessor,
  isValidEan,
  normalizeRow
} from '../src/services/normalizer.js';
import {
  parseXlsxBuffer,
  ingestXlsxStream
} from '../src/services/xlsxParser.js';
import { ingestSourceStream } from '../src/workers/ingestionWorker.js';
import { pool } from '../src/db/index.js';

/**
 * Creates an in-memory XLSX buffer from an Array-of-Arrays (AOA)
 */
function createMockWorkbookBuffer(dataAoa, sheetName = 'Sheet1') {
  const ws = XLSX.utils.aoa_to_sheet(dataAoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

describe('User Story B4.1 (PR 1): File Validator, XLSX Parser, and EAN Pre-processor', () => {

  // =========================================================================
  // 1. File Validator Tests (.xml, .xlsx, MIME types, security rejections)
  // =========================================================================
  describe('1. File Validator Utility (fileValidator.js)', () => {
    it('should validate .xml and .xlsx file extensions (case-insensitive)', () => {
      assert.strictEqual(isValidFileExtension('catalog.xml', 'xml'), true);
      assert.strictEqual(isValidFileExtension('CATALOG.XML', 'xml'), true);
      assert.strictEqual(isValidFileExtension('inventory.xlsx', 'xlsx'), true);
      assert.strictEqual(isValidFileExtension('INVENTORY.XLSX', 'xlsx'), true);
      assert.strictEqual(isValidFileExtension('data.csv', 'csv'), true);
    });

    it('should strip URL query parameters and hash anchors when extracting extension', () => {
      assert.strictEqual(
        isValidFileExtension('https://supplier.com/feeds/products.xlsx?token=abc123#page1', 'xlsx'),
        true
      );
      assert.strictEqual(
        isValidFileExtension('https://api.puchshop.de/export.xml?key=xyz&format=full', 'xml'),
        true
      );
    });

    it('should validate official and common MIME types for XML and XLSX', () => {
      // XML MIME types
      assert.strictEqual(isValidMimeType('application/xml', 'xml'), true);
      assert.strictEqual(isValidMimeType('text/xml', 'xml'), true);
      assert.strictEqual(isValidMimeType('application/xml; charset=utf-8', 'xml'), true);

      // XLSX MIME types
      assert.strictEqual(
        isValidMimeType('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx'),
        true
      );
      assert.strictEqual(isValidMimeType('application/vnd.ms-excel', 'xlsx'), true);
      assert.strictEqual(isValidMimeType('application/octet-stream', 'xlsx'), true);
      assert.strictEqual(isValidMimeType('application/zip', 'xlsx'), true);
    });

    it('should reject dangerous executable extensions and malicious HTML masquerades', () => {
      // Dangerous extensions
      for (const dangerous of ['.exe', '.sh', '.bat', '.js', '.php', '.html']) {
        assert.strictEqual(isValidFileExtension(`payload${dangerous}`), false);
      }

      // Blocked MIME types
      for (const blocked of BLOCKED_MIME_TYPES) {
        assert.strictEqual(isValidMimeType(blocked), false);
      }
    });

    it('should detect file types accurately via detectFileType', () => {
      assert.strictEqual(detectFileType('feed.xlsx'), 'xlsx');
      assert.strictEqual(detectFileType('feed.xml'), 'xml');
      assert.strictEqual(detectFileType('feed.csv'), 'csv');
      assert.strictEqual(
        detectFileType(undefined, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
        'xlsx'
      );
      assert.strictEqual(detectFileType(undefined, 'application/xml'), 'xml');
      assert.strictEqual(detectFileType('unknown.xyz', 'unknown/type'), null);
    });

    it('should validate file matching expectedType and reject mismatched types', () => {
      const validXlsx = validateFileType({
        filename: 'stock.xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        expectedType: 'xlsx'
      });
      assert.strictEqual(validXlsx.isValid, true);
      assert.strictEqual(validXlsx.detectedType, 'xlsx');

      const mismatched = validateFileType({
        filename: 'stock.xml',
        mimeType: 'text/xml',
        expectedType: 'xlsx'
      });
      assert.strictEqual(mismatched.isValid, false);
      assert.ok(mismatched.error.includes('does not match expected format'));
    });
  });

  // =========================================================================
  // 2. Schema Pre-processor Tests (12-to-13 digit EAN Auto-Padding)
  // =========================================================================
  describe('2. Schema Pre-processor: 12-to-13 Digit EAN Auto-Padding', () => {
    it('should automatically pad 12-digit barcodes to 13 digits with a leading zero', () => {
      // Puchshop edge case: 12-digit barcodes missing leading zero
      // 012345678905 (valid UPC-12 / EAN-13 when padded with 0)
      const padded1 = padEan('012345678905');
      assert.strictEqual(padded1, '0012345678905');
      assert.strictEqual(padded1.length, 13);
      assert.strictEqual(isValidEan(padded1), true);

      // Numeric input
      const paddedNum = padEan(12345678905); // 11 digits without leading 0s
      assert.strictEqual(typeof paddedNum, 'string');
    });

    it('should preserve standard 13-digit EANs without modifying them', () => {
      // 4006381333931 (STABILO Boss 13-digit EAN)
      assert.strictEqual(padEan('4006381333931'), '4006381333931');
      assert.strictEqual(isValidEan(padEan('4006381333931')), true);
    });

    it('should function correctly with eanPreProcessor for schema pipelines', () => {
      assert.strictEqual(eanPreProcessor('012345678905'), '0012345678905');
      assert.strictEqual(eanPreProcessor('4006381333931'), '4006381333931');
      assert.strictEqual(eanPreProcessor(null), null);
      assert.strictEqual(eanPreProcessor(''), '');
    });

    it('should normalize 12-digit EAN in normalizeRow to 13-digit EAN', () => {
      const row = {
        sku: 'PUCH-001',
        name: 'Puch Maxi 50cc Cylinder Kit',
        price: '€ 79,95',
        ean: '012345678905' // 12-digit UPC/EAN
      };

      const result = normalizeRow(row);
      assert.strictEqual(result.isValid, true);
      assert.strictEqual(result.normalized.sku, 'PUCH-001');
      assert.strictEqual(result.normalized.price, 79.95);
      // Barcode should be saved as 13 digits, not 12
      assert.strictEqual(result.normalized.ean, '0012345678905');
      assert.strictEqual(result.normalized.ean.length, 13);
    });

    it('should reject invalid checksums even after 12-to-13 digit padding', () => {
      const badRow = {
        sku: 'PUCH-002',
        name: 'Broken Barcode Item',
        price: '10.00',
        ean: '012345678906' // Corrupt check digit
      };

      const result = normalizeRow(badRow);
      assert.strictEqual(result.isValid, false);
      assert.ok(result.reasons.includes('INVALID_EAN_CHECKSUM'));
    });
  });

  // =========================================================================
  // 3. XLSX Parser Tests (Leading Zeros & Strict String Reading)
  // =========================================================================
  describe('3. XLSX Parser (Strict String Reading raw: false)', () => {
    it('should read all cell values strictly as strings, preserving leading zeros', () => {
      // Construct workbook with cells containing leading zeros
      const testData = [
        ['sku', 'name', 'price', 'ean', 'postal_code'],
        ['00123', 'Leading Zero SKU', '45.00', '012345678905', '01234'],
        ['00001', 'Part Alpha', '12.50', '4006381333931', '00890']
      ];

      const buffer = createMockWorkbookBuffer(testData);
      const rows = parseXlsxBuffer(buffer);

      assert.strictEqual(rows.length, 2);
      // Strictly strings with leading zeros preserved
      assert.strictEqual(rows[0].sku, '00123');
      assert.strictEqual(typeof rows[0].sku, 'string');
      assert.strictEqual(rows[0].postal_code, '01234');
      assert.strictEqual(rows[1].sku, '00001');
      assert.strictEqual(rows[1].postal_code, '00890');
    });

    it('should correctly select target sheet if specified in options', () => {
      const wb = XLSX.utils.book_new();
      const ws1 = XLSX.utils.aoa_to_sheet([['sku'], ['IGNORE-1']]);
      const ws2 = XLSX.utils.aoa_to_sheet([['sku'], ['TARGET-1']]);
      XLSX.utils.book_append_sheet(wb, ws1, 'Cover');
      XLSX.utils.book_append_sheet(wb, ws2, 'Catalog');

      const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
      const rows = parseXlsxBuffer(buffer, { sheet: 'Catalog' });

      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].sku, 'TARGET-1');
    });
  });

  // =========================================================================
  // 4. End-to-End Ingestion Integration Tests
  // =========================================================================
  describe('4. XLSX Ingestion Pipeline & Metric Consistency (ingestXlsxStream)', () => {
    const merchantId = 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d';
    let sourceId;

    before(async () => {
      // Create a test source record in database
      const res = await pool.query(
        `INSERT INTO sources (merchant_id, name, type, protocol, connection_config)
         VALUES ($1, 'Puchshop XLSX Test Feed', 'xlsx', 'HTTP', '{}')
         RETURNING id`,
        [merchantId]
      );
      sourceId = res.rows[0].id;
    });

    after(async () => {
      // Cleanup created source and runs
      if (sourceId) {
        await pool.query('DELETE FROM sources WHERE id = $1', [sourceId]);
      }
    });

    it('should ingest XLSX feed, pad 12-digit EANs, triage invalid rows, and enforce metric consistency', async () => {
      const testData = [
        ['sku', 'name', 'price', 'ean', 'weight'],
        ['00101', 'Puch Dellorto Carburetor 15mm', '€ 65,00', '012345678905', '450 g'], // Valid, 12-digit EAN
        ['00102', 'Puch Exhaust Chrome 28mm', '45.50', '4006381333931', '1.8 kg'],       // Valid, 13-digit EAN
        ['', 'Nameless & Sku-less item', '10.00', '4006381333931', '100 g'],              // Invalid: MISSING_SKU
        ['00104', 'Broken Barcode Item', '20.00', '012345678906', '200 g']                // Invalid: INVALID_EAN_CHECKSUM
      ];

      const buffer = createMockWorkbookBuffer(testData);
      const stream = Readable.from(buffer);

      const stats = await ingestXlsxStream(stream, { id: sourceId }, merchantId);

      assert.ok(stats.runId, 'runId should be generated');
      assert.strictEqual(stats.totalRows, 4, 'Total rows should equal 4');
      assert.strictEqual(stats.validRows, 2, 'Valid rows should equal 2');
      assert.strictEqual(stats.failedRows, 2, 'Failed rows should equal 2');
      assert.strictEqual(
        stats.totalRows,
        stats.validRows + stats.failedRows,
        'Metric consistency: total_rows === valid_rows + failed_rows'
      );

      // Verify records in normalized_records
      const validRecordsRes = await pool.query(
        'SELECT * FROM normalized_records WHERE run_id = $1 ORDER BY sku ASC',
        [stats.runId]
      );
      assert.strictEqual(validRecordsRes.rows.length, 2);

      // Row 1: SKU with leading zero preserved and 12-digit EAN padded to 13 digits
      const row1 = validRecordsRes.rows[0];
      assert.strictEqual(row1.sku, '00101');
      assert.strictEqual(row1.name, 'Puch Dellorto Carburetor 15mm');
      assert.strictEqual(Number(row1.price), 65);
      assert.strictEqual(row1.ean, '0012345678905');
      assert.strictEqual(row1.ean.length, 13);
      assert.strictEqual(row1.unit_type, 'g');

      // Verify records in flagged_records
      const flaggedRes = await pool.query(
        'SELECT * FROM flagged_records WHERE run_id = $1 ORDER BY row_index ASC',
        [stats.runId]
      );
      assert.strictEqual(flaggedRes.rows.length, 2);
      assert.ok(JSON.stringify(flaggedRes.rows[0].error_reasons).includes('MISSING_SKU'));
      assert.ok(JSON.stringify(flaggedRes.rows[1].error_reasons).includes('INVALID_EAN_CHECKSUM'));

      // Verify ingestion_runs DB record
      const runRes = await pool.query(
        'SELECT * FROM ingestion_runs WHERE id = $1',
        [stats.runId]
      );
      assert.strictEqual(runRes.rows[0].status, 'COMPLETED');
      assert.strictEqual(runRes.rows[0].total_rows, 4);
      assert.strictEqual(runRes.rows[0].valid_rows, 2);
      assert.strictEqual(runRes.rows[0].failed_rows, 2);
      assert.ok(runRes.rows[0].finished_at !== null);
    });

    it('should dispatch XLSX streams through the unified worker ingestionWorker.js', async () => {
      const testData = [
        ['sku', 'name', 'price', 'ean'],
        ['00201', 'Puch Chain Gold 415', '18.90', '4006381333931']
      ];

      const buffer = createMockWorkbookBuffer(testData);
      const stream = Readable.from(buffer);

      const stats = await ingestSourceStream(stream, { id: sourceId, type: 'xlsx' }, merchantId);

      assert.strictEqual(stats.totalRows, 1);
      assert.strictEqual(stats.validRows, 1);
      assert.strictEqual(stats.failedRows, 0);
    });
  });
});
