import crypto from 'node:crypto';

export function computeSignature(secret, rawBody) {
  return `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

/** Constant-time comparison of GitHub's X-Hub-Signature-256 against our own HMAC of the raw bytes. */
export function isValidSignature(secret, rawBody, header) {
  if (typeof header !== 'string' || !Buffer.isBuffer(rawBody)) return false;
  const expected = Buffer.from(computeSignature(secret, rawBody));
  const given = Buffer.from(header);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

export function verifySignature(secret) {
  return (req, res, next) => {
    if (!isValidSignature(secret, req.body, req.get('x-hub-signature-256'))) {
      return res.status(401).json({ error: 'invalid signature' });
    }
    return next();
  };
}
