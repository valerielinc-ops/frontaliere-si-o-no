/**
 * pr-body-sections-check.mjs — Deterministic validator for PR body SECTION
 * CONTENT quality. ZERO Claude (pure regex+string). Companion to
 * pr-body-closes-check.mjs.
 *
 * Problem (escalation #3250, bucket `reviewer-finding/pr-body-contract` 6×/14d):
 * pr-body-contract.yml checks only that the two required headers are PRESENT,
 * not that they contain substantive content. The PR template leaves bare `- `
 * placeholder bullets in both sections; a fixer that submits without filling them
 * passes the CI gate but triggers a 🔴 reviewer finding — wasting a review cycle.
 *
 * This module closes the gap: it validates content quality so fixers can catch the
 * error locally BEFORE `gh pr create`. The exported functions are unit-tested and
 * mirror the modulo-condiviso pattern of pr-body-closes-check.mjs — they can be
 * inlined into a future pr-body-contract.yml step once that workflow can be updated
 * (requires PAT with `workflows` scope, separate PR).
 *
 * CHECKS:
 * 1. `## Implementato` present with the exact canonical header name.
 *    (catches `## Summary`, `## Fix`, `## Verify`, etc.)
 * 2. `## Non implementato (ancora)` present WITH "(ancora)".
 *    (pr-body-contract.yml regex matches without "(ancora)", but the reviewer
 *    expects the canonical name and the template enforces it.)
 * 3. `## Implementato` section has ≥1 substantive bullet (not just bare `- `
 *    from the template placeholder) OR non-empty prose.
 * 4. `## Non implementato (ancora)` section has valid content: either the word
 *    "Nessuno" (task complete, per AGENTS.md #8) OR ≥1 substantive bullet.
 * 5. A residual bullet that says `PR concatenata`/`PR concatenato` without
 *    `#N` is a blocking violation (`chained-pr-no-number`, #6300 / #6289).
 *    Other bullets without a literal state stay advisory (`bullet-without-state`).
 * 6. New PR writes can opt into a strict decision-deferral check: `per scelta`,
 *    `by construction` and the owner-decision state require concrete `Motivo:`
 *    and `Prossimo passo:` fields.
 * 7. The same strict mode (`strictClaims`, default = `strictDecisionDeferrals`)
 *    blocks a performance claim in `## Implementato` with no evidence in the
 *    body (`unvalidated-perf-claim`, #11675) and warns on an unmeasured bounded
 *    I/O claim (`unvalidated-io-bound-claim`). See `unvalidatedPerfClaims`.
 *
 * Usage:
 *   node scripts/lib/pr-body-sections-check.mjs "$BODY"   # exit 1 on violation
 *   echo "$BODY" | node scripts/lib/pr-body-sections-check.mjs
 *   node scripts/lib/pr-body-sections-check.mjs --json "$BODY"
 *
 * Returns: { ok: boolean, violations: Violation[] }
 * Each Violation: { type: string, section?: string, message: string }
 */

import { NEGATION_LOOKBEHIND } from '../ci/lib/false-positive-declaration.mjs';

// ---------------------------------------------------------------------------
// Pure helpers (exported — imported by unit tests and future CI callers)
// ---------------------------------------------------------------------------

/**
 * Extract the section body between `headerRe` and the next markdown heading (or EoF).
 * The header match itself is NOT included.  Returns null if the header is absent.
 *
 * @param {string} body full PR body text
 * @param {RegExp} headerRe must be non-global; the first match is used
 * @returns {string|null}
 */
