import { pool } from '../db/index.js';
import {
  createModelSchema,
  updateModelSchema,
  createAttributeSchema,
  updateAttributeSchema,
  slugifyKey
} from '../schemas/modelSchema.js';

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
          const key = attr.key || slugifyKey(attr.name);
          const allowedJson = JSON.stringify(attr.allowed_values || attr.list_of_values || []);
          const attrResult = await client.query(
            `INSERT INTO product_model_attributes (model_id, name, key, data_type, is_required, unit_type, list_of_values, allowed_values)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING *`,
            [
              newModel.id,
              attr.name,
              key,
              attr.data_type,
              attr.is_required ?? false,
              attr.unit_type ?? null,
              allowedJson,
              allowedJson
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
          const key = attr.key || slugifyKey(attr.name);
          const allowedJson = JSON.stringify(attr.allowed_values || attr.list_of_values || []);
          const attrRes = await client.query(
            `INSERT INTO product_model_attributes (model_id, name, key, data_type, is_required, unit_type, list_of_values, allowed_values)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING *`,
            [
              id,
              attr.name,
              key,
              attr.data_type,
              attr.is_required ?? false,
              attr.unit_type ?? null,
              allowedJson,
              allowedJson
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
      `INSERT INTO product_model_attributes (model_id, name, key, data_type, is_required, unit_type, list_of_values, allowed_values)
       SELECT $1, name, key, data_type, is_required, unit_type, list_of_values, allowed_values
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

// ==========================================
// User Story B2.2: Attribute CRUD Handlers
// ==========================================

// Add a single attribute to an existing model (Task 4)
export async function addModelAttribute(req, res) {
  try {
    const { id: modelId } = req.params;
    const merchantId = req.merchantId || req.headers['x-merchant-id'];
    if (!merchantId) {
      return res.status(400).json({ error: 'Invalid or missing x-merchant-id header. Must be a valid UUID.' });
    }

    // Enforce cross-tenant isolation: caller must own this model (returns 404 for other merchants to avoid leaking resource existence)
    try {
      await verifyModelAccess(modelId, merchantId, true);
    } catch (err) {
      if (err.status === 403 && err.message.includes('other merchants')) {
        return res.status(404).json({ error: 'Model not found' });
      }
      throw err;
    }

    const parseResult = createAttributeSchema.safeParse(req.body);
    if (!parseResult.success) {
      const firstError = parseResult.error.issues[0]?.message || 'Validation error';
      return res.status(400).json({ error: firstError, details: parseResult.error.flatten() });
    }

    const attr = parseResult.data;
    const key = attr.key || slugifyKey(attr.name);
    const allowedJson = JSON.stringify(attr.allowed_values || attr.list_of_values || []);

    const result = await pool.query(
      `INSERT INTO product_model_attributes (model_id, name, key, data_type, is_required, unit_type, list_of_values, allowed_values)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        modelId,
        attr.name,
        key,
        attr.data_type,
        attr.is_required ?? false,
        attr.unit_type ?? null,
        allowedJson,
        allowedJson
      ]
    );

    return res.status(201).json(result.rows[0]);
  } catch (error) {
    const status = error.status || error.statusCode || 500;
    return res.status(status).json({ error: error.message });
  }
}

