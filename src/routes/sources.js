import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/index.js';
import { sourceCreateSchema, sourceUpdateSchema } from '../schemas/sourceSchema.js';
import { streamHvhXml } from '../adapters/hvhAdapter.js';
import { ingestCsvStream } from '../services/csvParser.js';
import { ingestXlsxStream } from '../services/xlsxParser.js';
import { ingestXmlStream } from '../services/xmlParser.js';
import { fetchSourceStream } from '../adapters/fetcherFactory.js';
import { authenticateApi } from '../middleware/auth.js';

const router = Router();

// this will make sure its safe: protecting /api/sources routes with authentication
router.use(authenticateApi);

// this will make sure its safe: redacting secret keys and passwords from source responses
export function maskSourceCredentials(source) {
    if (!source || typeof source !== 'object') return source;

    const masked = { ...source };
    const sensitiveKeys = ['password', 'api_key', 'apiKey', 'token', 'secret', 'client_secret', 'access_token'];

    // redacting top-level secret fields if present
    for (const key of sensitiveKeys) {
        if (masked[key]) {
            masked[key] = '********';
        }
    }

    // redacting nested connection_config secrets
    if (masked.connection_config && typeof masked.connection_config === 'object') {
        const config = { ...masked.connection_config };
        for (const key of sensitiveKeys) {
            if (config[key]) {
                config[key] = '********';
            }
        }
        masked.connection_config = config;
    }

    return masked;
}

// standard UUID regex pattern matching 8-4-4-4-12 hex format
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const merchantIdSchema = z.string().regex(UUID_REGEX, 'Must be a valid UUID');

// this will make sure its safe: strictly validating x-merchant-id as a valid UUID
router.use((req, res, next) => {
    const rawMerchantId = req.headers['x-merchant-id'];
    const parseResult = merchantIdSchema.safeParse(rawMerchantId);

    if (!parseResult.success) {
        return res.status(400).json({
            error: 'Invalid or missing x-merchant-id header. Must be a valid UUID.'
        });
    }

    req.merchantId = parseResult.data;
    next();
});

