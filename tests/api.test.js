import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import express from 'express';
import { pool } from '../src/db/index.js';
import sourceRouter from '../src/routes/sources.js';
import { validateSafeUrl } from '../src/utils/urlValidator.js';
import { sourceCreateSchema } from '../src/schemas/sourceSchema.js';

// Ensure test environment has valid dummy credentials
process.env.API_KEY = process.env.API_KEY || 'qurated_dev_api_key_2026';
process.env.API_AUTH_USER = process.env.API_AUTH_USER || 'admin';
process.env.API_AUTH_PASS = process.env.API_AUTH_PASS || 'qurated_dev_password';

describe('Source API Endpoints & Security (Milestone B1 Fixes)', () => {
  let app;
  let server;
  let baseUrl;
  const merchantA = '00000000-0000-0000-0000-000000000001';
  const merchantB = '00000000-0000-0000-0000-000000000002';
  const validApiKey = 'qurated_dev_api_key_2026';
  let createdSourceId;

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
  });

  after(async () => {
    if (createdSourceId) {
      await pool.query('DELETE FROM sources WHERE id = $1', [createdSourceId]);
    }
    await new Promise((resolve) => server.close(resolve));
    await pool.end();
  });

  it('GET /api/sources should reject requests missing an API key with 401 Unauthorized', async () => {
    // Reject unauthenticated requests
    const res = await fetch(baseUrl, {
      headers: { 'x-merchant-id': merchantA }
    });

    assert.strictEqual(res.status, 401);
    const data = await res.json();
    assert.ok(data.error.includes('Unauthorized'));
  });

  it('GET /api/sources should fail closed with 500 if server auth is unconfigured', async () => {
    // Fail closed when API_KEY is missing in env
    const savedApiKey = process.env.API_KEY;

    try {
      delete process.env.API_KEY;

      const res = await fetch(baseUrl, {
        headers: {
          'x-merchant-id': merchantA,
          'x-api-key': 'any-key'
        }
      });

      assert.strictEqual(res.status, 500);
      const data = await res.json();
      assert.strictEqual(data.error, 'Server authentication misconfiguration');
    } finally {
      process.env.API_KEY = savedApiKey;
    }
  });

  it('GET /api/sources should reject missing or invalid x-merchant-id header with 400 Bad Request', async () => {
    // Reject missing or non-UUID merchant IDs
    const testCases = [
      { name: 'missing header', headers: { 'x-api-key': validApiKey } },
      { name: 'numeric id', headers: { 'x-api-key': validApiKey, 'x-merchant-id': '1' } },
      { name: 'arbitrary string', headers: { 'x-api-key': validApiKey, 'x-merchant-id': 'test' } },
      { name: 'test-tenant string', headers: { 'x-api-key': validApiKey, 'x-merchant-id': 'test-tenant' } },
      { name: 'sql injection attempt', headers: { 'x-api-key': validApiKey, 'x-merchant-id': "' OR 1=1" } },
      { name: 'short uuid', headers: { 'x-api-key': validApiKey, 'x-merchant-id': '12345' } }
    ];

    for (const tc of testCases) {
      const res = await fetch(baseUrl, { headers: tc.headers });
      assert.strictEqual(res.status, 400, `Expected 400 for ${tc.name}`);
      const data = await res.json();
      assert.strictEqual(data.error, 'Invalid or missing x-merchant-id header. Must be a valid UUID.');
    }
  });

  it('POST /api/sources should reject SSRF attempts with local file or private IP URLs', async () => {
    // Block local files and private IPs
    const privateIpPayload = {
      name: 'Malicious Source',
      type: 'csv',
      connection_config: { url: 'http://127.0.0.1:8080/internal.csv' }
    };

    const res1 = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-merchant-id': merchantA,
        'x-api-key': validApiKey
      },
      body: JSON.stringify(privateIpPayload)
    });
    assert.strictEqual(res1.status, 400);

    const filePayload = {
      name: 'File Scheme Source',
      type: 'csv',
      connection_config: { url: 'file:///etc/passwd' }
    };

    const res2 = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-merchant-id': merchantA,
        'x-api-key': validApiKey
      },
      body: JSON.stringify(filePayload)
    });
    assert.strictEqual(res2.status, 400);

    const windowsPathPayload = {
      name: 'Windows Path Source',
      type: 'csv',
      connection_config: { url: 'C:\\secrets.csv' }
    };

    const res3 = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-merchant-id': merchantA,
        'x-api-key': validApiKey
      },
      body: JSON.stringify(windowsPathPayload)
    });
    assert.strictEqual(res3.status, 400);
  });

  it('POST /api/sources should mask sensitive credentials in 201 response and store protocol', async () => {
    // Keep format and protocol strictly separate
    const payload = {
      name: 'Hardware Supplier API Test',
      type: 'csv',
      protocol: 'HTTP',
      default_model_id: 'google/gemini-flash-1.5',
      connection_config: {
        url: 'https://example.com/products.csv',
        password: 'my_super_secret_password',
        api_key: 'sk_live_1234567890',
        token: 'auth_bearer_token_xyz'
      },
      schedule_cron: '0 4 * * *'
    };

    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-merchant-id': merchantA,
        'x-api-key': validApiKey
      },
      body: JSON.stringify(payload)
    });

    assert.strictEqual(res.status, 201);
    const data = await res.json();
    createdSourceId = data.id;

    assert.ok(data.id, 'Expected source ID in response');
    assert.strictEqual(data.name, payload.name);
    assert.strictEqual(data.type, 'csv');
    assert.strictEqual(data.protocol, 'HTTP');
    // Verify credential masking in response
    assert.strictEqual(data.connection_config.password, '********');
    assert.strictEqual(data.connection_config.api_key, '********');
    assert.strictEqual(data.connection_config.token, '********');
  });

  it('GET /api/sources/:id should mask sensitive credentials in 200 response with Bearer auth', async () => {
    const res = await fetch(`${baseUrl}/${createdSourceId}`, {
      headers: {
        'x-merchant-id': merchantA,
        'Authorization': `Bearer ${validApiKey}`
      }
    });

    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.id, createdSourceId);
    assert.strictEqual(data.connection_config.password, '********');
    assert.strictEqual(data.connection_config.api_key, '********');
    assert.strictEqual(data.connection_config.token, '********');
  });

  it('GET /api/sources/:id should enforce multi-tenant isolation (404 for different merchant)', async () => {
    const res = await fetch(`${baseUrl}/${createdSourceId}`, {
      headers: {
        'x-merchant-id': merchantB,
        'x-api-key': validApiKey
      }
    });

    assert.strictEqual(res.status, 404);
  });

  it('PUT /api/sources/:id should mask sensitive credentials in 200 response', async () => {
    const updatePayload = {
      name: 'Hardware Supplier API Test (Renamed)',
      connection_config: {
        url: 'https://example.com/updated.csv',
        password: 'another_secret_password'
      }
    };

    const res = await fetch(`${baseUrl}/${createdSourceId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'x-merchant-id': merchantA,
        'x-api-key': validApiKey
      },
      body: JSON.stringify(updatePayload)
    });

    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.name, 'Hardware Supplier API Test (Renamed)');
    assert.strictEqual(data.connection_config.password, '********');
  });

  it('PUT /api/sources/:id with empty body should not leak cleartext credentials', async () => {
    // Empty updates must never echo unmasked credentials
    const res = await fetch(`${baseUrl}/${createdSourceId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'x-merchant-id': merchantA,
        'x-api-key': validApiKey
      },
      body: JSON.stringify({})
    });

    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.connection_config.password, '********');
  });

  it('DELETE /api/sources/:id should perform soft delete (status ARCHIVED)', async () => {
    const res = await fetch(`${baseUrl}/${createdSourceId}`, {
      method: 'DELETE',
      headers: {
        'x-merchant-id': merchantA,
        'x-api-key': validApiKey
      }
    });

    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.status, 'deleted');

    // Verify row still exists in DB as ARCHIVED
    const dbCheck = await pool.query('SELECT status, archived_at FROM sources WHERE id = $1', [createdSourceId]);
    assert.strictEqual(dbCheck.rows.length, 1);
    assert.strictEqual(dbCheck.rows[0].status, 'ARCHIVED');
    assert.ok(dbCheck.rows[0].archived_at !== null);
  });

  it('should validate URLs and reject all local filesystem paths and file schemes', async () => {
    // Reject local paths in validator and schema
    const invalidUrls = [
      'file:///etc/passwd',
      'file://C:/data/feed.csv',
      'C:\\data\\feed.csv',
      'c:/windows/system32/calc.exe',
      'D:\\supplier\\catalog.csv',
      '/etc/shadow',
      '/var/log/messages.csv',
      './local_feed.csv',
      '../parent_feed.csv',
      '.\\relative.csv',
      '..\\relative.csv',
      'feed.csv',
      'javascript:alert(1)'
    ];

    for (const url of invalidUrls) {
      // 1. validator check
      assert.throws(
        () => validateSafeUrl(url),
        (err) => err instanceof Error,
        `Expected validateSafeUrl to throw for ${url}`
      );

      // 2. schema check
      const parseResult = sourceCreateSchema.safeParse({
        name: 'Invalid Path Source',
        type: 'csv',
        connection_config: { url }
      });
      assert.strictEqual(parseResult.success, false, `Expected schema to reject ${url}`);
      assert.ok(parseResult.error.flatten().fieldErrors.connection_config?.length > 0);
    }
  });

  it('should accept valid absolute HTTP and FTP URLs in schema validation', async () => {
    const validHttp = sourceCreateSchema.safeParse({
      name: 'Valid HTTP Source',
      type: 'csv',
      protocol: 'HTTP',
      connection_config: { url: 'https://supplier.example.com/feed.csv' }
    });
    assert.strictEqual(validHttp.success, true);

    const validFtp = sourceCreateSchema.safeParse({
      name: 'Valid FTP Source',
      type: 'csv',
      protocol: 'FTP',
      connection_config: { url: 'ftp://ftp.supplier.example.com/feed.csv' }
    });
    assert.strictEqual(validFtp.success, true);
  });
});
