import { z } from 'zod';

/**
 * Preprocesses and coerces values to boolean safely.
 * Handles boolean types, numbers, and strings like "true"/"false", "1"/"0", "yes"/"no".
 */
const safeBooleanCoerce = z.preprocess((val) => {
  if (val === null || val === undefined) return val;
  if (typeof val === 'boolean') return val;
  if (typeof val === 'string') {
    const trimmed = val.trim().toLowerCase();
    if (trimmed === 'true' || trimmed === '1' || trimmed === 'yes') return true;
    if (trimmed === 'false' || trimmed === '0' || trimmed === 'no') return false;
  }
  if (typeof val === 'number') return val !== 0;
  return Boolean(val);
}, z.boolean());

/**
 * Compiles an attribute definition from a model snapshot into a corresponding Zod schema field.
 *
 * @param {Object} attr - Attribute definition from product_model_versions snapshot
 * @returns {z.ZodTypeAny} Executable Zod field schema
 */
export function compileAttributeFieldSchema(attr) {
  let fieldSchema;
  const dataType = (attr.data_type || attr.dataType || 'string').toLowerCase();

  switch (dataType) {
    case 'integer':
    case 'number':
      fieldSchema = z.coerce.number().int({ message: `Field ${attr.key || attr.name} must be an integer` });
      break;

    case 'boolean':
      fieldSchema = safeBooleanCoerce;
      break;

    case 'list_of_values':
    case 'enum': {
      let allowed = attr.allowed_values || attr.list_of_values || [];
      if (typeof allowed === 'string') {
        try {
          allowed = JSON.parse(allowed);
        } catch {
          allowed = [];
        }
      }

      const validList = Array.isArray(allowed)
        ? allowed.map((item) => String(item).trim()).filter(Boolean)
        : [];

      if (validList.length > 0) {
        fieldSchema = z.enum(validList);
      } else {
        fieldSchema = z.coerce.string();
      }
      break;
    }

    case 'string':
    default:
      fieldSchema = z.coerce.string();
      if (attr.is_required) {
        fieldSchema = fieldSchema.trim().min(1, { message: `${attr.key || attr.name} is required` });
      }
      break;
  }

  // Handle optional / nullable attributes
  if (!attr.is_required) {
    fieldSchema = fieldSchema.optional().nullable();
  }

  return fieldSchema;
}

/**
 * Converts a historical model snapshot (`product_model_versions.snapshot`) into an
 * executable Zod object schema at runtime.
 *
 * @param {Object|Array} snapshot - The model snapshot object or attributes array
 * @returns {z.ZodObject} Compiled Zod schema requiring supplier_sku and snapshot attributes
 */
export function compileModelZodSchema(snapshot) {
  const shape = {
    supplier_sku: z.preprocess(
      (val, ctx) => {
        // If supplier_sku is omitted, check for sku alias
        if (val !== undefined && val !== null) return String(val).trim();
        const rawObj = ctx?.parent;
        if (rawObj && (rawObj.sku || rawObj.artikel_nr || rawObj.item_number)) {
          return String(rawObj.sku || rawObj.artikel_nr || rawObj.item_number).trim();
        }
        return val;
      },
      z.string({ message: 'supplier_sku is required' }).trim().min(1, { message: 'supplier_sku cannot be empty' })
    )
  };

  const attributes = Array.isArray(snapshot)
    ? snapshot
    : Array.isArray(snapshot?.attributes)
      ? snapshot.attributes
      : [];

  for (const attr of attributes) {
    const key = attr.key || (attr.name ? attr.name.toLowerCase().replace(/[^a-z0-9_]/g, '_') : null);
    if (!key) continue;

    shape[key] = compileAttributeFieldSchema(attr);
  }

  return z.object(shape).passthrough();
}

/**
 * Formats model attributes into a human-readable schema specification for LLM prompts.
 *
 * @param {Object|Array} snapshot - Model snapshot
 * @returns {string} Textual schema description for LLM system prompt
 */
export function generatePromptSchemaDescription(snapshot) {
  const attributes = Array.isArray(snapshot)
    ? snapshot
    : Array.isArray(snapshot?.attributes)
      ? snapshot.attributes
      : [];

  const fields = [
    '- supplier_sku (string, required): Unique manufacturer or supplier product code/SKU'
  ];

  for (const attr of attributes) {
    const key = attr.key || attr.name;
    const type = attr.data_type || 'string';
    const req = attr.is_required ? 'required' : 'optional';
    let extra = '';

    if (type === 'list_of_values') {
      const allowed = attr.allowed_values || attr.list_of_values || [];
      extra = ` [allowed values: ${JSON.stringify(allowed)}]`;
    } else if (attr.unit_type) {
      extra = ` [unit: ${attr.unit_type}]`;
    }

    fields.push(`- ${key} (${type}, ${req})${extra}`);
  }

  return fields.join('\n');
}

export default {
  compileAttributeFieldSchema,
  compileModelZodSchema,
  generatePromptSchemaDescription
};
