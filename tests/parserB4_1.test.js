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
import {
  isItemNodeMatch,
  parseXmlStream,
  ingestXmlStream
} from '../src/services/xmlParser.js';
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

describe('User Story B4.1 (PR 1 & PR 2): Multi-Format Ingestion (XLSX, XML, & Provenance Lineage)', () => {

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
  // 3. XLSX Parser & Provenance Mapping (Sheet Name -> page_number)
  // =========================================================================
  describe('3. XLSX Parser & Sheet Provenance Mapping (xlsxParser.js)', () => {
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
      assert.strictEqual(rows.sheetName, 'Catalog');
    });
  });

  // =========================================================================
  // 4. XML Streaming Parser Unit Tests (Path Matching & Standalone Parsing)
  // =========================================================================
  describe('4. XML Streaming Parser Logic (xmlParser.js)', () => {
    it('should match item nodes using configured dialect_config.item_node_path or defaults', () => {
      // Default tag names
      assert.strictEqual(isItemNodeMatch('product', '/catalog/products/product', null), true);
      assert.strictEqual(isItemNodeMatch('item', '/feed/items/item', null), true);
      assert.strictEqual(isItemNodeMatch('article', '/shop/article', null), true);
      assert.strictEqual(isItemNodeMatch('catalog', '/catalog', null), false);

      // Custom configured paths
      assert.strictEqual(
        isItemNodeMatch('product', '/export/shop/product', 'shop/product'),
        true
      );
      assert.strictEqual(
        isItemNodeMatch('entry', '/feed/entry', '/feed/entry'),
        true
      );
      assert.strictEqual(
        isItemNodeMatch('header', '/export/shop/header', 'shop/product'),
        false
      );
    });

    it('should parse XML stream into standardized JSON objects with nodePath attached', async () => {
      const xmlData = `<?xml version="1.0" encoding="UTF-8"?>
        <catalog>
          <product id="P-101">
            <sku>PUCH-101</sku>
            <name>Puch 50cc Head</name>
            <price>39.50</price>
            <ean>4006381333931</ean>
          </product>
          <product id="P-102">
            <sku>PUCH-102</sku>
            <name>Puch Spark Plug</name>
            <price>4.50</price>
            <ean>012345678905</ean>
          </product>
        </catalog>`;

      const records = await parseXmlStream(xmlData, { itemNodePath: 'product' });

      assert.strictEqual(records.length, 2);
      assert.strictEqual(records[0].sku, 'PUCH-101');
      assert.strictEqual(records[0].name, 'Puch 50cc Head');
      assert.strictEqual(records[0].price, '39.50');
      assert.strictEqual(records[0].ean, '4006381333931');
      assert.strictEqual(records[0]._nodePath, '/catalog/product');

      assert.strictEqual(records[1].sku, 'PUCH-102');
      assert.strictEqual(records[1]._nodePath, '/catalog/product');
    });
  });

  // =========================================================================
  // 5. End-to-End Ingestion Integration Tests (XLSX & XML with Provenance)
  // =========================================================================
  describe('5. Database Ingestion Pipeline & Provenance Mapping', () => {
    const merchantId = 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d';
    let sourceIdXlsx;
    let sourceIdXml;

    before(async () => {
      const resXlsx = await pool.query(
        `INSERT INTO sources (merchant_id, name, type, protocol, connection_config)
         VALUES ($1, 'Puchshop XLSX Test Feed', 'xlsx', 'HTTP', '{}')
         RETURNING id`,
        [merchantId]
      );
      sourceIdXlsx = resXlsx.rows[0].id;

      const resXml = await pool.query(
        `INSERT INTO sources (merchant_id, name, type, protocol, connection_config, dialect_config)
         VALUES ($1, 'Puchshop XML Test Feed', 'xml', 'HTTP', '{}', '{"item_node_path": "catalog/product"}')
         RETURNING id`,
        [merchantId]
      );
      sourceIdXml = resXml.rows[0].id;
    });

    after(async () => {
      if (sourceIdXlsx) {
        await pool.query('DELETE FROM sources WHERE id = $1', [sourceIdXlsx]);
      }
      if (sourceIdXml) {
        await pool.query('DELETE FROM sources WHERE id = $1', [sourceIdXml]);
      }
    });

    it('XLSX Provenance: should map Excel sheet name to page_number in normalized_records', async () => {
      const testData = [
        ['sku', 'name', 'price', 'ean', 'weight'],
        ['00101', 'Puch Dellorto Carburetor 15mm', '€ 65,00', '012345678905', '450 g'], // Valid, 12-digit EAN
        ['00102', 'Puch Exhaust Chrome 28mm', '45.50', '4006381333931', '1.8 kg'],       // Valid, 13-digit EAN
        ['', 'Nameless item', '10.00', '4006381333931', '100 g'],                        // Invalid: MISSING_SKU
        ['00104', 'Broken Barcode Item', '20.00', '012345678906', '200 g']                // Invalid: INVALID_EAN_CHECKSUM
      ];

      const sheetName = 'PuchshopCatalog2026';
      const buffer = createMockWorkbookBuffer(testData, sheetName);
      const stream = Readable.from(buffer);

      const stats = await ingestXlsxStream(stream, { id: sourceIdXlsx, dialect_config: { sheet: sheetName } }, merchantId);

      assert.ok(stats.runId, 'runId should be generated');
      assert.strictEqual(stats.totalRows, 4, 'Total rows should equal 4');
      assert.strictEqual(stats.validRows, 2, 'Valid rows should equal 2');
      assert.strictEqual(stats.failedRows, 2, 'Failed rows should equal 2');
      assert.strictEqual(
        stats.totalRows,
        stats.validRows + stats.failedRows,
        'Metric consistency: total_rows === valid_rows + failed_rows'
      );

      // Verify records in normalized_records have page_number set to sheetName
      const validRecordsRes = await pool.query(
        'SELECT * FROM normalized_records WHERE run_id = $1 ORDER BY sku ASC',
        [stats.runId]
      );
      assert.strictEqual(validRecordsRes.rows.length, 2);

      const row1 = validRecordsRes.rows[0];
      assert.strictEqual(row1.sku, '00101');
      assert.strictEqual(row1.name, 'Puch Dellorto Carburetor 15mm');
      assert.strictEqual(Number(row1.price), 65);
      assert.strictEqual(row1.ean, '0012345678905');
      assert.strictEqual(row1.ean.length, 13);
      // PROVENANCE CHECK: sheet name mapped directly to page_number
      assert.strictEqual(row1.page_number, sheetName);

      const row2 = validRecordsRes.rows[1];
      assert.strictEqual(row2.sku, '00102');
      assert.strictEqual(row2.page_number, sheetName);

      // Verify flagged_records
      const flaggedRes = await pool.query(
        'SELECT * FROM flagged_records WHERE run_id = $1 ORDER BY row_index ASC',
        [stats.runId]
      );
      assert.strictEqual(flaggedRes.rows.length, 2);

      // Verify ingestion_runs DB record
      const runRes = await pool.query(
        'SELECT * FROM ingestion_runs WHERE id = $1',
        [stats.runId]
      );
      assert.strictEqual(runRes.rows[0].status, 'COMPLETED');
      assert.strictEqual(runRes.rows[0].total_rows, 4);
    });

    it('XML Provenance: should map XML node path to source_column in normalized_records', async () => {
      const xmlFeed = `<?xml version="1.0" encoding="UTF-8"?>
        <catalog>
          <product id="P-301">
            <sku>PUCH-301</sku>
            <name>Puch Maxi Crankshaft High Quality</name>
            <price>€ 119,95</price>
            <ean>012345678905</ean>
            <weight>1200 gram</weight>
          </product>
          <product id="P-302">
            <sku>PUCH-302</sku>
            <name>Puch Gasket Set Complete</name>
            <price>14.95</price>
            <ean>4006381333931</ean>
            <weight>50 g</weight>
          </product>
          <product>
            <name>Missing SKU Item</name>
            <price>20.00</price>
            <ean>4006381333931</ean>
          </product>
        </catalog>`;

      const stream = Readable.from(Buffer.from(xmlFeed));

      const stats = await ingestXmlStream(
        stream,
        { id: sourceIdXml, dialect_config: { item_node_path: 'catalog/product' } },
        merchantId
      );

      assert.ok(stats.runId, 'runId should be generated');
      assert.strictEqual(stats.totalRows, 3, 'Total rows should equal 3');
      assert.strictEqual(stats.validRows, 2, 'Valid rows should equal 2');
      assert.strictEqual(stats.failedRows, 1, 'Failed rows should equal 1');
      assert.strictEqual(
        stats.totalRows,
        stats.validRows + stats.failedRows,
        'Metric balance: total_rows === valid_rows + failed_rows'
      );

      // Verify records in normalized_records have source_column set to '/catalog/product'
      const validRecordsRes = await pool.query(
        'SELECT * FROM normalized_records WHERE run_id = $1 ORDER BY sku ASC',
        [stats.runId]
      );
      assert.strictEqual(validRecordsRes.rows.length, 2);

      const row1 = validRecordsRes.rows[0];
      assert.strictEqual(row1.sku, 'PUCH-301');
      assert.strictEqual(row1.name, 'Puch Maxi Crankshaft High Quality');
      assert.strictEqual(Number(row1.price), 119.95);
      // EAN padded to 13 digits
      assert.strictEqual(row1.ean, '0012345678905');
      // PROVENANCE CHECK: node path mapped directly to source_column
      assert.strictEqual(row1.source_column, '/catalog/product');

      const row2 = validRecordsRes.rows[1];
      assert.strictEqual(row2.sku, 'PUCH-302');
      assert.strictEqual(row2.source_column, '/catalog/product');

      // Verify flagged_records
      const flaggedRes = await pool.query(
        'SELECT * FROM flagged_records WHERE run_id = $1',
        [stats.runId]
      );
      assert.strictEqual(flaggedRes.rows.length, 1);
      assert.ok(JSON.stringify(flaggedRes.rows[0].error_reasons).includes('MISSING_SKU'));

      // Verify ingestion_runs DB record
      const runRes = await pool.query(
        'SELECT * FROM ingestion_runs WHERE id = $1',
        [stats.runId]
      );
      assert.strictEqual(runRes.rows[0].status, 'COMPLETED');
      assert.strictEqual(runRes.rows[0].total_rows, 3);
      assert.strictEqual(runRes.rows[0].valid_rows, 2);
      assert.strictEqual(runRes.rows[0].failed_rows, 1);
    });

    it('should dispatch XML streams through the unified worker ingestionWorker.js', async () => {
      const xmlFeed = `<?xml version="1.0" encoding="UTF-8"?>
        <feed>
          <item>
            <sku>ITEM-999</sku>
            <name>Puch Fuel Filter</name>
            <price>3.95</price>
            <ean>4006381333931</ean>
          </item>
        </feed>`;

      const stream = Readable.from(Buffer.from(xmlFeed));

      const stats = await ingestSourceStream(stream, { id: sourceIdXml, type: 'xml' }, merchantId);

      assert.strictEqual(stats.totalRows, 1);
      assert.strictEqual(stats.validRows, 1);
      assert.strictEqual(stats.failedRows, 0);

      const recordsRes = await pool.query(
        'SELECT * FROM normalized_records WHERE run_id = $1',
        [stats.runId]
      );
      assert.strictEqual(recordsRes.rows[0].sku, 'ITEM-999');
      assert.strictEqual(recordsRes.rows[0].source_column, '/feed/item');
    });
  });
});
