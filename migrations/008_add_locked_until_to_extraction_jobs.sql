-- Up Migration
ALTER TABLE extraction_jobs ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_extraction_jobs_claim ON extraction_jobs(status, locked_until);

-- Down Migration
DROP INDEX IF EXISTS idx_extraction_jobs_claim;
ALTER TABLE extraction_jobs DROP COLUMN IF EXISTS locked_until;

