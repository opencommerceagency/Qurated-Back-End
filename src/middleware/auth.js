// Protect /api endpoints using either an API key header/token or HTTP Basic Auth
export function authenticateApi(req, res, next) {
  // Let pre-flight OPTIONS requests pass through for browser CORS
  if (req.method === 'OPTIONS') {
    return next();
  }

  // Fail closed if the server authentication credentials have not been configured
  const expectedApiKey = process.env.API_KEY ? process.env.API_KEY.trim() : '';
  const expectedUser = process.env.API_AUTH_USER ? process.env.API_AUTH_USER.trim() : '';
  const expectedPass = process.env.API_AUTH_PASS ? process.env.API_AUTH_PASS.trim() : '';

  const hasApiKey = Boolean(expectedApiKey);
  const hasBasicAuth = Boolean(expectedUser && expectedPass);

  // Reject requests with a 500 if API_KEY is missing from the environment
  if (!hasApiKey) {
    return res.status(500).json({
      error: 'Server authentication misconfiguration'
    });
  }

  // Check for the custom x-api-key header first
  const apiKeyHeader = req.headers['x-api-key'];
  if (hasApiKey && apiKeyHeader && apiKeyHeader === expectedApiKey) {
    return next();
  }

  // Check Authorization header for Bearer token or Basic Auth
  const authHeader = req.headers['authorization'];
  if (authHeader) {
    // Bearer token format
    if (authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7).trim();
      if (hasApiKey && token === expectedApiKey) {
        return next();
      }
    }

    // Basic Auth format
    if (authHeader.startsWith('Basic ') && hasBasicAuth) {
      const b64 = authHeader.slice(6).trim();
      try {
        const decoded = Buffer.from(b64, 'base64').toString('utf8');
        const [user, pass] = decoded.split(':');
        if (user === expectedUser && pass === expectedPass) {
          return next();
        }
      } catch {
        // Drop through to 401 on malformed base64
      }
    }
  }

  // Reject callers that provided invalid or missing credentials
  return res.status(401).json({
    error: 'Unauthorized: Valid API key (x-api-key or Bearer token) or Basic Auth required.'
  });
}
