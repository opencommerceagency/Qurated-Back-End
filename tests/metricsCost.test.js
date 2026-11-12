import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import express from 'express';
import { pool } from '../src/db/index.js';
import metricsRoutes from '../src/routes/metrics.js';
import {
  calculateTokenCost,
  getModelPricing
} from '../src/services/costCalculator.js';

describe('B4.2 PR 2: AI Cost Tracking & Metrics API (GET /api/metrics/ai-costs)', () => {
  const merchantA = '11111111-1111-1111-1111-111111111111';
  const merchantB = '22222222-2222-2222-2222-222222222222';

  let app;
  let server;
  let baseUrl;

  let modelAId;
  let modelVersionAId;
  let fileAId;

  let jobAId;
  let jobBId;

  const createdModelIds = [];
  const createdJobIds = [];
  const createdFileIds = [];

  before(async () => {
    // Clean up any stale records from previous runs
    await pool.query('DELETE FROM extraction_metrics WHERE job_id IN (SELECT id FROM extraction_jobs WHERE merchant_id = $1 OR merchant_id = $2)', [merchantA, merchantB]);
    await pool.query('DELETE FROM extracted_products WHERE merchant_id = $1 OR merchant_id = $2', [merchantA, merchantB]);
    await pool.query('DELETE FROM extraction_jobs WHERE merchant_id = $1 OR merchant_id = $2', [merchantA, merchantB]);
    await pool.query('DELETE FROM files WHERE merchant_id = $1 OR merchant_id = $2', [merchantA, merchantB]);
    await pool.query('DELETE FROM product_models WHERE merchant_id = $1 OR merchant_id = $2', [merchantA, merchantB]);

    // 1. Setup Express app on ephemeral port
    app = express();
    app.use(express.json());
    app.use('/api/metrics', metricsRoutes);

    await new Promise((resolve) => {
      server = app.listen(0, () => {
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}/api/metrics`;
        resolve();
      });
    });

    // 2. Seed Model & File for Merchant A
    const modelRes = await pool.query(
      `INSERT INTO product_models (merchant_id, name, description, status, schema_version, created_by, updated_by)
       VALUES ($1, 'Metrics Test Model', 'Model for cost metrics testing', 'ACTIVE', 1, 'admin', 'admin')
       RETURNING id`,
      [merchantA]
    );
    modelAId = modelRes.rows[0].id;
    createdModelIds.push(modelAId);

    const versionRes = await pool.query(
      `INSERT INTO product_model_versions (model_id, version, snapshot)
       VALUES ($1, 1, '{"name": "Metrics Test Model", "attributes": []}'::jsonb)
       RETURNING id`,
      [modelAId]
    );
    modelVersionAId = versionRes.rows[0].id;

    const fileRes = await pool.query(
      `INSERT INTO files (merchant_id, filename, file_size, mime_type)
       VALUES ($1, 'catalog.csv', 1024, 'text/csv')
       RETURNING id`,
      [merchantA]
    );
    fileAId = fileRes.rows[0].id;
    createdFileIds.push(fileAId);

    // 3. Seed Job A for Merchant A (10 total attempted products)
    const jobARes = await pool.query(
      `INSERT INTO extraction_jobs (merchant_id, model_version_id, file_id, total_records, processed_records, failed_records, status)
       VALUES ($1, $2, $3, 10, 8, 2, 'COMPLETED')
       RETURNING id`,
      [merchantA, modelVersionAId, fileAId]
    );
    jobAId = jobARes.rows[0].id;
    createdJobIds.push(jobAId);

    // 4. Seed Job B for Merchant B (5 total attempted products)
    const jobBRes = await pool.query(
      `INSERT INTO extraction_jobs (merchant_id, model_version_id, file_id, total_records, processed_records, failed_records, status)
       VALUES ($1, $2, $3, 5, 5, 0, 'COMPLETED')
       RETURNING id`,
      [merchantB, modelVersionAId, fileAId]
    );
    jobBId = jobBRes.rows[0].id;
    createdJobIds.push(jobBId);
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
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

  describe('1. Unit Tests: costCalculator Service', () => {
    it('should correctly resolve pricing tiers for known and versioned model strings', () => {
      const claude = getModelPricing('anthropic/claude-3.5-sonnet');
      assert.strictEqual(claude.promptPricePerMillion, 3.00);
      assert.strictEqual(claude.completionPricePerMillion, 15.00);

      const claudeBeta = getModelPricing('anthropic/claude-3.5-sonnet:beta');
      assert.strictEqual(claudeBeta.promptPricePerMillion, 3.00);

      const gpt4oMini = getModelPricing('openai/gpt-4o-mini');
      assert.strictEqual(gpt4oMini.promptPricePerMillion, 0.15);
      assert.strictEqual(gpt4oMini.completionPricePerMillion, 0.60);

      const gpt4oMiniDated = getModelPricing('openai/gpt-4o-mini-2024-07-18');
      assert.strictEqual(gpt4oMiniDated.promptPricePerMillion, 0.15);

      const fallbackDefault = getModelPricing('some-unlisted/experimental-model');
      assert.ok(fallbackDefault.promptPricePerMillion > 0);
    });

    it('should calculate accurate token costs with precision', () => {
      // 1,000 prompt tokens and 200 completion tokens on Claude 3.5 Sonnet
      // prompt: (1000 / 1,000,000) * 3.00 = 0.003
      // completion: (200 / 1,000,000) * 15.00 = 0.003
      // total = 0.006
      const cost = calculateTokenCost('anthropic/claude-3.5-sonnet', 1000, 200);
      assert.strictEqual(cost.promptCost, 0.003);
      assert.strictEqual(cost.completionCost, 0.003);
      assert.strictEqual(cost.totalCost, 0.006);

      // 2,000 prompt tokens and 500 completion tokens on GPT-4o-mini
      // prompt: (2000 / 1,000,000) * 0.15 = 0.0003
      // completion: (500 / 1,000,000) * 0.60 = 0.0003
      // total = 0.0006
      const miniCost = calculateTokenCost('openai/gpt-4o-mini', 2000, 500);
      assert.strictEqual(miniCost.promptCost, 0.0003);
      assert.strictEqual(miniCost.completionCost, 0.0003);
      assert.strictEqual(miniCost.totalCost, 0.0006);
    });
  });

  describe('2. Job-Level AI Cost & Cost Per Product Calculation', () => {
    before(async () => {
      // Seed extraction_metrics for Job A:
      // 1. Claude 3.5 Sonnet: 1,000 prompt, 200 completion ($0.006)
      await pool.query(
        `INSERT INTO extraction_metrics (job_id, model_used, prompt_tokens, completion_tokens, is_failover, status)
         VALUES ($1, 'anthropic/claude-3.5-sonnet', 1000, 200, false, 'success')`,
        [jobAId]
      );

      // 2. GPT-4o-mini (failover): 2,000 prompt, 500 completion ($0.0006)
      await pool.query(
        `INSERT INTO extraction_metrics (job_id, model_used, prompt_tokens, completion_tokens, is_failover, status)
         VALUES ($1, 'openai/gpt-4o-mini', 2000, 500, true, 'success')`,
        [jobAId]
      );
    });

    it('should calculate total cost, tokens, and cost per product for a specific job_id', async () => {
      const res = await fetch(`${baseUrl}/ai-costs?job_id=${jobAId}`, {
        headers: { 'x-merchant-id': merchantA }
      });

      assert.strictEqual(res.status, 200);
      const data = await res.json();

      assert.strictEqual(data.job_id, jobAId);
      assert.strictEqual(data.total_prompt_tokens, 3000);
      assert.strictEqual(data.total_completion_tokens, 700);
      assert.strictEqual(data.total_tokens, 3700);
      assert.strictEqual(data.total_cost, 0.0066);

      // Total products attempted is 10 (not just the 8 processed)
      assert.strictEqual(data.total_products_attempted, 10);
      // cost_per_product: 0.0066 / 10 = 0.00066
      assert.strictEqual(data.cost_per_product, 0.00066);

      // Verify breakdown by model
      assert.strictEqual(data.breakdown_by_model.length, 2);
      const claudeEntry = data.breakdown_by_model.find((m) => m.model === 'anthropic/claude-3.5-sonnet');
      assert.ok(claudeEntry);
      assert.strictEqual(claudeEntry.prompt_tokens, 1000);
      assert.strictEqual(claudeEntry.completion_tokens, 200);
      assert.strictEqual(claudeEntry.total_cost, 0.006);

      const miniEntry = data.breakdown_by_model.find((m) => m.model === 'openai/gpt-4o-mini');
      assert.ok(miniEntry);
      assert.strictEqual(miniEntry.prompt_tokens, 2000);
      assert.strictEqual(miniEntry.completion_tokens, 500);
      assert.strictEqual(miniEntry.total_cost, 0.0006);
    });

    it('should divide total job cost by products ATTEMPTED, not just successfully stored ones', async () => {
      // Create a job where total_records is 20, processed is 12, failed is 8
      const partialJobRes = await pool.query(
        `INSERT INTO extraction_jobs (merchant_id, model_version_id, file_id, total_records, processed_records, failed_records, status)
         VALUES ($1, $2, $3, 20, 12, 8, 'PARTIALLY_FAILED')
         RETURNING id`,
        [merchantA, modelVersionAId, fileAId]
      );
      const partialJobId = partialJobRes.rows[0].id;
      createdJobIds.push(partialJobId);

      // Add metrics totaling $0.0100
      // 2,000 prompt, 266.66666 completion on Claude (~$0.0100)
      // Or 1,000,000 tokens on GPT-4o-mini:
      // prompt: 40,000 tokens -> $0.006
      // completion: 10,000 tokens -> $0.006
      // total = $0.012
      await pool.query(
        `INSERT INTO extraction_metrics (job_id, model_used, prompt_tokens, completion_tokens, is_failover, status)
         VALUES ($1, 'openai/gpt-4o-mini', 40000, 10000, false, 'success')`,
        [partialJobId]
      );

      const res = await fetch(`${baseUrl}/ai-costs?job_id=${partialJobId}`, {
        headers: { 'x-merchant-id': merchantA }
      });

      assert.strictEqual(res.status, 200);
      const data = await res.json();

      assert.strictEqual(data.total_cost, 0.012);
      assert.strictEqual(data.total_products_attempted, 20);
      // Cost per product should divide by 20 (attempted), NOT 12 (processed)!
      // 0.012 / 20 = 0.0006
      assert.strictEqual(data.cost_per_product, 0.0006);
      assert.notStrictEqual(data.cost_per_product, 0.012 / 12);
    });
  });

  describe('3. Strict Multi-Tenant Isolation', () => {
    before(async () => {
      // Seed metric for Merchant B's job
      await pool.query(
        `INSERT INTO extraction_metrics (job_id, model_used, prompt_tokens, completion_tokens, is_failover, status)
         VALUES ($1, 'openai/gpt-4o-mini', 5000, 1000, false, 'success')`,
        [jobBId]
      );
    });

    it('Merchant B querying job_id belonging to Merchant A returns 404 Not Found', async () => {
      const res = await fetch(`${baseUrl}/ai-costs?job_id=${jobAId}`, {
        headers: { 'x-merchant-id': merchantB }
      });

      assert.strictEqual(res.status, 404);
      const data = await res.json();
      assert.strictEqual(data.error, 'Extraction job not found');
    });

    it('Merchant B querying without job_id never sees Merchant A metrics or costs', async () => {
      const res = await fetch(`${baseUrl}/ai-costs`, {
        headers: { 'x-merchant-id': merchantB }
      });

      assert.strictEqual(res.status, 200);
      const data = await res.json();

      // Ensure only Job B is returned in the jobs list
      assert.strictEqual(data.jobs.length, 1);
      assert.strictEqual(data.jobs[0].job_id, jobBId);

      // Verify no leak of Merchant A job
      const hasJobA = data.jobs.some((j) => j.job_id === jobAId);
      assert.strictEqual(hasJobA, false);

      // Verify tokens match only Merchant B's metric
      assert.strictEqual(data.summary.total_prompt_tokens, 5000);
      assert.strictEqual(data.summary.total_completion_tokens, 1000);
    });
  });

  describe('4. Date Range Filtering & Global Overview', () => {
    let oldJobId;
    let recentJobId;

    before(async () => {
      // Seed a job and metric with old created_at (10 days ago)
      const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
      const oldJobRes = await pool.query(
        `INSERT INTO extraction_jobs (merchant_id, model_version_id, file_id, total_records, status, created_at)
         VALUES ($1, $2, $3, 4, 'COMPLETED', $4)
         RETURNING id`,
        [merchantA, modelVersionAId, fileAId, oldDate]
      );
      oldJobId = oldJobRes.rows[0].id;
      createdJobIds.push(oldJobId);

      await pool.query(
        `INSERT INTO extraction_metrics (job_id, model_used, prompt_tokens, completion_tokens, is_failover, status, created_at)
         VALUES ($1, 'anthropic/claude-3.5-sonnet', 500, 100, false, 'success', $2)`,
        [oldJobId, oldDate]
      );

      // Seed a job and metric created today
      const recentJobRes = await pool.query(
        `INSERT INTO extraction_jobs (merchant_id, model_version_id, file_id, total_records, status, created_at)
         VALUES ($1, $2, $3, 6, 'COMPLETED', NOW())
         RETURNING id`,
        [merchantA, modelVersionAId, fileAId]
      );
      recentJobId = recentJobRes.rows[0].id;
      createdJobIds.push(recentJobId);

      await pool.query(
        `INSERT INTO extraction_metrics (job_id, model_used, prompt_tokens, completion_tokens, is_failover, status, created_at)
         VALUES ($1, 'openai/gpt-4o-mini', 800, 200, false, 'success', NOW())`,
        [recentJobId]
      );
    });

    it('should filter metrics by "from" date range parameter', async () => {
      // Query from 3 days ago: should only include recentJobId, not oldJobId
      const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();

      const res = await fetch(`${baseUrl}/ai-costs?from=${threeDaysAgo}`, {
        headers: { 'x-merchant-id': merchantA }
      });

      assert.strictEqual(res.status, 200);
      const data = await res.json();

      const jobIds = data.jobs.map((j) => j.job_id);
      assert.ok(jobIds.includes(recentJobId), 'Recent job should be included');
      assert.ok(!jobIds.includes(oldJobId), 'Old job must NOT be included with from filter');
    });

    it('should filter metrics by "to" date range parameter', async () => {
      // Query to 3 days ago: should only include oldJobId, not recentJobId
      const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();

      const res = await fetch(`${baseUrl}/ai-costs?to=${threeDaysAgo}`, {
        headers: { 'x-merchant-id': merchantA }
      });

      assert.strictEqual(res.status, 200);
      const data = await res.json();

      const jobIds = data.jobs.map((j) => j.job_id);
      assert.ok(jobIds.includes(oldJobId), 'Old job should be included with to filter');
      assert.ok(!jobIds.includes(recentJobId), 'Recent job must NOT be included with to filter');
    });
  });

  describe('5. Input Validation & Error Handling', () => {
    it('should reject request missing x-merchant-id header with 400 Bad Request', async () => {
      const res = await fetch(`${baseUrl}/ai-costs`);
      assert.strictEqual(res.status, 400);
      const data = await res.json();
      assert.ok(data.error.includes('x-merchant-id'));
    });

    it('should reject request with malformed x-merchant-id header with 400 Bad Request', async () => {
      const res = await fetch(`${baseUrl}/ai-costs`, {
        headers: { 'x-merchant-id': 'not-a-valid-uuid' }
      });
      assert.strictEqual(res.status, 400);
      const data = await res.json();
      assert.ok(data.error.includes('x-merchant-id'));
    });

    it('should reject malformed job_id query parameter with 400 Bad Request', async () => {
      const res = await fetch(`${baseUrl}/ai-costs?job_id=invalid-uuid-string`, {
        headers: { 'x-merchant-id': merchantA }
      });
      assert.strictEqual(res.status, 400);
      const data = await res.json();
      assert.ok(data.error.includes('UUID') || data.error.includes('job_id'));
    });

    it('should return 404 when querying a non-existent job_id', async () => {
      const nonExistentUuid = '99999999-9999-9999-9999-999999999999';
      const res = await fetch(`${baseUrl}/ai-costs?job_id=${nonExistentUuid}`, {
        headers: { 'x-merchant-id': merchantA }
      });
      assert.strictEqual(res.status, 404);
      const data = await res.json();
      assert.strictEqual(data.error, 'Extraction job not found');
    });
  });
});

