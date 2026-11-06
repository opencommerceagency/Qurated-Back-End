-- Up Migration
CREATE TABLE IF NOT EXISTS files (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id UUID NOT NULL,
    filename VARCHAR(255) NOT NULL,
    file_path TEXT,
    file_size BIGINT NOT NULL DEFAULT 0,
    mime_type VARCHAR(100),
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_files_merchant_id ON files(merchant_id);

CREATE TABLE IF NOT EXISTS extraction_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id UUID NOT NULL,
    file_id UUID NOT NULL,
    model_version_id UUID NOT NULL REFERENCES product_model_versions(id) ON DELETE RESTRICT,
    status VARCHAR(32) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'PARTIALLY_FAILED', 'FAILED')),
    total_records INT NOT NULL DEFAULT 0,
    processed_records INT NOT NULL DEFAULT 0,
    failed_records INT NOT NULL DEFAULT 0,
    job_errors JSONB NOT NULL DEFAULT '[]'::jsonb,
    attempts INT NOT NULL DEFAULT 0,
    max_attempts INT NOT NULL DEFAULT 3,
    logs TEXT,
    next_retry_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_extraction_jobs_merchant_status ON extraction_jobs(merchant_id, status);
CREATE INDEX IF NOT EXISTS idx_extraction_jobs_model_version_id ON extraction_jobs(model_version_id);

-- Down Migration
DROP TABLE IF EXISTS extraction_jobs;
DROP TABLE IF EXISTS files;
