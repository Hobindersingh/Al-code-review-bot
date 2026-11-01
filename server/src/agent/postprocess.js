import { SEVERITY_RANK } from './schema.js';
import { sanitizeInline, sanitizeText } from '../utils/sanitize.js';

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Never trust model output: validate every finding against the real diff, drop low-signal
 * ones, de-duplicate, rank, and split into inline comments (valid diff line) vs summary-only.
 */
export function finalizeFindings(findings, filesByPath, { minConfidence, minSeverity, maxInline }) {
  const dropped = { unknownFile: 0, lowConfidence: 0, lowSeverity: 0, duplicate: 0 };
  const candidates = [];

  for (const raw of findings) {
    const file = filesByPath.get(raw.path);
    if (!file) { dropped.unknownFile += 1; continue; }
    if (raw.confidence < minConfidence) { dropped.lowConfidence += 1; continue; }
    if (SEVERITY_RANK[raw.severity] < SEVERITY_RANK[minSeverity]) { dropped.lowSeverity += 1; continue; }

    const canSuggest =
      raw.suggestion && !raw.suggestion.includes('```') && !raw.suggestion.includes('\n') && file.parsed.addedLines.has(raw.line);
    candidates.push({
      path: raw.path,
      line: raw.line,
      severity: raw.severity,
      category: raw.category,
      confidence: Math.round(raw.confidence * 100) / 100,
      title: sanitizeInline(raw.title),
      body: sanitizeText(raw.body, 1200),
      ...(canSuggest ? { suggestion: raw.suggestion } : {}),
    });
  }

  candidates.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || b.confidence - a.confidence);

  const seenLoc = new Set();
  const seenTitle = new Set();
  const inline = [];
  const general = [];
  for (const f of candidates) {
    const locKey = `${f.path}:${f.line}:${f.category}`;
    const titleKey = `${f.path}:${norm(f.title)}`;
    if (seenLoc.has(locKey) || seenTitle.has(titleKey)) { dropped.duplicate += 1; continue; }
    seenLoc.add(locKey);
    seenTitle.add(titleKey);

    const placeable = filesByPath.get(f.path).parsed.rightLines.has(f.line);
    if (placeable && inline.length < maxInline) inline.push({ ...f, placement: 'inline' });
    else {
      const { suggestion, ...rest } = f; // suggestions only make sense on inline comments
      general.push({ ...rest, placement: 'summary' });
    }
  }
  return { inline, general, dropped };
}
