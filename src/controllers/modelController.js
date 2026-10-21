import { pool } from '../db/index.js';
import { createModelSchema, updateModelSchema } from '../validations/modelSchema.js';

// Catch malformed UUIDs early before hitting Postgres
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Guard helper: makes sure the model exists, isn't archived, and belongs to the caller.
// Base templates are open to everyone for reading/cloning, but locked down against edits.
export async function verifyModelAccess(modelId, reqMerchantId, requireWriteAccess = false, client = pool) {
  if (!modelId || !UUID_REGEX.test(modelId)) {
    const error = new Error('Model not found');
    error.status = 404;
    error.statusCode = 404;
    throw error;
  }

  const result = await client.query(
    'SELECT * FROM product_models WHERE id = $1',
    [modelId]
  );

  if (result.rows.length === 0) {
    const error = new Error('Model not found');
    error.status = 404;
    error.statusCode = 404;
    throw error;
  }

  const model = result.rows[0];

  if (model.status === 'ARCHIVED') {
    const error = new Error('Model not found');
    error.status = 404;
    error.statusCode = 404;
    throw error;
  }

  if (requireWriteAccess) {
    // Base templates are shared across the system, so merchants cannot edit or delete them
    if (model.merchant_id === null) {
      const error = new Error('Forbidden: Global templates are read-only');
      error.status = 403;
      error.statusCode = 403;
      throw error;
    }

    // Make sure merchants can't touch each other's models
    if (model.merchant_id !== reqMerchantId) {
      const error = new Error('Forbidden: Cannot modify models belonging to other merchants');
      error.status = 403;
      error.statusCode = 403;
      throw error;
    }
  } else {
    // Allow reading shared templates, but block snooping on other tenants
    if (model.merchant_id !== null && model.merchant_id !== reqMerchantId) {
      const error = new Error('Forbidden: Cannot access models belonging to other merchants');
      error.status = 403;
      error.statusCode = 403;
      throw error;
    }
  }

  return model;
}

