import { pool } from '../db/index.js';
import { sourceCreateSchema, sourceUpdateSchema } from '../schemas/sourceSchema.js';
import { streamHvhXml } from '../adapters/hvhAdapter.js';
import { ingestCsvStream } from '../services/csvParser.js';
import { fetchSourceStream } from '../adapters/fetcherFactory.js';

// Recursively redact sensitive tokens, passwords, and connection secrets from payloads
export function maskSourceCredentials(source) {
  if (!source || typeof source !== 'object') return source;

  const masked = Array.isArray(source) ? [...source] : { ...source };
  const sensitiveKeys = [
    'password',
    'api_key',
    'apikey',
    'token',
    'secret',
    'client_secret',
    'access_token',
    'private_key'
  ];

  for (const [key, value] of Object.entries(masked)) {
    if (value && typeof value === 'object') {
      masked[key] = maskSourceCredentials(value);
    } else if (typeof key === 'string' && sensitiveKeys.includes(key.toLowerCase()) && value) {
      masked[key] = '********';
    } else if (typeof value === 'string' && key === 'error_message') {
      masked[key] = value.replace(/:\/\/([^:]+):([^@]+)@/g, (m, u) => `://${u}:********@`);
    }
  }

  return masked;
}

// Strip embedded basic auth credentials from database and network error messages
export function scrubError(err) {
  const msg = err?.message || String(err);
  return msg.replace(/:\/\/([^:]+):([^@]+)@/g, (m, u) => `://${u}:********@`);
}

// List all active data sources for the requesting merchant
export async function getSources(req, res) {
  try {
    const statusFilter = req.query.status;
    let result;

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

    const maskedSources = result.rows.map(maskSourceCredentials);
    return res.json({ sources: maskedSources });
  } catch (error) {
    return res.status(500).json({ error: scrubError(error) });
  }
}

// Fetch details for a specific ingestion run scoped to the merchant
export async function getRunById(req, res) {
  try {
    const result = await pool.query(
      'SELECT * FROM ingestion_runs WHERE id = $1 AND merchant_id = $2',
      [req.params.runId, req.merchantId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Run not found' });
    }

    return res.json(maskSourceCredentials(result.rows[0]));
  } catch (error) {
    return res.status(500).json({ error: scrubError(error) });
  }
}

// Fetch run history and execution duration for a specific data source
export async function getSourceRuns(req, res) {
  try {
    const result = await pool.query(
      `SELECT *, 
          EXTRACT(EPOCH FROM (COALESCE(finished_at, NOW()) - started_at)) AS duration_seconds 
       FROM ingestion_runs 
       WHERE source_id = $1 AND merchant_id = $2 
       ORDER BY started_at DESC`,
      [req.params.id, req.merchantId]
    );
    return res.json({ runs: result.rows.map(maskSourceCredentials) });
  } catch (error) {
    return res.status(500).json({ error: scrubError(error) });
  }
}

// Fetch a single source configuration by ID
export async function getSourceById(req, res) {
  try {
    const result = await pool.query(
      'SELECT * FROM sources WHERE id = $1 AND merchant_id = $2',
      [req.params.id, req.merchantId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Source not found' });
    }

    return res.json(maskSourceCredentials(result.rows[0]));
  } catch (error) {
    return res.status(500).json({ error: scrubError(error) });
  }
}

// Create a new supplier data source scoped to the caller's merchant ID
export async function createSource(req, res) {
  const parsed = sourceCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ errors: parsed.error.flatten() });
  }

  const { name, type, protocol, default_model_id, connection_config, dialect_config, schedule_cron } =
    parsed.data;

  try {
    const result = await pool.query(
      `INSERT INTO sources (merchant_id, name, type, protocol, default_model_id, connection_config, dialect_config, schedule_cron)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        req.merchantId,
        name,
        type,
        protocol,
        default_model_id,
        connection_config,
        dialect_config,
        schedule_cron || null
      ]
    );

    return res.status(201).json(maskSourceCredentials(result.rows[0]));
  } catch (error) {
    return res.status(500).json({ error: scrubError(error) });
  }
}

// Trigger an immediate manual ingestion sync in the background
export async function syncSource(req, res) {
  try {
    const sourceResult = await pool.query(
      'SELECT * FROM sources WHERE id = $1 AND merchant_id = $2',
      [req.params.id, req.merchantId]
    );

    if (sourceResult.rows.length === 0) {
      return res.status(404).json({ error: 'Source not found' });
    }

    const source = sourceResult.rows[0];

    // Concurrency lock: prevent parallel runs on the same source
    const activeRunResult = await pool.query(
      "SELECT id FROM ingestion_runs WHERE source_id = $1 AND merchant_id = $2 AND status = 'PROCESSING'",
      [source.id, req.merchantId]
    );
    if (activeRunResult.rows.length > 0) {
      return res.status(409).json({ error: 'Sync already in progress for this source' });
    }

    const runResult = await pool.query(
      `INSERT INTO ingestion_runs (source_id, merchant_id, status, started_at)
       VALUES ($1, $2, 'PROCESSING', NOW())
       RETURNING id`,
      [source.id, req.merchantId]
    );

    const runId = runResult.rows[0].id;

    res.status(202).json({
      message: 'Ingestion started',
      run_id: runId
    });

    // Run the streaming pipeline in the background so the HTTP response returns immediately
    (async () => {
      let totalRows = 0;
      let validRows = 0;
      let failedRows = 0;

      try {
        const stream = await fetchSourceStream(source, runId);

        if (source.type && source.type.toLowerCase() === 'csv') {
          const stats = await ingestCsvStream(stream, source, req.merchantId, runId);
          totalRows = stats.totalRows;
          validRows = stats.validRows;
          failedRows = stats.failedRows;
        } else {
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
        await pool.query(
          `UPDATE ingestion_runs 
           SET status = 'FAILED',
               error_message = $1,
               finished_at = NOW()
           WHERE id = $2 AND merchant_id = $3`,
          [bgError.message, runId, req.merchantId]
        );
      }
    })().catch((err) => console.error('Background sync failure for source', source.id, err));
  } catch (error) {
    return res.status(500).json({ error: scrubError(error) });
  }
}

// Update configuration or status of an existing data source
export async function updateSource(req, res) {
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
      return res.json(maskSourceCredentials(checkResult.rows[0]));
    }

    const queryParams = [];
    const setStatements = [];
    let paramIndex = 1;

    for (const [key, value] of Object.entries(updates)) {
      setStatements.push(`${key} = $${paramIndex}`);
      queryParams.push(value);
      paramIndex++;
    }

    if (updates.status === 'ARCHIVED') {
      setStatements.push('archived_at = NOW()');
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
    return res.json(maskSourceCredentials(updateResult.rows[0]));
  } catch (error) {
    return res.status(500).json({ error: scrubError(error) });
  }
}

// Soft delete a source: marks status as ARCHIVED to preserve run history and lineage
export async function deleteSource(req, res) {
  try {
    const result = await pool.query(
      "UPDATE sources SET status = 'ARCHIVED', archived_at = NOW() WHERE id = $1 AND merchant_id = $2 RETURNING id",
      [req.params.id, req.merchantId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Source not found' });
    }

    return res.json({ status: 'deleted', id: result.rows[0].id });
  } catch (error) {
    return res.status(500).json({ error: scrubError(error) });
  }
}

export default {
  maskSourceCredentials,
  scrubError,
  getSources,
  getRunById,
  getSourceRuns,
  getSourceById,
  createSource,
  syncSource,
  updateSource,
  deleteSource
};
