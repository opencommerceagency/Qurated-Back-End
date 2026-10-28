import { downloadFtpStream } from './ftpDownloader.js';
import { downloadHttpStream } from './httpDownloader.js';
import { failIngestionRun } from '../db/ingestionHelpers.js';

// Resolves transport protocol ('FTP' or 'HTTP') by checking explicit protocol flags,
// URL scheme prefixes, and fallback connection properties
export function resolveProtocol(source) {
  const connConfig = source?.connection_config || {};

  if (source?.protocol) {
    const proto = String(source.protocol).trim().toUpperCase();
    if (['FTP', 'SFTP'].includes(proto)) return 'FTP';
    if (['HTTP', 'HTTPS', 'API'].includes(proto)) return 'HTTP';
  }

  if (connConfig.protocol) {
    const proto = String(connConfig.protocol).trim().toUpperCase();
    if (['FTP', 'SFTP'].includes(proto)) return 'FTP';
    if (['HTTP', 'HTTPS', 'API'].includes(proto)) return 'HTTP';
  }

  if (connConfig.url && typeof connConfig.url === 'string') {
    const lowerUrl = connConfig.url.trim().toLowerCase();
    if (lowerUrl.startsWith('ftp://') || lowerUrl.startsWith('sftp://') || lowerUrl.startsWith('ftp')) {
      return 'FTP';
    }
    if (lowerUrl.startsWith('http://') || lowerUrl.startsWith('https://')) {
      return 'HTTP';
    }
  }

  if (source?.type) {
    const typeUpper = String(source.type).trim().toUpperCase();
    if (['FTP', 'SFTP'].includes(typeUpper)) return 'FTP';
    if (['HTTP', 'HTTPS'].includes(typeUpper)) return 'HTTP';
  }

  if (connConfig.host && (connConfig.user || connConfig.port === 21)) {
    return 'FTP';
  }

  if (connConfig.url) {
    return 'HTTP';
  }

  return null;
}

// Routes download requests to the FTP or HTTP streaming downloader
export async function fetchSourceStream(source, runId) {
  try {
    const protocol = resolveProtocol(source);
    let stream;
    
    // Route to the appropriate downloader based on resolved protocol
    if (protocol === 'FTP') {
      stream = await downloadFtpStream(source.connection_config);
    } else if (protocol === 'HTTP') {
      stream = await downloadHttpStream(source.connection_config);
    } else {
      throw new Error(`Unable to determine transport protocol for source: ${source?.name || source?.id || 'unknown'}`);
    }
    
    return stream;
  } catch (error) {
    // Record run failure on connection errors before rethrowing
    if (runId) {
      await failIngestionRun(runId, error.message);
    }
    throw error;
  }
}
