/**
 * pr-body-closes-check.mjs — Deterministic detector for the "multi-issue Closes
 * on one line" PR-body bug. ZERO Claude (pure regex), used by pr-body-contract.yml.
 *
 * THE BUG: GitHub honors only the FIRST issue reference after a closing keyword on
 * a line. `Closes #12 #34 #56` closes ONLY #12 — #34/#56 stay open and must be
 * closed by hand (real recurrence: PR #1320 listed 9 issues on one `Closes` line,
 * 8 stayed open). To close N issues each ref needs its OWN keyword:
 *   `Closes #12`        ← one per line (correct)
 *   `Closes #34`
 * or inline `Closes #12, closes #34` (keyword repeated before each).
 *
 * GitHub closing keywords (case-insensitive): close/closes/closed, fix/fixes/fixed,
 * resolve/resolves/resolved. See
 * https://docs.github.com/issues/tracking-your-work-with-issues/linking-a-pull-request-to-an-issue
 *
 * DETECTION (conservative — flag only the unambiguous bug, never a valid body):
 * For each line, find a closing keyword immediately followed by an issue ref
 * (`keyword #N` or `keyword owner/repo#N`) that is itself immediately followed by
 * a SECOND issue ref separated only by list separators (space, comma, colon,
 * semicolon, `&`, or `and`). Those chained extra refs are exactly what GitHub
 * silently ignores. A ref that comes after a sentence boundary or real words
 * (e.g. `Closes #12. See also #99 for context`) is a genuine cross-reference,
 * NOT part of the chain → never flagged (false-positive guard). Bare `#N` not
 * governed by any keyword (e.g. `see #99`) is ignored.
 *
 * Returns { ok, violations } where each violation is { line, text, refs } with
 * `refs` = all issue numbers on the line that the single keyword reaches but
 * GitHub won't close.
 */

// An issue reference: optional `owner/repo` prefix, then `#<digits>`.
const REF = '(?:[\\w.-]+\\/[\\w.-]+)?#\\d+';
// Separators GitHub users put between chained refs (the ones it silently ignores):
// whitespace, comma, colon, semicolon, ampersand, or the word "and".
const SEP = '(?:\\s*(?:,|:|;|&|\\band\\b)?\\s*)';
// A closing keyword that governs the FIRST ref, then ≥1 MORE refs chained by
// separators only (no sentence boundary, no real words between). Each extra ref
// must NOT carry its own closing keyword (that would be the correct form).
const CHAIN = new RegExp(
  `\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\b\\s*(${REF})((?:${SEP}${REF})+)`,
  'gi',
);
const ALL_REFS = new RegExp(REF, 'g');

/**
 * Detect a closing keyword followed by a chain of ≥2 refs (`kw #a #b ...`). Returns
 * the list of issue numbers in the chain, or null if the line is clean.
 */
function lineHasMultiCloseViolation(line) {
  // Guard: if the "extra" segment actually starts a NEW closing keyword for each
  // ref (e.g. `closes #1, closes #2`), the CHAIN regex won't match because a
  // keyword sits between the separator and the ref — SEP forbids word chars.
  CHAIN.lastIndex = 0;
  const m = CHAIN.exec(line);
  if (!m) return null;
  const chunk = m[0];
  const nums = [];
  for (const r of chunk.matchAll(ALL_REFS)) nums.push(r[0].match(/#(\d+)/)[1]);
  return nums.length >= 2 ? nums : null;
}

export function checkClosesLines(body = '') {
  const lines = String(body || '').split(/\r?\n/);
  const violations = [];
  for (let i = 0; i < lines.length; i++) {
    const refs = lineHasMultiCloseViolation(lines[i]);
    if (refs) {
      violations.push({ line: i + 1, text: lines[i].trim(), refs });
    }
  }
  return { ok: violations.length === 0, violations };
}

// CLI mode: read body from arg or stdin, print JSON, exit 1 on violation.
if (process.argv[1] && process.argv[1].endsWith('pr-body-closes-check.mjs')) {
  const arg = process.argv[2];
  const run = (body) => {
    const res = checkClosesLines(body);
    process.stdout.write(JSON.stringify(res));
    if (!res.ok) process.exitCode = 1;
  };
  if (typeof arg === 'string') {
    run(arg);
  } else {
    let buf = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (d) => (buf += d));
    process.stdin.on('end', () => run(buf));
  }
}
