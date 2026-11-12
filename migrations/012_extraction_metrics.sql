-- Up Migration
CREATE TABLE IF NOT EXISTS extraction_metrics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id UUID NOT NULL REFERENCES extraction_jobs(id) ON DELETE CASCADE,
    product_id UUID NULL REFERENCES extracted_products(id) ON DELETE SET NULL,
    model_used VARCHAR(150) NOT NULL,
    prompt_tokens INT NOT NULL DEFAULT 0,
    completion_tokens INT NOT NULL DEFAULT 0,
    is_failover BOOLEAN NOT NULL DEFAULT false,
    status VARCHAR(32) NOT NULL CHECK (status IN ('success', 'error')),
    error_message TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_extraction_metrics_job_id ON extraction_metrics(job_id);
CREATE INDEX IF NOT EXISTS idx_extraction_metrics_product_id ON extraction_metrics(product_id);
CREATE INDEX IF NOT EXISTS idx_extraction_metrics_model ON extraction_metrics(model_used);
CREATE INDEX IF NOT EXISTS idx_extraction_metrics_created_at ON extraction_metrics(created_at);

-- Down Migration
DROP TABLE IF EXISTS extraction_metrics;

