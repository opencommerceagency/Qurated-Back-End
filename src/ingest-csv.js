import fs from 'fs';
import { parse } from 'csv-parse';
import { z } from 'zod';
import path from 'path';
import { fileURLToPath } from 'url';
import iconv from 'iconv-lite';
import { normalizePrice } from './services/normalizer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Zod Schema Definition: This schema validates the shape and data types of each
// parsed row from the CSV. Using Zod guarantees I don't accidentally ingest corrupted
// or improperly formatted product data into the database.
const ProductSchema = z.object({
  sku: z.string().trim().min(1, "SKU is required"), // SKU must be non-empty
  name: z.string().trim().min(1, "Name is required"), // Product name must be non-empty
  threadSize: z.string().trim().nullable().transform(v => v === "" ? null : v), // Convert empty strings to NULL
  lengthMm: z.number().nullable(), // Allow nulls for products without length
  material: z.string().trim().transform(v => v.toUpperCase()), // Normalize materials to UPPERCASE
  finish: z.string().trim().nullable().transform(v => v === "" ? null : v), // Convert empty strings to NULL
  grade: z.string().trim().nullable().transform(v => v === "" ? null : v), // Convert empty strings to NULL
  priceExcl: z.number().positive("Price must be positive"), // Ensure pricing logic is sound
  stock: z.number().int().nonnegative("Stock must be non-negative") // Ensure stock doesn't go below 0
});

/**
 * Parses a given CSV file, maps its columns from Dutch to English camelCase,
 * and validates each row against a strict Zod schema.
 * 
 * @param {string} targetPath - The absolute file path to the CSV file to parse.
 * @param {Object} [options] - Stream configuration options (encoding, delimiter)
 * @returns {Promise<Object>} A summary object containing the valid and flagged records.
 */
export const parseCsvFile = (targetPath, options = {}) => {
  return new Promise((resolve, reject) => {
    const encoding = options.encoding || 'utf-8';
    const delimiter = options.delimiter || ',';

    // Arrays to collect valid output and records that failed validation
    const validProducts = [];
    const flaggedRecords = [];
    let totalRowsProcessed = 0;

    fs.createReadStream(targetPath)
      .pipe(iconv.decodeStream(encoding))
      .pipe(parse({
        columns: true,
        skip_empty_lines: true,
        trim: true,
        delimiter: delimiter
      }))
      .on('data', (row) => {
        totalRowsProcessed++;

        // Map raw Dutch merchant headers to English camelCase property names
        // Also apply very basic type coersion (parseInt/parseFloat) before hitting Zod
        const mappedRecord = {
          sku: row.artikel_nr,
          name: row.omschrijving,
          threadSize: row.schroefdraad_maat || null,
          lengthMm: row.lengte_mm ? (isNaN(parseFloat(row.lengte_mm)) ? null : parseFloat(row.lengte_mm)) : null,
          material: row.materiaal || "",
          finish: row.oppervlaktebehandeling || null,
          grade: row.sterkteklasse || null,
          // Use normalizePrice to handle European decimal formats properly
          priceExcl: row.prijs_excl ? normalizePrice(row.prijs_excl) : -1, // Use -1 to purposely fail Zod validation if missing
          stock: row.voorraad ? parseInt(row.voorraad, 10) : -1 // Use -1 to purposely fail Zod validation if missing
        };

        // Validate the mapped object against the Zod schema
        const result = ProductSchema.safeParse(mappedRecord);

        if (result.success) {
          // If the data passes validation, push to the valid output array
          validProducts.push(result.data);
        } else {
          // If the data fails validation, record the raw row and exact errors for debugging/reporting
          flaggedRecords.push({
            rowNumber: totalRowsProcessed,
            rawRecord: row,
            errors: result.error.issues.map(err => `${err.path.join('.')}: ${err.message}`)
          });
        }
      })
      .on('end', () => {
        // Once the file stream completes, resolve the promise with the final batch summary
        resolve({
          totalRowsProcessed,
          validRecordsCount: validProducts.length,
          flaggedRecordsCount: flaggedRecords.length,
          validProducts,
          flaggedRecords
        });
      })
      .on('error', (err) => {
        reject(err);
      });
  });
};

// Check if running directly as a script
if (process.argv[1] === __filename) {
  const csvFilePath = path.join(__dirname, '..', 'mock_pushop.csv');
  parseCsvFile(csvFilePath)
    .then(summary => console.log(JSON.stringify(summary, null, 2)))
    .catch(err => console.error('Error parsing CSV:', err));
}
