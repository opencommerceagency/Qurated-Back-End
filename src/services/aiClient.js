import { compileModelZodSchema, generatePromptSchemaDescription } from './schemaCompiler.js';

export const DEFAULT_OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
export const DEFAULT_PRIMARY_MODEL = 'anthropic/claude-3.5-sonnet';
export const DEFAULT_FALLBACK_MODEL = 'openai/gpt-4o-mini';

export const CSV_TIMEOUT_MS = 15000; // 15 seconds
export const PDF_TIMEOUT_MS = 60000; // 60 seconds

/**
 * Resolves extraction timeout in milliseconds based on file type.
 *
 * @param {string} [fileType='csv'] - File extension/type ('csv' or 'pdf')
 * @param {number} [overrideTimeoutMs] - Optional explicit timeout override
 * @returns {number} Timeout in milliseconds
 */
export function getExtractionTimeoutMs(fileType = 'csv', overrideTimeoutMs = null) {
  if (typeof overrideTimeoutMs === 'number' && overrideTimeoutMs > 0) {
    return overrideTimeoutMs;
  }
  const type = String(fileType).toLowerCase();
  if (type === 'pdf') {
    return PDF_TIMEOUT_MS;
  }
  return CSV_TIMEOUT_MS;
}

/**
 * Sanitizes model JSON response, removing markdown code fences if present.
 *
 * @param {string} content - Raw message content from AI model
 * @returns {string} Clean JSON string
 */
export function sanitizeJsonResponse(content) {
  if (!content) return '{}';
  const trimmed = content.trim();
  // Strip markdown code fences like ```json ... ``` or ``` ... ```
  if (trimmed.startsWith('```')) {
    return trimmed
      .replace(/^```(?:json)?\s*\r?\n?/, '')
      .replace(/\r?\n?```$/, '')
      .trim();
  }
  return trimmed;
}

/**
 * Executes a single AI completion call with timeout, response parsing, and schema validation.
 */
async function callModelWithSchema({
  modelName,
  rawData,
  schemaSnapshot,
  compiledSchema,
  timeoutMs,
  apiKey,
  baseUrl,
  fetchFn
}) {
  const schemaDesc = generatePromptSchemaDescription(schemaSnapshot);
  const serializedRaw = typeof rawData === 'string' ? rawData : JSON.stringify(rawData, null, 2);

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`Extraction request timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  try {
    const response = await fetchFn(`${baseUrl}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://qurated.com',
        'X-Title': 'Qurated Product Extraction'
      },
      body: JSON.stringify({
        model: modelName,
        messages: [
          {
            role: 'system',
            content:
              'You are a deterministic product catalog extraction system. ' +
              'Extract product attributes strictly matching the required schema. ' +
              'Output ONLY a valid JSON object or JSON array containing the extracted item(s). ' +
              'Do not include markdown fences, comments, or explanations.'
          },
          {
            role: 'user',
            content:
              `Target Schema Definition:\n${schemaDesc}\n\n` +
              `Raw Supplier Data:\n${serializedRaw}\n\n` +
              'Return the JSON object now:'
          }
        ],
        temperature: 0.1,
        response_format: { type: 'json_object' }
      })
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`OpenRouter API error (HTTP ${response.status}): ${errorText || response.statusText}`);
    }

    const jsonRes = await response.json();
    const rawContent = jsonRes.choices?.[0]?.message?.content;
    if (!rawContent) {
      throw new Error('Empty response content received from model');
    }

    const cleanContent = sanitizeJsonResponse(rawContent);
    const parsedData = JSON.parse(cleanContent);

    // Validate and coerce against compiled schema
    // If output is wrapped in a top-level key like { "product": ... } or { "products": [...] }, unwrap it
    let targetPayload = parsedData;
    if (parsedData && !Array.isArray(parsedData) && !parsedData.supplier_sku) {
      const firstVal = Object.values(parsedData)[0];
      if (firstVal && (typeof firstVal === 'object')) {
        targetPayload = firstVal;
      }
    }

    if (Array.isArray(targetPayload)) {
      const validatedItems = targetPayload.map((item) => compiledSchema.parse(item));
      return validatedItems;
    }

    const validatedItem = compiledSchema.parse(targetPayload);
    return validatedItem;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extracts product data with dynamic model failover and per-file-type timeouts:
 * 1. Tries OPENROUTER_PRIMARY_MODEL within the computed timeout window.
 * 2. On timeout (AbortError), HTTP 5xx, or schema failure, immediately falls back to OPENROUTER_FALLBACK_MODEL.
 * 3. Returns validated product data and execution metadata (`model_used: 'primary' | 'fallback'`).
 *
 * @param {Object} params - Extraction parameters
 * @param {Object|string} params.rawData - Raw supplier text or structured record
 * @param {string} [params.fileType='csv'] - 'csv' or 'pdf'
 * @param {Object|Array} params.schemaSnapshot - Target model version attributes snapshot
 * @param {Object} [params.options={}] - Additional runtime options and test hooks
 * @returns {Promise<Object>} Extracted product(s) with lineage metadata
 */
export async function extractWithFallback({
  rawData,
  fileType = 'csv',
  schemaSnapshot,
  options = {}
}) {
  const apiKey = options.apiKey || process.env.OPENROUTER_API_KEY || 'dummy_openrouter_api_key';
  const baseUrl = options.baseUrl || process.env.OPENROUTER_BASE_URL || DEFAULT_OPENROUTER_BASE_URL;
  const primaryModel = options.primaryModel || process.env.OPENROUTER_PRIMARY_MODEL || DEFAULT_PRIMARY_MODEL;
  const fallbackModel = options.fallbackModel || process.env.OPENROUTER_FALLBACK_MODEL || DEFAULT_FALLBACK_MODEL;
  const fetchFn = options.fetchFn || globalThis.fetch;

  const timeoutMs = getExtractionTimeoutMs(fileType, options.timeoutMs);
  const compiledSchema = compileModelZodSchema(schemaSnapshot);

  // 1. Primary Model Attempt
  try {
    const data = await callModelWithSchema({
      modelName: primaryModel,
      rawData,
      schemaSnapshot,
      compiledSchema,
      timeoutMs,
      apiKey,
      baseUrl,
      fetchFn
    });

    return {
      data,
      metadata: {
        model_used: 'primary',
        model_name: primaryModel,
        timeout_ms: timeoutMs
      }
    };
  } catch (primaryErr) {
    console.warn(
      `[AIClient] Primary model (${primaryModel}) failed (${primaryErr.name || 'Error'}: ${primaryErr.message}). ` +
      `Failing over to fallback model (${fallbackModel})...`
    );

    // 2. Fallover Execution to Fallback Model
    try {
      const fallbackData = await callModelWithSchema({
        modelName: fallbackModel,
        rawData,
        schemaSnapshot,
        compiledSchema,
        timeoutMs,
        apiKey,
        baseUrl,
        fetchFn
      });

      return {
        data: fallbackData,
        metadata: {
          model_used: 'fallback',
          model_name: fallbackModel,
          primary_error: primaryErr.message,
          timeout_ms: timeoutMs
        }
      };
    } catch (fallbackErr) {
      throw new Error(
        `AI extraction failed on both primary (${primaryModel}) and fallback (${fallbackModel}) models. ` +
        `Primary error: ${primaryErr.message}. Fallback error: ${fallbackErr.message}`
      );
    }
  }
}

export default {
  CSV_TIMEOUT_MS,
  PDF_TIMEOUT_MS,
  getExtractionTimeoutMs,
  sanitizeJsonResponse,
  extractWithFallback
};
