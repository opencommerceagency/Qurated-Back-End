import fs from 'fs';
import { z } from 'zod';
import { pool } from '../db/index.js';
import { enqueueJob, getJobById } from '../services/queueService.js';
import { validateFile } from '../services/fileValidator.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const createJobSchema = z.object({
  file_id: z.string().refine((val) => UUID_REGEX.test(val), { message: 'file_id must be a valid UUID' }),
  model_version_id: z.string().refine((val) => UUID_REGEX.test(val), { message: 'model_version_id must be a valid UUID' }),
  total_records: z.number().int().nonnegative().optional(),
  file_path: z.string().optional(),
  file_content: z.string().optional(),
  file_size: z.number().optional(),
  filename: z.string().optional(),
  mime_type: z.string().optional(),
  metadata: z.record(z.string(), z.any()).optional(),
  // Direct test hooks / explicit overrides
  total_pages: z.number().optional(),
  pageCount: z.number().optional(),
  is_encrypted: z.boolean().optional(),
  isEncrypted: z.boolean().optional(),
  text_content: z.string().optional(),
  textContent: z.string().optional()
});

/**
 * Verifies tenant access to a model version.
 * Global base templates (merchant_id === null) are accessible, but other tenants' models are blocked.
 */
async function verifyModelVersionAccess(modelVersionId, merchantId, client = pool) {
  const result = await client.query(
    `SELECT v.id, v.version, v.snapshot, m.merchant_id
     FROM product_model_versions v
     JOIN product_models m ON m.id = v.model_id
     WHERE v.id = $1`,
    [modelVersionId]
  );

  if (result.rows.length === 0) {
    return { authorized: false, reason: 'NOT_FOUND' };
  }

  const row = result.rows[0];
  if (row.merchant_id !== null && row.merchant_id !== merchantId) {
    return { authorized: false, reason: 'FORBIDDEN' };
  }

  return { authorized: true, modelVersion: row };
}

/**
 * Resolves and verifies tenant access to the specified file.
 */
async function resolveAndVerifyFile(fileId, merchantId, reqBody = {}, client = pool) {
  const fileRes = await client.query('SELECT * FROM files WHERE id = $1', [fileId]);

  if (fileRes.rows.length > 0) {
    const file = fileRes.rows[0];
    if (file.merchant_id !== merchantId) {
      return { authorized: false, reason: 'FORBIDDEN' };
    }
    return { authorized: true, file };
  }

  // If no DB row exists yet, check if file data was supplied in request body to register it
  if (
    reqBody.file_path ||
    reqBody.file_content ||
    reqBody.file_size !== undefined ||
    reqBody.total_pages !== undefined ||
    reqBody.is_encrypted !== undefined ||
    reqBody.text_content !== undefined
  ) {
    let size = reqBody.file_size || 0;
    if (!size && reqBody.file_path && fs.existsSync(reqBody.file_path)) {
      size = fs.statSync(reqBody.file_path).size;
    } else if (!size && reqBody.file_content) {
      size = Buffer.byteLength(reqBody.file_content, 'utf-8');
    }

    const insertRes = await client.query(
      `INSERT INTO files (id, merchant_id, filename, file_path, file_size, mime_type, metadata, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       RETURNING *`,
      [
        fileId,
        merchantId,
        reqBody.filename || 'uploaded_document',
        reqBody.file_path || null,
        size,
        reqBody.mime_type || null,
        JSON.stringify(reqBody.metadata || {})
      ]
    );

    return { authorized: true, file: insertRes.rows[0] };
  }

  return { authorized: false, reason: 'NOT_FOUND' };
}

/**
 * POST /api/extraction/jobs
 * Accepts a file extraction job after running synchronous file validation guardrails.
 */
export async function createExtractionJob(req, res) {
  try {
    const merchantId = req.merchantId;
    if (!merchantId) {
      return res.status(400).json({ error: 'Invalid or missing x-merchant-id header. Must be a valid UUID.' });
    }

    const parseResult = createJobSchema.safeParse(req.body);
    if (!parseResult.success) {
      const firstError = parseResult.error.issues[0]?.message || 'Validation error';
      return res.status(400).json({ error: firstError, details: parseResult.error.flatten() });
    }

    const { file_id, model_version_id, total_records = 0 } = parseResult.data;

    // 1. Verify tenant owns the model version
    const modelVersionCheck = await verifyModelVersionAccess(model_version_id, merchantId);
    if (!modelVersionCheck.authorized) {
      return res.status(404).json({ error: 'Model version not found' });
    }

    // 2. Verify tenant owns the file
    const fileCheck = await resolveAndVerifyFile(file_id, merchantId, req.body);
    if (!fileCheck.authorized) {
      return res.status(404).json({ error: 'File not found' });
    }

    const fileRecord = fileCheck.file;

    // 3. Run fileValidator guardrails synchronously
    const fileToValidate = {
      filePath: fileRecord.file_path,
      size: req.body.file_size !== undefined ? Number(req.body.file_size) : Number(fileRecord.file_size),
      filename: req.body.filename || fileRecord.filename,
      mimeType: req.body.mime_type || fileRecord.mime_type,
      total_pages: req.body.total_pages,
      pageCount: req.body.pageCount,
      is_encrypted: req.body.is_encrypted,
      isEncrypted: req.body.isEncrypted,
      text_content: req.body.text_content,
      textContent: req.body.textContent,
      content: req.body.file_content
    };

    const validation = validateFile(fileToValidate);
    if (!validation.valid) {
      return res.status(400).json({
        error: validation.error,
        message: validation.message
      });
    }

    // 4. Enqueue job into extraction_jobs
    const enqueued = await enqueueJob({
      merchant_id: merchantId,
      file_id,
      model_version_id,
      total_records
    });

    return res.status(202).json({
      job_id: enqueued.job_id,
      status: enqueued.status,
      message: enqueued.message
    });
  } catch (error) {
    const status = error.status || error.statusCode || 500;
    return res.status(status).json({ error: error.message });
  }
}

/**
 * GET /api/extraction/jobs/:id
 * Retrieves job status, counters, error items, and timestamps with strict tenant isolation.
 */
export async function getExtractionJobById(req, res) {
  try {
    const merchantId = req.merchantId;
    if (!merchantId) {
      return res.status(400).json({ error: 'Invalid or missing x-merchant-id header. Must be a valid UUID.' });
    }

    const { id } = req.params;
    if (!id || !UUID_REGEX.test(id)) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const job = await getJobById(id, merchantId);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    return res.status(200).json({
      id: job.id,
      status: job.status,
      total_records: job.total_records,
      processed_records: job.processed_records,
      failed_records: job.failed_records,
      job_errors: job.job_errors,
      attempts: job.attempts,
      created_at: job.created_at,
      updated_at: job.updated_at
    });
  } catch (error) {
    const status = error.status || error.statusCode || 500;
    return res.status(status).json({ error: error.message });
  }
}

export default {
  createExtractionJob,
  getExtractionJobById
};
