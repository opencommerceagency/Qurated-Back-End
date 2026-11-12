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
 * Determines whether a model error qualifies for fallback failover.
 * - Restricts fallback specifically to Timeouts and 5xx Server Errors (and model schema/output issues).
 * - Explicitly rejects fallback on 400, 401, 402, 429 and all 4xx client errors.
 *
 * @param {Error} err - Caught error from primary model execution
 * @returns {boolean} True if fallback model should be attempted
 */
export function isFallbackEligibleError(err) {
  if (!err) return false;

  // Never fall back on HTTP 4xx errors (400 Bad Request, 401 Unauthorized, 402 Payment Required, 429 Rate Limit, etc.)
  if (typeof err.status === 'number' && err.status >= 400 && err.status < 500) {
    return false;
  }

  // Fall back on Timeouts (AbortError or timeout message)
  if (err.name === 'AbortError' || /timed?\s*out|aborted/i.test(err.message || '')) {
    return true;
  }

  // Fall back on 5xx Server Errors
  if (typeof err.status === 'number' && err.status >= 500 && err.status < 600) {
    return true;
  }

  // Fall back on schema validation failures or invalid/empty response content
  if (err.name === 'ZodError' || err instanceof SyntaxError || (err.message && err.message.includes('Empty response content'))) {
    return true;
  }

  return false;
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
      const err = new Error(`OpenRouter API error (HTTP ${response.status}): ${errorText || response.statusText}`);
      err.status = response.status;
      throw err;
    }

    const jsonRes = await response.json();
    const promptTokens = jsonRes.usage?.prompt_tokens ?? 0;
    const completionTokens = jsonRes.usage?.completion_tokens ?? 0;
    const actualModel = jsonRes.model || modelName;

    const rawContent = jsonRes.choices?.[0]?.message?.content;
    if (!rawContent) {
      const emptyErr = new Error('Empty response content received from model');
      emptyErr.prompt_tokens = promptTokens;
      emptyErr.completion_tokens = completionTokens;
      emptyErr.model_used = actualModel;
      throw emptyErr;
    }

    let parsedData;
    try {
      const cleanContent = sanitizeJsonResponse(rawContent);
      parsedData = JSON.parse(cleanContent);
    } catch (parseErr) {
      parseErr.prompt_tokens = promptTokens;
      parseErr.completion_tokens = completionTokens;
      parseErr.model_used = actualModel;
      throw parseErr;
    }

    // Validate and coerce against compiled schema
    // If output is wrapped in a top-level key like { "product": ... } or { "products": [...] }, unwrap it
    let targetPayload = parsedData;
    if (parsedData && !Array.isArray(parsedData) && !parsedData.supplier_sku) {
      const firstVal = Object.values(parsedData)[0];
      if (firstVal && (typeof firstVal === 'object')) {
        targetPayload = firstVal;
      }
    }

    let validatedData;
    try {
      if (Array.isArray(targetPayload)) {
        validatedData = targetPayload.map((item) => compiledSchema.parse(item));
      } else {
        validatedData = compiledSchema.parse(targetPayload);
      }
    } catch (valErr) {
      valErr.prompt_tokens = promptTokens;
      valErr.completion_tokens = completionTokens;
      valErr.model_used = actualModel;
      throw valErr;
    }

    return {
      data: validatedData,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      model_used: actualModel
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extracts product data with dynamic model failover and per-file-type timeouts:
 * 1. Tries OPENROUTER_PRIMARY_MODEL within the computed timeout window.
 * 2. On timeout (AbortError), HTTP 5xx, or schema failure, immediately falls back to OPENROUTER_FALLBACK_MODEL.
 *    (Rejects fallback on 400, 401, 402, 429 and other 4xx errors).
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
  const apiKey = options.apiKey || process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY is missing or unconfigured');
  }

  const baseUrl = options.baseUrl || process.env.OPENROUTER_BASE_URL || DEFAULT_OPENROUTER_BASE_URL;
  const primaryModel = options.primaryModel || process.env.OPENROUTER_PRIMARY_MODEL || DEFAULT_PRIMARY_MODEL;
  const fallbackModel = options.fallbackModel || process.env.OPENROUTER_FALLBACK_MODEL || DEFAULT_FALLBACK_MODEL;
  const fetchFn = options.fetchFn || globalThis.fetch;

  const timeoutMs = getExtractionTimeoutMs(fileType, options.timeoutMs);
  const compiledSchema = compileModelZodSchema(schemaSnapshot);
  const attempts = [];

  // 1. Primary Model Attempt
  try {
    const primaryResult = await callModelWithSchema({
      modelName: primaryModel,
      rawData,
      schemaSnapshot,
      compiledSchema,
      timeoutMs,
      apiKey,
      baseUrl,
      fetchFn
    });

    const primaryAttempt = {
      model_used: primaryResult.model_used || primaryModel,
      prompt_tokens: primaryResult.prompt_tokens || 0,
      completion_tokens: primaryResult.completion_tokens || 0,
      is_failover: false,
      status: 'success'
    };
    attempts.push(primaryAttempt);

    if (typeof options.onAttempt === 'function') {
      await options.onAttempt(primaryAttempt);
    }

    return {
      data: primaryResult.data,
      metadata: {
        model_used: 'primary',
        model_name: primaryResult.model_used || primaryModel,
        prompt_tokens: primaryResult.prompt_tokens || 0,
        completion_tokens: primaryResult.completion_tokens || 0,
        timeout_ms: timeoutMs,
        attempts
      },
      model_used: primaryResult.model_used || primaryModel,
      prompt_tokens: primaryResult.prompt_tokens || 0,
      completion_tokens: primaryResult.completion_tokens || 0,
      attempts
    };
  } catch (primaryErr) {
    const primaryAttempt = {
      model_used: primaryErr.model_used || primaryModel,
      prompt_tokens: primaryErr.prompt_tokens || 0,
      completion_tokens: primaryErr.completion_tokens || 0,
      is_failover: false,
      status: 'error',
      error_message: primaryErr.message
    };
    attempts.push(primaryAttempt);

    if (typeof options.onAttempt === 'function') {
      await options.onAttempt(primaryAttempt);
    }

    if (!isFallbackEligibleError(primaryErr)) {
      primaryErr.attempts = attempts;
      throw primaryErr;
    }

    console.warn(
      `[AIClient] Primary model (${primaryModel}) failed (${primaryErr.name || 'Error'}: ${primaryErr.message}). ` +
      `Failing over to fallback model (${fallbackModel})...`
    );

    // 2. Fallover Execution to Fallback Model
    try {
      const fallbackResult = await callModelWithSchema({
        modelName: fallbackModel,
        rawData,
        schemaSnapshot,
        compiledSchema,
        timeoutMs,
        apiKey,
        baseUrl,
        fetchFn
      });

      const fallbackAttempt = {
        model_used: fallbackResult.model_used || fallbackModel,
        prompt_tokens: fallbackResult.prompt_tokens || 0,
        completion_tokens: fallbackResult.completion_tokens || 0,
        is_failover: true,
        status: 'success'
      };
      attempts.push(fallbackAttempt);

      if (typeof options.onAttempt === 'function') {
        await options.onAttempt(fallbackAttempt);
      }

      return {
        data: fallbackResult.data,
        metadata: {
          model_used: 'fallback',
          model_name: fallbackResult.model_used || fallbackModel,
          prompt_tokens: fallbackResult.prompt_tokens || 0,
          completion_tokens: fallbackResult.completion_tokens || 0,
          primary_error: primaryErr.message,
          timeout_ms: timeoutMs,
          attempts
        },
        model_used: fallbackResult.model_used || fallbackModel,
        prompt_tokens: fallbackResult.prompt_tokens || 0,
        completion_tokens: fallbackResult.completion_tokens || 0,
        attempts
      };
    } catch (fallbackErr) {
      const fallbackAttempt = {
        model_used: fallbackErr.model_used || fallbackModel,
        prompt_tokens: fallbackErr.prompt_tokens || 0,
        completion_tokens: fallbackErr.completion_tokens || 0,
        is_failover: true,
        status: 'error',
        error_message: fallbackErr.message
      };
      attempts.push(fallbackAttempt);

      if (typeof options.onAttempt === 'function') {
        await options.onAttempt(fallbackAttempt);
      }

      const totalErr = new Error(
        `AI extraction failed on both primary (${primaryModel}) and fallback (${fallbackModel}) models. ` +
        `Primary error: ${primaryErr.message}. Fallback error: ${fallbackErr.message}`
      );
      totalErr.attempts = attempts;
      throw totalErr;
    }
  }
}

