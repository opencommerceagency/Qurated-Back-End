-- Up Migration
CREATE TABLE IF NOT EXISTS product_model_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    model_id UUID NOT NULL REFERENCES product_models(id) ON DELETE CASCADE,
    version INT NOT NULL,
    snapshot JSONB NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_product_model_versions_model_version ON product_model_versions(model_id, version);

-- Down Migration
DROP TABLE IF EXISTS product_model_versions;
