import fs from 'fs';
import zlib from 'zlib';

export const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB
export const MAX_PDF_PAGES = 50;

/**
 * Extracts raw or decompressed stream bytes from a PDF buffer.
 * Attempts zlib inflation if FlateDecode is specified.
 */
function extractPdfStreams(buffer) {
  const streams = [];
  const str = buffer.toString('binary');
  const streamRegex = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let match;

  while ((match = streamRegex.exec(str)) !== null) {
    const rawContent = match[1];
    const streamBuffer = Buffer.from(rawContent, 'binary');

    // Try decompressing with zlib
    try {
      const decompressed = zlib.inflateSync(streamBuffer);
      streams.push(decompressed.toString('utf-8'));
    } catch {
      // If inflate fails, try inflateRaw
      try {
        const decompressedRaw = zlib.inflateRawSync(streamBuffer);
        streams.push(decompressedRaw.toString('utf-8'));
      } catch {
        // Fall back to raw string content
        streams.push(rawContent);
      }
    }
  }

  return streams;
}

/**
 * Extracts readable text strings from PDF stream contents or raw PDF data.
 */
function extractTextFromPdf(buffer, streams = []) {
  const textChunks = [];

  // 1. Inspect decompressed streams
  for (const streamContent of streams) {
    // Match text showing operators: (text) Tj or [(t) -10 (e) (x) (t)] TJ
    const tjRegex = /\(([^)]*)\)\s*Tj/g;
    let match;
    while ((match = tjRegex.exec(streamContent)) !== null) {
      if (match[1] && match[1].trim()) {
        textChunks.push(match[1]);
      }
    }

    const arrayTjRegex = /\[([^\]]*)\]\s*TJ/g;
    while ((match = arrayTjRegex.exec(streamContent)) !== null) {
      const inner = match[1];
      const parts = inner.match(/\(([^)]*)\)/g);
      if (parts) {
        for (const p of parts) {
          const cleaned = p.slice(1, -1).trim();
          if (cleaned) textChunks.push(cleaned);
        }
      }
    }
  }

  // 2. Also inspect raw PDF buffer for uncompressed text blocks
  const rawStr = buffer.toString('latin1');
  const rawTjRegex = /\(([^)]+)\)\s*Tj/g;
  let rawMatch;
  while ((rawMatch = rawTjRegex.exec(rawStr)) !== null) {
    if (rawMatch[1] && rawMatch[1].trim()) {
      textChunks.push(rawMatch[1]);
    }
  }

  return textChunks.join(' ').trim();
}

/**
 * Counts total pages in a PDF document.
 */
function countPdfPages(buffer) {
  const str = buffer.toString('latin1');

  // Look for /Count N in /Pages dictionary
  const pagesCountRegex = /\/Type\s*\/Pages[\s\S]*?\/Count\s+(\d+)/i;
  const countMatch = str.match(pagesCountRegex);
  if (countMatch && countMatch[1]) {
    const count = parseInt(countMatch[1], 10);
    if (!isNaN(count) && count > 0) {
      return count;
    }
  }

  // Reverse order: /Count N ... /Type /Pages
  const reverseCountRegex = /\/Count\s+(\d+)[\s\S]*?\/Type\s*\/Pages/i;
  const revMatch = str.match(reverseCountRegex);
  if (revMatch && revMatch[1]) {
    const count = parseInt(revMatch[1], 10);
    if (!isNaN(count) && count > 0) {
      return count;
    }
  }

  // Fallback: count individual /Type /Page (excluding /Type /Pages)
  const pageMatches = str.match(/\/Type\s*\/Page(?![a-zA-Z])/g);
  if (pageMatches) {
    return pageMatches.length;
  }

  return 0;
}

/**
 * Checks if a PDF is encrypted or password-protected.
 */
function isPdfEncrypted(buffer) {
  const str = buffer.toString('latin1');
  // Check for /Encrypt dictionary or Standard filter
  const encryptRegex = /\/Encrypt\s*(\d+\s+\d+\s+R|<<)/i;
  if (encryptRegex.test(str)) {
    return true;
  }
  if (/\/Filter\s*\/Standard/i.test(str) && /\/Encrypt/i.test(str)) {
    return true;
  }
  return false;
}

/**
 * Validates a file synchronously against extraction pipeline guardrails:
 * 1. File size <= 25 MB
 * 2. PDF page count <= 50
 * 3. PDF is not encrypted / password-protected
 * 4. PDF has extractable text layer (not scanned without OCR)
 * 5. CSV has readable, non-empty headers
 *
 * @param {Object|string|Buffer} input - File path, Buffer, or file descriptor object
 * @returns {Object} Validation result { valid: boolean, error?: string, message?: string }
 */
