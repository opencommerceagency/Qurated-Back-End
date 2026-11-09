-- Up Migration
CREATE TABLE IF NOT EXISTS product_gaps (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id UUID NOT NULL REFERENCES extracted_products(id) ON DELETE CASCADE,
    attribute_key VARCHAR(100) NOT NULL,
    gap_type VARCHAR(32) NOT NULL CHECK (gap_type IN ('missing_required', 'low_confidence', 'schema_error')),
    details TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_product_gaps_product_id ON product_gaps(product_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_product_gaps_attr ON product_gaps(product_id, attribute_key, gap_type);

-- Ensure extracted_attributes supports bounding boxes and lineage
ALTER TABLE extracted_attributes
    ADD COLUMN IF NOT EXISTS page_number INT,
    ADD COLUMN IF NOT EXISTS bounding_box JSONB,
    ADD COLUMN IF NOT EXISTS raw_source_value TEXT,
    ADD COLUMN IF NOT EXISTS confidence_score INT NOT NULL DEFAULT 100;

-- Down Migration
DROP TABLE IF EXISTS product_gaps;
