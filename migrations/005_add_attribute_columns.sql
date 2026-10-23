-- Up Migration
ALTER TABLE product_model_attributes
  ADD COLUMN IF NOT EXISTS key VARCHAR(100),
  ADD COLUMN IF NOT EXISTS unit_type VARCHAR(32),
  ADD COLUMN IF NOT EXISTS allowed_values JSONB DEFAULT '[]'::jsonb;

-- Down Migration
ALTER TABLE product_model_attributes
  DROP COLUMN IF EXISTS key,
  DROP COLUMN IF EXISTS unit_type,
  DROP COLUMN IF EXISTS allowed_values;