// Spin up a brand new product model scoped to the calling merchant
export async function createModel(req, res) {
  try {
    const merchantId = req.merchantId || req.headers['x-merchant-id'];
    if (!merchantId) {
      return res.status(400).json({ error: 'Invalid or missing x-merchant-id header. Must be a valid UUID.' });
    }

    const parseResult = createModelSchema.safeParse(req.body);
    if (!parseResult.success) {
      const firstError = parseResult.error.issues[0]?.message || 'Validation error';
      return res.status(400).json({ error: firstError, details: parseResult.error.flatten() });
    }

    const { name, description = null, attributes = [] } = parseResult.data;
    const createdBy = req.headers['x-user-id'] || req.body?.created_by || merchantId;
    const updatedBy = req.headers['x-user-id'] || req.body?.updated_by || merchantId;

    const client = await pool.connect();
    try {
      // Wrap model creation and its attributes in a transaction so I never save a half-baked model
      await client.query('BEGIN');

      const modelResult = await client.query(
        `INSERT INTO product_models (merchant_id, name, description, status, schema_version, created_by, updated_by)
         VALUES ($1, $2, $3, 'ACTIVE', 1, $4, $5)
         RETURNING *`,
        [merchantId, name, description, createdBy, updatedBy]
      );
      const newModel = modelResult.rows[0];

      const insertedAttributes = [];
      if (attributes && attributes.length > 0) {
        for (const attr of attributes) {
          const attrResult = await client.query(
            `INSERT INTO product_model_attributes (model_id, name, data_type, is_required, list_of_values)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING *`,
            [
              newModel.id,
              attr.name,
              attr.data_type,
              attr.is_required ?? false,
              JSON.stringify(attr.list_of_values ?? [])
            ]
          );
          insertedAttributes.push(attrResult.rows[0]);
        }
      }

      await client.query('COMMIT');

      return res.status(201).json({
        ...newModel,
        attributes: insertedAttributes
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (error) {
    const status = error.status || error.statusCode || 500;
    return res.status(status).json({ error: error.message });
  }
}

// Update an existing model and replace its attribute set if new ones were provided
export async function updateModel(req, res) {
  try {
    const { id } = req.params;
    const merchantId = req.merchantId || req.headers['x-merchant-id'];
    if (!merchantId) {
      return res.status(400).json({ error: 'Invalid or missing x-merchant-id header. Must be a valid UUID.' });
    }

    // Make sure the caller actually owns this model before touching anything
    const existingModel = await verifyModelAccess(id, merchantId, true);

    const parseResult = updateModelSchema.safeParse(req.body);
    if (!parseResult.success) {
      const firstError = parseResult.error.issues[0]?.message || 'Validation error';
      return res.status(400).json({ error: firstError, details: parseResult.error.flatten() });
    }

    const { name, description, attributes, status } = parseResult.data;
    const updatedBy = req.headers['x-user-id'] || req.body?.updated_by || merchantId;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const newName = name !== undefined ? name : existingModel.name;
      const newDesc = description !== undefined ? description : existingModel.description;
      const newStatus = status !== undefined ? status : existingModel.status;

      const updateResult = await client.query(
        `UPDATE product_models
         SET name = $1,
             description = $2,
             status = $3,
             updated_by = $4,
             updated_at = NOW()
         WHERE id = $5 AND merchant_id = $6
         RETURNING *`,
        [newName, newDesc, newStatus, updatedBy, id, merchantId]
      );
      const updatedModel = updateResult.rows[0];

      let currentAttributes = [];
      if (attributes !== undefined) {
        // Swap out the old attributes with the new set atomically
        await client.query('DELETE FROM product_model_attributes WHERE model_id = $1', [id]);
        for (const attr of attributes) {
          const attrRes = await client.query(
            `INSERT INTO product_model_attributes (model_id, name, data_type, is_required, list_of_values)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING *`,
            [
              id,
              attr.name,
              attr.data_type,
              attr.is_required ?? false,
              JSON.stringify(attr.list_of_values ?? [])
            ]
          );
          currentAttributes.push(attrRes.rows[0]);
        }
      } else {
        const attrRes = await client.query(
          'SELECT * FROM product_model_attributes WHERE model_id = $1',
          [id]
        );
        currentAttributes = attrRes.rows;
      }

      await client.query('COMMIT');

      return res.status(200).json({
        ...updatedModel,
        attributes: currentAttributes
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (error) {
    const status = error.status || error.statusCode || 500;
    return res.status(status).json({ error: error.message });
  }
}

// Soft-delete: flip status to ARCHIVED so historical data and lineage stay intact
export async function deleteModel(req, res) {
  try {
    const { id } = req.params;
    const merchantId = req.merchantId || req.headers['x-merchant-id'];
    if (!merchantId) {
      return res.status(400).json({ error: 'Invalid or missing x-merchant-id header. Must be a valid UUID.' });
    }

    // Only the owner can archive their model; base templates are untouchable
    await verifyModelAccess(id, merchantId, true);

    const updatedBy = req.headers['x-user-id'] || req.body?.updated_by || merchantId;

    const result = await pool.query(
      `UPDATE product_models
       SET status = 'ARCHIVED',
           updated_at = NOW(),
           updated_by = $1
       WHERE id = $2 AND merchant_id = $3
       RETURNING *`,
      [updatedBy, id, merchantId]
    );

    return res.status(200).json({
      message: 'Model archived successfully',
      id: result.rows[0].id,
      status: 'ARCHIVED'
    });
  } catch (error) {
    const status = error.status || error.statusCode || 500;
    return res.status(status).json({ error: error.message });
  }
}

// Clone a base template (or custom model) into a brand new model under the requester's tenant
export async function cloneModel(req, res) {
  const templateId = req.params.templateId || req.params.id;
  const merchantId = req.merchantId || req.headers['x-merchant-id'];

  if (!merchantId) {
    return res.status(400).json({ error: 'Invalid or missing x-merchant-id header. Must be a valid UUID.' });
  }

  const client = await pool.connect();

  try {
    // Using a transaction here to guarantee data consistency. If the attribute deep-copy fails, I roll everything back so I don't end up with an orphaned model.
    await client.query('BEGIN');

    // Pass the active client so this access check participates in the same transaction
    const parentTemplate = await verifyModelAccess(templateId, merchantId, false, client);

    const createdBy = req.headers['x-user-id'] || req.body?.created_by || merchantId;
    const updatedBy = req.headers['x-user-id'] || req.body?.updated_by || merchantId;
    const cloneName = `${parentTemplate.name} (Clone)`;

    // Reset to version 1 and stamp the caller's tenant ID so they own this new copy
    const modelInsertResult = await client.query(
      `INSERT INTO product_models (merchant_id, name, description, status, schema_version, created_by, updated_by)
       VALUES ($1, $2, $3, 'ACTIVE', 1, $4, $5)
       RETURNING *`,
      [merchantId, cloneName, parentTemplate.description, createdBy, updatedBy]
    );
    const clonedModel = modelInsertResult.rows[0];

    // Snapshot all parent attributes into fresh rows pointing to the new model
    const clonedAttributesResult = await client.query(
      `INSERT INTO product_model_attributes (model_id, name, data_type, is_required, list_of_values)
       SELECT $1, name, data_type, is_required, list_of_values
       FROM product_model_attributes
       WHERE model_id = $2
       RETURNING *`,
      [clonedModel.id, templateId]
    );

    await client.query('COMMIT');

    return res.status(201).json({
      ...clonedModel,
      attributes: clonedAttributesResult.rows
    });
  } catch (error) {
    await client.query('ROLLBACK');
    const status = error.status || error.statusCode || 500;
    return res.status(status).json({ error: error.message });
  } finally {
    client.release();
  }
}

// Fetch a single model along with all of its defined attributes
export async function getModelById(req, res) {
  try {
    const { id } = req.params;
    const merchantId = req.merchantId || req.headers['x-merchant-id'];
    if (!merchantId) {
      return res.status(400).json({ error: 'Invalid or missing x-merchant-id header. Must be a valid UUID.' });
    }

    const model = await verifyModelAccess(id, merchantId, false);

    const attrResult = await pool.query(
      'SELECT * FROM product_model_attributes WHERE model_id = $1 ORDER BY name ASC',
      [id]
    );

    return res.status(200).json({
      ...model,
      attributes: attrResult.rows
    });
  } catch (error) {
    const status = error.status || error.statusCode || 500;
    return res.status(status).json({ error: error.message });
  }
}

// List models visible to this merchant: their own active models plus the shared base templates
export async function getModels(req, res) {
  try {
    const merchantId = req.merchantId || req.headers['x-merchant-id'];
    if (!merchantId) {
      return res.status(400).json({ error: 'Invalid or missing x-merchant-id header. Must be a valid UUID.' });
    }

    const statusFilter = req.query.status;
    let result;

    if (statusFilter) {
      result = await pool.query(
        `SELECT m.*,
                COALESCE(
                  (SELECT json_agg(a.* ORDER BY a.name) FROM product_model_attributes a WHERE a.model_id = m.id),
                  '[]'::json
                ) AS attributes
         FROM product_models m
         WHERE (m.merchant_id = $1 OR m.merchant_id IS NULL)
           AND m.status = $2
         ORDER BY m.created_at DESC`,
        [merchantId, statusFilter.toUpperCase()]
      );
    } else {
      result = await pool.query(
        `SELECT m.*,
                COALESCE(
                  (SELECT json_agg(a.* ORDER BY a.name) FROM product_model_attributes a WHERE a.model_id = m.id),
                  '[]'::json
                ) AS attributes
         FROM product_models m
         WHERE (m.merchant_id = $1 OR m.merchant_id IS NULL)
           AND m.status != 'ARCHIVED'
         ORDER BY m.created_at DESC`,
        [merchantId]
      );
    }

    return res.status(200).json({ models: result.rows });
  } catch (error) {
    const status = error.status || error.statusCode || 500;
    return res.status(status).json({ error: error.message });
  }
}

export default {
  verifyModelAccess,
  createModel,
  updateModel,
  deleteModel,
  cloneModel,
  getModelById,
  getModels
};
