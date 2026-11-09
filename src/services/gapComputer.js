import { pool } from '../db/index.js';
import { compileAttributeFieldSchema } from './schemaCompiler.js';

export const DEFAULT_MIN_CONFIDENCE_THRESHOLD = 75;

/**
 * Resolves the minimum confidence threshold from merchant settings, env, or default.
 *
 * @param {Object} [merchantSettings]
 * @returns {number} Threshold between 0 and 100
 */
export function resolveMinConfidenceThreshold(merchantSettings = {}) {
  if (merchantSettings?.min_confidence_threshold !== undefined && merchantSettings?.min_confidence_threshold !== null) {
    const parsed = Number(merchantSettings.min_confidence_threshold);
    if (!isNaN(parsed) && parsed >= 0 && parsed <= 100) return parsed;
  }
  if (process.env.MIN_CONFIDENCE_THRESHOLD) {
    const envVal = Number(process.env.MIN_CONFIDENCE_THRESHOLD);
    if (!isNaN(envVal) && envVal >= 0 && envVal <= 100) return envVal;
  }
  return DEFAULT_MIN_CONFIDENCE_THRESHOLD;
}

/**
 * Evaluates whether a value violates an attribute's schema definition.
 *
 * @param {Object} attr - Attribute definition from product_model_versions snapshot
 * @param {*} value - Extracted value
 * @returns {{ isError: boolean, message?: string }}
 */
export function evaluateSchemaError(attr, value) {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) {
    return { isError: false };
  }

  const dataType = (attr.data_type || attr.dataType || 'string').toLowerCase();

  switch (dataType) {
    case 'integer':
    case 'number': {
      if (typeof value === 'boolean') {
        return { isError: true, message: `Expected integer for "${attr.name || attr.key}", received boolean` };
      }
      if (typeof value === 'number') {
        if (!Number.isInteger(value)) {
          return { isError: true, message: `Value ${value} is not a valid integer` };
        }
        return { isError: false };
      }
      if (typeof value === 'string') {
        if (!/^-?\d+$/.test(value.trim())) {
          return { isError: true, message: `String "${value}" is not a valid integer` };
        }
        return { isError: false };
      }
      return { isError: true, message: `Cannot convert ${typeof value} to integer` };
    }

    case 'boolean': {
      if (typeof value === 'boolean') {
        return { isError: false };
      }
      const validBools = ['true', 'false', '1', '0', 'yes', 'no', 'ja', 'nee'];
      const strVal = String(value).trim().toLowerCase();
      if (validBools.includes(strVal) || value === 1 || value === 0) {
        return { isError: false };
      }
      return { isError: true, message: `Value "${value}" cannot be parsed as boolean` };
    }

    case 'list_of_values':
    case 'enum': {
      let allowed = attr.allowed_values || attr.list_of_values || [];
      if (typeof allowed === 'string') {
        try {
          allowed = JSON.parse(allowed);
        } catch {
          allowed = [];
        }
      }

      if (Array.isArray(allowed) && allowed.length > 0) {
        const strVal = String(value).trim();
        const matches = allowed.some((allowedItem) => String(allowedItem).trim().toLowerCase() === strVal.toLowerCase());
        if (!matches) {
          return {
            isError: true,
            message: `Value "${value}" is not permitted. Allowed values: [${allowed.join(', ')}]`
          };
        }
      }
      return { isError: false };
    }

    case 'string':
    default: {
      if (typeof value === 'object' && value !== null) {
        return { isError: true, message: `Expected string, received object` };
      }
      const fieldSchema = compileAttributeFieldSchema(attr);
      const parsed = fieldSchema.safeParse(value);
      if (!parsed.success) {
        return {
          isError: true,
          message: parsed.error.issues[0]?.message || 'Schema validation failed'
        };
      }
      return { isError: false };
    }
  }
}

/**
 * Pure evaluation function: computes all gaps for an extracted product against model snapshot attributes.
 *
 * @param {Object} params
 * @param {Array<Object>} params.modelAttributes - Attribute definitions from model version snapshot
 * @param {Object|Array} params.extractedAttributes - Extracted attributes keyed by key or as array of records
 * @param {number} [params.minConfidenceThreshold=75] - Minimum acceptable confidence score
 * @returns {Array<{ attribute_key: string, gap_type: 'missing_required'|'low_confidence'|'schema_error', details: string }>}
 */
