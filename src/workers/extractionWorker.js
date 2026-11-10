import fs from 'fs';
import { parse } from 'csv-parse/sync';
import { pool } from '../db/index.js';
import { claimNextPendingJob } from '../services/queueService.js';
import { compileModelZodSchema } from '../services/schemaCompiler.js';
import { extractWithFallback } from '../services/aiClient.js';
import { getSanitizedPath } from '../services/fileValidator.js';
import { calculateConfidenceScore } from '../services/confidenceScorer.js';
import { computeAndSyncProductGaps } from '../services/gapComputer.js';

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
 * Normalizes bounding box data to strict keys { x, y, width, height }
 * and ensures values are in the range [0.0, 1.0].
 * If coordinates/dimensions are on a 0-1000 scale or pixel scale, divides by page size or 1000.
 *
 * @param {Object} bbox - Raw bounding box object
 * @param {Object} [pageSize] - Optional page dimensions { width: 1000, height: 1000 }
 * @returns {Object|null} Normalized { x, y, width, height } or null if invalid
 */
export function normalizeBoundingBox(bbox, pageSize = { width: 1000, height: 1000 }) {
  if (!bbox || typeof bbox !== 'object') return null;

  let x = bbox.x ?? bbox.xmin ?? bbox.left ?? 0;
  let y = bbox.y ?? bbox.ymin ?? bbox.top ?? 0;
  let width = bbox.width ?? bbox.w ?? (bbox.xmax !== undefined ? bbox.xmax - (bbox.xmin || 0) : null);
  let height = bbox.height ?? bbox.h ?? (bbox.ymax !== undefined ? bbox.ymax - (bbox.ymin || 0) : null);

  if (width === null || height === null) {
    return null;
  }

  x = Number(x);
  y = Number(y);
  width = Number(width);
  height = Number(height);

  if (isNaN(x) || isNaN(y) || isNaN(width) || isNaN(height)) {
    return null;
  }

  const pageWidth = pageSize?.width || 1000;
  const pageHeight = pageSize?.height || 1000;

  // Scale down if coordinates appear to be on a 0-1000 integer or pixel coordinate system
  if (x > 1 || width > 1) {
    x = x / pageWidth;
    width = width / pageWidth;
  }
  if (y > 1 || height > 1) {
    y = y / pageHeight;
    height = height / pageHeight;
  }

  // Clamp into [0.0, 1.0]
  x = Math.max(0, Math.min(1, x));
  y = Math.max(0, Math.min(1, y));
  width = Math.max(0, Math.min(1 - x, width));
  height = Math.max(0, Math.min(1 - y, height));

  return {
    x: Number(x.toFixed(6)),
    y: Number(y.toFixed(6)),
    width: Number(width.toFixed(6)),
    height: Number(height.toFixed(6))
  };
}

