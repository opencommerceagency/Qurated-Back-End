/**
 * Normalization Rules & Edge Case Validation for Ingestion (Milestone B1.3-T3 & B4.1)
 * 
 * Provides:
 * 1. SKU validation (detects missing or whitespace-only SKUs)
 * 2. Modulo-10 checksum verification for EAN-13 and UPC-12 barcodes
 * 3. Schema Pre-processor: Auto-padding 12-digit EANs to 13 digits (Puchshop edge cases)
 * 4. European & US price parsing (currency symbols, comma/dot decimals)
 * 5. Embedded unit extraction (composite measurement strings like "1300 gram", "2.5 kg")
 * 6. Full row evaluation returning { isValid, reasons, normalized }
 */

/**
 * Automatically pads 12-digit barcodes (UPC-12 or shortened EAN-13 missing a leading zero)
 * to 13 digits with a leading zero to handle supplier edge cases (such as Puchshop).
 * 
 * @param {string|number} ean - The raw barcode / EAN / UPC value
 * @returns {string|null} - 13-digit EAN string, or original trimmed string if not 12 digits
 */
export function padEan(ean) {
  if (ean === null || ean === undefined) return null;
  const str = String(ean).trim();
  if (!str) return null;

  const clean = str.replace(/[-\s]/g, '');
  if (!/^\d+$/.test(clean)) return clean;

  if (clean.length === 12) {
    return '0' + clean;
  }

  return clean;
}

/**
 * Schema Pre-processor helper for Zod schemas or attribute pipelines.
 * Coerces numbers/strings and automatically pads 12-digit barcodes to 13 digits.
 * 
 * @param {unknown} val - Incoming raw value
 * @returns {unknown} - Pre-processed value
 */
export function eanPreProcessor(val) {
  if (val === null || val === undefined || val === '') return val;
  const str = typeof val === 'number' ? String(val) : String(val).trim();
  const clean = str.replace(/[-\s]/g, '');
  if (/^\d{12}$/.test(clean)) {
    return '0' + clean;
  }
  return str;
}

/**
 * Validates an EAN-13 or UPC-12 barcode using modulo-10 checksum validation.
 * Automatically pads 12-digit UPCs/EANs with a leading zero to conform to EAN-13.
 * 
 * @param {string|number} ean - The raw barcode / EAN / UPC value
 * @returns {boolean} - True if valid modulo-10 checksum, false otherwise
 */
export function isValidEan(ean) {
  if (ean === null || ean === undefined) return false;
  const str = String(ean).trim();
  if (!str) return false;

  // Barcode must only contain digits (hyphens/spaces are stripped)
  const clean = str.replace(/[-\s]/g, '');
  if (!/^\d+$/.test(clean)) return false;

  let code = clean;
  // Pad 12-digit UPC to 13 digits with leading 0
  if (code.length === 12) {
    code = '0' + code;
  }

  // Must be strictly 13 digits for EAN-13 evaluation
  if (code.length !== 13) return false;

  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const digit = parseInt(code[i], 10);
    sum += (i % 2 === 0) ? digit : digit * 3;
  }

  const checkDigit = (10 - (sum % 10)) % 10;
  return checkDigit === parseInt(code[12], 10);
}

/**
 * Normalizes European & US prices into standard floats.
 * Handles "€ 80,56", "1.280,56", "80.56", "$ 1,280.56", etc.
 * 
 * @param {string|number} priceStr - The raw price representation
 * @returns {number|null} - Parsed float value, or null if unparseable/invalid
 */
export function normalizePrice(priceStr) {
  if (priceStr === null || priceStr === undefined) return null;
  if (typeof priceStr === 'number') {
    return (isNaN(priceStr) || !isFinite(priceStr)) ? null : priceStr;
  }

  let str = priceStr.toString().trim();
  if (!str) return null;

  // Remove common currency symbols and whitespace
  str = str.replace(/[€$£¥\s]/g, '').trim();
  if (!str) return null;

  // If characters other than digits, dots, commas, or minus remain, it is unparseable
  if (/[^\d.,-]/.test(str)) {
    return null;
  }

  // Handle number separators
  if (str.includes('.') && str.includes(',')) {
    const lastDot = str.lastIndexOf('.');
    const lastComma = str.lastIndexOf(',');
    if (lastComma > lastDot) {
      // European format: 1.280,56 -> remove dots, replace comma with dot
      str = str.replace(/\./g, '').replace(',', '.');
    } else {
      // US format: 1,280.56 -> remove commas
      str = str.replace(/,/g, '');
    }
  } else if (str.includes(',')) {
    // Only comma(s): European decimal e.g. "80,56" or thousands separator "1,000,000"
    const parts = str.split(',');
    if (parts.length === 2) {
      str = parts[0] + '.' + parts[1];
    } else {
      str = str.replace(/,/g, '');
    }
  } else if (str.includes('.')) {
    // Only dot(s): e.g. "80.56" or thousands "1.000.000"
    const parts = str.split('.');
    if (parts.length > 2) {
      // If multiple dots, check if they are thousands separators (3 digits between dots)
      if (parts.slice(1).some(p => p.length !== 3)) {
        return null; // Corrupted decimal like "12.34.56"
      }
      str = parts.join('');
    }
  }

  const val = parseFloat(str);
  if (isNaN(val) || !isFinite(val)) return null;
  return val;
}

/**
 * Standard unit mapping dictionary.
 */
