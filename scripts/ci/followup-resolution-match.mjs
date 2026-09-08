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
  for (const m of body.matchAll(/(?:^|\n)\s*(?:[-*]\s*)?Target file:\s*([\w./-]+\.[a-z]{2,5})(?::L?\d+)?\s*$/gim)) {
    const p = m[1];
    if (p.includes('/') && fileExists(p)) out.add(p);
  }
  return [...out];
}

const ITEM_HEADING_START = /^#{2,3}\s/i;
// `Funnel impact` is no longer emitted by the schema, but it remains a boundary
// for backwards compatibility with already-minted issues. Removing it would
// absorb the legacy line into `Suggested action` and recreate the too-wide-region
// false positive fixed by #7902.
const ITEM_FIELD_START = /^-\s+(?:Source|Original text|Stato dichiarato nella PR|Funnel impact|Rationale|Suggested action|METRICA|OSSERVATORE)\s*:/i;
const POST_ORIGINAL_FIELD_START = /^-\s+(?:Funnel impact|Rationale|Suggested action|METRICA|OSSERVATORE)\s*:/i;
const DECORATED_SHEET_START = /^\s*\*{0,2}\d+\s*-\s*(?:METRICA|OSSERVATORE)(?:\s*[.:]\s*\*{0,2}|\s*\*{0,2}\s*[.:])/i;
const METRIC_SHEET_START = /^(?:-\s+METRICA\s*:|\s*\*{0,2}\d+\s*-\s*METRICA(?:\s*[.:]\s*\*{0,2}|\s*\*{0,2}\s*[.:]))/i;

function isOriginalTextBoundary(line) {
  return ITEM_HEADING_START.test(line) || POST_ORIGINAL_FIELD_START.test(line) || DECORATED_SHEET_START.test(line);
}

function isSuggestedActionSectionBreak(line) {
  return ITEM_HEADING_START.test(line) || ITEM_FIELD_START.test(line) || DECORATED_SHEET_START.test(line);
}

/**
 * Keep only the part of an item that can describe the current acceptance condition.
 * `Original text` is quoted status quo, so it must be excluded for every acceptance
 * predicate, including the sheet branch that does not require `Suggested action`.
 */
function acceptanceScopeText(body) {
  const lines = String(body || '').split('\n');
  const scoped = [];
  let inOriginalText = false;

  for (const line of lines) {
    if (/^-\s+Original text\s*:/i.test(line)) {
      inOriginalText = true;
      continue;
    }
    if (inOriginalText && isOriginalTextBoundary(line)) inOriginalText = false;
    if (!inOriginalText) scoped.push(line);
  }
  return scoped.join('\n');
}

/**
 * Scope token extraction to the `Suggested action` region(s) when present — that text
 * describes the PRESCRIBED fix, so a token from it appearing in the file is real signal
 * of "done". Falls back to the item text outside `Original text` for free-form issues.
 * Avoids the trap where an issue QUOTES the status-quo code it wants changed — that token
 * is in the file because the work is NOT done, the opposite of what we want to flag.
 */
