-- Up Migration
CREATE INDEX IF NOT EXISTS idx_extracted_products_merchant_state_created_at
    ON extracted_products(merchant_id, state, created_at DESC);

-- Down Migration
DROP INDEX IF EXISTS idx_extracted_products_merchant_state_created_at;
