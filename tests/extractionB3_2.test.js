import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { pool } from '../src/db/index.js';
import {
  compileModelZodSchema,
  generatePromptSchemaDescription
} from '../src/services/schemaCompiler.js';
import {
  extractWithFallback,
  getExtractionTimeoutMs,
  CSV_TIMEOUT_MS,
  PDF_TIMEOUT_MS,
  DEFAULT_PRIMARY_MODEL,
  DEFAULT_FALLBACK_MODEL
} from '../src/services/aiClient.js';
import {
  enqueueJob
} from '../src/services/queueService.js';
import {
  processJob,
  ingestExtractedProduct
} from '../src/workers/extractionWorker.js';

describe('User Story B3.2: OpenRouter Integration, Fallback Engine, and Idempotent Ingestion', () => {
  const merchantId = '55555555-5555-5555-5555-555555555555';

  let modelId;
  let modelVersionId;
  let fileId;
  let schemaSnapshot;

  const createdModelIds = [];
  const createdJobIds = [];
  const createdFileIds = [];

  before(async () => {
    // 1. Seed Product Model and Version Snapshot
    const modelRes = await pool.query(
      `INSERT INTO product_models (merchant_id, name, description, status, schema_version, created_by, updated_by)
       VALUES ($1, 'B3.2 Industrial Fasteners', 'Fastener catalog schema for B3.2 extraction testing', 'ACTIVE', 1, 'admin', 'admin')
       RETURNING id`,
      [merchantId]
    );
    modelId = modelRes.rows[0].id;
    createdModelIds.push(modelId);

    schemaSnapshot = {
      name: 'B3.2 Industrial Fasteners',
      schema_version: 1,
      attributes: [
        {
          name: 'Thread Size',
          key: 'thread_size',
          data_type: 'string',
          is_required: false
        },
        {
          name: 'Length MM',
          key: 'length_mm',
          data_type: 'integer',
          is_required: true,
          unit_type: 'mm'
        },
        {
          name: 'In Stock',
          key: 'in_stock',
          data_type: 'boolean',
          is_required: true
        },
        {
          name: 'Grade',
          key: 'grade',
          data_type: 'list_of_values',
          is_required: true,
          allowed_values: ['8.8', '10.9', '12.9']
        }
      ]
    };

    const versionRes = await pool.query(
      `INSERT INTO product_model_versions (model_id, version, snapshot)
       VALUES ($1, 1, $2)
       RETURNING id`,
      [modelId, JSON.stringify(schemaSnapshot)]
    );
    modelVersionId = versionRes.rows[0].id;

    // 2. Seed File in files table
    const fileRes = await pool.query(
      `INSERT INTO files (merchant_id, filename, file_size, mime_type, metadata)
       VALUES ($1, 'fasteners_supplier_catalog.csv', 2048, 'text/csv', '{"rows": 100}'::jsonb)
       RETURNING id`,
      [merchantId]
    );
    fileId = fileRes.rows[0].id;
    createdFileIds.push(fileId);
  });

  after(async () => {
    // Cleanup extracted_attributes and extracted_products (CASCADE handles attributes)
    if (createdJobIds.length > 0) {
      await pool.query('DELETE FROM extracted_products WHERE job_id = ANY($1)', [createdJobIds]);
      await pool.query('DELETE FROM extraction_jobs WHERE id = ANY($1)', [createdJobIds]);
    }
    // Cleanup files
    if (createdFileIds.length > 0) {
      await pool.query('DELETE FROM files WHERE id = ANY($1)', [createdFileIds]);
    }
    // Cleanup models
    if (createdModelIds.length > 0) {
      await pool.query('DELETE FROM product_models WHERE id = ANY($1)', [createdModelIds]);
    }

    await pool.end();
  });

  describe('Scenario 1: Primary Model & Schema Matching', () => {
    it('should compile model snapshot into an executable Zod schema requiring supplier_sku', () => {
      const schema = compileModelZodSchema(schemaSnapshot);
      assert.ok(schema);

      // Verify schema description generator for prompt
      const promptDesc = generatePromptSchemaDescription(schemaSnapshot);
      assert.ok(promptDesc.includes('supplier_sku'));
      assert.ok(promptDesc.includes('length_mm (integer, required)'));
      assert.ok(promptDesc.includes('in_stock (boolean, required)'));
      assert.ok(promptDesc.includes('grade (list_of_values, required)'));
    });

    it('should correctly parse valid raw supplier row with integer, boolean, and list_of_values coercion', () => {
      const schema = compileModelZodSchema(schemaSnapshot);

      const rawSupplierRow = {
        supplier_sku: 'SKU-BOLT-M8-50',
        thread_size: 'M8',
        length_mm: '50', // string that coerces to integer 50
        in_stock: 'true', // string that coerces to boolean true
        grade: '8.8' // matches enum
      };

      const result = schema.parse(rawSupplierRow);
      assert.strictEqual(result.supplier_sku, 'SKU-BOLT-M8-50');
      assert.strictEqual(result.thread_size, 'M8');
      assert.strictEqual(result.length_mm, 50);
      assert.strictEqual(typeof result.length_mm, 'number');
      assert.strictEqual(result.in_stock, true);
      assert.strictEqual(typeof result.in_stock, 'boolean');
      assert.strictEqual(result.grade, '8.8');
    });

    it('should coerce boolean variations like "false", "0", "no" to false', () => {
      const schema = compileModelZodSchema(schemaSnapshot);

      const rowFalse = schema.parse({
        supplier_sku: 'SKU-1',
        length_mm: 20,
        in_stock: 'false',
        grade: '10.9'
      });
      assert.strictEqual(rowFalse.in_stock, false);

      const rowNo = schema.parse({
        supplier_sku: 'SKU-2',
        length_mm: 20,
        in_stock: 'no',
        grade: '10.9'
      });
      assert.strictEqual(rowNo.in_stock, false);

      const rowZero = schema.parse({
        supplier_sku: 'SKU-3',
        length_mm: 20,
        in_stock: 0,
        grade: '10.9'
      });
      assert.strictEqual(rowZero.in_stock, false);
    });

    it('should reject invalid list_of_values when value is not in allowed_values', () => {
      const schema = compileModelZodSchema(schemaSnapshot);

      const invalidRow = {
        supplier_sku: 'SKU-INVALID-GRADE',
        length_mm: 40,
        in_stock: true,
        grade: '4.8' // Not in ['8.8', '10.9', '12.9']
      };

      const parseResult = schema.safeParse(invalidRow);
      assert.strictEqual(parseResult.success, false);
    });

    it('should reject missing or empty supplier_sku', () => {
      const schema = compileModelZodSchema(schemaSnapshot);

      const missingSku = {
        length_mm: 40,
        in_stock: true,
        grade: '8.8'
      };

      const parseResult = schema.safeParse(missingSku);
      assert.strictEqual(parseResult.success, false);
    });
  });

  describe('Scenario 2: Failover & Timeout Handling', () => {
    it('should resolve correct timeout based on fileType (15s for CSV, 60s for PDF)', () => {
      assert.strictEqual(getExtractionTimeoutMs('csv'), CSV_TIMEOUT_MS);
      assert.strictEqual(getExtractionTimeoutMs('CSV'), 15000);
      assert.strictEqual(getExtractionTimeoutMs('pdf'), PDF_TIMEOUT_MS);
      assert.strictEqual(getExtractionTimeoutMs('PDF'), 60000);
      assert.strictEqual(getExtractionTimeoutMs('csv', 5000), 5000);
    });

    it('should succeed with primary model when primary call returns valid JSON', async () => {
      const mockFetch = async (url, init) => {
        const body = JSON.parse(init.body);
        assert.strictEqual(body.model, DEFAULT_PRIMARY_MODEL);

        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    supplier_sku: 'PRIMARY-SKU-001',
                    thread_size: 'M12',
                    length_mm: 80,
                    in_stock: true,
                    grade: '12.9'
                  })
                }
              }
            ]
          })
        };
      };

      const result = await extractWithFallback({
        rawData: 'Fastener M12 80mm Grade 12.9 in stock',
        fileType: 'csv',
        schemaSnapshot,
        options: { fetchFn: mockFetch }
      });

      assert.strictEqual(result.metadata.model_used, 'primary');
      assert.strictEqual(result.metadata.model_name, DEFAULT_PRIMARY_MODEL);
      assert.strictEqual(result.data.supplier_sku, 'PRIMARY-SKU-001');
      assert.strictEqual(result.data.length_mm, 80);
      assert.strictEqual(result.data.grade, '12.9');
    });

    it('should failover to fallback model when primary model times out', async () => {
      const modelsCalled = [];

      const mockFetch = async (url, init) => {
        const body = JSON.parse(init.body);
        modelsCalled.push(body.model);

        if (body.model === DEFAULT_PRIMARY_MODEL) {
          // Simulate timeout via AbortError or abort signal
          const error = new Error('The operation was aborted');
          error.name = 'AbortError';
          throw error;
        }

        // Fallback model call succeeds
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    supplier_sku: 'FALLBACK-SKU-TIMEOUT',
                    thread_size: 'M10',
                    length_mm: 60,
                    in_stock: true,
                    grade: '10.9'
                  })
                }
              }
            ]
          })
        };
      };

      const result = await extractWithFallback({
        rawData: 'Bolt M10 60mm Grade 10.9',
        fileType: 'csv',
        schemaSnapshot,
        options: {
          fetchFn: mockFetch,
          timeoutMs: 100 // short timeout for testing
        }
      });

      assert.deepStrictEqual(modelsCalled, [DEFAULT_PRIMARY_MODEL, DEFAULT_FALLBACK_MODEL]);
      assert.strictEqual(result.metadata.model_used, 'fallback');
      assert.strictEqual(result.metadata.model_name, DEFAULT_FALLBACK_MODEL);
      assert.strictEqual(result.data.supplier_sku, 'FALLBACK-SKU-TIMEOUT');
      assert.strictEqual(result.data.length_mm, 60);
      assert.ok(result.metadata.primary_error.includes('aborted'));
    });

    it('should failover to fallback model when primary model returns HTTP 500 / 502', async () => {
      const modelsCalled = [];

      const mockFetch = async (url, init) => {
        const body = JSON.parse(init.body);
        modelsCalled.push(body.model);

        if (body.model === DEFAULT_PRIMARY_MODEL) {
          return {
            ok: false,
            status: 502,
            statusText: 'Bad Gateway',
            text: async () => 'Provider upstream 502 Bad Gateway'
          };
        }

        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    supplier_sku: 'FALLBACK-SKU-502',
                    thread_size: 'M6',
                    length_mm: 25,
                    in_stock: false,
                    grade: '8.8'
                  })
                }
              }
            ]
          })
        };
      };

      const result = await extractWithFallback({
        rawData: 'Bolt M6 25mm Grade 8.8 out of stock',
        fileType: 'csv',
        schemaSnapshot,
        options: { fetchFn: mockFetch }
      });

      assert.deepStrictEqual(modelsCalled, [DEFAULT_PRIMARY_MODEL, DEFAULT_FALLBACK_MODEL]);
      assert.strictEqual(result.metadata.model_used, 'fallback');
      assert.strictEqual(result.data.supplier_sku, 'FALLBACK-SKU-502');
      assert.strictEqual(result.data.in_stock, false);
    });

    it('should failover when primary model returns invalid JSON schema output', async () => {
      const modelsCalled = [];

      const mockFetch = async (url, init) => {
        const body = JSON.parse(init.body);
        modelsCalled.push(body.model);

        if (body.model === DEFAULT_PRIMARY_MODEL) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              choices: [
                {
                  message: {
                    // Invalid schema output: missing supplier_sku and length_mm is not an integer
                    content: JSON.stringify({
                      title: 'Just a description with no SKU'
                    })
                  }
                }
              ]
            })
          };
        }

        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    supplier_sku: 'RECOVERED-SKU-VALID',
                    thread_size: 'M8',
                    length_mm: 45,
                    in_stock: true,
                    grade: '8.8'
                  })
                }
              }
            ]
          })
        };
      };

      const result = await extractWithFallback({
        rawData: 'Raw text without obvious structure',
        fileType: 'csv',
        schemaSnapshot,
        options: { fetchFn: mockFetch }
      });

      assert.strictEqual(result.metadata.model_used, 'fallback');
      assert.strictEqual(result.data.supplier_sku, 'RECOVERED-SKU-VALID');
    });

    it('should throw an error if both primary and fallback models fail', async () => {
      const mockFetch = async () => ({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: async () => 'Outage across providers'
      });

      await assert.rejects(
        async () => {
          await extractWithFallback({
            rawData: 'Test data',
            fileType: 'csv',
            schemaSnapshot,
            options: { fetchFn: mockFetch }
          });
        },
        /AI extraction failed on both primary/
      );
    });
  });

  describe('Scenario 3: Idempotent Product Ingestion (UPSERT)', () => {
    it('should insert new product and attributes for SKU-100 on first run', async () => {
      const enqueued = await enqueueJob({
        merchant_id: merchantId,
        file_id: fileId,
        model_version_id: modelVersionId,
        total_records: 1
      });
      createdJobIds.push(enqueued.job_id);

      const productPayload = {
        supplier_sku: 'SKU-100',
        thread_size: 'M8',
        length_mm: 50,
        in_stock: true,
        grade: '8.8'
      };

      const ingestRes = await ingestExtractedProduct({
        merchant_id: merchantId,
        job_id: enqueued.job_id,
        model_version_id: modelVersionId,
        productData: productPayload,
        source_file_id: fileId,
        source_row_index: 0
      });

      assert.ok(ingestRes.productId);
      assert.strictEqual(ingestRes.product.supplier_sku, 'SKU-100');

      // Verify in DB: extracted_products
      const prodCheck = await pool.query(
        'SELECT * FROM extracted_products WHERE merchant_id = $1 AND model_version_id = $2 AND supplier_sku = $3',
        [merchantId, modelVersionId, 'SKU-100']
      );
      assert.strictEqual(prodCheck.rows.length, 1);
      const savedProd = prodCheck.rows[0];
      assert.strictEqual(savedProd.state, 'PROCESSING');
      assert.strictEqual(savedProd.job_id, enqueued.job_id);

      // Verify in DB: extracted_attributes
      const attrCheck = await pool.query(
        'SELECT * FROM extracted_attributes WHERE product_id = $1 ORDER BY attribute_key ASC',
        [savedProd.id]
      );
      assert.strictEqual(attrCheck.rows.length, 4);

      const lengthAttr = attrCheck.rows.find((a) => a.attribute_key === 'length_mm');
      assert.ok(lengthAttr);
      assert.strictEqual(JSON.parse(JSON.stringify(lengthAttr.value)), 50);

      const gradeAttr = attrCheck.rows.find((a) => a.attribute_key === 'grade');
      assert.ok(gradeAttr);
      assert.strictEqual(JSON.parse(JSON.stringify(gradeAttr.value)), '8.8');
    });

    it('should update existing product and attributes without creating duplicates on second run', async () => {
      // Re-run for the SAME SKU-100 with updated values under a new job
      const enqueued2 = await enqueueJob({
        merchant_id: merchantId,
        file_id: fileId,
        model_version_id: modelVersionId,
        total_records: 1
      });
      createdJobIds.push(enqueued2.job_id);

      const updatedPayload = {
        supplier_sku: 'SKU-100', // SAME SKU
        thread_size: 'M8',
        length_mm: 75, // Updated from 50 to 75
        in_stock: false, // Updated from true to false
        grade: '10.9' // Updated from 8.8 to 10.9
      };

      const reIngestRes = await ingestExtractedProduct({
        merchant_id: merchantId,
        job_id: enqueued2.job_id,
        model_version_id: modelVersionId,
        productData: updatedPayload,
        source_file_id: fileId,
        source_row_index: 0
      });

      assert.ok(reIngestRes.productId);

      // Verify in DB: extracted_products MUST STILL have exactly 1 row!
      const prodCheck = await pool.query(
        'SELECT * FROM extracted_products WHERE merchant_id = $1 AND model_version_id = $2 AND supplier_sku = $3',
        [merchantId, modelVersionId, 'SKU-100']
      );
      assert.strictEqual(prodCheck.rows.length, 1);
      const updatedProd = prodCheck.rows[0];
      // Job ID is updated to the latest execution run
      assert.strictEqual(updatedProd.job_id, enqueued2.job_id);

      // Verify in DB: extracted_attributes MUST have updated values
      const attrCheck = await pool.query(
        'SELECT * FROM extracted_attributes WHERE product_id = $1 ORDER BY attribute_key ASC',
        [updatedProd.id]
      );
      assert.strictEqual(attrCheck.rows.length, 4);

      const lengthAttr = attrCheck.rows.find((a) => a.attribute_key === 'length_mm');
      assert.strictEqual(JSON.parse(JSON.stringify(lengthAttr.value)), 75);

      const inStockAttr = attrCheck.rows.find((a) => a.attribute_key === 'in_stock');
      assert.strictEqual(JSON.parse(JSON.stringify(inStockAttr.value)), false);

      const gradeAttr = attrCheck.rows.find((a) => a.attribute_key === 'grade');
      assert.strictEqual(JSON.parse(JSON.stringify(gradeAttr.value)), '10.9');
    });

    it('should process job end-to-end through worker and ingest products with Zod schema validation', async () => {
      const enqueued = await enqueueJob({
        merchant_id: merchantId,
        file_id: fileId,
        model_version_id: modelVersionId
      });
      createdJobIds.push(enqueued.job_id);

      const items = [
        {
          supplier_sku: 'E2E-SKU-1',
          thread_size: 'M10',
          length_mm: 100,
          in_stock: true,
          grade: '12.9'
        },
        {
          supplier_sku: 'E2E-SKU-2',
          thread_size: 'M12',
          length_mm: 120,
          in_stock: false,
          grade: '8.8'
        }
      ];

      const processedJob = await processJob(enqueued.job_id, { items });

      assert.strictEqual(processedJob.status, 'COMPLETED');
      assert.strictEqual(processedJob.total_records, 2);
      assert.strictEqual(processedJob.processed_records, 2);
      assert.strictEqual(processedJob.failed_records, 0);

      // Verify products were ingested into extracted_products
      const e2eProd1 = await pool.query(
        'SELECT * FROM extracted_products WHERE merchant_id = $1 AND supplier_sku = $2',
        [merchantId, 'E2E-SKU-1']
      );
      assert.strictEqual(e2eProd1.rows.length, 1);

      const e2eProd2 = await pool.query(
        'SELECT * FROM extracted_products WHERE merchant_id = $1 AND supplier_sku = $2',
        [merchantId, 'E2E-SKU-2']
      );
      assert.strictEqual(e2eProd2.rows.length, 1);
    });
  });
});
