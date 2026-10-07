#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
// Lessons harvester — DETERMINISTIC aggregator (zero Claude).
//
// Scans recent reviewer findings, recurring issue classes and issue-fix
// outcomes, buckets them by a fixed taxonomy, drops anything already covered by
// the doc-contracts (AGENTS.md / ISSUES.md / REVIEW.md / FOLLOWUP.md), and
// emits the surviving "novel recurring" clusters. The weekly/daily workflow
// only spends a Claude turn when this script reports has_novel=true, so the
// common (nothing-new) day costs zero model tokens.
//
// Output:
//   - writes clusters JSON to $HARVEST_OUT (default: harvest-clusters.json)
//   - prints a human summary to stdout
//   - appends `has_novel=<bool>` and `novel_count=<n>` to $GITHUB_OUTPUT
//
// Env knobs: WINDOW_DAYS (14), THRESHOLD (3), MAX_PRS (0), MAX_ISSUES (0).
// MAX_PRS / MAX_ISSUES a 0 = nessun tetto: la finestra si legge INTERA (vedi
// `collectWindow`). Un tetto esplicito resta possibile, ma viene dichiarato
// come vista parziale, mai applicato in silenzio.
//
// Pure helpers (detectSeverity / tallyFindings / bucketFinding / issueClass /
// severityLabelForCount / parseEscalationKey) are exported and unit-tested; the
// gh-scanning + escalation-emit side effects live in main(), run only when this
// file is invoked as a script (guard at bottom) so importing it is free.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createGithubIssue } from '../lib/github-issue-creator.mjs';
import { FIX_OUTCOME_RE } from './close-recovered-failure-issues.mjs';
import { FALSE_POSITIVE_DECLARATION_RE } from './lib/false-positive-declaration.mjs';
import { REVIEWER_BOT_LOGIN_RE } from './lib/constants.mjs';
import { isExplicitNonFunnelDisposition, isMalformedReviewBody } from './lib/review-findings.mjs';
import { intFromEnv } from '../lib/int-from-env.mjs';
import { ACCEPTANCE_CONDITION, hasEnumeratedItems } from './followup-resolution-match.mjs';
import { isAggregate, isAggregateForAnalytics } from './check-issue-already-resolved.mjs';

export { hasEnumeratedItems };

// I default sono la misura CANONICA: il self-heal chiude solo su quella (vedi
// selfHealDecision), mai su una finestra accorciata o una soglia alzata a mano.
export const DEFAULT_WINDOW_DAYS = 14;
export const DEFAULT_THRESHOLD = 3;
export const DEFAULT_EFFICACY_FACTOR = 2;
const WINDOW_DAYS = intFromEnv('WINDOW_DAYS', DEFAULT_WINDOW_DAYS);
const THRESHOLD = intFromEnv('THRESHOLD', DEFAULT_THRESHOLD);
// Default 0 = nessun tetto. Fino al 2026-09-27 erano 40 e 120, e la «finestra
// di 14 giorni» era una finzione: il sito mergia 70-120 PR al giorno (999 PR
// dal 13 al 27-09), quindi `--limit 40` leggeva le review delle ultime ~12 ore;
// le issue `agent:triaged` aggiornate nella finestra erano 664 e ne entravano
// 120. Misurato sulla stessa finestra: capped 0 NOVEL / 0 ESCALATE per 30+ run
// di fila, finestra intera 1 NOVEL + 2 ESCALATE. Il corpus (126 PR, 182 issue
// in 14 giorni) ne leggeva abbastanza da produrre lezioni, e per questo il
// difetto sembrava del solo sito.
const MAX_PRS = intFromEnv('MAX_PRS', 0);
const MAX_ISSUES = intFromEnv('MAX_ISSUES', 0);
// La search API di GitHub restituisce al massimo 1000 risultati per query:
// oltre, `gh ... --limit N` si ferma senza errore. Per questo la finestra si
// legge un giorno alla volta (`collectWindow`) e un giorno che tocca il tetto
// viene dichiarato troncato.
export const SEARCH_RESULT_CAP = 1000;
// `gh pr list --json reviews` / `gh issue list --json comments` leggono al
// massimo 100 nodi annidati per elemento: chi li raggiunge viene riletto con
// `gh pr view` / `gh issue view`, che paginano.
export const NESTED_PAGE_CAP = 100;
const OUT = process.env.HARVEST_OUT || 'harvest-clusters.json';
const NO_AUTOCLOSE = process.env.FOLLOWUP_NO_AUTOCLOSE === '1' || process.env.NO_AUTOCLOSE === '1';
// EFFICACY_FACTOR: a documented pattern that STILL recurs at ≥ THRESHOLD×factor
// is evidence the prose rule isn't preventing the mistake → escalate to a
// structural fix instead of writing another line nobody follows.
const EFFICACY_FACTOR = intFromEnv('EFFICACY_FACTOR', DEFAULT_EFFICACY_FACTOR);

const sinceMs = Date.now() - WINDOW_DAYS * 86_400_000;
const sinceDay = new Date(sinceMs).toISOString().slice(0, 10);

