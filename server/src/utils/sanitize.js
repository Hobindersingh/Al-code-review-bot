const ZWSP = '\u200b';

/** Stops model/PR-controlled text from pinging real users or teams. */
export function neutralizeMentions(text) {
  return text.replace(/(^|[^\w`@])@([A-Za-z0-9])/gm, `$1@${ZWSP}$2`);
}

/**
 * Model output is derived from untrusted PR content, so treat it as hostile:
 * - no images (GitHub's proxy would fetch attacker URLs -> data exfiltration channel)
 * - no HTML comments (could spoof our idempotency marker)
 * - no @mentions
 */
export function sanitizeText(input, max = 1500) {
  let t = String(input ?? '');
  t = t.replace(/<!--/g, '&lt;!--');
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, '[image removed]');
  t = t.replace(/<img\b[^>]*>/gi, '[image removed]');
  t = neutralizeMentions(t);
  if (t.length > max) t = `${t.slice(0, max - 1)}…`;
  return t.trim();
}

/** Single-line fields (titles, paths) */
export function sanitizeInline(input, max = 120) {
  return sanitizeText(input, max).replace(/\s+/g, ' ');
}
