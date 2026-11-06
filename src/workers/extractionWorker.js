import fs from 'fs';
import { parse } from 'csv-parse/sync';
import { pool } from '../db/index.js';
import { claimNextPendingJob } from '../services/queueService.js';
import { compileModelZodSchema } from '../services/schemaCompiler.js';
import { extractWithFallback } from '../services/aiClient.js';
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
 * Ingests an extracted product and its attributes idempotently into PostgreSQL:
 * - UPSERT into extracted_products on (merchant_id, model_version_id, supplier_sku)
 * - UPSERT into extracted_attributes on (product_id, attribute_key)
 *
 * @param {Object} params - Ingestion parameters
 * @param {string} params.merchant_id - Tenant merchant UUID
 * @param {string} params.job_id - Extraction job UUID
 * @param {string} params.model_version_id - Product model version UUID
 * @param {Object} params.productData - Validated product object with supplier_sku and attributes
 * @param {string} [params.source_file_id] - Optional source file UUID
 * @param {number} [params.source_row_index] - Row or item index
 * @param {string} [params.source_column] - Source column name if known
 * @param {number} [params.confidence_score=100] - Confidence score (0-100)
 * @param {string} [params.raw_source_value] - Raw unnormalized source value
 * @param {Object} [client=pool] - Active database client or pool
 * @returns {Promise<Object>} Inserted/updated product record and metadata
 */
export async function ingestExtractedProduct(
  {
    merchant_id,
    job_id,
    model_version_id,
    productData,
    source_file_id = null,
    source_row_index = null,
    source_column = null,
    confidence_score = 100,
    raw_source_value = null
  },
  client = pool
) {
  const supplierSku = productData.supplier_sku || productData.sku;
  if (!supplierSku) {
    throw new Error('supplier_sku is required for product ingestion');
  }

  // 1. UPSERT extracted_products
  const productRes = await client.query(
    `INSERT INTO extracted_products (
       merchant_id, job_id, model_version_id, supplier_sku, state, updated_at
     )
     VALUES ($1, $2, $3, $4, 'PROCESSING', NOW())
     ON CONFLICT (merchant_id, model_version_id, supplier_sku)
     DO UPDATE SET
       job_id = EXCLUDED.job_id,
       state = 'PROCESSING',
       updated_at = NOW()
     RETURNING id, merchant_id, job_id, model_version_id, supplier_sku, state, created_at, updated_at`,
    [merchant_id, job_id, model_version_id, String(supplierSku).trim()]
  );

  const product = productRes.rows[0];
  const productId = product.id;

  // 2. UPSERT extracted_attributes
  const attributeKeys = Object.keys(productData).filter(
    (k) => k !== 'supplier_sku' && k !== 'sku' && productData[k] !== undefined
  );

  for (const attrKey of attributeKeys) {
    const attrVal = productData[attrKey];
    const jsonVal = JSON.stringify(attrVal);
    const rawVal =
      raw_source_value !== null
        ? raw_source_value
        : typeof attrVal === 'object'
          ? JSON.stringify(attrVal)
          : String(attrVal ?? '');

    await client.query(
      `INSERT INTO extracted_attributes (
         product_id, attribute_key, value, confidence_score,
         source_file_id, source_row_index, source_column, raw_source_value, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
       ON CONFLICT (product_id, attribute_key)
       DO UPDATE SET
         value = EXCLUDED.value,
         confidence_score = EXCLUDED.confidence_score,
         raw_source_value = EXCLUDED.raw_source_value,
         updated_at = NOW()`,
      [
        productId,
        attrKey,
        jsonVal,
        confidence_score,
        source_file_id,
        source_row_index,
        source_column,
        rawVal
      ]
    );
  }

  return {
    productId,
    product,
    attributeCount: attributeKeys.length
  };
}