const UNIT_MAP = {
  gram: 'g',
  grams: 'g',
  g: 'g',
  kg: 'kg',
  kilogram: 'kg',
  kilograms: 'kg',
  mg: 'mg',
  milligram: 'mg',
  milligrams: 'mg',
  ml: 'ml',
  milliliter: 'ml',
  milliliters: 'ml',
  millilitre: 'ml',
  millilitres: 'ml',
  cl: 'cl',
  centiliter: 'cl',
  centiliters: 'cl',
  l: 'l',
  liter: 'l',
  liters: 'l',
  litre: 'l',
  litres: 'l',
  m: 'm',
  meter: 'm',
  meters: 'm',
  metre: 'm',
  metres: 'm',
  cm: 'cm',
  centimeter: 'cm',
  centimeters: 'cm',
  mm: 'mm',
  millimeter: 'mm',
  millimeters: 'mm',
  km: 'km',
  kilometer: 'km',
  kilometers: 'km',
  pcs: 'pcs',
  piece: 'pcs',
  pieces: 'pcs',
  st: 'pcs',
  stuks: 'pcs'
};

/**
 * Detects and extracts embedded units from composite strings.
 * E.g. "1300 gram" -> { value: 1300, unit: "g" }
 *      "2.5 kg"     -> { value: 2.5, unit: "kg" }
 *      "500ml"      -> { value: 500, unit: "ml" }
 *      "10 m"       -> { value: 10, unit: "m" }
 * 
 * @param {string} text - The input string containing value and unit
 * @returns {{ value: number, unit: string } | null}
 */
export function extractUnit(text) {
  if (text === null || text === undefined) return null;
  const str = String(text).trim();
  if (!str) return null;

  const match = str.match(/^([\d.,]+)\s*([a-zA-Z]+)$/);
  if (!match) return null;

  const rawNum = match[1];
  const rawUnit = match[2].toLowerCase();

  const val = normalizePrice(rawNum);
  if (val === null) return null;

  const unit = UNIT_MAP[rawUnit] || rawUnit;
  return { value: val, unit };
}

/**
 * Evaluates a single record row against all normalization rules:
 * - SKU exists and is non-empty after trimming (else: 'MISSING_SKU')
 * - Barcode/EAN checksum valid if present, auto-padded to 13 digits (else: 'INVALID_EAN_CHECKSUM')
 * - Price format parseable and non-negative (else: 'INVALID_PRICE')
 * - Composite unit string extracted if present
 * 
 * @param {Object} row - Raw CSV/XLSX record object
 * @returns {{ isValid: boolean, reasons: string[], normalized: Object|null }}
 */
export function normalizeRow(row) {
  if (!row || typeof row !== 'object') {
    return {
      isValid: false,
      reasons: ['INVALID_ROW'],
      normalized: null
    };
  }

  const reasons = [];

  // 1. SKU Validation
  const rawSku = row.sku ?? row.artikel_nr ?? row.id ?? row.article_number ?? row.product_id;
  let sku = null;
  if (rawSku === undefined || rawSku === null || String(rawSku).trim() === '') {
    reasons.push('MISSING_SKU');
  } else {
    sku = String(rawSku).trim();
  }

  // 2. Barcode / EAN Checksum Verification & Pre-processing (Pad 12-digit to 13-digit)
  const rawEan = row.ean ?? row.barcode ?? row.upc ?? row.gtin;
  let ean = null;
  if (rawEan !== undefined && rawEan !== null && String(rawEan).trim() !== '') {
    const paddedEan = padEan(rawEan);
    if (!isValidEan(paddedEan)) {
      reasons.push('INVALID_EAN_CHECKSUM');
    } else {
      ean = paddedEan;
    }
  }

  // 3. European Price Normalization
  const rawPrice = row.price ?? row.prijs_excl ?? row.prijs ?? row.unit_price ?? row.amount;
  let price = null;
  let currency = 'EUR';

  if (row.currency || row.valuta) {
    currency = String(row.currency || row.valuta).trim().toUpperCase();
  }

  if (rawPrice !== undefined && rawPrice !== null && String(rawPrice).trim() !== '') {
    const priceStr = String(rawPrice).trim();
    if (priceStr.includes('$')) currency = 'USD';
    else if (priceStr.includes('£')) currency = 'GBP';
    else if (priceStr.includes('€')) currency = 'EUR';

    const parsedPrice = normalizePrice(rawPrice);
    if (parsedPrice === null || parsedPrice < 0) {
      reasons.push('INVALID_PRICE');
    } else {
      price = parsedPrice;
    }
  }

  // 4. Name extraction
  const rawName = row.name ?? row.omschrijving ?? row.title ?? row.product_name ?? row.description;
  const name = (rawName !== undefined && rawName !== null && String(rawName).trim() !== '')
    ? String(rawName).trim()
    : null;

  // 5. Embedded Unit Extraction
  let unitValue = null;
  let unitType = null;

  if (row.unit_value !== undefined && row.unit_value !== null && row.unit_type) {
    unitValue = normalizePrice(row.unit_value);
    unitType = String(row.unit_type).trim();
  } else {
    const unitSource = row.unit ?? row.weight ?? row.gewicht ?? row.inhoud ?? row.package_size ?? row.size;
    if (unitSource) {
      const unitData = extractUnit(unitSource);
      if (unitData) {
        unitValue = unitData.value;
        unitType = unitData.unit;
      }
    }
  }

  const isValid = reasons.length === 0;

  return {
    isValid,
    reasons,
    normalized: isValid ? {
      sku,
      name,
      price,
      currency,
      ean,
      unit_value: unitValue,
      unit_type: unitType,
      raw_data: row
    } : null
  };
}

export default {
  padEan,
  eanPreProcessor,
  isValidEan,
  normalizePrice,
  extractUnit,
  normalizeRow
};
