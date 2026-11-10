import { z } from 'zod';

export const KEY_REGEX = /^[a-z0-9_]+$/;

// Slugify helper: converts human strings like 'Package Weight (kg)' to 'package_weight_kg'
export function slugifyKey(text = '') {
  if (!text) return '';
  return text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 100);
}

// Strict Attribute Schema according to User Story B2.2
export const attributeSchema = z.preprocess(
  (val) => {
    if (val && typeof val === 'object') {
      const copy = { ...val };
      // Transparently normalize legacy aliases if provided
      if (copy.data_type === 'number') copy.data_type = 'integer';
      if (copy.data_type === 'enum') copy.data_type = 'list_of_values';

      // If key is not provided but name is, auto-slugify key
      if (!copy.key && copy.name) {
        copy.key = slugifyKey(copy.name);
      }
      // Keep allowed_values and list_of_values synchronized
      if (copy.allowed_values && (!copy.list_of_values || copy.list_of_values.length === 0)) {
        copy.list_of_values = copy.allowed_values;
      } else if (copy.list_of_values && (!copy.allowed_values || copy.allowed_values.length === 0)) {
        copy.allowed_values = copy.list_of_values;
      }
      return copy;
    }
    return val;
  },
  z.object({
    name: z.string().min(1, 'Attribute name is required').max(255),
    key: z.string().regex(KEY_REGEX, 'Key must contain only lowercase alphanumeric characters and underscores').max(100),
    data_type: z.enum(['string', 'integer', 'boolean', 'list_of_values']),
    is_required: z.boolean().default(false),
    unit_type: z.string().max(32).optional().nullable(),
    allowed_values: z.array(z.string().min(1, 'Allowed value item cannot be empty')).optional(),
    list_of_values: z.array(z.string()).default([])
  }).superRefine((data, ctx) => {
    if (data.data_type === 'list_of_values') {
      const values = data.allowed_values || (data.list_of_values && data.list_of_values.length > 0 ? data.list_of_values : null);
      if (!Array.isArray(values) || values.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'allowed_values must be a non-empty array of strings when data_type is list_of_values',
          path: ['allowed_values']
        });
      }
    }
  })
);

export const createAttributeSchema = attributeSchema;

export const updateAttributeSchema = z.preprocess(
  (val) => {
    if (val && typeof val === 'object') {
      const copy = { ...val };
      if (copy.data_type === 'number') copy.data_type = 'integer';
      if (copy.data_type === 'enum') copy.data_type = 'list_of_values';

      if (!copy.key && copy.name) {
        copy.key = slugifyKey(copy.name);
      }
      if (copy.allowed_values && (!copy.list_of_values || copy.list_of_values.length === 0)) {
        copy.list_of_values = copy.allowed_values;
      } else if (copy.list_of_values && (!copy.allowed_values || copy.allowed_values.length === 0)) {
        copy.allowed_values = copy.list_of_values;
      }
      return copy;
    }
    return val;
  },
  z.object({
    name: z.string().min(1, 'Attribute name must not be empty').max(255).optional(),
    key: z.string().regex(KEY_REGEX, 'Key must contain only lowercase alphanumeric characters and underscores').max(100).optional(),
    data_type: z.enum(['string', 'integer', 'boolean', 'list_of_values']).optional(),
    is_required: z.boolean().optional(),
    unit_type: z.string().max(32).optional().nullable(),
    allowed_values: z.array(z.string().min(1, 'Allowed value item cannot be empty')).optional(),
    list_of_values: z.array(z.string()).optional()
  }).superRefine((data, ctx) => {
    if (data.data_type === 'list_of_values') {
      const values = data.allowed_values || (data.list_of_values && data.list_of_values.length > 0 ? data.list_of_values : null);
      if (!Array.isArray(values) || values.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'allowed_values must be a non-empty array of strings when data_type is list_of_values',
          path: ['allowed_values']
        });
      }
    }
  })
);

// Require meaningful names (at least 3 chars) so catalog models aren't named accidentally
export const modelSchema = z.object({
  name: z.string().min(3, 'Name must be at least 3 characters').max(255, 'Name must not exceed 255 characters'),
  description: z.string().nullable().optional(),
  attributes: z.array(attributeSchema).optional().default([])
});

export const createModelSchema = modelSchema;

// Updates are partial: only validate whatever fields the user actually sent over
export const updateModelSchema = z.object({
  name: z.string().min(3, 'Name must be at least 3 characters').max(255, 'Name must not exceed 255 characters').optional(),
  description: z.string().nullable().optional(),
  attributes: z.array(attributeSchema).optional(),
  status: z.enum(['ACTIVE', 'ARCHIVED']).optional()
});

export default {
  KEY_REGEX,
  slugifyKey,
  attributeSchema,
  createAttributeSchema,
  updateAttributeSchema,
  modelSchema,
  createModelSchema,
  updateModelSchema
};
