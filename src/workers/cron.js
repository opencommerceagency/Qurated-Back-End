import { pool } from '../db/index.js';
import { streamHvhXml } from '../adapters/hvhAdapter.js';
import { ingestCsvStream } from '../services/csvParser.js';
import { fetchSourceStream } from '../adapters/fetcherFactory.js';
import parser from 'cron-parser';

// Background cron worker: polls active scheduled sources every 60 seconds and triggers syncs
export function startCronWorker() {
    console.log('Cron worker started, checking for scheduled syncs every minute...');
    
    // Ensure the last_run_at tracking column exists on sources
    pool.query(`
        DO $$ 
        BEGIN 
            IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='sources' AND column_name='last_run_at') THEN
                ALTER TABLE sources ADD COLUMN last_run_at TIMESTAMP;
            END IF;
        END $$;
    `).catch(err => console.error('Failed to add last_run_at column:', err));

    // Poll every 60 seconds for due schedules
    setInterval(async () => {
        try {
            // Fetch active sources with configured cron expressions
            const sourcesResult = await pool.query(
                "SELECT * FROM sources WHERE status = 'ACTIVE' AND schedule_cron IS NOT NULL"
            );

            for (const source of sourcesResult.rows) {
                try {
                    // Idempotency check: verify if the source is due based on its last run
                    try {
                        const interval = parser.parseExpression(source.schedule_cron);
                        const prevRunDue = interval.prev().toDate();
                        const lastRun = source.last_run_at ? new Date(source.last_run_at) : new Date(0);
                        
                        // Skip if already executed for this interval
                        if (prevRunDue <= lastRun) {
                            continue;
                        }
                    } catch (cronErr) {
                        console.error(`Invalid cron schedule for source ${source.id}:`, cronErr);
                        continue;
                    }

                    // Concurrency lock: skip if a sync is already running for this source
                    const activeRun = await pool.query(
                        "SELECT id FROM ingestion_runs WHERE source_id = $1 AND status = 'PROCESSING'",
                        [source.id]
                    );

                    if (activeRun.rows.length > 0) {
                        continue; 
                    }
                    
                    // Acquire lock by inserting a run in PROCESSING status
                    const runResult = await pool.query(
                        `INSERT INTO ingestion_runs (source_id, merchant_id, status, started_at)
                         VALUES ($1, $2, 'PROCESSING', NOW())
                         RETURNING id`,
                        [source.id, source.merchant_id]
                    );
                    const runId = runResult.rows[0].id;

                    // Record sync start timestamp on source
                    await pool.query(
                        "UPDATE sources SET last_run_at = NOW() WHERE id = $1",
                        [source.id]
                    );

                    // Execute streaming pipeline in the background
                    (async () => {
                        let totalRows = 0;
                        let validRows = 0;
                        let failedRows = 0;

                        try {
                            // Fetch remote stream via transport factory
                            const stream = await fetchSourceStream(source, runId);

                            // Use the correct parser based on source type
                            if (source.type && source.type.toLowerCase() === 'csv') {
                                const stats = await ingestCsvStream(stream, source, source.merchant_id, runId);
                                totalRows = stats.totalRows;
                                validRows = stats.validRows;
                                failedRows = stats.failedRows;
                            } else {
                                // Stream and parse XML payload
                                await streamHvhXml(stream, (record) => {
                                    totalRows++;
                                    if (record && !record.is_flagged) {
                                        validRows++;
                                    } else {
                                        failedRows++;
                                    }
                                });
                            }

                            // Mark run as COMPLETED with row counts
                            await pool.query(
                                `UPDATE ingestion_runs 
                                 SET status = 'COMPLETED',
                                     total_rows = $1,
                                     valid_rows = $2,
                                     failed_rows = $3,
                                     finished_at = NOW()
                                 WHERE id = $4`,
                                [totalRows, validRows, failedRows, runId]
                            );
                        } catch (bgError) {
                            // Record failure while retaining partial row counts
                            await pool.query(
                                `UPDATE ingestion_runs 
                                 SET status = 'FAILED',
                                     error_message = $1,
                                     finished_at = NOW()
                                 WHERE id = $2`,
                                [bgError.message, runId]
                            );
                        }
                    })().catch(err => console.error(`Background cron sync failure for source ${source.id}:`, err));

                } catch (err) {
                    console.error(`Error processing source ${source.id}:`, err);
                }
            }
        } catch (err) {
            console.error('Error in cron worker loop:', err);
        }
    }, 60000);
}
