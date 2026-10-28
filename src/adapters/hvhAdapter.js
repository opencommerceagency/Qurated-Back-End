import fs from 'fs';
import { Readable } from 'stream';
import sax from 'sax';

// Streams an XML feed from a stream, URL, or local file and extracts product records
export async function streamHvhXml(streamOrTarget, onProduct) {
    let stream;

    // Normalize input into a readable stream
    if (streamOrTarget && typeof streamOrTarget.pipe === 'function') {
        stream = streamOrTarget;
    } else if (typeof streamOrTarget === 'string' && (streamOrTarget.startsWith('http://') || streamOrTarget.startsWith('https://'))) {
        const response = await fetch(streamOrTarget);
        if (!response.ok) {
            throw new Error(`Failed to fetch XML stream from ${streamOrTarget}: HTTP ${response.status}`);
        }
        stream = Readable.fromWeb(response.body);
    } else if (typeof streamOrTarget === 'string' && fs.existsSync(streamOrTarget)) {
        stream = fs.createReadStream(streamOrTarget, { encoding: 'utf8' });
    } else {
        throw new Error(`File or URL target not accessible: ${streamOrTarget}`);
    }

    return new Promise((resolve, reject) => {
        // Use a streaming SAX XML parser to keep memory footprint minimal
        const parser = sax.createStream(true, { trim: true });

        let currentProduct = null;
        let currentTag = null;
        let insideProduct = false;
        let insideCategories = false;
        let count = 0;

        // Forward stream and parsing errors to reject the promise
        stream.on('error', (err) => reject(err));
        parser.on('error', (err) => reject(err));

        // Detect opening tags for product elements or category trees
        parser.on('opentag', (node) => {
            currentTag = node.name;

            if (node.name === 'product') {
                insideProduct = true;
                currentProduct = {
                    properties: {},
                };
            } else if (node.name === 'categories') {
                insideCategories = true;
            }
        });

        // Extract text nodes inside active product tags
        parser.on('text', (text) => {
            if (!insideProduct || insideCategories) return;

            // Save known top-level fields directly, collect additional attributes into properties
            if (['id', 'sku', 'title', 'name', 'price', 'stock', 'description', 'ean'].includes(currentTag)) {
                currentProduct[currentTag] = text;
            } else if (currentTag) {
                currentProduct.properties[currentTag] = text;
            }
        });

        // Emit complete product records to the callback on tag close
        parser.on('closetag', async (tagName) => {
            if (tagName === 'categories') {
                insideCategories = false;
            } else if (tagName === 'product') {
                insideProduct = false;
                count++;

                if (onProduct && currentProduct) {
                    // Backpressure: pause the parser while the async callback processes
                    parser.pause();
                    try {
                        await onProduct(currentProduct);
                    } catch (err) {
                        return reject(err);
                    }
                    parser.resume();
                }
                currentProduct = null;
            }
            currentTag = null;
        });

        // Resolve with total processed count when the stream ends
        parser.on('end', () => {
            resolve({ processedProducts: count });
        });

        // Pipe the stream into the SAX parser
        stream.pipe(parser);
    });
}