export function computeProductGaps({
  modelAttributes = [],
  extractedAttributes = {},
  minConfidenceThreshold = DEFAULT_MIN_CONFIDENCE_THRESHOLD
}) {
  const gaps = [];

  // Normalize extractedAttributes map
  let attrMap = {};
  if (Array.isArray(extractedAttributes)) {
    for (const item of extractedAttributes) {
      if (item && item.attribute_key) {
        let val = item.value;
        if (typeof val === 'string') {
          try {
            val = JSON.parse(val);
          } catch {
            // Keep as string
          }
        }
        attrMap[item.attribute_key] = {
          value: val,
          confidence_score: item.confidence_score !== undefined ? Number(item.confidence_score) : 100,
          raw_source_value: item.raw_source_value
        };
      }
    }
  } else if (extractedAttributes && typeof extractedAttributes === 'object') {
    for (const [key, item] of Object.entries(extractedAttributes)) {
      if (item && typeof item === 'object' && ('value' in item || 'confidence_score' in item)) {
        attrMap[key] = {
          value: item.value,
          confidence_score: item.confidence_score !== undefined ? Number(item.confidence_score) : 100,
          raw_source_value: item.raw_source_value
        };
      } else {
        attrMap[key] = {
          value: item,
          confidence_score: 100,
          raw_source_value: null
        };
      }
    }
  }

  for (const attr of modelAttributes) {
    const key = attr.key || (attr.name ? attr.name.toLowerCase().replace(/[^a-z0-9_]/g, '_') : null);
    if (!key) continue;

    const extracted = attrMap[key];
    const val = extracted ? extracted.value : undefined;
    const isMissing =
      val === undefined ||
      val === null ||
      (typeof val === 'string' && val.trim() === '');

    // 1. missing_required
    if (attr.is_required && isMissing) {
      gaps.push({
        attribute_key: key,
        gap_type: 'missing_required',
        details: `Required attribute "${attr.name || key}" is missing or empty.`
      });
      // Skip schema and confidence evaluation if value is missing
      continue;
    }

    // If optional and missing, no gap
    if (isMissing) {
      continue;
    }

    // 2. schema_error
    const schemaCheck = evaluateSchemaError(attr, val);
    if (schemaCheck.isError) {
      gaps.push({
        attribute_key: key,
        gap_type: 'schema_error',
        details: schemaCheck.message || `Attribute "${key}" failed schema validation.`
      });
    }

    // 3. low_confidence
    const score = extracted.confidence_score !== undefined ? extracted.confidence_score : 100;
    if (score < minConfidenceThreshold) {
      gaps.push({
        attribute_key: key,
        gap_type: 'low_confidence',
        details: `Confidence score (${score}) is below the required threshold of ${minConfidenceThreshold}.`
      });
    }
  }

  return gaps;
}

/**
 * Computes gaps and updates product state atomically in PostgreSQL.
 *
 * @param {Object} params
 * @param {string} params.productId - UUID of extracted product
 * @param {string} [params.modelVersionId] - Product model version UUID
 * @param {Object|Array} [params.schemaSnapshot] - Preloaded model version snapshot
 * @param {number} [params.minConfidenceThreshold=75] - Minimum confidence threshold
 * @param {boolean} [params.extractionFailed=false] - Flag if extraction failed catastrophically
 * @param {string} [params.failureReason] - Reason for extraction failure
 * @param {Object} [client=pool] - Active database client for transaction
 * @returns {Promise<{ state: string, gaps: Array, product: Object }>}
 */
