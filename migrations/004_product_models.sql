-- Up Migration
CREATE TABLE IF NOT EXISTS product_models (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id UUID, -- NULL means it's a shared base template anyone can clone
    name VARCHAR(255) NOT NULL,
    description TEXT,
    status VARCHAR(50) DEFAULT 'ACTIVE', -- 'ACTIVE' or 'ARCHIVED'
    schema_version INT DEFAULT 1,
    created_by VARCHAR(255) NOT NULL,
    updated_by VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS product_model_attributes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    model_id UUID REFERENCES product_models(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    data_type VARCHAR(50) NOT NULL, 
    is_required BOOLEAN DEFAULT false,
    list_of_values JSONB DEFAULT '[]'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_product_models_merchant ON product_models(merchant_id) WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS idx_product_model_attributes_model_id ON product_model_attributes(model_id);

-- Down Migration
DROP TABLE IF EXISTS product_model_attributes;
DROP TABLE IF EXISTS product_models;
