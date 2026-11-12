export const MODEL_PRICING = {
  'anthropic/claude-3.5-sonnet': {
    promptPricePerMillion: 3.00,
    completionPricePerMillion: 15.00
  },
  'openai/gpt-4o-mini': {
    promptPricePerMillion: 0.15,
    completionPricePerMillion: 0.60
  },
  'openai/gpt-4o': {
    promptPricePerMillion: 2.50,
    completionPricePerMillion: 10.00
  },
  'google/gemini-flash-1.5': {
    promptPricePerMillion: 0.075,
    completionPricePerMillion: 0.30
  },
  'default': {
    promptPricePerMillion: 3.00,
    completionPricePerMillion: 15.00
  }
};

/**
 * Resolves the pricing tiers for a given model name.
 * Matches exact, case-insensitive, or base model prefixes.
 *
 * @param {string} modelName - OpenRouter model identifier
 * @returns {{ promptPricePerMillion: number, completionPricePerMillion: number }}
 */
export function getModelPricing(modelName) {
  if (!modelName || typeof modelName !== 'string') {
    return MODEL_PRICING['default'];
  }

  const norm = modelName.toLowerCase().trim();
  if (MODEL_PRICING[norm]) {
    return MODEL_PRICING[norm];
  }

  for (const key of Object.keys(MODEL_PRICING)) {
    if (key !== 'default' && (norm.startsWith(key) || norm.includes(key))) {
      return MODEL_PRICING[key];
    }
  }

  return MODEL_PRICING['default'];
}

/**
 * Calculates token costs in USD given token usage and model identifier.
 *
 * @param {string} modelName - Model identifier
 * @param {number} promptTokens - Count of prompt tokens
 * @param {number} completionTokens - Count of completion tokens
 * @returns {{ promptCost: number, completionCost: number, totalCost: number }}
 */
export function calculateTokenCost(modelName, promptTokens = 0, completionTokens = 0) {
  const pricing = getModelPricing(modelName);
  const prompt = Number(promptTokens) || 0;
  const completion = Number(completionTokens) || 0;

  const promptCost = (prompt / 1_000_000) * pricing.promptPricePerMillion;
  const completionCost = (completion / 1_000_000) * pricing.completionPricePerMillion;
  const totalCost = promptCost + completionCost;

  return {
    promptCost: Number(promptCost.toFixed(8)),
    completionCost: Number(completionCost.toFixed(8)),
    totalCost: Number(totalCost.toFixed(8))
  };
}

export default {
  MODEL_PRICING,
  getModelPricing,
  calculateTokenCost
};

