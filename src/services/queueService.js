import { pool } from '../db/index.js';

/**
 * Enqueues a new extraction job into the database queue.
 *
 * @param {Object} params - Enqueue parameters
 * @param {string} params.merchant_id - UUID of the merchant tenant
 * @param {string} params.file_id - UUID of the target file
 * @param {string} params.model_version_id - UUID of the product model version
 * @param {number} [params.total_records=0] - Expected total records if known upfront
 * @param {Object} [client=pool] - Optional database client or transaction pool
 * @returns {Promise<Object>} The enqueued job record and confirmation response
 */
export async function enqueueJob(
  { merchant_id, file_id, model_version_id, total_records = 0 },
  client = pool
) {
  const result = await client.query(
    `INSERT INTO extraction_jobs (
       merchant_id,
       file_id,
       model_version_id,
       status,
       total_records,
       processed_records,
       failed_records,
       job_errors,
       attempts,
       max_attempts,
       logs,
       next_retry_at,
       created_at,
       updated_at
     )
     VALUES ($1, $2, $3, 'PENDING', $4, 0, 0, '[]'::jsonb, 0, 3, NULL, NOW(), NOW(), NOW())
     RETURNING *`,
    [merchant_id, file_id, model_version_id, total_records]
  );

  const job = result.rows[0];

  return {
    job_id: job.id,
    status: job.status,
    message: 'Extraction job accepted',
    job
  };
}

/**
 * Retrieves a job by ID, enforcing strict tenant isolation.
 *
 * @param {string} jobId - UUID of the extraction job
 * @param {string} [merchantId] - UUID of the requesting merchant
 * @param {Object} [client=pool] - Database client or pool
 * @returns {Promise<Object|null>} The job record if found and authorized, or null
 */
export async function getJobById(jobId, merchantId, client = pool) {
  if (!jobId) return null;

  const result = await client.query(
    `SELECT id,
            merchant_id,
            file_id,
            model_version_id,
            status,
            total_records,
            processed_records,
            failed_records,
            job_errors,
            attempts,
            max_attempts,
            logs,
            created_at,
            updated_at
     FROM extraction_jobs
     WHERE id = $1`,
    [jobId]
  );

  if (result.rows.length === 0) {
    return null;
  }

  const job = result.rows[0];

  // Enforce cross-tenant isolation
  if (merchantId && job.merchant_id !== merchantId) {
    return null;
  }

  return job;
}

/**
 * Atomically claims the next due PENDING job using FOR UPDATE SKIP LOCKED.
 *
 * @param {Object} client - Active database connection client (required for row lock)
 * @returns {Promise<Object|null>} The claimed job row or null if queue is empty
 */
export async function claimNextPendingJob(client) {
  const result = await client.query(
    `SELECT *
     FROM extraction_jobs
     WHERE (
       (status = 'PENDING' AND (next_retry_at IS NULL OR next_retry_at <= NOW()))
       OR (status = 'PROCESSING' AND locked_until < NOW())
     )
     ORDER BY created_at ASC
     LIMIT 1
     FOR UPDATE SKIP LOCKED`
  );

  if (result.rows.length === 0) {
    return null;
  }

  const job = result.rows[0];

  // Increment attempts and update status to PROCESSING atomically with a 5-minute lock
  const updatedResult = await client.query(
    `UPDATE extraction_jobs
     SET status = 'PROCESSING',
         attempts = attempts + 1,
         locked_until = NOW() + INTERVAL '5 minutes',
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [job.id]
  );

  return updatedResult.rows[0];
}

export default {
  enqueueJob,
  getJobById,
  claimNextPendingJob
};
