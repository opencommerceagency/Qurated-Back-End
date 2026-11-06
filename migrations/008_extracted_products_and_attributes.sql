-- Up Migration
CREATE TABLE IF NOT EXISTS extracted_products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id UUID NOT NULL,
    job_id UUID NOT NULL REFERENCES extraction_jobs(id) ON DELETE CASCADE,
    model_version_id UUID NOT NULL REFERENCES product_model_versions(id) ON DELETE RESTRICT,
    supplier_sku VARCHAR(255) NOT NULL,
    state VARCHAR(32) NOT NULL DEFAULT 'PROCESSING' CHECK (state IN ('PROCESSING', 'NEEDS_REVIEW', 'ENRICHED', 'FAILED_EXTRACTION')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_extracted_products_sku ON extracted_products(merchant_id, model_version_id, supplier_sku);
CREATE INDEX IF NOT EXISTS idx_extracted_products_job_id ON extracted_products(job_id);
CREATE INDEX IF NOT EXISTS idx_extracted_products_merchant_id ON extracted_products(merchant_id);

CREATE TABLE IF NOT EXISTS extracted_attributes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id UUID NOT NULL REFERENCES extracted_products(id) ON DELETE CASCADE,
    attribute_key VARCHAR(100) NOT NULL,
    value JSONB NOT NULL,
    confidence_score INT NOT NULL DEFAULT 100,
    source_file_id UUID NULL,
    source_row_index INT NULL,
    source_column VARCHAR(100) NULL,
    page_number INT NULL,
    bounding_box JSONB NULL,
    raw_source_value TEXT NULL,
    is_manually_overridden BOOLEAN NOT NULL DEFAULT false,
    overridden_by VARCHAR(255) NULL,
    overridden_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_extracted_attributes_key ON extracted_attributes(product_id, attribute_key);
CREATE INDEX IF NOT EXISTS idx_extracted_attributes_product_id ON extracted_attributes(product_id);

-- Down Migration
DROP TABLE IF EXISTS extracted_attributes;
DROP TABLE IF EXISTS extracted_products;
