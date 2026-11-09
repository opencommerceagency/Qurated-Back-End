import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import express from 'express';
import { pool } from '../src/db/index.js';
import extractionRouter from '../src/routes/extraction.js';
import { calculateConfidenceScore } from '../src/services/confidenceScorer.js';
import {
  computeProductGaps,
  computeAndSyncProductGaps,
  promoteProductState,
  resetProductForReExtraction
} from '../src/services/gapComputer.js';
import { enqueueJob } from '../src/services/queueService.js';
import {
  processJob,
  ingestExtractedProduct,
  normalizeBoundingBox
} from '../src/workers/extractionWorker.js';

process.env.API_KEY = process.env.API_KEY || 'qurated_dev_api_key_2026';
process.env.API_AUTH_USER = process.env.API_AUTH_USER || 'admin';
process.env.API_AUTH_PASS = process.env.API_AUTH_PASS || 'qurated_dev_password';

describe('User Story B3.3: Granular Provenance, Confidence Heuristics, Gap Computation, and Strict State Machine', () => {
  const merchantId = '66666666-6666-6666-6666-666666666666';
  const validApiKey = 'qurated_dev_api_key_2026';

  let app;
  let server;
  let baseUrl;

  let modelId;
  let modelVersionId;
  let fileId;
  let schemaSnapshot;

  const createdModelIds = [];
  const createdJobIds = [];
  const createdFileIds = [];
  const createdProductIds = [];

  before(async () => {
    // 1. Setup lightweight Express server for API testing
    app = express();
    app.use(express.json());
    app.use('/api/extraction', extractionRouter);

    await new Promise((resolve) => {
      server = app.listen(0, () => {
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}/api/extraction`;
        resolve();
      });
    });

    // 2. Seed Product Model and Version Snapshot
    const modelRes = await pool.query(
      `INSERT INTO product_models (merchant_id, name, description, status, schema_version, created_by, updated_by)
       VALUES ($1, 'B3.3 Provenance & Gaps Catalog', 'Model schema for B3.3 gap computation testing', 'ACTIVE', 1, 'admin', 'admin')
       RETURNING id`,
      [merchantId]
    );
    modelId = modelRes.rows[0].id;
    createdModelIds.push(modelId);

    schemaSnapshot = {
      name: 'B3.3 Provenance & Gaps Catalog',
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
          name: 'Length',
          key: 'length',
          data_type: 'integer',
          is_required: false,
          unit_type: 'mm'
        },
        {
          name: 'In Stock',
          key: 'in_stock',
          data_type: 'boolean',
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
      [modelId, JSON.stringify(schemaSnapshot)]
    );
    modelVersionId = versionRes.rows[0].id;

    // 3. Seed file record
    const fileRes = await pool.query(
      `INSERT INTO files (merchant_id, filename, file_path, file_size, mime_type, metadata)
       VALUES ($1, 'b3_3_lineage_test.csv', '/tmp/b3_3_lineage_test.csv', 1024, 'text/csv', '{"source":"supplier_spec"}'::jsonb)
       RETURNING id`,
      [merchantId]
    );
    fileId = fileRes.rows[0].id;
    createdFileIds.push(fileId);
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }

    // Cleanup seeded data
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
  // 1. Confidence Heuristics Tests
  // =========================================================================
  describe('1. Confidence Heuristics Engine (confidenceScorer.js)', () => {
    it('Rule 1: Exact literal full match should return confidence score 100', () => {
      const score = calculateConfidenceScore({
        extractedValue: 'Stainless Steel',
        rawSourceValue: 'Stainless Steel'
      });
      assert.strictEqual(score, 100);
    });

    it('Rule 1: Exact literal substring match should return score >= 90', () => {
      const score = calculateConfidenceScore({
        extractedValue: 'M8',
        rawSourceValue: 'Hex head bolt M8 x 40mm galvanized'
      });
      assert.ok(score >= 90, `Expected score >= 90, got ${score}`);
      assert.strictEqual(score, 95);
    });

    it('Rule 1: Match with punctuation differences should return score >= 90', () => {
      const score = calculateConfidenceScore({
        extractedValue: 'M8',
        rawSourceValue: 'M-8'
      });
      assert.ok(score >= 90, `Expected score >= 90, got ${score}`);
      assert.strictEqual(score, 95);
    });

    it('Fix 6: stripPunct must preserve commas and decimals (12,99 does NOT match 1299)', () => {
      const score = calculateConfidenceScore({
        extractedValue: '1299',
        rawSourceValue: '12,99'
      });
      // Should NOT match with 95
      assert.notStrictEqual(score, 95);
      assert.ok(score < 90, `Expected score < 90 for 12,99 vs 1299, got ${score}`);
    });

    it('Rule 2: Canonical unit conversion match (1.3 kg -> 1300 g) should return score between 75 and 89', () => {
      const score = calculateConfidenceScore({
        extractedValue: 1300,
        rawSourceValue: '1.3 kg',
        unit: 'g'
      });
      assert.ok(score >= 75 && score <= 89, `Expected score in [75, 89], got ${score}`);
      assert.strictEqual(score, 85);
    });

    it('Fix 5: Unit conversion loop does not match if no unit or mismatched unit is declared', () => {
      // No unit declared on un-typed number
      const scoreNoUnit = calculateConfidenceScore({
        extractedValue: 1300,
        rawSourceValue: '1.3 kg'
        // unit omitted
      });
      assert.ok(scoreNoUnit < 75, `Expected score < 75 when unit is unconfigured, got ${scoreNoUnit}`);

      // Mismatched unit base (length 'mm' vs mass 'kg')
      const scoreMismatchedBase = calculateConfidenceScore({
        extractedValue: 1300,
        rawSourceValue: '1.3 kg',
        unit: 'mm'
      });
      assert.ok(scoreMismatchedBase < 75, `Expected score < 75 for mismatched unit base, got ${scoreMismatchedBase}`);
    });

    it('Rule 2: Canonical length conversion match (100 cm -> 1 m) should return score between 75 and 89', () => {
      const score = calculateConfidenceScore({
        extractedValue: 1,
        rawSourceValue: '100 cm',
        unit: 'm'
      });
      assert.ok(score >= 75 && score <= 89, `Expected score in [75, 89], got ${score}`);
      assert.strictEqual(score, 85);
    });

    it('Rule 2: European decimal normalization ("80,50" -> 80.5) should return score between 75 and 89', () => {
      const score = calculateConfidenceScore({
        extractedValue: 80.5,
        rawSourceValue: '80,50'
      });
      assert.ok(score >= 75 && score <= 89, `Expected score in [75, 89], got ${score}`);
      assert.strictEqual(score, 85);
    });

    it('Rule 2: Boolean semantic equivalents ("ja" / "yes" / "in stock" -> true) should return score between 75 and 89', () => {
      const scoreJa = calculateConfidenceScore({
        extractedValue: true,
        rawSourceValue: 'ja',
        attributeType: 'boolean'
      });
      assert.strictEqual(scoreJa, 85);

      const scoreInStock = calculateConfidenceScore({
        extractedValue: true,
        rawSourceValue: 'Item is in stock and ready to ship',
        attributeType: 'boolean'
      });
      assert.strictEqual(scoreInStock, 85);

      const scoreOutOfStock = calculateConfidenceScore({
        extractedValue: false,
        rawSourceValue: 'out of stock',
        attributeType: 'boolean'
      });
      assert.strictEqual(scoreOutOfStock, 85);
    });

    it('Fix 7: Tightened Boolean regex does NOT trigger false positive on stray "0" or "1" in text', () => {
      // "1" in "pack of 1 piece" should not falsely match boolean true
      const score1 = calculateConfidenceScore({
        extractedValue: true,
        rawSourceValue: 'pack of 1 piece',
        attributeType: 'boolean'
      });
      assert.strictEqual(score1, 50);

      // "0" in "dimension 0.5mm" should not falsely match boolean false
      const score0 = calculateConfidenceScore({
        extractedValue: false,
        rawSourceValue: 'dimension 0.5mm',
        attributeType: 'boolean'
      });
      assert.strictEqual(score0, 50);

      // Standalone "1" still matches boolean true
      const scoreStandalone1 = calculateConfidenceScore({
        extractedValue: true,
        rawSourceValue: '1',
        attributeType: 'boolean'
      });
      assert.strictEqual(scoreStandalone1, 85);

      // Standalone "0" still matches boolean false
      const scoreStandalone0 = calculateConfidenceScore({
        extractedValue: false,
        rawSourceValue: '0',
        attributeType: 'boolean'
      });
      assert.strictEqual(scoreStandalone0, 85);
    });

    it('Rule 3: Synthesized, inferred, or hallucinated value should return score < 75', () => {
      const score = calculateConfidenceScore({
        extractedValue: 'Heavy Duty Structural Steel',
        rawSourceValue: 'Fastener blue pack'
      });
      assert.ok(score < 75, `Expected score < 75, got ${score}`);
      assert.strictEqual(score, 50);
    });

    it('Rule 3: Missing raw_source_value should return score 50', () => {
      const score = calculateConfidenceScore({
        extractedValue: 'Some Value',
        rawSourceValue: null
      });
      assert.strictEqual(score, 50);
    });

    it('Null or undefined extracted value should return score 0', () => {
      assert.strictEqual(calculateConfidenceScore({ extractedValue: null, rawSourceValue: 'test' }), 0);
      assert.strictEqual(calculateConfidenceScore({ extractedValue: undefined, rawSourceValue: 'test' }), 0);
    });
  });

  // =========================================================================
  // 2. Gap Detection & Storage Tests
  // =========================================================================
  describe('2. Gap Computation & Storage (gapComputer.js)', () => {
    it('should detect missing_required gap when required attribute is omitted or empty', () => {
      const gaps = computeProductGaps({
        modelAttributes: schemaSnapshot.attributes,
        extractedAttributes: {
          weight: { value: 500, confidence_score: 95 }
          // material is required but omitted
        }
      });

      const missingRequired = gaps.find((g) => g.attribute_key === 'material');
      assert.ok(missingRequired, 'Expected missing_required gap for material');
      assert.strictEqual(missingRequired.gap_type, 'missing_required');
    });

    it('should detect low_confidence gap when confidence score is below threshold', () => {
      const gaps = computeProductGaps({
        modelAttributes: schemaSnapshot.attributes,
        extractedAttributes: {
          material: { value: 'Steel', confidence_score: 100 },
          weight: { value: 500, confidence_score: 60 } // threshold default is 75
        },
        minConfidenceThreshold: 75
      });

      const lowConf = gaps.find((g) => g.attribute_key === 'weight');
      assert.ok(lowConf, 'Expected low_confidence gap for weight');
      assert.strictEqual(lowConf.gap_type, 'low_confidence');
    });

    it('should detect schema_error gap on data type mismatch (e.g. non-integer to integer)', () => {
      const gaps = computeProductGaps({
        modelAttributes: schemaSnapshot.attributes,
        extractedAttributes: {
          material: { value: 'Steel', confidence_score: 100 },
          weight: { value: 'not_a_valid_integer', confidence_score: 95 }
        }
      });

      const schemaErr = gaps.find((g) => g.attribute_key === 'weight');
      assert.ok(schemaErr, 'Expected schema_error gap for weight');
      assert.strictEqual(schemaErr.gap_type, 'schema_error');
    });

    it('should detect schema_error gap when enum value is not in allowed_values', () => {
      const gaps = computeProductGaps({
        modelAttributes: schemaSnapshot.attributes,
        extractedAttributes: {
          material: { value: 'Steel', confidence_score: 100 },
          finish: { value: 'chrome_plated', confidence_score: 95 } // not in ['zinc', 'black_oxide', 'galvanized']
        }
      });

      const schemaErr = gaps.find((g) => g.attribute_key === 'finish');
      assert.ok(schemaErr, 'Expected schema_error gap for finish');
      assert.strictEqual(schemaErr.gap_type, 'schema_error');
    });

    it('should return 0 gaps when all required attributes are present, types are valid, and confidence >= 75', () => {
      const gaps = computeProductGaps({
        modelAttributes: schemaSnapshot.attributes,
        extractedAttributes: {
          material: { value: 'Stainless Steel', confidence_score: 100 },
          weight: { value: 1200, confidence_score: 85 },
          length: { value: 50, confidence_score: 95 },
          in_stock: { value: true, confidence_score: 85 },
          finish: { value: 'zinc', confidence_score: 95 }
        },
        minConfidenceThreshold: 75
      });

      assert.strictEqual(gaps.length, 0);
    });

    it('computeAndSyncProductGaps should synchronize gaps and transition state directly in PostgreSQL', async () => {
      const enqueued = await enqueueJob({
        merchant_id: merchantId,
        file_id: fileId,
        model_version_id: modelVersionId,
        total_records: 1
      });
      createdJobIds.push(enqueued.job_id);

      // Ingest without auto gap computation
      const initial = await ingestExtractedProduct({
        merchant_id: merchantId,
        job_id: enqueued.job_id,
        model_version_id: modelVersionId,
        productData: {
          supplier_sku: 'DIRECT-SYNC-SKU',
          material: { value: 'Grade A Steel', raw_source_value: 'Grade A Steel' }
        },
        computeGaps: false
      });
      createdProductIds.push(initial.productId);

      // Explicitly run computeAndSyncProductGaps
      const syncResult = await computeAndSyncProductGaps({
        productId: initial.productId,
        modelVersionId,
        schemaSnapshot
      });

      assert.strictEqual(syncResult.state, 'ENRICHED');
      assert.strictEqual(syncResult.gaps.length, 0);
    });

    it('should persist detected gaps atomically into product_gaps table', async () => {
      const enqueued = await enqueueJob({
        merchant_id: merchantId,
        file_id: fileId,
        model_version_id: modelVersionId,
        total_records: 1
      });
      createdJobIds.push(enqueued.job_id);

      const ingestRes = await ingestExtractedProduct({
        merchant_id: merchantId,
        job_id: enqueued.job_id,
        model_version_id: modelVersionId,
        productData: {
          supplier_sku: 'GAP-TEST-SKU-1',
          // material omitted -> missing_required
          weight: { value: 999, raw_source_value: 'unknown' }, // low_confidence
          finish: { value: 'anodized', raw_source_value: 'anodized' } // not in enum -> schema_error
        },
        computeGaps: true,
        schemaSnapshot
      });

      createdProductIds.push(ingestRes.productId);

      const gapsRes = await pool.query(
        'SELECT * FROM product_gaps WHERE product_id = $1 ORDER BY attribute_key ASC',
        [ingestRes.productId]
      );

      assert.strictEqual(gapsRes.rows.length, 3);
      const gapTypes = gapsRes.rows.map((r) => r.gap_type).sort();
      assert.deepStrictEqual(gapTypes, ['low_confidence', 'missing_required', 'schema_error']);
    });
  });

  // =========================================================================
  // 3. Strict State Machine & Illegal Promotion Guards
  // =========================================================================
  describe('3. Strict State Machine & Promotion Guards (gapComputer.js)', () => {
    it('Product with >= 1 unresolved gap must transition to NEEDS_REVIEW', async () => {
      const enqueued = await enqueueJob({
        merchant_id: merchantId,
        file_id: fileId,
        model_version_id: modelVersionId
      });
      createdJobIds.push(enqueued.job_id);

      const ingestRes = await ingestExtractedProduct({
        merchant_id: merchantId,
        job_id: enqueued.job_id,
        model_version_id: modelVersionId,
        productData: {
          supplier_sku: 'STATE-NEEDS-REVIEW-SKU',
          // material missing
          weight: 100
        },
        computeGaps: true,
        schemaSnapshot
      });
      createdProductIds.push(ingestRes.productId);

      assert.strictEqual(ingestRes.state, 'NEEDS_REVIEW');
      assert.strictEqual(ingestRes.product.state, 'NEEDS_REVIEW');

      // Verify in DB
      const dbCheck = await pool.query('SELECT state FROM extracted_products WHERE id = $1', [ingestRes.productId]);
      assert.strictEqual(dbCheck.rows[0].state, 'NEEDS_REVIEW');
    });

    it('Product with 0 active gaps must transition to ENRICHED', async () => {
      const enqueued = await enqueueJob({
        merchant_id: merchantId,
        file_id: fileId,
        model_version_id: modelVersionId
      });
      createdJobIds.push(enqueued.job_id);

      const ingestRes = await ingestExtractedProduct({
        merchant_id: merchantId,
        job_id: enqueued.job_id,
        model_version_id: modelVersionId,
        productData: {
          supplier_sku: 'STATE-ENRICHED-SKU',
          material: { value: 'Grade 316 Stainless', raw_source_value: 'Grade 316 Stainless' },
          weight: { value: 750, raw_source_value: '750 g' },
          finish: { value: 'zinc', raw_source_value: 'zinc' }
        },
        computeGaps: true,
        schemaSnapshot
      });
      createdProductIds.push(ingestRes.productId);

      assert.strictEqual(ingestRes.state, 'ENRICHED');
      assert.strictEqual(ingestRes.product.state, 'ENRICHED');

      // Verify in DB
      const dbCheck = await pool.query('SELECT state FROM extracted_products WHERE id = $1', [ingestRes.productId]);
      assert.strictEqual(dbCheck.rows[0].state, 'ENRICHED');

      // Verify 0 gaps in product_gaps
      const gapCheck = await pool.query('SELECT COUNT(*)::int AS count FROM product_gaps WHERE product_id = $1', [ingestRes.productId]);
      assert.strictEqual(gapCheck.rows[0].count, 0);
    });

    it('Illegal Promotion Guard: Attempting to promote product with active gaps to ENRICHED should throw 409 Conflict', async () => {
      const enqueued = await enqueueJob({
        merchant_id: merchantId,
        file_id: fileId,
        model_version_id: modelVersionId
      });
      createdJobIds.push(enqueued.job_id);

      const ingestRes = await ingestExtractedProduct({
        merchant_id: merchantId,
        job_id: enqueued.job_id,
        model_version_id: modelVersionId,
        productData: {
          supplier_sku: 'ILLEGAL-PROMOTION-SKU',
          material: { value: 'Steel', raw_source_value: 'Unrelated other item' } // Low confidence (< 75)
        },
        computeGaps: true,
        schemaSnapshot
      });
      createdProductIds.push(ingestRes.productId);

      assert.strictEqual(ingestRes.state, 'NEEDS_REVIEW');

      // 1. Test helper function promoteProductState directly
      await assert.rejects(
        async () => {
          await promoteProductState(ingestRes.productId, 'ENRICHED');
        },
        (err) => {
          assert.strictEqual(err.statusCode || err.status, 409);
          assert.strictEqual(err.error, 'CANNOT_PROMOTE_WITH_ACTIVE_GAPS');
          return true;
        }
      );

      // 2. Test HTTP API endpoint PATCH /api/extraction/products/:id/state
      const patchRes = await fetch(`${baseUrl}/products/${ingestRes.productId}/state`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': validApiKey,
          'x-merchant-id': merchantId
        },
        body: JSON.stringify({ state: 'ENRICHED' })
      });

      assert.strictEqual(patchRes.status, 409);
      const errBody = await patchRes.json();
      assert.strictEqual(errBody.error, 'CANNOT_PROMOTE_WITH_ACTIVE_GAPS');
      assert.match(errBody.message, /unresolved gaps/);
    });

    it('Fix 4: Attempting to promote product directly from PROCESSING to ENRICHED throws 409 Conflict', async () => {
      const enqueued = await enqueueJob({
        merchant_id: merchantId,
        file_id: fileId,
        model_version_id: modelVersionId,
        total_records: 1
      });
      createdJobIds.push(enqueued.job_id);

      // Create product in PROCESSING state without gaps
      const prodRes = await pool.query(
        `INSERT INTO extracted_products (merchant_id, job_id, model_version_id, supplier_sku, state)
         VALUES ($1, $2, $3, 'DIRECT-PROCESSING-TO-ENRICHED', 'PROCESSING')
         RETURNING id`,
        [merchantId, enqueued.job_id, modelVersionId]
      );
      const prodId = prodRes.rows[0].id;
      createdProductIds.push(prodId);

      await assert.rejects(
        async () => {
          await promoteProductState(prodId, 'ENRICHED');
        },
        (err) => {
          assert.strictEqual(err.statusCode || err.status, 409);
          assert.strictEqual(err.error, 'ILLEGAL_STATE_TRANSITION');
          return true;
        }
      );
    });

    it('Re-extracting an ENRICHED product cleanly resets state to PROCESSING and re-evaluates gaps', async () => {
      const enqueued = await enqueueJob({
        merchant_id: merchantId,
        file_id: fileId,
        model_version_id: modelVersionId
      });
      createdJobIds.push(enqueued.job_id);

      // 1. Initial run: Product is ENRICHED
      const initialIngest = await ingestExtractedProduct({
        merchant_id: merchantId,
        job_id: enqueued.job_id,
        model_version_id: modelVersionId,
        productData: {
          supplier_sku: 'RE-EXTRACT-SKU',
          material: { value: 'Titanium', raw_source_value: 'Titanium' }
        },
        computeGaps: true,
        schemaSnapshot
      });
      createdProductIds.push(initialIngest.productId);
      assert.strictEqual(initialIngest.state, 'ENRICHED');

      // 2. Explicitly test reset helper
      const resetProd = await resetProductForReExtraction(initialIngest.productId);
      assert.strictEqual(resetProd.state, 'PROCESSING');

      // 3. Second run: Re-extract with invalid enum value (new gap introduced)
      const enqueued2 = await enqueueJob({
        merchant_id: merchantId,
        file_id: fileId,
        model_version_id: modelVersionId
      });
      createdJobIds.push(enqueued2.job_id);

      const reIngest = await ingestExtractedProduct({
        merchant_id: merchantId,
        job_id: enqueued2.job_id,
        model_version_id: modelVersionId,
        productData: {
          supplier_sku: 'RE-EXTRACT-SKU', // SAME SKU
          material: { value: 'Titanium', raw_source_value: 'Titanium' },
          finish: 'unsupported_finish' // Schema error gap!
        },
        computeGaps: true,
        schemaSnapshot
      });

      assert.strictEqual(reIngest.productId, initialIngest.productId);
      assert.strictEqual(reIngest.state, 'NEEDS_REVIEW');

      // Verify in DB: state must now be NEEDS_REVIEW
      const dbCheck = await pool.query('SELECT state FROM extracted_products WHERE id = $1', [initialIngest.productId]);
      assert.strictEqual(dbCheck.rows[0].state, 'NEEDS_REVIEW');
    });

    it('Fix 3: Re-extraction deletes old attributes omitted in new run and updates provenance pointers', async () => {
      const enqueued1 = await enqueueJob({
        merchant_id: merchantId,
        file_id: fileId,
        model_version_id: modelVersionId
      });
      createdJobIds.push(enqueued1.job_id);

      // 1. Run 1: extracts material and weight
      const run1 = await ingestExtractedProduct({
        merchant_id: merchantId,
        job_id: enqueued1.job_id,
        model_version_id: modelVersionId,
        productData: {
          supplier_sku: 'PRUNING-RE-EXTRACT-SKU',
          material: 'Carbon Steel',
          weight: 500
        },
        source_file_id: fileId,
        source_row_index: 0,
        source_column: 'Col_A',
        schemaSnapshot
      });
      createdProductIds.push(run1.productId);

      const attrsRun1 = await pool.query('SELECT attribute_key FROM extracted_attributes WHERE product_id = $1', [run1.productId]);
      assert.strictEqual(attrsRun1.rows.length, 2);

      // 2. Run 2 (New file, re-extract): only extracts material, omitting weight
      const newFileRes = await pool.query(
        `INSERT INTO files (merchant_id, filename, file_size, mime_type)
         VALUES ($1, 'new_run.csv', 512, 'text/csv')
         RETURNING id`,
        [merchantId]
      );
      const newFileId = newFileRes.rows[0].id;
      createdFileIds.push(newFileId);

      const enqueued2 = await enqueueJob({
        merchant_id: merchantId,
        file_id: newFileId,
        model_version_id: modelVersionId
      });
      createdJobIds.push(enqueued2.job_id);

      await ingestExtractedProduct({
        merchant_id: merchantId,
        job_id: enqueued2.job_id,
        model_version_id: modelVersionId,
        productData: {
          supplier_sku: 'PRUNING-RE-EXTRACT-SKU',
          material: 'Carbon Steel'
          // weight omitted!
        },
        source_file_id: newFileId,
        source_row_index: 4,
        source_column: 'New_Col_Material',
        schemaSnapshot
      });

      // Verify weight was DELETED from DB
      const attrsRun2 = await pool.query('SELECT * FROM extracted_attributes WHERE product_id = $1', [run1.productId]);
      assert.strictEqual(attrsRun2.rows.length, 1);
      assert.strictEqual(attrsRun2.rows[0].attribute_key, 'material');

      // Verify provenance updated to new file, row index, and column
      assert.strictEqual(attrsRun2.rows[0].source_file_id, newFileId);
      assert.strictEqual(attrsRun2.rows[0].source_row_index, 4);
      assert.strictEqual(attrsRun2.rows[0].source_column, 'New_Col_Material');
    });
  });

  // =========================================================================
  // 4. Provenance & Bounding Box Lineage
  // =========================================================================
  describe('4. Provenance & Bounding Box Lineage', () => {
    it('Fix 8: should normalize bounding box with strict keys { x, y, width, height } and scale coordinates', () => {
      // Alias keys { left, top, w, h }
      const bbox1 = normalizeBoundingBox({ left: 0.1, top: 0.2, w: 0.3, h: 0.4 });
      assert.deepStrictEqual(bbox1, { x: 0.1, y: 0.2, width: 0.3, height: 0.4 });

      // 0-1000 scale normalization
      const bbox1000 = normalizeBoundingBox({ x: 120, y: 340, width: 85, height: 22 });
      assert.strictEqual(bbox1000.x, 0.12);
      assert.strictEqual(bbox1000.y, 0.34);
      assert.strictEqual(bbox1000.width, 0.085);
      assert.strictEqual(bbox1000.height, 0.022);

      // xmin, ymin, xmax, ymax
      const bboxMinMax = normalizeBoundingBox({ xmin: 100, ymin: 200, xmax: 600, ymax: 500 });
      assert.strictEqual(bboxMinMax.x, 0.1);
      assert.strictEqual(bboxMinMax.y, 0.2);
      assert.strictEqual(bboxMinMax.width, 0.5);
      assert.strictEqual(bboxMinMax.height, 0.3);
    });

    it('should store and retrieve page_number, normalized bounding_box, and raw_source_value', async () => {
      const enqueued = await enqueueJob({
        merchant_id: merchantId,
        file_id: fileId,
        model_version_id: modelVersionId
      });
      createdJobIds.push(enqueued.job_id);

      const boundingBoxData = { x: 0.125, y: 0.35, w: 0.42, h: 0.08 };

      const ingestRes = await ingestExtractedProduct({
        merchant_id: merchantId,
        job_id: enqueued.job_id,
        model_version_id: modelVersionId,
        productData: {
          supplier_sku: 'LINEAGE-SKU-001',
          material: {
            value: 'Carbon Steel',
            page_number: 3,
            bounding_box: boundingBoxData,
            raw_source_value: 'Material: Carbon Steel (AISI 1045)'
          },
          weight: {
            value: 1300,
            page_number: 3,
            bounding_box: { x: 0.125, y: 0.45, w: 0.25, h: 0.05 },
            raw_source_value: '1.3 kg'
          }
        },
        computeGaps: true,
        schemaSnapshot
      });
      createdProductIds.push(ingestRes.productId);

      // Verify attributes directly in PostgreSQL
      const attrRes = await pool.query(
        'SELECT * FROM extracted_attributes WHERE product_id = $1 ORDER BY attribute_key ASC',
        [ingestRes.productId]
      );
      assert.strictEqual(attrRes.rows.length, 2);

      const materialAttr = attrRes.rows.find((a) => a.attribute_key === 'material');
      assert.ok(materialAttr);
      assert.strictEqual(materialAttr.page_number, 3);
      assert.strictEqual(materialAttr.raw_source_value, 'Material: Carbon Steel (AISI 1045)');
      assert.deepStrictEqual(materialAttr.bounding_box, { x: 0.125, y: 0.35, width: 0.42, height: 0.08 });
      assert.strictEqual(materialAttr.confidence_score, 95);

      const weightAttr = attrRes.rows.find((a) => a.attribute_key === 'weight');
      assert.ok(weightAttr);
      assert.strictEqual(weightAttr.page_number, 3);
      assert.strictEqual(weightAttr.raw_source_value, '1.3 kg');
      // Confidence score calculated via Rule 2 canonical unit conversion
      assert.strictEqual(weightAttr.confidence_score, 85);
    });
  });

  // =========================================================================
  // 5. Extraction Worker End-to-End Execution
  // =========================================================================
  describe('5. Extraction Worker Execution & Transaction Integrity', () => {
    it('Fix 2: should map tabular CSV cells to raw_source_value and set source_column', async () => {
      const enqueued = await enqueueJob({
        merchant_id: merchantId,
        file_id: fileId,
        model_version_id: modelVersionId,
        total_records: 1
      });
      createdJobIds.push(enqueued.job_id);

      // Raw CSV item with exact headers
      const csvRow = {
        'Supplier SKU': 'TABULAR-PROV-SKU-1',
        'Material': 'Stainless Steel',
        'Weight': '1.3 kg'
      };

      const processedJob = await processJob(enqueued.job_id, {
        items: [csvRow]
      });

      assert.strictEqual(processedJob.status, 'COMPLETED');

      const prodRes = await pool.query('SELECT id FROM extracted_products WHERE supplier_sku = $1', ['TABULAR-PROV-SKU-1']);
      assert.strictEqual(prodRes.rows.length, 1);
      createdProductIds.push(prodRes.rows[0].id);

      const attrs = await pool.query('SELECT * FROM extracted_attributes WHERE product_id = $1', [prodRes.rows[0].id]);
      const mat = attrs.rows.find((a) => a.attribute_key === 'material');
      assert.ok(mat);
      assert.strictEqual(mat.source_column, 'Material');
      assert.strictEqual(mat.raw_source_value, 'Stainless Steel');
      assert.strictEqual(mat.confidence_score, 100);

      const wt = attrs.rows.find((a) => a.attribute_key === 'weight');
      assert.ok(wt);
      assert.strictEqual(wt.source_column, 'Weight');
      assert.strictEqual(wt.raw_source_value, '1.3 kg');
    });

    it('should process job end-to-end, computing confidence, persisting lineage, and resolving states', async () => {
      const enqueued = await enqueueJob({
        merchant_id: merchantId,
        file_id: fileId,
        model_version_id: modelVersionId,
        total_records: 2
      });
      createdJobIds.push(enqueued.job_id);

      const testItems = [
        {
          supplier_sku: 'WORKER-E2E-ENRICHED',
          material: 'High Tensile Steel',
          raw_source_value: 'High Tensile Steel, 250g, zinc finish',
          page_number: 1,
          bounding_box: { x: 0.1, y: 0.1, w: 0.5, h: 0.1 },
          weight: 250,
          finish: 'zinc'
        },
        {
          supplier_sku: 'WORKER-E2E-NEEDS-REVIEW',
          material: 'Cast Iron',
          raw_source_value: 'Cast Iron, finish: unsupported_finish',
          page_number: 2,
          bounding_box: { x: 0.2, y: 0.2, w: 0.4, h: 0.1 },
          finish: 'unsupported_finish' // Schema error -> causes NEEDS_REVIEW
        }
      ];

      const processedJob = await processJob(enqueued.job_id, {
        items: testItems
      });

      assert.strictEqual(processedJob.status, 'COMPLETED');
      assert.strictEqual(processedJob.total_records, 2);
      assert.strictEqual(processedJob.processed_records, 2);
      assert.strictEqual(processedJob.failed_records, 0);

      // Verify product 1 is ENRICHED
      const prod1Res = await pool.query(
        'SELECT * FROM extracted_products WHERE merchant_id = $1 AND supplier_sku = $2',
        [merchantId, 'WORKER-E2E-ENRICHED']
      );
      assert.strictEqual(prod1Res.rows.length, 1);
      createdProductIds.push(prod1Res.rows[0].id);
      assert.strictEqual(prod1Res.rows[0].state, 'ENRICHED');

      // Verify product 2 is NEEDS_REVIEW
      const prod2Res = await pool.query(
        'SELECT * FROM extracted_products WHERE merchant_id = $1 AND supplier_sku = $2',
        [merchantId, 'WORKER-E2E-NEEDS-REVIEW']
      );
      assert.strictEqual(prod2Res.rows.length, 1);
      createdProductIds.push(prod2Res.rows[0].id);
      assert.strictEqual(prod2Res.rows[0].state, 'NEEDS_REVIEW');

      // Verify product 2 has 1 gap in product_gaps
      const gaps2Res = await pool.query(
        'SELECT * FROM product_gaps WHERE product_id = $1',
        [prod2Res.rows[0].id]
      );
      assert.strictEqual(gaps2Res.rows.length, 1);
      assert.strictEqual(gaps2Res.rows[0].gap_type, 'schema_error');
    });

    it('Fix 9: Atomic transaction rollback: if ingestion fails mid-way after product upsert, attributes and product state are cleanly rolled back', async () => {
      const enqueued = await enqueueJob({
        merchant_id: merchantId,
        file_id: fileId,
        model_version_id: modelVersionId
      });
      createdJobIds.push(enqueued.job_id);

      const rollbackSku = 'TX-ROLLBACK-TEST-SKU';

      // Connect real client and begin transaction
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Create a wrapper client that allows the product upsert (1st query),
        // but throws an error on the 3rd query (during attribute write)
        let queryCounter = 0;
        const failingClient = {
          query: async (...args) => {
            queryCounter++;
            if (queryCounter === 3) {
              throw new Error('Simulated database write failure during attribute insertion');
            }
            return client.query(...args);
          }
        };

        await assert.rejects(
          async () => {
            await ingestExtractedProduct(
              {
                merchant_id: merchantId,
                job_id: enqueued.job_id,
                model_version_id: modelVersionId,
                productData: {
                  supplier_sku: rollbackSku,
                  material: 'Steel',
                  weight: 100
                },
                client: failingClient
              },
              failingClient
            );
          },
          /Simulated database write failure/
        );

        await client.query('ROLLBACK');
      } finally {
        client.release();
      }

      // Verify product record was cleanly rolled back and does not exist in PostgreSQL
      const orphanCheck = await pool.query(
        'SELECT * FROM extracted_products WHERE supplier_sku = $1',
        [rollbackSku]
      );
      assert.strictEqual(orphanCheck.rows.length, 0);
    });
  });
});
