/**
 * pr-body-closes-check.mjs — Deterministic detector for the PR-body bugs that
 * leave an issue OPEN after the PR that fixes it merges. ZERO Claude (pure
 * regex), used by pr-body-contract.yml.
 *
 * Two defects, one question: **will GitHub actually close what the body says it
 * closes?** The body is verified for its EFFECT, not for its shape.
 *
 *   1. MULTI-REF — `Closes #12 #34 #56` closes only #12 (below).
 *   2. INEFFECTIVE KEYWORD — `Chiude #133` closes nothing at all. GitHub honors
 *      only close/closes/closed, fix/fixes/fixed, resolve/resolves/resolved;
 *      everything else is prose, however unambiguous the intent. Real
 *      recurrence: PR #139 on the corpus wrote `Chiude #133`, merged, and #133
 *      stayed in the backlog with its fix already on `main` until someone
 *      closed it by hand. Census over merged PRs since 2026-07-25: 7 (1 corpus,
 *      6 here — #5417, #5372, #5368, #5338, #5300, #5271).
 *
 * Defect 2 was invisible to this module by construction: the detector started
 * FROM the valid keywords, so a line that never uses one was neither a
 * violation nor a `Closes` — it simply did not exist for the check. Same shape
 * as the defect nanako's escalation #140 closes on the other section: a
 * contract verified for its form rather than its effect.
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
 * Returns { ok, violations }. Every violation carries `{ type, line, text,
 * message }`; multi-ref ones also carry `refs`, ineffective-keyword ones carry
 * `ref`, `keyword` and `suggestion` (the line to write instead).
 *
 * `message` is part of the contract: nanako's `scripts/ci/pr-body-contract.mjs`
 * renders `v.message` when present and falls back to its own wording otherwise,
 * so a new violation type reaches the sticky comment correctly the moment this
 * file mirrors down, with no change needed there.
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

// ---------------------------------------------------------------------------
// Defect 2: closure intent expressed with a keyword GitHub does not honor.
// ---------------------------------------------------------------------------

// The ONLY tokens GitHub acts on. Note what is absent: the gerunds. `Closing
// #12` / `Fixing #12` read as closure to a human and do nothing at all.
const EFFECTIVE_KW = '(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)';
const EFFECTIVE_RE = new RegExp(`\\b${EFFECTIVE_KW}\\b[\\s:]*[*_\`[]*(${REF})`, 'gi');

// Tokens that state closure but are NOT GitHub keywords. Italian verbs (the
// measured recurrence) plus the English near-misses that share the failure
// mode. Deliberately NOT here: `addresses`, `see`, `related to`, `part of` —
// those mean "connected to", and flagging them would punish a correct body.
const INTENT_KW =
  '(?:chiud(?:e|ono|er[àa]|iamo)|chius[aoie]|risolv(?:e|ono|iamo)|risolt[aoie]|' +
  'fixa(?:ta|to)?|corregg(?:e|ono)|corrett[aoie]|' +
  'closing|fixing|resolving|solves|solved|completes|completed)';
// A PAST-TENSE report ("già chiusa da #66", "was fixed by #66") states that
// something ELSE already closed the ref — it is not this PR's closure intent,
// and flagging it would punish a body that is telling the truth.
const PAST_REPORT_RE = /\b(?:gi[àa]'?|already|was|were|sono\s+stat[ei]|[èe]'?\s+stat[ao])\s*$/i;
// A NEGATED report ("non chiusi: #849 resta aperta", "not fixed by #66") states
// the ref stays OPEN — the exact opposite of a closure intent. Without this the
// gate answers such a line with "write `Closes #849`", i.e. it asks the author
// to close an issue the same sentence declares still open: the very outcome the
// check exists to prevent, inverted. Bounded to two intervening words and
// stopped by any punctuation (`\w` never matches a comma), so a real intent a
// clause later — "questo non è un problema, chiude #12" — is still reported.
const NEG_REPORT_RE = /\b(?:non|n[éè]|not|never|mai|senza|without)(?:\s+\w+){0,2}\s*$/i;
// Filler tolerated between the verb and the ref: `Chiusa da #12`, `Risolve
// definitivamente #12`, `Closing the #12`. Bounded to a known word list so a
// sentence boundary or real prose can never bridge verb and ref.
const INTENT_FILLER = "(?:\\s+(?:da|by|the|la|il|lo|le|gli|l'|anche|definitivamente|finalmente|completamente|parzialmente))*";
const INTENT_RE = new RegExp(`\\b(${INTENT_KW})\\b${INTENT_FILLER}[\\s:]*[*_\`[]*(${REF})`, 'gi');

/** Every ref a real GitHub keyword governs → the ones that will actually close. */
function effectiveRefs(body) {
  const found = new Set();
  EFFECTIVE_RE.lastIndex = 0;
  for (const m of String(body || '').matchAll(EFFECTIVE_RE)) found.add(m[1].toLowerCase());
  return found;
}

