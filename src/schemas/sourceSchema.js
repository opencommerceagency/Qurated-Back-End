// Keep data format (CSV/XML) and transport protocol (HTTP/FTP) strictly separate
import { z } from 'zod';
import { validateSafeUrl, isPrivateOrLocalHost } from '../utils/urlValidator.js';

// Validate connection details so local files, SSRF, and private IPs are blocked
const connectionConfigSchemaBase = z.record(z.any()).superRefine((config, ctx) => {
  if (config.url !== undefined) {
    try {
      validateSafeUrl(config.url);
    } catch (err) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['url'],
        message: err.message
      });
    }
  }

  if (config.host) {
    if (isPrivateOrLocalHost(config.host)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['host'],
        message: `Access to private or local host '${config.host}' is blocked for security.`
      });
    }
  }
});

// Schema for registering a new supplier data source
export const sourceCreateSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  // Data format: csv, xml, or api
  type: z.enum(['csv', 'xml', 'api']),
  // Transport protocol: HTTP or FTP
  protocol: z
    .enum(['HTTP', 'FTP', 'HTTPS', 'SFTP', 'http', 'ftp', 'https', 'sftp'])
    .default('HTTP')
    .transform((p) => p.toUpperCase()),
  default_model_id: z.string().default('google/gemini-flash-1.5'),
  connection_config: connectionConfigSchemaBase.default({}),
  dialect_config: z.record(z.any()).default({}),
  schedule_cron: z.string().nullable().optional()
});

// Partial schema for updating an existing source without overwriting untouched fields
export const sourceUpdateSchema = z.object({
  name: z.string().min(1, 'Name is required').optional(),
  type: z.enum(['csv', 'xml', 'api']).optional(),
  protocol: z
    .enum(['HTTP', 'FTP', 'HTTPS', 'SFTP', 'http', 'ftp', 'https', 'sftp'])
    .transform((p) => p.toUpperCase())
    .optional(),
  default_model_id: z.string().optional(),
  connection_config: connectionConfigSchemaBase.optional(),
  dialect_config: z.record(z.any()).optional(),
  schedule_cron: z.string().nullable().optional(),
  status: z.enum(['ACTIVE', 'PAUSED', 'ARCHIVED']).optional()
});