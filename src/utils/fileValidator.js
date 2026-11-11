import path from 'path';

/**
 * File & MIME Type Validation Utility (Milestone B4.1)
 *
 * Provides safe validation for XML and XLSX feeds and files:
 * 1. Safe extension inspection (case-insensitive, URL query/hash stripping)
 * 2. MIME type verification against official & common Content-Types
 * 3. Rejection of dangerous executable files and HTML masquerades
 */

export const SUPPORTED_FILE_TYPES = {
  xml: {
    extensions: ['.xml'],
    mimeTypes: [
      'application/xml',
      'text/xml',
      'application/xhtml+xml'
    ]
  },
  xlsx: {
    extensions: ['.xlsx'],
    mimeTypes: [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
      'application/octet-stream',
      'application/zip'
    ]
  },
  csv: {
    extensions: ['.csv'],
    mimeTypes: [
      'text/csv',
      'text/plain',
      'application/csv',
      'text/x-csv',
      'application/vnd.ms-excel'
    ]
  }
};

export const DANGEROUS_EXTENSIONS = [
  '.exe', '.bat', '.cmd', '.sh', '.bash', '.ps1',
  '.js', '.mjs', '.cjs', '.ts', '.py', '.rb',
  '.php', '.phtml', '.asp', '.aspx', '.jsp',
  '.html', '.htm', '.xhtml', '.svg'
];

export const BLOCKED_MIME_TYPES = [
  'text/html',
  'application/javascript',
  'text/javascript',
  'application/x-msdownload',
  'application/x-sh',
  'application/x-php',
  'application/x-httpd-php'
];

/**
 * Extracts a normalized, lowercased file extension from a filename or URL.
 * Automatically strips URL query parameters, hash fragments, and path traversals.
 *
 * @param {string} filenameOrUrl
 * @returns {string} - e.g. '.xlsx', '.xml', or '' if not found
 */