/**
 * Refs a line claims to close with a token GitHub ignores.
 * @returns {Array<{ keyword: string, ref: string }>}
 */
function lineIntentRefs(line) {
  const s = String(line || '');
  INTENT_RE.lastIndex = 0;
  return [...s.matchAll(INTENT_RE)]
    .filter((m) => {
      const before = s.slice(Math.max(0, m.index - 24), m.index);
      return !PAST_REPORT_RE.test(before) && !NEG_REPORT_RE.test(before);
    })
    .map((m) => ({ keyword: m[1], ref: m[2] }));
}

/**
 * Blank out what is QUOTED rather than claimed: fenced blocks, inline code
 * spans and HTML comments. Every character becomes a space and every newline
 * survives, so line numbers and columns still line up with the original.
 *
 * Not cosmetic. A PR body that DOCUMENTS the rule ("don't write `Chiude #133`,
 * write `Closes #133`") and the PR template that warns about it both contain
 * the offending shape verbatim — and the template ships its guidance in HTML
 * comments, which stay in the body of every PR opened from it. Without this the
 * gate fires on the two bodies most likely to be right about it. Same reason
 * `pr-body-sections-check.mjs` strips the same three constructs before judging
 * section content.
 *
 * @param {string} body
 * @returns {string}
 */
export function maskQuoted(body) {
  return String(body || '')
    .replace(/```[\s\S]*?```|~~~[\s\S]*?~~~|<!--[\s\S]*?-->|`[^`\n]*`/g, (m) =>
      m.replace(/[^\n]/g, ' '),
    );
}

export function checkClosesLines(body = '') {
  const lines = maskQuoted(body).split(/\r?\n/);
  const rawLines = String(body || '').split(/\r?\n/);
  const violations = [];
  // Body-level, not line-level: `Chiude #133` two lines below a valid
  // `Closes #133` is redundant prose, not a missed closure. What matters is
  // whether SOME keyword in the body reaches that ref.
  const willClose = effectiveRefs(maskQuoted(body));
  // One report per REF, not per phrasing: PR #5368 said both "chiude #5331"
  // and "chiuso #5331", and the fix is a single line either way.
  const reported = new Set();

  for (let i = 0; i < lines.length; i++) {
    // Scan the masked line, but REPORT the original: the author has to find the
    // line in their own body, and a row of blanks is not a landmark.
    const text = (rawLines[i] ?? lines[i]).trim();
    const refs = lineHasMultiCloseViolation(lines[i]);
    if (refs) {
      violations.push({
        type: 'multi-ref-close',
        line: i + 1,
        text,
        refs,
        message:
          `\`${text}\` chiude **solo #${refs[0]}** — GitHub ignora i riferimenti successivi ` +
          'sulla stessa riga. Usa una keyword per issue, una per riga: ' +
          refs.map((r) => `\`Closes #${r}\``).join(' / ') + '.',
      });
    }
    for (const { keyword, ref } of lineIntentRefs(lines[i])) {
      if (willClose.has(ref.toLowerCase())) continue; // già chiusa da una keyword vera altrove
      if (reported.has(ref.toLowerCase())) continue;
      reported.add(ref.toLowerCase());
      violations.push({
        type: 'ineffective-closing-keyword',
        line: i + 1,
        text,
        ref,
        keyword,
        suggestion: `Closes ${ref}`,
        message:
          `\`${keyword} ${ref}\` **non chiude niente**: GitHub riconosce solo ` +
          '`close/closes/closed`, `fix/fixes/fixed`, `resolve/resolves/resolved`. ' +
          `Tutto il resto è prosa, e ${ref} resterebbe aperta con la fix già su \`main\` ` +
          '(successo reale: PR #139 → issue #133). ' +
          `Scrivi invece: \`Closes ${ref}\``,
      });
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