export function suggestedActionText(body) {
  const scoped = acceptanceScopeText(body);
  const lines = scoped.split('\n');
  const regions = [];
  for (let i = 0; i < lines.length; i++) {
    if (/suggested action/i.test(lines[i])) {
      const buf = [lines[i]];
      for (let j = i + 1; j < lines.length; j++) {
        if (isSuggestedActionSectionBreak(lines[j])) break;
        buf.push(lines[j]);
      }
      regions.push(buf.join('\n'));
    }
  }
  return regions.length ? regions.join('\n') : scoped;
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
 * Un item di follow-up è TRACCIABILE solo se porta una condizione di
 * accettazione FALSIFICABILE: qualcosa che, girando, può provare che è stato
 * affrontato. Decisione del proprietario del 2026-09-05.
 *
 * L'oracolo non è nuovo ed è deliberatamente lo stesso che chiude l'item:
 * `citedTokens()`. Un item che non cita nemmeno un token-codice distintivo non
 * offre appiglio a nessun check — né oggi né mai — quindi non è lavoro
 * verificabile ma un rischio ipotetico in prosa. Usare due oracoli diversi per
 * «si può aprire» e «si può chiudere» produrrebbe esattamente la classe di
 * item che entra in coda e non ne esce più.
 *
 * Misurato il 2026-09-05 sul sito: 36 dei 49 item (73%) delle aggregate
 * bloccate non citano alcun token, e sulle ultime 60 follow-up sono 81 item su
 * 129 (63%). Sono in massima parte rischi sollevati dal reviewer in
 * `## Adversarial check` con `Stato dichiarato nella PR: nessuno`.
 *
 * NON è un criterio di chiusura: un item non falsificabile non viene chiuso
 * «lo stesso», viene RICLASSIFICATO come mai-stato-un-item — resta leggibile
 * nel corpo della issue e nel commento della PR, ma non fa da gate.
 */
export const ACCEPTANCE_CONDITION = Object.freeze({
  id: 'cited-code-token',
  describe: 'almeno un token-codice distintivo citato in `Suggested action`',
  /**
   * La regione `Suggested action` va richiesta ESPLICITAMENTE, non dedotta dai
   * token. `suggestedActionText()` usa lo stesso `acceptanceScopeText()` degli
   * altri predicati, quindi il suo fallback non legge mai `Original text`; il
   * requisito esplicito resta comunque necessario perché un item senza azione
   * prescritta non è falsificabile per definizione.
   *
   * Un item senza `Suggested action` può quindi passare solo per la condizione
   * alternativa della scheda. I suoi eventuali token non entrano nel detector
   * di chiusura: quello consuma token prescritti soltanto dalla regione
   * `Suggested action`.
   *
   * @param {string} itemText @returns {boolean}
   */
  holds: (itemText) => {
    const s = String(itemText || '');
    if (!/suggested action/i.test(s)) return false;
    return citedTokens(s).length > 0;
  },
});

/**
 * Il `COMANDO` di una scheda, oppure `null`. Copre le DUE forme già in uso, che
 * differiscono solo per decorazione: la riga del template di `issue-decompose.yml`
 * (`- METRICA: prima=<n> atteso=<n> | COMANDO: <comando>`) e quella emessa da
 * `scripts/audit-canton-url-drift.mjs` (`**3-METRICA.** … | **COMANDO**: \`<comando>\``).
 * Il marker `COMANDO` è l'ancora esplicita e viene cercato solo su una riga
 * `METRICA`: non si deduce da una riga che «sembra» un comando né da prosa che
 * contiene la stringa `COMANDO:`, per la stessa ragione per cui
 * `ACCEPTANCE_CONDITION` pretende la regione `Suggested action` invece di dedurla
 * dai token. Puro.
 *
 * @param {string} itemText @returns {string|null}
 */
export function schedaCommand(itemText) {
  for (const line of acceptanceScopeText(itemText).split('\n')) {
    if (!METRIC_SHEET_START.test(line)) continue;
    const m = line.match(/\*{0,2}COMANDO\*{0,2}\s*:\s*(.+)$/);
    if (!m) continue;
    const cmd = m[1].trim().replace(/^`+|`+$/g, '').trim();
    if (cmd) return cmd;
  }
  return null;
}

/**
 * Il referente nominato da un comando: il primo path di repository che il comando
 * cita (con almeno una `/` e un'estensione). È la metà VERIFICABILE della scheda —
 * un nome si scrive, un referente si risolve.
 *
 * Il vincolo della `/` è lo stesso di `citedFiles()`, e per la stessa ragione: un
 * `package.json` nudo non individua un file in questo repo. Un comando che non
 * nomina nessun referente (`npm test`, `gh run list --branch main`) NON è
 * risolvibile: non dice su cosa si legge il verdetto. Puro.
 *
 * @param {string} command @returns {string|null}
 */
export function commandReferent(command) {
  const m = String(command || '').match(
    /(?:^|[\s`'":=(])([\w.-]+(?:\/[\w.-]+)+\.[a-z]{2,5})(?=$|[\s`'":,)])/i,
  );
  return m ? m[1] : null;
}

/**
 * La scheda dichiara una metrica GIA' al bersaglio (`prima=N atteso=N`)?
 *
 * È il terzo stato della D2: referente esistente e già verde → l'item non muove
 * niente, è irrobustimento travestito da lavoro. Si legge dal TESTO, solo dalla
 * riga `METRICA` della scheda, non eseguendo il comando: questo modulo non
 * esegue nulla.
 *
 * Solo numeri NUDI. `atteso=<6.17%` dichiara una soglia sotto cui scendere, non un
 * bersaglio raggiunto: leggerlo come «già verde» scarterebbe lavoro vero, e in
 * questo gate scartare a torto costa più che ammettere a torto (l'item demoto esce
 * dal tracciamento, l'item ammesso resta comunque da chiudere con una PR). Puro.
 *
 * @param {string} itemText @returns {boolean}
 */
export function metricAlreadyGreen(itemText) {
  const metricLine = acceptanceScopeText(itemText).split('\n').find((line) => METRIC_SHEET_START.test(line));
  const m = metricLine?.match(/prima\s*=\s*([^\s|]+)\s+atteso\s*=\s*([^\s|]+)/i);
  if (!m) return false;
  if (/[<>≤≥]/.test(m[1]) || /[<>≤≥]/.test(m[2])) return false;
  const a = Number.parseFloat(m[1].replace(/%$/, ''));
  const b = Number.parseFloat(m[2].replace(/%$/, ''));
  return Number.isFinite(a) && Number.isFinite(b) && a === b;
}

/**
 * Seconda condizione di accettazione: la scheda con un `COMANDO` risolvibile.
 *
 * Perché SOSTITUISCE e non si somma (decisione del proprietario, D3 del 2026-09-07):
 * un `COMANDO` che nomina un referente prova più di un token backtickato — il token
 * è un proxy dell'azionabilità, il comando *è* l'azionabilità. Sommarli in
 * congiunzione farebbe pagare due volte la stessa prova e alzerebbe un tasso di
 * demozione già al 55%.
 *
 * NON è un allentamento di `isDistinctiveToken()`. Quel tentativo è stato misurato e
 * ritirato il 2026-09-06 — ammetteva +93 item di cui 32 su 45 portavano un token GIA'
 * presente nel file citato, cioè `detectAlreadyResolved()` avrebbe letto «fatto» su
 * lavoro pendente (classe #1647). Qui la soglia del token resta intatta: questo ramo
 * apre una strada DIVERSA, e non può produrre quella classe di falso positivo perché
 * non alimenta `citedTokens()` — un item ammesso di qui non ha alcun token prescritto
 * da confermare, quindi `detectAlreadyResolved()` resta `false` e l'aggregata NON si
 * auto-chiude su di lui. È la D2 letta al contrario, ed è l'effetto voluto: un item
 * che si chiude solo quando un referente esiste, per chiudersi ha bisogno di una PR.
 *
 * Per la stessa ragione qui non serve il guardrail che `ACCEPTANCE_CONDITION` mette
 * sulla regione `Suggested action`: la trappola che quel guardrail chiude è
 * l'AUTO-CHIUSURA su token dello status quo, e un item ammesso da questo ramo non è
 * auto-chiudibile per costruzione.
 *
 * Quello che questo ramo NON fa, deliberatamente: eseguire il comando. Il gate
 * verifica che il `COMANDO` ci sia e nomini un referente, mai che oggi fallisca —
 * eseguire una stringa derivata dal body di una PR dentro un job con `GH_TOKEN` in
 * scrittura è una decisione separata (D8), non una conseguenza di questa.
 */
export const COMMAND_CONDITION = Object.freeze({
  id: 'scheda-comando',
  describe: 'un `COMANDO` di scheda che nomina un referente (file/script/test)',
  /** @param {string} itemText @returns {boolean} */
  holds: (itemText) => {
    const s = String(itemText || '');
    const cmd = schedaCommand(s);
    if (!cmd || !commandReferent(cmd)) return false;
    return !metricAlreadyGreen(s);
  },
});

/**
 * True se l'item porta una condizione di accettazione falsificabile.
 *
 * DISGIUNZIONE, non congiunzione (D3). Le due condizioni sono strade alternative
 * verso la stessa prova, e questa funzione è l'UNICO punto in cui vivono: la usano
 * sia il gate in APERTURA (`scripts/ci/gate-minted-followups.mjs`) sia il predicato
 * in CHIUSURA (`aggregateCloseGate()` in `scripts/ci/reconcile-followups.mjs`).
 * Allargarla qui le allarga insieme, nello stesso commit e per costruzione — che è
 * esattamente il vincolo di #7587: un criterio più permissivo in apertura che in
 * chiusura è ciò che ha prodotto la coda immortale.
 */
export function hasFalsifiableAcceptance(itemText) {
  const s = String(itemText || '');
  return ACCEPTANCE_CONDITION.holds(s) || COMMAND_CONDITION.holds(s);
}

/**
 * Spezza il corpo di una follow-up nei suoi item (`### 1.`, `### 2.`, …).
 * Ritorna `[]` se il corpo non ha la struttura a item — che per i chiamanti
 * significa «non riclassificare», mai «zero item validi».
 */
export function splitFollowupItems(body) {
  return String(body || '').split(/^### \d+\./m).slice(1);
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
// Match a closing keyword IMMEDIATELY followed by a run of issue refs separated
// ONLY by separators (whitespace / comma / `&` / "and") — the multi-issue
// `Closes #a #b #c` (and `Closes #a, #b and #c`) shape. Requiring the ref to be
// part of that unbroken keyword-anchored list (not merely on the same line)
// rejects `Fixes #8 and touches #N`: the word "touches" breaks the run, so #N
// is NOT in the closing list (reviewer adversarial #1/#2 — a same-line match
// would have false-flagged it and dropped a legit agent:fix). Single source of
// truth: `closedIssueRefs` (the grandchild-suppression gate) and `closingMergedPr`
// (the already-resolved gate) MUST agree byte-for-byte on what a "closing ref" is
// (AGENTS.md #6 — a regex duplicated literally in ≥2 files → ONE shared module).
//
// Italian closure declarations (issue #567): this repo's own PR bodies state
// closure in Italian prose ("Chiude anche la issue #402", PR #418) — a form
// GitHub itself never honors (see scripts/lib/pr-body-closes-check.mjs, which
// flags exactly that as an ineffective keyword and tells the author to write
// `Closes #N` instead), but which IS a real, unambiguous author declaration
// this gate must read. `chiud[eo]`/`risolv[eo]`/`super[ae]` cover the
// present-tense forms observed in the corpus (chiude/chiudo, risolve/risolvo,
// supera); `IT_BRIDGE` absorbs the optional filler words ("anche", "la"/"le",
// "issue") Italian prose puts between the verb and the `#N`, bounded to that
// fixed word list so a real sentence boundary still breaks the run exactly
// like the English case above.
const IT_BRIDGE = '(?:anche\\s+)?(?:l[ae]\\s+)?(?:issue\\s+)?';
const CLOSE_KW_LIST = new RegExp(
  `\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|supersede[sd]?|chiud[eo]|risolv[eo]|super[ae])\\b\\s*:?\\s*${IT_BRIDGE}((?:#\\d+(?:[\\s,&]+(?:and\\s+)?)?)+)`,
  'ig',
);

/**
 * Every issue number declared closed/superseded by a closing-keyword list in `text`
 * (PR title+body). Returns a deduped array of positive integers (the `#` numbers in
 * each keyword-anchored run). Empty array on non-string / no match.
 *
 * Backs `closingMergedPr` (the already-resolved gate's explicit cross-ref signal).
 * NB: deliberately NOT used by the post-merge-followup grandchild-suppression gate —
 * that gate anchors on the fixer BRANCH (`fix/issue-<N>`), not the body, because any
 * "closes #N" in prose (even describing another PR) false-positives here and would skip
 * a real organic PR's triage (regression seen on PR #2214). Pure — no I/O.
 *
 * @param {string} text  PR title + body (or any prose)
 * @returns {number[]}   deduped closed-issue numbers, in first-seen order
 */
export function closedIssueRefs(text) {
  if (typeof text !== 'string' || !text) return [];
  const out = [];
  const seen = new Set();
  for (const m of text.matchAll(CLOSE_KW_LIST)) {
    for (const ref of (m[1] || '').match(/#\d+/g) || []) {
      const n = Number(ref.slice(1));
      if (Number.isInteger(n) && n > 0 && !seen.has(n)) { seen.add(n); out.push(n); }
    }
  }
  return out;
}

export function closingMergedPr(issueNumber, mergedPrs) {
  const n = Number(issueNumber);
  if (!Number.isInteger(n) || n <= 0 || !Array.isArray(mergedPrs)) return null;
  // The exact `#${n}` string compare also makes the `#2035` vs `#20350` guard fall
  // out for free (closedIssueRefs returns parsed integers, compared exactly).
  for (const pr of mergedPrs) {
    const refs = closedIssueRefs(`${pr?.title || ''}\n${pr?.body || ''}`);
    if (refs.includes(n)) return pr?.number ?? null;
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
    const bodyText = typeof body === 'string' ? body : '';
    const files = citedFiles(bodyText, fileExists);
    // A sheet-only item is accepted through `COMMAND_CONDITION`, not through a
    // prescribed token. Keep it out of the token-resolution path entirely, while
    // preserving the free-form issue fallback for bodies with no sheet at all.
    const sheetOnly = COMMAND_CONDITION.holds(bodyText) && !ACCEPTANCE_CONDITION.holds(bodyText);
    const tokens = sheetOnly ? [] : citedTokens(bodyText);
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
