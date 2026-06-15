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
 * A token qualifies only if it carries CODE PUNCTUATION (paren/brace/quote/backtick,
 * dot-member, `::`, `=>`, comparison/assignment operator, `:digit`). Bare prose words
 * AND bare identifiers — `previousSlugs`, `mergedCount`, `getList`, `markStale` on their
 * own — are REJECTED.
 *
 * Why no bare-identifier allowlist (was `getList|markStale|mergedCount|previousSlugs`):
 * those are exactly the funnel-critical #829 field names cited in REVIEW.md L92. They
 * occur in the cited file INDEPENDENTLY of the prescribed fix (`previousSlugs` lives in
 * every slug/redirect builder; `mergedCount` in any orphan-merge), so promoting a bare
 * occurrence to "distinctive" lets a coincidental field-name hit short-circuit the gate
 * and DROP a still-pending redirect/canonical fix. A token must therefore appear WITH
 * code punctuation in the issue's `Suggested action` (e.g. `markStale()`,
 * `job.previousSlugs`, `mergedCount >= 1`) before it can ever count as evidence. Test
 * matchers (`toContain`/`expect`/…) likewise only qualify inside a call/member shape via
 * the generic punctuation classes below — never as a bare word.
 */
export function isDistinctiveToken(s) {
  if (s.length < 6 || s.length > 80) return false;
  if (/^[\w./-]+$/.test(s) && /\.[a-z]{2,4}$/i.test(s)) return false; // bare file path
  if (/\s/.test(s.trim()) && !/[(){}'"`:=<>]|\.\w/.test(s)) return false; // prose phrase
  // ONLY code punctuation qualifies. A bare identifier (even a familiar field/helper name
  // like `previousSlugs` / `mergedCount` / `getList` / a vitest matcher) is NOT distinctive:
  // it occurs in a cited file independently of any fix (e.g. `previousSlugs` lives in every
  // slug/redirect builder), so allowlisting bare words would let a still-pending
  // funnel-critical fix (redirect/canonical/previousSlugs) be short-circuited and silently
  // dropped — the exact false-positive the gate must never produce (#1647, REVIEW.md L92).
  // Such names still qualify in their real form (`previousSlugs.push(`, `getList()`) via the
  // dot-member/paren branches below.
  return /[(){}'"`]|::|=>|\.\w|:\d|>=|<=/.test(s);
}

/**
 * The single MOST-SPECIFIC token among a candidate set: the one carrying the richest code
 * structure (most punctuation, longest). Exported for inspection/telemetry; the
 * short-circuit bar in detectAlreadyResolved requires ALL distinctive tokens present
 * (a superset of "most-specific present"), which is not sensitive to this ordering.
 */
export function mostSpecificToken(tokens) {
  if (!tokens.length) return null;
  const score = (t) => {
    const punct = (t.match(/[(){}[\]'"`.:;=<>+\-*/!&|?]/g) || []).length;
    return punct * 100 + t.length; // punctuation dominates, length tie-breaks
  };
  return [...tokens].sort((a, b) => score(b) - score(a))[0];
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
 * Explicit cross-reference signal: is this issue declared resolved by a MERGED PR?
 *
 * Orthogonal to the token matcher (which reads file CONTENT). Here the signal is a human/
 * agent DECLARATION: a merged PR whose title/body names this issue on a line that also
 * carries a closing/supersede keyword (`Closes`/`Fixes`/`Resolves`/`Supersedes #N`). This
 * catches two done-but-open classes the verbatim-token matcher structurally cannot:
 *   1. The multi-issue `Closes #a #b #c` gotcha (AGENTS.md): GitHub auto-closes ONLY the
 *      first issue after a closing keyword, so `#b`/`#c` stay OPEN despite being declared
 *      done in the merged PR (PR #1320: 9 issues on one line → 8 left open, manual cleanup).
 *   2. `Supersedes #N` — deliberately non-auto-closing by GitHub, but an explicit "this PR
 *      makes the issue moot" declaration.
 *
 * SAFE / bias-to-PROCEED: this is an EXPLICIT author declaration, not a content heuristic —
 * far stronger than a coincidental token hit, and the caller still only short-circuits to an
 * advisory `maybe-resolved` (never auto-closes; human confirms). A merged PR is required
 * (a closed-unmerged PR's `Closes` is void). The `#N(?!\d)` guard prevents `#2035` matching
 * `#20350`; requiring a keyword on the SAME line avoids bare `Related: #N` mentions.
 *
 * Pure: the caller injects the merged-PR list (the gate fetches it via `gh pr list`).
 *
 * @param {number|string} issueNumber
 * @param {Array<{number?: number, title?: string, body?: string}>} mergedPrs
 * @returns {number|null}  the declaring PR number, or null
 */
export function closingMergedPr(issueNumber, mergedPrs) {
  const n = Number(issueNumber);
  if (!Number.isInteger(n) || n <= 0 || !Array.isArray(mergedPrs)) return null;
  // Match a closing keyword IMMEDIATELY followed by a run of issue refs separated
  // ONLY by separators (whitespace / comma / `&` / "and") — the multi-issue
  // `Closes #a #b #c` (and `Closes #a, #b and #c`) shape. Requiring the ref to be
  // part of that unbroken keyword-anchored list (not merely on the same line)
  // rejects `Fixes #8 and touches #N`: the word "touches" breaks the run, so #N
  // is NOT in the closing list (reviewer adversarial #1/#2 — a same-line match
  // would have false-flagged it and dropped a legit agent:fix). The exact `#${n}`
  // string compare also makes the `#2035` vs `#20350` guard fall out for free.
  const kwList = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|supersede[sd]?)\b\s*:?\s*((?:#\d+(?:[\s,&]+(?:and\s+)?)?)+)/ig;
  for (const pr of mergedPrs) {
    const text = `${pr?.title || ''}\n${pr?.body || ''}`;
    for (const m of text.matchAll(kwList)) {
      const refs = (m[1] || '').match(/#\d+/g) || [];
      if (refs.includes(`#${n}`)) return pr?.number ?? null;
    }
  }
  return null;
}

/**
 * Core resolution check: does the cited file's CURRENT content already contain the
 * prescribed fix? Pure — the caller injects file access.
 *
 * SHORT-CIRCUIT BAR (deliberately high — a false short-circuit drops a REAL bug, far
 * worse than a wasted run):
 *   1. There is at least one distinctive cited token (code-punctuation-carrying — a bare
 *      field name like `previousSlugs` no longer qualifies); AND
 *   2. EVERY distinctive token from the prescribed `Suggested action` is present verbatim
 *      in a cited file. Requiring ALL of them — not merely *some* token, and not just the
 *      heuristic "most-specific" one — means a single coincidental field-name hit can
 *      never alone flip `resolved` to true; the whole prescribed shape must be on main.
 *      (This is a strict superset of "most-specific token present", and unlike that test
 *      it is not sensitive to any token-scoring heuristic.)
 * Anything weaker/partial/ambiguous → `resolved=false` → the caller PROCEEDS (runs the
 * fixer). The worst outcome — dropping a still-pending fix — is structurally excluded.
 *
 * TOTAL / DEFENSIVE: any malformed body or resolver fault is swallowed and reported as
 * `resolved=false` (proceed), so a throw can NEVER strand an issue (the issue-fix
 * pre-flight has no continue-on-error; a throw there would skip the `agent:fix` removal
 * AND the fixer → labeled-but-undispatched). Never throws.
 *
 * @param {string} body                              issue body markdown
 * @param {object} io
 * @param {(path: string) => boolean} io.fileExists  true if the path resolves
 * @param {(path: string) => (string|null)} io.readFile  current file content, or null
 * @returns {{ resolved: boolean, evidence: Array<{file:string, tok:string}>,
 *             files: string[], tokens: string[] }}
 */
export function detectAlreadyResolved(body, io) {
  const empty = { resolved: false, evidence: [], files: [], tokens: [] };
  try {
    const fileExists = io && typeof io.fileExists === 'function' ? io.fileExists : () => false;
    const readFile = io && typeof io.readFile === 'function' ? io.readFile : () => null;
    const files = citedFiles(body || '', fileExists);
    const tokens = citedTokens(body || '');
    const evidence = [];
    if (files.length && tokens.length) {
      const cache = new Map();
      for (const file of files) {
        if (!cache.has(file)) cache.set(file, readFile(file));
        const content = cache.get(file);
        if (typeof content !== 'string') continue;
        for (const tok of tokens) {
          if (content.includes(tok)) evidence.push({ file, tok });
        }
      }
    }
    // Bar: EVERY distinctive prescribed token must be matched (high bar — a coincidental
    // single field-name hit can never short-circuit and drop a real fix).
    const matched = new Set(evidence.map((e) => e.tok));
    const resolved = tokens.length > 0 && tokens.every((t) => matched.has(t));
    return { resolved, evidence, files, tokens };
  } catch {
    // Malformed body / faulty resolver → proceed-safe. Never strand the issue.
    return empty;
  }
}