export function extractSection(body, headerRe) {
  const m = headerRe.exec(body);
  if (!m) return null;
  const rest = body.slice(m.index + m[0].length);
  const nextHeading = /\n(?=#{1,6}[ \t])/.exec(rest);
  return nextHeading ? rest.slice(0, nextHeading.index) : rest;
}

/**
 * Strip HTML comments and fenced code blocks so we don't treat template
 * comments or example snippets as real content.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripNonContent(text) {
  return String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
}

/**
 * True iff `line` is a markdown bullet that has text beyond the marker.
 * A bare `- ` (or `* ` / `+ `) with nothing after counts as an EMPTY placeholder.
 *
 * @param {string} line
 * @returns {boolean}
 */
export function isSubstantiveBullet(line) {
  const stripped = line.replace(/^[ \t]*[-*+][ \t]*/, '').trim();
  return stripped.length > 0;
}

/**
 * True iff the section text (with non-content stripped) contains at least one
 * substantive bullet OR non-empty non-heading prose.
 *
 * @param {string} rawContent section text (after the header, before the next heading)
 * @returns {boolean}
 */
export function hasMeaningfulContent(rawContent) {
  const clean = stripNonContent(rawContent ?? '');
  return clean.split('\n').some((line) => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    if (/^#{1,6}[ \t]/.test(trimmed)) return false; // heading line (shouldn't appear mid-section)
    // Match a bullet marker followed by space/tab OR at end of line (bare `-`)
    if (/^[-*+](?:[ \t]|$)/.test(trimmed)) return isSubstantiveBullet(trimmed);
    return true; // non-bullet, non-heading, non-empty prose → meaningful
  });
}

/**
 * True iff the section contains ONLY bare placeholder bullets and/or whitespace/comments.
 * Useful for a more precise error message.
 *
 * @param {string} rawContent
 * @returns {boolean}
 */
export function hasOnlyBareBullets(rawContent) {
  const clean = stripNonContent(rawContent ?? '');
  const lines = clean.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) return false; // empty, not "only bare bullets"
  return lines.every((line) => {
    const trimmed = line.trim();
    if (/^#{1,6}[ \t]/.test(trimmed)) return true; // skip any stray headings
    if (/^[-*+][ \t]?$/.test(trimmed)) return true; // bare bullet marker with no text
    if (/^[-*+][ \t]/.test(trimmed)) return false; // bullet WITH text
    return true; // pure whitespace / other structural char → not "content"
  });
}

/**
 * True iff `rawContent` (after stripping HTML comments and code blocks) contains
 * the canonical "Nessuno" marker accepted by AGENTS.md #8 as "task complete, no
 * deferred scope".  Case-insensitive; accepts "Nessuno" / "Nessuna" / "Nessuno."
 *
 * @param {string} rawContent
 * @returns {boolean}
 */
export function hasNessuno(rawContent) {
  const clean = stripNonContent(rawContent ?? '');
  return /\bnessun[oa]?\b/i.test(clean);
}

// ---------------------------------------------------------------------------
// Stato letterale dei bullet di `## Non implementato (ancora)`
// ---------------------------------------------------------------------------

/**
 * Il vocabolario degli stati, in UN SOLO posto.
 *
 * AGENTS.md #8 e REVIEW.md pretendono che ogni voce residua dichiari stato e
 * next-step, ma finora la pretesa viveva solo in prosa: `hasMeaningfulContent`
 * qui sopra verifica che il bullet non sia il placeholder `- ` vuoto, e la
 * regex di `pr-body-contract.yml` verifica la presenza dell'header. Nessuno dei
 * due guarda cosa c'è scritto. Misurato su 13 coppie issue←PR: 7 PR non
 * dichiaravano lo stato su nessun bullet, e in 0 casi lo stato era presente
 * nella PR e perso a valle — il difetto è nel gate, non nel raccoglitore.
 *
 * Le classi sono sei e si dividono in due gruppi per chi legge a valle
 * (`scripts/ci/followup-has-candidates.mjs` importa da qui proprio per non
 * riscrivere la tassonomia e non lasciarla divergere):
 *
 *   lavoro ancora DOVUTO      → `in questa PR`, `PR concatenata #N`,
 *                               `blocked: <causa tecnica>`
 *   voce CHIUSA per decisione → `per scelta`, `by construction`,
 *                               `blocked: decisione del proprietario`
 *
 * `blocked:` sta di qua o di là a seconda della causa: una causa tecnica è
 * lavoro sospeso e va riaperta come follow-up; «decisione del proprietario» è
 * un no definitivo e non genera niente.
 */
export const STATE_PATTERNS = Object.freeze({
  inThisPr: /\bin\s+questa\s+PR\b/i,
  chainedPr: /\bPR\s+concatenat[ao]\s*#\s*\d+/i,
  // «falso positivo» / «false positive» sono sinonimi accettati dello stesso
  // stato `by-choice` (stesso significato: nessuna azione dovuta) — non una
  // classe nuova.
  // La variante negata ("non è un falso positivo, va sistemato in
  // follow-up") dichiara l'OPPOSTO — lavoro dovuto, non chiuso — quindi
  // riusa lo stesso NEGATION_LOOKBEHIND già fixato per questa identica
  // frase in scripts/ci/lib/false-positive-declaration.mjs (incidente
  // #3367) invece di duplicare la naive substring-match qui.
  byChoice: new RegExp(
    String.raw`\bper\s+scelta\b|${NEGATION_LOOKBEHIND}\b(?:falso\s+positivo|false\s+positive)\b`,
    'i',
  ),
  byConstruction: /\bby\s+construction\b/i,
  // «decisione del proprietario» (o «owner») → non è lavoro sospeso, è un no.
  blockedByOwner: /\bblocked\s*:\s*[^\n]*\b(decision[ei]\s+del\s+proprietario|owner\s+decision|scelta\s+del\s+proprietario)\b/i,
  // Qualunque altro `blocked: <causa>` — lavoro sospeso su una causa esterna.
  blockedTechnical: /\bblocked\s*:\s*\S/i,
});

/**
 * Menzione dello stato «PR concatenata» SENZA il vincolo `#N`.
 * Un bullet che matcha questo ma non `STATE_PATTERNS.chainedPr` è sempre
 * una violazione `chained-pr-no-number` (mai un caso legittimo: senza
 * numero la voce non è tracciabile). Recidiva: PR #6289 / issue #6300.
 * Non esportata: i test devono passare da `checkPrBodySections`, non
 * reimplementare il regex.
 */
const CHAINED_PR_MENTION_RE = /\bPR\s+concatenat[ao]\b/i;

// Specificità, usata SOLO per rompere una parità di posizione: `blocked:
// decisione del proprietario` e il `blocked:` generico iniziano allo stesso
// indice, e vince il più specifico.
const STATE_ORDER = [
  ['blocked-owner', 'blockedByOwner'],
  ['blocked-technical', 'blockedTechnical'],
  ['chained-pr', 'chainedPr'],
  ['in-this-pr', 'inThisPr'],
  ['by-choice', 'byChoice'],
  ['by-construction', 'byConstruction'],
];

/**
 * Lo stato dichiarato da un bullet, o `null` se non ne dichiara nessuno.
 *
 * Vince lo stato che compare per PRIMO nel testo, non il primo che si prova.
 * La differenza non è teorica: un bullet il cui stato è `blocked: <causa>` può
 * benissimo contenere più avanti la frase «in questa PR» come prosa — «si
 * sblocca dopo che i generatori corretti in questa PR avranno girato» — e con
 * un ordine di prova fisso quel bullet verrebbe classificato `in-this-pr`,
 * cioè archiviato come già fatto. Trovato provando questa stessa funzione sul
 * body di questa PR: uno dei suoi bullet `blocked:` veniva filtrato proprio
 * così. Lo stato è una DICHIARAZIONE e sta all'inizio; ciò che segue è prosa.
 *
 * @param {string} item testo del bullet, con o senza il marker `- `
 * @returns {'in-this-pr'|'chained-pr'|'by-choice'|'by-construction'|'blocked-owner'|'blocked-technical'|null}
 */
export function bulletState(item) {
  const s = String(item ?? '').replace(/^[ \t]*[-*+][ \t]*/, '');
  let best = null;
  for (const [state, key] of STATE_ORDER) {
    const m = STATE_PATTERNS[key].exec(s);
    if (!m) continue;
    // `<` e non `<=`: a parità di indice tiene il precedente, cioè il più
    // specifico secondo STATE_ORDER.
    if (best === null || m.index < best.index) best = { index: m.index, state };
  }
  return best?.state ?? null;
}

/**
 * I bullet non vuoti della sezione, nell'ordine in cui compaiono.
 *
 * @param {string} rawContent testo della sezione (dopo l'header, prima del successivo)
 * @returns {string[]}
 */
export function sectionBullets(rawContent) {
  return stripNonContent(rawContent ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^[-*+][ \t]+\S/.test(l));
}

// Decision states close a residual item, so a vague decision used to erase
// work from the follow-up graph. Keep the structural fields deliberately
// narrow and parseable; this checks completeness, not whether the reason is
// substantively correct.
const DECISION_RE = /\bby construction\b|\bper (?:scelta|costruzione|design)\b|(?:è|e')\s+una\s+decisione\b|\bdi proposito\b|\bdeliberat\w*|\bblocked\s*:\s*(?:decisione del proprietario|owner decision)\b/i;
const DECISION_REASON_RE = /\b(?:motivo|ragione|reason)\s*:\s*(.+?)(?=\s+\b(?:prossimo\s+passo|next\s+step|azione\s+successiva)\s*:|$)/iu;
const DECISION_NEXT_STEP_RE = /\b(?:prossimo\s+passo|next\s+step|azione\s+successiva)\s*:\s*(.+)$/iu;
const DECISION_PLACEHOLDER_RE = /(?:^|[\s:;,.!?()\[\]{}—–-])(?:<[^>]+>|\.\.\.|tbd|n\/a|da\s+(?:definire|decidere|valutare|fare))(?=$|[\s:;,.!?()\[\]{}—–-])/iu;
const DECISION_STATES = new Set(['by-choice', 'by-construction', 'blocked-owner']);
const NON_IMPL_ANY_RE = /^[ \t]{0,3}#{2,3}[ \t]+Non[ \t]+implementato\b[^\n]*/im;

function stripDecisionFormatting(text) {
  return String(text ?? '').replace(/[*_~`]/gu, '');
}

function concreteDecisionValue(value) {
  const clean = String(value ?? '').replace(/\s+/gu, ' ').trim();
  return clean.length >= 8
    && !DECISION_PLACEHOLDER_RE.test(clean)
    && /[\p{L}\p{N}]/u.test(clean);
}

/** Verifica i due campi auditabili di una deroga decisionale. */
export function decisionDeferralSpecificity(text) {
  const normalized = stripDecisionFormatting(text);
  const reason = normalized.match(DECISION_REASON_RE)?.[1]?.trim() || '';
  const nextStep = normalized.match(DECISION_NEXT_STEP_RE)?.[1]?.trim() || '';
  return {
    specific: concreteDecisionValue(reason) && concreteDecisionValue(nextStep),
    reason,
    nextStep,
  };
}

function isDecisionDeferral(text) {
  const normalized = stripDecisionFormatting(text);
  // `bulletState` is the canonical classifier. The explicit regex retains
  // older prose forms (`deliberatamente`, `è una decisione`), while the state
  // check also covers the accepted negation-aware `falso positivo` synonym.
  return DECISION_RE.test(normalized) || DECISION_STATES.has(bulletState(normalized));
}

function leadingIndentWidth(line) {
  const prefix = line.match(/^[ \t]*/u)?.[0] || '';
  return [...prefix].reduce((width, character) => width + (character === '\t' ? 4 : 1), 0);
}

/**
 * Il testo di `## Non implementato` come lo legge il contratto: dall'header
 * (`##` o `###`) al primo heading successivo di qualunque livello. `null` se
 * la sezione manca.
 *
 * @param {string} body
 * @returns {string|null}
 */
export function nonImplementedSection(body = '') {
  return extractSection(String(body ?? ''), NON_IMPL_ANY_RE);
}

/**
 * Le voci di primo livello della sezione, con le loro continuazioni.
 *
 * È LA regola di raggruppamento del contratto: un bullet annidato (indentato
 * più del livello radice della sezione) e ogni riga non vuota che non è un
 * bullet si accodano alla voce che le precede, anche dopo una riga vuota. Chi
 * classifica le voci a valle (`scripts/ci/followup-candidate-bullets.mjs`) la
 * importa invece di riscriverla: con due raggruppamenti diversi `- residuo`
 * seguito da `per scelta` sulla riga sotto era una deroga completa qui e un
 * residuo candidato là (review della PR corpus 2080).
 *
 * Le righe non vuote che precedono il primo bullet non appartengono a nessuna
 * voce e il contratto le ignora; con `includePreamble` tornano, ciascuna a sé,
 * con `preamble: true` e `index: 0`.
 *
 * @param {string} rawContent testo della sezione (dopo l'header, prima del successivo)
 * @param {{includePreamble?: boolean}} [options]
 * @returns {Array<{index: number, text: string, preamble?: true}>} `text` porta
 *   ancora il marker della voce (`- `), le continuazioni unite da uno spazio
 */
export function topLevelBullets(rawContent, { includePreamble = false } = {}) {
  const clean = stripNonContent(rawContent ?? '');
  const lines = clean.split('\n');
  const bulletLines = lines.filter((line) => /^[ \t]*[-*+][ \t]+\S/.test(line));
  const rootIndent = bulletLines.length > 0
    ? Math.min(...bulletLines.map(leadingIndentWidth))
    : 0;
  const preamble = [];
  const bullets = [];
  let current = null;
  for (const line of lines) {
    if (/^[ \t]*[-*+][ \t]+\S/.test(line)) {
      // A nested bullet is metadata for its parent (e.g. separate Motivo and
      // Prossimo passo fields), not a second decision to validate. Root
      // indentation is measured from the section so a consistently indented
      // top-level list remains valid.
      if (leadingIndentWidth(line) <= rootIndent) {
        if (current) bullets.push(current);
        current = { index: bullets.length + 1, text: line.trim() };
      } else if (current) {
        current.text += ` ${line.trim()}`;
      }
    } else if (current && line.trim()) {
      current.text += ` ${line.trim()}`;
    } else if (!current && line.trim() && includePreamble) {
      preamble.push({ index: 0, text: line.trim(), preamble: true });
    }
  }
  if (current) bullets.push(current);
  return [...preamble, ...bullets];
}

/** Decision bullets that lack one or both concrete audit fields. */
export function decisionDeferralFindings(body = '') {
  const content = nonImplementedSection(body);
  if (content === null) return [];
  return topLevelBullets(content)
    .filter((bullet) => isDecisionDeferral(bullet.text))
    .map((bullet) => ({ ...bullet, specificity: decisionDeferralSpecificity(bullet.text) }))
    .filter((bullet) => !bullet.specificity.specific);
}

export function decisionDeferralsAreSpecific(body = '') {
  return decisionDeferralFindings(body).length === 0;
}

/**
 * I bullet della sezione che NON dichiarano uno stato.
 *
 * @param {string} rawContent testo della sezione (dopo l'header, prima del successivo)
 * @returns {string[]} i bullet senza stato, nell'ordine in cui compaiono
 */
export function bulletsWithoutState(rawContent) {
  return sectionBullets(rawContent).filter((l) => bulletState(l) === null);
}

// ---------------------------------------------------------------------------
// Diff-vs-body citation check (#6301)
// ---------------------------------------------------------------------------

/**
 * Funnel-critical path prefix: files under here carry outsized blast radius, and
 * `hasMeaningfulContent` above only checks that `## Implementato` has SOME content —
 * not that it mentions every file the diff actually touches. Reproduced on #6279
 * (mergiata): the diff modified `.github/workflows/prospector-loop.yml` and the body
 * never named it in any section; the gap surfaced only as a reviewer 🟡 Nit after the
 * fact, wasting a review cycle the same way the bullet-state gap above did.
 */
export const FUNNEL_CRITICAL_PATH_RE = /^\.github\/workflows\//;

/**
 * Funnel-critical paths in `diffPaths` that `body` never mentions — neither by their
 * full repo-relative path nor by basename. Advisory input only (see the `warnings`
 * rationale on `checkPrBodySections` below): promoting straight to a blocking
 * violation risks the same over-blocking stall documented there before authors
 * reliably cite every touched file.
 *
 * @param {string[]} diffPaths repo-relative paths changed by the PR (`git diff --name-only`)
 * @param {string} body full PR body text
 * @returns {string[]} the uncited funnel-critical paths, in the order given
 */
export function filesUncitedInBody(diffPaths, body) {
  const text = String(body ?? '');
  return (diffPaths ?? [])
    .filter((p) => FUNNEL_CRITICAL_PATH_RE.test(p))
    .filter((p) => !text.includes(p) && !text.includes(p.split('/').pop()));
}

// ---------------------------------------------------------------------------
// Claim di prestazione non validato (escalation #11675)
// ---------------------------------------------------------------------------

/**
 * AGENTS.md («Claim build/perf/memoria non validabile pre-merge → dichiara il
 * trigger di revert») e REVIEW.md step 7 erano solo prosa: il reviewer li
 * applicava dopo, con un 🔴 e un giro di review in più. Bucket
 * `reviewer-finding/unvalidated-claim` del lessons-harvester, 6 PR in 14 giorni
 * (#11641, #11053, #10464, #10292, #9959, #9950), tutte con un 🔴 corretto
 * prima di `## LGTM`. Qui la stessa regola diventa deterministica e scatta
 * prima della review: in `## Implementato` una frase che dichiara un guadagno
 * di tempo, memoria, disco o CI, senza nel body nessuna delle prove che il
 * reviewer accetta.
 *
 * Due livelli, tarati sul body che il reviewer ha giudicato (la versione in
 * vigore alla prima review, dalla cronologia degli edit) e su 145 body
 * originali di PR mergiate dal 21-09 al 05-10 con `## LGTM` finale e senza quel
 * finding (10 per giorno):
 *   - `unvalidated-perf-claim` (VIOLAZIONE): quantità con unità di tempo o di
 *     dimensione accanto a un verbo di guadagno, oppure un verbo di guadagno
 *     accanto a un sostantivo di risorsa (suite completa, wall-time, memoria,
 *     RSS, OOM, disco, pack, margine del job…). Segnala 4 esempi su 6
 *     (#10292, #11641, #10464, #9959); 1 body su 145 (#10653, «riducendo la
 *     crescita della memoria del build» senza misura, cioè proprio la classe
 *     della regola, che il reviewer non ha segnalato).
 *   - `unvalidated-io-bound-claim` (WARNING): lavoro di I/O limitato o evitato
 *     (fetch, download, prefetch, preflight; limitato, bounded). Prende gli altri
 *     2 esempi (#9950, #11053), ma su 145 body ne segnala altri 3 (#9552,
 *     #10272, #10430): sopra la tolleranza di un falso positivo su 50, quindi
 *     resta advisory.
 *
 * Prova = una qualunque delle forme che il reviewer accetta, ovunque nel body:
 * link a una run `/actions/runs/<id>`, una riga `Misura:` / `Comando:`, una
 * «misura pre/post» o «prima/dopo», una coppia di quantità confrontate
 * («308 MB contro 203 MB», «da 216 s a 9 s»), «non validato pre-merge», un
 * trigger o un rischio di revert, `blocked: misura post-merge`, una baseline.
 */
const PERF_QTY = String.raw`\d+(?:[.,']\d+)*\s*(?:ms|s|sec|secondi|minut[oi]|min|ore|h|MB|GB|KB|MiB|GiB|%)(?!\w)`;
const PERF_BENEFIT_ALT = String.raw`in meno|risparmi\w*|riduc\w*|ridott\w*|dimezz\w*|più veloc\w*|piu' veloc\w*|accelera\w*|velocizz\w*|faster|speed-?up|saves?\b|reduc\w*|abbass\w*|tagli\w*|converg\w*|evit\w*|elimin\w*|non (?:consuma|satura|sfora)\w*|sotto (?:il|i|la|le)\b`;
const PERF_BENEFIT = `(?:${PERF_BENEFIT_ALT})`;
const PERF_RESOURCE = String.raw`(?:suite (?:completa|intera)|wall[- ]?time|durata|tempi? (?:di|del|della)|memoria|\brss\b|\boom\b|heap|\bdisco\b|\bdisk\b|spazio su disco|\bleak\b|\bpack\b|margine del job|minuti|secondi|quota|latenza|throughput)`;
const PERF_CLAIM_RE = new RegExp(
  String.raw`${PERF_QTY}[^.\n]{0,120}${PERF_BENEFIT}|${PERF_BENEFIT}[^.\n]{0,120}${PERF_QTY}`
  + String.raw`|${PERF_BENEFIT}[^.\n]{0,100}${PERF_RESOURCE}|${PERF_RESOURCE}[^.\n]{0,100}${PERF_BENEFIT}`,
  'i',
);
const IO_BENEFIT = String.raw`(?:${PERF_BENEFIT_ALT}|limitat\w*|bound\w*)`;
const IO_RESOURCE = String.raw`(?:download|prefetch|preflight|fetch)`;
const IO_BOUND_CLAIM_RE = new RegExp(
  String.raw`${IO_BENEFIT}[^.\n]{0,100}${IO_RESOURCE}|${IO_RESOURCE}[^.\n]{0,100}${IO_BENEFIT}`,
  'i',
);
const PERF_EVIDENCE_RE = /\/actions\/runs\/\d+|^\s*(?:[-*]\s*)?(?:\*\*)?(?:misura|comando|measure(?:ment)?|command)(?:\*\*)?\s*:|\bmisur[ae]\s+(?:pre\/post|prima\/dopo|prima e dopo|pre-?merge)|\bnon\s+validat[oaie]\s+pre-?merge|\btrigger\s+di\s+revert|\brevert[- ]trigger|\brischio\s+di\s+revert|\bblocked\s*:\s*misura\s+post-?merge|\bbaseline\b/im;
const PERF_PAIR_RE = new RegExp(
  String.raw`${PERF_QTY}[^.\n]{0,40}(?:\bcontro\b|\bvs\.?(?!\w)|→|->)[^.\n]{0,20}?${PERF_QTY}`
  + String.raw`|\bda\s+(?:circa\s+|~)?${PERF_QTY}\s+a\s+(?:circa\s+|~)?${PERF_QTY}`,
  'i',
);

function stripCode(text) {
  return stripNonContent(text).replace(/`[^`\n]*`/g, ' ');
}

/**
 * Le frasi di `## Implementato` che dichiarano un guadagno di prestazione senza
 * che il body porti una prova (vedi sopra). `blocking` sono i claim del livello
 * violazione, `advisory` quelli del solo livello I/O.
 *
 * @param {string} body full PR body text
 * @returns {{ blocking: string[], advisory: string[] }}
 */
export function unvalidatedPerfClaims(body = '') {
  const s = String(body ?? '');
  const empty = { blocking: [], advisory: [] };
  const impl = extractSection(s, IMPL_RE);
  if (!impl) return empty;
  if (PERF_EVIDENCE_RE.test(stripNonContent(s)) || PERF_PAIR_RE.test(stripCode(s))) return empty;
  const blocking = [];
  const advisory = [];
  for (const line of stripCode(impl).split('\n')) {
    for (const sentence of line.split(/(?<=[.;])\s+/)) {
      const text = sentence.replace(/^[ \t]*[-*+][ \t]*/, '').trim();
      if (!text) continue;
      if (PERF_CLAIM_RE.test(text)) blocking.push(text);
      else if (IO_BOUND_CLAIM_RE.test(text)) advisory.push(text);
    }
  }
  return { blocking, advisory };
}

// ---------------------------------------------------------------------------
// Combined validator
// ---------------------------------------------------------------------------

const IMPL_RE = /^[ \t]{0,3}#{2,3}[ \t]+Implementato\b/im;
/**
 * L'header canonico della sezione dei residui.
 *
 * Esportata perché è l'argomento `headerRe` che `extractSection` pretende e non
 * sa costruirsi da sola: chi la riscrive a mano (un prompt, un altro script)
 * ottiene una sezione diversa da quella che questo modulo giudica — la
 * divergenza silenziosa che l'intera tassonomia qui sotto esiste per evitare.
 * NON è globale, e non deve diventarlo: `extractSection` usa `.exec()` e con il
 * flag `g` la posizione sopravvivrebbe fra due chiamate.
 */
export const NON_IMPL_ANCORA_RE = /^[ \t]{0,3}#{2,3}[ \t]+Non[ \t]+implementato[^\n]*\(ancora\)/im;
const NON_IMPL_NO_ANCORA_RE = /^[ \t]{0,3}#{2,3}[ \t]+Non[ \t]+implementato\b/im;

/**
 * Check a PR body for section-content quality violations.
 *
 * `warnings` è una lista SEPARATA da `violations` e NON entra in `ok`: è
 * advisory per costruzione. Il perché è un requisito, non una timidezza — il
 * ciclo autonomo apre e mergia le proprie PR, e il generatore che scrive quei
 * body (`.github/workflows/issue-fix.yml`, il blocco fenced allo step 9) NON
 * emette ancora gli stati letterali: emetteva la tassonomia pre-#8 abolita
 * (`out of scope / follow-up / blocked / posposto`). Con 7 PR recenti su 13
 * senza stato, promuovere subito questo check a violazione fermerebbe la coda
 * di merge dell'intero sito — è già successo il 2026-08-12, 13 ore di stallo.
 * Questa PR corregge il generatore; la promozione a duro è un passo separato,
 * da fare quando la misura sarà 0/13.
 *
 * @param {string} body full PR body text
 * @param {{ diffPaths?: string[], strictDecisionDeferrals?: boolean, strictClaims?: boolean }} [opts] `diffPaths` (optional): repo-relative paths
 *   changed by the PR, to power the diff-vs-body citation check (#6301). Omitted →
 *   that check simply doesn't run (no diff to compare against).
 * @returns {{ ok: boolean, violations: Array<{type:string,section?:string,message:string}>, warnings: Array<{type:string,section?:string,message:string}> }}
 */
export function checkPrBodySections(body = '', {
  diffPaths, strictDecisionDeferrals = false, strictClaims = strictDecisionDeferrals,
} = {}) {
  const s = String(body ?? '');
  const violations = [];
  const warnings = [];

  // --- 1. Required header: ## Implementato ------------------------------------
  const hasImpl = IMPL_RE.test(s);
  if (!hasImpl) {
    violations.push({
      type: 'missing-implementato',
      message:
        'Manca `## Implementato` (header letterale richiesto da REVIEW.md; ' +
        'non usare `## Summary`, `## Fix`, `## Verify`, `## Effetto`, etc.).',
    });
  }

  // --- 2. Required header: ## Non implementato (ancora) ----------------------
  const hasNonImplAncora = NON_IMPL_ANCORA_RE.test(s);
  if (!hasNonImplAncora) {
    const hasNonImplWithout = NON_IMPL_NO_ANCORA_RE.test(s);
    if (hasNonImplWithout) {
      violations.push({
        type: 'missing-ancora',
        section: 'Non implementato',
        message:
          '`## Non implementato` manca di "(ancora)": usa l\'header canonico ' +
          '`## Non implementato (ancora)` (come nella PR template e nel contratto REVIEW.md).',
      });
    } else {
      violations.push({
        type: 'missing-non-implementato',
        message:
          'Manca `## Non implementato (ancora)` (header letterale richiesto da REVIEW.md).',
      });
    }
  }

  // --- 3. ## Implementato section content ------------------------------------
  if (hasImpl) {
    const content = extractSection(s, IMPL_RE) ?? '';
    if (!hasMeaningfulContent(content)) {
      if (hasOnlyBareBullets(content)) {
        violations.push({
          type: 'empty-implementato',
          section: 'Implementato',
          message:
            '`## Implementato` contiene solo bullet placeholder vuoti (`- `) non compilati. ' +
            'Sostituisci ogni `- ` con una descrizione concreta del cambiamento (file / comportamento).',
        });
      } else {
        violations.push({
          type: 'empty-implementato',
          section: 'Implementato',
          message:
            '`## Implementato` è vuota. ' +
            'Aggiungi almeno un bullet che descriva cosa fa la PR (file / comportamento cambiato).',
        });
      }
    }
  }

  // --- 4. ## Non implementato (ancora) section content -----------------------
  if (hasNonImplAncora) {
    const content = extractSection(s, NON_IMPL_ANCORA_RE) ?? '';
    if (!hasNessuno(content) && !hasMeaningfulContent(content)) {
      if (hasOnlyBareBullets(content)) {
        violations.push({
          type: 'empty-non-implementato',
          section: 'Non implementato (ancora)',
          message:
            '`## Non implementato (ancora)` contiene solo bullet placeholder vuoti (`- `) non compilati. ' +
            'Scrivi "Nessuno" (task completo) oppure elenca gli item residui con stato/next-step.',
        });
      } else {
        violations.push({
          type: 'empty-non-implementato',
          section: 'Non implementato (ancora)',
          message:
            '`## Non implementato (ancora)` è vuota. ' +
            'Scrivi "Nessuno" (task completo) oppure elenca gli item residui.',
        });
      }
    }

    // --- 5. BLOCKING: «PR concatenata» senza `#N` (#6300 / recidiva #6289) ---
    // Non è un caso legittimo: lo stato letterale è `PR concatenata #N`, e
    // senza numero la voce non è tracciabile. Entra in `violations` (ok:false),
    // mai in `warnings`. I restanti bullet senza stato restano advisory —
    // non promuoviamo tutta la classe `bullet-without-state` a bloccante.
    {
      const bullets = sectionBullets(content);
      const chainedNoNumber = bullets.filter(
        (b) => CHAINED_PR_MENTION_RE.test(b) && !STATE_PATTERNS.chainedPr.test(b),
      );
      if (chainedNoNumber.length > 0) {
        violations.push({
          type: 'chained-pr-no-number',
          section: 'Non implementato (ancora)',
          message:
            `${chainedNoNumber.length} bullet di \`## Non implementato (ancora)\` dichiara`
            + ' `PR concatenata` senza `#N`. Lo stato letterale è `PR concatenata #N`'
            + ' (AGENTS.md #8, REVIEW.md): senza numero la voce non è tracciabile'
            + ' (recidiva: PR #6289).'
            + ` Primo bullet: "${chainedNoNumber[0].slice(0, 120)}".`,
        });
      }

      // --- 5b. ADVISORY: ogni bullet dichiara uno stato letterale? -----------
      // Non entra in `ok` — vedi il commento su checkPrBodySections.
      //
      // La condizione è «ci sono bullet», NON `!hasNessuno(content)`: quella
      // regex è `\bnessun[oa]?\b`, che matcha anche dentro un bullet vero — un
      // «- Nessun retry sul path offline — per scelta» le basta per dichiarare
      // l'intera sezione «task completo» e zittire il check. Sui bullet non serve
      // comunque: una sezione che dice davvero solo «Nessuno» non ha bullet, e il
      // ciclo qui sotto non gira.
      //
      // I bullet già in `chained-pr-no-number` sono esclusi: quella classe è
      // violazione, non warning.
      const stateless = bulletsWithoutState(content).filter(
        (b) => !chainedNoNumber.includes(b),
      );
      if (bullets.length > 0 && stateless.length > 0) {
        const total = bullets.length;
        warnings.push({
          type: 'bullet-without-state',
          section: 'Non implementato (ancora)',
          message:
            `${stateless.length} bullet su ${total} non dichiara`
            + ' uno stato letterale. Ogni voce residua vuole `in questa PR` / `PR concatenata #N` /'
            + ' `per scelta` / `by construction` / `blocked: <causa>` (AGENTS.md #8, REVIEW.md).'
            + ' Senza stato la voce viene raccolta come follow-up da'
            + ' scripts/ci/followup-has-candidates.mjs, anche quando è già chiusa.'
            + ` Primo bullet interessato: "${stateless[0].slice(0, 120)}".`,
        });
      }
    }

    // --- 5b. STRICT: a decision must remain auditable ------------------------
    if (strictDecisionDeferrals) {
      for (const finding of decisionDeferralFindings(s)) {
        violations.push({
          type: 'decision-deferral-not-specific',
          section: 'Non implementato (ancora)',
          message:
            `Voce ${finding.index} dichiara una deroga decisionale senza `
            + '`Motivo: <causa concreta>` e `Prossimo passo: <azione concreta>`.',
        });
      }
    }
  }

  // --- 5c. STRICT: claim di prestazione senza prova (#11675) ------------------
  // Solo per le scritture nuove (stessa opzione delle deroghe): i lettori di
  // body storici e il contratto del corpus, che chiama senza opzioni, restano
  // invariati.
  if (strictClaims && hasImpl) {
    const { blocking, advisory } = unvalidatedPerfClaims(s);
    const remedy = ' Aggiungi nel body una prova: link alla run `/actions/runs/<id>`, una riga'
      + ' `Misura:` o `Comando:` con l\'output pre/post, oppure dichiara il claim'
      + ' «non validato pre-merge» con un bullet `blocked: misura post-merge` in'
      + ' `## Non implementato (ancora)` che nomina workflow, soglia e trigger di revert'
      + ' (AGENTS.md, Build And Test; REVIEW.md step 7).';
    if (blocking.length > 0) {
      violations.push({
        type: 'unvalidated-perf-claim',
        section: 'Implementato',
        message:
          `${blocking.length} frase di \`## Implementato\` dichiara un guadagno di tempo, memoria,`
          + ` disco o CI senza misura: "${blocking[0].slice(0, 160)}".` + remedy,
      });
    }
    if (advisory.length > 0) {
      warnings.push({
        type: 'unvalidated-io-bound-claim',
        section: 'Implementato',
        message:
          `${advisory.length} frase di \`## Implementato\` limita o evita lavoro di I/O senza misura:`
          + ` "${advisory[0].slice(0, 160)}". Se è un claim di prestazione, vale la stessa regola.`
          + remedy,
      });
    }
  }

  // --- 6. ADVISORY: funnel-critical files touched by the diff but never cited ------
  // Not entered into `ok` — same reasoning as check 5 above (bullet-without-state):
  // the generator producing these bodies doesn't yet cite every file reliably, and
  // promoting this straight to blocking would repeat the 2026-08-12 stall.
  if (diffPaths && diffPaths.length > 0) {
    const uncited = filesUncitedInBody(diffPaths, s);
    if (uncited.length > 0) {
      warnings.push({
        type: 'files-uncited-in-body',
        message:
          `${uncited.length} file funnel-critical modificati dal diff non sono citati nel ` +
          `body (né per path né per basename): ${uncited.map((p) => `\`${p}\``).join(', ')}. ` +
          'Aggiungi un bullet in `## Implementato` che li menziona (recidiva: PR #6279, ' +
          '`.github/workflows/prospector-loop.yml` modificato e mai citato).',
      });
    }
  }

  return { ok: violations.length === 0, violations, warnings };
}

// ---------------------------------------------------------------------------
// CLI entrypoint (guard: only when invoked directly, not when imported)
// ---------------------------------------------------------------------------
import { fileURLToPath } from 'node:url';
import path from 'node:path';

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const JSON_OUT = argv.includes('--json');
  const bodyArg = argv.filter((a) => !a.startsWith('--'))[0];

  const run = (body) => {
    const res = checkPrBodySections(body);
    if (JSON_OUT) {
      process.stdout.write(JSON.stringify(res, null, 2) + '\n');
      if (!res.ok) process.exitCode = 1;
      return;
    }
    if (res.ok) {
      process.stdout.write('✓ PR body sections OK — Implementato e Non implementato (ancora) presenti e compilati.\n');
    } else {
      for (const v of res.violations) {
        process.stderr.write(`✗ [${v.type}] ${v.message}\n`);
      }
      process.exitCode = 1;
    }
    // ADVISORY: stampato sempre, non tocca mai exitCode. Deve restare visibile
    // anche quando il resto è verde — è l'unico posto in cui un autore vede il
    // difetto prima che diventi una issue di follow-up spuria.
    for (const w of res.warnings ?? []) {
      process.stderr.write(`⚠ [${w.type}] ${w.message}\n`);
    }
  };

  if (typeof bodyArg === 'string') {
    run(bodyArg);
  } else {
    let buf = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (d) => { buf += d; });
    process.stdin.on('end', () => run(buf));
  }
}