export async function computeAndSyncProductGaps(
  {
    productId,
    modelVersionId,
    schemaSnapshot = null,
    minConfidenceThreshold = DEFAULT_MIN_CONFIDENCE_THRESHOLD,
    extractionFailed = false,
    failureReason = null
  },
  client = pool
) {
  // If catastrophic extraction failure
  if (extractionFailed) {
    const updateRes = await client.query(
      `UPDATE extracted_products
       SET state = 'FAILED_EXTRACTION',
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [productId]
    );

    return {
      state: 'FAILED_EXTRACTION',
      gaps: [],
      product: updateRes.rows[0],
      failureReason
    };
  }

  // 1. Resolve schema snapshot if not provided
  let snapshot = schemaSnapshot;
  if (!snapshot && modelVersionId) {
    const versionRes = await client.query(
      'SELECT snapshot FROM product_model_versions WHERE id = $1',
      [modelVersionId]
    );
    if (versionRes.rows.length > 0) {
      snapshot = versionRes.rows[0].snapshot;
    }
  }

  const modelAttributes = Array.isArray(snapshot)
    ? snapshot
    : Array.isArray(snapshot?.attributes)
      ? snapshot.attributes
      : [];

  // 2. Fetch current extracted attributes for product
  const attrRes = await client.query(
    `SELECT attribute_key, value, confidence_score, raw_source_value
     FROM extracted_attributes
     WHERE product_id = $1`,
    [productId]
  );

  // 3. Compute gaps
  const gaps = computeProductGaps({
    modelAttributes,
    extractedAttributes: attrRes.rows,
    minConfidenceThreshold
  });

  // 4. Atomic database sync: clear existing gaps for this product
  await client.query('DELETE FROM product_gaps WHERE product_id = $1', [productId]);

  // Batch insert new gaps
  if (gaps.length > 0) {
    const values = [];
    const params = [];
    let idx = 1;

    for (const gap of gaps) {
      params.push(productId, gap.attribute_key, gap.gap_type, gap.details || null);
      values.push(`($${idx}, $${idx + 1}, $${idx + 2}, $${idx + 3}, NOW())`);
      idx += 4;
    }

    await client.query(
      `INSERT INTO product_gaps (product_id, attribute_key, gap_type, details, created_at)
       VALUES ${values.join(', ')}
       ON CONFLICT (product_id, attribute_key, gap_type) DO UPDATE SET
         details = EXCLUDED.details,
         created_at = NOW()`,
      params
    );
  }

  // 5. State Transition Decision
  const targetState = gaps.length > 0 ? 'NEEDS_REVIEW' : 'ENRICHED';

  const updateProductRes = await client.query(
    `UPDATE extracted_products
     SET state = $1,
         updated_at = NOW()
     WHERE id = $2
     RETURNING *`,
    [targetState, productId]
  );

  return {
    state: targetState,
    gaps,
    product: updateProductRes.rows[0]
  };
}

/**
 * Promotes or transitions a product's state with strict illegal promotion guards.
 * Enforces the NEEDS_REVIEW -> ENRICHED promotion inside a single database transaction
 * using SELECT ... FOR UPDATE to prevent race conditions.
 *
 * @param {string} productId - Product UUID
 * @param {'PROCESSING'|'NEEDS_REVIEW'|'ENRICHED'|'FAILED_EXTRACTION'} targetState - Desired state
 * @param {Object} [client=pool] - Active database client
 * @returns {Promise<Object>} Updated product record
 * @throws {Error} Throws 409 Conflict if attempting to promote to ENRICHED with active gaps or from an invalid state
 */
export async function promoteProductState(productId, targetState, client = pool) {
  const allowedStates = ['PROCESSING', 'NEEDS_REVIEW', 'ENRICHED', 'FAILED_EXTRACTION'];
  if (!allowedStates.includes(targetState)) {
    const err = new Error(`Invalid target state "${targetState}". Allowed: ${allowedStates.join(', ')}`);
    err.status = 400;
    err.statusCode = 400;
    throw err;
  }

  const isDedicatedClient = client !== pool;
  const dbClient = isDedicatedClient ? client : await pool.connect();
  const shouldManageTransaction = !isDedicatedClient;

  if (shouldManageTransaction) {
    await dbClient.query('BEGIN');
  }

  try {
    // 1. Lock product row with SELECT ... FOR UPDATE to prevent race conditions
    const prodRes = await dbClient.query(
      'SELECT * FROM extracted_products WHERE id = $1 FOR UPDATE',
      [productId]
    );

    if (prodRes.rows.length === 0) {
      const err = new Error(`Product not found: ${productId}`);
      err.status = 404;
      err.statusCode = 404;
      throw err;
    }

    const currentProduct = prodRes.rows[0];

    // 2. Explicitly deny illegal transitions (e.g. direct from PROCESSING or FAILED_EXTRACTION to ENRICHED)
    if (targetState === 'ENRICHED') {
      if (currentProduct.state !== 'NEEDS_REVIEW') {
        const transitionError = new Error(
          `Illegal state transition: Cannot promote product from "${currentProduct.state}" to "ENRICHED". Product must be in "NEEDS_REVIEW" before promotion.`
        );
        transitionError.status = 409;
        transitionError.statusCode = 409;
        transitionError.error = 'ILLEGAL_STATE_TRANSITION';
        throw transitionError;
      }

      // Guard: Promotion to ENRICHED requires 0 active gaps
      const gapCountRes = await dbClient.query(
        'SELECT COUNT(*)::int AS count FROM product_gaps WHERE product_id = $1',
        [productId]
      );
      const activeGaps = gapCountRes.rows[0].count;

      if (activeGaps > 0) {
        const conflictError = new Error('Product has unresolved gaps and cannot transition to ENRICHED.');
        conflictError.status = 409;
        conflictError.statusCode = 409;
        conflictError.error = 'CANNOT_PROMOTE_WITH_ACTIVE_GAPS';
        conflictError.activeGapsCount = activeGaps;
        throw conflictError;
      }
    }

    const updateRes = await dbClient.query(
      `UPDATE extracted_products
       SET state = $1,
           updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [targetState, productId]
    );

    if (shouldManageTransaction) {
      await dbClient.query('COMMIT');
    }

    return updateRes.rows[0];
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
 * Resets a product's state cleanly to PROCESSING for re-extraction.
 *
 * @param {string} productId - Product UUID
 * @param {Object} [client=pool] - Database client
 * @returns {Promise<Object>} Updated product
 */
export async function resetProductForReExtraction(productId, client = pool) {
  const updateRes = await client.query(
    `UPDATE extracted_products
     SET state = 'PROCESSING',
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [productId]
  );

  if (updateRes.rows.length === 0) {
    const err = new Error(`Product not found: ${productId}`);
    err.status = 404;
    err.statusCode = 404;
    throw err;
  }

  return updateRes.rows[0];
}

export default {
  DEFAULT_MIN_CONFIDENCE_THRESHOLD,
  resolveMinConfidenceThreshold,
  evaluateSchemaError,
  computeProductGaps,
  computeAndSyncProductGaps,
  promoteProductState,
  resetProductForReExtraction
};
