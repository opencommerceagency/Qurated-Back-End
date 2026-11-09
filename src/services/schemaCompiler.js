import { z } from 'zod';

/**
 * Preprocesses and coerces values to boolean safely.
 * Handles boolean types, numbers, and strings like "true"/"false", "1"/"0", "yes"/"no".
 * Returns raw value if not definitively boolean-like, letting z.boolean() properly reject it.
 */
const safeBooleanCoerce = z.preprocess((val) => {
  if (val === null || val === undefined) return val;
  if (typeof val === 'boolean') return val;
  if (typeof val === 'string') {
    const trimmed = val.trim().toLowerCase();
    if (trimmed === 'true' || trimmed === '1' || trimmed === 'yes') return true;
    if (trimmed === 'false' || trimmed === '0' || trimmed === 'no') return false;
    return val;
  }
  if (typeof val === 'number') {
    if (val === 1) return true;
    if (val === 0) return false;
    return val;
  }
  return val;
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
        const canonicalMap = new Map();
        for (const item of validList) {
          canonicalMap.set(item.toLowerCase(), item);
        }
        fieldSchema = z.preprocess((val) => {
          if (val === null || val === undefined) return val;
          const strVal = String(val).trim();
          const canonical = canonicalMap.get(strVal.toLowerCase());
          return canonical !== undefined ? canonical : val;
        }, z.enum(validList));
      } else {
        fieldSchema = z.string();
      }
      break;
    }

    case 'string':
    default:
      fieldSchema = z.string();
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
 * Unknown keys are dropped (no .passthrough()) to prevent LLM inventions from breaching DB limits.
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

  return z.object(shape);
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

/**
 * Compiles a Zod schema for validating a partial set of attributes being manually overridden.
 *
 * @param {Object|Array} snapshot - Model snapshot
 * @param {string[]} attributeKeys - Keys of the attributes being overridden
 * @returns {z.ZodObject} Compiled Zod schema for the attributes
 */
export function compileAttributesOverrideSchema(snapshot, attributeKeys = []) {
  const attributes = Array.isArray(snapshot)
    ? snapshot
    : Array.isArray(snapshot?.attributes)
      ? snapshot.attributes
      : [];

  const shape = {};
  for (const key of attributeKeys) {
    const attr = attributes.find(
      (a) => (a.key || (a.name ? a.name.toLowerCase().replace(/[^a-z0-9_]/g, '_') : null)) === key
    );

    if (!attr) {
      shape[key] = z.any().refine(() => false, {
        message: `Attribute "${key}" is not defined in model schema`
      });
      continue;
    }

    const dataType = (attr.data_type || attr.dataType || 'string').toLowerCase();

    switch (dataType) {
      case 'integer':
      case 'number':
        shape[key] = z.preprocess((val) => {
          if (typeof val === 'boolean') return NaN;
          if (typeof val === 'string') {
            if (!/^-?\d+$/.test(val.trim())) return NaN;
            return parseInt(val.trim(), 10);
          }
          return val;
        }, z.number({ message: `Field "${key}" must be an integer` }).int({ message: `Field "${key}" must be an integer` }));
        break;

      case 'boolean':
        shape[key] = safeBooleanCoerce;
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
          shape[key] = z.enum(validList, {
            errorMap: () => ({
              message: `Value is not permitted for "${key}". Allowed values: [${validList.join(', ')}]`
            })
          });
        } else {
          shape[key] = z.coerce.string();
        }
        break;
      }

      case 'string':
      default:
        shape[key] = z.preprocess(
          (val) => (typeof val === 'string' ? val.trim() : val),
          z.string({ message: `Field "${key}" must be a string` }).min(1, { message: `Field "${key}" cannot be empty` })
        );
        break;
    }
  }

  return z.object(shape);
}

export default {
  compileAttributeFieldSchema,
  compileModelZodSchema,
  generatePromptSchemaDescription,
  compileAttributesOverrideSchema
};