/**
 * Processes a specific extraction job through chunking, accounting, reconciliation,
 * dynamic schema compilation, AI extraction, and idempotent PostgreSQL upserts.
 *
 * @param {string} jobId - UUID of the extraction job
 * @param {Object} [options={}] - Processing options and test hooks
 * @param {Array} [options.items] - Injected items for direct row processing
 * @param {Function} [options.itemProcessor] - Custom per-item validator/processor
 * @param {boolean|Function} [options.failTransiently] - Injects a transient failure for retry testing
 * @param {boolean} [options.useAi=false] - Whether to use OpenRouter AI extraction
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
    if (updateRes.rows.length > 0) {
      job = updateRes.rows[0];
    }
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

    // 2. Retrieve model version snapshot and compile Zod schema
    let schemaSnapshot = null;
    let compiledSchema = null;
    if (job.model_version_id) {
      const versionRes = await client.query(
        'SELECT snapshot FROM product_model_versions WHERE id = $1',
        [job.model_version_id]
      );
      if (versionRes.rows.length > 0) {
        schemaSnapshot = versionRes.rows[0].snapshot;
        compiledSchema = compileModelZodSchema(schemaSnapshot);
      }
    }

    // 3. Resolve items to process: from options.items, or by parsing the associated file
    let items = options.items;
    let fileType = 'csv';

    if (!items) {
      // Look up file record in files table
      const fileRes = await client.query('SELECT * FROM files WHERE id = $1', [job.file_id]);
      if (fileRes.rows.length > 0) {
        const fileRecord = fileRes.rows[0];
        if (fileRecord.filename?.toLowerCase().endsWith('.pdf') || fileRecord.mime_type === 'application/pdf') {
          fileType = 'pdf';
        }
        if (fileRecord.file_path) {
          const safePath = getSanitizedPath(fileRecord.file_path);
          if (fs.existsSync(safePath)) {
            if (fileType === 'pdf') {
              // PDF Document: do not parse with csv-parse! Treat as extraction document payload
              const content = fs.readFileSync(safePath, 'utf-8');
              items = [{ document: content, filename: fileRecord.filename, type: 'pdf' }];
            } else {
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
    }

    if (!items || items.length === 0) {
      throw new Error('Source file could not be read or parsed');
    }

    const totalRecords = items.length;
    let processedRecords = 0;
    let failedRecords = 0;
    const jobErrors = [];
    const aiMetadataList = [];

    // 4. Process items in chunks (default 500 items per chunk)
    const chunkSize = options.chunkSize || 500;
    for (let chunkStart = 0; chunkStart < items.length; chunkStart += chunkSize) {
      const chunk = items.slice(chunkStart, chunkStart + chunkSize);

      for (let i = 0; i < chunk.length; i++) {
        const itemIndex = chunkStart + i;
        const rawItem = chunk[i];

        try {
          let itemValid = true;
          let errorMessage = null;
          let rawValue = null;
          let processedData = rawItem;

          // Optional AI extraction step
          if (options.useAi && schemaSnapshot) {
            const aiResult = await extractWithFallback({
              rawData: rawItem,
              fileType,
              schemaSnapshot,
              options
            });
            processedData = aiResult.data;
            if (aiResult.metadata) {
              aiMetadataList.push({
                item_index: itemIndex,
                ...aiResult.metadata
              });
            }
          }

          // Item validation & processing
          if (options.itemProcessor) {
            const processResult = await options.itemProcessor(processedData, itemIndex);
            if (processResult && processResult.valid === false) {
              itemValid = false;
              errorMessage = processResult.error || 'Validation failed';
              rawValue =
                processResult.raw_value !== undefined
                  ? processResult.raw_value
                  : typeof rawItem === 'object'
                    ? JSON.stringify(rawItem)
                    : String(rawItem);
            } else if (processResult && typeof processResult === 'object' && processResult.data) {
              processedData = processResult.data;
            }
          } else if (processedData && (processedData.valid === false || processedData.is_valid === false)) {
            itemValid = false;
            errorMessage = processedData.error || 'Validation failed';
            rawValue =
              processedData.raw_value !== undefined
                ? processedData.raw_value
                : typeof rawItem === 'object'
                  ? JSON.stringify(rawItem)
                  : String(rawItem);
          } else if (processedData && (processedData.valid === true || processedData.is_valid === true)) {
            itemValid = true;
          } else if (compiledSchema) {
            // Strict schema validation on all items: missing supplier_sku fails validation
            if (!processedData || typeof processedData !== 'object') {
              itemValid = false;
              errorMessage = 'Invalid item payload';
              rawValue = String(processedData);
            } else {
              const hasSku = Boolean(
                processedData.supplier_sku ||
                processedData.sku ||
                processedData.artikel_nr ||
                processedData.item_number
              );
              if (!hasSku) {
                itemValid = false;
                errorMessage = 'supplier_sku is required';
                rawValue = JSON.stringify(processedData);
              } else {
                const parseResult = compiledSchema.safeParse(processedData);
                if (!parseResult.success) {
                  itemValid = false;
                  errorMessage = parseResult.error.issues[0]?.message || 'Schema validation failed';
                  rawValue = JSON.stringify(processedData);
                } else {
                  processedData = parseResult.data;
                }
              }
            }
          }

          if (itemValid) {
            // Idempotent UPSERT into extracted_products & extracted_attributes
            if (
              processedData &&
              typeof processedData === 'object' &&
              (processedData.supplier_sku || processedData.sku) &&
              job.merchant_id &&
              job.model_version_id
            ) {
              await ingestExtractedProduct(
                {
                  merchant_id: job.merchant_id,
                  job_id: jobId,
                  model_version_id: job.model_version_id,
                  productData: processedData,
                  source_file_id: job.file_id,
                  source_row_index: itemIndex,
                  client
                },
                client
              );
            }

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
            raw_value: typeof rawItem === 'object' ? JSON.stringify(rawItem) : String(rawItem)
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

    let aiLineageLog = '';
    if (aiMetadataList.length > 0) {
      const primaryCount = aiMetadataList.filter((m) => m.model_used === 'primary').length;
      const fallbackCount = aiMetadataList.filter((m) => m.model_used === 'fallback').length;
      const modelNames = [...new Set(aiMetadataList.map((m) => m.model_name))].join(', ');
      aiLineageLog = `[${new Date().toISOString()}] AI Lineage: extracted ${aiMetadataList.length} item(s) using [${modelNames}] (primary: ${primaryCount}, fallback: ${fallbackCount})\n`;
    }

    const updateRes = await client.query(
      `UPDATE extraction_jobs
       SET status = $1,
           total_records = $2,
           processed_records = $3,
           failed_records = $4,
           job_errors = $5,
           logs = COALESCE(logs, '') || $6,
           locked_until = NULL,
           updated_at = NOW()
       WHERE id = $7
       RETURNING *`,
      [
        finalStatus,
        totalRecords,
        processedRecords,
        failedRecords,
        JSON.stringify(jobErrors),
        aiLineageLog,
        jobId
      ]
    );

    return updateRes.rows[0];
  } catch (error) {
    // 5. Retry handling with exponential backoff on transient failure
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
    await client.query('ROLLBACK').catch(() => { });
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
 * @param {boolean} [config.useAi=true] - Defaults to using AI extraction in worker
 * @returns {void}
 */
export function startExtractionWorker({ pollIntervalMs = 1000, useAi = true } = {}) {
  if (workerIntervalId) return;

  workerIntervalId = setInterval(async () => {
    try {
      await processNextJob({ useAi });
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
  ingestExtractedProduct,
  processJob,
  processNextJob,
  startExtractionWorker,
  stopExtractionWorker
};
