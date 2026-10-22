import { PassThrough } from 'stream';
import { validateSafeUrl } from '../utils/urlValidator.js';

// Streams remote CSV / data over HTTP/HTTPS
export async function downloadHttpStream(connectionConfig) {
  // Block SSRF and private IP ranges
  validateSafeUrl(connectionConfig?.url);

  // Set up an abort controller to enforce a 15-second timeout on the request
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(connectionConfig.url, {
      signal: controller.signal
    });

    // Clear the timeout since the initial response was received
    clearTimeout(timeoutId);

    if (!res.ok) {
      throw new Error(`HTTP Error: ${res.status}`);
    }

    // Inspect Content-Type header to ensure the supplier didn't return an HTML error page
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('text/html')) {
      throw new Error('Supplier returned an HTML page instead of a CSV');
    }

    // I peek at the first chunk to ensure the supplier didn't return HTML disguised as a 200
    const reader = res.body.getReader();
    const { value: firstChunk, done } = await reader.read();
    
    // If stream is empty, return an empty PassThrough
    if (done) {
      const emptyStream = new PassThrough();
      emptyStream.end();
      return emptyStream;
    }

    // Inspect the decoded beginning for HTML tags
    const chunkString = new TextDecoder().decode(firstChunk);
    if (chunkString.trimStart().startsWith('<')) {
      throw new Error('Supplier returned an HTML page instead of a CSV');
    }

    const outputStream = new PassThrough();

    // Push the peeked chunk into the stream so no data is lost
    outputStream.write(firstChunk);

    // Pipe the remaining chunks to the output stream
    (async () => {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) {
            outputStream.end();
            break;
          }
          outputStream.write(value);
        }
      } catch (err) {
        outputStream.destroy(err);
      }
    })();

    return outputStream;
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}
