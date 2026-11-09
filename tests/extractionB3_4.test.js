import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import express from 'express';
import { pool } from '../src/db/index.js';
import productsRouter from '../src/routes/products.js';
import { enqueueJob } from '../src/services/queueService.js';
import { ingestExtractedProduct } from '../src/workers/extractionWorker.js';

process.env.API_KEY = process.env.API_KEY || 'qurated_dev_api_key_2026';
process.env.API_AUTH_USER = process.env.API_AUTH_USER || 'admin';
process.env.API_AUTH_PASS = process.env.API_AUTH_PASS || 'qurated_dev_password';

describe('User Story B3.4: Manual Enrichment & Gap Resolution', () => {
  const merchantA = '77777777-7777-7777-7777-777777777777';
  const merchantB = '88888888-8888-8888-8888-888888888888';
  const validApiKey = 'qurated_dev_api_key_2026';

  let app;
  let server;
  let baseUrl;

  let modelAId;
  let modelVersionAId;
  let fileAId;
  let jobAId;
  let schemaSnapshot;

  const createdModelIds = [];
  const createdJobIds = [];
  const createdFileIds = [];
  const createdProductIds = [];

  before(async () => {
    // 1. Setup Express server for API integration tests
    app = express();
    app.use(express.json());
    app.use('/api/products', productsRouter);

    await new Promise((resolve) => {
      server = app.listen(0, () => {
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}/api/products`;
        resolve();
      });
    });

    // 2. Seed model for Merchant A
    const modelRes = await pool.query(
      `INSERT INTO product_models (merchant_id, name, description, status, schema_version, created_by, updated_by)
       VALUES ($1, 'B3.4 Catalog Model', 'Schema for B3.4 review and override testing', 'ACTIVE', 1, 'admin', 'admin')
       RETURNING id`,
      [merchantA]
    );
    modelAId = modelRes.rows[0].id;
    createdModelIds.push(modelAId);

    schemaSnapshot = {
      name: 'B3.4 Catalog Model',
      schema_version: 1,
      attributes: [
        {
          name: 'Material',
          key: 'material',
          data_type: 'string',
          is_required: true
        },
        {
          name: 'Weight',
          key: 'weight',
          data_type: 'integer',
          is_required: false,
          unit_type: 'g'
        },
        {
          name: 'Color',
          key: 'color',
          data_type: 'string',
          is_required: false
        },
        {
          name: 'Finish',
          key: 'finish',
          data_type: 'list_of_values',
          is_required: false,
          allowed_values: ['zinc', 'black_oxide', 'galvanized']
        }
      ]
    };

    const versionRes = await pool.query(
      `INSERT INTO product_model_versions (model_id, version, snapshot)
       VALUES ($1, 1, $2)
       RETURNING id`,
      [modelAId, JSON.stringify(schemaSnapshot)]
    );
    modelVersionAId = versionRes.rows[0].id;

    // 3. Seed file record
    const fileRes = await pool.query(
      `INSERT INTO files (merchant_id, filename, file_path, file_size, mime_type, metadata)
       VALUES ($1, 'b3_4_review_queue.csv', '/tmp/b3_4_review_queue.csv', 2048, 'text/csv', '{}'::jsonb)
       RETURNING id`,
      [merchantA]
    );
    fileAId = fileRes.rows[0].id;
    createdFileIds.push(fileAId);

    // 4. Seed extraction job
    const enqueued = await enqueueJob({
      merchant_id: merchantA,
      file_id: fileAId,
      model_version_id: modelVersionAId,
      total_records: 10
    });
    jobAId = enqueued.job_id;
    createdJobIds.push(jobAId);
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }

    // Clean up created records
    if (createdProductIds.length > 0) {
      await pool.query('DELETE FROM extracted_products WHERE id = ANY($1)', [createdProductIds]);
    }
    if (createdJobIds.length > 0) {
      await pool.query('DELETE FROM extraction_jobs WHERE id = ANY($1)', [createdJobIds]);
    }
    if (createdFileIds.length > 0) {
      await pool.query('DELETE FROM files WHERE id = ANY($1)', [createdFileIds]);
    }
    if (createdModelIds.length > 0) {
      await pool.query('DELETE FROM product_models WHERE id = ANY($1)', [createdModelIds]);
    }
  });

  // =========================================================================
  // 1. Paginated Review Queue Tests (GET /api/products)
  // =========================================================================
  describe('1. Paginated Review Queue (GET /api/products)', () => {
    let reviewProd1Id;
    let reviewProd2Id;
    let enrichedProdId;

    before(async () => {
      // Seed Product 1 in NEEDS_REVIEW (missing required 'material')
      const p1 = await ingestExtractedProduct({
        merchant_id: merchantA,
        job_id: jobAId,
        model_version_id: modelVersionAId,
        productData: {
          supplier_sku: 'QUEUE-PROD-001',
          weight: { value: 500, confidence_score: 95 }
        },
        computeGaps: true,
        schemaSnapshot
      });
      reviewProd1Id = p1.productId;
      createdProductIds.push(reviewProd1Id);

      // Seed Product 2 in NEEDS_REVIEW (low confidence 'weight' and schema error 'finish')
      const p2 = await ingestExtractedProduct({
        merchant_id: merchantA,
        job_id: jobAId,
        model_version_id: modelVersionAId,
        productData: {
          supplier_sku: 'QUEUE-PROD-002',
          material: { value: 'Grade 304 Stainless', confidence_score: 95 },
          weight: { value: 800, confidence_score: 50 },
          finish: { value: 'chrome', confidence_score: 95 } // not in allowed_values
        },
        computeGaps: true,
        schemaSnapshot
      });
      reviewProd2Id = p2.productId;
      createdProductIds.push(reviewProd2Id);

      // Seed Product 3 in ENRICHED (0 gaps)
      const p3 = await ingestExtractedProduct({
        merchant_id: merchantA,
        job_id: jobAId,
        model_version_id: modelVersionAId,
        productData: {
          supplier_sku: 'QUEUE-PROD-003',
          material: { value: 'Structural Steel', confidence_score: 95 },
          weight: { value: 1200, confidence_score: 90 },
          finish: { value: 'zinc', confidence_score: 100 }
        },
        computeGaps: true,
        schemaSnapshot
      });
      enrichedProdId = p3.productId;
      createdProductIds.push(enrichedProdId);
    });

    it('should retrieve all merchant products when no state filter is applied', async () => {
      const res = await fetch(`${baseUrl}`, {
        headers: {
          'x-api-key': validApiKey,
          'x-merchant-id': merchantA
        }
      });

      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.ok(Array.isArray(body.data));
      assert.ok(body.pagination);
      assert.ok(body.data.length >= 3);
      assert.ok(body.pagination.total >= 3);
    });

    it('should filter review queue by state=NEEDS_REVIEW with aggregated product_gaps', async () => {
      const res = await fetch(`${baseUrl}?state=NEEDS_REVIEW`, {
        headers: {
          'x-api-key': validApiKey,
          'x-merchant-id': merchantA
        }
      });

      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.ok(body.data.length >= 2);

      // Verify every returned item has state === 'NEEDS_REVIEW' and non-empty gaps array
      for (const prod of body.data) {
        assert.strictEqual(prod.state, 'NEEDS_REVIEW');
        assert.ok(Array.isArray(prod.gaps));
        assert.ok(prod.gaps.length > 0);
        for (const gap of prod.gaps) {
          assert.ok(gap.id);
          assert.ok(gap.attribute_key);
          assert.ok(gap.gap_type);
        }
      }

      // Check product 2 specific gaps
      const prod2 = body.data.find((p) => p.supplier_sku === 'QUEUE-PROD-002');
      assert.ok(prod2);
      assert.strictEqual(prod2.gaps.length, 2);
      const gapTypes = prod2.gaps.map((g) => g.gap_type).sort();
      assert.deepStrictEqual(gapTypes, ['low_confidence', 'schema_error']);
    });

    it('should filter by state=ENRICHED and return empty gaps array', async () => {
      const res = await fetch(`${baseUrl}?state=ENRICHED`, {
        headers: {
          'x-api-key': validApiKey,
          'x-merchant-id': merchantA
        }
      });

      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.ok(body.data.length >= 1);

      const enrichedProd = body.data.find((p) => p.supplier_sku === 'QUEUE-PROD-003');
      assert.ok(enrichedProd);
      assert.strictEqual(enrichedProd.state, 'ENRICHED');
      assert.deepStrictEqual(enrichedProd.gaps, []);
    });

    it('should filter by job_id', async () => {
      const res = await fetch(`${baseUrl}?job_id=${jobAId}`, {
        headers: {
          'x-api-key': validApiKey,
          'x-merchant-id': merchantA
        }
      });

      assert.strictEqual(res.status, 200);
      const body = await res.json();
      for (const prod of body.data) {
        assert.strictEqual(prod.job_id, jobAId);
      }
    });

    it('should correctly calculate pagination math (page, limit, total, totalPages)', async () => {
      const resPage1 = await fetch(`${baseUrl}?limit=2&page=1`, {
        headers: {
          'x-api-key': validApiKey,
          'x-merchant-id': merchantA
        }
      });

      assert.strictEqual(resPage1.status, 200);
      const body1 = await resPage1.json();
      assert.strictEqual(body1.pagination.page, 1);
      assert.strictEqual(body1.pagination.limit, 2);
      assert.strictEqual(body1.data.length, 2);
      assert.strictEqual(body1.pagination.totalPages, Math.ceil(body1.pagination.total / 2));

      // Page 2
      const resPage2 = await fetch(`${baseUrl}?limit=2&page=2`, {
        headers: {
          'x-api-key': validApiKey,
          'x-merchant-id': merchantA
        }
      });

      assert.strictEqual(resPage2.status, 200);
      const body2 = await resPage2.json();
      assert.strictEqual(body2.pagination.page, 2);
      assert.strictEqual(body2.pagination.limit, 2);
      // Ensure pages contain distinct products
      const p1Ids = new Set(body1.data.map((p) => p.id));
      for (const p of body2.data) {
        assert.ok(!p1Ids.has(p.id), 'Page 2 should not repeat items from Page 1');
      }
    });

    it('Cross-tenant isolation: Merchant B querying review queue receives 0 of Merchant A products', async () => {
      const res = await fetch(`${baseUrl}`, {
        headers: {
          'x-api-key': validApiKey,
          'x-merchant-id': merchantB
        }
      });

      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.strictEqual(body.data.length, 0);
      assert.strictEqual(body.pagination.total, 0);
    });

    it('should reject invalid query parameters with 400 Bad Request', async () => {
      const res = await fetch(`${baseUrl}?state=INVALID_STATE`, {
        headers: {
          'x-api-key': validApiKey,
          'x-merchant-id': merchantA
        }
      });
      assert.strictEqual(res.status, 400);

      const resLimit = await fetch(`${baseUrl}?limit=999`, {
        headers: {
          'x-api-key': validApiKey,
          'x-merchant-id': merchantA
        }
      });
      assert.strictEqual(resLimit.status, 400);
    });
  });

  // =========================================================================
  // 2. Single Product Detail Tests (GET /api/products/:id)
  // =========================================================================
  describe('2. Single Product Detail (GET /api/products/:id)', () => {
    let detailProdId;

    before(async () => {
      const p = await ingestExtractedProduct({
        merchant_id: merchantA,
        job_id: jobAId,
        model_version_id: modelVersionAId,
        productData: {
          supplier_sku: 'DETAIL-PROD-001',
          material: {
            value: 'Stainless Steel A2',
            confidence_score: 95,
            page_number: 4,
            bounding_box: { x: 0.1, y: 0.2, w: 0.5, h: 0.1 },
            raw_source_value: 'Material: Stainless Steel A2'
          },
          weight: { value: 650, confidence_score: 50 } // Low confidence gap
        },
        computeGaps: true,
        schemaSnapshot
      });
      detailProdId = p.productId;
      createdProductIds.push(detailProdId);
    });

    it('should return complete product record with active gaps and extracted attributes', async () => {
      const res = await fetch(`${baseUrl}/${detailProdId}`, {
        headers: {
          'x-api-key': validApiKey,
          'x-merchant-id': merchantA
        }
      });

      assert.strictEqual(res.status, 200);
      const product = await res.json();

      assert.strictEqual(product.id, detailProdId);
      assert.strictEqual(product.supplier_sku, 'DETAIL-PROD-001');
      assert.strictEqual(product.state, 'NEEDS_REVIEW');

      // Gaps check
      assert.ok(Array.isArray(product.gaps));
      assert.strictEqual(product.gaps.length, 1);
      assert.strictEqual(product.gaps[0].attribute_key, 'weight');
      assert.strictEqual(product.gaps[0].gap_type, 'low_confidence');

      // Attributes check
      assert.ok(Array.isArray(product.attributes));
      assert.strictEqual(product.attributes.length, 2);

      const matAttr = product.attributes.find((a) => a.attribute_key === 'material');
      assert.ok(matAttr);
      assert.strictEqual(matAttr.value, 'Stainless Steel A2');
      assert.strictEqual(matAttr.confidence_score, 95);
      assert.strictEqual(matAttr.page_number, 4);
      assert.deepStrictEqual(matAttr.bounding_box, { x: 0.1, y: 0.2, w: 0.5, h: 0.1 });
      assert.strictEqual(matAttr.raw_source_value, 'Material: Stainless Steel A2');
      assert.strictEqual(matAttr.is_manually_overridden, false);
      assert.strictEqual(matAttr.overridden_by, null);
    });

    it('Cross-tenant isolation: Merchant B querying Merchant A product by ID receives 404 Not Found', async () => {
      const res = await fetch(`${baseUrl}/${detailProdId}`, {
        headers: {
          'x-api-key': validApiKey,
          'x-merchant-id': merchantB
        }
      });

      assert.strictEqual(res.status, 404);
      const body = await res.json();
      assert.strictEqual(body.error, 'Product not found');
    });

    it('should return 404 Not Found for non-existent product UUID', async () => {
      const res = await fetch(`${baseUrl}/00000000-0000-0000-0000-000000000000`, {
        headers: {
          'x-api-key': validApiKey,
          'x-merchant-id': merchantA
        }
      });
      assert.strictEqual(res.status, 404);
    });
  });

  // =========================================================================
  // 3. Manual Override & Promotion Tests (PUT /api/products/:id/attributes)
  // =========================================================================
  describe('3. Manual Override & Promotion (PUT /api/products/:id/attributes)', () => {
    let overrideProdId;

    beforeEach(async () => {
      // Seed a fresh product in NEEDS_REVIEW with 2 gaps:
      // 1. weight: low_confidence
      // 2. material: missing_required
      const p = await ingestExtractedProduct({
        merchant_id: merchantA,
        job_id: jobAId,
        model_version_id: modelVersionAId,
        productData: {
          supplier_sku: `OVERRIDE-SKU-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
          // material omitted -> missing_required
          weight: { value: 900, confidence_score: 50 } // low_confidence
        },
        computeGaps: true,
        schemaSnapshot
      });
      overrideProdId = p.productId;
      createdProductIds.push(overrideProdId);
    });

    it('should reject schema type violation with 400 SCHEMA_VALIDATION_ERROR and leave state unchanged', async () => {
      const res = await fetch(`${baseUrl}/${overrideProdId}/attributes`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': validApiKey,
          'x-merchant-id': merchantA
        },
        body: JSON.stringify({
          attributes: {
            weight: 'not_an_integer' // String into integer field
          }
        })
      });

      assert.strictEqual(res.status, 400);
      const body = await res.json();
      assert.strictEqual(body.error, 'SCHEMA_VALIDATION_ERROR');
      assert.match(body.message, /must be an integer/i);

      // Verify product state remains NEEDS_REVIEW in database
      const dbCheck = await pool.query('SELECT state FROM extracted_products WHERE id = $1', [overrideProdId]);
      assert.strictEqual(dbCheck.rows[0].state, 'NEEDS_REVIEW');

      // Verify gaps are unchanged (still 2 gaps)
      const gapCheck = await pool.query('SELECT COUNT(*)::int AS count FROM product_gaps WHERE product_id = $1', [overrideProdId]);
      assert.strictEqual(gapCheck.rows[0].count, 2);
    });

    it('should reject invalid enum value for list_of_values attribute with 400 SCHEMA_VALIDATION_ERROR', async () => {
      const res = await fetch(`${baseUrl}/${overrideProdId}/attributes`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': validApiKey,
          'x-merchant-id': merchantA
        },
        body: JSON.stringify({
          attributes: {
            finish: 'unsupported_finish' // Not in ['zinc', 'black_oxide', 'galvanized']
          }
        })
      });

      assert.strictEqual(res.status, 400);
      const body = await res.json();
      assert.strictEqual(body.error, 'SCHEMA_VALIDATION_ERROR');
      assert.match(body.message, /invalid option|expected one of|not permitted/i);
    });

    it('Step 1 Override: resolving weight gap updates audit logging, removes gap, and leaves state as NEEDS_REVIEW', async () => {
      const operatorUser = 'operator_sarah';

      const res = await fetch(`${baseUrl}/${overrideProdId}/attributes`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': validApiKey,
          'x-merchant-id': merchantA,
          'x-user-id': operatorUser
        },
        body: JSON.stringify({
          attributes: {
            weight: 1250
          }
        })
      });

      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.strictEqual(body.product_id, overrideProdId);
      assert.strictEqual(body.state, 'NEEDS_REVIEW');
      assert.strictEqual(body.remaining_gaps_count, 1); // material gap still remains

      // 1. Verify extracted_attributes audit logging
      const attrRes = await pool.query(
        'SELECT * FROM extracted_attributes WHERE product_id = $1 AND attribute_key = $2',
        [overrideProdId, 'weight']
      );
      assert.strictEqual(attrRes.rows.length, 1);
      const weightAttr = attrRes.rows[0];
      assert.strictEqual(weightAttr.value, 1250);
      assert.strictEqual(weightAttr.confidence_score, 100);
      assert.strictEqual(weightAttr.is_manually_overridden, true);
      assert.strictEqual(weightAttr.overridden_by, operatorUser);
      assert.ok(weightAttr.overridden_at !== null);

      // 2. Verify product_gaps for weight was deleted, while material gap remains
      const gapsRes = await pool.query(
        'SELECT * FROM product_gaps WHERE product_id = $1',
        [overrideProdId]
      );
      assert.strictEqual(gapsRes.rows.length, 1);
      assert.strictEqual(gapsRes.rows[0].attribute_key, 'material');
      assert.strictEqual(gapsRes.rows[0].gap_type, 'missing_required');

      // 3. Verify product state in DB is still NEEDS_REVIEW
      const prodRes = await pool.query('SELECT state FROM extracted_products WHERE id = $1', [overrideProdId]);
      assert.strictEqual(prodRes.rows[0].state, 'NEEDS_REVIEW');
    });

    it('Step 2 Override: resolving remaining material gap clears all gaps and automatically promotes product to ENRICHED', async () => {
      const operatorUser = 'catalog_curator';

      // First resolve weight
      await fetch(`${baseUrl}/${overrideProdId}/attributes`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': validApiKey,
          'x-merchant-id': merchantA
        },
        body: JSON.stringify({ attributes: { weight: 1250 } })
      });

      // Now resolve material (the last remaining gap)
      const res = await fetch(`${baseUrl}/${overrideProdId}/attributes`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': validApiKey,
          'x-merchant-id': merchantA,
          'x-user-id': operatorUser
        },
        body: JSON.stringify({
          attributes: {
            material: 'Grade 316 Marine Stainless Steel'
          }
        })
      });

      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.strictEqual(body.product_id, overrideProdId);
      assert.strictEqual(body.state, 'ENRICHED');
      assert.strictEqual(body.remaining_gaps_count, 0);

      // 1. Verify extracted_attributes audit logging for material
      const matRes = await pool.query(
        'SELECT * FROM extracted_attributes WHERE product_id = $1 AND attribute_key = $2',
        [overrideProdId, 'material']
      );
      assert.strictEqual(matRes.rows.length, 1);
      assert.strictEqual(matRes.rows[0].value, 'Grade 316 Marine Stainless Steel');
      assert.strictEqual(matRes.rows[0].confidence_score, 100);
      assert.strictEqual(matRes.rows[0].is_manually_overridden, true);
      assert.strictEqual(matRes.rows[0].overridden_by, operatorUser);

      // 2. Verify all product_gaps are cleared
      const gapCheck = await pool.query('SELECT COUNT(*)::int AS count FROM product_gaps WHERE product_id = $1', [overrideProdId]);
      assert.strictEqual(gapCheck.rows[0].count, 0);

      // 3. Verify product state in DB is now ENRICHED
      const prodCheck = await pool.query('SELECT state FROM extracted_products WHERE id = $1', [overrideProdId]);
      assert.strictEqual(prodCheck.rows[0].state, 'ENRICHED');
    });

    it('should support updating multiple attributes in a single payload', async () => {
      const res = await fetch(`${baseUrl}/${overrideProdId}/attributes`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': validApiKey,
          'x-merchant-id': merchantA,
          'x-user-id': 'lead_engineer'
        },
        body: JSON.stringify({
          attributes: {
            material: 'Titanium Grade 5',
            weight: 850,
            finish: 'galvanized'
          }
        })
      });

      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.strictEqual(body.state, 'ENRICHED');
      assert.strictEqual(body.remaining_gaps_count, 0);

      const prodCheck = await pool.query('SELECT state FROM extracted_products WHERE id = $1', [overrideProdId]);
      assert.strictEqual(prodCheck.rows[0].state, 'ENRICHED');
    });
  });

  // =========================================================================
  // 4. Cross-Tenant Mutation Security & Edge Cases
  // =========================================================================
  describe('4. Cross-Tenant Mutation Security & Edge Cases', () => {
    let merchantAProdId;

    before(async () => {
      const p = await ingestExtractedProduct({
        merchant_id: merchantA,
        job_id: jobAId,
        model_version_id: modelVersionAId,
        productData: {
          supplier_sku: 'CROSS-TENANT-TARGET-SKU',
          material: { value: 'Brass', confidence_score: 95 }
        },
        computeGaps: true,
        schemaSnapshot
      });
      merchantAProdId = p.productId;
      createdProductIds.push(merchantAProdId);
    });

    it('Merchant B attempting to override Merchant A product attributes receives strict 404 Not Found', async () => {
      const res = await fetch(`${baseUrl}/${merchantAProdId}/attributes`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': validApiKey,
          'x-merchant-id': merchantB // Unauthorized tenant
        },
        body: JSON.stringify({
          attributes: {
            material: 'Compromised Material'
          }
        })
      });

      assert.strictEqual(res.status, 404);
      const body = await res.json();
      assert.strictEqual(body.error, 'Product not found');

      // Verify Merchant A product was NOT modified
      const checkRes = await pool.query(
        'SELECT * FROM extracted_attributes WHERE product_id = $1 AND attribute_key = $2',
        [merchantAProdId, 'material']
      );
      assert.strictEqual(checkRes.rows[0].value, 'Brass');
      assert.strictEqual(checkRes.rows[0].is_manually_overridden, false);
    });

    it('PUT on non-existent product ID returns 404 Not Found', async () => {
      const res = await fetch(`${baseUrl}/00000000-0000-0000-0000-000000000000/attributes`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': validApiKey,
          'x-merchant-id': merchantA
        },
        body: JSON.stringify({
          attributes: {
            material: 'Steel'
          }
        })
      });

      assert.strictEqual(res.status, 404);
    });

    it('PUT with empty attributes object returns 400 Bad Request', async () => {
      const res = await fetch(`${baseUrl}/${merchantAProdId}/attributes`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': validApiKey,
          'x-merchant-id': merchantA
        },
        body: JSON.stringify({
          attributes: {}
        })
      });

      assert.strictEqual(res.status, 400);
    });

    it('Requests with missing or invalid x-merchant-id return 400 Bad Request', async () => {
      const resNoHeader = await fetch(`${baseUrl}`, {
        headers: {
          'x-api-key': validApiKey
        }
      });
      assert.strictEqual(resNoHeader.status, 400);

      const resInvalidUuid = await fetch(`${baseUrl}`, {
        headers: {
          'x-api-key': validApiKey,
          'x-merchant-id': 'not-a-valid-uuid'
        }
      });
      assert.strictEqual(resInvalidUuid.status, 400);
    });

    it('Requests with invalid API key return 401 Unauthorized', async () => {
      const res = await fetch(`${baseUrl}`, {
        headers: {
          'x-api-key': 'invalid_key',
          'x-merchant-id': merchantA
        }
      });
      assert.strictEqual(res.status, 401);
    });
  });
});
