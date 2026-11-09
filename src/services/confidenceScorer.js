import { normalizePrice, extractUnit } from './normalizer.js';

// Base conversion factors for canonical units
const UNIT_CONVERSIONS = {
  // Mass -> base: grams (g)
  g: { base: 'g', factor: 1 },
  gram: { base: 'g', factor: 1 },
  grams: { base: 'g', factor: 1 },
  kg: { base: 'g', factor: 1000 },
  kilogram: { base: 'g', factor: 1000 },
  kilograms: { base: 'g', factor: 1000 },
  mg: { base: 'g', factor: 0.001 },
  milligram: { base: 'g', factor: 0.001 },
  milligrams: { base: 'g', factor: 0.001 },

  // Length -> base: millimeters (mm)
  mm: { base: 'mm', factor: 1 },
  millimeter: { base: 'mm', factor: 1 },
  millimeters: { base: 'mm', factor: 1 },
  cm: { base: 'mm', factor: 10 },
  centimeter: { base: 'mm', factor: 10 },
  centimeters: { base: 'mm', factor: 10 },
  m: { base: 'mm', factor: 1000 },
  meter: { base: 'mm', factor: 1000 },
  meters: { base: 'mm', factor: 1000 },
  km: { base: 'mm', factor: 1000000 },

  // Volume -> base: milliliters (ml)
  ml: { base: 'ml', factor: 1 },
  milliliter: { base: 'ml', factor: 1 },
  cl: { base: 'ml', factor: 10 },
  centiliter: { base: 'ml', factor: 10 },
  l: { base: 'ml', factor: 1000 },
  liter: { base: 'ml', factor: 1000 },
  liters: { base: 'ml', factor: 1000 }
};

/**
 * Checks if two unit measurements are equivalent in base units.
 */
function areUnitsEquivalent(val1, unit1, val2, unit2) {
  if (!unit1 || !unit2) return false;
  const u1 = UNIT_CONVERSIONS[unit1.toLowerCase()];
  const u2 = UNIT_CONVERSIONS[unit2.toLowerCase()];

  if (!u1 || !u2 || u1.base !== u2.base) {
    return false;
  }

  const base1 = Number(val1) * u1.factor;
  const base2 = Number(val2) * u2.factor;

  return Math.abs(base1 - base2) < 0.0001;
}

/**
 * Checks boolean semantic equivalents in raw text with strict boundary matching.
 * Does not match stray '0' or '1' inside arbitrary numbers or sentences.
 */
function isBooleanEquivalent(extractedBool, rawText) {
  if (typeof extractedBool !== 'boolean' || !rawText) return false;

  const text = String(rawText).toLowerCase().trim();

  if (extractedBool === true) {
    if (text === '1') return true;
    if (/(?:^|\s|[:=])1(?:\s|$)/.test(text) && /\b(?:in_?stock|stock|available|active|enabled|voorraad)\b/i.test(text)) {
      return true;
    }
    const positivePattern = /\b(yes|ja|in\s*stock|op\s*voorraad|true|available|beschikbaar)\b/i;
    return positivePattern.test(text);
  }

  if (extractedBool === false) {
    if (text === '0') return true;
    if (/(?:^|\s|[:=])0(?:\s|$)/.test(text) && /\b(?:in_?stock|stock|available|active|enabled|voorraad)\b/i.test(text)) {
      return true;
    }
    const negativePattern = /\b(no|nee|out\s*of\s*stock|niet\s*op\s*voorraad|false|unavailable|geen\s*voorraad)\b/i;
    return negativePattern.test(text);
  }

  return false;
}

/**
 * Calculates a deterministic confidence score (0–100) for an extracted attribute:
 *
 * Rule 1 (High: 90–100):
 * - Exact literal substring match in raw source value.
 * - Score: 100 (exact) or 95 (substring/punctuation differences).
 *
 * Rule 2 (Medium: 75–89):
 * - Matches after canonical unit conversion (e.g., "1.3 kg" -> 1300 g),
 *   number formatting normalization (European decimals "80,50" -> 80.5),
 *   or boolean semantic equivalents ("in stock" -> true).
 * - Score: 85.
 *
 * Rule 3 (Low: < 75):
 * - Synthesized, inferred, or hallucinated value where no literal or unit-normalized equivalent exists.
 * - Score: 50.
 *
 * @param {Object} params
 * @param {*} params.extractedValue - Extracted attribute value
 * @param {string|null} params.rawSourceValue - Raw unnormalized source snippet
 * @param {string} [params.attributeType] - Optional attribute data type ('string', 'integer', 'boolean', etc.)
 * @param {string} [params.unit] - Target unit for physical measurements (e.g., 'g', 'mm')
 * @returns {number} Integer confidence score (0-100)
 */
