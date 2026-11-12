-- Up Migration
-- Initial schema for sources, ingestion runs, and flagged records

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS sources (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id UUID NOT NULL,
    name VARCHAR(255) NOT NULL,
    protocol VARCHAR(32) NOT NULL DEFAULT 'HTTP',
    connection_config JSONB NOT NULL DEFAULT '{}',
    dialect_config JSONB NOT NULL DEFAULT '{}',
    status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
    schedule_cron VARCHAR(64),
    created_by VARCHAR(255),
    updated_by VARCHAR(255),
    archived_at TIMESTAMPTZ,
    archived_by VARCHAR(255),
    last_run_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ingestion_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id UUID REFERENCES sources(id) ON DELETE CASCADE,
    merchant_id UUID NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'PROCESSING',
    started_at TIMESTAMPTZ DEFAULT NOW(),
    finished_at TIMESTAMPTZ,
    total_rows INT DEFAULT 0,
    valid_rows INT DEFAULT 0,
    failed_rows INT DEFAULT 0,
    error_message TEXT
);

CREATE TABLE IF NOT EXISTS flagged_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id UUID REFERENCES ingestion_runs(id) ON DELETE CASCADE,
    merchant_id UUID NOT NULL,
    row_index INT NOT NULL,
    raw_row JSONB NOT NULL,
    error_reasons JSONB NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Down Migration
-- Down migration: drops initial tables on rollback
DROP TABLE IF EXISTS flagged_records;
DROP TABLE IF EXISTS ingestion_runs;
DROP TABLE IF EXISTS sources;
