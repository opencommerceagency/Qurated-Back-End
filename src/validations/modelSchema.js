import { z } from 'zod';

// Keep attribute names non-empty and limit types to what my parser and UI support
export const attributeSchema = z.object({
  name: z.string().min(1, 'Attribute name is required'),
  data_type: z.enum(['string', 'number', 'boolean', 'enum']),
  is_required: z.boolean().default(false),
  list_of_values: z.array(z.string()).default([])
});

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
  attributeSchema,
  modelSchema,
  createModelSchema,
  updateModelSchema
};
