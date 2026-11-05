// End-to-end ingestion test from API to database.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import express from 'express';
import { pool } from '../src/db/index.js';
import sourceRouter from '../src/routes/sources.js';

// Ensure test environment has valid dummy credentials.
process.env.API_KEY = process.env.API_KEY || 'qurated_dev_api_key_2026';
process.env.API_AUTH_USER = process.env.API_AUTH_USER || 'admin';
process.env.API_AUTH_PASS = process.env.API_AUTH_PASS || 'qurated_dev_password';

describe('End-to-End Ingestion Pipeline (Milestone B1 Full Lifecycle)', () => {
  let app;
  let server;
  let baseUrl;
  const merchantId = '00000000-0000-0000-0000-000000000001';
  const apiKey = 'qurated_dev_api_key_2026';
  let createdSourceId;
  let originalFetch;

  // Spin up an in-memory Express server and mock the remote supplier stream.
  before(async () => {
    app = express();
    app.use(express.json());
    app.use('/api/sources', sourceRouter);

    await new Promise((resolve) => {
      server = app.listen(0, () => {
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}/api/sources`;
        resolve();
      });
    });

    // Mock the remote supplier CSV download stream.
    originalFetch = globalThis.fetch;
    const csvContent = [
      'sku,name,price,ean,weight',
      'SKU-E2E-1,High Grade Hammer,"€ 80,56",4006381333931,1300 gram',
      'SKU-E2E-2,Steel Fixing Bolt,"1.280,56",012345678905,2.5 kg',
      ',Missing SKU Item,"10.50",4006381333931,500ml',
      'SKU-E2E-BAD1,Corrupt Barcode Item,"25.00",4006381333932,2.5 kg',
      'SKU-E2E-BAD2,Corrupt Price Item,"corrupted_price",4006381333931,10 m',
      '',
      '   '
    ].join('\n');

    globalThis.fetch = async (url, options) => {
      // Forward requests aimed at the local test Express server to the original fetch.
      if (typeof url === 'string' && (url.includes('127.0.0.1') || url.includes('localhost'))) {
        return originalFetch(url, options);
      }

      // otherwise return the mock supplier stream
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(csvContent));
          controller.close();
        }
      });

      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'text/csv' }),
        body: stream
      };
    };
  });

  // Clean up database records and close active resources.
  after(async () => {
    globalThis.fetch = originalFetch;

    if (createdSourceId) {
      await pool.query('DELETE FROM sources WHERE id = $1', [createdSourceId]);
    }

    await new Promise((resolve) => server.close(resolve));
    await pool.end();
  });

  it('should run full lifecycle: create source, trigger sync, normalize clean records, triage dirty records', async () => {
    // 1. Create source via API
    // Keep file format and transport protocol strictly decoupled.
    const createPayload = {
      name: 'E2E Hardware Supplier Catalog',
      type: 'csv',
      protocol: 'HTTP',
      default_model_id: 'google/gemini-flash-1.5',
      connection_config: {
        url: 'https://suppliers.opencommerce.io/hardware.csv',
        delimiter: ','
      }
    };

    const createRes = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-merchant-id': merchantId,
        'x-api-key': apiKey
      },
      body: JSON.stringify(createPayload)
    });

    assert.strictEqual(createRes.status, 201);
    const sourceData = await createRes.json();
    createdSourceId = sourceData.id;
    assert.ok(createdSourceId, 'Source ID should be generated');
    assert.strictEqual(sourceData.type, 'csv');
    assert.strictEqual(sourceData.protocol, 'HTTP');

    // 2. Trigger sync on demand via POST /api/sources/:id/sync
    const syncRes = await fetch(`${baseUrl}/${createdSourceId}/sync`, {
      method: 'POST',
      headers: {
        'x-merchant-id': merchantId,
        'x-api-key': apiKey
      }
    });

    assert.strictEqual(syncRes.status, 202);
    const syncData = await syncRes.json();
    assert.strictEqual(syncData.message, 'Ingestion started');
    const runId = syncData.run_id;
    assert.ok(runId, 'Ingestion run ID should be returned');

    // 3. Poll database until ingestion run completes
    let run;
    for (let attempts = 0; attempts < 30; attempts++) {
      const checkRes = await pool.query('SELECT * FROM ingestion_runs WHERE id = $1', [runId]);
      if (checkRes.rows.length > 0 && checkRes.rows[0].status !== 'PROCESSING') {
        run = checkRes.rows[0];
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    assert.ok(run, 'Expected run to complete');
    assert.strictEqual(run.status, 'COMPLETED');
    assert.strictEqual(run.total_rows, 5);
    assert.strictEqual(run.valid_rows, 2);
    assert.strictEqual(run.failed_rows, 3);
    assert.strictEqual(run.total_rows, run.valid_rows + run.failed_rows);

    // 4. Assert valid normalized records
    // Verify valid rows land in the normalized table.
    const normalizedRes = await pool.query(
      'SELECT * FROM normalized_records WHERE run_id = $1 ORDER BY sku ASC',
      [runId]
    );
    assert.strictEqual(normalizedRes.rows.length, 2);

    const hammer = normalizedRes.rows.find((r) => r.sku === 'SKU-E2E-1');
    assert.ok(hammer, 'Expected SKU-E2E-1 to be normalized');
    assert.strictEqual(parseFloat(hammer.price), 80.56);
    assert.strictEqual(hammer.currency, 'EUR');
    assert.strictEqual(hammer.ean, '4006381333931');
    assert.strictEqual(parseFloat(hammer.unit_value), 1300);
    assert.strictEqual(hammer.unit_type, 'g');

    const bolt = normalizedRes.rows.find((r) => r.sku === 'SKU-E2E-2');
    assert.ok(bolt, 'Expected SKU-E2E-2 to be normalized');
    assert.strictEqual(parseFloat(bolt.price), 1280.56);
    assert.strictEqual(parseFloat(bolt.unit_value), 2.5);
    assert.strictEqual(bolt.unit_type, 'kg');

    // 5. Assert flagged dirty records
    // Verify dirty rows land in the flagged table with explicit error reasons.
    const flaggedRes = await pool.query(
      'SELECT * FROM flagged_records WHERE run_id = $1 ORDER BY row_index ASC',
      [runId]
    );
    assert.strictEqual(flaggedRes.rows.length, 3);

    // Row 3 had missing SKU
    assert.strictEqual(flaggedRes.rows[0].row_index, 3);
    assert.deepStrictEqual(flaggedRes.rows[0].error_reasons, ['MISSING_SKU']);

    // Row 4 had bad EAN checksum
    assert.strictEqual(flaggedRes.rows[1].row_index, 4);
    assert.deepStrictEqual(flaggedRes.rows[1].error_reasons, ['INVALID_EAN_CHECKSUM']);

    // Row 5 had corrupted price
    assert.strictEqual(flaggedRes.rows[2].row_index, 5);
    assert.deepStrictEqual(flaggedRes.rows[2].error_reasons, ['INVALID_PRICE']);
  });
});