/**
 * Extracts product attributes and returns token usage metrics.
 *
 * @param {...any} args - Can be called as (rawData, schemaSnapshot, options) or ({ rawData, schemaSnapshot, options })
 * @returns {Promise<Object>} Extracted product attributes with token telemetry
 */
export async function extractProductAttributes(...args) {
  let params;
  if (args.length === 1 && typeof args[0] === 'object' && ('rawData' in args[0] || 'text' in args[0])) {
    const raw = args[0].rawData || args[0].text;
    params = {
      rawData: raw,
      fileType: args[0].fileType || 'csv',
      schemaSnapshot: args[0].schemaSnapshot || args[0].modelSnapshot,
      options: args[0].options || args[0]
    };
  } else {
    const [rawData, schemaSnapshot, options] = args;
    params = { rawData, schemaSnapshot, options: options || {} };
  }

  const result = await extractWithFallback(params);
  return {
    attributes: result.data,
    data: result.data,
    model_used: result.model_used,
    prompt_tokens: result.prompt_tokens,
    completion_tokens: result.completion_tokens,
    metadata: result.metadata,
    attempts: result.attempts
  };
}

export default {
  CSV_TIMEOUT_MS,
  PDF_TIMEOUT_MS,
  getExtractionTimeoutMs,
  sanitizeJsonResponse,
  isFallbackEligibleError,
  extractWithFallback,
  extractProductAttributes
};
