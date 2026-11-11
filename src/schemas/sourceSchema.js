// this is what sander asked: keeping format and protocol strictly separate
import { z } from 'zod';
import { validateSafeUrl, isPrivateOrLocalHost } from '../utils/urlValidator.js';

// checking connection details so unsafe URLs or private IPs are blocked
const connectionConfigSchemaBase = z.record(z.any()).superRefine((config, ctx) => {
  if (config.url !== undefined) {
    try {
      // this will make sure its safe: blocking local files and private IPs
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

const supportedSourceTypes = ['csv', 'xml', 'xlsx', 'api', 'CSV', 'XML', 'XLSX', 'API'];

// schema for creating a brand new supplier source
export const sourceCreateSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  // this is the data format: csv, xml, xlsx, or api
  type: z
    .enum(supportedSourceTypes)
    .transform((t) => t.toLowerCase()),
  // this is the transport protocol: HTTP or FTP
  protocol: z
    .enum(['HTTP', 'FTP', 'HTTPS', 'SFTP', 'http', 'ftp', 'https', 'sftp'])
    .default('HTTP')
    .transform((p) => p.toUpperCase()),
  default_model_id: z.string().default('google/gemini-flash-1.5'),
  connection_config: connectionConfigSchemaBase.default({}),
  dialect_config: z.record(z.any()).default({}),
  schedule_cron: z.string().nullable().optional(),
});

// schema for updating an existing source without wiping fields with defaults
export const sourceUpdateSchema = z.object({
  name: z.string().min(1, 'Name is required').optional(),
  type: z
    .enum(supportedSourceTypes)
    .transform((t) => t.toLowerCase())
    .optional(),
  protocol: z
    .enum(['HTTP', 'FTP', 'HTTPS', 'SFTP', 'http', 'ftp', 'https', 'sftp'])
    .transform((p) => p.toUpperCase())
    .optional(),
  default_model_id: z.string().optional(),
  connection_config: connectionConfigSchemaBase.optional(),
  dialect_config: z.record(z.any()).optional(),
  schedule_cron: z.string().nullable().optional(),
  status: z.enum(['ACTIVE', 'PAUSED', 'ARCHIVED']).optional(),
});