// Update an existing attribute on a model (Task 4)
export async function updateModelAttribute(req, res) {
  try {
    const { id: modelId } = req.params;
    const attributeId = req.params.attributeId || req.body?.id || req.body?.attribute_id || req.query?.attributeId;
    const merchantId = req.merchantId || req.headers['x-merchant-id'];

    if (!merchantId) {
      return res.status(400).json({ error: 'Invalid or missing x-merchant-id header. Must be a valid UUID.' });
    }

    if (!attributeId || !UUID_REGEX.test(attributeId)) {
      return res.status(404).json({ error: 'Attribute not found' });
    }

    // Enforce cross-tenant isolation: caller must own this model (returns 404 for other merchants to avoid leaking resource existence)
    try {
      await verifyModelAccess(modelId, merchantId, true);
    } catch (err) {
      if (err.status === 403 && err.message.includes('other merchants')) {
        return res.status(404).json({ error: 'Attribute not found' });
      }
      throw err;
    }

    // Verify attribute exists and belongs to this model
    const existingAttrRes = await pool.query(
      'SELECT * FROM product_model_attributes WHERE id = $1 AND model_id = $2',
      [attributeId, modelId]
    );

    if (existingAttrRes.rows.length === 0) {
      return res.status(404).json({ error: 'Attribute not found' });
    }

    const existingAttr = existingAttrRes.rows[0];

    const parseResult = updateAttributeSchema.safeParse(req.body);
    if (!parseResult.success) {
      const firstError = parseResult.error.issues[0]?.message || 'Validation error';
      return res.status(400).json({ error: firstError, details: parseResult.error.flatten() });
    }

    const data = parseResult.data;
    const newName = data.name !== undefined ? data.name : existingAttr.name;
    const newKey = data.key !== undefined ? data.key : (data.name ? slugifyKey(data.name) : existingAttr.key);
    const newDataType = data.data_type !== undefined ? data.data_type : existingAttr.data_type;
    const newIsRequired = data.is_required !== undefined ? data.is_required : existingAttr.is_required;
    const newUnitType = data.unit_type !== undefined ? data.unit_type : existingAttr.unit_type;

    let finalAllowedValues = data.allowed_values ?? data.list_of_values;
    if (finalAllowedValues === undefined) {
      finalAllowedValues = existingAttr.allowed_values ?? existingAttr.list_of_values ?? [];
    }

    if (newDataType === 'list_of_values') {
      if (!Array.isArray(finalAllowedValues) || finalAllowedValues.length === 0) {
        return res.status(400).json({
          error: 'allowed_values must be a non-empty array of strings when data_type is list_of_values'
        });
      }
    }

    const valuesJson = JSON.stringify(finalAllowedValues);

    const updateRes = await pool.query(
      `UPDATE product_model_attributes
       SET name = $1,
           key = $2,
           data_type = $3,
           is_required = $4,
           unit_type = $5,
           list_of_values = $6,
           allowed_values = $7
       WHERE id = $8 AND model_id = $9
       RETURNING *`,
      [
        newName,
        newKey,
        newDataType,
        newIsRequired,
        newUnitType,
        valuesJson,
        valuesJson,
        attributeId,
        modelId
      ]
    );

    return res.status(200).json(updateRes.rows[0]);
  } catch (error) {
    const status = error.status || error.statusCode || 500;
    return res.status(status).json({ error: error.message });
  }
}

// Delete an attribute from a model (Task 4)
export async function deleteModelAttribute(req, res) {
  try {
    const { id: modelId } = req.params;
    const attributeId = req.params.attributeId || req.body?.id || req.body?.attribute_id || req.query?.attributeId;
    const merchantId = req.merchantId || req.headers['x-merchant-id'];

    if (!merchantId) {
      return res.status(400).json({ error: 'Invalid or missing x-merchant-id header. Must be a valid UUID.' });
    }

    if (!attributeId || !UUID_REGEX.test(attributeId)) {
      return res.status(404).json({ error: 'Attribute not found' });
    }

    // Enforce cross-tenant isolation: caller must own this model (returns 404 for other merchants to avoid leaking resource existence)
    try {
      await verifyModelAccess(modelId, merchantId, true);
    } catch (err) {
      if (err.status === 403 && err.message.includes('other merchants')) {
        return res.status(404).json({ error: 'Attribute not found' });
      }
      throw err;
    }

    const deleteRes = await pool.query(
      'DELETE FROM product_model_attributes WHERE id = $1 AND model_id = $2 RETURNING id',
      [attributeId, modelId]
    );

    if (deleteRes.rows.length === 0) {
      return res.status(404).json({ error: 'Attribute not found' });
    }

    return res.status(200).json({
      message: 'Attribute deleted successfully',
      id: attributeId
    });
  } catch (error) {
    const status = error.status || error.statusCode || 500;
    return res.status(status).json({ error: error.message });
  }
}

// List all attributes of a model
export async function getModelAttributes(req, res) {
  try {
    const { id: modelId } = req.params;
    const merchantId = req.merchantId || req.headers['x-merchant-id'];

    if (!merchantId) {
      return res.status(400).json({ error: 'Invalid or missing x-merchant-id header. Must be a valid UUID.' });
    }

    // Read access check: merchant can read their own models and shared templates
    try {
      await verifyModelAccess(modelId, merchantId, false);
    } catch (err) {
      if (err.status === 403 && err.message.includes('other merchants')) {
        return res.status(404).json({ error: 'Model not found' });
      }
      throw err;
    }

    const result = await pool.query(
      'SELECT * FROM product_model_attributes WHERE model_id = $1 ORDER BY name ASC',
      [modelId]
    );

    return res.status(200).json({ attributes: result.rows });
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
  getModels,
  addModelAttribute,
  updateModelAttribute,
  deleteModelAttribute,
  getModelAttributes
};
