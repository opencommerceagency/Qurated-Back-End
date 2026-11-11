import { pool } from './index.js';

/**
 * Updates the ingestion_runs table to mark a run as FAILED with an error message.
 *
 * @param {string|number} runId - The ID of the ingestion run
 * @param {string} errorMessage - The error message to record
 */
export async function failIngestionRun(runId, errorMessage) {
  const query = `
    UPDATE ingestion_runs
    SET status = 'FAILED',
        finished_at = NOW(),
        error_message = $1
    WHERE id = $2
  `;
  
  try {
    await pool.query(query, [errorMessage, runId]);
  } catch (error) {
    console.error(`Failed to update ingestion run ${runId} with error:`, error);
  }
}

let columnsEnsured = false;

/**
 * Ensures that provenance tracking columns ('page_number' and 'source_column')
 * exist in the normalized_records table.
 */
export async function ensureProvenanceColumns() {
  if (columnsEnsured) return;
  try {
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name='normalized_records' AND column_name='page_number'
        ) THEN
          ALTER TABLE normalized_records ADD COLUMN page_number TEXT;
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name='normalized_records' AND column_name='source_column'
        ) THEN
          ALTER TABLE normalized_records ADD COLUMN source_column TEXT;
        END IF;
      END $$;
    `);
    columnsEnsured = true;
  } catch (err) {
    console.error('Failed to ensure provenance columns in normalized_records:', err);
  }
}

export default {
  failIngestionRun,
  ensureProvenanceColumns
};
