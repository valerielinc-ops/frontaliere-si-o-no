/**
 * followup-resolution-match.mjs — shared, pure matcher for "done-but-open" follow-ups.
 *
 * Single source of truth for the deterministic "is this follow-up already resolved?"
 * heuristic, used by BOTH:
 *   - scripts/ci/reconcile-followups.mjs (scheduled advisory pass — flags w/ comment)
 *   - scripts/ci/check-issue-already-resolved.mjs (issue-fix.yml pre-flight gate —
 *     short-circuits the Claude fixer BEFORE it spends Max OAuth quota on a no-op)
 *
 * Extracting it here (AGENTS.md non-negotiable #6: a regex/heuristic duplicated
 * literally in ≥2 files → ONE shared module) makes the two callers drift-proof
 * by construction: the gate and the reconciler can never diverge on what counts as
 * "distinctive token" / "cited file" / "suggested-action region".
 *
 * SIGNAL (intentionally conservative — a false short-circuit drops a real bug, far
 * worse than a wasted run): a follow-up is "likely resolved" when a DISTINCTIVE code
 * token quoted in its `Suggested action` region appears verbatim in the cited file's
 * CURRENT content. Tokens are scoped to `Suggested action` (the PRESCRIBED fix), never
 * `Original text` (the status-quo the issue wants CHANGED — that token is in the file
 * precisely because the work is NOT done). Bare prose words and plain identifiers are
 * rejected; only tokens carrying code punctuation qualify. Pure functions, no I/O —
 * the caller supplies a `readFile(path) -> string|null` resolver (disk, or
 * `git show origin/main:<path>`), so the same logic works on a worktree or a ref.
 */

/**
 * A token qualifies only if it carries code punctuation (paren/quote/colon/dot-member/
 * operator) — bare prose words and plain identifiers are rejected to keep precision
 * high (we'd rather miss a resolved issue than wrongly flag a live one). Bare file
 * paths are handled separately by fileResolver/citedFiles.
 */
export function isDistinctiveToken(s) {
  if (s.length < 6 || s.length > 80) return false;
  if (/^[\w./-]+$/.test(s) && /\.[a-z]{2,4}$/i.test(s)) return false; // bare file path
  if (/\s/.test(s.trim()) && !/[(){}'"`:=<>]|\.\w/.test(s)) return false; // prose phrase
  return /[(){}'"`]|::|=>|\.\w|:\d|>=|<=|\b(toContain|toBe|toEqual|expect|describe|getList|markStale|mergedCount|previousSlugs)\b/.test(s);
}

/**
 * Backticked file paths in the body that exist according to `fileExists(path)`.
 * Strips a trailing `:Lnnn` / `:nnn` line suffix. Only paths containing `/` are
 * considered (avoids bare `package.json`-style ambiguity flagging wrong files).
 *
 * @param {string} body
 * @param {(path: string) => boolean} fileExists
 * @returns {string[]}
 */
export function citedFiles(body, fileExists) {
  const out = new Set();
  for (const m of body.matchAll(/`([\w./-]+\.[a-z]{2,5})(?::L?\d+)?`/gi)) {
    const p = m[1];
    if (p.includes('/') && fileExists(p)) out.add(p);
  }
  return [...out];
}

/**
 * Scope token extraction to the `Suggested action` region(s) when present — that text
 * describes the PRESCRIBED fix, so a token from it appearing in the file is real signal
 * of "done". Falls back to the whole body for free-form issues. Avoids the trap where an
 * issue QUOTES the status-quo code it wants changed (`Original text`) — that token is in
 * the file because the work is NOT done, the opposite of what we want to flag.
 */
export function suggestedActionText(body) {
  const lines = body.split('\n');
  const regions = [];
  for (let i = 0; i < lines.length; i++) {
    if (/suggested action/i.test(lines[i])) {
      const buf = [lines[i]];
      for (let j = i + 1; j < lines.length; j++) {
        if (/^(#{2,3}\s|- Source:|- Original text:|- Funnel impact:)/.test(lines[j])) break;
        buf.push(lines[j]);
      }
      regions.push(buf.join('\n'));
    }
  }
  return regions.length ? regions.join('\n') : body;
}

/** Backticked spans inside the suggested-action region → distinctive tokens (capped, deduped). */
export function citedTokens(body) {
  const out = new Set();
  for (const m of suggestedActionText(body).matchAll(/`([^`]{3,90})`/g)) {
    const t = m[1].trim();
    if (isDistinctiveToken(t)) out.add(t);
  }
  return [...out].slice(0, 8);
}

/**
 * Core resolution check: does any distinctive cited token already appear verbatim in
 * its cited file's current content? Pure — the caller injects file access.
 *
 * @param {string} body                              issue body markdown
 * @param {object} io
 * @param {(path: string) => boolean} io.fileExists  true if the path resolves
 * @param {(path: string) => (string|null)} io.readFile  current file content, or null
 * @returns {{ resolved: boolean, evidence: Array<{file:string, tok:string}>,
 *             files: string[], tokens: string[] }}
 */
export function detectAlreadyResolved(body, { fileExists, readFile }) {
  const files = citedFiles(body || '', fileExists);
  const tokens = citedTokens(body || '');
  const evidence = [];
  if (files.length && tokens.length) {
    const cache = new Map();
    for (const file of files) {
      if (!cache.has(file)) cache.set(file, readFile(file));
      const content = cache.get(file);
      if (content == null) continue;
      for (const tok of tokens) {
        if (content.includes(tok)) evidence.push({ file, tok });
      }
    }
  }
  return { resolved: evidence.length > 0, evidence, files, tokens };
}
