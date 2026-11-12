import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { pool } from '../src/db/index.js';
import {
  extractWithFallback,
  extractProductAttributes,
  DEFAULT_PRIMARY_MODEL
} from '../src/services/aiClient.js';
import {
  processJob,
  recordExtractionMetric
} from '../src/workers/extractionWorker.js';

describe('B4.2 PR 1: AI Telemetry & Extraction Metrics Tracking', () => {
  const merchantId = '66666666-6666-6666-6666-666666666666';

  let modelId;
  let modelVersionId;
  let fileId;
  let schemaSnapshot;

  const createdModelIds = [];
  const createdJobIds = [];
  const createdFileIds = [];

  before(async () => {
    process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || 'test_openrouter_api_key_2026';

    // 1. Seed Product Model and Version Snapshot
    const modelRes = await pool.query(
      `INSERT INTO product_models (merchant_id, name, description, status, schema_version, created_by, updated_by)
       VALUES ($1, 'B4.2 Telemetry Model', 'Schema for B4.2 telemetry testing', 'ACTIVE', 1, 'admin', 'admin')
       RETURNING id`,
      [merchantId]
    );
    modelId = modelRes.rows[0].id;
    createdModelIds.push(modelId);

    schemaSnapshot = {
      name: 'B4.2 Telemetry Model',
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

    // 2. Seed File record
    const fileRes = await pool.query(
      `INSERT INTO files (merchant_id, filename, file_size, mime_type, metadata)
       VALUES ($1, 'telemetry_supplier_catalog.csv', 1024, 'text/csv', '{"rows": 10}'::jsonb)
       RETURNING id`,
      [merchantId]
    );
    fileId = fileRes.rows[0].id;
    createdFileIds.push(fileId);
  });

  after(async () => {
    if (createdJobIds.length > 0) {
      await pool.query('DELETE FROM extraction_metrics WHERE job_id = ANY($1)', [createdJobIds]);
      await pool.query('DELETE FROM extracted_products WHERE job_id = ANY($1)', [createdJobIds]);
      await pool.query('DELETE FROM extraction_jobs WHERE id = ANY($1)', [createdJobIds]);
    }
    if (createdFileIds.length > 0) {
      await pool.query('DELETE FROM files WHERE id = ANY($1)', [createdFileIds]);
    }
    if (createdModelIds.length > 0) {
      await pool.query('DELETE FROM product_models WHERE id = ANY($1)', [createdModelIds]);
    }
  });

  describe('1. Database Migration: extraction_metrics Table Structure', () => {
    it('should have created the extraction_metrics table with all required columns and nullable product_id', async () => {
      const colRes = await pool.query(
        `SELECT column_name, is_nullable, data_type
         FROM information_schema.columns
         WHERE table_name = 'extraction_metrics'`
      );

      const columns = Object.fromEntries(
        colRes.rows.map((r) => [r.column_name, { nullable: r.is_nullable, type: r.data_type }])
      );

      assert.ok(columns.id, 'id column should exist');
      assert.ok(columns.job_id, 'job_id column should exist');
      assert.strictEqual(columns.job_id.nullable, 'NO', 'job_id must NOT be nullable');

      assert.ok(columns.product_id, 'product_id column should exist');
      assert.strictEqual(columns.product_id.nullable, 'YES', 'product_id MUST be nullable in case of early failure');

      assert.ok(columns.model_used, 'model_used column should exist');
      assert.strictEqual(columns.model_used.nullable, 'NO', 'model_used must NOT be nullable');

      assert.ok(columns.prompt_tokens, 'prompt_tokens column should exist');
      assert.strictEqual(columns.prompt_tokens.type, 'integer');

      assert.ok(columns.completion_tokens, 'completion_tokens column should exist');
      assert.strictEqual(columns.completion_tokens.type, 'integer');

      assert.ok(columns.is_failover, 'is_failover column should exist');
      assert.strictEqual(columns.is_failover.type, 'boolean');

      assert.ok(columns.status, 'status column should exist');
      assert.ok(columns.created_at, 'created_at column should exist');
    });

    it('should insert and retrieve a telemetry record via recordExtractionMetric helper', async () => {
      const jobRes = await pool.query(
        `INSERT INTO extraction_jobs (merchant_id, model_version_id, file_id, status)
         VALUES ($1, $2, $3, 'PROCESSING')
         RETURNING id`,
        [merchantId, modelVersionId, fileId]
      );
      const testJobId = jobRes.rows[0].id;
      createdJobIds.push(testJobId);

      const metric = await recordExtractionMetric(pool, {
        jobId: testJobId,
        productId: null,
        modelUsed: 'anthropic/claude-3.5-sonnet',
        promptTokens: 250,
        completionTokens: 85,
        isFailover: false,
        status: 'success'
      });

      assert.ok(metric.id);
      assert.strictEqual(metric.job_id, testJobId);
      assert.strictEqual(metric.product_id, null);
      assert.strictEqual(metric.model_used, 'anthropic/claude-3.5-sonnet');
      assert.strictEqual(metric.prompt_tokens, 250);
      assert.strictEqual(metric.completion_tokens, 85);
      assert.strictEqual(metric.is_failover, false);
      assert.strictEqual(metric.status, 'success');
    });
  });

  describe('2. aiClient: Token Usage & Model Metadata Capture', () => {
    it('should capture prompt_tokens, completion_tokens, and actual model_used from OpenRouter response', async () => {
      const mockFetch = async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          model: 'anthropic/claude-3.5-sonnet:beta',
          usage: {
            prompt_tokens: 312,
            completion_tokens: 64,
            total_tokens: 376
          },
          choices: [
            {
              message: {
                content: JSON.stringify({
                  supplier_sku: 'TEL-SKU-001',
                  thread_size: 'M10',
                  length_mm: 50,
                  grade: '10.9'
                })
              }
            }
          ]
        })
      });

      const result = await extractWithFallback({
        rawData: 'Bolt M10 50mm 10.9',
        fileType: 'csv',
        schemaSnapshot,
        options: { fetchFn: mockFetch }
      });

      assert.strictEqual(result.model_used, 'anthropic/claude-3.5-sonnet:beta');
      assert.strictEqual(result.prompt_tokens, 312);
      assert.strictEqual(result.completion_tokens, 64);
      assert.strictEqual(result.metadata.model_name, 'anthropic/claude-3.5-sonnet:beta');
      assert.strictEqual(result.metadata.prompt_tokens, 312);
      assert.strictEqual(result.metadata.completion_tokens, 64);
      assert.strictEqual(result.attempts.length, 1);
      assert.strictEqual(result.attempts[0].is_failover, false);
      assert.strictEqual(result.attempts[0].status, 'success');
      assert.strictEqual(result.attempts[0].prompt_tokens, 312);
      assert.strictEqual(result.attempts[0].completion_tokens, 64);
    });

    it('should return token telemetry when invoked through extractProductAttributes wrapper', async () => {
      const mockFetch = async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          model: 'openai/gpt-4o-mini',
          usage: {
            prompt_tokens: 180,
            completion_tokens: 42
          },
          choices: [
            {
              message: {
                content: JSON.stringify({
                  supplier_sku: 'TEL-SKU-002',
                  thread_size: 'M8',
                  length_mm: 40,
                  grade: '8.8'
                })
              }
            }
          ]
        })
      });

      const result = await extractProductAttributes('Bolt M8 40mm 8.8', schemaSnapshot, { fetchFn: mockFetch });

      assert.strictEqual(result.model_used, 'openai/gpt-4o-mini');
      assert.strictEqual(result.prompt_tokens, 180);
      assert.strictEqual(result.completion_tokens, 42);
      assert.strictEqual(result.attributes.supplier_sku, 'TEL-SKU-002');
      assert.strictEqual(result.attempts.length, 1);
    });

    it('should record both primary and failover attempts with token stats on fallback', async () => {
      let callCount = 0;
      const mockFetch = async () => {
        callCount++;
        if (callCount === 1) {
          // Primary call fails with 500
          return {
            ok: false,
            status: 500,
            statusText: 'Internal Server Error',
            text: async () => 'Primary model temporarily overloaded'
          };
        }

        // Fallback call succeeds
        return {
          ok: true,
          status: 200,
          json: async () => ({
            model: 'openai/gpt-4o-mini-2024-07-18',
            usage: {
              prompt_tokens: 215,
              completion_tokens: 55
            },
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    supplier_sku: 'FALLBACK-SKU-001',
                    thread_size: 'M12',
                    length_mm: 70,
                    grade: '12.9'
                  })
                }
              }
            ]
          })
        };
      };

      const result = await extractWithFallback({
        rawData: 'Bolt M12 70mm 12.9',
        fileType: 'csv',
        schemaSnapshot,
        options: { fetchFn: mockFetch }
      });

      assert.strictEqual(result.metadata.model_used, 'fallback');
      assert.strictEqual(result.prompt_tokens, 215);
      assert.strictEqual(result.completion_tokens, 55);
      assert.strictEqual(result.attempts.length, 2);

      // Attempt 1: Primary failed
      assert.strictEqual(result.attempts[0].is_failover, false);
      assert.strictEqual(result.attempts[0].status, 'error');
      assert.strictEqual(result.attempts[0].model_used, DEFAULT_PRIMARY_MODEL);
      assert.ok(result.attempts[0].error_message.includes('500'));

      // Attempt 2: Fallback succeeded
      assert.strictEqual(result.attempts[1].is_failover, true);
      assert.strictEqual(result.attempts[1].status, 'success');
      assert.strictEqual(result.attempts[1].model_used, 'openai/gpt-4o-mini-2024-07-18');
      assert.strictEqual(result.attempts[1].prompt_tokens, 215);
      assert.strictEqual(result.attempts[1].completion_tokens, 55);
    });
  });

  describe('3. Worker Loop: extraction_metrics Persistence', () => {
    it('should log telemetry to extraction_metrics and link product_id on successful AI extraction', async () => {
      const jobRes = await pool.query(
        `INSERT INTO extraction_jobs (merchant_id, model_version_id, file_id, status)
         VALUES ($1, $2, $3, 'PENDING')
         RETURNING id`,
        [merchantId, modelVersionId, fileId]
      );
      const testJobId = jobRes.rows[0].id;
      createdJobIds.push(testJobId);

      const mockFetch = async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          model: 'anthropic/claude-3.5-sonnet',
          usage: {
            prompt_tokens: 340,
            completion_tokens: 72
          },
          choices: [
            {
              message: {
                content: JSON.stringify({
                  supplier_sku: 'WORKER-METRIC-001',
                  thread_size: 'M16',
                  length_mm: 100,
                  grade: '12.9'
                })
              }
            }
          ]
        })
      });

      await processJob(
        testJobId,
        {
          useAi: true,
          fetchFn: mockFetch,
          items: [{ raw: 'Fastener M16 100mm Grade 12.9' }]
        },
        pool
      );

      // Query extraction_metrics
      const metricsRes = await pool.query(
        `SELECT * FROM extraction_metrics WHERE job_id = $1`,
        [testJobId]
      );

      assert.strictEqual(metricsRes.rows.length, 1);
      const metric = metricsRes.rows[0];

      assert.strictEqual(metric.job_id, testJobId);
      assert.ok(metric.product_id, 'product_id should be linked after successful ingestion');
      assert.strictEqual(metric.model_used, 'anthropic/claude-3.5-sonnet');
      assert.strictEqual(metric.prompt_tokens, 340);
      assert.strictEqual(metric.completion_tokens, 72);
      assert.strictEqual(metric.is_failover, false);
      assert.strictEqual(metric.status, 'success');

      // Verify product exists in extracted_products
      const prodRes = await pool.query(
        `SELECT * FROM extracted_products WHERE id = $1`,
        [metric.product_id]
      );
      assert.strictEqual(prodRes.rows.length, 1);
      assert.strictEqual(prodRes.rows[0].supplier_sku, 'WORKER-METRIC-001');
    });

    it('should log 2 extraction_metrics rows (error + fallback) when failover occurs in worker', async () => {
      const jobRes = await pool.query(
        `INSERT INTO extraction_jobs (merchant_id, model_version_id, file_id, status)
         VALUES ($1, $2, $3, 'PENDING')
         RETURNING id`,
        [merchantId, modelVersionId, fileId]
      );
      const testJobId = jobRes.rows[0].id;
      createdJobIds.push(testJobId);

      let callCount = 0;
      const mockFetch = async () => {
        callCount++;
        if (callCount === 1) {
          return {
            ok: false,
            status: 502,
            statusText: 'Bad Gateway',
            text: async () => 'OpenRouter primary provider unavailable'
          };
        }

        return {
          ok: true,
          status: 200,
          json: async () => ({
            model: 'openai/gpt-4o-mini',
            usage: {
              prompt_tokens: 195,
              completion_tokens: 48
            },
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    supplier_sku: 'WORKER-FAILOVER-001',
                    thread_size: 'M14',
                    length_mm: 90,
                    grade: '10.9'
                  })
                }
              }
            ]
          })
        };
      };

      await processJob(
        testJobId,
        {
          useAi: true,
          fetchFn: mockFetch,
          items: [{ raw: 'Fastener M14 90mm Grade 10.9' }]
        },
        pool
      );

      const metricsRes = await pool.query(
        `SELECT * FROM extraction_metrics WHERE job_id = $1 ORDER BY created_at ASC`,
        [testJobId]
      );

      assert.strictEqual(metricsRes.rows.length, 2, 'Should have logged 2 metric attempts');

      // 1. Primary failure attempt
      const primaryMetric = metricsRes.rows[0];
      assert.strictEqual(primaryMetric.is_failover, false);
      assert.strictEqual(primaryMetric.status, 'error');
      assert.strictEqual(primaryMetric.model_used, DEFAULT_PRIMARY_MODEL);
      assert.ok(primaryMetric.error_message.includes('502'));

      // 2. Fallback success attempt
      const fallbackMetric = metricsRes.rows[1];
      assert.strictEqual(fallbackMetric.is_failover, true);
      assert.strictEqual(fallbackMetric.status, 'success');
      assert.strictEqual(fallbackMetric.model_used, 'openai/gpt-4o-mini');
      assert.strictEqual(fallbackMetric.prompt_tokens, 195);
      assert.strictEqual(fallbackMetric.completion_tokens, 48);
      assert.ok(fallbackMetric.product_id, 'Fallback metric should be linked to created product');
    });

    it('should log telemetry into extraction_metrics for hard errors when extraction fails completely', async () => {
      const jobRes = await pool.query(
        `INSERT INTO extraction_jobs (merchant_id, model_version_id, file_id, status)
         VALUES ($1, $2, $3, 'PENDING')
         RETURNING id`,
        [merchantId, modelVersionId, fileId]
      );
      const testJobId = jobRes.rows[0].id;
      createdJobIds.push(testJobId);

      // Both primary and fallback fail with 500
      const mockFetch = async () => ({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: async () => 'Provider total outage'
      });

      await processJob(
        testJobId,
        {
          useAi: true,
          fetchFn: mockFetch,
          items: [{ raw: 'Unparseable item' }]
        },
        pool
      );

      const metricsRes = await pool.query(
        `SELECT * FROM extraction_metrics WHERE job_id = $1 ORDER BY created_at ASC`,
        [testJobId]
      );

      // Incurred attempts must be recorded even on total job failure!
      assert.ok(metricsRes.rows.length >= 2, 'Should have logged attempts for primary and fallback failures');
      assert.strictEqual(metricsRes.rows[0].status, 'error');
      assert.strictEqual(metricsRes.rows[0].is_failover, false);
      assert.strictEqual(metricsRes.rows[0].product_id, null);

      assert.strictEqual(metricsRes.rows[1].status, 'error');
      assert.strictEqual(metricsRes.rows[1].is_failover, true);
      assert.strictEqual(metricsRes.rows[1].product_id, null);
    });

    it('should link product_id to extraction_metrics if product fails validation into FAILED_EXTRACTION', async () => {
      const jobRes = await pool.query(
        `INSERT INTO extraction_jobs (merchant_id, model_version_id, file_id, status)
         VALUES ($1, $2, $3, 'PENDING')
         RETURNING id`,
        [merchantId, modelVersionId, fileId]
      );
      const testJobId = jobRes.rows[0].id;
      createdJobIds.push(testJobId);

      const mockFetch = async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          model: 'anthropic/claude-3.5-sonnet',
          usage: {
            prompt_tokens: 280,
            completion_tokens: 35
          },
          choices: [
            {
              message: {
                content: JSON.stringify({
                  supplier_sku: 'FAILED-EXT-SKU-001',
                  thread_size: 'M8',
                  length_mm: 50,
                  grade: '8.8'
                })
              }
            }
          ]
        })
      });

      await processJob(
        testJobId,
        {
          useAi: true,
          fetchFn: mockFetch,
          itemProcessor: () => ({
            valid: false,
            error: 'Custom compliance rule rejection'
          }),
          items: [{ raw: 'Fastener M8 50mm 8.8 rejected by compliance' }]
        },
        pool
      );

      // Verify product is in FAILED_EXTRACTION state
      const prodRes = await pool.query(
        `SELECT id, state FROM extracted_products WHERE job_id = $1 AND supplier_sku = 'FAILED-EXT-SKU-001'`,
        [testJobId]
      );
      assert.strictEqual(prodRes.rows.length, 1);
      assert.strictEqual(prodRes.rows[0].state, 'FAILED_EXTRACTION');

      // Verify extraction_metrics has product_id linked to the failed product
      const metricsRes = await pool.query(
        `SELECT * FROM extraction_metrics WHERE job_id = $1`,
        [testJobId]
      );
      assert.strictEqual(metricsRes.rows.length, 1);
      assert.strictEqual(metricsRes.rows[0].product_id, prodRes.rows[0].id);
      assert.strictEqual(metricsRes.rows[0].prompt_tokens, 280);
      assert.strictEqual(metricsRes.rows[0].completion_tokens, 35);
    });
  });
});