// Purpose: Get a list of all data sources set up by this merchant.
// Pseudocode: Runs a simple SQL query to grab everything from the sources table for the current merchant.
router.get('/', async (req, res) => {
    try {
        const statusFilter = req.query.status;
        let result;
        
        // If a status is explicitly requested, filter by it.
        // Otherwise, return everything that is NOT archived.
        if (statusFilter) {
            result = await pool.query(
                'SELECT * FROM sources WHERE merchant_id = $1 AND status = $2 ORDER BY created_at DESC',
                [req.merchantId, statusFilter.toUpperCase()]
            );
        } else {
            result = await pool.query(
                "SELECT * FROM sources WHERE merchant_id = $1 AND status != 'ARCHIVED' ORDER BY created_at DESC",
                [req.merchantId]
            );
        }

        // Scenario 5: Sensitive Credential Masking
        const maskedSources = result.rows.map(maskSourceCredentials);

        res.json({ sources: maskedSources });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Purpose: Get the exact details of one specific ingestion run.
// Pseudocode: Looks up the run by its ID in the database and makes sure it belongs to the merchant.
router.get('/runs/:runId', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM ingestion_runs WHERE id = $1 AND merchant_id = $2',
            [req.params.runId, req.merchantId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Run not found' });
        }

        res.json(maskSourceCredentials(result.rows[0]));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Purpose: Fetch all the runs for a specific source to show a history of syncs.
// Pseudocode: 
// 1. Look up all the run records for this source ID.
// 2. Make sure they belong to the current merchant.
// 3. Calculate how long each run took by finding the difference between start and finish.
// 4. Return the list.
// Edge cases: If a run is still processing, it calculates duration up to the current moment.
router.get('/:id/runs', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT *, 
                EXTRACT(EPOCH FROM (COALESCE(finished_at, NOW()) - started_at)) AS duration_seconds 
             FROM ingestion_runs 
             WHERE source_id = $1 AND merchant_id = $2 
             ORDER BY started_at DESC`,
            [req.params.id, req.merchantId]
        );
        res.json({ runs: result.rows.map(maskSourceCredentials) });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Purpose: Get the exact details of one specific data source.
// Pseudocode: Looks up the source by its ID and makes sure it belongs to the merchant.
router.get('/:id', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM sources WHERE id = $1 AND merchant_id = $2',
            [req.params.id, req.merchantId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Source not found' });
        }

        // Scenario 5: Sensitive Credential Masking
        res.json(maskSourceCredentials(result.rows[0]));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Purpose: Create a brand new data source for a merchant.
// Pseudocode: 
// 1. Validate the incoming data using our Zod schema.
// 2. If it's valid, insert a new row into the sources table.
// 3. Return the newly created source back to the user.
router.post('/', async (req, res) => {
    const parsed = sourceCreateSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ errors: parsed.error.flatten() });
    }

    // this is what sander asked: keeping format and protocol strictly separate
    const { name, type, protocol, default_model_id, connection_config, dialect_config, schedule_cron } = parsed.data;

    try {
        const result = await pool.query(
            `INSERT INTO sources (merchant_id, name, type, protocol, default_model_id, connection_config, dialect_config, schedule_cron)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING *`,
            [req.merchantId, name, type, protocol, default_model_id, connection_config, dialect_config, schedule_cron || null]
        );

        res.status(201).json(maskSourceCredentials(result.rows[0]));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Purpose: Manually start a data sync for a specific source.
// Pseudocode:
// 1. Find the source to make sure it exists.
// 2. Check if a sync is already running right now. If yes, stop and tell the user.
// 3. If it's free, create a new run record marked as 'PROCESSING'.
// 4. Immediately tell the user it started (HTTP 202) so they don't have to wait.
// 5. In the background, stream the data, count the records, and save the final status.
// Inputs: Source ID from the URL, Merchant ID from the headers.
// Outputs: A run_id right away, then database updates later.
// Edge cases: Prevents two syncs from running at the same time (concurrency lock). Gracefully saves errors if the stream crashes.
router.post('/:id/sync', async (req, res) => {
    try {
        const sourceResult = await pool.query(
            'SELECT * FROM sources WHERE id = $1 AND merchant_id = $2',
            [req.params.id, req.merchantId]
        );

        if (sourceResult.rows.length === 0) {
            return res.status(404).json({ error: 'Source not found' });
        }

        const source = sourceResult.rows[0];

        // Check for active processing run
        const activeRunResult = await pool.query(
            "SELECT id FROM ingestion_runs WHERE source_id = $1 AND merchant_id = $2 AND status = 'PROCESSING'",
            [source.id, req.merchantId]
        );
        if (activeRunResult.rows.length > 0) {
            return res.status(409).json({ error: 'Sync already in progress for this source' });
        }

        // Insert initial ingestion run
        const runResult = await pool.query(
            `INSERT INTO ingestion_runs (source_id, merchant_id, status, started_at)
             VALUES ($1, $2, 'PROCESSING', NOW())
             RETURNING id`,
            [source.id, req.merchantId]
        );

        const runId = runResult.rows[0].id;

        // Return 202 Accepted immediately
        res.status(202).json({
            message: 'Ingestion started',
            run_id: runId
        });

        // Background stream execution
        (async () => {
            let totalRows = 0;
            let validRows = 0;
            let failedRows = 0;

            try {
                // Dynamically fetch the stream using the fetcher factory
                const stream = await fetchSourceStream(source, runId);

                // Use the correct parser based on source type
                const sourceType = (source.type || '').toLowerCase();
                if (sourceType === 'xlsx' || sourceType === 'excel') {
                    const stats = await ingestXlsxStream(stream, source, req.merchantId, runId);
                    totalRows = stats.totalRows;
                    validRows = stats.validRows;
                    failedRows = stats.failedRows;
                } else if (sourceType === 'xml') {
                    const stats = await ingestXmlStream(stream, source, req.merchantId, runId);
                    totalRows = stats.totalRows;
                    validRows = stats.validRows;
                    failedRows = stats.failedRows;
                } else if (sourceType === 'csv') {
                    const stats = await ingestCsvStream(stream, source, req.merchantId, runId);
                    totalRows = stats.totalRows;
                    validRows = stats.validRows;
                    failedRows = stats.failedRows;
                } else {
                    // Default fallback to XML stream for testing/legacy
                    await streamHvhXml(stream, (record) => {
                        totalRows++;
                        if (record && !record.is_flagged) {
                            validRows++;
                        } else {
                            failedRows++;
                        }
                    });
                }

                await pool.query(
                    `UPDATE ingestion_runs 
                     SET status = 'COMPLETED',
                         total_rows = $1,
                         valid_rows = $2,
                         failed_rows = $3,
                         finished_at = NOW()
                     WHERE id = $4 AND merchant_id = $5`,
                    [totalRows, validRows, failedRows, runId, req.merchantId]
                );
            } catch (bgError) {
                // Retain partial counts recorded by the parser instead of resetting them to 0
                await pool.query(
                    `UPDATE ingestion_runs 
                     SET status = 'FAILED',
                         error_message = $1,
                         finished_at = NOW()
                     WHERE id = $2 AND merchant_id = $3`,
                    [bgError.message, runId, req.merchantId]
                );
            }
        })().catch(err => console.error('Background sync failure for source', source.id, err));

    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Purpose: Update an existing data source's configuration or status.
// Pseudocode: 
// 1. Check if the source exists and belongs to the merchant.
// 2. Validate the incoming data against the update schema.
// 3. Build a dynamic SQL query for only the fields provided.
// 4. Update the row and return the updated data.
router.put('/:id', async (req, res) => {
    const parsed = sourceUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ errors: parsed.error.flatten() });
    }

    try {
        const checkResult = await pool.query(
            'SELECT * FROM sources WHERE id = $1 AND merchant_id = $2',
            [req.params.id, req.merchantId]
        );

        if (checkResult.rows.length === 0) {
            return res.status(404).json({ error: 'Source not found' });
        }

        const updates = parsed.data;
        if (Object.keys(updates).length === 0) {
            return res.json(maskSourceCredentials(checkResult.rows[0])); // Nothing to update
        }

        let queryParams = [];
        let setStatements = [];
        let paramIndex = 1;

        for (const [key, value] of Object.entries(updates)) {
            setStatements.push(`${key} = $${paramIndex}`);
            queryParams.push(value);
            paramIndex++;
        }

        // Handle archiving specifically
        if (updates.status === 'ARCHIVED') {
            setStatements.push(`archived_at = NOW()`);
        }

        queryParams.push(req.params.id);
        queryParams.push(req.merchantId);
        const idIndex = paramIndex;
        const merchantIndex = paramIndex + 1;

        const updateQuery = `
            UPDATE sources 
            SET ${setStatements.join(', ')}
            WHERE id = $${idIndex} AND merchant_id = $${merchantIndex}
            RETURNING *
        `;

        const updateResult = await pool.query(updateQuery, queryParams);
        res.json(maskSourceCredentials(updateResult.rows[0]));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Purpose: Soft Delete a source from the database.
// Pseudocode: Updates the status to ARCHIVED where the ID and merchant ID match. Returns 404 if it couldn't find it.
router.delete('/:id', async (req, res) => {
    try {
        // Scenario 6: Soft Delete & Run History Retention
        const result = await pool.query(
            "UPDATE sources SET status = 'ARCHIVED', archived_at = NOW() WHERE id = $1 AND merchant_id = $2 RETURNING id",
            [req.params.id, req.merchantId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Source not found' });
        }

        res.json({ status: 'deleted', id: result.rows[0].id });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

export default router;
