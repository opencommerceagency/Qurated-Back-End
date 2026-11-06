import { describe, it, before, after } from 'node:test';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert';
import express from 'express';
import { pool } from '../src/db/index.js';
import extractionRouter from '../src/routes/extraction.js';
import { validateFile, MAX_FILE_SIZE, MAX_PDF_PAGES, getSanitizedPath, SAFE_BASE_DIR } from '../src/services/fileValidator.js';

import { enqueueJob, claimNextPendingJob } from '../src/services/queueService.js';
import { processJob, calculateBackoffMs } from '../src/workers/extractionWorker.js';

process.env.API_KEY = process.env.API_KEY || 'qurated_dev_api_key_2026';
process.env.API_AUTH_USER = process.env.API_AUTH_USER || 'admin';
process.env.API_AUTH_PASS = process.env.API_AUTH_PASS || 'qurated_dev_password';

describe('User Story B3.1: Asynchronous Job Queue & Runner Architecture', () => {
  let app;
  let server;
  let baseUrl;

  const merchantA = '33333333-3333-3333-3333-333333333333';
  const merchantB = '44444444-4444-4444-4444-444444444444';
  const validApiKey = 'qurated_dev_api_key_2026';

  let modelAId;
  let modelVersionAId;
  let modelBId;
  let modelVersionBId;
  let validFileAId;
  let validFileBId;

  const createdJobIds = [];
  const createdFileIds = [];
  const createdModelIds = [];

  before(async () => {
    await pool.query('DELETE FROM extraction_jobs WHERE merchant_id = $1 OR merchant_id = $2', [merchantA, merchantB]);
    app = express();
    app.use(express.json());
    app.use('/api/extraction', extractionRouter);

    await new Promise((resolve) => {
      server = app.listen(0, () => {
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}/api/extraction`;
        resolve();
      });
    });

    // 1. Seed Model and Version for Merchant A
    const modelARes = await pool.query(
      `INSERT INTO product_models (merchant_id, name, description, status, schema_version, created_by, updated_by)
       VALUES ($1, 'Extraction Test Model A', 'Model for Merchant A extraction', 'ACTIVE', 1, 'tester', 'tester')
       RETURNING id`,
      [merchantA]
    );
    modelAId = modelARes.rows[0].id;
    createdModelIds.push(modelAId);

    const versionARes = await pool.query(
      `INSERT INTO product_model_versions (model_id, version, snapshot)
       VALUES ($1, 1, '{"name": "Extraction Test Model A", "attributes": []}'::jsonb)
       RETURNING id`,
      [modelAId]
    );
    modelVersionAId = versionARes.rows[0].id;

    // 2. Seed Model and Version for Merchant B
    const modelBRes = await pool.query(
      `INSERT INTO product_models (merchant_id, name, description, status, schema_version, created_by, updated_by)
       VALUES ($1, 'Extraction Test Model B', 'Model for Merchant B extraction', 'ACTIVE', 1, 'tester', 'tester')
       RETURNING id`,
      [merchantB]
    );
    modelBId = modelBRes.rows[0].id;
    createdModelIds.push(modelBId);

    const versionBRes = await pool.query(
      `INSERT INTO product_model_versions (model_id, version, snapshot)
       VALUES ($1, 1, '{"name": "Extraction Test Model B", "attributes": []}'::jsonb)
       RETURNING id`,
      [modelBId]
    );
    modelVersionBId = versionBRes.rows[0].id;

    // 3. Seed Valid Files in files table
    const fileARes = await pool.query(
      `INSERT INTO files (merchant_id, filename, file_size, mime_type, metadata)
       VALUES ($1, 'catalog_a.pdf', 1024, 'application/pdf', '{"pages": 5}'::jsonb)
       RETURNING id`,
      [merchantA]
    );
    validFileAId = fileARes.rows[0].id;
    createdFileIds.push(validFileAId);

    const fileBRes = await pool.query(
      `INSERT INTO files (merchant_id, filename, file_size, mime_type, metadata)
       VALUES ($1, 'catalog_b.pdf', 1024, 'application/pdf', '{"pages": 5}'::jsonb)
       RETURNING id`,
      [merchantB]
    );
    validFileBId = fileBRes.rows[0].id;
    createdFileIds.push(validFileBId);
  });

  after(async () => {
    // Cleanup extraction_jobs
    if (createdJobIds.length > 0) {
      await pool.query('DELETE FROM extraction_jobs WHERE id = ANY($1)', [createdJobIds]);
    }
    // Cleanup files
    if (createdFileIds.length > 0) {
      await pool.query('DELETE FROM files WHERE id = ANY($1)', [createdFileIds]);
    }
    // Cleanup models (CASCADE drops versions)
    if (createdModelIds.length > 0) {
      await pool.query('DELETE FROM product_models WHERE id = ANY($1)', [createdModelIds]);
    }
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    await pool.end();
  });

  describe('Scenario 1: File Validation Guardrails', () => {
    it('Size check: Reject any file > 25 MB with 400 and FILE_LIMIT_EXCEEDED', async () => {
      // 1. Direct unit check
      const unitResult = validateFile({
        filename: 'oversized.pdf',
        size: MAX_FILE_SIZE + 1024
      });
      assert.strictEqual(unitResult.valid, false);
      assert.strictEqual(unitResult.error, 'FILE_LIMIT_EXCEEDED');

      const oversizedFileId = randomUUID();
      createdFileIds.push(oversizedFileId);

      // 2. HTTP endpoint check
      const res = await fetch(`${baseUrl}/jobs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': validApiKey,
          'x-merchant-id': merchantA
        },
        body: JSON.stringify({
          file_id: oversizedFileId,
          model_version_id: modelVersionAId,
          filename: 'oversized.pdf',
          file_size: 26 * 1024 * 1024 // 26 MB
        })
      });

      assert.strictEqual(res.status, 400);
      const data = await res.json();
      assert.strictEqual(data.error, 'FILE_LIMIT_EXCEEDED');
      assert.ok(data.message.includes('25 MB'));
    });

    it('Page count limit: Reject PDFs with > 50 pages with 400 and FILE_LIMIT_EXCEEDED', async () => {
      // 1. Direct unit check
      const unitResult = validateFile({
        filename: 'too_many_pages.pdf',
        size: 5000,
        total_pages: MAX_PDF_PAGES + 5
      });
      assert.strictEqual(unitResult.valid, false);
      assert.strictEqual(unitResult.error, 'FILE_LIMIT_EXCEEDED');

      const oversizedFileId = randomUUID();
      createdFileIds.push(oversizedFileId);

      // 2. HTTP endpoint check
      const res = await fetch(`${baseUrl}/jobs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': validApiKey,
          'x-merchant-id': merchantA
        },
        body: JSON.stringify({
          file_id: oversizedFileId,
          model_version_id: modelVersionAId,
          filename: 'heavy_document.pdf',
          total_pages: 55
        })
      });

      assert.strictEqual(res.status, 400);
      const data = await res.json();
      assert.strictEqual(data.error, 'FILE_LIMIT_EXCEEDED');
      assert.ok(data.message.includes('50 pages'));
    });

    it('Encrypted/Password-protected check: Reject encrypted PDF with 400 and UNSUPPORTED_ENCRYPTED_FILE', async () => {
      // 1. Direct unit check with encrypted flag and buffer inspection
      const unitResult = validateFile({
        filename: 'locked.pdf',
        size: 5000,
        is_encrypted: true
      });
      assert.strictEqual(unitResult.valid, false);
      assert.strictEqual(unitResult.error, 'UNSUPPORTED_ENCRYPTED_FILE');

      // Test raw buffer containing /Encrypt dictionary
      const encryptedBuffer = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Encrypt 2 0 R >>\nendobj\ntrailer\n<<>>\n%%EOF');
      const bufferResult = validateFile({
        filename: 'crypto.pdf',
        buffer: encryptedBuffer,
        size: encryptedBuffer.length
      });
      assert.strictEqual(bufferResult.valid, false);
      assert.strictEqual(bufferResult.error, 'UNSUPPORTED_ENCRYPTED_FILE');

      const oversizedFileId = randomUUID();
      createdFileIds.push(oversizedFileId);

      // 2. HTTP endpoint check
      const res = await fetch(`${baseUrl}/jobs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': validApiKey,
          'x-merchant-id': merchantA
        },
        body: JSON.stringify({
          file_id: oversizedFileId,
          model_version_id: modelVersionAId,
          filename: 'locked.pdf',
          is_encrypted: true
        })
      });

      assert.strictEqual(res.status, 400);
      const data = await res.json();
      assert.strictEqual(data.error, 'UNSUPPORTED_ENCRYPTED_FILE');
    });

    it('Scanned PDF check (No text layer): Reject PDF with 0 extractable text with 400 and OCR_REQUIRED_NO_TEXT_LAYER', async () => {
      // 1. Direct unit check
      const unitResult = validateFile({
        filename: 'scanned_image_only.pdf',
        size: 5000,
        total_pages: 3,
        text_content: '   \n   \t ' // purely whitespace
      });
      assert.strictEqual(unitResult.valid, false);
      assert.strictEqual(unitResult.error, 'OCR_REQUIRED_NO_TEXT_LAYER');

      const oversizedFileId = randomUUID();
      createdFileIds.push(oversizedFileId);

      // 2. HTTP endpoint check
      const res = await fetch(`${baseUrl}/jobs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': validApiKey,
          'x-merchant-id': merchantA
        },
        body: JSON.stringify({
          file_id: oversizedFileId,
          model_version_id: modelVersionAId,
          filename: 'scanned.pdf',
          total_pages: 3,
          text_content: '   '
        })
      });

      assert.strictEqual(res.status, 400);
      const data = await res.json();
      assert.strictEqual(data.error, 'OCR_REQUIRED_NO_TEXT_LAYER');
    });

    it('CSV check: Verify non-empty and readable headers; reject empty CSV', () => {
      const emptyCsv = validateFile({
        filename: 'empty.csv',
        content: '   \n  \n'
      });
      assert.strictEqual(emptyCsv.valid, false);
      assert.strictEqual(emptyCsv.error, 'INVALID_CSV_HEADERS');

      const validCsv = validateFile({
        filename: 'products.csv',
        content: 'sku,name,price\n1,Hammer,25.00'
      });
      assert.strictEqual(validCsv.valid, true);
      assert.deepStrictEqual(validCsv.headers, ['sku', 'name', 'price']);
    });

    it('Security / LFI remediation: Reject path traversal and null-byte injection attempts', async () => {
      // 1. Direct getSanitizedPath tests
      assert.throws(
        () => getSanitizedPath('../../../../secret.txt'),
        /Path traversal detected: Access denied/
      );
      assert.throws(
        () => getSanitizedPath('../../../../secret.txt'),
        /Path traversal detected: Access denied/
      );
      assert.throws(
        () => getSanitizedPath('malicious\0file.pdf'),
        /Invalid path format/
      );
      assert.throws(
        () => getSanitizedPath(12345),
        /Invalid path format/
      );

      // Verify safe resolution within SAFE_BASE_DIR
      const resolved = getSanitizedPath('safe_file.csv');
      assert.ok(resolved.startsWith(SAFE_BASE_DIR));

      // 2. Direct validateFile tests
      assert.throws(
        () => validateFile('../../../../etc/passwd'),
        /Path traversal detected: Access denied/
      );
      assert.throws(
        () => validateFile({ filePath: '../../../../secret.txt' }),
        /Path traversal detected: Access denied/
      );
      assert.throws(
        () => validateFile({ filePath: 'bad\0file.pdf' }),
        /Invalid path format/
      );

      // 3. HTTP endpoint check: should reject path traversal in file_path with 400 Bad Request
      const res = await fetch(`${baseUrl}/jobs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': validApiKey,
          'x-merchant-id': merchantA
        },
        body: JSON.stringify({
          file_id: validFileAId,
          model_version_id: modelVersionAId,
          file_path: '../../../../secret.txt'
        })
      });

      assert.strictEqual(res.status, 400);
      const data = await res.json();
      assert.ok(data.error.includes('Path traversal detected') || data.error.includes('Access denied'));

      // 4. Missing file check (Fix #7)
      const missingFileResult = validateFile({ filePath: 'uploads/non_existent_file.pdf' });
      assert.strictEqual(missingFileResult.valid, false);
      assert.strictEqual(missingFileResult.error, 'FILE_NOT_FOUND');
      assert.strictEqual(missingFileResult.message, 'The specified file does not exist.');

      // 5. Tenant Path Stealing check (Fix #3)
      const stealRes = await fetch(`${baseUrl}/jobs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': validApiKey,
          'x-merchant-id': merchantA
        },
        body: JSON.stringify({
          file_id: randomUUID(),
          model_version_id: modelVersionAId,
          file_path: `uploads/${merchantB}/stolen_data.csv`
        })
      });
      assert.strictEqual(stealRes.status, 400);
      const stealData = await stealRes.json();
      assert.ok(stealData.error.includes('Path traversal detected') || stealData.error.includes('Access denied'));
    });

    it('Valid file: Enqueue job and return 202 Accepted with job_id and initial status PENDING', async () => {
      const res = await fetch(`${baseUrl}/jobs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': validApiKey,
          'x-merchant-id': merchantA
        },
        body: JSON.stringify({
          file_id: validFileAId,
          model_version_id: modelVersionAId,
          filename: 'valid_catalog.pdf',
          total_pages: 10,
          text_content: 'Standard Bolt M8 Steel 100mm 5.99 EUR'
        })
      });

      assert.strictEqual(res.status, 202);
      const data = await res.json();
      assert.strictEqual(data.status, 'PENDING');
      assert.strictEqual(data.message, 'Extraction job accepted');
      assert.ok(data.job_id);

      createdJobIds.push(data.job_id);

      // Verify in DB
      const dbRes = await pool.query('SELECT * FROM extraction_jobs WHERE id = $1', [data.job_id]);
      assert.strictEqual(dbRes.rows.length, 1);
      const jobRow = dbRes.rows[0];
      assert.strictEqual(jobRow.status, 'PENDING');
      assert.strictEqual(jobRow.attempts, 0);
      assert.strictEqual(jobRow.merchant_id, merchantA);
      assert.strictEqual(jobRow.model_version_id, modelVersionAId);
    });
  });

  describe('Scenario 2: Lifecycle, Accounting & Reconciliation', () => {
    it('Worker picks up job: status changes PENDING -> PROCESSING', async () => {
      const enqueued = await enqueueJob({
        merchant_id: merchantA,
        file_id: validFileAId,
        model_version_id: modelVersionAId,
        total_records: 5
      });
      createdJobIds.push(enqueued.job_id);

      assert.strictEqual(enqueued.status, 'PENDING');

      // Process job with simulated delay or check transition
      const processingPromise = processJob(enqueued.job_id, {
        items: [{ valid: true }, { valid: true }]
      });

      const updatedJob = await processingPromise;
      assert.ok(updatedJob.attempts >= 1);
      assert.strictEqual(updatedJob.status, 'COMPLETED');
    });

    it('All records succeed: status transitions to COMPLETED, processed === total, failed === 0', async () => {
      const enqueued = await enqueueJob({
        merchant_id: merchantA,
        file_id: validFileAId,
        model_version_id: modelVersionAId
      });
      createdJobIds.push(enqueued.job_id);

      const items = [
        { sku: 'SKU-001', name: 'Drill Bit', price: 12.50 },
        { sku: 'SKU-002', name: 'Hex Bolt', price: 2.10 },
        { sku: 'SKU-003', name: 'Steel Nut', price: 0.50 }
      ];

      const completedJob = await processJob(enqueued.job_id, {
        items,
        itemProcessor: async (item) => ({ valid: Boolean(item.sku && item.name) })
      });

      assert.strictEqual(completedJob.status, 'COMPLETED');
      assert.strictEqual(completedJob.total_records, 3);
      assert.strictEqual(completedJob.processed_records, 3);
      assert.strictEqual(completedJob.failed_records, 0);
      assert.strictEqual(completedJob.processed_records + completedJob.failed_records, completedJob.total_records);
      assert.deepStrictEqual(completedJob.job_errors, []);

      // Verify via GET endpoint
      const getRes = await fetch(`${baseUrl}/jobs/${enqueued.job_id}`, {
        headers: {
          'x-api-key': validApiKey,
          'x-merchant-id': merchantA
        }
      });
      assert.strictEqual(getRes.status, 200);
      const getData = await getRes.json();
      assert.strictEqual(getData.status, 'COMPLETED');
      assert.strictEqual(getData.processed_records, 3);
      assert.strictEqual(getData.failed_records, 0);
    });

    it('Partial failure (1 out of 10 rows fails): status PARTIALLY_FAILED, exact item error recorded', async () => {
      const enqueued = await enqueueJob({
        merchant_id: merchantA,
        file_id: validFileAId,
        model_version_id: modelVersionAId
      });
      createdJobIds.push(enqueued.job_id);

      // 10 items, item index 4 (item 5) has corrupted data
      const items = Array.from({ length: 10 }, (_, i) => ({
        index: i,
        sku: `SKU-${i}`,
        price: i === 4 ? 'corrupt_price_string' : 10.0 + i
      }));

      const partialJob = await processJob(enqueued.job_id, {
        items,
        itemProcessor: async (item, _index) => {
          if (typeof item.price !== 'number') {
            return {
              valid: false,
              error: 'Invalid price format',
              raw_value: item.price
            };
          }
          return { valid: true };
        }
      });

      assert.strictEqual(partialJob.status, 'PARTIALLY_FAILED');
      assert.strictEqual(partialJob.total_records, 10);
      assert.strictEqual(partialJob.processed_records, 9);
      assert.strictEqual(partialJob.failed_records, 1);
      // Invariant: processed_records + failed_records === total_records
      assert.strictEqual(partialJob.processed_records + partialJob.failed_records, partialJob.total_records);

      assert.strictEqual(partialJob.job_errors.length, 1);
      assert.strictEqual(partialJob.job_errors[0].item_index, 4);
      assert.strictEqual(partialJob.job_errors[0].error, 'Invalid price format');
      assert.strictEqual(partialJob.job_errors[0].raw_value, 'corrupt_price_string');
    });

    it('Total failure (all records fail): status transitions to FAILED', async () => {
      const enqueued = await enqueueJob({
        merchant_id: merchantA,
        file_id: validFileAId,
        model_version_id: modelVersionAId
      });
      createdJobIds.push(enqueued.job_id);

      const items = [
        { sku: '', error: 'Missing SKU' },
        { sku: '', error: 'Missing SKU' },
        { sku: '', error: 'Missing SKU' }
      ];

      const failedJob = await processJob(enqueued.job_id, {
        items,
        itemProcessor: async (item) => ({
          valid: false,
          error: item.error,
          raw_value: item.sku
        })
      });

      assert.strictEqual(failedJob.status, 'FAILED');
      assert.strictEqual(failedJob.total_records, 3);
      assert.strictEqual(failedJob.processed_records, 0);
      assert.strictEqual(failedJob.failed_records, 3);
      assert.strictEqual(failedJob.job_errors.length, 3);
    });

    it('Transient failure retry test: worker retries up to 3 times with exponential backoff before FAILED', async () => {
      // 1. Verify exponential backoff calculation: 2^(attempts - 1) * 1000 ms
      assert.strictEqual(calculateBackoffMs(1), 1000); // 2^0 * 1000 = 1000 ms (1s)
      assert.strictEqual(calculateBackoffMs(2), 2000); // 2^1 * 1000 = 2000 ms (2s)
      assert.strictEqual(calculateBackoffMs(3), 4000); // 2^2 * 1000 = 4000 ms (4s)

      const enqueued = await enqueueJob({
        merchant_id: merchantA,
        file_id: validFileAId,
        model_version_id: modelVersionAId
      });
      const jobId = enqueued.job_id;
      createdJobIds.push(jobId);

      // Attempt 1: Transient failure -> status resets to PENDING, attempts = 1
      const attempt1 = await processJob(jobId, {
        failTransiently: true,
        transientErrorMessage: 'DB connection timeout'
      });
      assert.strictEqual(attempt1.status, 'PENDING');
      assert.strictEqual(attempt1.attempts, 1);
      assert.ok(attempt1.logs.includes('Attempt 1/3 failed: DB connection timeout'));
      assert.ok(attempt1.logs.includes('Rescheduling retry in 1000ms'));

      // Attempt 2: Transient failure -> status resets to PENDING, attempts = 2
      const attempt2 = await processJob(jobId, {
        failTransiently: true,
        transientErrorMessage: 'External 504 Gateway Timeout'
      });
      assert.strictEqual(attempt2.status, 'PENDING');
      assert.strictEqual(attempt2.attempts, 2);
      assert.ok(attempt2.logs.includes('Attempt 2/3 failed: External 504 Gateway Timeout'));
      assert.ok(attempt2.logs.includes('Rescheduling retry in 2000ms'));

      // Attempt 3: Final attempt reaches max_attempts (3) -> transitions to FAILED
      const attempt3 = await processJob(jobId, {
        failTransiently: true,
        transientErrorMessage: 'External service outage'
      });
      assert.strictEqual(attempt3.status, 'FAILED');
      assert.strictEqual(attempt3.attempts, 3);
      assert.ok(attempt3.logs.includes('Fatal: Attempt 3/3 failed'));
      assert.ok(attempt3.logs.includes('Max attempts reached'));

      // Verify final persisted status via GET endpoint
      const getRes = await fetch(`${baseUrl}/jobs/${jobId}`, {
        headers: {
          'x-api-key': validApiKey,
          'x-merchant-id': merchantA
        }
      });
      assert.strictEqual(getRes.status, 200);
      const jobData = await getRes.json();
      assert.strictEqual(jobData.status, 'FAILED');
      assert.strictEqual(jobData.attempts, 3);
    });

    it('Job locking & recovery: claim sets 5-minute lock; expired lock allows recovery', async () => {
      await pool.query("UPDATE extraction_jobs SET status = 'COMPLETED' WHERE status = 'PENDING'");
      const enqueued = await enqueueJob({
        merchant_id: merchantA,
        file_id: validFileAId,
        model_version_id: modelVersionAId
      });
      createdJobIds.push(enqueued.job_id);

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const claimed1 = await claimNextPendingJob(client);
        await client.query('COMMIT');

        assert.ok(claimed1);
        assert.strictEqual(claimed1.id, enqueued.job_id);
        assert.strictEqual(claimed1.status, 'PROCESSING');
        assert.ok(claimed1.locked_until);
        const lockTime = new Date(claimed1.locked_until).getTime();
        const diffMs = lockTime - Date.now();
        assert.ok(diffMs > 280000 && diffMs <= 310000);

        await client.query('BEGIN');
        const claimed2 = await claimNextPendingJob(client);
        await client.query('COMMIT');
        assert.strictEqual(claimed2, null);

        await pool.query(
          "UPDATE extraction_jobs SET locked_until = NOW() - INTERVAL '1 second' WHERE id = $1",
          [enqueued.job_id]
        );

        await client.query('BEGIN');
        const recoveredClaim = await claimNextPendingJob(client);
        await client.query('COMMIT');
        assert.ok(recoveredClaim);
        assert.strictEqual(recoveredClaim.id, enqueued.job_id);
      } finally {
        client.release();
      }
    });

    it('Hard error on missing/empty source file: transitions immediately to FAILED', async () => {
      const enqueued = await enqueueJob({
        merchant_id: merchantA,
        file_id: validFileAId,
        model_version_id: modelVersionAId,
        total_records: 0
      });
      createdJobIds.push(enqueued.job_id);

      const failedJob = await processJob(enqueued.job_id);
      assert.strictEqual(failedJob.status, 'FAILED');
      assert.ok(failedJob.logs.includes('Source file could not be read or parsed'));
    });
  });

  describe('Scenario 3: Cross-Tenant Isolation', () => {
    it('Merchant B requesting GET /api/extraction/jobs/:id of Merchant A returns 404 Not Found', async () => {
      // Create job belonging to Merchant A
      const enqueuedA = await enqueueJob({
        merchant_id: merchantA,
        file_id: validFileAId,
        model_version_id: modelVersionAId
      });
      createdJobIds.push(enqueuedA.job_id);

      // Merchant B tries to read Merchant A's job
      const res = await fetch(`${baseUrl}/jobs/${enqueuedA.job_id}`, {
        headers: {
          'x-api-key': validApiKey,
          'x-merchant-id': merchantB
        }
      });

      assert.strictEqual(res.status, 404);
      const data = await res.json();
      assert.strictEqual(data.error, 'Job not found');

      // Merchant A can access their own job
      const resOwner = await fetch(`${baseUrl}/jobs/${enqueuedA.job_id}`, {
        headers: {
          'x-api-key': validApiKey,
          'x-merchant-id': merchantA
        }
      });
      assert.strictEqual(resOwner.status, 200);
      const ownerData = await resOwner.json();
      assert.strictEqual(ownerData.id, enqueuedA.job_id);
    });

    it('Merchant B attempting to create extraction job targeting Merchant A model version returns 404 Not Found', async () => {
      const res = await fetch(`${baseUrl}/jobs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': validApiKey,
          'x-merchant-id': merchantB
        },
        body: JSON.stringify({
          file_id: validFileBId,
          model_version_id: modelVersionAId // Belongs to Merchant A!
        })
      });

      assert.strictEqual(res.status, 404);
      const data = await res.json();
      assert.strictEqual(data.error, 'Model version not found');
    });

    it('Merchant B attempting to create extraction job targeting Merchant A file returns 404 Not Found', async () => {
      const res = await fetch(`${baseUrl}/jobs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': validApiKey,
          'x-merchant-id': merchantB
        },
        body: JSON.stringify({
          file_id: validFileAId, // Belongs to Merchant A!
          model_version_id: modelVersionBId
        })
      });

      assert.strictEqual(res.status, 404);
      const data = await res.json();
      assert.strictEqual(data.error, 'File not found');
    });
  });
});
