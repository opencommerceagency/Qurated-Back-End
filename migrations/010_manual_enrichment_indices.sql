-- Up Migration
CREATE INDEX IF NOT EXISTS idx_extracted_products_merchant_state ON extracted_products(merchant_id, state);
CREATE INDEX IF NOT EXISTS idx_product_gaps_product_id ON product_gaps(product_id);

ALTER TABLE extracted_attributes
    ADD COLUMN IF NOT EXISTS is_manually_overridden BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS overridden_by VARCHAR(255) NULL,
    ADD COLUMN IF NOT EXISTS overridden_at TIMESTAMPTZ NULL;

-- Down Migration
DROP INDEX IF EXISTS idx_extracted_products_merchant_state;