export function calculateConfidenceScore({
  extractedValue,
  rawSourceValue,
  attributeType = null,
  unit = null
}) {
  if (extractedValue === null || extractedValue === undefined) {
    return 0;
  }

  if (rawSourceValue === null || rawSourceValue === undefined) {
    return 50; // Inferred / absent raw snippet -> Rule 3
  }

  const rawStr = String(rawSourceValue).trim().toLowerCase();
  const extStr = String(extractedValue).trim().toLowerCase();

  if (!rawStr) {
    return 50;
  }

  // --- Rule 1: High Confidence (90–100) ---
  // Exact literal full match
  if (rawStr === extStr) {
    return 100;
  }

  // Punctuation-stripped exact match (preserves commas and decimals to keep number semantics)
  const stripPunct = (s) => s.replace(/[/#!$%^&*;:{}=\-_`~()]/g, '').replace(/\s+/g, ' ').trim();
  if (stripPunct(rawStr) === stripPunct(extStr) && extStr.length > 0) {
    return 95;
  }

  // Token boundary substring match (e.g., raw contains "M8" or "8.8" or "316 Stainless" as distinct token)
  const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tokenRegex = new RegExp(`(?:^|[^a-zA-Z0-9])${escapeRegExp(extStr)}(?:$|[^a-zA-Z0-9])`, 'i');
  if (extStr.length > 0 && tokenRegex.test(rawStr)) {
    return 95;
  }

  // Check punctuation-stripped token boundary match
  const strippedExt = stripPunct(extStr);
  const strippedRaw = stripPunct(rawStr);
  if (strippedExt.length > 0) {
    const strippedRegex = new RegExp(`(?:^|[^a-zA-Z0-9])${escapeRegExp(strippedExt)}(?:$|[^a-zA-Z0-9])`, 'i');
    if (strippedRegex.test(strippedRaw)) {
      return 95;
    }
  }

  // --- Rule 2: Medium Confidence (75–89) ---
  // 1. Boolean equivalence
  if (typeof extractedValue === 'boolean' || attributeType === 'boolean') {
    const boolVal = typeof extractedValue === 'boolean' ? extractedValue : extStr === 'true' || extStr === '1';
    if (isBooleanEquivalent(boolVal, rawStr)) {
      return 85;
    }
  }

  // 2. Number & European decimal normalization (e.g., "80,50" -> 80.5)
  const numExt = typeof extractedValue === 'number' ? extractedValue : parseFloat(extStr.replace(',', '.'));
  if (!isNaN(numExt)) {
    const normalizedRawPrice = normalizePrice(rawStr);
    if (normalizedRawPrice !== null && Math.abs(normalizedRawPrice - numExt) < 0.0001) {
      return 85;
    }

    // Check tokens in raw string for matching decimal numbers (e.g., raw snippet "Price: € 80,50 excl VAT")
    const numberTokens = rawStr.match(/[\d.,]+/g) || [];
    for (const token of numberTokens) {
      const parsedToken = normalizePrice(token);
      if (parsedToken !== null && Math.abs(parsedToken - numExt) < 0.0001) {
        return 85;
      }
    }
  }

  // 3. Canonical unit conversions (e.g. "1.3 kg" -> 1300 g or "100 cm" -> 1 m)
  let effectiveUnit = unit;
  let effectiveExtNum = numExt;
  if (!effectiveUnit) {
    const extUnitData = extractUnit(extStr);
    if (extUnitData) {
      effectiveUnit = extUnitData.unit;
      effectiveExtNum = extUnitData.value;
    }
  }

  if (effectiveUnit && !isNaN(effectiveExtNum)) {
    const declaredConf = UNIT_CONVERSIONS[effectiveUnit.toLowerCase()];
    if (declaredConf) {
      // Check if rawSourceValue itself is an embedded unit with the same base
      const rawUnitData = extractUnit(rawStr);
      if (rawUnitData) {
        const rawConf = UNIT_CONVERSIONS[rawUnitData.unit?.toLowerCase()];
        if (rawConf && rawConf.base === declaredConf.base) {
          if (areUnitsEquivalent(rawUnitData.value, rawUnitData.unit, effectiveExtNum, effectiveUnit)) {
            return 85;
          }
        }
      }

      // Check if raw string contains a composite unit token anywhere with the same base (e.g., "Weight: 1.3 kg")
      const compositeMatches = rawStr.match(/([\d.,]+)\s*([a-zA-Z]+)/g) || [];
      for (const comp of compositeMatches) {
        const parsedComp = extractUnit(comp);
        if (parsedComp) {
          const compConf = UNIT_CONVERSIONS[parsedComp.unit?.toLowerCase()];
          if (compConf && compConf.base === declaredConf.base) {
            if (areUnitsEquivalent(parsedComp.value, parsedComp.unit, effectiveExtNum, effectiveUnit)) {
              return 85;
            }
          }
        }
      }
    }
  }

  // --- Rule 3: Low Confidence (< 75) ---
  // Inferred, synthesized, or hallucinated
  return 50;
}

export default {
  calculateConfidenceScore
};
