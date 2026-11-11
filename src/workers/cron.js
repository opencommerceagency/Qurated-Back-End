import { pool } from '../db/index.js';
import { streamHvhXml } from '../adapters/hvhAdapter.js';
import { ingestCsvStream } from '../services/csvParser.js';
import { ingestXlsxStream } from '../services/xlsxParser.js';
import { ingestXmlStream } from '../services/xmlParser.js';
import { fetchSourceStream } from '../adapters/fetcherFactory.js';
import parser from 'cron-parser';

// Purpose: Automatically kicks off data syncs for sources that are on a schedule.
// Pseudocode: 
// 1. Make sure we have a way to track the last run time in the database.
// 2. Every 60 seconds, look for sources that are 'ACTIVE' and have a cron schedule.
// 3. For each active source, check if it's already doing a sync. If it is, skip it.
// 4. If it's free, create a new run record and start the sync.
// Inputs: Database connection.
// Outputs: New ingestion run records and updated catalog data.
// Edge cases: Skips if a sync is currently locked/processing, gracefully handles missing columns on start.
export function startCronWorker() {
    console.log('Cron worker started, checking for scheduled syncs every minute...');
    
    // First, let's quietly make sure the database has a column to track the last time a sync ran.
    // We use a safe IF NOT EXISTS block so it won't break if it's already there.
    pool.query(`
        DO $$ 
        BEGIN 
            IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='sources' AND column_name='last_run_at') THEN
                ALTER TABLE sources ADD COLUMN last_run_at TIMESTAMP;
            END IF;
        END $$;
    `).catch(err => console.error('Failed to add last_run_at column:', err));

    // Start our infinite loop that ticks every 1 minute.
    setInterval(async () => {
        try {
            // Go find all the sources that are active and actually have a schedule set.
            const sourcesResult = await pool.query(
                "SELECT * FROM sources WHERE status = 'ACTIVE' AND schedule_cron IS NOT NULL"
            );

            // Loop through each source we found.
            for (const source of sourcesResult.rows) {
                try {
                    // Scenario 3: Cron Scheduler Idempotency
                    // Verify if it's ACTUALLY due according to its cron schedule
                    try {
                        const interval = parser.parseExpression(source.schedule_cron);
                        const prevRunDue = interval.prev().toDate();
                        const lastRun = source.last_run_at ? new Date(source.last_run_at) : new Date(0);
                        
                        // If the most recent cron trigger time is strictly BEFORE OR EQUAL TO the last run time, 
                        // it means we've already ran the job for this interval. Skip it.
                        if (prevRunDue <= lastRun) {
                            continue;
                        }
                    } catch (cronErr) {
                        console.error(`Invalid cron schedule for source ${source.id}:`, cronErr);
                        continue;
                    }

                    // CONCURRENCY LOCK: Let's check if this specific source is already busy running a sync.
                    const activeRun = await pool.query(
                        "SELECT id FROM ingestion_runs WHERE source_id = $1 AND status = 'PROCESSING'",
                        [source.id]
                    );

                    // If it is busy, just skip it and move on to the next source.
                    if (activeRun.rows.length > 0) {
                        continue; 
                    }
                    
                    // It's not busy! Let's lock it by creating a new run record marked as 'PROCESSING'.
                    const runResult = await pool.query(
                        `INSERT INTO ingestion_runs (source_id, merchant_id, status, started_at)
                         VALUES ($1, $2, 'PROCESSING', NOW())
                         RETURNING id`,
                        [source.id, source.merchant_id]
                    );
                    const runId = runResult.rows[0].id;

                    // Update the timestamp on the source so we know when it last started.
                    await pool.query(
                        "UPDATE sources SET last_run_at = NOW() WHERE id = $1",
                        [source.id]
                    );

                    // Now kick off the actual downloading and parsing in the background.
                    (async () => {
                        let totalRows = 0;
                        let validRows = 0;
                        let failedRows = 0;

                        try {
                            // Use our factory to get the remote stream
                            const stream = await fetchSourceStream(source, runId);

                            // Use the correct parser based on source type
                            const sourceType = (source.type || '').toLowerCase();
                            if (sourceType === 'xlsx' || sourceType === 'excel') {
                                const stats = await ingestXlsxStream(stream, source, source.merchant_id, runId);
                                totalRows = stats.totalRows;
                                validRows = stats.validRows;
                                failedRows = stats.failedRows;
                            } else if (sourceType === 'xml') {
                                const stats = await ingestXmlStream(stream, source, source.merchant_id, runId);
                                totalRows = stats.totalRows;
                                validRows = stats.validRows;
                                failedRows = stats.failedRows;
                            } else if (sourceType === 'csv') {
                                const stats = await ingestCsvStream(stream, source, source.merchant_id, runId);
                                totalRows = stats.totalRows;
                                validRows = stats.validRows;
                                failedRows = stats.failedRows;
                            } else {
                                // Fallback legacy callback
                                await streamHvhXml(stream, (record) => {
                                    totalRows++;
                                    if (record && !record.is_flagged) {
                                        validRows++;
                                    } else {
                                        failedRows++;
                                    }
                                });
                            }

                            // We finished successfully! Update the run record to show it's done.
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
                            // Uh oh, something broke during the sync. Mark it as failed so we can check it later.
                            // Retain partial counts recorded by the parser instead of resetting them to 0
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
    }, 60000); // Wait 60 seconds before checking again.
}
