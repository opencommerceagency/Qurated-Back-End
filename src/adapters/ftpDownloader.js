import * as ftp from 'basic-ftp';
import { PassThrough } from 'stream';
import { isPrivateOrLocalHost, validateSafeUrl } from '../utils/urlValidator.js';

// Streams remote file contents over FTP
export async function downloadFtpStream(connectionConfig) {
  // Guard against SSRF and local host connections
  if (connectionConfig?.url) {
    validateSafeUrl(connectionConfig.url);
  }
  if (connectionConfig?.host && isPrivateOrLocalHost(connectionConfig.host)) {
    throw new Error(`Access to private or local host '${connectionConfig.host}' is blocked for security.`);
  }

  const client = new ftp.Client();
  client.ftp.verbose = false;
  client.ftp.timeout = 15000;
  
  // Initialize a PassThrough stream to return to the caller
  const passThrough = new PassThrough();

  try {
    await client.access({
      host: connectionConfig.host,
      user: connectionConfig.user,
      password: connectionConfig.password,
      port: connectionConfig.port || 21,
      secure: connectionConfig.secure || false,
    });
    
    // Pipe the remote file into the PassThrough stream
    // I don't await this because I want to return the stream immediately
    // so downstream consumers can start processing it
    client.downloadTo(passThrough, connectionConfig.remotePath)
      .then(() => {
        client.close();
      })
      .catch((err) => {
        passThrough.destroy(err);
        client.close();
      });

    return passThrough;
  } catch (error) {
    client.close();
    throw error;
  }
}
