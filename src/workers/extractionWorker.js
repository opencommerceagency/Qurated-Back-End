import fs from 'fs';
import { parse } from 'csv-parse/sync';
import { pool } from '../db/index.js';
import { claimNextPendingJob } from '../services/queueService.js';
import { getSanitizedPath } from '../services/fileValidator.js';

let workerIntervalId = null;

/**
 * Calculates exponential backoff delay in milliseconds:
 * 2^(attempts - 1) * 1000 ms (1s, 2s, 4s...)
 *
 * @param {number} attempts - Current attempt count
 * @returns {number} Backoff delay in milliseconds
 */
export function calculateBackoffMs(attempts) {
  const exponent = Math.max(0, attempts - 1);
  return Math.pow(2, exponent) * 1000;
}

/**
 * Processes a specific extraction job through chunking, accounting, reconciliation,
 * and exponential backoff retry handling.
 *
 * @param {string} jobId - UUID of the extraction job
 * @param {Object} [options={}] - Processing options and test hooks
 * @param {Array} [options.items] - Injected items for direct row processing
 * @param {Function} [options.itemProcessor] - Custom per-item validator/processor
 * @param {boolean|Function} [options.failTransiently] - Injects a transient failure for retry testing
 * @param {number} [options.chunkSize=500] - Batch chunk processing size
 * @param {Object} [client=pool] - Database pool or client
 * @returns {Promise<Object>} Updated job state
 */
