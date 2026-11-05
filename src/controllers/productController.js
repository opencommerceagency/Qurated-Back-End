import { z } from 'zod';
import { pool } from '../db/index.js';
import { compileAttributesOverrideSchema } from '../services/schemaCompiler.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const queryParamsSchema = z.object({
  state: z.enum(['PROCESSING', 'NEEDS_REVIEW', 'ENRICHED', 'FAILED_EXTRACTION']).optional(),
  job_id: z.string().refine((val) => UUID_REGEX.test(val), { message: 'job_id must be a valid UUID' }).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20)
});

const updateAttributesBodySchema = z.object({
  attributes: z.record(z.string(), z.any()).refine(
    (attrs) => Object.keys(attrs).length > 0,
    { message: 'attributes object must contain at least one attribute to update' }
  )
});

/**
 * GET /api/products
 * Retrieves paginated products for the review queue with optional state and job_id filters.
 * Returns products with aggregated active product_gaps and pagination metadata.
 */
export async function getProducts(req, res) {
  try {
    const merchantId = req.merchantId;
    if (!merchantId) {
      return res.status(400).json({ error: 'Invalid or missing x-merchant-id header. Must be a valid UUID.' });
    }

    const parseResult = queryParamsSchema.safeParse(req.query);
    if (!parseResult.success) {
      const firstError = parseResult.error.issues[0]?.message || 'Invalid query parameters';
      return res.status(400).json({ error: firstError, details: parseResult.error.flatten() });
    }

    const { state, job_id, page, limit } = parseResult.data;
    const offset = (page - 1) * limit;

    const conditions = ['p.merchant_id = $1'];
    const params = [merchantId];
    let paramIndex = 2;

    if (state) {
      conditions.push(`p.state = $${paramIndex}`);
      params.push(state);
      paramIndex++;
    }

    if (job_id) {
      conditions.push(`p.job_id = $${paramIndex}`);
      params.push(job_id);
      paramIndex++;
    }

    const whereClause = conditions.join(' AND ');

    // 1. Total matching products count
    const countQuery = `SELECT COUNT(*)::int AS total FROM extracted_products p WHERE ${whereClause}`;
    const countRes = await pool.query(countQuery, params);
    const total = countRes.rows[0].total;

    // 2. Fetch paginated products with aggregated active product_gaps
    const dataParams = [...params, limit, offset];
    const dataQuery = `
      SELECT
        p.id,
        p.merchant_id,
        p.job_id,
        p.model_version_id,
        p.supplier_sku,
        p.state,
        p.created_at,
        p.updated_at,
        COALESCE(
          (
            SELECT json_agg(
              json_build_object(
                'id', g.id,
                'attribute_key', g.attribute_key,
                'gap_type', g.gap_type,
                'details', g.details
              ) ORDER BY g.created_at ASC
            )
            FROM product_gaps g
            WHERE g.product_id = p.id
          ),
          '[]'::json
        ) AS gaps
      FROM extracted_products p
      WHERE ${whereClause}
      ORDER BY p.created_at DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;

    const dataRes = await pool.query(dataQuery, dataParams);
    const totalPages = Math.ceil(total / limit) || 0;

    return res.status(200).json({
      data: dataRes.rows,
      pagination: {
        page,
        limit,
        total,
        totalPages
      }
    });
  } catch (error) {
    const status = error.status || error.statusCode || 500;
    return res.status(status).json({ error: error.message });
  }
}

/**
 * GET /api/products/:id
 * Retrieves a single product by ID, verifying tenant isolation.
 * Includes active product_gaps and all associated records from extracted_attributes.
 */
export async function getProductById(req, res) {
  try {
    const merchantId = req.merchantId;
    if (!merchantId) {
      return res.status(400).json({ error: 'Invalid or missing x-merchant-id header. Must be a valid UUID.' });
    }

    const { id } = req.params;
    if (!id || !UUID_REGEX.test(id)) {
      return res.status(404).json({ error: 'Product not found' });
    }

    // 1. Fetch product record
    const prodRes = await pool.query(
      `SELECT id, merchant_id, job_id, model_version_id, supplier_sku, state, created_at, updated_at
       FROM extracted_products
       WHERE id = $1 AND merchant_id = $2`,
      [id, merchantId]
    );

    if (prodRes.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const product = prodRes.rows[0];

    // 2. Fetch active product gaps
    const gapsRes = await pool.query(
      `SELECT id, product_id, attribute_key, gap_type, details, created_at
       FROM product_gaps
       WHERE product_id = $1
       ORDER BY created_at ASC`,
      [id]
    );

    // 3. Fetch all extracted attributes with provenance and override audit metadata
    const attrRes = await pool.query(
      `SELECT
         id,
         product_id,
         attribute_key,
         value,
         confidence_score,
         source_file_id,
         source_row_index,
         source_column,
         page_number,
         bounding_box,
         raw_source_value,
         is_manually_overridden,
         overridden_by,
         overridden_at,
         created_at,
         updated_at
       FROM extracted_attributes
       WHERE product_id = $1
       ORDER BY attribute_key ASC`,
      [id]
    );

    return res.status(200).json({
      ...product,
      gaps: gapsRes.rows,
      attributes: attrRes.rows
    });
  } catch (error) {
    const status = error.status || error.statusCode || 500;
    return res.status(status).json({ error: error.message });
  }
}

/**
 * PUT /api/products/:id/attributes
 * Manually overrides product attributes within a single atomic PostgreSQL transaction:
 * - Validates provided attributes using dynamically compiled Zod schema from model snapshot
 * - Updates or inserts extracted_attributes with confidence_score=100 and audit metadata
 * - Deletes resolved gaps from product_gaps
 * - Evaluates remaining gaps: promotes to ENRICHED if 0 gaps remain, else stays in NEEDS_REVIEW
 */
export async function updateProductAttributes(req, res) {
  const client = await pool.connect();
  try {
    const merchantId = req.merchantId;
    if (!merchantId) {
      client.release();
      return res.status(400).json({ error: 'Invalid or missing x-merchant-id header. Must be a valid UUID.' });
    }

    const { id } = req.params;
    if (!id || !UUID_REGEX.test(id)) {
      client.release();
      return res.status(404).json({ error: 'Product not found' });
    }

    const bodyValidation = updateAttributesBodySchema.safeParse(req.body);
    if (!bodyValidation.success) {
      client.release();
      const firstError = bodyValidation.error.issues[0]?.message || 'Invalid request body';
      return res.status(400).json({ error: firstError, details: bodyValidation.error.flatten() });
    }

    const attributesToUpdate = bodyValidation.data.attributes;
    const attributeKeys = Object.keys(attributesToUpdate);

    await client.query('BEGIN');

    // 1. Retrieve product and active model version snapshot
    const prodRes = await client.query(
      `SELECT p.id, p.merchant_id, p.model_version_id, p.state, v.snapshot
       FROM extracted_products p
       JOIN product_model_versions v ON v.id = p.model_version_id
       WHERE p.id = $1 AND p.merchant_id = $2
       FOR UPDATE`,
      [id, merchantId]
    );

    if (prodRes.rows.length === 0) {
      await client.query('ROLLBACK');
      client.release();
      return res.status(404).json({ error: 'Product not found' });
    }

    const product = prodRes.rows[0];
    const snapshot = product.snapshot;

    // 2. Dynamically compile runtime Zod validator for the provided attributes
    const overrideValidator = compileAttributesOverrideSchema(snapshot, attributeKeys);
    const parseResult = overrideValidator.safeParse(attributesToUpdate);

    if (!parseResult.success) {
      await client.query('ROLLBACK');
      client.release();
      return res.status(400).json({
        error: 'SCHEMA_VALIDATION_ERROR',
        message: parseResult.error.issues[0]?.message || 'Schema validation failed for one or more attributes',
        details: parseResult.error.flatten()
      });
    }

    const validatedAttributes = parseResult.data;
    const overriddenBy = req.userId || req.headers['x-user-id'] || 'operator';

    // 3. Update or insert extracted_attributes and delete resolved gaps
    for (const [attrKey, attrVal] of Object.entries(validatedAttributes)) {
      const jsonVal = JSON.stringify(attrVal);

      await client.query(
        `INSERT INTO extracted_attributes (
           product_id, attribute_key, value, confidence_score,
           is_manually_overridden, overridden_by, overridden_at, updated_at
         )
         VALUES ($1, $2, $3, 100, true, $4, NOW(), NOW())
         ON CONFLICT (product_id, attribute_key)
         DO UPDATE SET
           value = EXCLUDED.value,
           confidence_score = 100,
           is_manually_overridden = true,
           overridden_by = EXCLUDED.overridden_by,
           overridden_at = EXCLUDED.overridden_at,
           updated_at = NOW()`,
        [id, attrKey, jsonVal, overriddenBy]
      );

      // Delete resolved gap for this attribute
      await client.query(
        'DELETE FROM product_gaps WHERE product_id = $1 AND attribute_key = $2',
        [id, attrKey]
      );
    }

    // 4. Evaluate remaining gaps
    const remainingGapsRes = await client.query(
      'SELECT COUNT(*)::int AS count FROM product_gaps WHERE product_id = $1',
      [id]
    );
    const remainingGapsCount = remainingGapsRes.rows[0].count;

    // If all gaps resolved -> ENRICHED, else stay in NEEDS_REVIEW
    const targetState = remainingGapsCount === 0 ? 'ENRICHED' : 'NEEDS_REVIEW';

    await client.query(
      `UPDATE extracted_products
       SET state = $1, updated_at = NOW()
       WHERE id = $2`,
      [targetState, id]
    );

    await client.query('COMMIT');
    client.release();

    return res.status(200).json({
      product_id: id,
      state: targetState,
      remaining_gaps_count: remainingGapsCount,
      message: 'Attributes successfully updated'
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    const status = error.status || error.statusCode || 500;
    return res.status(status).json({ error: error.message });
  }
}

export default {
  getProducts,
  getProductById,
  updateProductAttributes
};