/**
 * Ingests an extracted product and its attributes idempotently into PostgreSQL within an atomic transaction:
 * - UPSERT into extracted_products on (merchant_id, model_version_id, supplier_sku)
 * - UPSERT into extracted_attributes on (product_id, attribute_key) with provenance and confidence score
 * - Prunes removed attributes during re-extraction runs
 * - Deterministically evaluates gaps and syncs to product_gaps
 * - Transitions product state to NEEDS_REVIEW or ENRICHED (or FAILED_EXTRACTION)
 *
 * @param {Object} params - Ingestion parameters
 * @param {string} params.merchant_id - Tenant merchant UUID
 * @param {string} params.job_id - Extraction job UUID
 * @param {string} params.model_version_id - Product model version UUID
 * @param {Object} params.productData - Validated product object with supplier_sku and attributes
 * @param {string} [params.source_file_id] - Optional source file UUID
 * @param {number} [params.source_row_index] - Row or item index
 * @param {string} [params.source_column] - Source column name if known
 * @param {number} [params.page_number] - Lineage page number
 * @param {Object} [params.bounding_box] - Bounding box { x, y, w, h }
 * @param {number} [params.confidence_score] - Explicit confidence score override (0-100)
 * @param {string} [params.raw_source_value] - Raw unnormalized source value
 * @param {Object} [params.attribute_provenance] - Map of per-attribute provenance overrides
 * @param {boolean} [params.computeGaps=false] - Whether to trigger gap evaluation & state transition
 * @param {number} [params.min_confidence_threshold=75] - Minimum confidence threshold for gaps
 * @param {Object|Array} [params.schemaSnapshot] - Active model version snapshot
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
    page_number = null,
    bounding_box = null,
    _confidence_score = null,
    raw_source_value = null,
    attribute_provenance = {},
    computeGaps = false,
    min_confidence_threshold = 75,
    schemaSnapshot = null
  },
  client = pool
) {
  const supplierSku = productData.supplier_sku || productData.sku;
  if (!supplierSku) {
    throw new Error('supplier_sku is required for product ingestion');
  }

  const isDedicatedClient = client !== pool;
  const dbClient = isDedicatedClient ? client : await pool.connect();
  const shouldManageTransaction = !isDedicatedClient;

  if (shouldManageTransaction) {
    await dbClient.query('BEGIN');
  }

  try {
    // 1. UPSERT extracted_products - resetting state to PROCESSING if re-extracting
    const productRes = await dbClient.query(
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

    // Resolve snapshot attribute definitions if available
    let snapshotAttributes = [];
    if (schemaSnapshot) {
      snapshotAttributes = Array.isArray(schemaSnapshot)
        ? schemaSnapshot
        : Array.isArray(schemaSnapshot?.attributes)
          ? schemaSnapshot.attributes
          : [];
    }

    // 2. UPSERT extracted_attributes
    const nonAttrKeys = new Set([
      'supplier_sku',
      'sku',
      'page_number',
      'bounding_box',
      'raw_source_value',
      'confidence_score',
      'attribute_provenance'
    ]);

    const isSkuOrMetaKey = (k) => {
      if (nonAttrKeys.has(k)) return true;
      return /^(supplier[_\s-]?sku|sku|artikel[_\s-]?nr|item[_\s-]?number)$/i.test(k.trim());
    };

    const attributeKeys = Object.keys(productData).filter(
      (k) => !isSkuOrMetaKey(k) && productData[k] !== undefined
    );

    for (const attrKey of attributeKeys) {
      const attrVal = productData[attrKey];
      let actualVal = attrVal;
      let attrConfidence = null;
      let attrPageNumber = page_number;
      let attrBoundingBox = bounding_box;
      let attrRawSource = raw_source_value;
      let attrSourceColumn = source_column;

      // Extract lineage if attribute value itself is an object with metadata
      if (
        attrVal !== null &&
        typeof attrVal === 'object' &&
        !Array.isArray(attrVal) &&
        ('value' in attrVal || 'raw_source_value' in attrVal || 'bounding_box' in attrVal)
      ) {
        actualVal = attrVal.value !== undefined ? attrVal.value : null;
        // Fix 1: Ignore AI self-reported confidence_score (attrVal.confidence_score)
        if (attrVal.page_number !== undefined) attrPageNumber = attrVal.page_number;
        if (attrVal.bounding_box !== undefined) attrBoundingBox = attrVal.bounding_box;
        if (attrVal.raw_source_value !== undefined) attrRawSource = attrVal.raw_source_value;
        if (attrVal.source_column !== undefined) attrSourceColumn = attrVal.source_column;
      }

      // Check per-attribute explicit provenance dictionary (e.g. from tabular CSV mapping or test fixture)
      const prov = attribute_provenance[attrKey];
      if (prov) {
        // Only allow explicit test fixture overrides if passed in prov.confidence_score
        if (prov.confidence_score !== undefined) attrConfidence = prov.confidence_score;
        if (prov.page_number !== undefined) attrPageNumber = prov.page_number;
        if (prov.bounding_box !== undefined) attrBoundingBox = prov.bounding_box;
        if (prov.raw_source_value !== undefined) attrRawSource = prov.raw_source_value;
        if (prov.source_column !== undefined) attrSourceColumn = prov.source_column;
      }

      // Fix 8: Normalize bounding box
      const normalizedBbox = normalizeBoundingBox(attrBoundingBox);

      // Find schema definition for unit/type
      const attrDef = snapshotAttributes.find(
        (a) => (a.key || a.name) === attrKey
      );
      const attrType = attrDef?.data_type || null;
      const attrUnit = attrDef?.unit_type || null;

      // Fix 1: Always force calculation through our deterministic confidenceScorer unless explicitly fixed in prov test fixture
      if (attrConfidence === null || attrConfidence === undefined) {
        attrConfidence = calculateConfidenceScore({
          extractedValue: actualVal,
          rawSourceValue: attrRawSource,
          attributeType: attrType,
          unit: attrUnit
        });
      }

      const jsonVal = JSON.stringify(actualVal);
      const jsonBoundingBox = normalizedBbox
        ? JSON.stringify(normalizedBbox)
        : null;

      // Fix 3: Update source_file_id, source_row_index, and source_column on conflict
      await dbClient.query(
        `INSERT INTO extracted_attributes (
           product_id, attribute_key, value, confidence_score,
           source_file_id, source_row_index, source_column,
           page_number, bounding_box, raw_source_value, updated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
         ON CONFLICT (product_id, attribute_key)
         DO UPDATE SET
           value = EXCLUDED.value,
           confidence_score = EXCLUDED.confidence_score,
           source_file_id = EXCLUDED.source_file_id,
           source_row_index = EXCLUDED.source_row_index,
           source_column = EXCLUDED.source_column,
           page_number = EXCLUDED.page_number,
           bounding_box = EXCLUDED.bounding_box,
           raw_source_value = EXCLUDED.raw_source_value,
           updated_at = NOW()
         WHERE extracted_attributes.is_manually_overridden = false`,
        [
          productId,
          attrKey,
          jsonVal,
          attrConfidence ?? 50,
          source_file_id,
          source_row_index,
          attrSourceColumn,
          attrPageNumber,
          jsonBoundingBox,
          attrRawSource
        ]
      );
    }

    // Fix 3: Delete previously extracted attributes that are omitted in the new extraction run
    if (attributeKeys.length > 0) {
      await dbClient.query(
        `DELETE FROM extracted_attributes
         WHERE product_id = $1
           AND is_manually_overridden = false
           AND NOT (attribute_key = ANY($2::text[]))`,
        [productId, attributeKeys]
      );
    } else {
      await dbClient.query(
        `DELETE FROM extracted_attributes
         WHERE product_id = $1
           AND is_manually_overridden = false`,
        [productId]
      );
    }

    // 3. Gap Computation & State Transition
    let finalProduct = product;
    let gaps = [];
    let state = product.state;

    const shouldComputeGaps = Boolean(computeGaps || schemaSnapshot);
    if (shouldComputeGaps) {
      const gapResult = await computeAndSyncProductGaps(
        {
          productId,
          modelVersionId: model_version_id,
          schemaSnapshot,
          minConfidenceThreshold: min_confidence_threshold
        },
        dbClient
      );
      finalProduct = gapResult.product;
      gaps = gapResult.gaps;
      state = gapResult.state;
    }

    if (shouldManageTransaction) {
      await dbClient.query('COMMIT');
    }

    return {
      productId,
      product: finalProduct,
      state,
      gaps,
      attributeCount: attributeKeys.length
    };
  } catch (err) {
    if (shouldManageTransaction) {
      await dbClient.query('ROLLBACK').catch(() => { });
    }
    throw err;
  } finally {
    if (shouldManageTransaction) {
      dbClient.release();
    }
  }
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
          let processedData =
            rawItem && typeof rawItem === 'object' && !Array.isArray(rawItem)
              ? { ...rawItem }
              : rawItem;

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

          // For tabular CSV records, resolve SKU and attribute keys to schema definitions
          if (fileType === 'csv' && processedData && typeof processedData === 'object') {
            const rawKeys = Object.keys(processedData);

            // 1. Resolve SKU if not already present on processedData
            if (!processedData.supplier_sku && !processedData.sku) {
              const skuCol = rawKeys.find((k) =>
                /^(supplier[_\s-]?sku|sku|artikel[_\s-]?nr|item[_\s-]?number)$/i.test(k.trim())
              );
              if (skuCol && processedData[skuCol] !== undefined && processedData[skuCol] !== null) {
                processedData.supplier_sku = String(processedData[skuCol]).trim();
              }
            }

            // 2. Map raw CSV column headers to schema attribute keys
            if (schemaSnapshot) {
              const snapshotAttrs = Array.isArray(schemaSnapshot)
                ? schemaSnapshot
                : (schemaSnapshot.attributes || []);

              for (const attr of snapshotAttrs) {
                const attrKey = attr.key || (attr.name ? attr.name.toLowerCase().replace(/[^a-z0-9_]/g, '_') : null);
                if (!attrKey) continue;

                if (processedData[attrKey] === undefined) {
                  const matchCol = rawKeys.find((k) => {
                    const normK = k.toLowerCase().replace(/[^a-z0-9]/g, '');
                    const normAttrKey = attrKey.toLowerCase().replace(/[^a-z0-9]/g, '');
                    const normAttrName = (attr.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
                    return normK === normAttrKey || (normAttrName && normK === normAttrName);
                  });

                  if (matchCol && processedData[matchCol] !== undefined && processedData[matchCol] !== null) {
                    processedData[attrKey] = processedData[matchCol];
                  }
                }
              }
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
            if (!processedData || typeof processedData !== 'object') {
              itemValid = false;
              errorMessage = 'Invalid item payload';
              rawValue = String(processedData);
            } else {
              // 1. Strict SKU enforcement
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
                // 2. Conditional Schema Validation
                if (options.strictSchemaValidation) {
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
          }

          if (itemValid) {
            // Fix 2: For tabular/CSV sources, map CSV column and raw cell value to attributes
            let tabularProvenance = {};
            if (fileType === 'csv' && rawItem && typeof rawItem === 'object') {
              const rawKeys = Object.keys(rawItem);
              const normalizedRawKeyMap = new Map();
              for (const rk of rawKeys) {
                normalizedRawKeyMap.set(rk.toLowerCase().trim(), rk);
                normalizedRawKeyMap.set(rk.toLowerCase().replace(/[^a-z0-9]/g, '_'), rk);
              }

              const processedKeys = typeof processedData === 'object' && processedData ? Object.keys(processedData) : [];
              for (const key of processedKeys) {
                if (
                  key === 'supplier_sku' ||
                  key === 'sku' ||
                  /^(supplier[_\s-]?sku|sku|artikel[_\s-]?nr|item[_\s-]?number)$/i.test(key)
                ) {
                  continue;
                }
                let matchedCol = null;
                if (key in rawItem) {
                  matchedCol = key;
                } else {
                  const normKey = key.toLowerCase().replace(/[^a-z0-9]/g, '_');
                  if (normalizedRawKeyMap.has(normKey)) {
                    matchedCol = normalizedRawKeyMap.get(normKey);
                  } else if (normalizedRawKeyMap.has(key.toLowerCase().trim())) {
                    matchedCol = normalizedRawKeyMap.get(key.toLowerCase().trim());
                  } else if (schemaSnapshot) {
                    const attrs = Array.isArray(schemaSnapshot)
                      ? schemaSnapshot
                      : (schemaSnapshot.attributes || []);
                    const def = attrs.find((a) => (a.key || a.name) === key);
                    if (def?.name) {
                      const normName = def.name.toLowerCase().replace(/[^a-z0-9]/g, '_');
                      if (normalizedRawKeyMap.has(normName)) {
                        matchedCol = normalizedRawKeyMap.get(normName);
                      } else if (normalizedRawKeyMap.has(def.name.toLowerCase().trim())) {
                        matchedCol = normalizedRawKeyMap.get(def.name.toLowerCase().trim());
                      }
                    }
                  }
                }

                if (matchedCol !== null && rawItem[matchedCol] !== undefined && rawItem[matchedCol] !== null) {
                  tabularProvenance[key] = {
                    source_column: matchedCol,
                    raw_source_value: String(rawItem[matchedCol])
                  };
                }
              }
            }

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
                  page_number: processedData.page_number ?? rawItem?.page_number ?? null,
                  bounding_box: processedData.bounding_box ?? rawItem?.bounding_box ?? null,
                  raw_source_value: processedData.raw_source_value ?? rawItem?.raw_source_value ?? null,
                  confidence_score: null, // Fix 1: Ignore AI self-reported confidence score
                  attribute_provenance: {
                    ...tabularProvenance,
                    ...(options.attribute_provenance || {})
                  },
                  computeGaps: true,
                  schemaSnapshot,
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

            // If product has a SKU but extraction/validation failed, record as FAILED_EXTRACTION
            if (
              processedData &&
              typeof processedData === 'object' &&
              (processedData.supplier_sku || processedData.sku) &&
              job.merchant_id &&
              job.model_version_id
            ) {
              const sku = processedData.supplier_sku || processedData.sku;
              await client.query(
                `INSERT INTO extracted_products (
                   merchant_id, job_id, model_version_id, supplier_sku, state, updated_at
                 )
                 VALUES ($1, $2, $3, $4, 'FAILED_EXTRACTION', NOW())
                 ON CONFLICT (merchant_id, model_version_id, supplier_sku)
                 DO UPDATE SET
                   job_id = EXCLUDED.job_id,
                   state = 'FAILED_EXTRACTION',
                   updated_at = NOW()`,
                [job.merchant_id, jobId, job.model_version_id, String(sku).trim()]
              );
            }
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
  normalizeBoundingBox,
  ingestExtractedProduct,
  processJob,
  processNextJob,
  startExtractionWorker,
  stopExtractionWorker
};
