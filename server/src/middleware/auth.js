import crypto from 'node:crypto';

/** Optional bearer-token guard for the dashboard API. Disabled when no key is configured. */
export function apiKeyAuth(apiKey) {
  if (!apiKey) return (_req, _res, next) => next();
  const expected = crypto.createHash('sha256').update(apiKey).digest();
  return (req, res, next) => {
    const header = req.get('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const given = crypto.createHash('sha256').update(token).digest(); // hash => equal length for timingSafeEqual
    if (!crypto.timingSafeEqual(expected, given)) return res.status(401).json({ error: 'unauthorized' });
    return next();
  };
}
