-- Up Migration
-- Ingestion pipeline tables: normalized and flagged records with tenant indexes

-- 1. ingestion_runs table and indexes
CREATE TABLE IF NOT EXISTS ingestion_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id UUID NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    merchant_id UUID NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'PROCESSING',
    started_at TIMESTAMPTZ DEFAULT NOW(),
    finished_at TIMESTAMPTZ,
    total_rows INT DEFAULT 0,
    valid_rows INT DEFAULT 0,
    failed_rows INT DEFAULT 0,
    error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_ingestion_runs_source_id ON ingestion_runs(source_id);
CREATE INDEX IF NOT EXISTS idx_ingestion_runs_merchant_id ON ingestion_runs(merchant_id);
CREATE INDEX IF NOT EXISTS idx_ingestion_runs_status ON ingestion_runs(status);

-- 2. flagged_records table and indexes
CREATE TABLE IF NOT EXISTS flagged_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id UUID NOT NULL REFERENCES ingestion_runs(id) ON DELETE CASCADE,
    merchant_id UUID NOT NULL,
    row_index INT NOT NULL,
    raw_row JSONB NOT NULL,
    error_reasons JSONB NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_flagged_records_run_id ON flagged_records(run_id);
CREATE INDEX IF NOT EXISTS idx_flagged_records_merchant_id ON flagged_records(merchant_id);

-- 3. normalized_records table and indexes
CREATE TABLE IF NOT EXISTS normalized_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id UUID NOT NULL REFERENCES ingestion_runs(id) ON DELETE CASCADE,
    merchant_id UUID NOT NULL,
    sku VARCHAR NOT NULL,
    name VARCHAR,
    price NUMERIC(12, 2),
    currency VARCHAR(3) DEFAULT 'EUR',
    ean VARCHAR(14),
    unit_value NUMERIC(10, 2),
    unit_type VARCHAR(20),
    raw_data JSONB NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_normalized_records_run_id ON normalized_records(run_id);
CREATE INDEX IF NOT EXISTS idx_normalized_records_merchant_id ON normalized_records(merchant_id);
CREATE INDEX IF NOT EXISTS idx_normalized_records_sku ON normalized_records(sku);

-- Down Migration
-- Down migration: drops normalized_records table on rollback
DROP TABLE IF EXISTS normalized_records;
