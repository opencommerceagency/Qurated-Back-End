-- Up Migration
ALTER TABLE product_model_attributes
  ADD COLUMN IF NOT EXISTS key VARCHAR(100),
  ADD COLUMN IF NOT EXISTS unit_type VARCHAR(32),
  ADD COLUMN IF NOT EXISTS allowed_values JSONB DEFAULT '[]'::jsonb;

-- Backfill allowed_values from legacy list_of_values if populated
UPDATE product_model_attributes
SET allowed_values = list_of_values
WHERE (allowed_values IS NULL OR allowed_values = '[]'::jsonb)
  AND list_of_values IS NOT NULL
  AND list_of_values != '[]'::jsonb;

-- Down Migration
ALTER TABLE product_model_attributes
  DROP COLUMN IF EXISTS key,
  DROP COLUMN IF EXISTS unit_type,
  DROP COLUMN IF EXISTS allowed_values;