export function validateFile(input) {
  if (!input) {
    return {
      valid: false,
      error: 'FILE_LIMIT_EXCEEDED',
      message: 'No file provided for validation'
    };
  }

  let buffer;
  let fileSize = 0;
  let filename = '';
  let mimeType = '';
  let explicitPageCount = null;
  let explicitIsEncrypted = null;
  let explicitTextContent = null;

  if (typeof input === 'string') {
    // File path
    if (!fs.existsSync(input)) {
      return {
        valid: false,
        error: 'FILE_NOT_FOUND',
        message: `File not found at path: ${input}`
      };
    }
    const stat = fs.statSync(input);
    fileSize = stat.size;
    filename = input;
    buffer = fs.readFileSync(input);
  } else if (Buffer.isBuffer(input)) {
    buffer = input;
    fileSize = input.length;
  } else if (typeof input === 'object') {
    if (input.buffer && Buffer.isBuffer(input.buffer)) {
      buffer = input.buffer;
      fileSize = input.size || input.buffer.length;
    } else if (input.filePath && fs.existsSync(input.filePath)) {
      const stat = fs.statSync(input.filePath);
      fileSize = input.size || stat.size;
      filename = input.filename || input.filePath;
      buffer = fs.readFileSync(input.filePath);
    } else if (typeof input.content === 'string') {
      buffer = Buffer.from(input.content, 'utf-8');
      fileSize = input.size || buffer.length;
    } else {
      fileSize = input.size || 0;
      buffer = Buffer.alloc(0);
    }

    filename = input.filename || input.name || filename;
    mimeType = input.mimeType || input.mimetype || '';
    if (typeof input.total_pages === 'number') explicitPageCount = input.total_pages;
    if (typeof input.pageCount === 'number') explicitPageCount = input.pageCount;
    if (typeof input.is_encrypted === 'boolean') explicitIsEncrypted = input.is_encrypted;
    if (typeof input.isEncrypted === 'boolean') explicitIsEncrypted = input.isEncrypted;
    if (typeof input.text_content === 'string') explicitTextContent = input.text_content;
    if (typeof input.textContent === 'string') explicitTextContent = input.textContent;
  }

  // 1. Size check
  if (fileSize > MAX_FILE_SIZE) {
    return {
      valid: false,
      error: 'FILE_LIMIT_EXCEEDED',
      message: `File size (${(fileSize / (1024 * 1024)).toFixed(2)} MB) exceeds maximum allowed limit of 25 MB`
    };
  }

  const isPdf =
    (filename && filename.toLowerCase().endsWith('.pdf')) ||
    mimeType === 'application/pdf' ||
    (buffer.length >= 4 && buffer.slice(0, 4).toString('latin1') === '%PDF') ||
    explicitPageCount !== null ||
    explicitIsEncrypted !== null ||
    explicitTextContent !== null;

  const isCsv =
    (filename && filename.toLowerCase().endsWith('.csv')) ||
    mimeType === 'text/csv' ||
    mimeType === 'application/csv';

  // 2. PDF Guardrails
  if (isPdf) {
    // Encrypted / Password-protected check
    const encrypted = explicitIsEncrypted !== null ? explicitIsEncrypted : isPdfEncrypted(buffer);
    if (encrypted) {
      return {
        valid: false,
        error: 'UNSUPPORTED_ENCRYPTED_FILE',
        message: 'Password-protected or encrypted PDF files are not supported'
      };
    }

    // Page count check
    const pageCount = explicitPageCount !== null ? explicitPageCount : countPdfPages(buffer);
    if (pageCount > MAX_PDF_PAGES) {
      return {
        valid: false,
        error: 'FILE_LIMIT_EXCEEDED',
        message: `PDF contains ${pageCount} pages, exceeding the maximum allowed limit of ${MAX_PDF_PAGES} pages`
      };
    }

    // Scanned PDF check (No text layer)
    let extractedText = '';
    if (explicitTextContent !== null) {
      extractedText = explicitTextContent.trim();
    } else {
      const streams = extractPdfStreams(buffer);
      extractedText = extractTextFromPdf(buffer, streams);
    }

    if (pageCount > 0 && extractedText.length === 0) {
      return {
        valid: false,
        error: 'OCR_REQUIRED_NO_TEXT_LAYER',
        message: 'PDF contains no extractable text layer; OCR is required'
      };
    }

    return {
      valid: true,
      fileType: 'PDF',
      pageCount,
      size: fileSize
    };
  }

  // 3. CSV Guardrails
  if (isCsv) {
    const rawText = buffer.toString('utf-8').trim();
    if (!rawText) {
      return {
        valid: false,
        error: 'INVALID_CSV_HEADERS',
        message: 'CSV file is empty or missing readable headers'
      };
    }

    const firstLine = rawText.split(/\r?\n/)[0].trim();
    if (!firstLine) {
      return {
        valid: false,
        error: 'INVALID_CSV_HEADERS',
        message: 'CSV file has empty header row'
      };
    }

    // Ensure at least one valid delimiter-separated header exists
    const delimiter = firstLine.includes(';') ? ';' : firstLine.includes('\t') ? '\t' : ',';
    const headers = firstLine.split(delimiter).map(h => h.replace(/^["']|["']$/g, '').trim());
    const validHeaders = headers.filter(h => h.length > 0);

    if (validHeaders.length === 0) {
      return {
        valid: false,
        error: 'INVALID_CSV_HEADERS',
        message: 'CSV file contains no readable headers'
      };
    }

    return {
      valid: true,
      fileType: 'CSV',
      headers: validHeaders,
      size: fileSize
    };
  }

  // Default: pass through for other supported types if size check passed
  return {
    valid: true,
    fileType: 'UNKNOWN',
    size: fileSize
  };
}

export default {
  MAX_FILE_SIZE,
  MAX_PDF_PAGES,
  validateFile
};
