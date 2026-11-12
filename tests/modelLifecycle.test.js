import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import express from 'express';
import { pool } from '../src/db/index.js';
import modelRouter from '../src/routes/models.js';
import { verifyModelAccess } from '../src/controllers/modelController.js';
import { modelSchema, attributeSchema, updateModelSchema } from '../src/validations/modelSchema.js';

process.env.API_KEY = process.env.API_KEY || 'qurated_dev_api_key_2026';
process.env.API_AUTH_USER = process.env.API_AUTH_USER || 'admin';
process.env.API_AUTH_PASS = process.env.API_AUTH_PASS || 'qurated_dev_password';

describe('Milestone B2.1: Product Model Lifecycle & Template Cloning', () => {
  let app;
  let server;
  let baseUrl;

  const merchantA = '11111111-1111-1111-1111-111111111111';
  const merchantB = '22222222-2222-2222-2222-222222222222';
  const validApiKey = 'qurated_dev_api_key_2026';

  let globalTemplateId;
  let merchantAModelId;
  const createdModelIds = [];

  before(async () => {
    app = express();
    app.use(express.json());
    app.use('/api/models', modelRouter);

    await new Promise((resolve) => {
      server = app.listen(0, () => {
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}/api/models`;
        resolve();
      });
    });

    // Seed a global base template (merchant_id: null)
    const tplRes = await pool.query(
      `INSERT INTO product_models (merchant_id, name, description, status, schema_version, created_by, updated_by)
       VALUES (NULL, 'Standard Apparel Template', 'Base industry template for clothing', 'ACTIVE', 1, 'system_admin', 'system_admin')
       RETURNING id`
    );
    globalTemplateId = tplRes.rows[0].id;
    createdModelIds.push(globalTemplateId);

    // Seed attributes for global template
    await pool.query(
      `INSERT INTO product_model_attributes (model_id, name, data_type, is_required, list_of_values)
       VALUES 
         ($1, 'size', 'enum', true, '["XS", "S", "M", "L", "XL"]'::jsonb),
         ($1, 'color', 'string', true, '[]'::jsonb),
         ($1, 'material', 'string', false, '[]'::jsonb)`,
      [globalTemplateId]
    );
  });

  after(async () => {
    // Clean up created models (CASCADE will delete attributes)
    if (createdModelIds.length > 0) {
      await pool.query('DELETE FROM product_models WHERE id = ANY($1)', [createdModelIds]);
    }
    await new Promise((resolve) => server.close(resolve));
    await pool.end();
  });

  describe('1. Zod Validation Unit Tests (src/validations/modelSchema.js)', () => {
    it('should reject model name with fewer than 3 characters', () => {
      const result = modelSchema.safeParse({ name: 'ab' });
      assert.strictEqual(result.success, false);
      assert.ok(result.error.issues.some((i) => i.path.includes('name')));
    });

    it('should reject model name exceeding 255 characters', () => {
      const longName = 'a'.repeat(256);
      const result = modelSchema.safeParse({ name: longName });
      assert.strictEqual(result.success, false);
    });

    it('should accept valid model without attributes and supply default []', () => {
      const result = modelSchema.safeParse({ name: 'Valid Model' });
      assert.strictEqual(result.success, true);
      assert.deepStrictEqual(result.data.attributes, []);
    });

    it('should reject attribute with invalid data_type enum', () => {
      const result = attributeSchema.safeParse({
        name: 'test_attr',
        data_type: 'invalid_type'
      });
      assert.strictEqual(result.success, false);
    });

    it('should accept valid attribute and apply default is_required and list_of_values', () => {
      const result = attributeSchema.safeParse({
        name: 'sku',
        data_type: 'string'
      });
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.data.is_required, false);
      assert.deepStrictEqual(result.data.list_of_values, []);
    });

    it('should reject attribute with empty name', () => {
      const result = attributeSchema.safeParse({
        name: '',
        data_type: 'number'
      });
      assert.strictEqual(result.success, false);
    });

    it('should validate updateModelSchema fields optionally', () => {
      const result = updateModelSchema.safeParse({
        name: 'Updated Name'
      });
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.data.name, 'Updated Name');
    });
  });

  describe('2. verifyModelAccess Helper Function Tests', () => {
    it('should throw 404 for non-existent model ID or invalid UUID', async () => {
      await assert.rejects(
        async () => {
          await verifyModelAccess('00000000-0000-0000-0000-000000000099', merchantA, false);
        },
        (err) => {
          assert.strictEqual(err.status, 404);
          return true;
        }
      );

      await assert.rejects(
        async () => {
          await verifyModelAccess('not-a-uuid', merchantA, false);
        },
        (err) => {
          assert.strictEqual(err.status, 404);
          return true;
        }
      );
    });

    it('should allow read access to global templates (merchant_id: null)', async () => {
      const model = await verifyModelAccess(globalTemplateId, merchantA, false);
      assert.strictEqual(model.id, globalTemplateId);
      assert.strictEqual(model.merchant_id, null);
    });

    it('should reject write access to global templates with 403 Forbidden', async () => {
      await assert.rejects(
        async () => {
          await verifyModelAccess(globalTemplateId, merchantA, true);
        },
        (err) => {
          assert.strictEqual(err.status, 403);
          assert.ok(err.message.includes('Global templates are read-only'));
          return true;
        }
      );
    });
  });

  describe('3. Multi-Tenant Model CRUD & Soft-Delete (Acceptance Criteria 1)', () => {
    it('POST /api/models should create a new model scoped to the requesting merchant', async () => {
      const res = await fetch(baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': validApiKey,
          'x-merchant-id': merchantA
        },
        body: JSON.stringify({
          name: 'Merchant A Catalog Model',
          description: 'Custom product schema for Merchant A',
          attributes: [
            { name: 'barcode', data_type: 'string', is_required: true },
            { name: 'weight', data_type: 'number', is_required: false },
            { name: 'condition', data_type: 'enum', is_required: false, list_of_values: ['NEW', 'REFURBISHED'] }
          ]
        })
      });

      assert.strictEqual(res.status, 201);
      const data = await res.json();
      assert.ok(data.id);
      assert.strictEqual(data.merchant_id, merchantA);
      assert.strictEqual(data.name, 'Merchant A Catalog Model');
      assert.strictEqual(data.status, 'ACTIVE');
      assert.strictEqual(data.schema_version, 1);
      assert.strictEqual(data.attributes.length, 3);

      merchantAModelId = data.id;
      createdModelIds.push(merchantAModelId);
    });

    it('GET /api/models/:id should return the model with its attributes for the owner', async () => {
      const res = await fetch(`${baseUrl}/${merchantAModelId}`, {
        headers: {
          'x-api-key': validApiKey,
          'x-merchant-id': merchantA
        }
      });

      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.id, merchantAModelId);
      assert.strictEqual(data.attributes.length, 3);
      assert.ok(data.attributes.some((a) => a.name === 'barcode' && a.is_required === true));
    });

    it('GET /api/models/:id should reject cross-tenant access with 403 Forbidden', async () => {
      // Merchant B tries to read Merchant A's model
      const res = await fetch(`${baseUrl}/${merchantAModelId}`, {
        headers: {
          'x-api-key': validApiKey,
          'x-merchant-id': merchantB
        }
      });

      assert.strictEqual(res.status, 403);
      const data = await res.json();
      assert.ok(data.error.includes('Forbidden') || data.error.includes('other merchants'));
    });

    it('PUT /api/models/:id should update model details and replace attributes', async () => {
      const res = await fetch(`${baseUrl}/${merchantAModelId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': validApiKey,
          'x-merchant-id': merchantA
        },
        body: JSON.stringify({
          name: 'Merchant A Catalog Model (Updated)',
          attributes: [
            { name: 'barcode', data_type: 'string', is_required: true },
            { name: 'dimensions', data_type: 'string', is_required: false }
          ]
        })
      });

      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.name, 'Merchant A Catalog Model (Updated)');
      assert.strictEqual(data.attributes.length, 2);
      assert.ok(data.attributes.some((a) => a.name === 'dimensions'));
      assert.ok(!data.attributes.some((a) => a.name === 'weight'));
    });

    it('PUT /api/models/:id should reject cross-tenant updates with 403 Forbidden', async () => {
      // Merchant B attempts to update Merchant A's model
      const res = await fetch(`${baseUrl}/${merchantAModelId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': validApiKey,
          'x-merchant-id': merchantB
        },
        body: JSON.stringify({ name: 'Hacked Model' })
      });

      assert.strictEqual(res.status, 403);
    });

    it('DELETE /api/models/:id should soft-delete the model (status = ARCHIVED)', async () => {
      const res = await fetch(`${baseUrl}/${merchantAModelId}`, {
        method: 'DELETE',
        headers: {
          'x-api-key': validApiKey,
          'x-merchant-id': merchantA
        }
      });

      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.status, 'ARCHIVED');

      // Verify directly in DB that record is NOT physically deleted, but marked ARCHIVED
      const dbCheck = await pool.query('SELECT status, updated_at FROM product_models WHERE id = $1', [merchantAModelId]);
      assert.strictEqual(dbCheck.rows[0].status, 'ARCHIVED');
      assert.ok(dbCheck.rows[0].updated_at);
    });

    it('Subsequent GET, PUT, and DELETE on ARCHIVED model should return 404 Not Found', async () => {
      const getRes = await fetch(`${baseUrl}/${merchantAModelId}`, {
        headers: { 'x-api-key': validApiKey, 'x-merchant-id': merchantA }
      });
      assert.strictEqual(getRes.status, 404);

      const putRes = await fetch(`${baseUrl}/${merchantAModelId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': validApiKey,
          'x-merchant-id': merchantA
        },
        body: JSON.stringify({ name: 'Revive attempt' })
      });
      assert.strictEqual(putRes.status, 404);

      const delRes = await fetch(`${baseUrl}/${merchantAModelId}`, {
        method: 'DELETE',
        headers: { 'x-api-key': validApiKey, 'x-merchant-id': merchantA }
      });
      assert.strictEqual(delRes.status, 404);
    });
  });

  describe('4. Read-Only Protection on Global Templates (Acceptance Criteria 3)', () => {
    it('PUT /api/models/:id on global template should reject with 403 Forbidden', async () => {
      const res = await fetch(`${baseUrl}/${globalTemplateId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': validApiKey,
          'x-merchant-id': merchantA
        },
        body: JSON.stringify({ name: 'Tampered Template Name' })
      });

      assert.strictEqual(res.status, 403);
      const data = await res.json();
      assert.ok(data.error.includes('Global templates are read-only'));

      // Verify DB template name was NOT altered
      const dbCheck = await pool.query('SELECT name FROM product_models WHERE id = $1', [globalTemplateId]);
      assert.strictEqual(dbCheck.rows[0].name, 'Standard Apparel Template');
    });

    it('DELETE /api/models/:id on global template should reject with 403 Forbidden', async () => {
      const res = await fetch(`${baseUrl}/${globalTemplateId}`, {
        method: 'DELETE',
        headers: {
          'x-api-key': validApiKey,
          'x-merchant-id': merchantA
        }
      });

      assert.strictEqual(res.status, 403);
      const data = await res.json();
      assert.ok(data.error.includes('Global templates are read-only'));

      // Verify DB template was NOT archived
      const dbCheck = await pool.query('SELECT status FROM product_models WHERE id = $1', [globalTemplateId]);
      assert.strictEqual(dbCheck.rows[0].status, 'ACTIVE');
    });
  });

  describe('5. Template Cloning without Cascading Mutations (Acceptance Criteria 2)', () => {
    let clonedModelId;

    it('POST /api/models/:templateId/clone should deep-copy global template to requester tenant', async () => {
      const res = await fetch(`${baseUrl}/${globalTemplateId}/clone`, {
        method: 'POST',
        headers: {
          'x-api-key': validApiKey,
          'x-merchant-id': merchantA
        }
      });

      assert.strictEqual(res.status, 201);
      const data = await res.json();
      assert.ok(data.id);
      assert.notStrictEqual(data.id, globalTemplateId);
      assert.strictEqual(data.merchant_id, merchantA);
      assert.strictEqual(data.name, 'Standard Apparel Template (Clone)');
      assert.strictEqual(data.description, 'Base industry template for clothing');
      assert.strictEqual(data.schema_version, 1);
      assert.strictEqual(data.status, 'ACTIVE');

      // Verify deep copy of attributes
      assert.strictEqual(data.attributes.length, 3);
      const sizeAttr = data.attributes.find((a) => a.name === 'size');
      assert.ok(sizeAttr);
      assert.strictEqual(sizeAttr.data_type, 'enum');
      assert.strictEqual(sizeAttr.is_required, true);
      assert.deepStrictEqual(sizeAttr.list_of_values, ['XS', 'S', 'M', 'L', 'XL']);

      clonedModelId = data.id;
      createdModelIds.push(clonedModelId);
    });

    it('Mutations on cloned model must NOT cascade to the parent template', async () => {
      // Merchant A modifies their cloned model
      const updateRes = await fetch(`${baseUrl}/${clonedModelId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': validApiKey,
          'x-merchant-id': merchantA
        },
        body: JSON.stringify({
          name: 'My Custom Apparel Model',
          attributes: [
            { name: 'custom_sku', data_type: 'string', is_required: true },
            { name: 'size', data_type: 'enum', is_required: true, list_of_values: ['S', 'M', 'L'] }
          ]
        })
      });

      assert.strictEqual(updateRes.status, 200);

      // Verify the parent template attributes remain completely untouched
      const parentAttrs = await pool.query(
        'SELECT name, list_of_values FROM product_model_attributes WHERE model_id = $1 ORDER BY name ASC',
        [globalTemplateId]
      );
      assert.strictEqual(parentAttrs.rows.length, 3);
      const parentSize = parentAttrs.rows.find((a) => a.name === 'size');
      assert.deepStrictEqual(parentSize.list_of_values, ['XS', 'S', 'M', 'L', 'XL']);

      // Verify parent model name was not changed
      const parentModel = await pool.query('SELECT name FROM product_models WHERE id = $1', [globalTemplateId]);
      assert.strictEqual(parentModel.rows[0].name, 'Standard Apparel Template');
    });

    it('POST /api/models/:templateId/clone should reject cloning another merchant private model with 403', async () => {
      // Merchant B attempts to clone Merchant A's cloned model
      const res = await fetch(`${baseUrl}/${clonedModelId}/clone`, {
        method: 'POST',
        headers: {
          'x-api-key': validApiKey,
          'x-merchant-id': merchantB
        }
      });

      assert.strictEqual(res.status, 403);
    });

    it('POST /api/models/:templateId/clone on archived template should return 404', async () => {
      // Create and archive a model
      const tempRes = await pool.query(
        `INSERT INTO product_models (merchant_id, name, status, created_by, updated_by)
         VALUES ($1, 'Archived Model', 'ARCHIVED', 'tester', 'tester')
         RETURNING id`,
        [merchantA]
      );
      const archivedId = tempRes.rows[0].id;
      createdModelIds.push(archivedId);

      const res = await fetch(`${baseUrl}/${archivedId}/clone`, {
        method: 'POST',
        headers: {
          'x-api-key': validApiKey,
          'x-merchant-id': merchantA
        }
      });

      assert.strictEqual(res.status, 404);
    });
  });

  describe('6. Listing Models (GET /api/models)', () => {
    it('should list global templates and models owned by the requesting merchant', async () => {
      const res = await fetch(baseUrl, {
        headers: {
          'x-api-key': validApiKey,
          'x-merchant-id': merchantA
        }
      });

      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.ok(Array.isArray(data.models));

      // Must include the active global template
      assert.ok(data.models.some((m) => m.id === globalTemplateId));

      // Must NOT include archived models
      assert.ok(!data.models.some((m) => m.id === merchantAModelId));
    });
  });

  describe('7. Schema Versioning & Lineage Retrieval (User Story B2.3)', () => {
    let versionTestModelId;
    let testAttrId;

    it('Scenario 1: Version increment on schema updates (POST, PUT, DELETE attribute)', async () => {
      // 1. Create a model for Merchant A (starts at schema_version = 1 with initial attribute)
      const createRes = await fetch(baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': validApiKey,
          'x-merchant-id': merchantA
        },
        body: JSON.stringify({
          name: 'Versioning Precision Model',
          description: 'Model for testing schema version increments and historical snapshots',
          attributes: [
            { name: 'Initial Code', key: 'initial_code', data_type: 'string', is_required: true }
          ]
        })
      });

      assert.strictEqual(createRes.status, 201);
      const modelData = await createRes.json();
      versionTestModelId = modelData.id;
      createdModelIds.push(versionTestModelId);
      assert.strictEqual(modelData.schema_version, 1);
      assert.strictEqual(modelData.attributes.length, 1);

      // 2. Add an attribute (schema_version should increment from 1 to 2)
      const addAttrRes = await fetch(`${baseUrl}/${versionTestModelId}/attributes`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': validApiKey,
          'x-merchant-id': merchantA
        },
        body: JSON.stringify({
          name: 'Batch Number',
          key: 'batch_number',
          data_type: 'integer',
          is_required: false
        })
      });
      assert.strictEqual(addAttrRes.status, 201);
      const addedAttr = await addAttrRes.json();
      testAttrId = addedAttr.id;

      // Check model schema_version is now 2
      const modelV2Res = await fetch(`${baseUrl}/${versionTestModelId}`, {
        headers: {
          'x-api-key': validApiKey,
          'x-merchant-id': merchantA
        }
      });
      assert.strictEqual(modelV2Res.status, 200);
      const modelV2 = await modelV2Res.json();
      assert.strictEqual(modelV2.schema_version, 2);
      assert.strictEqual(modelV2.attributes.length, 2);

      // 3. Update an attribute (schema_version should increment from 2 to 3)
      const updateAttrRes = await fetch(`${baseUrl}/${versionTestModelId}/attributes/${testAttrId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': validApiKey,
          'x-merchant-id': merchantA
        },
        body: JSON.stringify({
          name: 'Batch Number Updated',
          is_required: true
        })
      });
      assert.strictEqual(updateAttrRes.status, 200);

      const modelV3Res = await fetch(`${baseUrl}/${versionTestModelId}`, {
        headers: {
          'x-api-key': validApiKey,
          'x-merchant-id': merchantA
        }
      });
      const modelV3 = await modelV3Res.json();
      assert.strictEqual(modelV3.schema_version, 3);

      // 4. Delete an attribute (schema_version should increment from 3 to 4)
      const deleteAttrRes = await fetch(`${baseUrl}/${versionTestModelId}/attributes/${testAttrId}`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': validApiKey,
          'x-merchant-id': merchantA
        },
        body: JSON.stringify({
          id: testAttrId
        })
      });
      assert.strictEqual(deleteAttrRes.status, 200);

      const modelV4Res = await fetch(`${baseUrl}/${versionTestModelId}`, {
        headers: {
          'x-api-key': validApiKey,
          'x-merchant-id': merchantA
        }
      });
      const modelV4 = await modelV4Res.json();
      assert.strictEqual(modelV4.schema_version, 4);
      assert.strictEqual(modelV4.attributes.length, 1);
    });

    it('Scenario 2: Querying historical versions with GET /api/models/:id?version=:version', async () => {
      // Query version 1: should have exactly 1 attribute ('initial_code') and schema_version = 1
      const v1Res = await fetch(`${baseUrl}/${versionTestModelId}?version=1`, {
        headers: {
          'x-api-key': validApiKey,
          'x-merchant-id': merchantA
        }
      });
      assert.strictEqual(v1Res.status, 200);
      const v1Data = await v1Res.json();
      assert.strictEqual(v1Data.schema_version, 1);
      assert.strictEqual(v1Data.attributes.length, 1);
      assert.strictEqual(v1Data.attributes[0].key, 'initial_code');

      // Query version 2: should have 2 attributes (initial_code, batch_number) and schema_version = 2
      const v2Res = await fetch(`${baseUrl}/${versionTestModelId}?version=2`, {
        headers: {
          'x-api-key': validApiKey,
          'x-merchant-id': merchantA
        }
      });
      assert.strictEqual(v2Res.status, 200);
      const v2Data = await v2Res.json();
      assert.strictEqual(v2Data.schema_version, 2);
      assert.strictEqual(v2Data.attributes.length, 2);

      // Query without ?version: should default to latest active version (4)
      const activeRes = await fetch(`${baseUrl}/${versionTestModelId}`, {
        headers: {
          'x-api-key': validApiKey,
          'x-merchant-id': merchantA
        }
      });
      assert.strictEqual(activeRes.status, 200);
      const activeData = await activeRes.json();
      assert.strictEqual(activeData.schema_version, 4);
    });

    it('Scenario 2: should return 404 when querying a non-existent version', async () => {
      const res = await fetch(`${baseUrl}/${versionTestModelId}?version=999`, {
        headers: {
          'x-api-key': validApiKey,
          'x-merchant-id': merchantA
        }
      });
      assert.strictEqual(res.status, 404);
    });

    it('Scenario 2: should return 400 when version query parameter is malformed', async () => {
      const res = await fetch(`${baseUrl}/${versionTestModelId}?version=invalid`, {
        headers: {
          'x-api-key': validApiKey,
          'x-merchant-id': merchantA
        }
      });
      assert.strictEqual(res.status, 400);
    });

    it('Scenario 3: Merchant B attempting to query Merchant A historical version should be rejected with 403 Forbidden', async () => {
      const res = await fetch(`${baseUrl}/${versionTestModelId}?version=1`, {
        headers: {
          'x-api-key': validApiKey,
          'x-merchant-id': merchantB
        }
      });
      assert.strictEqual(res.status, 403);
    });

    it('Regression: should capture exact pre-mutation baseline for pre-versioned/seeded models without initial product_model_versions row', async () => {
      // Seed a model and attributes directly into DB without an initial product_model_versions row
      const seededModelRes = await pool.query(
        `INSERT INTO product_models (merchant_id, name, description, status, schema_version, created_by, updated_by)
         VALUES ($1, 'Pre-versioned Seeded Model', 'Seeded directly in DB without versions row', 'ACTIVE', 1, 'seeder', 'seeder')
         RETURNING id`,
        [merchantA]
      );
      const seededModelId = seededModelRes.rows[0].id;
      createdModelIds.push(seededModelId);

      const seededAttrRes = await pool.query(
        `INSERT INTO product_model_attributes (model_id, name, key, data_type, is_required, unit_type, list_of_values, allowed_values)
         VALUES ($1, 'Initial Code', 'initial_code', 'string', false, NULL, '[]'::jsonb, '[]'::jsonb)
         RETURNING id`,
        [seededModelId]
      );
      const seededAttrId = seededAttrRes.rows[0].id;

      // Verify no rows exist in product_model_versions
      const preCheck = await pool.query(
        'SELECT * FROM product_model_versions WHERE model_id = $1',
        [seededModelId]
      );
      assert.strictEqual(preCheck.rows.length, 0);

      // Perform an attribute update
      const updateRes = await fetch(`${baseUrl}/${seededModelId}/attributes/${seededAttrId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': validApiKey,
          'x-merchant-id': merchantA
        },
        body: JSON.stringify({
          name: 'Modified Initial Code',
          is_required: true
        })
      });
      assert.strictEqual(updateRes.status, 200);

      // Query version 1: must return EXACT pre-mutation state (Initial Code, is_required: false)
      const v1Res = await fetch(`${baseUrl}/${seededModelId}?version=1`, {
        headers: {
          'x-api-key': validApiKey,
          'x-merchant-id': merchantA
        }
      });
      assert.strictEqual(v1Res.status, 200);
      const v1Data = await v1Res.json();
      assert.strictEqual(v1Data.schema_version, 1);
      assert.strictEqual(v1Data.attributes.length, 1);
      assert.strictEqual(v1Data.attributes[0].name, 'Initial Code');
      assert.strictEqual(v1Data.attributes[0].is_required, false);

      // Query version 2: must return the updated state (Modified Initial Code, is_required: true)
      const v2Res = await fetch(`${baseUrl}/${seededModelId}?version=2`, {
        headers: {
          'x-api-key': validApiKey,
          'x-merchant-id': merchantA
        }
      });
      assert.strictEqual(v2Res.status, 200);
      const v2Data = await v2Res.json();
      assert.strictEqual(v2Data.schema_version, 2);
      assert.strictEqual(v2Data.attributes.length, 1);
      assert.strictEqual(v2Data.attributes[0].name, 'Modified Initial Code');
      assert.strictEqual(v2Data.attributes[0].is_required, true);
    });

    it('Regression: updating an attribute on a legacy model with populated list_of_values and empty allowed_values preserves the array of strings', async () => {
      // Seed a legacy model and attribute with populated list_of_values and empty allowed_values
      const legacyModelRes = await pool.query(
        `INSERT INTO product_models (merchant_id, name, description, status, schema_version, created_by, updated_by)
         VALUES ($1, 'Legacy Attribute Model', 'Seeded legacy model with list_of_values', 'ACTIVE', 1, 'seeder', 'seeder')
         RETURNING id`,
        [merchantA]
      );
      const legacyModelId = legacyModelRes.rows[0].id;
      createdModelIds.push(legacyModelId);

      const legacyAttrRes = await pool.query(
        `INSERT INTO product_model_attributes (model_id, name, key, data_type, is_required, unit_type, list_of_values, allowed_values)
         VALUES ($1, 'Size Options', 'size_options', 'list_of_values', false, NULL, '["S", "M", "L", "XL"]'::jsonb, '[]'::jsonb)
         RETURNING id`,
        [legacyModelId]
      );
      const legacyAttrId = legacyAttrRes.rows[0].id;

      // Update the attribute without passing allowed_values (e.g. updating is_required)
      const updateRes = await fetch(`${baseUrl}/${legacyModelId}/attributes/${legacyAttrId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': validApiKey,
          'x-merchant-id': merchantA
        },
        body: JSON.stringify({
          is_required: true
        })
      });
      assert.strictEqual(updateRes.status, 200);
      const updatedData = await updateRes.json();

      // Ensure allowed_values and list_of_values preserved the array of strings and did not wipe it to []
      assert.strictEqual(updatedData.is_required, true);
      assert.deepStrictEqual(updatedData.allowed_values, ['S', 'M', 'L', 'XL']);
      assert.deepStrictEqual(updatedData.list_of_values, ['S', 'M', 'L', 'XL']);

      // Also verify via GET /api/models/:id that persisted attribute retained allowed_values
      const getModelRes = await fetch(`${baseUrl}/${legacyModelId}`, {
        headers: {
          'x-api-key': validApiKey,
          'x-merchant-id': merchantA
        }
      });
      assert.strictEqual(getModelRes.status, 200);
      const modelData = await getModelRes.json();
      const attr = modelData.attributes.find((a) => a.id === legacyAttrId);
      assert.ok(attr);
      assert.deepStrictEqual(attr.allowed_values, ['S', 'M', 'L', 'XL']);
      assert.deepStrictEqual(attr.list_of_values, ['S', 'M', 'L', 'XL']);
    });
  });
});