export async function processJob(jobId, options = {}, client = pool) {
  // 1. Ensure the job status is set to PROCESSING and attempts incremented if not already done by claimNextPendingJob
  const preCheck = await client.query(
    'SELECT * FROM extraction_jobs WHERE id = $1',
    [jobId]
  );

  if (preCheck.rows.length === 0) {
    throw new Error(`Extraction job not found: ${jobId}`);
  }

  let job = preCheck.rows[0];

  if (job.status !== 'PROCESSING') {
    const updateRes = await client.query(
      `UPDATE extraction_jobs
       SET status = 'PROCESSING',
           attempts = attempts + 1,
           locked_until = NOW() + INTERVAL '5 minutes',
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [jobId]
    );
    job = updateRes.rows[0];
  }

  const currentAttempts = job.attempts;
  const maxAttempts = job.max_attempts || 3;

  try {
    // Check for simulated transient failure (for automated retry tests)
    const shouldFailTransiently =
      typeof options.failTransiently === 'function'
        ? await options.failTransiently(job)
        : Boolean(options.failTransiently);

    if (shouldFailTransiently) {
      throw new Error(options.transientErrorMessage || 'Transient network or database failure');
    }

    // 2. Resolve items to process: from options.items, or by parsing the associated file
    let items = options.items;


    if (!items) {
      // Look up file record in files table
      const fileRes = await client.query('SELECT * FROM files WHERE id = $1', [job.file_id]);
      if (fileRes.rows.length > 0) {
        const fileRecord = fileRes.rows[0];
        if (fileRecord.file_path) {
          const safePath = getSanitizedPath(fileRecord.file_path);
          if (fs.existsSync(safePath)) {
            const content = fs.readFileSync(safePath, 'utf-8');
            try {
              items = parse(content, {
                columns: true,
                skip_empty_lines: true,
                trim: true
              });
            } catch {
              items = [];
            }
          }
        }
      }
    }

    if (!items || items.length === 0) {
      throw new Error('Source file could not be read or parsed');
    }

    const totalRecords = items.length;
    let processedRecords = 0;
    let failedRecords = 0;
    const jobErrors = [];

    // 3. Process items in chunks (default 500 items per chunk)
    const chunkSize = options.chunkSize || 500;
    for (let chunkStart = 0; chunkStart < items.length; chunkStart += chunkSize) {
      const chunk = items.slice(chunkStart, chunkStart + chunkSize);

      for (let i = 0; i < chunk.length; i++) {
        const itemIndex = chunkStart + i;
        const item = chunk[i];

        try {
          let itemValid = true;
          let errorMessage = null;
          let rawValue = null;

          if (options.itemProcessor) {
            const processResult = await options.itemProcessor(item, itemIndex);
            if (processResult && processResult.valid === false) {
              itemValid = false;
              errorMessage = processResult.error || 'Validation failed';
              rawValue = processResult.raw_value !== undefined
                ? processResult.raw_value
                : (typeof item === 'object' ? JSON.stringify(item) : String(item));
            }
          } else if (item && (item.valid === false || item.is_valid === false)) {
            itemValid = false;
            errorMessage = item.error || 'Validation failed';
            rawValue = item.raw_value !== undefined
              ? item.raw_value
              : (typeof item === 'object' ? JSON.stringify(item) : String(item));
          }

          if (itemValid) {
            processedRecords++;
          } else {
            failedRecords++;
            jobErrors.push({
              item_index: itemIndex,
              error: errorMessage,
              raw_value: rawValue
            });
          }
        } catch (itemErr) {
          failedRecords++;
          jobErrors.push({
            item_index: itemIndex,
            error: itemErr.message || 'Validation error',
            raw_value: typeof item === 'object' ? JSON.stringify(item) : String(item)
          });
        }
      }
    }

    // Invariant check: processed_records + failed_records === total_records
    if (processedRecords + failedRecords !== totalRecords) {
      throw new Error(
        `Accounting reconciliation invariant failed: processed (${processedRecords}) + failed (${failedRecords}) !== total (${totalRecords})`
      );
    }

    // Final status transition
    let finalStatus = 'COMPLETED';
    if (totalRecords === 0) {
      finalStatus = 'COMPLETED';
    } else if (failedRecords === 0 && processedRecords > 0) {
      finalStatus = 'COMPLETED';
    } else if (failedRecords > 0 && processedRecords > 0) {
      finalStatus = 'PARTIALLY_FAILED';
    } else if (processedRecords === 0 && failedRecords > 0) {
      finalStatus = 'FAILED';
    }

    const updateRes = await client.query(
      `UPDATE extraction_jobs
       SET status = $1,
           total_records = $2,
           processed_records = $3,
           failed_records = $4,
           job_errors = $5,
           locked_until = NULL,
           updated_at = NOW()
       WHERE id = $6
       RETURNING *`,
      [
        finalStatus,
        totalRecords,
        processedRecords,
        failedRecords,
        JSON.stringify(jobErrors),
        jobId
      ]
    );

    return updateRes.rows[0];
  } catch (error) {
    // 4. Retry handling with exponential backoff on transient failure
    if (error.message !== 'Source file could not be read or parsed' && currentAttempts < maxAttempts) {
      const delayMs = calculateBackoffMs(currentAttempts);
      const nextRetryAt = new Date(Date.now() + delayMs);
      const retryLog = `[${new Date().toISOString()}] Attempt ${currentAttempts}/${maxAttempts} failed: ${error.message}. Rescheduling retry in ${delayMs}ms\n`;

      const retryRes = await client.query(
        `UPDATE extraction_jobs
         SET status = 'PENDING',
             next_retry_at = $1,
             logs = COALESCE(logs, '') || $2,
             locked_until = NULL,
             updated_at = NOW()
         WHERE id = $3
         RETURNING *`,
        [nextRetryAt, retryLog, jobId]
      );

      return retryRes.rows[0];
    } else {
      // Exceeded max attempts: transition to FAILED
      const fatalLog = `[${new Date().toISOString()}] Fatal: Attempt ${currentAttempts}/${maxAttempts} failed: ${error.message}. Max attempts reached.\n`;

      const failRes = await client.query(
        `UPDATE extraction_jobs
         SET status = 'FAILED',
             logs = COALESCE(logs, '') || $1,
             locked_until = NULL,
             updated_at = NOW()
         WHERE id = $2
         RETURNING *`,
        [fatalLog, jobId]
      );

      return failRes.rows[0];
    }
  }
}

/**
 * Claims and executes the next pending job from the database queue.
 *
 * @param {Object} [options={}] - Processing options and test hooks
 * @returns {Promise<Object|null>} The processed job result or null if queue is empty
 */
export async function processNextJob(options = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const claimedJob = await claimNextPendingJob(client);
    await client.query('COMMIT');

    if (!claimedJob) {
      return null;
    }

    return await processJob(claimedJob.id, options);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Starts the continuous background polling worker for extraction jobs.
 *
 * @param {Object} [config={}] - Worker configuration
 * @param {number} [config.pollIntervalMs=1000] - Polling frequency
 * @returns {void}
 */
export function startExtractionWorker({ pollIntervalMs = 1000 } = {}) {
  if (workerIntervalId) return;

  workerIntervalId = setInterval(async () => {
    try {
      await processNextJob();
    } catch (err) {
      console.error('Extraction worker loop error:', err);
    }
  }, pollIntervalMs);
}

/**
 * Stops the continuous background polling worker.
 */
export function stopExtractionWorker() {
  if (workerIntervalId) {
    clearInterval(workerIntervalId);
    workerIntervalId = null;
  }
}

export default {
  calculateBackoffMs,
  processJob,
  processNextJob,
  startExtractionWorker,
  stopExtractionWorker
};
