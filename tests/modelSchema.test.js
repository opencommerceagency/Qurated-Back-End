import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import express from 'express';
import { pool } from '../src/db/index.js';
import modelRouter from '../src/routes/models.js';
import {
  attributeSchema,
  updateAttributeSchema,
  KEY_REGEX,
  slugifyKey
} from '../src/schemas/modelSchema.js';

process.env.API_KEY = process.env.API_KEY || 'qurated_dev_api_key_2026';
process.env.API_AUTH_USER = process.env.API_AUTH_USER || 'admin';
process.env.API_AUTH_PASS = process.env.API_AUTH_PASS || 'qurated_dev_password';

describe('User Story B2.2: Attribute Schema & Strict Type Validation', () => {
  describe('Unit Tests: Zod Attribute Schema & Constraints (Task 2 & 5)', () => {
    describe('key regex validation (^[a-z0-9_]+$)', () => {
      it('should validate valid slugified keys with regex ^[a-z0-9_]+$', () => {
        assert.ok(KEY_REGEX.test('sku'));
        assert.ok(KEY_REGEX.test('package_weight'));
        assert.ok(KEY_REGEX.test('custom_field_123'));
        assert.ok(KEY_REGEX.test('color_finish_code'));
      });

      it('should reject invalid keys with uppercase, dashes, spaces, or symbols', () => {
        assert.strictEqual(KEY_REGEX.test('SKU'), false);
        assert.strictEqual(KEY_REGEX.test('package-weight'), false);
        assert.strictEqual(KEY_REGEX.test('custom field'), false);
        assert.strictEqual(KEY_REGEX.test('finish@special'), false);
        assert.strictEqual(KEY_REGEX.test(''), false);
      });

      it('should accept attributeSchema with a valid key', () => {
        const result = attributeSchema.safeParse({
          name: 'Package Weight',
          key: 'package_weight',
          data_type: 'integer',
          unit_type: 'kg'
        });
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.data.key, 'package_weight');
        assert.strictEqual(result.data.data_type, 'integer');
        assert.strictEqual(result.data.unit_type, 'kg');
      });

      it('should reject attributeSchema with an invalid key', () => {
        const result = attributeSchema.safeParse({
          name: 'Package Weight',
          key: 'Package-Weight!',
          data_type: 'integer'
        });
        assert.strictEqual(result.success, false);
        assert.ok(result.error.issues.some((i) => i.path.includes('key')));
      });

      it('should auto-slugify key when key is omitted but name is provided', () => {
        const result = attributeSchema.safeParse({
          name: 'Package Weight (Gross kg)',
          data_type: 'integer'
        });
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.data.key, 'package_weight_gross_kg');
      });

      it('slugifyKey utility should format strings into valid lowercase underscore slugs', () => {
        assert.strictEqual(slugifyKey('Product SKU #1'), 'product_sku_1');
        assert.strictEqual(slugifyKey('  Multiple   Spaces  '), 'multiple_spaces');
        assert.strictEqual(slugifyKey('Special & Characters!'), 'special_characters');
      });
    });

    describe('data_type validation & conditional list_of_values refinement (Scenario 1 & 2)', () => {
      it('Scenario 1: should accept valid data_types: string, integer, boolean, list_of_values', () => {
        for (const type of ['string', 'integer', 'boolean']) {
          const res = attributeSchema.safeParse({
            name: `Test ${type}`,
            key: `test_${type}`,
            data_type: type
          });
          assert.strictEqual(res.success, true);
          assert.strictEqual(res.data.data_type, type);
        }
      });

      it('should reject unsupported data_types', () => {
        const res = attributeSchema.safeParse({
          name: 'Unknown',
          key: 'unknown',
          data_type: 'floating_point'
        });
        assert.strictEqual(res.success, false);
      });

      it('Scenario 2: should reject list_of_values if allowed_values is missing', () => {
        const res = attributeSchema.safeParse({
          name: 'Color Finish',
          key: 'color_finish',
          data_type: 'list_of_values'
        });
        assert.strictEqual(res.success, false);
        assert.ok(res.error.issues.some((i) => i.path.includes('allowed_values')));
      });

      it('Scenario 2: should reject list_of_values if allowed_values is an empty array', () => {
        const res = attributeSchema.safeParse({
          name: 'Color Finish',
          key: 'color_finish',
          data_type: 'list_of_values',
          allowed_values: []
        });
        assert.strictEqual(res.success, false);
        assert.ok(res.error.issues.some((i) => i.path.includes('allowed_values')));
      });

      it('Scenario 1 & 2: should accept list_of_values with non-empty array of strings', () => {
        const res = attributeSchema.safeParse({
          name: 'Color Finish',
          key: 'color_finish',
          data_type: 'list_of_values',
          allowed_values: ['MATTE', 'GLOSS', 'SATIN']
        });
        assert.strictEqual(res.success, true);
        assert.deepStrictEqual(res.data.allowed_values, ['MATTE', 'GLOSS', 'SATIN']);
      });

      it('Scenario 1: should validate unit_type optionally and default is_required to false', () => {
        const res = attributeSchema.safeParse({
          name: 'Length',
          key: 'length',
          data_type: 'integer',
          unit_type: 'mm'
        });
        assert.strictEqual(res.success, true);
        assert.strictEqual(res.data.is_required, false);
        assert.strictEqual(res.data.unit_type, 'mm');
      });
    });

    describe('updateAttributeSchema validation', () => {
      it('should allow partial updates to attributes', () => {
        const res = updateAttributeSchema.safeParse({
          unit_type: 'cm',
          is_required: true
        });
        assert.strictEqual(res.success, true);
        assert.strictEqual(res.data.unit_type, 'cm');
        assert.strictEqual(res.data.is_required, true);
      });

      it('should reject update if data_type is updated to list_of_values with empty allowed_values', () => {
        const res = updateAttributeSchema.safeParse({
          data_type: 'list_of_values',
          allowed_values: []
        });
        assert.strictEqual(res.success, false);
      });
    });
  });

  describe('Integration Tests: Attribute Endpoints & Tenant Isolation (Tasks 4 & 5)', () => {
    let app;
    let server;
    let baseUrl;

    const merchantA = '33333333-3333-3333-3333-333333333333';
    const merchantB = '44444444-4444-4444-4444-444444444444';
    const validApiKey = 'qurated_dev_api_key_2026';

    let merchantAModelId;
    let merchantBModelId;
    let globalTemplateId;
    let createdAttributeId;
    const cleanupModelIds = [];

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

      // Seed a model for Merchant A
      const modelResA = await pool.query(
        `INSERT INTO product_models (merchant_id, name, description, status, schema_version, created_by, updated_by)
         VALUES ($1, 'Merchant A Precision Parts', 'Precision hardware schema', 'ACTIVE', 1, 'merchant_a_user', 'merchant_a_user')
         RETURNING id`,
        [merchantA]
      );
      merchantAModelId = modelResA.rows[0].id;
      cleanupModelIds.push(merchantAModelId);

      // Seed a model for Merchant B
      const modelResB = await pool.query(
        `INSERT INTO product_models (merchant_id, name, description, status, schema_version, created_by, updated_by)
         VALUES ($1, 'Merchant B Catalog Model', 'Catalog schema for Merchant B', 'ACTIVE', 1, 'merchant_b_user', 'merchant_b_user')
         RETURNING id`,
        [merchantB]
      );
      merchantBModelId = modelResB.rows[0].id;
      cleanupModelIds.push(merchantBModelId);

      // Seed a global shared template (merchant_id: null)
      const tplRes = await pool.query(
        `INSERT INTO product_models (merchant_id, name, description, status, schema_version, created_by, updated_by)
         VALUES (NULL, 'Global Hardware Template', 'Base shared hardware template', 'ACTIVE', 1, 'system_admin', 'system_admin')
         RETURNING id`
      );
      globalTemplateId = tplRes.rows[0].id;
      cleanupModelIds.push(globalTemplateId);
    });

    after(async () => {
      for (const modelId of cleanupModelIds) {
        await pool.query('DELETE FROM product_models WHERE id = $1', [modelId]);
      }
      if (server) {
        await new Promise((resolve) => server.close(resolve));
      }
    });

    describe('Scenario 1: POST /api/models/:id/attributes', () => {
      it('Scenario 1: Merchant A should create an attribute on their model with valid type and flags', async () => {
        const res = await fetch(`${baseUrl}/${merchantAModelId}/attributes`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': validApiKey,
            'x-merchant-id': merchantA
          },
          body: JSON.stringify({
            name: 'Thread Size',
            key: 'thread_size',
            data_type: 'string',
            unit_type: 'metric',
            is_required: true
          })
        });

        assert.strictEqual(res.status, 201);
        const data = await res.json();
        assert.ok(data.id);
        assert.strictEqual(data.model_id, merchantAModelId);
        assert.strictEqual(data.name, 'Thread Size');
        assert.strictEqual(data.key, 'thread_size');
        assert.strictEqual(data.data_type, 'string');
        assert.strictEqual(data.unit_type, 'metric');
        assert.strictEqual(data.is_required, true);

        createdAttributeId = data.id;
      });

      it('Scenario 1 & 2: should create a list_of_values attribute with valid allowed_values', async () => {
        const res = await fetch(`${baseUrl}/${merchantAModelId}/attributes`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': validApiKey,
            'x-merchant-id': merchantA
          },
          body: JSON.stringify({
            name: 'Material Grade',
            key: 'material_grade',
            data_type: 'list_of_values',
            allowed_values: ['GRADE_304', 'GRADE_316', 'GRADE_410']
          })
        });

        assert.strictEqual(res.status, 201);
        const data = await res.json();
        assert.strictEqual(data.data_type, 'list_of_values');
        assert.deepStrictEqual(data.allowed_values, ['GRADE_304', 'GRADE_316', 'GRADE_410']);
      });

      it('Scenario 2: should reject list_of_values attribute with 400 when allowed_values is missing or empty', async () => {
        const res = await fetch(`${baseUrl}/${merchantAModelId}/attributes`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': validApiKey,
            'x-merchant-id': merchantA
          },
          body: JSON.stringify({
            name: 'Coating',
            key: 'coating',
            data_type: 'list_of_values',
            allowed_values: []
          })
        });

        assert.strictEqual(res.status, 400);
        const data = await res.json();
        assert.ok(data.error.includes('allowed_values'));
      });

      it('should reject invalid key with 400 Bad Request', async () => {
        const res = await fetch(`${baseUrl}/${merchantAModelId}/attributes`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': validApiKey,
            'x-merchant-id': merchantA
          },
          body: JSON.stringify({
            name: 'Invalid Key Attr',
            key: 'Invalid Key With Spaces!',
            data_type: 'string'
          })
        });

        assert.strictEqual(res.status, 400);
      });

      it('Scenario 3: Merchant B attempting to add attribute to Merchant A model should return 404 Not Found', async () => {
        const res = await fetch(`${baseUrl}/${merchantAModelId}/attributes`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': validApiKey,
            'x-merchant-id': merchantB
          },
          body: JSON.stringify({
            name: 'Hacked Attribute',
            key: 'hacked_attr',
            data_type: 'string'
          })
        });

        assert.strictEqual(res.status, 404);
      });

      it('attempting to add attribute to a global template should be rejected with 403 Forbidden', async () => {
        const res = await fetch(`${baseUrl}/${globalTemplateId}/attributes`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': validApiKey,
            'x-merchant-id': merchantA
          },
          body: JSON.stringify({
            name: 'Template Mutate Attr',
            key: 'tpl_attr',
            data_type: 'string'
          })
        });

        assert.strictEqual(res.status, 403);
      });

      it('adding attribute to non-existent model ID should return 404', async () => {
        const nonExistent = '00000000-0000-0000-0000-000000000000';
        const res = await fetch(`${baseUrl}/${nonExistent}/attributes`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': validApiKey,
            'x-merchant-id': merchantA
          },
          body: JSON.stringify({
            name: 'Orphan Attr',
            key: 'orphan_attr',
            data_type: 'string'
          })
        });

        assert.strictEqual(res.status, 404);
      });
    });

    describe('Scenario 3: GET /api/models/:id/attributes (Cross-Tenant Isolation)', () => {
      it('Merchant A should fetch their model attributes', async () => {
        const res = await fetch(`${baseUrl}/${merchantAModelId}/attributes`, {
          method: 'GET',
          headers: {
            'x-api-key': validApiKey,
            'x-merchant-id': merchantA
          }
        });

        assert.strictEqual(res.status, 200);
        const data = await res.json();
        assert.ok(Array.isArray(data.attributes));
        assert.ok(data.attributes.length >= 1);
      });

      it('Scenario 3: Merchant B attempting to fetch Merchant A model attributes should return 404 Not Found', async () => {
        const res = await fetch(`${baseUrl}/${merchantAModelId}/attributes`, {
          method: 'GET',
          headers: {
            'x-api-key': validApiKey,
            'x-merchant-id': merchantB
          }
        });

        assert.strictEqual(res.status, 404);
      });

      it('any merchant should be able to read shared template attributes', async () => {
        const res = await fetch(`${baseUrl}/${globalTemplateId}/attributes`, {
          method: 'GET',
          headers: {
            'x-api-key': validApiKey,
            'x-merchant-id': merchantB
          }
        });

        assert.strictEqual(res.status, 200);
      });
    });

    describe('Scenario 3: PUT /api/models/:id/attributes/:attributeId (Cross-Tenant Isolation)', () => {
      it('Merchant A should update an existing attribute', async () => {
        const res = await fetch(`${baseUrl}/${merchantAModelId}/attributes/${createdAttributeId}`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': validApiKey,
            'x-merchant-id': merchantA
          },
          body: JSON.stringify({
            name: 'Thread Size (Metric)',
            unit_type: 'mm',
            is_required: false
          })
        });

        assert.strictEqual(res.status, 200);
        const data = await res.json();
        assert.strictEqual(data.name, 'Thread Size (Metric)');
        assert.strictEqual(data.unit_type, 'mm');
        assert.strictEqual(data.is_required, false);
      });

      it('Scenario 3: Merchant B attempting to modify Merchant A attribute directly should return 404 Not Found', async () => {
        const res = await fetch(`${baseUrl}/${merchantAModelId}/attributes/${createdAttributeId}`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': validApiKey,
            'x-merchant-id': merchantB
          },
          body: JSON.stringify({
            name: 'Cross-Tenant Tamper'
          })
        });

        assert.strictEqual(res.status, 404);
      });

      it('Scenario 3: Merchant B attempting to modify Merchant A attribute via Merchant B model should return 404 Not Found', async () => {
        const res = await fetch(`${baseUrl}/${merchantBModelId}/attributes/${createdAttributeId}`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': validApiKey,
            'x-merchant-id': merchantB
          },
          body: JSON.stringify({
            name: 'Cross-Tenant Tamper via Owned Model'
          })
        });

        assert.strictEqual(res.status, 404);
      });

      it('attempting to update attribute with non-existent attribute ID should return 404', async () => {
        const nonExistentAttr = '00000000-0000-0000-0000-000000000000';
        const res = await fetch(`${baseUrl}/${merchantAModelId}/attributes/${nonExistentAttr}`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': validApiKey,
            'x-merchant-id': merchantA
          },
          body: JSON.stringify({
            name: 'Does Not Exist'
          })
        });

        assert.strictEqual(res.status, 404);
      });
    });

    describe('Scenario 3: DELETE /api/models/:id/attributes/:attributeId (Cross-Tenant Isolation)', () => {
      it('Scenario 3: Merchant B attempting to delete Merchant A attribute directly should return 404 Not Found', async () => {
        const res = await fetch(`${baseUrl}/${merchantAModelId}/attributes/${createdAttributeId}`, {
          method: 'DELETE',
          headers: {
            'x-api-key': validApiKey,
            'x-merchant-id': merchantB
          }
        });

        assert.strictEqual(res.status, 404);
      });

      it('Scenario 3: Merchant B attempting to delete Merchant A attribute via Merchant B model should return 404 Not Found', async () => {
        const res = await fetch(`${baseUrl}/${merchantBModelId}/attributes/${createdAttributeId}`, {
          method: 'DELETE',
          headers: {
            'x-api-key': validApiKey,
            'x-merchant-id': merchantB
          }
        });

        assert.strictEqual(res.status, 404);
      });

      it('Merchant A should delete their attribute', async () => {
        const res = await fetch(`${baseUrl}/${merchantAModelId}/attributes/${createdAttributeId}`, {
          method: 'DELETE',
          headers: {
            'x-api-key': validApiKey,
            'x-merchant-id': merchantA
          }
        });

        assert.strictEqual(res.status, 200);
        const data = await res.json();
        assert.strictEqual(data.message, 'Attribute deleted successfully');
        assert.strictEqual(data.id, createdAttributeId);

        // Verify it was actually removed
        const check = await pool.query('SELECT * FROM product_model_attributes WHERE id = $1', [createdAttributeId]);
        assert.strictEqual(check.rows.length, 0);
      });

      it('deleting an already deleted attribute should return 404', async () => {
        const res = await fetch(`${baseUrl}/${merchantAModelId}/attributes/${createdAttributeId}`, {
          method: 'DELETE',
          headers: {
            'x-api-key': validApiKey,
            'x-merchant-id': merchantA
          }
        });

        assert.strictEqual(res.status, 404);
      });
    });
  });
});