function gh(args) {
  try {
    return execFileSync('gh', args, { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    process.stderr.write(`gh ${args.join(' ')} failed: ${err.message}\n`);
    return '';
  }
}
function ghJson(args) {
  const raw = gh(args).trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// Le liste della finestra portano body e commenti: una pagina GraphQL da 100
// issue puo' rispondere 504 (misurato il 2026-09-27 su `updated:2026-09-27`).
// Un 504 e' transitorio, quindi si ritenta prima di dichiarare il giorno fallito.
function ghJsonRetry(args, attempts = 3) {
  for (let i = 1; i <= attempts; i++) {
    const out = ghJson(args);
    if (out !== null) return out;
    if (i < attempts) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000 * i);
  }
  return null;
}

// ---- Window coverage (pure → unit-tested) ----------------------------------
/**
 * I giorni UTC `YYYY-MM-DD` da `sinceDay` a `todayDay` inclusi.
 * @param {string} sinceDay
 * @param {string} todayDay
 * @returns {string[]}
 */
export function windowDays(sinceDay, todayDay) {
  const days = [];
  const end = Date.parse(`${todayDay}T00:00:00Z`);
  for (let t = Date.parse(`${sinceDay}T00:00:00Z`); Number.isFinite(t) && t <= end; t += 86_400_000) {
    days.push(new Date(t).toISOString().slice(0, 10));
  }
  return days;
}

/**
 * Legge la finestra un giorno alla volta e unisce per `number`. `fetchDay`
 * restituisce le righe del giorno, oppure `null` se la lettura e' fallita.
 * Un giorno che raggiunge `cap` righe e' TRONCATO dalla search API; un giorno
 * fallito e' un BUCO: entrambi finiscono nel risultato, perche' una finestra
 * letta a meta' che si dichiara intera e' esattamente il guasto che ha tenuto
 * l'harvester del sito a zero lezioni per settimane.
 * @param {string[]} days
 * @param {(day: string) => Array<{number: number}> | null} fetchDay
 * @param {{cap?: number}} [opts]
 */
export function collectWindow(days, fetchDay, { cap = SEARCH_RESULT_CAP } = {}) {
  const byNumber = new Map();
  const truncatedDays = [];
  const failedDays = [];
  for (const day of days) {
    const rows = fetchDay(day);
    if (!Array.isArray(rows)) { failedDays.push(day); continue; }
    if (rows.length >= cap) truncatedDays.push(day);
    for (const r of rows) {
      if (r && r.number != null && !byNumber.has(r.number)) byNumber.set(r.number, r);
    }
  }
  const items = [...byNumber.values()].sort((a, b) => b.number - a.number);
  return { items, truncatedDays, failedDays };
}

/**
 * Un giorno della finestra con ripiego: prima la lista completa (una query);
 * se fallisce, la lista leggera idratata elemento per elemento. `null` solo se
 * falliscono entrambe, e allora `collectWindow` dichiara il giorno mancante.
 * @template T
 * @param {() => T[] | null} fetchFull
 * @param {() => T[] | null} fetchLight
 * @param {(item: T) => T} hydrate
 * @returns {T[] | null}
 */
export function fetchDayWithFallback(fetchFull, fetchLight, hydrate) {
  const full = fetchFull();
  if (Array.isArray(full)) return full;
  const light = fetchLight();
  if (!Array.isArray(light)) return null;
  return light.map(hydrate);
}

/**
 * Tetto opzionale: `max` 0 = nessun tetto. Restituisce anche se ha tagliato,
 * cosi' il chiamante lo dichiara invece di tacerlo.
 * @template T
 * @param {T[]} items
 * @param {number} max
 * @returns {{items: T[], cut: number}}
 */
export function applyCap(items, max) {
  if (!max || items.length <= max) return { items, cut: 0 };
  return { items: items.slice(0, max), cut: items.length - max };
}

/**
 * Le righe `::warning::` di copertura: vuote quando la finestra e' stata
 * letta per intero.
 * @param {string} label
 * @param {{truncatedDays: string[], failedDays: string[]}} window
 * @param {number} cut
 * @param {number[]} [unreadItems] elementi letti senza i loro nodi annidati
 * @returns {string[]}
 */
export function coverageWarnings(label, { truncatedDays, failedDays }, cut, unreadItems = [], unreadNoun = 'commenti') {
  const out = [];
  if (truncatedDays.length) {
    out.push(`::warning::${label}: giorni al tetto della search API (${SEARCH_RESULT_CAP}), vista PARZIALE: ${truncatedDays.join(', ')}`);
  }
  if (failedDays.length) {
    out.push(`::warning::${label}: lettura fallita, giorni MANCANTI dalla finestra: ${failedDays.join(', ')}`);
  }
  if (cut) out.push(`::warning::${label}: tetto esplicito, ${cut} elementi della finestra esclusi (vista PARZIALE)`);
  if (unreadItems.length) {
    out.push(`::warning::${label}: ${unreadNoun} illeggibili per ${unreadItems.length} elementi, vista PARZIALE: ${unreadItems.map((n) => `#${n}`).join(', ')}`);
  }
  return out;
}

// ---- Reviewer-finding taxonomy: stable buckets via regex on finding text. ----
// Each finding (a 🔴/🟡/❓ line in a reviewer review body) maps to ONE bucket so
// recurrence is countable without fuzzy NLP. `docKeys` are substrings searched
// in the doc corpus to decide "already documented".
//
// Two finding FAMILIES live here:
//   - TOPIC buckets (structured-data, cls, auto-ads, …): "agent shipped wrong
//     code about <domain>". Adding a NEW doc rule fixes these. Since decision
//     I3 (2026-10-05) a pure lexicon bucket is report-only and never escalates;
//     see the `escalation` field of each entry below.
//   - PROCESS-failure-mode buckets (pr-body-contract, sibling-class-fix,
//     unvalidated-claim, stale-comment): "agent repeats a meta-mistake". These
//     are usually ALREADY documented, so they never surface as `novel`. They
//     matter via the EFFICACY signal instead: documented-but-still-recurring →
//     `recurringDespiteRule` → the prose rule isn't working → escalate to a
//     STRUCTURAL fix (template / CI gate / shared module), not another line.
//     (These 4 buckets were the harvester's blind spot until 2026-06-04.)
const ADSENSE_BOT_GATE_AD_SURFACE = String.raw`(?:\badsense\b|\badsbygoogle\b|\bauto[- ]?ads?\b|\bads?\b|\badvertising\b|\badvertisements?\b|\bcta\b)`;
const ADSENSE_BOT_GATE_SIGNAL = String.raw`(?:\b(?:bot|bots)\b|\banti[- ]?bot\b|\bautomation(?:[- ]?(?:gate|classifier|detector|signature))?\b|\bscreen\s+signature\b|\bfalse\s+positive\b|\b(?:real|legitimate)\s+(?:session|user)\b)`;
const ADSENSE_BOT_GATE_RE = new RegExp(
  String.raw`(?:${ADSENSE_BOT_GATE_AD_SURFACE}[\s\S]{0,180}${ADSENSE_BOT_GATE_SIGNAL}|${ADSENSE_BOT_GATE_SIGNAL}[\s\S]{0,180}${ADSENSE_BOT_GATE_AD_SURFACE})`,
  'i',
);
// A generic `credential`/`secret` can describe an application account, and
// file locations can contain those words even when the finding is unrelated
// (for example #10637's checkout-time measurement finding in
// `unsubscribe-credential-monitor.yml`). Keep the topic tied to GitHub Actions
// authentication or capability evidence.
const WORKFLOW_SCOPE_CREDS_RE = /workflows? scope|github_pat|github[_ .-]?token|gh[_ .-]?token|\bpat\b|app[_ .-]?token|persist-credentials|branch protection|token\s+(?:scope|permission|capabilit)|(?:\b(?:github|workflow|actions\/checkout|checkout|branch protection|app installation)\b[\s\S]{0,100}\b(?:credential|credentials|secret|token)\b|\b(?:credential|credentials|secret|token)\b[\s\S]{0,100}\b(?:github|workflow|actions\/checkout|checkout|branch protection|app installation)\b)/i;

// Candidate: a canonical (canonicalPath, canonical URL) and a trailing slash in
// the same finding line, in either order and in either review language. The
// semantic guard below also requires an explicit missing-slash signal.
const CANONICAL_TRAILING_SLASH_RE = /\bcanonical\w*\b[^\n]{0,200}?(?:\btrailing[- ]slash|\bslash finale|\bbarra finale)|(?:\btrailing[- ]slash|\bslash finale|\bbarra finale)[^\n]{0,200}?\bcanonical\w*\b/i;
const CANONICAL_MISSING_SLASH_RE = /\b(?:without|missing|omit\w*|remove\w*|lack\w*|absent|fail\w*\s+to|(?:do|does|did)\s+not|(?:does|did)n['’]?t|senza|manc\w*|omett\w*|rimuov\w*|assent\w*)\b/i;
const CANONICAL_NO_TRAILING_SLASH_RE = /\bno\b[^\n]{0,32}\b(?:trailing[- ]slash|slash finale|barra finale)\b/i;

function isMissingCanonicalTrailingSlash(text) {
  const s = String(text || '');
  if (!CANONICAL_TRAILING_SLASH_RE.test(s)) return false;
  return [...s.matchAll(/\b(?:trailing[- ]slash|slash finale|barra finale)\b/gi)].some((match) => {
    const context = sentenceAround(s, match.index, match.index + match[0].length);
    return /\bcanonical\w*\b/i.test(context) &&
      (CANONICAL_MISSING_SLASH_RE.test(context) || CANONICAL_NO_TRAILING_SLASH_RE.test(context));
  });
}

// `structured-data` is a lexicon, and the same words name two classes with two
// different structural fixes (issue 9108, reopened 2026-10-04 with 11 findings
// after the cutoff): the site EMITTERS that write JSON-LD (build-plugins,
// services/seo: #11328, #10992, #10753, #11021) and the crawler PARSERS that
// READ a source's JSON-LD/JobPosting or fill the fields it is built from
// (scripts/update-*-jobs.mjs, scripts/lib/*-job-parser.mjs: #11406, #11303,
// #11297, #11281, #11206, #11126). One bucket summed them, so an emitter gate
// could never bring the count down and the escalation re-fired on parser work.
// Split by WHERE the finding is located, threshold unchanged: a finding whose
// located paths are ALL crawler parsers counts in `structured-data-parser`;
// anything else (emitter paths, mixed, or no path) stays `structured-data`.
const STRUCTURED_DATA_RE = /structured data|json-?ld|basesalary|postalcode|hiringorganization|jobposting/i;

// ---- Regola o argomento: chi puo' aprire un'escalation ----------------------
// Decisione del proprietario I3 del 2026-10-05: i bucket «di argomento» restano
// SOLO nel report; l'escalation (`escalation(harvester): …`) scatta solo per le
// voci legate a una regola violata. Soglie invariate. Caso guida: issue 10112,
// dove `canonical-sitemap` (un lessico) sommava 9 finding di argomento mentre la
// sua sottoclasse vera, `canonical-trailing-slash`, aveva gia' gate e bucket.
// Ogni voce dichiara `escalation` e il motivo in `why`:
//   - 'rule': un predicato su una violazione precisa (un guard, un sottotipo
//     strutturale, o un'espressione le cui alternative nominano tutte la
//     violazione). Sopra soglia escala.
//   - 'topic': un lessico di un'area del codice. Contato nel tally e nel report,
//     non apre e non tiene aperta un'escalation (il self-heal la chiude).
//   - 'ambiguous': non classificabile senza perdere un segnale; resta
//     nell'escalation come una 'rule' e lo dichiara.
// I bucket fuori tassonomia (fingerprint `fp:*`, codici `fix-outcome`) non sono
// toccati da questa decisione: decide isEscalationDriver come prima.
export const TAXONOMY_ESCALATION_KINDS = Object.freeze(['rule', 'topic', 'ambiguous']);

// Il checker/gate sibling e' un'area del codice, non la classe di processo che
// misura i gemelli lasciati indietro. Le forme qui sotto descrivono il soggetto
// dello strumento (cache/revisione del checker, filtro del gate o misura del
// hook), non un semplice path citato nell'acceptance del finding.
const SIBLING_TOOLING_RE =
  /\bsibling\s+checker\b|\bchecker\s+(?:cache|contents?|extracted|invocation|revision)\b|\bfunction-header\s+filter\b|\bgeneric\s+sibling\s+expression\b|\bgate\s+candidate\b|\bhook\b[^.\n]{0,40}\bcomplete\b[^.\n]{0,40}\b(?:large|partial)\s+clones?\b|\b(?:large|partial)\s+clones?\b[^.\n]{0,120}\b(?:pre\/?post|measurement|benchmark)\b/i;
const UNVALIDATED_CLAIM_RE =
  /claim.*(non validat|unvalidated|speculativ)|non validat.*pre-?merge|atteso\s+green|revert-?trigger|sufficienza speculativa/i;

export const TAXONOMY = [
  { key: 'structured-data-parser', re: STRUCTURED_DATA_RE, docKeys: ['structured data', 'json-ld', 'jobposting'],
    escalation: 'rule', why: "predicato sulla posizione: tutti i path del finding sono parser del crawler (isCrawlerParserFinding), cioe' la classe che il gate dei parser misura" },
  { key: 'structured-data', re: STRUCTURED_DATA_RE, docKeys: ['structured data', 'json-ld', 'basesalary'],
    escalation: 'ambiguous', why: "resto lessicale dopo lo split dei parser, ma i suoi termini (basesalary, postalcode, hiringorganization) sono i campi obbligatori del Non-Negotiable 3: non si puo' dire che sia solo argomento, resta nell'escalation" },
  { key: 'missing-test-funnel', re: /missing test|test mancant|no test|senza test|test coverage/i, docKeys: ['test coverage', 'test mancant', 'senza test'],
    escalation: 'ambiguous', why: "quattro alternative nominano la violazione (test mancante), la quinta 'test coverage' e' argomento e nessun guard le separa: resta nell'escalation" },
  { key: 'time-bomb-hardcoded', re: /hardcoded|time-?bomb|absolute date|aged? out|invecchia|date assolut/i, docKeys: ['date assolut', 'time-bomb', 'daysago'],
    escalation: 'rule', why: "ogni alternativa nomina la violazione della regola 'mai date assolute' (AGENTS.md, Test fixture), non un'area del codice" },
  // AdSense findings need a structural subtype before the generic topic bucket.
  // The old flat regex grouped unrelated reviewer findings from #10030, #10028,
  // #9836, #9835 and #9492 into `auto-ads`, so the harvester escalated a topic
  // even though no single antipattern recurred. Keep the threshold unchanged;
  // improve the measurement by preserving the failure mode in the bucket key.
  //
  // `noindex`/`indexable` alone are deliberately NOT thin-content evidence:
  // SEO parser and audit findings mention both routinely, while `ad` alone also
  // appears in ordinary prose such as "metadata"/"head". Require an explicit
  // content-floor signal and an explicit ad-unit surface in the same finding.
  // This keeps a real "thin page still carries AdSense" finding countable while
  // leaving unrelated noindex, missing-ad and generic SEO findings to their own
  // bucket/fingerprint (measured on #10177, #10037 and #9910).
  { key: 'adsense-thin-content', re: new RegExp(
    String.raw`(?:(?:thin(?:[- ]content)?|word[- ]?count|below[- ]floor|mfa)[\s\S]{0,220}(?:adsense|adsbygoogle|auto[- ]?ads|manual\s+(?:ad|adsense)|multiplex|<ins\b|(?:ad|ads)\s+(?:unit|slot|block|snippet|placement)|(?:unit|slot|block|snippet|placement)\s+(?:ad|ads))|(?:adsense|adsbygoogle|auto[- ]?ads|manual\s+(?:ad|adsense)|multiplex|<ins\b|(?:ad|ads)\s+(?:unit|slot|block|snippet|placement)|(?:unit|slot|block|snippet|placement)\s+(?:ad|ads))[\s\S]{0,220}(?:thin(?:[- ]content)?|word[- ]?count|below[- ]floor|mfa))`,
    'i',
  ), docKeys: ['auto ads', 'adsense'],
    escalation: 'rule', why: "sottotipo strutturale: soglia di contenuto e unita' AdSense nella stessa riga, violazione del Non-Negotiable 4 (thin content con annunci)" },
  { key: 'adsense-slot-lifecycle', re: /(?:(?:static[- ]slot|drive[- ]by|adsbygoogle|<ins>)[\s\S]{0,180}(?:collapse|timeout|consent|no[- ]ads|unfilled|watcher)|(?:collapse|timeout|consent|no[- ]ads|unfilled|watcher)[\s\S]{0,180}(?:static[- ]slot|drive[- ]by|adsbygoogle|<ins>))/i, docKeys: ['auto ads', 'adsense'],
    escalation: 'rule', why: "sottotipo strutturale: ciclo di vita dello slot statico (collapse, timeout, consenso, unfilled), un modo di guasto preciso" },
  // Keep both sides explicit and word-bounded. The previous `ads?`/`bot`
  // fragments matched the tail of ordinary words (`load` + `automation`,
  // `advertised` + `antiBotChallenge`, `ad` + `both`, `instead` +
  // `antiBotExhausted`) and turned unrelated funnel findings into this bucket
  // (#10209). A bot-gate finding must mention an ad surface and a genuine
  // bot/automation signal; short substrings are not evidence.
  { key: 'adsense-bot-gate', re: ADSENSE_BOT_GATE_RE, docKeys: ['auto ads', 'adsense'],
    escalation: 'rule', why: "sottotipo strutturale: superficie annunci e segnale bot/automazione entrambi richiesti, word-bounded (issue 10209)" },
  { key: 'adsense-loader-contract', re: /(?:(?:adsense|adsbygoogle|auto ?ads)[\s\S]{0,220}(?:loader|script|asset|chunk|cdn|same[- ]origin|missing|absent|drop|zero|offload)|(?:loader|script|asset|chunk|cdn|same[- ]origin|missing|absent|drop|zero|offload)[\s\S]{0,220}(?:adsense|adsbygoogle|auto ?ads))/i, docKeys: ['auto ads', 'adsense'],
    escalation: 'rule', why: "sottotipo strutturale: contratto del loader AdSense (script, chunk, cdn, offload) mancante o rotto" },
  { key: 'cls-layout', re: /\bcls\b|layout shift|reflow|reserve space|min-h-|aspect-ratio/i, docKeys: ['cls', 'reserve space', 'layout shift'],
    escalation: 'topic', why: "lessico dell'area layout (cls, reflow, min-h-, aspect-ratio): nomina anche il rimedio, non una violazione precisa" },
  { key: 'auto-ads', re: /auto ?ads|adsense|anchor ad|vignette|in-page ad/i, docKeys: ['auto ads', 'adsense'],
    escalation: 'topic', why: "lessico generico AdSense rimasto dopo i sottotipi adsense-*: raccoglie qualunque finding che nomini gli annunci" },
  // Split out of `canonical-sitemap` by the RULE it violates, not by its words
  // (issue 10112, triage of the 11 findings after the 2026-09-27 cutoff): an
  // article canonicalPath written without the trailing slash the site's URL
  // contract requires (AGENTS.md, "Trailing slash obbligatorio"). Two of the
  // eleven (#11114, #10987) were this one rule, both on the SEO entries the
  // corpus article generator writes; that generator now refuses a no-slash
  // canonicalPath in its post-write validation, so this bucket measures that
  // gate alone. The other nine stay in the topic bucket below: they share
  // vocabulary, not a rule. Threshold unchanged.
  { key: 'canonical-trailing-slash', re: CANONICAL_TRAILING_SLASH_RE, docKeys: ['trailing slash obbligatorio', 'trailing slash'],
    escalation: 'rule', why: "predicato sulla violazione: canonical senza lo slash finale obbligatorio (isMissingCanonicalTrailingSlash), con gate nel generatore del corpus" },
  // Precedence is intentional: when a finding mentions both surfaces, the
  // topic bucket wins before the sibling-sweep process bucket below.
  { key: 'canonical-sitemap', re: /\b(?:canonical|sitemaps?|noindex|cross-section)\b/i, docKeys: ['canonical', 'sitemap', 'noindex'],
    escalation: 'topic', why: "lessico SEO (canonical, sitemap, noindex, cross-section): il guard toglie gli usi non SEO ma lascia insieme difetti diversi, nessuna regola comune (issue 10112)" },
  // Keep this bucket about authentication/capability mistakes. The former
  // `push.*workflow` alternative matched any workflow finding whose prose
  // mentioned a push and later said "workflow" (#9566/#9326/#9218), merging
  // trigger/retry correctness with credential scope and repeatedly re-firing
  // this escalation. Those findings still go through the fingerprint safety
  // net; they must not inflate the credential bucket.
  { key: 'workflow-scope-creds', re: WORKFLOW_SCOPE_CREDS_RE, docKeys: ['workflows`', 'capability-guard', 'github_pat'],
    escalation: 'rule', why: "autenticazione e capability dei workflow, con la guardia che legge solo il testo dopo il marcatore di severita'" },
  // i18n-NAMING: genuine naming/i18n defects only — locale URL segments, translated
  // brand names, canton-aware slug naming, missing/untranslated keys. The old regex
  // `/locale|i18n|translat|canton-?aware|naming|brand/i` was far too loose: the bare
  // `translat` swallowed the ENTIRE translate pipeline (a high-volume active area),
  // `naming` matched any "naming" (e.g. ad-container naming), `brand` matched
  // "branded"/"branding" — so heterogeneous, unrelated findings false-clustered here
  // and tripped a phantom `recurringDespiteRule` escalation (issue #2122, 15 hits / 0
  // real naming defects). Deliberately NO replacement topic-bucket for the translate
  // pipeline: those findings are genuine process-failures (unvalidated-claim,
  // sibling-class-fix, pr-body-contract) and now route to THOSE buckets, or fall to
  // the fingerprint safety-net — which clusters only on truly-repeated lead-phrases.
  { key: 'i18n-naming', re: /locale segment|locale-?prefix|canton-?aware (slug|naming|url)|translated? brand|brand.*translat|translation key|missing (locale|translation)|untranslated/i, docKeys: ['locale', 'i18n', 'canton-aware'],
    escalation: 'ambiguous', why: "meta' alternative nominano la violazione (untranslated, missing translation), meta' un'area (locale segment, locale-prefix): resta nell'escalation" },
  { key: 'router-nav', re: /router|parsepath|staticoverlay|window\.location/i, docKeys: ['router', 'staticoverlay', 'parsepath'],
    escalation: 'topic', why: "lessico dei nomi del router (router, parsePath, staticOverlay): un modulo, non una violazione" },
  // PROCESS-failure-mode buckets (see family note above):
  { key: 'pr-body-contract', re: /implementato|non implementato|completeness contract|sezioni? (obbligatori|mancant)|## fix\b|## verify\b/i, docKeys: ['completeness contract', 'non implementato'],
    escalation: 'rule', why: "contratto del body PR, con il filtro dei falsi positivi isGenuinePrBodyContractViolation" },
  { key: 'sibling-tooling', re: SIBLING_TOOLING_RE, docKeys: ['sibling checker', 'sibling-check', 'check-sibling-patterns'],
    escalation: 'topic', why: "soggetto sul checker o gate sibling: resta nel report come argomento, ma non misura la recidiva del processo di sweep" },
  { key: 'sibling-class-fix', re: /stesso anti-?pattern|file gemello|stesso costrutto|sibling|non toccat|class-complete/i, docKeys: ['file gemello', 'stesso anti', 'class-complete'],
    escalation: 'rule', why: "Non-Negotiable 6, con il filtro isGenuineSiblingClassViolation che esige una relazione di classe" },
  { key: 'unvalidated-claim', re: UNVALIDATED_CLAIM_RE, docKeys: ['non validat', 'revert-trigger', 'speculativ'],
    escalation: 'rule', why: "ogni alternativa nomina la violazione: claim non validato pre-merge senza revert-trigger (AGENTS.md, Build And Test)" },
  { key: 'stale-comment', re: /stale (comment|doc)|comment(o|i)? stale|docblock stale|descrive ancora|title.*(contraddice|stale)|commento.*vecchio/i, docKeys: ['stale comment', 'docblock', 'descrive ancora'],
    escalation: 'rule', why: "ogni alternativa nomina la violazione (commento o docblock stale), con lo scarto delle disposizioni esplicite nel tally" },
];

// Catch-all fingerprint: when a finding matches NO taxonomy bucket, don't drop
// it silently (the old behaviour that hid the 4 process classes above). Derive a
// deterministic fingerprint from the first few CONTENT words (stopwords, emoji,
// severity labels, code spans, paths and digits stripped) so genuinely-NEW
// recurring phrasings still cluster and surface for human review. Coarse by
// design: it catches stable lead-phrases ("manca la sezione…", "claim non…"),
// not every paraphrase — a safety net, not a classifier.
const STOPWORDS = new Set(['the', 'a', 'an', 'di', 'la', 'il', 'le', 'lo', 'un', 'una',
  'e', 'ed', 'o', 'in', 'su', 'per', 'con', 'da', 'del', 'della', 'dei', 'delle', 'al',
  'non', 'che', 'è', 'this', 'is', 'to', 'of', 'and', 'or', 'no', 'nel', 'nella']);
function fingerprintFinding(text) {
  const words = text
    .toLowerCase()
    .replace(/[🔴🟡🟣❓]/g, ' ')
    .replace(/`[^`]*`/g, ' ')          // code spans (file paths, symbols, values)
    .replace(/\b(important|nit|q|pre-existing|process)\b/gi, ' ') // severity labels
    .replace(/[#/].*?(\s|$)/g, ' ')    // headings, paths
    .replace(/[^a-zàèéìòù\s-]+/gi, ' ') // punctuation, digits
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
  const lead = words.slice(0, 4);
  return lead.length >= 3 ? `fp:${lead.join('-')}` : null; // too short → still drop
}
// ---- `pr-body-contract` false-positive guard (DETERMINISTIC) ----------------
// The `pr-body-contract` regex matches the contract VOCABULARY (`## Implementato`,
// `## Non implementato`, `completeness contract`, …), but a reviewer line mentions
// that vocabulary in four distinct senses, only ONE of which is a recurring agent
// mistake worth escalating:
//   (a) GENUINE violation — a section is missing/empty/incomplete, or a `Closes`
//       multi-issue line, or `## Implementato` makes a false/unverified claim.
//       This is the escalation target.
//   (b) AFFIRMATION — the reviewer states the contract is fine ("sezioni presenti
//       e sensate", "completeness contract OK", "## Implementato accurato",
//       "completeness contract del body è valido"). NOT a defect; counting it
//       inflates the bucket (#2397/#2396 examples).
//   (c) LOCATION LABEL — the finding is about a DIFFERENT topic (sibling count,
//       stale comment, CSS) and merely cites `PR body ## Implementato L2` /
//       `## Non implementato L1` / `PR body:L16` as the line address. Those
//       findings belong to their own bucket (sibling-class-fix / stale-comment),
//       reached via the fingerprint net or another taxonomy entry — not
//       pr-body-contract (#2409/#2408 examples; corpus #140: `PR body:Ln`).
//   (d) PRESCRIPTION REFERENCE — the reviewer prescribes what to ADD to
//       ## Non implementato / ## Implementato as a remediation suggestion ("dichiara
//       nel ## Non implementato il revert-risk", "listare in Non implementato il
//       provider"). The section itself is not flagged as broken; the vocabulary
//       appears only as the write-target of a suggested fix. Counting these inflates
//       the bucket with non-violations (#2836/#2840 examples: code findings that
//       mention ## Non implementato only as a remediation slot).
//   (e) ❓-ONLY adversarial questions that mention the vocabulary ("❓ q: non è
//       verificato che ## Non implementato resti vero dopo il rebase") are due
//       diligence, not a confirmed defect. tallyFindings already skips ❓ via
//       COUNTABLE_SEVERITIES; the classifier repeats the rule so a direct call
//       cannot reintroduce them.
// Crucially the deterministic gate `pr-body-contract.yml` ALREADY enforces section
// PRESENCE (`hasImpl`/`hasNon`, multi-issue `Closes`) and the next-step check
// already accepts `per scelta` / `by construction` as motivated decisions — the
// structural fix for missing-section / no-plan violations already shipped. The
// 2026-09-17 reopen (corpus #140, 14/14d, #1536/#1535/#1534/#1521/#1520) was the
// keep=true default counting `PR body:Ln` lines about those accepted states.
// Only count (a). Pure → unit-tested.
//
// Same false-positive class as the `❓`/per-line dedup fixes in tallyFindings and
// the `already-fixed` avoidability classifier: don't escalate non-defects.
// Explicit "the section/Closes is broken" language → a real violation. Negation-
// aware on the affirmation side (below): "non rispettato" / "non è valido" must
// NOT read as "ok".
const PR_BODY_CONTRACT_VIOLATION_RE =
  /\b(manca\w*|mancant\w*|assent\w*|vuot\w*|incomplet\w*|placeholder|tbd|stub|multi-?issue)\b|sezion\w*\s+obbligator\w*\s+(manca|assent)|non\s+(è\s+|e\s+)?(corrisponde|rispettat\w*|accurat\w*|coerent\w*|corrett\w*|valid[oaie]?)|senza testo|n\/a|claim.*(?:non.*(diff|reale)|\bfalso\b|errat\w*|sbagliato\w*)|rivendicat\w*.*non\s+esiste|una riga sola|dichiar\w*.{0,160}\b(?:ma|but)\b.{0,120}\b(?:diff|bundle|modific|non lo mostra)/i;
// Positive contract-state words. Only an AFFIRMATION when NOT negated by a
// preceding "non " (so "non rispettato" / "non accurato" / "non è valido" are
// not swallowed here: those hit VIOLATION_RE first).
const PR_BODY_CONTRACT_AFFIRM_RE =
  /(?<!non\s)\b(ok|presenti|presente|sensate?|accurat\w*|coerent\w*|corrett\w*|completo|in regola|rispettat\w*|valid[oaie]?)\b|nessun\w*\s+(problema|drift|violazione|scope drift)/i;
// Location-label tell: the finding cites `## Implementato`/`## Non implementato`
// (optionally prefixed "PR body", optionally with an L<n> line ref) only as the
// ADDRESS of a finding about another topic. Tolerant of arrows/quotes between
// "PR body" and the section, of the section being quoted, and of the reviewer
// form `PR body:L16:` measured on corpus #1536/#1535/#1534/#1521/#1520.
const PR_BODY_CONTRACT_LOCATION_RE =
  /pr body\b[^a-z]*#{0,3}\s*"?\s*(non\s+)?implementato\b|#{2,3}\s*(non\s+)?implementato\s+l?\d|"\s*#{2,3}\s*(non\s+)?implementato\s*"\s*l?\d|pr body\s*:\s*l\d+/i;
// Prescription-reference tell: an imperative/infinitive suggestion verb followed
// (within the same sentence) by "in"/"nel" and then the section name. The
// reviewer is telling the author WHERE to write something, not flagging the
// section as broken. Bounded by sentence boundary ([^.]{0,150}) to prevent
// runaway cross-sentence matches. Case (a) still wins: if the explicit violation
// RE fires (e.g. "claim falso") the prescription filter is never reached.
const PR_BODY_CONTRACT_PRESCRIPTION_RE =
  /\b(?:aggiungi|inserisci|inserir[ei]|dichiara(?:re)?|elenc[ao](?:re)?|list[ao](?:re)?|menziona(?:re)?|nota(?:re)?|documenta(?:re)?|scrivi|scrivere|aggiorna(?:re)?|specifica(?:re)?|includi|includere)\b[^.]{0,150}\b(?:in|nel(?:la)?)\b[^.]{0,80}\b(?:non\s+)?implementato\b/i;
export function isGenuinePrBodyContractViolation(text) {
  const s = String(text || '');
  // (e) ❓-only adversarial questions that mention the vocabulary are due
  //     diligence, not a confirmed defect. A confirmed 🔴/🟡 on the same line
  //     still proceeds to (a)–(d).
  if (s.includes('❓') && !s.includes('🔴') && !s.includes('🟡')) return false;
  // (a) explicit violation language wins — a real missing/empty/mismatched section,
  //     a multi-issue Closes, or a false/unverified claim in ## Implementato.
  if (PR_BODY_CONTRACT_VIOLATION_RE.test(s)) return true;
  // (b) the line AFFIRMS the contract is fine (un-negated positive) → not a defect.
  if (PR_BODY_CONTRACT_AFFIRM_RE.test(s)) return false;
  // (c) section name used only as a `PR body ## X (L<n>)` / `PR body:Ln` location
  //     label for a finding about a different topic → not a contract defect.
  if (PR_BODY_CONTRACT_LOCATION_RE.test(s)) return false;
  // (d) the reviewer prescribes what to ADD to ## Non implementato / ## Implementato
  //     as a remediation suggestion — the section itself is not broken, the
  //     vocabulary appears only as the write-target. (#2836/#2840 pattern)
  if (PR_BODY_CONTRACT_PRESCRIPTION_RE.test(s)) return false;
  // Default: vocabulary without explicit missing/empty/false-claim language is
  // (b)/(c)/(d)/(e) residue — NOT a genuine violation. keep=true was the
  // recurrence (corpus #140: 14/14d, #1536/#1535/#1534/#1521/#1520).
  return false;
}

// ---- `sibling-class-fix` false-positive guard (DETERMINISTIC) ---------------
// Same false-positive class as `isGenuinePrBodyContractViolation` above, applied
// to the OTHER process-failure-mode bucket the reviewer regex matches loosely on
// sweep vocabulary (`sibling`, `file gemello`, `stesso anti-pattern`, `non
// toccat[o]`, …). Unlike pr-body-contract (structural gate already blocks missing
// sections), `check-sibling-patterns.mjs` is a candidate-SURFACER with no
// enforcement — but the reviewer regex still can't tell these senses apart:
//   (a) GENUINE violation — a sibling file left un-swept still carries the SAME
//       antipattern the PR just fixed elsewhere (e.g. #3317: `.slice(0, 20)`
//       cap-trim fixed in one crawler, "resta intatto" in 7 siblings). This is
//       the escalation target. A divergent-but-deferred nit ("diverges from the
//       sibling's pattern — deferred, non funnel-critical", #3312) is STILL a
//       real finding here — AGENTS.md #8 abolished deferral-as-closure, so only
//       (b)/(c) below are excluded, never a plain "deferred".
//   (b) AFFIRMATION — the reviewer confirms the sibling sweep is COMPLETE / no
//       residual finding ("nessun sibling residuo", "no inconsistency", "coerente
//       col sibling", "correctly mirrors the sibling"). NOT a defect. Includes the
//       same emoji-as-word trap that inflated pr-body-contract (#2397/#2396): a
//       line like "nessun 🔴/🟡 da propagare" (#3319) contains the literal glyphs
//       `detectSeverity` substring-matches on, even though the sentence explicitly
//       says there is NOTHING to report.
//   (c) DECLARED FALSE POSITIVE — the reviewer explicitly invokes AGENTS.md #6's
//       own escape hatch: the construct is "solo lessicalmente simile ma
//       semanticamente diverso" / an explicit "falso positivo" — not the same bug
//       class, just a shared token.
// Issue #3325 (escalation ×6 in 14gg: #3319/#3317/#3312/#3267/#3265) — the bucket
// had no filter at all, unlike its pr-body-contract sibling shipped in #3332.
// Pure → unit-tested, mirrors isGenuinePrBodyContractViolation's structure.
const SIBLING_CLASS_AFFIRM_RE =
  /nessun\w*\s*(?:[\u{1F534}\u{1F7E1}]\s*\/?\s*)*(?:da propagare|altro finding|bug replicat\w*|antipattern replicat\w*)|nessun\s+sibling\s+resid\w*|no inconsistenc\w*|not a candidate for|correctly mirrors? the sibling|coerente\s+(?:col|con il)\s+sibling|match(?:es)?\s+the sibling'?s?\s+(?:proven\s+)?(?:pattern|guard)/iu;
// A bare `sibling` is not evidence of an AGENTS.md #6 violation. Reviewer
// findings also use it for semantic neighbours (`same-level sibling` in a DOM
// parser), for scope prose (`consumer sibling`), or for a checker feature that
// is merely being described. Those lines must not inflate this process bucket.
// Keep the positive side explicit: a class finding needs an actionable relation
// between the sibling and the repeated construct/sweep. Ambiguous lines fall
// through to the fingerprint safety net in `bucketFinding`, so this guard does
// not discard the reviewer finding; it only refuses to call it a sibling-class
// recurrence without evidence.
// A semantic neighbour that is merely non-first or changes route (for example
// an event slug collision) is still countable through the fingerprint safety
// net, but is not evidence of an unswept cross-file class.
const SIBLING_CLASS_EVIDENCE_RE =
  /(?:\b(?:stesso|same)\s+(?:anti-?pattern|costrutto|construct|pattern|bug|guard|logic|class)\b|\b(?:file|script|workflow|consumer|ramo|branch)\s+gemell\w*\b|\b(?:sibling|gemell\w*)\b[^.\n]{0,120}\b(?:non|not|never|mai|still|resta|lasciat\w*|left|remain\w*|unchanged|untouched|unfixed|unaddressed|omess\w*|manc\w*|sweep\w*|check\w*|guard\w*|pattern\w*|bug\w*|fix\w*|modif\w*|address\w*|propagat\w*)\b|\b(?:still|resta|lasciat\w*|left|remain\w*|unchanged|untouched|unfixed|unaddressed|diverg\w*|different|unlike)\b[^.\n]{0,120}\b(?:sibling|gemell\w*)\b)/iu;

export function isGenuineSiblingToolingFinding(text) {
  const s = stripFindingLocationLabel(text).replace(/`[^`]*`/g, ' ');
  if (FALSE_POSITIVE_DECLARATION_RE.test(s)) return false;
  if (SIBLING_CLASS_AFFIRM_RE.test(s)) return false;
  // Se il reviewer dice esplicitamente che un gemello porta ancora lo stesso
  // costrutto, il path del checker e' il soggetto del gemello, non del tool.
  if (/\b(?:stesso|same)\s+(?:anti-?pattern|costrutto|construct|pattern|bug|guard|logic|class)\b/i.test(s)) return false;
  return SIBLING_TOOLING_RE.test(s);
}

// Negation-aware false-positive-declaration matcher, shared with
// sibling-check-gate.mjs's isDeclaredFalsePositive (issue #3367 — the two
// copies drifted when kept in sync by docstring promise only).
export function isGenuineSiblingClassViolation(text) {
  const s = stripFindingLocationLabel(text).replace(/`[^`]*`/g, ' ');
  // (c) explicit false-positive declaration wins first — a reviewer can declare
  //     lexical-vs-semantic mismatch even inside an otherwise alarming sentence.
  if (FALSE_POSITIVE_DECLARATION_RE.test(s)) return false;
  // (b) the line AFFIRMS the sweep is complete / nothing to propagate → not a
  //     defect, even if it contains 🔴/🟡 glyphs as prose rather than a marker.
  if (SIBLING_CLASS_AFFIRM_RE.test(s)) return false;
  // A finding about the checker/gate itself belongs to the topic bucket below;
  // it is not evidence that a sibling implementation was left unswept.
  if (isGenuineSiblingToolingFinding(text)) return false;
  // A class relation is required before this process bucket can claim the line.
  // Scope-only and semantic-neighbour mentions remain available to the generic
  // fingerprint path instead of being mistaken for an unswept sibling.
  return SIBLING_CLASS_EVIDENCE_RE.test(s);
}

export function isGenuineUnvalidatedClaimFinding(text) {
  return UNVALIDATED_CLAIM_RE.test(stripFindingLocationLabel(text));
}

// ---- NEGATED-IMPACT recap clauses (DETERMINISTIC, cross-bucket) ------------
// REVIEW.md fa della «correttezza della superficie pubblicata» la priorita' 1 e
// chiede di promuovere a 🔴 qualunque ❓ che, se vero, impatterebbe `dist/api/`,
// gli slug, le sitemap o i feed. La conseguenza e' che quasi ogni review chiude
// il proprio verdetto con una frase di RICOGNIZIONE NEGATA — «nessun impatto su
// `dist/api/`, sulle sitemap o sui feed», «nessuno tocca gli slug, le sitemap, i
// canonical» — che dice l'esatto contrario di un difetto: la superficie NON e'
// toccata.
//
// Quella frase vive sulla stessa riga del verdetto, che porta il glifo di
// severita', quindi `detectSeverity` la conta come finding confermato e la
// taxonomy la butta nel bucket il cui vocabolario compare nell'ELENCO DELLE COSE
// NON TOCCATE. Su questo repo l'elenco nomina sempre sitemap/canonical, quindi il
// bucket `canonical-sitemap` si gonfia a ogni PR pulita e ri-escala per sempre:
// issue #901, 10 hit su 14gg di cui 4 dei 5 esempi (#896, #882, #881, #879) sono
// esattamente questa ricognizione — solo #878 era un difetto vero (`/de/blog/null`
// nel canonical e nella sitemap).
//
// Stessa classe di falso positivo gia' chiusa altrove, ogni volta su un bucket
// solo: `auto-ads` a livello di regex (#2114, «non SEO/AdSense»), `i18n-naming`
// restringendo la regex (#2122), `pr-body-contract` (#3332) e `sibling-class-fix`
// (#3325) con un guard di affermazione, `NEGATED_SEVERITY_RE` a livello di
// severita' (#4342). Qui il rimedio e' UNO e vale per TUTTI i bucket topic: la
// clausola negata viene tolta dal testo PRIMA di scegliere il bucket, quindi il
// vocabolario che compare solo li' dentro non fa piu' punteggio.
//
// Deliberatamente stretto sui verbi. Solo verbi di IMPATTO/PORTATA (impattare,
// toccare, raggiungere, coinvolgere, ricadere) piu' i loro equivalenti inglesi:
// sono quelli della ricognizione. Verbi di COMPORTAMENTO («non aggiorna la
// sitemap», «non emette il canonical») restano fuori, perche' li' la negazione E'
// il difetto. La clausola si chiude al primo confine di frase (`.`/`;`/`—`/a
// capo), cosi' non mangia il resto della riga.
const IMPACT_VERB = String.raw`impatt\w*|impact\b|ricadut\w*|tocca\w*|touch\w*|raggiung\w*|reach\w*|coinvolg\w*|affect\w*`;
// Il corpo di una clausola si chiude al primo confine di frase, ma un punto e'
// confine SOLO se seguito da spazio o da fine riga: dentro un code span
// (`articles.json`, `create-article.mjs`, `publish-api.yml`) non lo e'. Senza
// questa distinzione la ricognizione negata resta mezza in piedi appena nomina un
// file, cioe' nel caso DOMINANTE su questo repo, dove l'elenco delle cose non
// toccate e' fatto di nomi di file: «nessun impatto su `articles.json`, sulle
// sitemap o sui feed» si troncava a «nessun impatto su `articles» e lasciava
// scansionabile «.json`, sulle sitemap o sui feed» — bucket `canonical-sitemap`.
const SPACED_HYPHEN = String.raw`[ \t]-[ \t]`;
const CLAUSE_BODY = String.raw`(?:(?!${SPACED_HYPHEN})[^.;—–\n]|\.(?!\s|$))`;
// Una virgola puo' anche essere il punto in cui la ricognizione negata lascia
// posto a una proposizione affermativa («nessun impatto su X, il fix tocca Y»).
// Se dopo la virgola compare un verbo di impatto entro poche parole, chiudi qui
// la forma A: altrimenti il suo corpo greedy mangia proprio il verbo che la forma
// B deve usare come ancora nel replace successivo. Le liste negate restano
// invariate: una virgola seguita da nomi/coordinate senza un verbo di impatto
// continua a far parte del corpo della ricognizione.
const NEGATED_CLAUSE_BODY = String.raw`(?:(?!,\s+(?:\S+\s+){0,3}(?:${IMPACT_VERB})\b)${CLAUSE_BODY})`;
// (C) La negazione E' il difetto quando la riga afferma uno SWEEP incompleto: «lo
//     stesso anti-pattern in `cf-purge-cache.mjs` non e' toccato». E' la
//     formulazione che REVIEW.md prescrive per un finding di classe, ed e' anche
//     il tell `non toccat` della TAXONOMY `sibling-class-fix`, che collide per
//     costruzione con `tocca\w*` di IMPACT_VERB (che copre gia' toccano/toccata/
//     toccare: le alternative esplicite erano rami morti). Su una riga cosi' lo strip non
//     deve girare, altrimenti il bucket process piu' canonico perde la sua entrata
//     piu' tipica: misurato sulle ultime 114 PR mergiate, 6 righe su 50 con
//     «negazione + participio» sono findings di sweep veri (#880 e #822 su tutte).
//     I tell sono quelli della TAXONOMY meno la negazione, cosi' le due
//     definizioni di «riga di sweep» non possono divergere.
const SWEEP_ASSERTION_RE = /stesso anti-?pattern|file gemello|stesso costrutto|sibling|class-complete|ramo (?:equivalente|gemello)/iu;
// (A) negazione PRIMA del verbo: «nessun impatto su …», «nulla tocca …»,
//     «nessun articolo nuovo raggiunge …», «no impact on …».
const NEGATED_IMPACT_CLAUSE_RE =
  new RegExp(String.raw`\b(?:nessun\w*|nulla|niente|zero|senza|non|not|no)\b(?:\s+\S+){0,3}?\s+(?:${IMPACT_VERB})${NEGATED_CLAUSE_BODY}*`, 'giu');
// (B) negazione DOPO il verbo, in forma contrastiva: «il ramo tocca l'automazione
//     delle issue di CI, non `dist/api/`, le sitemap, i feed o gli slug». Qui il
//     vocabolario del bucket sta nella coda negata, quindi si toglie SOLO quella
//     (il gruppo catturato conserva cio' che precede la virgola, senza un lookbehind
//     a lunghezza fissa). Se nella stessa clausola compaiono piu' verbi di impatto,
//     il corpo temperato forza il match sull'ULTIMO: un verbo piu' a sinistra non puo'
//     mangiare il prefisso legittimo del finding. La virgola e la contrastivita' sono
//     obbligatorie: sono cio' che distingue questa coda da un «non» qualsiasi piu'
//     avanti nella frase.
const CONTRASTIVE_NEGATED_TAIL_RE =
  new RegExp(String.raw`(\b(?:${IMPACT_VERB})\b(?:(?!\b(?:${IMPACT_VERB})\b)${CLAUSE_BODY})*?),\s*(?:e\s+|ma\s+)?(?:non|not)\b${CLAUSE_BODY}*`, 'giu');
// Confine di frase, nella STESSA accezione di `CLAUSE_BODY`: `;`, `—`, `–`, un
// trattino ASCII spaziato, a capo, e
// il punto solo se seguito da spazio o fine riga (dentro un code span non lo e').
// Tenerne una definizione sola e' cio' che impedisce al guard di sweep e allo
// strip di disaccordarsi su dove finisce una frase.
const SENTENCE_BOUNDARY_RE = new RegExp(String.raw`[;—–\n]|${SPACED_HYPHEN}|\.(?=\s|$)`, 'gu');
// La frase che contiene lo span `[start, end)`: dal confine precedente al primo
// confine successivo. I confini interni allo span non esistono per costruzione
// (`CLAUSE_BODY` li esclude), ma vengono comunque saltati invece di troncare.
function sentenceAround(text, start, end) {
  let from = 0;
  SENTENCE_BOUNDARY_RE.lastIndex = 0;
  for (let m = SENTENCE_BOUNDARY_RE.exec(text); m; m = SENTENCE_BOUNDARY_RE.exec(text)) {
    if (m.index < start) from = m.index + m[0].length;
    else if (m.index >= end) return text.slice(from, m.index);
  }
  return text.slice(from);
}

export function stripNegatedImpactClauses(text) {
  const s = String(text ?? '');
  // Preserve sweep assertions only in their own sentence. The contrastive
  // regex captures the legitimate prefix, which must survive the stripping.
  const stripUnlessSweep = (match, offset, whole) =>
    SWEEP_ASSERTION_RE.test(sentenceAround(whole, offset, offset + match.length)) ? match : ' ';
  return s
    .replace(NEGATED_IMPACT_CLAUSE_RE, stripUnlessSweep)
    .replace(CONTRASTIVE_NEGATED_TAIL_RE, (match, prefix, offset, whole) =>
      SWEEP_ASSERTION_RE.test(sentenceAround(whole, offset, offset + match.length)) ? match : prefix + ' ');
}

// ---- `canonical-sitemap` false-positive guard -----------------------------
// The topic regex is intentionally broad enough to catch every SEO surface,
// but `canonical` is also a common application-domain adjective: canonical
// vacancy links, canonical replacements, archive canonicalizers, and canonical
// route URLs are not sitemap/canonical SEO findings. Once the negated-impact
// recap is stripped, require an explicit SEO defect/surface signal before
// assigning the topic bucket. Unmatched lines still reach fingerprintFinding()
// below, so narrowing this bucket cannot silently discard a real recurrence.
const NON_SEO_CANONICAL_MENTION_RE =
  /\bcanonical(?:izer)?\b\s+(?:vacancy|job|listing|replacement|record|row|entry|entries|id|key|data(?:set)?|fallback|route|routes|slug|component|hub|duty|history|source|snapshot|payload|stats?|archive|document)\b/i;

const CANONICAL_SEO_DEFECT_RE =
  /\b(?:canonical[- ](?:missing|mismatch|drift)|self[- ]canonical|non[- ]canonical|rel\s*=\s*["']?canonical\b|canonical\s+(?:href|tag|markup|link)\b|(?:empty|missing|invalid|wrong|incorrect|broken|drift|mismatch|unset|unresolved|manca\w*|mancante|non\s+(?:emette|emesso|aggiorna|aggiornato|punta|include)|does\s+not\s+(?:emit|set|include|point)|fails?\s+to\s+(?:emit|set|include|point))[^.\n]{0,70}\bcanonical(?:s)?\b|\bcanonical(?:s)?\b[^.\n]{0,70}\b(?:mismatch|drift|missing|invalid|wrong|incorrect|broken|unresolved|consolidat\w*|redirect\w*|self[- ]canonical)\b|(?:tocca|touch(?:es)?|affect(?:s)?|impatt\w*)[^.\n]{0,45}\bcanonical(?:s)?\b)/i;

const SITEMAP_SEO_DEFECT_RE =
  /\b(?:sitemaps?|noindex)\b[^.\n]{0,100}\b(?:missing|empty|unsupported|stale|wrong|incorrect|broken|not|doesn['’]?t|does\s+not|fails?|omits?|drop(?:s|ped)?|update(?:s|d)?|aggiorna\w*|publish(?:es|ed)?|pubblic\w*|republish(?:es|ed)?|ripubblic\w*|emit(?:s|ted)?|emett\w*|noindex|non[- ]canonical|canonical|loc|inventory|coverage|redirect\w*|unreachable|include(?:s|d)?|listed)\b|\b(?:missing|empty|unsupported|stale|wrong|incorrect|broken|not|doesn['’]?t|does\s+not|fails?|omits?|drop(?:s|ped)?|update(?:s|d)?|aggiorna\w*|publish(?:es|ed)?|pubblic\w*|republish(?:es|ed)?|ripubblic\w*|emit(?:s|ted)?|emett\w*|noindex|non[- ]canonical|canonical|loc|inventory|coverage|redirect\w*|unreachable|include(?:s|d)?|listed)[^.\n]{0,100}\b(?:sitemaps?|noindex)\b/i;

// These words can describe a correct sitemap just as easily as a broken one.
// They only count as a finding when the same sentence also states an explicit
// defect; otherwise a positive line like "sitemap includes every URL" must
// remain in the fingerprint safety net instead of inflating this topic bucket.
const SITEMAP_NEUTRAL_ACTIVITY_RE =
  /\b(?:coverage|include(?:s|d)?|listed|update(?:s|d)?|aggiorna\w*|publish(?:es|ed)?|pubblic\w*|republish(?:es|ed)?|ripubblic\w*|emit(?:s|ted)?|emett\w*)\b/i;
// `coverage` alone is neutral, but a report that claims sitemap-only coverage
// while a discovered frontier was never crawled states an explicit defect.
const SITEMAP_EXPLICIT_DEFECT_RE =
  /\b(?:sitemaps?|noindex)\b[^.\n]{0,100}\b(?:missing|empty|unsupported|stale|wrong|incorrect|broken|not|non|doesn['’]?t|does\s+not|fails?|omits?|drop(?:s|ped)?|noindex|non[- ]canonical|unreachable|leak\w*|never\s+crawled|not\s+crawled|mai\s+crawled)\b|\b(?:missing|empty|unsupported|stale|wrong|incorrect|broken|not|non|doesn['’]?t|does\s+not|fails?|omits?|drop(?:s|ped)?|noindex|non[- ]canonical|unreachable|leak\w*|never\s+crawled|not\s+crawled|mai\s+crawled)[^.\n]{0,100}\b(?:sitemaps?|noindex)\b/i;

export function isGenuineCanonicalSitemapFinding(text) {
  const s = String(text || '');
  if (!s) return false;
  if (/\bsitemaps?\b/i.test(s) && SITEMAP_NEUTRAL_ACTIVITY_RE.test(s) && !SITEMAP_EXPLICIT_DEFECT_RE.test(s)) return false;
  // noindex is an SEO indexing directive by definition; the negated-impact
  // strip has already removed the "not touched" recap when this is called from
  // bucketFinding().
  if (/\bnoindex\b/i.test(s)) return true;
  if (/\bsitemaps?\b/i.test(s)) return SITEMAP_SEO_DEFECT_RE.test(s);
  if (/\bcross-section\b/i.test(s)) {
    return /\b(?:canonical|indexable|hreflang|robots?|google|seo)\b/i.test(s) &&
      /\b(?:mismatch|drift|missing|wrong|incorrect|broken|non[- ]canonical|self[- ]canonical|not|fails?|cross-section)\b/i.test(s);
  }
  if (NON_SEO_CANONICAL_MENTION_RE.test(s)) return false;
  return CANONICAL_SEO_DEFECT_RE.test(s);
}

// Crawler-side code: the per-source crawlers and the parsers/feeds/ATS clients
// they share. Anchored on the repo-relative path, so a site emitter (the jobs
// SEO pages build plugin, the SEO service modules) never matches. Emitter
// paths are named in words on purpose: checkout-profile-analyzer.mjs reads
// this file as text, and a quoted `services/<dir>` alias here would add the
// articles bucket to the lessons-harvester.yml sparse profile.
const CRAWLER_PARSER_PATH_RE = /^scripts\/(?:update-[\w-]+-jobs\.mjs|lib\/(?:ats-clients\/[\w./-]+|[\w-]*(?:parser|crawler|feed)[\w-]*\.mjs|federal-job-[\w-]+\.mjs))$/;
const LOCATED_PATH_RE = /(?:^|[\s`(,;'"])((?:[\w.-]+\/)+[\w.-]+\.(?:mjs|cjs|js|tsx?|json|ya?ml))(?=[:\s`),;'"]|$)/g;

/**
 * The repo paths a review line is LOCATED at: the ones before its severity
 * marker (`path:Lnn[, path:Lnn…]: 🔴 Important: …`). Paths named in the
 * finding's prose are not its location.
 * @param {string} text
 * @returns {string[]}
 */
export function findingLocationPaths(text) {
  const s = String(text || '');
  const severity = /🔴|🟡|❓/u.exec(s);
  const lead = severity ? s.slice(0, severity.index) : '';
  return [...lead.matchAll(LOCATED_PATH_RE)].map((m) => m[1]);
}

/** True when every located path of the finding is crawler parser code. */
export function isCrawlerParserFinding(text) {
  const paths = findingLocationPaths(text);
  return paths.length > 0 && paths.every((p) => CRAWLER_PARSER_PATH_RE.test(p));
}

/**
 * Removes only the leading review location (`path:L<n>:` or `PR body:L<n>:`).
 * The location is an address, not reviewer prose, so process-bucket guards can
 * ignore it. Topic buckets and the fingerprint keep the original text.
 * @param {unknown} text
 * @returns {string}
 */
export function stripFindingLocationLabel(text) {
  const s = String(text || '');
  const marker = /[🔴🟡❓]/u.exec(s);
  if (!marker || marker.index === 0) return s;
  const prefix = s.slice(0, marker.index).trim();
  if (/^PR body\s*:\s*L\d+\s*:\s*$/i.test(prefix) || findingLocationPaths(s).length > 0) {
    return s.slice(marker.index);
  }
  return s;
}

export function bucketFinding(text) {
  // I bucket si scelgono sul testo SENZA le ricognizioni negate: una sitemap
  // nominata solo per dire che non e' stata toccata non e' un finding su di lei.
  // Come su origin/main, anche i bucket di argomento e la rete fingerprint
  // ricevono il testo originale. Solo i guard dei bucket di processo rimuovono
  // la location label prima della loro discriminante.
  const scannable = stripNegatedImpactClauses(text);
  // Reviews sometimes name sitemap concepts only inside camelCase identifiers
  // (for example `discoverGeSitemapListDocuments` and `sitemapError`). Split
  // those boundaries for this topic so genuine sitemap failures still reach
  // its explicit-defect guard. Only identifiers that contain "sitemap" are
  // split: splitting every identifier turned `coverageOk` into a neutral
  // "coverage" activity word and dropped a real coverage finding (#10819).
  const canonicalSitemapScannable = scannable.replace(
    /\b\w*[Ss]itemap\w*\b/g,
    (id) => id.replace(/([a-z0-9])([A-Z])/g, '$1 $2'),
  );
  for (const t of TAXONOMY) {
    const candidate = t.key === 'canonical-sitemap' ? canonicalSitemapScannable : scannable;
    if (!t.re.test(candidate)) continue;
    if (t.key === 'canonical-trailing-slash' && !isMissingCanonicalTrailingSlash(scannable)) continue;
    if (t.key === 'structured-data-parser' && !isCrawlerParserFinding(text)) continue;
    // A review line starts with one or more file locations before its severity
    // marker. Do not let a path such as `unsubscribe-credential-monitor.yml`
    // provide the workflow/auth context for an unrelated finding.
    if (t.key === 'workflow-scope-creds') {
      // Separatore e grassetto facoltativi: la forma con ancora di posizione
      // (`path:L<n>: 🔴 Important testo`) non porta i due punti, e senza
      // riconoscerla la riga intera, path compresi, tornava a fare da contesto.
      const severity = /(?:🔴\s*\*{0,2}\s*Important|🟡\s*\*{0,2}\s*Nit)\s*\*{0,2}\s*[:—-]?/iu.exec(scannable);
      const finding = severity
        ? scannable.slice(severity.index + severity[0].length)
        : scannable;
      if (!WORKFLOW_SCOPE_CREDS_RE.test(finding)) continue;
    }
    // pr-body-contract: drop affirmations / location-label false positives so the
    // bucket counts only genuine contract violations (the deterministic gate
    // pr-body-contract.yml already blocks missing sections). Falls through to the
    // next matching taxonomy entry / fingerprint net so a co-mentioned real defect
    // (sibling-class-fix, stale-comment) still clusters in its own bucket.
    if (t.key === 'pr-body-contract' && !isGenuinePrBodyContractViolation(text)) continue;
    // sibling-class-fix: same treatment (issue #3325) — drop affirmations /
    // declared false positives so the bucket counts only genuine unswept-sibling
    // findings, mirroring pr-body-contract's filter above.
    if (t.key === 'sibling-tooling' && !isGenuineSiblingToolingFinding(text)) continue;
    if (t.key === 'sibling-class-fix' && !isGenuineSiblingClassViolation(text)) continue;
    if (t.key === 'unvalidated-claim' && !isGenuineUnvalidatedClaimFinding(text)) continue;
    // `canonical` is overloaded outside SEO (canonical vacancy links, archive
    // canonicalizers, canonical replacements, route URLs). Keep those lines in
    // the fingerprint safety-net instead of inflating the canonical-sitemap
    // topic with unrelated reviewer findings.
    if (t.key === 'canonical-sitemap' && !isGenuineCanonicalSitemapFinding(candidate)) continue;
    return t.key;
  }
  // La rete fingerprint riceve il testo INTERO, non quello strippato. Lo strip e'
  // un'euristica sul CONFINE della clausola negata, e su una riga in cui la
  // negazione porta su un participio o su un verbo di impatto usato in senso
  // comportamentale — «il redirect non raggiunge `/lavoro/ticino`, il canonical
  // resta rotto» — mangia anche la coda, che e' il difetto vero. Se anche il
  // safety net vedesse il testo strippato, quella riga cadrebbe attraverso
  // ENTRAMBI i livelli e sparirebbe dal tally: nessuna escalation, mai. E' la
  // direzione opposta a quella che questo modulo chiude (il falso positivo
  // GONFIA un bucket; questo lo SVUOTA in silenzio) ed e' la piu' pericolosa,
  // perche' invisibile. Passando `text` la riga perde al piu' il bucket topic,
  // ma resta contata e puo' ancora escalare.
  // Misurato su 651 righe con glifo di 172 review reali dei due repo: cambiano 6
  // righe, NESSUN bucket topic si muove (5 cambiano solo la lead-phrase del
  // fingerprint, 1 rientra nella rete da `null`), quindi il rimedio a #901 resta
  // intatto e i due controesempi smettono di sparire.
  return fingerprintFinding(text); // unbucketed → fingerprint safety net (or null)
}

// Severities that count as a CONFIRMED recurring mistake. `❓` is an
// adversarial-uncertainty note ("couldn't verify X") — the reviewer doing due
// diligence on a PR that legitimately touches the topic, NOT the agent
// repeating a documented error. Counting `❓` (and counting every matching LINE
// rather than every distinct PR) inflated TOPIC buckets with non-defects and
// mis-fired escalations: `auto-ads` reached 7 from a negation substring match
// ("non SEO/AdSense", #2114) plus the three `❓` adversarial lines of a single
// PR (#2086) — none of them a rule violation (#2124). So: count only confirmed
// severities, at most once per (PR, bucket).
const COUNTABLE_SEVERITIES = new Set(['🔴', '🟡']);
// Negated-count opener: an LGTM recap line ("Nessun 🔴; sibling-check risolto…",
// "Zero 🔴. Single-source html fix è corretto…, sibling-check risolto…") states
// there are ZERO findings of that severity, yet the raw glyph is still present
// in the text — a naive `.includes()` reads it as a CONFIRMED finding, and if
// the surrounding recap prose happens to name a bucket's vocabulary (here:
// "sibling-check"/"siblings", used routinely in a clean LGTM summary) the recap
// sentence itself gets miscounted as a genuine reviewer-finding (issue #4342:
// this exact bug inflated `sibling-class-fix` on #4279/#4276/#4259, all zero-🔴
// LGTM passes, driving a false `recurringDespiteRule` escalation — the rule was
// never broken, the harvester's own tally was). Same negation-substring class
// already fixed for `auto-ads` at the taxonomy-regex level (#2114); this closes
// it at the severity-detection level so EVERY bucket is protected, not just one.
const NEGATED_SEVERITY_RE = /\b(?:nessun\w*|zero|0)\s+(?:🔴|🟡|❓)/giu;
export function detectSeverity(line) {
  const s = String(line ?? '').replace(NEGATED_SEVERITY_RE, '');
  return s.includes('🔴') ? '🔴' : s.includes('🟡') ? '🟡' : s.includes('❓') ? '❓' : null;
}

// Pure tally: reviewer-PRs → { counts, examples } per bucket. Mirrors the
// per-issue dedup already used for fix-outcome markers below: one PR with N
// matching lines in the same bucket counts ONCE (the lesson is "N distinct PRs
// got <topic> wrong", not "N lines"). `❓`/uncountable severities are skipped.
// `bucketOf` is injectable for testing. Each example is stamped with `at`
// (the PR's `mergedAt`, when the caller provides one) so the post-fix
// re-escalation guard (`examplesSinceFix`) can filter reviewer-finding buckets
// the same way it already filters fix-outcome ones (#5516: without this stamp
// a bucket re-fires on the SAME pre-fix occurrences forever, indistinguishable
// from a rule that never worked).
/**
 * Le righe di un body di review. Un body malformato (`isMalformedReviewBody`:
 * tutto su una riga con `\n` LETTERALI, difetto del reviewer del 13-19/09
 * spento da #9781) si divide solo dopo aver riportato quei `\n` ad a-capo veri:
 * altrimenti l'intero body e' UNA riga, `detectSeverity` ci trova il primo glifo
 * di qualunque finding, e la rete fingerprint la battezza con le prime parole
 * del body (`<!-- CODEX_FALLBACK_REVIEW -->\n\n## Scope ...`). Sulla finestra
 * 14-28/09 del sito queste review generavano il cluster fantasma
 * `fp:codex-fallback-review-scope` (×18) — riproposto ogni giorno alla proposta
 * Codex e scartato ogni giorno (#10153, #10212). Un body sano non viene toccato:
 * un `\n` letterale citato in prosa resta testo.
 * @param {unknown} body
 * @returns {string[]}
 */
export function reviewBodyLines(body) {
  const raw = String(body ?? '');
  const text = isMalformedReviewBody(raw) ? raw.replace(/\\n/gu, '\n') : raw;
  return text.split('\n');
}

export function tallyFindings(prs, { bucketOf = bucketFinding } = {}) {
  const counts = {};
  const examples = {};
  for (const { number, reviews, mergedAt } of prs || []) {
    const seenBuckets = new Set(); // per-PR dedup across all its reviews
    for (const r of reviews || []) {
      // GraphQL exposes bot logins without the REST [bot] suffix.
      const reviewerLogin = String(r.author?.login || '').replace(/\[bot\]$/i, '') + '[bot]';
      if (!REVIEWER_BOT_LOGIN_RE.test(reviewerLogin)) continue;
      for (const line of reviewBodyLines(r.body)) {
        const sev = detectSeverity(line);
        if (!sev || !COUNTABLE_SEVERITIES.has(sev)) continue;
        const bucket = bucketOf(line);
        if (!bucket) continue;
        // REVIEW.md makes an explicitly disposed non-funnel Nit advisory and
        // FOLLOWUP.md drops it. It is therefore not evidence that a documented
        // stale-comment rule failed; counting it here made that bucket recur
        // forever even when every example was marked `deferred, non funnel-critical`.
        // Keep other process buckets (for example pr-body-contract) unchanged:
        // their deterministic contracts still make a recurring Nit actionable.
        // Keep 🔴 fail-closed: a red finding cannot self-dispose this way.
        if (bucket === 'stale-comment' && sev === '🟡' && isExplicitNonFunnelDisposition(line)) continue;
        if (seenBuckets.has(bucket)) continue;
        seenBuckets.add(bucket);
        counts[bucket] = (counts[bucket] || 0) + 1;
        (examples[bucket] ||= []).push({ pr: number, severity: sev, snippet: line.trim().slice(0, 160), at: mergedAt });
      }
    }
  }
  return { counts, examples };
}

// ---- `already-fixed` avoidability classifier (DETERMINISTIC) ----
// A `fix-outcome:already-fixed` marker is recurring-BURN signal worth escalating
// ONLY when the zero-Claude pre-flight gate (check-issue-already-resolved.mjs)
// COULD plausibly have caught it but didn't → a real gate gap. For two whole
// classes of issue the gate, by its own deliberately-conservative design, NEVER
// short-circuits — so a genuine Claude run discovering "already-fixed" is the
// EXPECTED minimal-cost confirmation path, NOT a rule violation, and counting it
// re-fires escalation #2290 perpetually with no actionable fix (you cannot make
// the gate aggressive enough without dropping real bugs — explicitly forbidden by
// the gate's bias-to-PROCEED invariant). Those two classes:
//   1. AGGREGATE follow-ups ("N item deferred", N≥2, or sweep/batch/bulk): the gate
//      refuses to short-circuit them (one item resolved ≠ all). Their title carries
//      the count verbatim (post-merge-followup.yml batches them, AGENTS.md #925), so
//      this is detectable from the title alone — no extra body fetch.
//   2. NON-follow-up issues (crawler-health, validation-failure, free-form): the
//      gate's scope is `follow-up`-labelled only; everything else is always let
//      through. A crawler-health `stale` that auto-resolves transiently (#2147) can
//      never be pre-empted by a content-token matcher.
// Same feedback-loop class as the reconcile-bot / pre-flight-deterministic skips in
// the outcome loop below: don't count burn that no safe gate could have prevented.
// A single-item follow-up is countable when the deterministic pre-flight has
// actionable evidence: either the explicit `Suggested action` + distinctive
// code-token contract, or a body keyword that the pre-flight still recognizes
// (the analytics classifier intentionally excludes that body-only fallback).
// Path-only or body-less follow-ups still need the Claude verification path, so
// counting them here would recreate the false escalation loop tracked by #9109.
// Pure → unit-tested. `labels` is an array of label names.
export function isAvoidableAlreadyFixed(title, labels, body = '') {
  const names = Array.isArray(labels) ? labels : [];
  if (!names.includes('follow-up')) return false; // out of the gate's scope
  // Keep analytics aligned with the pre-flight aggregate grammar while preserving
  // its title-only keyword contract. A daily bucket is aggregate even with one
  // current item; it is processed item by item and must not be counted as burn.
  if (isAggregateForAnalytics(title, body)) return false;
  // Keep this classifier aligned with deterministic pre-flight evidence. The
  // body-keyword fallback is intentionally retained here because pre-flight
  // recognizes it even though analytics does not (G5 contract).
  if (ACCEPTANCE_CONDITION.holds(body) || isAggregate(title, body)) return true;
  return false; // no actionable evidence → Claude verification is expected
}

// ---- `max-turns` avoidability classifier (DETERMINISTIC) --------------------
// A `fix-outcome:max-turns` marker (issue-fix.yml granular telemetry: a fixer run
// that died `error_max_turns`) is recurring-BURN worth escalating ONLY when the
// run hit the cap on a task the automation COULD have completed in budget — i.e. a
// genuinely-fixable loop. Two whole classes hit the cap DETERMINISTICALLY by their
// own structure, and for them the structural fix ALREADY shipped (followup-drainer
// pre-flight #2291 + the per-item circuit-breaker in issue-fix.yml). Re-tentando
// li riproduce; raising max-turns is explicitly forbidden (AGENTS.md, reverts
// #795/#802). Counting them re-fires escalation #2439 with no actionable fix left:
//   1. AGGREGATE follow-ups ("N item deferred", N≥2, or sweep/batch/bulk): doing
//      ALL items in one run blows the budget by construction (#2332 = 5 items). The
//      circuit-breaker already caps the run at ONE item; a death here is the
//      multi-item attempt the breaker is meant to stop, not a fixable loop.
//   2. Issues the drainer has ALREADY PARKED `automation-deferred` (malformed body / network
//      -audit / repeated-death too-large): the deterministic pre-flight detected the
//      structural non-fixability and stopped re-queueing. The lingering marker is the
//      run that triggered the park, expected — not preventable burn.
// Single-item, still-routable follow-ups that die at the cap (no `automation-deferred`) are
// the genuine signal — a fixable loop the budget should have covered → countable.
// Same feedback-loop class as isAvoidableAlreadyFixed. Pure → unit-tested.
// `labels` is an array of label-name strings.
//   3. The run ALREADY SHIPPED A PR (`hasDeliveredPr`, i.e. the issue carries a
//      `<!-- FIX_OUTCOME: pr-created -->` marker): the cap was hit on harmless
//      POST-delivery churn (telemetry comment, sibling-sweep verify, a second
//      item). The workflow's own `Classify outcome` step already treats this as
//      job-SUCCESS ("false-failure: lavoro consegnato"). Counting it as burn was
//      the false positive driving escalation #2653 (3/5 examples — #2590/#2560/
//      #2476 — opened a MERGED PR then overran). By-construction: a run that
//      delivered a PR can never inflate the bucket, mirroring the workflow.
//   4. The run left RECOVERABLE WORK on its branch (`hasRecoverableBranch`): commits on
//      `fix/issue-<N>` ahead of `main`, from the anti-100%-loss WIP checkpoint issue-fix.yml
//      pushes as soon as the edit is applied (#4337, step 4 of the fixer prompt). Until
//      2026-08-13 the ONLY proof of delivery this classifier accepted was a `pr-created`
//      marker, so a cap hit AFTER the checkpoint but BEFORE the PR read as "produced
//      nothing" and was counted as preventable burn. Measured on the corpus over 31
//      `max-turns` deaths: delivered=0, recoverable=11, empty=20 — eleven branches
//      carrying a real diff, classified as noise. Two of them were recovered by hand and
//      merged (site #5767 → PR #5774, corpus #166 → PR #293), which is the whole argument:
//      work you can merge is not a fixable-loop signal, it is a delivery that stopped one
//      step short. The actionable follow-up is to OPEN THAT PR (the drainer's resume-aware
//      retry does), not to write another doc rule — so it must not drive an escalation.
//      `hasDeliveredPr` and `hasRecoverableBranch` therefore point the same way here even
//      though they are opposite evidence: partial delivery and full delivery are both
//      delivery.
/**
 * @param {string} title
 * @param {string[]} labels
 * @param {boolean | { hasDeliveredPr?: boolean, hasRecoverableBranch?: boolean }} [delivery]
 *   Legacy boolean (`hasDeliveredPr`) or the two delivery evidences together.
 * @returns {boolean} true when the cap-death is preventable burn worth escalating.
 */
/**
 * Marker del commento che annota un `max-turns` con lavoro recuperabile.
 *
 * Stessa stringa usata da `orphan-max-turns-work.mjs` sul corpus, ed è
 * deliberato: le due metà rilevano lo stesso fatto con codice diverso — là uno
 * script dedicato, qui `recoverableWorkOnBranch`, che questo file ha già — e un
 * marker comune le rende leggibili insieme senza duplicare un rilevatore
 * (AGENTS.md #6: la logica sta in un posto, e qui c'era già).
 */
export const ORPHAN_NOTE_MARKER = '<!-- orphan-max-turns-work -->';

/** Vero se la issue porta già l'annotazione. Pura → il dedup è testabile. */
export function hasOrphanNote(comments) {
  return (comments || []).some((c) => String(c?.body || '').includes(ORPHAN_NOTE_MARKER));
}

/**
 * Il testo dell'annotazione. Pura, così il contratto (marker incluso) è verificabile
 * senza rete.
 * @param {{issue: number, branch: string, aheadBy: number}} r
 */
export function orphanNoteBody(r) {
  return `♻️ **Lavoro orfano rilevato (auto, zero-Claude)**: la run del fixer è morta `
    + `\`max-turns\` ma aveva già pushato \`${r.branch}\` — **${r.aheadBy}** commit avanti a `
    + `\`main\`, senza nessuna PR. Nessuno strato del ciclo lo raccoglie: `
    + `\`stale-pr-rescuer\`, \`recycle-stale-prs\` e \`pr-autorebase\` raccolgono PR, e questo `
    + `branch non ne ha mai avuta una. Prima di ri-tentare da zero, verifica se il commit è `
    + `recuperabile — la resume-logic del fixer riparte da qui.\n\n${ORPHAN_NOTE_MARKER}`;
}

export function isAvoidableMaxTurns(title, labels, delivery = false, body = '') {
  const names = Array.isArray(labels) ? labels : [];
  // `delivery` accepts the legacy boolean (`hasDeliveredPr`) or the richer
  // `{ hasDeliveredPr, hasRecoverableBranch }` — call sites written before the branch
  // evidence existed keep their meaning exactly.
  const { hasDeliveredPr = false, hasRecoverableBranch = false } =
    (delivery && typeof delivery === 'object') ? delivery : { hasDeliveredPr: Boolean(delivery) };
  // (3) a PR was delivered → cap hit on post-delivery overrun, not a fixable loop.
  if (hasDeliveredPr) return false;
  // (4) commits on `fix/issue-<N>` ahead of main → the run delivered recoverable work.
  if (hasRecoverableBranch) return false;
  // (2) drainer already parked it as structurally non-fixable → expected death.
  // `needs-human` resta compatibile per le decisioni reali del proprietario;
  // `automation-deferred` è il percorso tecnico oggi prodotto dal drainer.
  if (names.includes('needs-human') || names.includes('automation-deferred')) return false;
  // (1) aggregate multi-item/daily bucket → over-budget by construction
  // (circuit-breaker target), not a fixable loop. Reuse the shared predicate;
  // its explicit analytics mode keeps ordinary body prose from changing burn.
  if (isAggregateForAnalytics(title, body)) return false;
  return true; // single-item, still-routable → fixable loop → countable
}

// ---- `no-root-cause` avoidability classifier (DETERMINISTIC) ----------------
// A `fix-outcome:no-root-cause` marker is recurring-BURN worth escalating ONLY
// when the fixer genuinely explored a real code bug and couldn't diagnose it —
// the prose rule ("se dopo ~15 turni non emerge una root cause chiara... termina
// con l'outcome no-root-cause") failing to prevent repeat exploration dead-ends.
// Escalation #4580 fired at 6/14d, but EVERY example (#4540/#4516/#4515/#4484/
// #4458) is a CORRECT, non-preventable abort forced into this one generic code
// because the taxonomy had no dedicated code for either class below — the rule
// was never broken, the taxonomy was too coarse:
//   1. TRANSIENT / VERIFIED-LIVE NON-BUG (#4540/#4516/#4515): the fixer verified
//      live (curl, `gh run list`) that the alert is a monitor false-positive — a
//      self-heal debounced-opener issue by design (#4540), or a deploy-churn edge
//      503 blip that had already resolved by the time of diagnosis (#4516/#4515).
//      There is no root cause to find because there is no bug: "try harder to
//      diagnose" cannot fix a symptom that stopped existing.
//   2. BLOCKED-ON-DEPENDENCY (#4484/#4458): the fixer found the root cause — an
//      epic/sub-issue this issue explicitly depends on ("Dipende dalla sub-issue
//      X") isn't done yet — but building that dependency here would blow the
//      single-issue scope (AGENTS.md #6) and duplicate the dedicated fixer run
//      already queued for it. Root cause IS known; the run is blocked, not lost.
// Neither class is a diagnosis failure, so counting them can never validate a
// "the rule works now" outcome — no amount of prompt tuning eliminates a
// transient monitor blip or an unmet epic dependency. A genuine no-root-cause
// (explored and still can't tell) has neither tell below and stays counted.
// Detected from the OUTCOME COMMENT BODY (not title/labels, unlike the sibling
// classifiers above): the distinguishing signal is the fixer's own diagnosis
// prose, not issue metadata. Pure → unit-tested, same shape as
// isAvoidableAlreadyFixed / isAvoidableMaxTurns.
const NO_ROOT_CAUSE_TRANSIENT_RE =
  /verificat[oa]\s+live,?\s+nessuna root cause di codice|nessun bug di codice|self-heal|debounc\w*|blip\s+(?:edge\s+)?transitori[oa]|rumore\s+(?:edge\/)?deploy-churn|rumore\s+transitori[oa]/i;
const NO_ROOT_CAUSE_BLOCKED_DEP_RE =
  /blocco di dipendenza|dipend[ei]\s+esplicitamente\s+dalla\s+sub-?issue|blocked:\s*dipendenza/i;
export function isAvoidableNoRootCause(commentBody) {
  const s = String(commentBody || '');
  if (NO_ROOT_CAUSE_TRANSIENT_RE.test(s)) return false; // (1) verified non-bug
  if (NO_ROOT_CAUSE_BLOCKED_DEP_RE.test(s)) return false; // (2) blocked on unmet dependency
  return true; // genuine "couldn't diagnose" → the real signal → countable
}

// ---- `overlap-skip` avoidability classifier (DETERMINISTIC) -----------------
// The classifier this file was MISSING. Every sibling outcome code above has one; the
// scheduling pair did not, so the outcome loop counted every `overlap-skip` marker as
// recurring burn. Measured on the corpus mirror (2026-08-13): 11 markers seen, 11
// counted, 0 discarded — the bucket sat above threshold on outcomes that are, by the
// loop's OWN declaration, not faults at all.
//
// That declaration lives in `followup-drainer.mjs` and is explicit: `overlap-skip` and
// `pr-already-open` are deliberately EXCLUDED from `NON_RETRYABLE` because "l'overlap è
// transitorio (la PR bloccante può mergiare → ri-tentabile)", and
// `close-recovered-structural-hold.mjs` refuses to hold them for the same reason
// ("scheduling, not a fault"). Two issues touching one file at the same time is the
// normal shape of a loop that runs several fixers in parallel; the deferral IS the
// correct handling, and no doc rule an agent could follow makes two independent issues
// stop overlapping. Counting it re-fires an escalation whose only possible remedy is the
// zero-Claude pre-flight that already exists (#3810) — and whose corpus half was
// separately found INERT and fixed in `workflow-scope-detect.mjs` (see `CODE_DIRS`), which
// is the actual cause of the burn these markers recorded.
//
// The ONE case that stays countable: the issue also carries a `pr-created` marker. Then
// the fixer was re-promoted onto an issue that already had its PR open, which the
// drainer's `hasFixPR` guard exists to prevent — a real gate gap, and a whole Claude run
// spent to rediscover the loop's own output. Note the polarity is the opposite of
// `isAvoidableMaxTurns`'s: there a delivered PR means the cap was hit AFTER the work
// landed (harmless overrun); here it means the run should never have started.
// Pure → unit-tested, same shape as the classifiers above.
export function isAvoidableOverlapSkip(title, labels, hasDeliveredPr = false) {
  if (hasDeliveredPr) return true; // promoted despite an open PR → hasFixPR gap → countable
  return false; // transient scheduling deferral → expected, not preventable burn
}

// #4750: isAvoidableNoRootCause STILL misses both classes above whenever the
// fixer paraphrases them — e.g. "verificato live: nessuna root cause di
// codice" (colon, not the regex's comma) or "blip edge/deploy-churn
// transitorio" (an inserted "/deploy-churn" the regex doesn't allow) — because
// it is, unlike every sibling avoidable-* filter, matching open-ended
// LLM-authored diagnosis prose rather than a fixed-format field (title/labels).
// That input space is unbounded: #4580 escalated once, the regex was widened,
// and #4750 escalated again 6/14d later on a FRESH set of paraphrases
// (#4748/#4738/#4735/#4702/#4696 — all verified transient-live or
// blocked-on-a-separately-tracked-issue, none a genuine stuck diagnosis; see
// their `no-root-cause` comments). Widening the regex again would only repeat
// the same failure a third time. The structural fix is to stop trying to
// parse prose for the escalation decision: `no-root-cause` never drives a
// "ricorre nonostante regola" escalation (same treatment as `issue-class`,
// which is operational volume/context, not instruction signal) — a docs-only
// prompt rule can't bound how many ways an LLM restates "this was transient"
// or "blocked on #N", so recurrence here is expected noise, not a preventable
// mistake. isAvoidableNoRootCause / the regexes above stay in place for the
// volume/context count shown in the harvest summary; they just no longer gate
// whether the bucket can escalate.
// #4938: the carve-out above never actually fired in production. main()'s
// outcome-tally loop builds keys as `fix-outcome:${code}` (already prefixed
// with the source), but the check below only ever matched the bare code -
// a shape that only existed in the unit test, not at the real call site.
// Strip the redundant `${source}:` prefix (same normalization
// `alreadyDocumented` already does for non-taxonomy keys) before comparing.
// `rate-limited` (2026-08-05): stessa classe, causa diversa. Il marker dice che
// la quota Max CONDIVISA era esaurita quando è arrivato il turno di quella issue
// — la run è morta su HTTP 429 al primo turno, senza mai leggerla (`num_turns: 1`,
// `total_cost_usd: 0`). Non è una regola che un agent ha violato e che
// un'aggiunta ai doc potrebbe prevenire: è una condizione ambientale. Farla
// guidare un'escalation significherebbe spendere il turno Claude della proposta
// per redigere istruzioni che non possono fixare un'interruzione di quota —
// per giunta proprio nella finestra in cui la quota manca, cioè il momento
// peggiore possibile. Come per `no-root-cause`, il bucket resta CONTATO (volume
// e context nel summary del harvest restano visibili); smette solo di poter
// aprire una PR di regole. Il segnale di capacità ha già la sua sede giusta: il
// failure-rate di `issue-fix.yml` nel tracker #1951 (loop-health-report).
// `skip-duplicate-diagnosis` (2026-08-08, #5288): emesso SOLO dal Mode 2 di
// check-workflows-scope.mjs, cioè quando una issue con titolo identico a una
// precedente già diagnosticata viene short-circuitata PRIMA di spendere un turno
// Claude. Non è un blocco né una regola violata: è il guard che funziona, a costo
// zero. Prima condivideva il marker con `blocked-workflows-scope`, e quella
// conflazione ha una conseguenza perversa — più il guard è efficace, più alza il
// bucket che fa scattare l'escalation su quello stesso bucket, così l'escalation
// può ripresentarsi PROPRIO perché il fix funziona. Stessa classe di feedback-loop
// già vista con `already-fixed` (#2123) e `rate-limited`: separato il codice, il
// bucket resta contato come volume/context nel summary ma non può più driveare
// una proposta.
// `overlap-skip` / `pr-already-open` (2026-08-13): stessa classe, causa ancora diversa.
// Sono i due esiti che `followup-drainer.mjs` dichiara TRANSIENTI — li esclude apposta da
// `NON_RETRYABLE` perché «la PR bloccante può mergiare → ri-tentabile», e
// `close-recovered-structural-hold.mjs` si rifiuta di trattenerli («scheduling, not a
// fault»). Un'escalation su questo bucket chiederebbe una regola di prosa contro il fatto
// che due issue indipendenti nominino lo stesso file nello stesso momento, che è la forma
// normale di un ciclo con più fixer in parallelo: nessuna riga di doc la previene. Il
// rimedio strutturale esiste già ed è la pre-flight zero-Claude (#3810) — la cui metà
// corpus era però INERTE (`CODE_PATH_RE` matchava dalla directory, mai dal path completo,
// vedi `scripts/lib/workflow-scope-detect.mjs`), ed è quello il difetto che questi marker
// stavano davvero registrando. I due codici restano CONTATI come volume/context nel
// summary, esattamente come `rate-limited`: smettono solo di poter aprire una PR di regole.
export function isEscalationDriver(source, key) {
  if (source === 'issue-class') return false;
  const bareKey = key.startsWith(`${source}:`) ? key.slice(source.length + 1) : key;
  if (source === 'fix-outcome' && bareKey === 'no-root-cause') return false;
  if (source === 'fix-outcome' && bareKey === 'rate-limited') return false;
  if (source === 'fix-outcome' && bareKey === 'skip-duplicate-diagnosis') return false;
  if (source === 'fix-outcome' && bareKey === 'overlap-skip') return false;
  if (source === 'fix-outcome' && bareKey === 'pr-already-open') return false;
  // revenue-tracker-manual is an intentional terminal handoff, not a
  // repeatable agent mistake: its diagnosis may depend on an external provider,
  // a production-only measurement, or a credential/dispatch owned outside the
  // repository. Keep the marker in the volume summary, but do not let the
  // heterogeneous manual cases manufacture a false "rule is not working"
  // escalation.
  if (source === 'fix-outcome' && bareKey === 'revenue-tracker-manual') return false;
  return true;
}

/**
 * Classe di escalation di un bucket (decisione I3 del 2026-10-05, vedi la nota
 * sopra TAXONOMY): 'rule' | 'topic' | 'ambiguous' per le voci della tassonomia
 * dei finding, null per tutto il resto (fingerprint, fix-outcome, issue-class).
 * Accetta la chiave nuda o quella `<source>/<key>` del titolo. Puro → testabile.
 * @param {string} source
 * @param {string} key
 * @returns {'rule'|'topic'|'ambiguous'|null}
 */
export function bucketEscalationKind(source, key) {
  if (source !== 'reviewer-finding') return null;
  const bare = String(key || '').replace(/^reviewer-finding[/:]/, '');
  return TAXONOMY.find((t) => t.key === bare)?.escalation ?? null;
}

/** True solo per un bucket di argomento: contato nel report, mai escalato. */
export function isTopicOnlyBucket(source, key) {
  return bucketEscalationKind(source, key) === 'topic';
}

// ---- Recoverable work left on the fixer's branch ---------------------------
// issue-fix.yml pushes a WIP checkpoint (`wip(issue-N): checkpoint pre-test`) the moment
// the edit is applied, precisely so a run that dies at the turn cap doesn't take the diff
// down with the container (#4337). The branch it pushes is `fix/issue-<N>` — the same head
// the workflow's own `Classify outcome` step reads. Nothing downstream of the death ever
// looked at it: `isAvoidableMaxTurns` asked only about a PR, so a branch with real commits
// and no PR was indistinguishable from a run that produced nothing.
export function fixBranchName(issueNumber) {
  return `fix/issue-${issueNumber}`;
}

// Stamp written by mark-claude-terminal-outcome.mjs next to the `max-turns` marker, at the
// one moment the evidence is free (inside the job, on the machine that pushed the branch).
// Reading it costs no API call and survives the branch being deleted later by a merge.
export const RECOVERABLE_BRANCH_RE = /<!--\s*RECOVERABLE_BRANCH:\s*(\S+)\s+ahead=(\d+)\s*-->/i;

/**
 * `{ branch, aheadBy }` from a stamped comment, or null. Pure → testabile.
 * @param {string} commentBody
 */
export function parseRecoverableBranchStamp(commentBody) {
  const m = RECOVERABLE_BRANCH_RE.exec(String(commentBody || ''));
  if (!m) return null;
  const aheadBy = Number(m[2]);
  if (!Number.isFinite(aheadBy) || aheadBy <= 0) return null;
  return { branch: m[1], aheadBy };
}

/**
 * Recoverable work for `issueNumber`: the stamp when a run left one, otherwise ask GitHub
 * how far `fix/issue-<N>` is ahead of `main`. Impure (gh) — kept thin, and FAIL-SAFE: any
 * gh error / missing branch answers null, i.e. exactly the pre-2026-08-13 behaviour.
 * @param {number} issueNumber
 * @param {Array<{body?: string}>} comments
 */
function recoverableWorkOnBranch(issueNumber, comments) {
  for (const c of comments || []) {
    const stamped = parseRecoverableBranchStamp(c?.body);
    if (stamped) return stamped;
  }
  const branch = fixBranchName(issueNumber);
  const cmp = ghJson(['api', `repos/{owner}/{repo}/compare/main...${branch}`,
    '--jq', '{ahead_by: .ahead_by}']);
  const aheadBy = Number(cmp?.ahead_by);
  return Number.isFinite(aheadBy) && aheadBy > 0 ? { branch, aheadBy } : null;
}

// ---- 2. Recurring issue classes (created in window) ----
export function issueClass(title, labels) {
  const t = title || '';
  if (/^Crawler Failure/i.test(t)) return 'issue:crawler-failure';
  if (/Validation Failure|Publish post-deploy/i.test(t)) return 'issue:validation-failure';
  if (/\[crawler-health\]/i.test(t)) return 'issue:crawler-health';
  if (/^follow-up\(/i.test(t)) return 'issue:follow-up';
  const names = (labels || []).map((l) => l.name);
  if (names.includes('revenue') || names.includes('rpm-canary')) return 'issue:revenue';
  return null;
}

// ---- Dedup vs existing doc-contracts ----
const DOC_FILES = ['AGENTS.md', 'ISSUES.md', 'REVIEW.md', 'FOLLOWUP.md'];
export function alreadyDocumented(bucketKey, corpus) {
  const tax = TAXONOMY.find((t) => t.key === bucketKey);
  if (tax) return tax.docKeys.some((k) => corpus.includes(k.toLowerCase()));
  // Non-taxonomy keys (issue-class / fix-outcome codes): check hyphen, space
  // and nospace variants so "follow-up" matches a doc that writes "follow up".
  const base = bucketKey.replace(/^[a-z-]+:/, '').toLowerCase();
  const variants = [base, base.replace(/-/g, ' '), base.replace(/-/g, '')];
  return variants.some((v) => corpus.includes(v));
}

// ---- Escalation issue title/body helpers (DETERMINISTIC, see emit note) ----
function escalationTitle(c) {
  return `escalation(harvester): ${c.source}/${c.key} ricorre nonostante regola`;
}
// Recurrence bumps SEVERITY, not count: un'escalation è già "ricorre nonostante
// regola" (≥soglia×fattore) → baseline medium; se il count scala oltre 2× il
// fattore → high. Puro → testabile.
export function severityLabelForCount(count, threshold = THRESHOLD, factor = EFFICACY_FACTOR) {
  return count >= threshold * factor * 2 ? 'severity:high' : 'severity:medium';
}
// Estrae `<source>/<key>` dal titolo canonico, o null. Puro → testabile. Serve
// al self-heal: mappare un'escalation issue aperta al suo bucket.
export function parseEscalationKey(title) {
  const m = /^escalation\(harvester\):\s*(.+?)\s+ricorre nonostante regola\s*$/.exec(String(title || ''));
  return m ? m[1].trim() : null;
}
// ---- POST-FIX RE-ESCALATION GUARD (DETERMINISTIC, escalation #4578) --------
// `fix-outcome:revenue-tracker-manual` re-fired the day AFTER its own structural
// fix shipped: #4517 (this exact bucket) was closed by merging PR #4535, which
// added a zero-Claude pre-flight (`detectEpicTracker` in followup-drainer.mjs)
// that now prevents FUTURE burn. But the very next harvester run still counted
// 11 occurrences in the trailing 14-day window — all of them from BEFORE the fix
// merged (the 2026-07-18 `[EPIC]` batch) — so `recurringDespiteRule` fired again
// and `createGithubIssue` minted a brand-new duplicate (#4578) instead of finding
// #4517, because that dedup only searches OPEN issues by title and #4517 was
// already closed. The bucket wasn't still broken; the window just hadn't aged
// out yet. Root cause is generic (applies to ANY fix-outcome bucket, not just
// this one): count only examples NEWER than the bucket's last shipped fix.
//
// CONSERVATIVE (bias to escalate — a missed re-fire wastes a review cycle, a
// false suppression hides a real regression): only excludes examples when a
// PRIOR escalation for the SAME bucket key was actually closed (a shipped fix
// happened) AND the example predates that closure. A bucket with no prior
// closed escalation (first time above threshold) is unaffected — full count.

/**
 * Epoch ms of the most recent CLOSED escalation issue whose title parses to
 * `fullKey` (`<source>/<key>`, matching `escalationTitle`'s format), or null if
 * none. Pure → testable.
 * @param {string} fullKey
 * @param {Array<{title?: string, closedAt?: string}>} closedIssues
 */
export function lastEscalationClosedAt(fullKey, closedIssues) {
  let latest = null;
  for (const iss of closedIssues || []) {
    if (parseEscalationKey(iss?.title) !== fullKey) continue;
    const t = Date.parse(iss?.closedAt);
    if (!Number.isNaN(t) && (latest === null || t > latest)) latest = t;
  }
  return latest;
}

// ---- Il cutoff di un'escalation RIAPERTA sta negli eventi, non in `closedAt` ----
// `createGithubIssue` riapre il gemello chiuso invece di aprirne uno nuovo. Da
// quel momento l'issue non e' piu' fra le chiuse e GitHub le azzera `closedAt`
// (misurato su 10112 e 10114: `state: OPEN`, `closedAt: null`, evento `closed`
// del 27-09 seguito da `reopened` dell'01-10). Il cutoff tornava `null` e
// l'escalation si ricontava da sola sull'intera finestra, cioe' sugli esempi
// PRECEDENTI alla fix. Leggere la lista con `--state all` non basta: la data
// della chiusura di una issue aperta esiste solo nei suoi eventi.

// Una riga per evento, `<event> <created_at>`: testo semplice e non JSON,
// perche' `gh --jq` stampa il JSON compatto o indentato a seconda del
// terminale, e con `--paginate` emette un documento per pagina.
export const ISSUE_EVENTS_JQ = '.[] | "\\(.event) \\(.created_at)"';

/**
 * Output di `gh api .../events --paginate --jq ISSUE_EVENTS_JQ` → elenco di
 * eventi, oppure `null` se e' vuoto o contiene una riga malformata. `null`
 * significa «non so», e chi chiama lo tratta come nessun cutoff: l'allarme
 * resta, non si spegne. Puro → testabile.
 * @param {string} raw
 * @returns {Array<{event: string, created_at: string}> | null}
 */
export function parseIssueEventLines(raw) {
  const lines = String(raw ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return null;
  const events = [];
  for (const line of lines) {
    const m = /^([a-z0-9_]+) (\S+)$/u.exec(line);
    if (!m) return null;
    events.push({ event: m[1], created_at: m[2] });
  }
  return events;
}

/**
 * Istante ISO dell'ULTIMO evento `closed`, o `null` (mai chiusa, eventi
 * illeggibili, date non valide). Puro → testabile.
 * @param {Array<{event?: string, created_at?: string}> | null | undefined} events
 * @returns {string | null}
 */
export function lastClosedEventAt(events) {
  if (!Array.isArray(events)) return null;
  let latest = null;
  let latestMs = null;
  for (const e of events) {
    if (e?.event !== 'closed') continue;
    const t = Date.parse(e?.created_at);
    if (Number.isNaN(t) || (latestMs !== null && t <= latestMs)) continue;
    latestMs = t;
    latest = e.created_at;
  }
  return latest;
}

/**
 * Le chiusure passate delle escalation oggi APERTE, nella stessa forma delle
 * issue chiuse (`{title, closedAt}`), cosi' `lastEscalationClosedAt` riceve
 * l'unione. `readEvents(number)` restituisce gli eventi o `null`; i numeri
 * illeggibili finiscono in `unreadable` e NON producono un cutoff. Puro (la
 * lettura e' iniettata) → testabile.
 * @param {Array<{number: number, title?: string}>} openIssues
 * @param {(number: number) => Array<{event?: string, created_at?: string}> | null} readEvents
 */
export function reopenedEscalationClosures(openIssues, readEvents) {
  const closures = [];
  const unreadable = [];
  for (const iss of openIssues || []) {
    if (!parseEscalationKey(iss?.title)) continue;
    const events = readEvents(iss.number);
    if (!Array.isArray(events)) { unreadable.push(iss.number); continue; }
    const closedAt = lastClosedEventAt(events);
    if (closedAt) closures.push({ number: iss.number, title: iss.title, closedAt });
  }
  return { closures, unreadable };
}

/**
 * Examples occurring strictly AFTER `cutoffMs` (the bucket's last shipped fix).
 * `cutoffMs === null` means no prior fix ever shipped for this bucket → return
 * examples unchanged (first-ever escalation must still fire on full history).
 * An example lacking a parseable `at` timestamp is dropped once a cutoff exists
 * (conservative: can't prove it's post-fix, so don't let it count toward
 * re-firing an already-fixed bucket). Pure → testable.
 * @param {Array<{at?: string}>} examples
 * @param {number|null} cutoffMs
 */
export function examplesSinceFix(examples, cutoffMs) {
  if (cutoffMs === null || cutoffMs === undefined) return examples || [];
  return (examples || []).filter((e) => {
    const t = Date.parse(e?.at);
    return !Number.isNaN(t) && t > cutoffMs;
  });
}

// Sorgenti i cui esempi portano un `at`: fix-outcome (createdAt del commento
// FIX_OUTCOME) e reviewer-finding (mergedAt della PR, #5516). Solo queste si
// possono contare «dopo il cutoff»; issue-class non e' un driver.
const TIMESTAMPED_SOURCES = new Set(['fix-outcome', 'reviewer-finding']);
// Tetto degli esempi post-cutoff riportati nel corpo dell'escalation.
export const ESCALATION_EVIDENCE_CAP = 30;

/**
 * La misura di un bucket: da quando si conta e quanto resta. Il criterio di
 * escalation NON cambia (`effectiveCount >= soglia × fattore`): questa funzione
 * lo isola per poterlo provare su una escalation riaperta. Puro → testabile.
 * @param {{source: string, count: number, examples?: Array<{at?: string}>,
 *   escalationCutoff?: number|null, ruleCutoff?: number|null,
 *   threshold?: number, factor?: number}} input
 */
export function measureBucket({ source, count, examples = [], escalationCutoff = null, ruleCutoff = null,
  threshold = THRESHOLD, factor = EFFICACY_FACTOR }) {
  const timestamped = TIMESTAMPED_SOURCES.has(source);
  const esc = timestamped ? escalationCutoff ?? null : null;
  const rule = timestamped ? ruleCutoff ?? null : null;
  const cutoff = esc === null ? rule : rule === null ? esc : Math.max(esc, rule);
  const liveExamples = timestamped ? examplesSinceFix(examples, cutoff) : examples || [];
  const effectiveCount = timestamped ? liveExamples.length : count;
  return { cutoff, liveExamples, effectiveCount, limit: threshold * factor,
    aboveLimit: effectiveCount >= threshold * factor };
}

// ---- Self-heal: chi NON si chiude, e con quale misura ----------------------
// Label che vietano la chiusura automatica. Unione di `FIXER_EXEMPT_LABELS`
// (`scripts/lib/classify-issue.mjs`) e del veto `KEEP_OPEN_LABELS` di
// `reconcile-followups.mjs`: tenuta qui e non importata perche' questo file
// scende `identical` nel corpus, e la parita' la verifica un test.
export const SELF_HEAL_PIN_LABELS = Object.freeze(['keep-open', 'agent:no-age-out', 'pinned', 'tracker',
  'do-not-close', 'revenue']);
// Claim del fixer: una issue in lavorazione non si chiude sotto i suoi piedi.
export const SELF_HEAL_CLAIM_LABEL = 'agent:in-progress';

/**
 * Sorgente di un bucket `<source>/<key>` → la vista della finestra da cui
 * dipende la sua misura. Puro → testabile.
 * @param {string} fullKey
 */
export function bucketSource(fullKey) {
  const source = String(fullKey || '').split('/')[0];
  return TIMESTAMPED_SOURCES.has(source) || source === 'issue-class' ? source : null;
}

/**
 * Decide il self-heal di UNA escalation aperta il cui bucket non e' piu' fra
 * quelli attivi. Chiude solo con: nessun pin ne' claim, vista completa della
 * finestra per la sorgente del bucket, misura sotto la soglia di escalation.
 * Eccezione (decisione I3 del 2026-10-05): un bucket di argomento si chiude,
 * pin e claim a parte, a qualunque misura, perche' non puo' piu' escalare.
 * Il commento riporta la misura, non un'interpretazione. Puro → testabile.
 * @param {{key: string, labels?: Array<string|{name?: string}>,
 *   measure?: {effectiveCount: number, cutoffMs: number|null} | null,
 *   cutoffMs?: number|null, partialSources?: Set<string>, windowDays?: number,
 *   sinceDay?: string, threshold?: number, factor?: number}} input
 * @returns {{action: 'close'|'skip', reason: string, comment?: string}}
 */
export function selfHealDecision({ key, labels = [], measure = null, cutoffMs = null,
  partialSources = new Set(), windowDays: days = WINDOW_DAYS, sinceDay: since = sinceDay,
  threshold = THRESHOLD, factor = EFFICACY_FACTOR }) {
  const names = new Set((labels || []).map((l) => String(typeof l === 'string' ? l : l?.name ?? '').toLowerCase()));
  const pin = SELF_HEAL_PIN_LABELS.find((l) => names.has(l));
  if (pin) return { action: 'skip', reason: `pin ${pin}` };
  if (names.has(SELF_HEAL_CLAIM_LABEL)) return { action: 'skip', reason: `claim ${SELF_HEAL_CLAIM_LABEL}` };
  const source = bucketSource(key);
  if (!source) return { action: 'skip', reason: 'sorgente del bucket sconosciuta' };
  // Un bucket di argomento non tiene aperta un'escalation (decisione I3 del
  // 2026-10-05): la chiusura dipende dalla classe della voce, non dalla misura,
  // quindi qui non contano ne' la soglia ne' la completezza della finestra.
  if (isTopicOnlyBucket(source, key.slice(source.length + 1))) {
    const count = measure ? measure.effectiveCount : 0;
    const comment = `🌱 Self-heal: il bucket \`${key}\` e' classificato «argomento» nella tassonomia del harvester ` +
      `(un lessico, non una regola violata). Per la decisione del proprietario I3 del 2026-10-05 i bucket di ` +
      `argomento restano solo nel report e non aprono ne' tengono aperta un'escalation; soglie invariate. ` +
      `Misura corrente: ${count} su soglia ${threshold * factor} (${threshold}×${factor}), ancora visibile nel report ` +
      'e nella tally. Le sottoclassi legate a una regola hanno un bucket proprio e la loro escalation. ' +
      'Chiusa dal lessons-harvester.';
    return { action: 'close', reason: `bucket di argomento (decisione I3), ${count} su ${threshold * factor}`, comment };
  }
  if (partialSources.has(source)) return { action: 'skip', reason: `vista PARZIALE della finestra per ${source}` };
  const limit = threshold * factor;
  // Una run manuale con finestra piu' corta o soglia piu' alta misura meno di
  // quanto conta l'allarme: chiudere li' sposterebbe il cutoff alla data della
  // chiusura e zittirebbe il bucket finche' non tornano `limit` casi nuovi.
  const canonicalLimit = DEFAULT_THRESHOLD * DEFAULT_EFFICACY_FACTOR;
  if (days < DEFAULT_WINDOW_DAYS || limit > canonicalLimit) {
    return { action: 'skip', reason: `misura NON canonica (finestra ${days}gg, soglia ${limit}; ` +
      `il self-heal chiude solo con finestra >= ${DEFAULT_WINDOW_DAYS}gg e soglia <= ${canonicalLimit})` };
  }
  // Bucket assente dalla finestra: zero occorrenze, ma il cutoff e' comunque
  // quello della sua ultima chiusura.
  const effectiveCount = measure ? measure.effectiveCount : 0;
  const cut = measure ? measure.cutoffMs : cutoffMs;
  if (effectiveCount >= limit) {
    // Sopra soglia ma non attivo (non piu' driver o non piu' documentato):
    // «non supera la soglia» sarebbe falso, quindi non si chiude.
    return { action: 'skip', reason: `sopra soglia (${effectiveCount} su ${limit}) ma non attivo` };
  }
  const from = cut === null || cut === undefined
    ? `nessun cutoff, intera finestra dal ${since}`
    : `ultimo cutoff ${new Date(cut).toISOString()}`;
  const comment = `🌱 Self-heal: il bucket \`${key}\` non supera la soglia nella finestra di ${days} giorni ` +
    `dopo l'ultimo cutoff (${from}): ${effectiveCount} su soglia ${limit} (${threshold}×${factor}). ` +
    'Vista della finestra completa per la sorgente del bucket, nessun pin. Chiusa dal lessons-harvester; ' +
    'si riapre in automatico se il bucket torna sopra soglia.';
  return { action: 'close', reason: `${effectiveCount} < ${limit}`, comment };
}

// ---- Registro versionato delle decisioni sui cluster -----------------------
// `alreadyDocumented` riconosce un bucket della tassonomia dai suoi `docKeys`,
// ma per un cluster `fp:<...>` (rete fingerprint) o per un codice `fix-outcome`
// cerca la FRASE DEL FINGERPRINT nei doc, che una regola scritta in italiano
// non contiene quasi mai. Risultato misurato: ogni giorno la proposta Codex
// (10-16 min a run) ridecideva gli stessi cluster. `fp:scripts-funnel-treats-every`
// e' tornato NOVEL il 28-09, il giorno dopo la regola di #10153;
// `fp:body-not-closing-state` e' stato scartato il 27-09 (#10153) e accettato
// il 28-09 (#10212) sugli stessi tre esempi.
//
// Il registro e' la memoria di quelle decisioni: una voce per cluster
// (`<source>/<key>`, la stessa forma del titolo di escalation), con l'esito
// (`added` = regola scritta, `declined` = scartato per scelta), l'istante e il
// riferimento. Lo scrive la proposta Codex nella stessa PR in cui decide. Un
// cluster registrato torna NOVEL solo se DOPO la decisione raccoglie di nuovo
// ≥ soglia esempi (stesso filtro di `examplesSinceFix`); un `added` vale come
// documentato, quindi puo' ancora escalare se la regola non funziona.
export const LESSONS_REGISTRY_PATH = 'scripts/ci/lessons-harvester-registry.json';
export const REGISTRY_OUTCOMES = Object.freeze(['added', 'declined']);
const REGISTRY_KEY_RE = /^(?:reviewer-finding|fix-outcome|issue-class)\/\S+$/u;

/** Chiave di registro di un cluster: `<source>/<key>`, come `escalationTitle`. */
export function registryKey(source, key) {
  return `${source}/${key}`;
}

/**
 * Istante della decisione in epoch ms, o null. Una data sola (`YYYY-MM-DD`)
 * vale fine giornata UTC: gli esempi dello stesso giorno li aveva gia' visti
 * chi ha deciso, quindi non devono farlo riemergere.
 * @param {unknown} decidedAt
 */
export function registryDecidedAtMs(decidedAt) {
  const s = String(decidedAt ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/u.test(s)) return Date.parse(`${s}T23:59:59.999Z`);
  if (!/^\d{4}-\d{2}-\d{2}T/u.test(s)) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

/**
 * Valida e indicizza il registro. Una voce non valida NON sopprime niente (il
 * cluster torna a essere valutato come prima) e finisce in `errors`, che il
 * main stampa come `::warning::` e il test sul file versionato fa fallire.
 * Due voci con la stessa chiave: vince la decisione piu' recente.
 * @param {string | object} raw
 * @returns {{entries: Map<string, {key: string, outcome: string, decidedAt: string, decidedAtMs: number, ref: string, reason: string}>, errors: string[]}}
 */
export function parseLessonsRegistry(raw) {
  const entries = new Map();
  const errors = [];
  let data;
  try {
    data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (err) {
    return { entries, errors: [`JSON non valido: ${err.message}`] };
  }
  if (!Array.isArray(data?.entries)) return { entries, errors: ['manca l\'array `entries`'] };
  data.entries.forEach((e, i) => {
    const where = `entries[${i}]`;
    const key = String(e?.key ?? '');
    if (!REGISTRY_KEY_RE.test(key)) { errors.push(`${where}: key "${key}" non e' <source>/<key>`); return; }
    if (!REGISTRY_OUTCOMES.includes(e?.outcome)) {
      errors.push(`${where} (${key}): outcome "${e?.outcome}" non in ${REGISTRY_OUTCOMES.join('|')}`);
      return;
    }
    const decidedAtMs = registryDecidedAtMs(e?.decidedAt);
    if (decidedAtMs === null) { errors.push(`${where} (${key}): decidedAt "${e?.decidedAt}" non e' una data ISO`); return; }
    const reason = String(e?.reason ?? '').trim();
    if (!reason) { errors.push(`${where} (${key}): reason vuota`); return; }
    const prev = entries.get(key);
    if (prev && prev.decidedAtMs > decidedAtMs) return;
    entries.set(key, { key, outcome: e.outcome, decidedAt: String(e.decidedAt), decidedAtMs,
      ref: String(e?.ref ?? ''), reason });
  });
  return { entries, errors };
}

/**
 * Legge il registro. File assente = registro vuoto (il corpus riceve questo
 * script per mirror prima di avere un registro suo): nessuna soppressione.
 * @param {string} [path]
 * @param {(p: string, enc: string) => string} [readFile]
 */
export function loadLessonsRegistry(path = LESSONS_REGISTRY_PATH, readFile = fs.readFileSync) {
  let raw;
  try {
    raw = readFile(path, 'utf-8');
  } catch (err) {
    if (err?.code === 'ENOENT') return { entries: new Map(), errors: [], missing: true };
    return { entries: new Map(), errors: [`registro illeggibile: ${err.message}`] };
  }
  return parseLessonsRegistry(raw);
}

/**
 * Stato di un cluster rispetto al registro. Senza voce: nessun effetto. Con
 * voce: contano solo gli esempi successivi alla decisione, e il cluster
 * «riemerge» solo se sono di nuovo ≥ soglia. Puro → testabile.
 * @param {{decidedAtMs: number} | null | undefined} entry
 * @param {Array<{at?: string}>} examples
 * @param {number} [threshold]
 */
export function registryVerdict(entry, examples, threshold = THRESHOLD) {
  if (!entry) return { registered: false, resurfaced: true, examplesSinceDecision: examples || [] };
  const since = examplesSinceFix(examples, entry.decidedAtMs);
  return { registered: true, resurfaced: since.length >= threshold, examplesSinceDecision: since };
}

function formatExamples(c) {
  return (c.examples || [])
    .map((e) => [e?.pr, e?.issue].find((value) => value !== null && value !== undefined && value !== ''))
    .filter((value) => value !== undefined)
    .map((value) => `#${value}`)
    .join(', ') || '—';
}

export function buildEscalationSignals(c) {
  return {
    cosa: `bucket ${c.source}/${c.key}: pattern documentato che ricorre nonostante la regola`,
    metrica: {
      osservato: c.effectiveCount ?? c.count,
      atteso: `< ${THRESHOLD}×${EFFICACY_FACTOR} occorrenze dopo il cutoff (intera finestra se non c'è)`,
    },
    comando: 'node scripts/ci/harvest-agent-lessons.mjs --dry-run',
    evidenza: [
      `bucket=${c.source}/${c.key}`,
      `finestra=${WINDOW_DAYS}gg dal ${sinceDay}`,
      `in-finestra=${c.count}`,
      `cutoff=${c.cutoffAt || 'nessuno'}`,
      `esempi=${formatExamples(c)}`,
    ],
  };
}

// Lo snippet e' testo di un reviewer: va in un blocco recintato, dove non
// menziona nessuno, non crea riferimenti incrociati e non semina token-codice
// nel corpo di una issue `follow-up` (`followup-resolution-match.mjs` ignora le
// righe recintate, altrimenti le leggerebbe come prescrizioni da cercare).
function evidenceLine(e) {
  const present = (v) => v !== null && v !== undefined && v !== '';
  const ref = present(e?.pr) ? `PR ${e.pr}` : present(e?.issue) ? `issue ${e.issue}` : '—';
  const day = /^\d{4}-\d{2}-\d{2}/u.exec(String(e?.at ?? ''))?.[0];
  const snippet = String(e?.snippet ?? '').replace(/`/gu, "'").replace(/\s+/gu, ' ').trim();
  return `${ref}${day ? ` (${day})` : ''}${snippet ? `: ${snippet}` : ''}`;
}

/**
 * Corpo (e commento di ricorrenza) dell'escalation: la misura su cui si fonda
 * — occorrenze DOPO il cutoff, non la finestra intera — la data del cutoff e
 * gli esempi che contano, col loro testo. Puro → testabile.
 */
export function escalationBody(c) {
  const effective = c.effectiveCount ?? c.count;
  const evidence = c.postCutoffExamples || c.examples || [];
  const shown = evidence.slice(0, ESCALATION_EVIDENCE_CAP);
  return [
    '## Bucket',
    `\`${c.source}/${c.key}\` — **${effective}** occorrenze dopo il cutoff ` +
      `(soglia di escalation ${THRESHOLD}×${EFFICACY_FACTOR}) · in finestra ${WINDOW_DAYS}gg (dal ${sinceDay}): ${c.count}`,
    '',
    c.cutoffAt
      ? `Cutoff: **${c.cutoffAt}** (ultima chiusura dell'escalation di questo bucket, o regola registrata): gli esempi precedenti non contano.`
      : 'Cutoff: nessuno (nessuna escalation chiusa né regola registrata per questo bucket): conta l\'intera finestra.',
    '',
    '## Esempi dopo il cutoff',
    // I numeri delle PR stanno nel blocco recintato: fuori ne restano al piu' 5,
    // per non seminare 30 riferimenti incrociati a ogni ricorrenza.
    `Numeri: ${formatExamples({ examples: shown.slice(0, 5) })}${shown.length > 5 ? ', …' : ''}`,
    '',
    '```text',
    ...(shown.length ? shown.map(evidenceLine) : ['—']),
    ...(effective > shown.length ? [`… altri ${effective - shown.length} non riportati`] : []),
    '```',
    '',
    '## Perché escalare',
    `Pattern GIÀ documentato ma che ricorre ≥ soglia×fattore-efficacia ` +
      `(${THRESHOLD}×${EFFICACY_FACTOR}). La regola prosa NON previene l'errore ` +
      `→ serve un fix **STRUTTURALE** (gate CI deterministico, template, lint, ` +
      `modulo condiviso, refactor che lo renda impossibile by-construction), ` +
      `non un'altra riga di doc.`,
    '',
    '_Auto-filed dal lessons-harvester (dedup deterministico per bucket)._',
  ].join('\n');
}

/**
 * I cluster di UNA sorgente: misura ogni bucket, registra la misura in
 * `bucketMeasures` (anche sotto soglia, per il self-heal) e restituisce quelli
 * a soglia con il loro verdetto. Puro a parte `bucketMeasures` → testabile.
 * Un bucket di argomento (isTopicOnlyBucket, decisione I3 del 2026-10-05) resta
 * nel report con la sua misura e `topicAboveLimit`, ma `recurringDespiteRule`
 * e' sempre false: non apre e non tiene aperta un'escalation. Soglie invariate.
 * @param {{source: string, counts: Record<string, number>,
 *   examples: Record<string, Array<object>>, corpus?: string,
 *   registry?: {entries: Map<string, object>}, escalationClosures?: Array<object>,
 *   bucketMeasures?: Map<string, object>, threshold?: number}} input
 */
export function considerBuckets({ source, counts, examples = {}, corpus = '', registry = { entries: new Map() },
  escalationClosures = [], bucketMeasures = new Map(), threshold = THRESHOLD }) {
  const out = [];
  for (const [key, count] of Object.entries(counts)) {
    const driver = isEscalationDriver(source, key);
    const kind = bucketEscalationKind(source, key);
    const regKey = registryKey(source, key);
    const reg = registry.entries.get(regKey) || null;
    const allExamples = examples[key] || [];
    // A bucket whose last escalation was already closed via a shipped fix
    // shouldn't re-fire on the SAME pre-fix occurrences still sitting in the
    // trailing window — only count what happened AFTER that fix landed.
    // Stesso ragionamento per una regola `added` dal registro: la sua
    // efficacia si misura sugli esempi successivi alla regola.
    const { cutoff, liveExamples, effectiveCount, aboveLimit } = measureBucket({
      source, count, examples: allExamples,
      escalationCutoff: lastEscalationClosedAt(regKey, escalationClosures),
      ruleCutoff: reg?.outcome === 'added' ? reg.decidedAtMs : null,
    });
    bucketMeasures.set(regKey, { windowCount: count, effectiveCount, cutoffMs: cutoff, driver });
    if (count < threshold) continue;
    // Una regola registrata come `added` vale come documentata anche quando
    // la sua prosa non contiene la frase del fingerprint.
    const documented = alreadyDocumented(key, corpus) || reg?.outcome === 'added';
    const decision = registryVerdict(reg, allExamples);
    const topicOnly = kind === 'topic';
    // Documented + still recurring hard (post-fix) = the rule exists but isn't
    // working. Un argomento non e' una regola: sopra soglia resta nel report.
    const recurringDespiteRule = driver && !topicOnly && documented && aboveLimit;
    // Un cluster gia' deciso torna NOVEL solo con ≥ soglia esempi nuovi.
    const novel = driver && !documented && decision.resurfaced;
    const shown = reg && decision.examplesSinceDecision.length ? decision.examplesSinceDecision
      : liveExamples.length ? liveExamples : allExamples;
    out.push({ source, key, registryKey: regKey, count, effectiveCount,
      cutoffAt: cutoff === null ? null : new Date(cutoff).toISOString(), driver, novel,
      recurringDespiteRule, alreadyDocumented: documented,
      escalationKind: kind, topicAboveLimit: topicOnly && driver && documented && aboveLimit,
      // Gli esempi su cui l'escalation si fonda, col loro testo: finiscono
      // nel corpo della issue (escalationBody).
      ...(recurringDespiteRule ? { postCutoffExamples: liveExamples.slice(0, ESCALATION_EVIDENCE_CAP) } : {}),
      registry: reg ? { outcome: reg.outcome, decidedAt: reg.decidedAt, ref: reg.ref,
        examplesSinceDecision: decision.examplesSinceDecision.length } : null,
      examples: shown.slice(0, 5) });
  }
  return out;
}

/** Etichetta di un cluster nel riepilogo umano. Puro → testabile. */
export function clusterReportTag(c) {
  if (c.novel) return 'NOVEL';
  if (c.recurringDespiteRule) return 'ESCALATE';
  if (c.topicAboveLimit) return 'TOPIC-REPORT-ONLY';
  return c.registry ? `registered:${c.registry.outcome}` : 'documented';
}

async function main() {
  // ---- 1. Reviewer findings on recently-merged PRs ----
  // `mergedAt` fetched here (not from `pr view`) so tallyFindings can stamp each
  // example with it — needed so the post-fix re-escalation guard below can filter
  // reviewer-finding examples the same way it already filters fix-outcome ones.
  // Reviews e commenti arrivano nella stessa lista (una query per giorno), non
  // con un `view` per elemento: con la finestra intera il sito ha ~1000 PR e
  // ~650 issue, e un `view` ciascuna costerebbe ~10 minuti di chiamate seriali.
  const days = windowDays(sinceDay, new Date().toISOString().slice(0, 10));
  const coverage = [];
  const prWindow = collectWindow(days, (day) => ghJsonRetry(['pr', 'list', '--state', 'merged',
    '--search', `merged:${day}`, '--limit', String(SEARCH_RESULT_CAP), '--json', 'number,mergedAt,reviews']));
  const prCap = applyCap(prWindow.items, MAX_PRS);
  const mergedPrs = prCap.items;
  const prReviews = [];
  // PR con review troncate a NESTED_PAGE_CAP e non rilette: vista parziale.
  const unreadPrReviews = [];
  for (const { number, mergedAt, reviews } of mergedPrs) {
    let all = reviews || [];
    if (all.length >= NESTED_PAGE_CAP) {
      const data = ghJson(['pr', 'view', String(number), '--json', 'reviews']);
      if (data?.reviews) all = data.reviews;
      else unreadPrReviews.push(number);
    }
    prReviews.push({ number, reviews: all, mergedAt });
  }
  // Sorgenti la cui vista della finestra e' incompleta: il self-heal non
  // chiude un'escalation misurata su una vista parziale.
  const partialSources = new Set();
  const prCoverage = coverageWarnings('merged PRs', prWindow, prCap.cut, unreadPrReviews, 'review');
  if (prCoverage.length) partialSources.add('reviewer-finding');
  coverage.push(...prCoverage);
  const { counts: findingCounts, examples: findingExamples } = tallyFindings(prReviews);

  // ---- 2. Recurring issue classes (created in window) ----
  const issueCounts = {};
  const issueExamples = {};
  const issueWindow = collectWindow(days, (day) => ghJsonRetry(['issue', 'list', '--state', 'all',
    '--search', `created:${day}`, '--limit', String(SEARCH_RESULT_CAP), '--json', 'number,title,labels']));
  const issueCap = applyCap(issueWindow.items, MAX_ISSUES);
  const issueCoverage = coverageWarnings('issues', issueWindow, issueCap.cut);
  if (issueCoverage.length) partialSources.add('issue-class');
  coverage.push(...issueCoverage);
  const allIssues = issueCap.items;
  for (const it of allIssues) {
    const cls = issueClass(it.title, it.labels);
    if (!cls) continue;
    issueCounts[cls] = (issueCounts[cls] || 0) + 1;
    (issueExamples[cls] ||= []).push({ issue: it.number, title: (it.title || '').slice(0, 80) });
  }

  // ---- 3. issue-fix outcomes via FIX_OUTCOME markers in issue comments ----
  // Marker contract (issue-fix.yml prompt): the fixer's terminal comment starts
  // with `<!-- FIX_OUTCOME: <code> -->`. We bucket the blocked/no-pr codes since
  // those are the recurring-burn signal; `pr-created` is the healthy path.
  const outcomeCounts = {};
  const outcomeExamples = {};
  // `max-turns` deaths that left commits on `fix/issue-<N>`: work the loop can still
  // land, not noise. Surfaced in the harvest output (and in $GITHUB_OUTPUT) so it is
  // visible without reading 31 run logs by hand.
  const recoverableMaxTurns = [];
  // `body` entra nella lista perche' i classificatori `isAvoidable*` lo leggono
  // (`issue.body`): prima la lista chiedeva solo number,title,labels e il body
  // arrivava sempre vuoto.
  // Il giorno corrente porta le issue piu' attive, cioe' quelle coi thread piu'
  // lunghi: la pagina con `comments` risponde 504 anche dopo i retry (run
  // 36333749234, `updated:2026-09-27`, 3 tentativi su 3). Li' si ricade sulla
  // lista leggera e sui commenti per issue, invece di perdere il giorno.
  const fixListArgs = (day, fields) => ['issue', 'list', '--state', 'all',
    '--search', `label:agent:triaged updated:${day}`, '--limit', String(SEARCH_RESULT_CAP), '--json', fields];
  // Un `view` fallito nel ripiego NON diventa `comments: []` in silenzio: la
  // issue finisce in `unreadItems` e la finestra si dichiara PARTIAL (review
  // di #10118), perche' i suoi marker FIX_OUTCOME mancano dal conteggio.
  const unreadFixIssues = [];
  const fixWindow = collectWindow(days, (day) => fetchDayWithFallback(
    () => ghJsonRetry(fixListArgs(day, 'number,title,labels,body,comments')),
    () => ghJsonRetry(fixListArgs(day, 'number,title,labels,body')),
    (it) => {
      const view = ghJsonRetry(['issue', 'view', String(it.number), '--json', 'comments']);
      if (!Array.isArray(view?.comments)) unreadFixIssues.push(it.number);
      return { ...it, comments: view?.comments || [] };
    },
  ));
  const fixCap = applyCap(fixWindow.items, MAX_ISSUES);
  const fixCoverage = coverageWarnings('fix-issues', fixWindow, fixCap.cut, unreadFixIssues);
  if (fixCoverage.length) partialSources.add('fix-outcome');
  coverage.push(...fixCoverage);
  const fixIssues = fixCap.items;
  for (const issue of fixIssues) {
    const { number } = issue;
    const labelNames = (issue.labels || []).map((l) => l.name);
    let comments = issue.comments || [];
    if (comments.length >= NESTED_PAGE_CAP) {
      const data = ghJson(['issue', 'view', String(number), '--json', 'comments']);
      if (data?.comments) comments = data.comments;
    }
    // Dedup PER-ISSUE: una stessa issue ri-accodata dal followup-drainer (rescue
    // a 3 tentativi) può postare lo STESSO marker N volte. Contarli tutti gonfia
    // il bucket (3 run di UNA issue → conta 3) e fa scattare l'escalation su una
    // soglia di issue-distinte falsata — è esattamente ciò che ha prodotto #1478.
    // La lezione cercata è «N issue DISTINTE bloccate da questo esito», non «N
    // commenti» → conta ogni codice al più una volta per issue. (Il re-queue è
    // ora fermato alla sorgente in followup-drainer.mjs, ma il dedup rende il
    // conteggio robusto anche allo storico e a ri-tentativi manuali.)
    // Lo stesso principio dedup-per-sorgente vale per i reviewer-finding sopra,
    // dove la chiave è la PR (vedi tallyFindings).
    const seenThisIssue = new Set();
    // A `pr-created` marker anywhere on the issue means a fixer run delivered a PR
    // (open or merged) — so a `max-turns` death is post-delivery overrun, not a
    // fixable loop (escalation #2653). Pre-scan once; per-issue dedup already
    // collapses re-queued runs, and a delivered PR means the work landed.
    const hasDeliveredPr = comments.some((c) =>
      /<!--\s*FIX_OUTCOME:\s*pr-created\s*-->/i.test(String(c.body || '')));
    for (const c of comments) {
      const m = FIX_OUTCOME_RE.exec(String(c.body || ''));
      if (!m) continue;
      const code = m[1].toLowerCase();
      if (code === 'pr-created') continue; // healthy
      // Backstop-emitted fallbacks (issue-fix.yml "post-step deterministico") tag
      // crashed/max_turns runs — expected catch-all, not a doc-rule violation.
      // Counting them inflates no-pr-unspecified → feedback loop: escalation keeps
      // re-firing even after the backstop fix (PR #1067) landed.
      if (String(c.body || '').includes('post-step deterministico')) continue;
      // SAME feedback-loop, `already-fixed` flavour: the zero-Claude pre-flight gate
      // (check-issue-already-resolved.mjs, structural fix #1647) and the scheduled
      // reconciler (reconcile-followups.mjs) BOTH post `<!-- FIX_OUTCOME: already-fixed -->`
      // when they short-circuit a done-but-open follow-up WITHOUT ever spending a Claude
      // run. Counting those as burn makes the structural fix re-escalate ITSELF (#2123:
      // bucket re-fired at 10/14d even though the gate had already shipped). Only a
      // marker from a genuine Claude fixer run is recurring-burn signal → skip the
      // deterministic short-circuit comments (carry the `<!-- reconcile-bot -->` marker
      // and the "Pre-flight (auto, zero-Claude)" / "Reconcile (auto)" signature).
      const cb = String(c.body || '');
      if (cb.includes('reconcile-bot') ||
          cb.includes('Pre-flight (auto, zero-Claude)') ||
          cb.includes('Reconcile (auto)') ||
          // SAME feedback-loop, drainer pre-flight flavour (structural fix #2291):
          // followup-drainer.mjs posta `no-root-cause` / `blocked-*` DETERMINISTICAMENTE
          // quando rileva body malformato o audit-curl PRIMA di spendere un run Claude.
          // Contarli come burn gonfia il bucket e ri-scalderebbe l'escalation stessa.
          cb.includes('Pre-flight drainer (zero-Claude')) continue;
      // `already-fixed` on an issue the pre-flight gate could NEVER safely have
      // short-circuited (aggregate follow-up, or non-follow-up out of gate scope)
      // is the EXPECTED confirmation path, not preventable burn → don't escalate it
      // (root cause of #2290: bucket re-fired at 9/14d, all 5 examples aggregate or
      // non-follow-up). Single-item follow-ups — the gate's real target — still count.
      if (code === 'already-fixed' && !isAvoidableAlreadyFixed(issue.title, labelNames, issue.body || '')) continue;
      // `max-turns` on an aggregate multi-item issue (over-budget by construction,
      // the per-item circuit-breaker's target) or on an issue the drainer has already
      // parked `automation-deferred` (structurally non-fixable: malformed body / network-audit
      // / repeated-death) is an EXPECTED deterministic death, not a fixable loop → no
      // actionable structural fix beyond what shipped (#2291 + circuit-breaker), so
      // don't escalate it (root cause of #2439: bucket re-fired at 14/14d, examples
      // dominated by aggregate / parked runs). Single-item still-routable deaths count.
      if (code === 'max-turns') {
        // Consult the BRANCH, not just the PR: a cap hit after the WIP checkpoint left
        // commits on `fix/issue-<N>` that a retry can resume from (or a human can open a
        // PR from, as happened with #5767 → PR #5774). Recognised here so the work stops
        // being invisible — recoverableMaxTurns surfaces it in the harvest output — and
        // so the bucket stops treating a partial delivery as a fixable loop.
        const recoverable = hasDeliveredPr ? null : recoverableWorkOnBranch(number, comments);
        if (recoverable && !recoverableMaxTurns.some((r) => r.issue === number)) {
          recoverableMaxTurns.push({ issue: number, title: (issue.title || '').slice(0, 80), ...recoverable });
        }
        if (!isAvoidableMaxTurns(issue.title, labelNames,
          { hasDeliveredPr, hasRecoverableBranch: Boolean(recoverable) }, issue.body || '')) continue;
      }
      // `overlap-skip` / `pr-already-open`: deferral by the loop's own scheduling rule,
      // declared TRANSIENT by followup-drainer.mjs — expected, not preventable burn. Only
      // an overlap on an issue that ALREADY had its PR open is a real gate gap (hasFixPR).
      if ((code === 'overlap-skip' || code === 'pr-already-open') &&
          !isAvoidableOverlapSkip(issue.title, labelNames, hasDeliveredPr)) continue;
      // `no-root-cause` on a verified-transient monitor blip or an explicit
      // unmet-epic-dependency block is an EXPECTED correct abort, not a
      // diagnosis failure the prose rule could ever prevent (#4580: all 5
      // examples were one of these two, none a genuine stuck-diagnosis).
      if (code === 'no-root-cause' && !isAvoidableNoRootCause(cb)) continue;
      const k = `fix-outcome:${code}`;
      if (seenThisIssue.has(k)) continue;
      seenThisIssue.add(k);
      outcomeCounts[k] = (outcomeCounts[k] || 0) + 1;
      (outcomeExamples[k] ||= []).push({ issue: number, at: c.createdAt });
    }
  }

  // ---- Dedup vs existing doc-contracts ----
  let corpus = '';
  for (const f of DOC_FILES) { try { corpus += '\n' + fs.readFileSync(f, 'utf-8').toLowerCase(); } catch { /* ignore */ } }

  // ---- Post-fix re-escalation guard (escalation #4578, see lastEscalationClosedAt) ----
  // Sources whose examples carry a per-example `at` timestamp can be filtered
  // against a bucket's last shipped fix: fix-outcome (`at` = the FIX_OUTCOME
  // comment's createdAt) and reviewer-finding (`at` = the PR's mergedAt, #5516 —
  // without this, a reviewer-finding bucket like sibling-class-fix re-fires
  // forever on the SAME pre-fix PRs still sitting in the trailing window,
  // indistinguishable from a shipped fix that never worked). issue-class isn't
  // an escalation driver at all (isEscalationDriver), so it's excluded here too.
  // Fetched once, reused per bucket key inside consider().
  const closedEscalations = ghJson(['issue', 'list', '--state', 'closed',
    '--search', 'ricorre nonostante regola in:title',
    '--json', 'number,title,closedAt', '--limit', '100']) || [];
  // Le escalation riaperte non sono fra le chiuse: la loro ultima chiusura si
  // legge dagli eventi (vedi reopenedEscalationClosures). Lettura fallita →
  // nessun cutoff per quel bucket, cioe' il conteggio pieno di prima.
  const openEscalationsRead = ghJson(['issue', 'list', '--state', 'open',
    '--search', 'ricorre nonostante regola in:title',
    '--json', 'number,title', '--limit', '100']);
  if (!Array.isArray(openEscalationsRead)) {
    console.log('::warning::escalation aperte illeggibili: cutoff delle riaperte non determinabile → conteggio sull\'intera finestra');
  }
  const openEscalationsAtStart = openEscalationsRead || [];
  const reopened = reopenedEscalationClosures(openEscalationsAtStart, (number) => parseIssueEventLines(
    gh(['api', `repos/{owner}/{repo}/issues/${number}/events?per_page=100`, '--paginate',
      '--jq', ISSUE_EVENTS_JQ])));
  for (const n of reopened.unreadable) {
    console.log(`::warning::escalation #${n}: eventi illeggibili, cutoff non determinabile → conteggio sull'intera finestra`);
  }
  const escalationClosures = [...closedEscalations, ...reopened.closures];
  // La misura di ogni bucket visto nella finestra, anche sotto soglia: il
  // self-heal la riporta nel commento di chiusura.
  const bucketMeasures = new Map();

  // ---- Registro delle decisioni (vedi parseLessonsRegistry) ----
  const registryPath = process.env.HARVEST_REGISTRY || LESSONS_REGISTRY_PATH;
  const registry = loadLessonsRegistry(registryPath);

  // ---- Assemble clusters above threshold + novel ----
  const clusters = [];
  // `driver`: clusters that can drive a doc-rule proposal (an agent repeating a
  // mistake or hitting a wall). issue-class counts are operational VOLUME handled
  // by triage/monitors, not instruction signal → included as context, never a
  // proposal driver (novel stays false for them). Per-key, not blanket per-source
  // (see isEscalationDriver, #4750): `fix-outcome:no-root-cause` is carved out the
  // same way even though its source is otherwise driver-eligible.
  const consider = (source, counts, examples) => clusters.push(...considerBuckets({
    source, counts, examples, corpus, registry, escalationClosures, bucketMeasures }));
  consider('reviewer-finding', findingCounts, findingExamples);
  consider('fix-outcome', outcomeCounts, outcomeExamples);
  consider('issue-class', issueCounts, issueExamples);

  clusters.sort((a, b) => b.count - a.count);
  const novel = clusters.filter((c) => c.novel);
  const escalations = clusters.filter((c) => c.recurringDespiteRule);
  // Bucket di argomento sopra soglia: solo report (decisione I3 del 2026-10-05).
  const topicReportOnly = clusters.filter((c) => c.topicAboveLimit);

  const result = { generatedForWindowDays: WINDOW_DAYS, threshold: THRESHOLD,
    efficacyFactor: EFFICACY_FACTOR, since: sinceDay, totalClusters: clusters.length,
    novelClusters: novel.length, escalationClusters: escalations.length,
    topicReportOnlyClusters: topicReportOnly.length, clusters,
    recoverableMaxTurns,
    registry: { path: registryPath, entries: registry.entries.size, missing: Boolean(registry.missing),
      errors: registry.errors },
    coverage: { days: days.length, mergedPrs: mergedPrs.length, issues: allIssues.length,
      fixIssues: fixIssues.length, partial: coverage.length > 0, warnings: coverage } };
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));

  // ---- Human summary ----
  console.log(`Lessons harvest — window ${WINDOW_DAYS}d (since ${sinceDay}), threshold ≥${THRESHOLD}`);
  console.log(`Registro decisioni: ${registry.entries.size} voci (${registryPath}${registry.missing ? ', assente' : ''})`);
  for (const e of registry.errors) console.log(`::warning::registro ${registryPath}: ${e}`);
  console.log(`Merged PRs scanned: ${mergedPrs.length} · issues scanned: ${allIssues.length} · fix-issues: ${fixIssues.length}` +
    ` · window: ${days.length} days, ${coverage.length ? 'PARTIAL' : 'complete'}`);
  for (const w of coverage) console.log(w);
  if (!clusters.length) console.log('No recurring clusters above threshold.');
  for (const c of clusters) {
    const tag = clusterReportTag(c);
    const reg = c.registry
      ? ` [registro ${c.registry.outcome} ${c.registry.decidedAt} ${c.registry.ref}, +${c.registry.examplesSinceDecision} dopo]`
      : '';
    const sinceCutoff = c.cutoffAt ? ` · dopo il cutoff ${c.cutoffAt}: ${c.effectiveCount}` : '';
    console.log(`  [${tag}] ${c.source}/${c.key} ×${c.count}${sinceCutoff}${reg}` +
      (c.examples?.length ? `  e.g. ${c.examples.map((e) => '#' + (e.pr || e.issue)).join(',')}` : ''));
  }
  console.log(`\n→ novel recurring clusters: ${novel.length} · escalations (documented-but-recurring): ${escalations.length}` +
    ` · argomenti sopra soglia, solo report: ${topicReportOnly.length}`);
  if (recoverableMaxTurns.length) {
    console.log(`\n♻️  max-turns con lavoro RECUPERABILE sul branch (commit avanti a main, nessuna PR): ${recoverableMaxTurns.length}`);
    for (const r of recoverableMaxTurns) {
      console.log(`   #${r.issue} → ${r.branch} (+${r.aheadBy} commit) — ${r.title}`);
    }
    // ANNOTA, non solo stampa. Questo blocco stampava e finiva qui, e
    // `recoverable_max_turns` in `$GITHUB_OUTPUT` non è letto da nessuno step
    // (verificato: `lessons-harvester.yml` non lo nomina). Il risultato era una
    // misura corretta che non raggiungeva nessuno: il 2026-08-24 sul sito
    // c'erano **5** branch con lavoro reale — `fix/issue-6315`, `#6270`,
    // `#6206` (3 commit), `#6147`, `#5975` — invisibili a ogni strato, perché
    // `stale-pr-rescuer`, `recycle-stale-prs` e `pr-autorebase` raccolgono PR e
    // un branch senza PR non ne ha mai avuta una.
    //
    // Il dedup sul marker non è una rifinitura: senza, questo commento
    // tornerebbe a ogni run dell'harvester (daily), e un commento di bot alza
    // `updatedAt` — che è esattamente ciò che affama il cooldown del
    // parked-retry e l'age-out del drainer. Il rilevatore diventerebbe la causa
    // del blocco che aiuta a diagnosticare.
    let annotated = 0;
    let already = 0;
    for (const r of recoverableMaxTurns) {
      let comments = [];
      try {
        comments = ghJson(['api', `repos/{owner}/{repo}/issues/${r.issue}/comments?per_page=100`, '--paginate']) || [];
      } catch { continue; } // illeggibile → si rivaluta al run successivo, mai un doppio commento
      if (hasOrphanNote(Array.isArray(comments) ? comments : [])) { already++; continue; }
      try {
        gh(['issue', 'comment', String(r.issue), '--body', orphanNoteBody(r)]);
        annotated++;
      } catch (e) {
        console.log(`::warning::annotazione di #${r.issue} fallita: ${String(e).slice(0, 120)}`);
      }
    }
    console.log(`   annotazioni — nuove=${annotated} già-annotate=${already} su ${recoverableMaxTurns.length}`);
  }

  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT,
      `has_novel=${novel.length > 0}\nnovel_count=${novel.length}\n` +
      `has_escalation=${escalations.length > 0}\nescalation_count=${escalations.length}\n` +
      `recoverable_max_turns=${recoverableMaxTurns.length}\n`);
  }

  // ---- Escalation issues: DETERMINISTIC + dedup-by-construction (zero Claude) ----
  // Previously the Claude step was told to open one escalation issue per
  // `recurringDespiteRule` cluster and dedup by re-searching the title. That
  // soft, LLM-driven dedup drifted (same bucket filed under `source/key` AND
  // `source:key`) and re-fired every run → duplicate escalations piled up
  // (i18n-naming ×4, blocked-workflows-scope ×5, …). Emit them from code with a
  // SINGLE canonical title + the hardened code-level dedup in
  // github-issue-creator.mjs (comments on the open canonical instead of
  // duplicating). The Claude step now handles ONLY novel doc-rule proposals.
  // Gate: emit only when explicitly enabled (the workflow sets this). Keeps local
  // dry-runs and tests from minting real GitHub issues.
  if (process.env.HARVEST_EMIT_ESCALATIONS === 'true') {
    // 1. EMIT/UPDATE: una issue canonica per bucket attivo. createGithubIssue
    //    dedupa (commenta sul canonico se esiste). Poi bump SEVERITÀ in base al
    //    count (recidiva → severity sale, non si accumula un'altra issue).
    for (const c of escalations) {
      try {
        const res = await createGithubIssue({
          title: escalationTitle(c),
          description: escalationBody(c),
          signals: buildEscalationSignals(c),
          priority: 2,
          labels: ['follow-up'],
          workflow: 'Lessons harvester',
        });
        const num = res?.number;
        if (num) {
          const sev = severityLabelForCount(c.effectiveCount ?? c.count);
          const drop = sev === 'severity:high' ? 'severity:medium' : 'severity:high';
          try {
            gh(['label', 'create', sev, '--color', sev === 'severity:high' ? 'B60205' : 'D93F0B', '-f']);
          } catch { /* label esiste già */ }
          try {
            gh(['issue', 'edit', String(num), '--add-label', sev, '--remove-label', drop]);
          } catch (e) { process.stderr.write(`sev bump #${num} fallito: ${e.message}\n`); }
        }
      } catch (err) {
        process.stderr.write(`escalation emit failed for ${c.source}/${c.key}: ${err.message}\n`);
      }
    }

    // 2. SELF-HEAL CLOSE: un'escalation aperta il cui bucket NON è più tra quelli
    //    attivi → chiudila con la misura (drena il ratchet; si riapre se
    //    ricorre). Mai con un pin o un claim, mai su una vista parziale della
    //    finestra, mai sopra soglia (vedi selfHealDecision).
    //    Search via la frase senza parentesi (le `(` rompono gh search → era il
    //    blind-spot del monitoring) e filtro per titolo esatto.
    const liveKeys = new Set(escalations.map((c) => `${c.source}/${c.key}`));
    const openEsc = (ghJson([
      'issue', 'list', '--state', 'open', '--search', 'ricorre nonostante regola in:title',
      '--json', 'number,title,labels', '--limit', '100',
    ]) || []).filter((i) => parseEscalationKey(i.title));
    for (const iss of openEsc) {
      const key = parseEscalationKey(iss.title);
      if (liveKeys.has(key)) continue; // ancora attivo → lascia aperta
      if (NO_AUTOCLOSE) {
        console.log(`SELF-HEAL close skipped #${iss.number} — no-autoclose`);
        continue;
      }
      const decision = selfHealDecision({ key, labels: iss.labels, measure: bucketMeasures.get(key) || null,
        cutoffMs: lastEscalationClosedAt(key, escalationClosures), partialSources });
      if (decision.action !== 'close') {
        console.log(`SELF-HEAL close skipped #${iss.number} — ${decision.reason}`);
        continue;
      }
      try {
        gh(['issue', 'comment', String(iss.number), '--body', decision.comment]);
        gh(['issue', 'close', String(iss.number), '--reason', 'completed']);
        console.log(`SELF-HEAL close #${iss.number} — bucket ${key}: ${decision.reason}`);
      } catch (e) {
        process.stderr.write(`self-heal close #${iss.number} fallito: ${e.message}\n`);
      }
    }
  }
}

// Run only as a script, never on import (lets the test import the pure helpers
// above without firing gh / writing files). Same guard convention as
// auto-merge-eval.mjs.
if ((() => { try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; } })()) {
  await main();
}
