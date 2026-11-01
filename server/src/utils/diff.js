const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

const IGNORE = [
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|Gemfile\.lock|composer\.lock|go\.sum)$/,
  /\.min\.(js|css)$/,
  /\.(png|jpe?g|gif|svg|ico|webp|pdf|zip|gz|woff2?|ttf|eot|mp4|mov)$/i,
  /(^|\/)(dist|build|node_modules|vendor|coverage|\.next)\//,
  /\.snap$/,
  /\.map$/,
];

export function shouldReview(filename) {
  return !IGNORE.some((re) => re.test(filename));
}

/**
 * Parses a unified-diff patch (as returned by GitHub's "list PR files") and tracks
 * new-file line numbers. GitHub only accepts inline comments on lines that appear
 * in the diff's RIGHT side, so we keep that set for validation.
 */
export function parsePatch(patch = '') {
  const rows = String(patch).split('\n');
  if (rows.length && rows[rows.length - 1] === '') rows.pop();

  const rightLines = new Set();
  const addedLines = new Set();
  const lines = [];
  let n = 0;
  let inHunk = false;

  for (const raw of rows) {
    const m = HUNK.exec(raw);
    if (m) {
      n = parseInt(m[1], 10);
      inHunk = true;
      lines.push({ type: 'hunk', text: raw });
      continue;
    }
    if (!inHunk) continue;
    if (raw.startsWith('\\')) continue; // "\ No newline at end of file"
    const c = raw[0];
    if (c === '+') {
      rightLines.add(n);
      addedLines.add(n);
      lines.push({ type: 'add', line: n, text: raw.slice(1) });
      n += 1;
    } else if (c === '-') {
      lines.push({ type: 'del', text: raw.slice(1) });
    } else {
      rightLines.add(n);
      lines.push({ type: 'ctx', line: n, text: raw.slice(1) });
      n += 1;
    }
  }
  return { rightLines, addedLines, lines };
}

/** Renders a parsed patch with explicit new-file line numbers so the model never has to count. */
export function renderNumbered(parsed, maxChars = Infinity) {
  const out = [];
  let size = 0;
  for (const r of parsed.lines) {
    let s;
    if (r.type === 'hunk') s = r.text;
    else if (r.type === 'add') s = `${String(r.line).padStart(5)} + ${r.text}`;
    else if (r.type === 'ctx') s = `${String(r.line).padStart(5)}   ${r.text}`;
    else s = `${' '.repeat(5)} - ${r.text}`;
    size += s.length + 1;
    if (size > maxChars) {
      out.push('... [diff truncated: call get_file_diff or get_file_content for the rest]');
      break;
    }
    out.push(s);
  }
  return out.join('\n');
}