export function extractExtension(filenameOrUrl) {
  if (!filenameOrUrl || typeof filenameOrUrl !== 'string') return '';

  let clean = filenameOrUrl.trim();

  // Strip query strings and hash anchors if present (e.g. "feed.xlsx?token=123#page1")
  try {
    if (clean.includes('://')) {
      const parsedUrl = new URL(clean);
      clean = parsedUrl.pathname;
    } else {
      clean = clean.split(/[?#]/)[0];
    }
  } catch {
    clean = clean.split(/[?#]/)[0];
  }

  const ext = path.extname(clean).toLowerCase();
  return ext;
}

/**
 * Cleans and normalizes a MIME type string, stripping charset and other parameters.
 *
 * @param {string} mimeType - e.g. "application/xml; charset=utf-8"
 * @returns {string} - e.g. "application/xml"
 */
export function cleanMimeType(mimeType) {
  if (!mimeType || typeof mimeType !== 'string') return '';
  return mimeType.split(';')[0].trim().toLowerCase();
}

/**
 * Checks whether a file extension is allowed for a given file type or list of extensions.
 *
 * @param {string} filenameOrUrl
 * @param {string|string[]} [allowed] - Type ('xml'|'xlsx'|'csv') or list of allowed extensions
 * @returns {boolean}
 */
export function isValidFileExtension(filenameOrUrl, allowed) {
  const ext = extractExtension(filenameOrUrl);
  if (!ext) return false;

  // Immediately reject dangerous extensions
  if (DANGEROUS_EXTENSIONS.includes(ext)) {
    return false;
  }

  let allowedList = [];
  if (typeof allowed === 'string') {
    const config = SUPPORTED_FILE_TYPES[allowed.toLowerCase()];
    allowedList = config ? config.extensions : [allowed.toLowerCase()];
  } else if (Array.isArray(allowed)) {
    allowedList = allowed.map(e => (e.startsWith('.') ? e.toLowerCase() : `.${e.toLowerCase()}`));
  } else {
    // All supported extensions
    allowedList = Object.values(SUPPORTED_FILE_TYPES).flatMap(c => c.extensions);
  }

  return allowedList.includes(ext);
}

/**
 * Checks whether a MIME type is allowed for a given file type or list of MIME types.
 *
 * @param {string} rawMimeType
 * @param {string|string[]} [allowed] - Type ('xml'|'xlsx'|'csv') or list of allowed MIME types
 * @returns {boolean}
 */
export function isValidMimeType(rawMimeType, allowed) {
  const mime = cleanMimeType(rawMimeType);
  if (!mime) return false;

  // Immediately reject blocked MIME types (e.g. text/html)
  if (BLOCKED_MIME_TYPES.includes(mime)) {
    return false;
  }

  let allowedList = [];
  if (typeof allowed === 'string') {
    const config = SUPPORTED_FILE_TYPES[allowed.toLowerCase()];
    allowedList = config ? config.mimeTypes : [allowed.toLowerCase()];
  } else if (Array.isArray(allowed)) {
    allowedList = allowed.map(m => m.toLowerCase());
  } else {
    // All supported MIME types
    allowedList = Object.values(SUPPORTED_FILE_TYPES).flatMap(c => c.mimeTypes);
  }

  return allowedList.includes(mime);
}

/**
 * Detects the file type ('xml' | 'xlsx' | 'csv' | null) from a filename and/or MIME type.
 *
 * @param {string} [filename]
 * @param {string} [rawMimeType]
 * @returns {'xml'|'xlsx'|'csv'|null}
 */
export function detectFileType(filename, rawMimeType) {
  const ext = extractExtension(filename);
  const mime = cleanMimeType(rawMimeType);

  // Check extensions first if present
  if (ext) {
    for (const [type, config] of Object.entries(SUPPORTED_FILE_TYPES)) {
      if (config.extensions.includes(ext)) {
        return type;
      }
    }
  }

  // Fallback to MIME type
  if (mime) {
    for (const [type, config] of Object.entries(SUPPORTED_FILE_TYPES)) {
      if (config.mimeTypes.includes(mime)) {
        return type;
      }
    }
  }

  return null;
}

/**
 * Validates a file's extension and MIME type against expectations.
 *
 * @param {Object} options
 * @param {string} [options.filename] - The filename or URL
 * @param {string} [options.mimeType] - The Content-Type header or MIME type
 * @param {string} [options.expectedType] - Expected type ('xml'|'xlsx'|'csv')
 * @returns {{ isValid: boolean, detectedType: string|null, error?: string }}
 */
export function validateFileType({ filename, mimeType, expectedType } = {}) {
  const ext = extractExtension(filename);
  const mime = cleanMimeType(mimeType);

  if (ext && DANGEROUS_EXTENSIONS.includes(ext)) {
    return {
      isValid: false,
      detectedType: null,
      error: `File extension '${ext}' is dangerous and strictly prohibited.`
    };
  }

  if (mime && BLOCKED_MIME_TYPES.includes(mime)) {
    return {
      isValid: false,
      detectedType: null,
      error: `MIME type '${mime}' is not permitted (HTML or executable content).`
    };
  }

  const detected = detectFileType(filename, mimeType);

  if (expectedType) {
    const targetType = expectedType.toLowerCase();
    const config = SUPPORTED_FILE_TYPES[targetType];

    if (!config) {
      return {
        isValid: false,
        detectedType: detected,
        error: `Unsupported expected type '${expectedType}'.`
      };
    }

    if (ext && !config.extensions.includes(ext)) {
      return {
        isValid: false,
        detectedType: detected,
        error: `File extension '${ext}' does not match expected format '${expectedType}'.`
      };
    }

    if (mime && !config.mimeTypes.includes(mime)) {
      return {
        isValid: false,
        detectedType: detected,
        error: `MIME type '${mime}' does not match expected format '${expectedType}'.`
      };
    }

    return {
      isValid: true,
      detectedType: targetType
    };
  }

  if (!detected) {
    return {
      isValid: false,
      detectedType: null,
      error: `Could not identify a supported file format for filename '${filename || ''}' and MIME type '${mimeType || ''}'.`
    };
  }

  return {
    isValid: true,
    detectedType: detected
  };
}

export default {
  SUPPORTED_FILE_TYPES,
  DANGEROUS_EXTENSIONS,
  BLOCKED_MIME_TYPES,
  extractExtension,
  cleanMimeType,
  isValidFileExtension,
  isValidMimeType,
  detectFileType,
  validateFileType
};

