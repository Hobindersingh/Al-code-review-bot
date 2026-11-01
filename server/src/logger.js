import pino from 'pino';

export function createLogger(level = 'info') {
  return pino({
    level,
    redact: ['req.headers.authorization', 'req.headers["x-hub-signature-256"]', '*.apiKey', '*.token'],
  });
}
