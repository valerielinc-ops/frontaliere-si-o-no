/**
 * followup-drainer.mjs — gestore coda follow-up (zero-Claude, deterministico).
 *
 * Risolve la STARVATION osservata 2026-06-04: `issue-fix.yml` ha un solo slot
 * concurrency globale (`group: issue-fix`, `cancel-in-progress: false`). GitHub
 * con cancel=false CANCELLA le run PENDING tenendo solo l'in-progress + l'ultima
 * queued. In un burst di follow-up auto-routati a agent:fix → 60% delle fix-run
 * cancellate-in-coda, mai ri-tentate (nessun nuovo evento `labeled`), ~20 issue
 * bloccate `agent:fix` ma non lavorate.
 *
 * Design (vedi AUTONOMOUS-LOOP-DESIGN): i follow-up non ricevono più `agent:fix`
 * diretto da triage ma `agent:fix-queued`. Questo drainer (cron ~20min +
 * workflow_run dopo issue-fix) promuove UNO alla volta a `agent:fix`, e SOLO
 * quando lo slot issue-fix è libero → la run promossa è l'unica pending → non
 * viene mai cancellata. Starvation eliminata per costruzione.
 *
 * Termina autonomamente (no human): un follow-up promosso che non produce PR
 * (run cancellata/error_max_turns) viene rilevato come orfano e RI-ACCODATO con
 * `fu-attempt:N` incrementato; a N>=MAX_ATTEMPTS → `fu-parked` (esce dalla coda
 * attiva, nessuna perdita: resta aperto, ri-tentabile a mano/in futuro).
 *
 * Tutte le mutazioni label passano dal PAT (GH_TOKEN=GITHUB_PAT a monte) così il
 * `labeled` agent:fix triggera issue-fix (GITHUB_TOKEN no, anti-ricorsione).
 *
 * Uso:  node scripts/ci/followup-drainer.mjs [--dry-run]
 * Env:  GH_TOKEN (PAT), GITHUB_REPOSITORY (owner/repo). Richiede `gh` in PATH.
 *
 * Estensione 2026-07-05 (owner decision, guardrail category-based rimosse):
 * `classify-issue.mjs` ora assegna `route='queue'` a OGNI categoria tranne
 * `crawler` (che resta `route='fix'` immediato). Questo drainer, nato per i
 * follow-up, gestisce quindi la STESSA coda anche per revenue/tracker/
 * validation-failure/other — vedi `isQueueManaged` sotto, che sostituisce i
 * check hardcoded su `has(iss,'follow-up')`.
 *
 * Estensione 2026-08-10 (#5514): i crawler, unica categoria `route='fix'`, erano
 * per ciò stesso l'unica ESCLUSA dal rescue (`isQueueManaged`) — e una loro run
 * cancellata dalla coda concurrency non veniva né ri-accodata né parkata né
 * marcata `needs-human`. Ora hanno un rescue proprio, gemello di quello
 * queue-managed: vedi `crawlerFixDecision`.
 */
import { execFileSync } from 'node:child_process';
import { classifyIssue } from '../lib/classify-issue.mjs';
import {
  CODE_PATH_RE,
  detectWorkflowScoped,
  extractWorkflowRefs,
  repoRelativeTail,
} from '../lib/workflow-scope-detect.mjs';
import {
  detectRemoteConfigScoped,
  detectSecretsScoped,
  matchSecretsScopedLabel,
  matchSecretsScopedShape,
} from '../lib/secrets-scope-detect.mjs';
import { isBackoffActive, maxQuotaResetsAt } from './claude-rate-limit.mjs';
import { runBudgetFromEnv } from './lib/run-budget.mjs';

export {
  detectWorkflowScoped,
  detectSecretsScoped,
  matchSecretsScopedLabel,
  detectRemoteConfigScoped,
  matchSecretsScopedShape,
};

// --- BUDGET DI RUN (#5162) ---------------------------------------------------
// Il job `drain` ha 6 minuti per SETUP + LAVORO, e il setup non è una costante:
// `actions/checkout` su questo repo (10,5 GB) costa ~113s nel caso normale ma ha
// una coda lunga — nel run 31037187242 ha preso 6m10s da solo e il job è stato
// ucciso PRIMA che questo script partisse. Quando invece parte, gli restano i
// minuti che il checkout non ha consumato: un numero variabile che lo script non
// conosceva. La deadline assoluta esportata dal workflow glielo dice, così i
// loop qui sotto si fermano puliti invece di essere ammazzati a metà di un item
// (una issue tolta dalla coda ma non promossa, un commento di age-out postato su
// una issue mai chiusa).
const budget = runBudgetFromEnv();
// Costo per item: un'azione di age-out sono 2 chiamate gh (comment + close), un
// rescue/park 1-2 (view commenti + edit label). 8s copre entrambe con margine.
const ITEM_COST_MS = Number(process.env.FOLLOWUP_ITEM_COST_MS || 8_000);

const DRY = process.argv.includes('--dry-run');
const REPO = process.env.GITHUB_REPOSITORY || '';
// Exported (#5524 item 3) so a test can tie this number to the `fu-attempt:N`
// labels that actually exist in the repo (`ROUTING_LABELS` in
// triage-sweep.mjs) instead of the two constants drifting apart in silence —
// `gh issue edit --add-label` fails on a label that was never created, so a
// bump here without a matching label would strand issues at the new ceiling
// forever, unnoticed (no error, just a park that never reaches `needs-human`
// nor gets excluded from re-triage by `ROUTING_LABELS`).
export const MAX_ATTEMPTS = 3;
// Cap di letture `gh issue view` per la scansione del beacon di quota. Il beacon
// sta sull'ultima issue processata, quindi in regime normale si trova alla prima
// o seconda lettura; il cap serve solo a impedire che una coda lunga trasformi il
// guard in un costo lineare sul backlog.
const QUOTA_SCAN_MAX = Number(process.env.FOLLOWUP_QUOTA_SCAN_MAX || 8);
// Margine prima di considerare un agent:fix "orfano" (la run deve aver avuto il
// tempo di partire + aprire la PR). Conservativo per non ri-accodare run vive.
const ORPHAN_MIN_AGE_MIN = 30;
// Finestra di "assestamento" promozione: copre SOLO la latenza secondi tra
// `gh issue edit --add-label agent:fix` e la comparsa della run in `gh run list`
// (race-visibilità #1339). NON va confusa con ORPHAN_MIN_AGE_MIN: il vero
// serializzatore anti-doppia-promozione è `inFlightFixCount()` (run queued/
// in_progress), che fa `return` in cima. Prima il settling riusava i 30min
// dell'orfano → un fix COMPLETATO-FALLITO (no PR) restava "settling" per 30min e
// BLOCCAVA il drain fino al cron throttlato (stallo osservato 2026-06-14 21:00Z:
// coda 21 ferma ~40min). 3min coprono la registrazione con ampio margine senza
// incatenare il drain a un fix già finito.
const SETTLE_MIN = Number(process.env.FOLLOWUP_SETTLE_MIN || 3);

const LBL_QUEUED = 'agent:fix-queued';
const LBL_FIX = 'agent:fix';
const LBL_PARKED = 'fu-parked';
// Issue-contatore/tracker permanenti (#5615): il ledger crawler-transient e il
// tracker loop-health sono queue-managed (category='other' → route='queue',
// nessuna regex di categoria li riconosce), quindi altrimenti eleggibili
// all'age-out come qualunque follow-up vecchio+inattivo. La loro "inattività"
// però è il segnale sano — sopravvivono SOLO perché i fallimenti sub-soglia
// che contano li ri-commentano; un periodo di crawler sani li lascia fermi e
// il drainer li chiuderebbe, azzerando lo streak che contano. Riconoscerli dal
// titolo sarebbe fragile (proxy, non fatto) — una label esplicita applicata
// alla creazione (github-issue-creator.mjs, loop-health-report.mjs) è verificata
// qui, indipendente da età/inattività.
const LBL_NO_AGE_OUT = 'agent:no-age-out';

// Age-out close: il post-merge-followup apre 1 follow-up per PR mergiata e
// NESSUN workflow le chiude mai → ratchet monotòno (osservate 41 aperte). Un
// follow-up vecchio, inattivo e NON in lavorazione (né agent:fix né
// agent:fix-queued) non verrà mai drenato: chiudilo (riapribile se ricorre). I
// `fu-parked` (tentativi esauriti) sono i candidati principali. Drain, non
// perdita: commento esplicito + reversibile. 0 disabilita.
const AGEOUT_DAYS = Number(process.env.FOLLOWUP_AGEOUT_DAYS || 10);
const AGEOUT_INACTIVE_DAYS = Number(process.env.FOLLOWUP_AGEOUT_INACTIVE_DAYS || 7);
const AGEOUT_MAX_PER_RUN = Number(process.env.FOLLOWUP_AGEOUT_MAX_PER_RUN || 20);

// Esiti FIX_OUTCOME (contratto ISSUES.md: il fixer chiude ogni run con
// `<!-- FIX_OUTCOME: <code> -->`) DETERMINISTICI: rieseguire il fixer sullo
// stesso body riprodurrebbe identico verdetto → re-queue = solo quota Claude
// bruciata a vuoto. Root cause #1478 (no-root-cause ×6/14gg): il rescue qui
// sotto vedeva «agent:fix vecchio senza PR» e ri-accodava, ma un'ABORT pulita
// (root cause assente, capability/scope mancante, giudizio umano, già risolto)
// NON è una run morta da ri-tentare — è un verdetto fermo. Park subito invece
// di consumare i tentativi residui (3 run identiche → 1). Esclusi di proposito:
// `overlap-skip`/`pr-already-open` (transienti: la PR bloccante può mergiare →
// ri-tentabile) e l'ASSENZA di marker (run crashata/max_turns davvero orfana →
// rescue normale). `pr-created` non arriva qui: `hasFixPR` lo intercetta prima.
// `skip-duplicate-diagnosis` (#5288): stesso verdetto fermo di
// `blocked-workflows-scope`, da cui è stato separato solo per non far salire il
// bucket dell'harvester quando il guard FUNZIONA (vedi check-workflows-scope.mjs,
// "Two outcome codes, not one"). Deve restare qui: il Mode 2 che l'ha emesso è
// deterministico sul titolo, quindi ri-accodare la issue riprodurrebbe identico
// il verdetto bruciando tentativi. Ometterlo sarebbe una regressione silenziosa
// introdotta dalla sola rinomina del codice.
export const NON_RETRYABLE = new Set([
  'no-root-cause',
  'blocked-workflows-scope',
  'skip-duplicate-diagnosis',
  'blocked-secrets',
  'blocked-admin-settings',
  'revenue-tracker-manual',
  'already-fixed',
]);

// Esiti ZERO-WORK: la run è morta PRIMA che l'agent leggesse la issue, quindi
// non ha prodotto alcuna informazione — né un fix, né un verdetto, né una
// diagnosi. Sono l'esatto opposto sia di NON_RETRYABLE (verdetto fermo → park)
// sia di una run crashata a metà lavoro (→ rescue con tentativo consumato):
// qui la issue è INTATTA e va rimessa in coda **senza consumare un tentativo**.
//
// Root cause (misurata 2026-08-05 sui log di tutte e 61 le run fallite di
// issue-fix nella finestra 7gg 2026-07-29 → 08-05): 60 sono HTTP 429 con
// `num_turns: 1` e `total_cost_usd: 0`. Il payload di un 429 ha
// `"subtype": "success"` con `is_error: true`, quindi il vecchio step
// subtype-gated di issue-fix.yml non emetteva marker granulare; restava il
// backstop `no-pr-unspecified`, che questo file scarta di proposito
// (BACKSTOP_MARKER) → `latestFixOutcome()` null → «run davvero morta,
// ri-tentabile» → `fu-attempt`++ → ri-promossa contro la stessa quota ancora
// esaurita → altri due 429 → `fu-attempt:3` → `fu-parked` → e, da parked, l'age-out
// close la chiudeva «not planned» dopo 10 giorni. Osservato su #5008 #5004
// #5001 #4974: issue mai lette da nessun agent, uscite dal loop autonomo per
// esaurimento di una quota che non aveva niente a che vedere con loro.
//
// Questo è lo stato assorbente lato fixer, gemello di quello del grafo di
// recupero PR fixato in #5099: un verdetto che nessun predicato copriva.
export const ZERO_WORK = new Set(['rate-limited']);

const FIX_OUTCOME_RE = /<!--\s*FIX_OUTCOME:\s*([a-z0-9-]+)\s*-->/i;
// I fallback deterministici del backstop (issue-fix.yml "post-step
// deterministico") taggano run crashate/max_turns con un marker generico: NON
// sono il verdetto diagnostico del fixer → vanno ignorati, così una run morta
// resta ri-tentabile (mirror della stessa guardia in harvest-agent-lessons.mjs).
const BACKSTOP_MARKER = 'post-step deterministico';

/**
 * Codice dell'ULTIMO marker FIX_OUTCOME (commento più recente) di una lista di
 * commenti, o null. Pura (niente gh) → testabile. Ignora i fallback del
 * backstop così solo i verdetti autentici del fixer contano.
 * @param {Array<{body?: string, createdAt?: string}>} comments
 */
export function latestFixOutcomeFromComments(comments) {
  let latest = null;
  let latestAt = -Infinity;
  for (const c of comments || []) {
    const body = String(c?.body || '');
    if (body.includes(BACKSTOP_MARKER)) continue;
    const m = FIX_OUTCOME_RE.exec(body);
    if (!m) continue;
    const at = Date.parse(c?.createdAt);
    // `>=` così, a parità (o data illeggibile → NaN ignorato), vince l'ultimo
    // in ordine di lista (i commenti gh sono cronologici).
    if (!Number.isNaN(at) && at >= latestAt) { latestAt = at; latest = m[1].toLowerCase(); }
  }
  return latest;
}

// --- WORKFLOW-SCOPE PRE-FLIGHT (escalation #1724) ---------------------------
// `fix-outcome:blocked-workflows-scope` ricorre 13×/14gg: ogni occorrenza è una
// follow-up DISTINTA il cui fix tocca file `.github/workflows/**`, che il token
// GitHub App di issue-fix NON può pushare (manca lo scope `workflows`). Il
// drainer parka già quel verdetto a posteriori (NON_RETRYABLE), ma solo DOPO che
// il primo run Claude ha bruciato ~1M token per scoprire il blocco. Questa
// pre-flight deterministica lo rileva PRIMA della promozione a agent:fix.
//
// Detection logic (WORKFLOW_PATH_RE/BARE_YML_RE/NON_WORKFLOW_YML/CODE_PATH_RE/
// detectWorkflowScoped) is shared with check-workflows-scope.mjs via
// ../lib/workflow-scope-detect.mjs — see that module's docstring for the
// bias-to-promote rationale and the #4437 false-positive-loop incident that
// motivated extracting it out of a hand-duplicated copy.

// --- MALFORMED-BODY & NETWORK-AUDIT PRE-FLIGHT (escalation #2291) -----------
// `fix-outcome:max-turns` ricorre ≥7×/14gg (dal 2026-06-02): due sottoclassi
// distinte emergono dai run esaminati che bruciano il budget DETERMINISTICAMENTE:
//
// 1. MALFORMED BODY (#2098-class): il body dell'issue è vuoto / stub ("test") o
//    è un'issue aggregata che manca del template FOLLOWUP.md (nessuna sezione
//    ## Origine / ### N. item). Il fixer non trova contesto, gira in tondo, muore.
//
// 2. NETWORK-AUDIT (#2224-class): il `## Suggested action` dice esplicitamente
//    "network-enabled audit" (phrase canonica FOLLOWUP.md) o "audit curl": il fix
//    richiede una verifica HTTP su URL esterni PRIMA di poter toccare il codice.
//    Il fixer ha solo `Bash(node:*)` in allowedTools (no `curl` diretto): deve
//    scrivere script node inline → multi-turno → error_max_turns deterministico.
//
// Pattern: pre-flight CONSERVATIVO (bias a PROMUOVERE) — stessa filosofia di
// detectWorkflowScoped. Park con `needs-human` per evitare ri-accodo (parked-retry
// loop) su issue strutturalmente non-fixabili dall'automazione CI.

/**
 * Vero se il body dell'issue è troppo corto/malformato per consentire al fixer
 * di operare senza bruciare turni in cerca di contesto inesistente. Pura → testabile.
 * @param {string} title
 * @param {string} body
 */
export function detectMalformedBody(title, body) {
  const b = String(body || '').trim();
  if (b.length < 50) return true; // empty or stub (e.g. "test")
  // Issue aggregata (N items deferred) senza struttura FOLLOWUP.md:
  // ## Origine / ## Item / ### N. assenti → post-merge-followup malformato.
  if (/\b\d+\s+items?\s+deferred\b/i.test(String(title || ''))) {
    const hasStructure = /^##\s+(Origine|Item)\b/mi.test(b) || /^###\s+\d+\.\s/m.test(b);
    if (!hasStructure) return true;
  }
  return false;
}

/**
 * Vero se il `## Suggested action` della follow-up richiede esplicitamente un
 * audit HTTP/curl su URL esterni come PREREQUISITO al fix del codice. Il fixer
 * non ha `curl` in allowedTools (solo `Bash(node:*)`); deve scrivere inline
 * node HTTP → molti turni → error_max_turns deterministico. Pura → testabile.
 * @param {string} title
 * @param {string} body
 */
export function detectExplicitNetworkAudit(title, body) {
  const s = String(title || '') + '\n' + String(body || '');
  // Segnali espliciti: "network-enabled audit" (phrase canonica FOLLOWUP.md) o
  // "audit curl" (phrasing italiano comune). Entrambi indicano che la fase di
  // verifica HTTP PRECEDE qualsiasi modifica al codice sorgente.
  return /network-enabled\s+audit|audit\s+curl/i.test(s);
}

// --- EPIC-TRACKER PRE-FLIGHT (escalation #4517) -----------------------------
// `fix-outcome:revenue-tracker-manual` ricorre 10×/14gg (dal 2026-07-18): un
// batch di issue `[EPIC] ...` auto-filate da un audit esplorativo 3-agent
// delega l'intero scope implementativo a una sezione `## Sub-issues` che
// elenca sub-issue GIÀ aperte e GIÀ instradate nella propria coda
// `agent:fix-queued`/`agent:fix` indipendente. L'epic in sé non ha un
// target-file proprio da editare: ogni promozione a `agent:fix` fa fare a
// Claude la STESSA diagnosi (leggere le sub-issue, verificare che siano già in
// coda, controllare overlap-file) per arrivare sempre alla stessa conclusione
// — "nessuna azione di codice qui, tracker di coordinamento" — bruciando un
// run Claude completo per OGNI epic distinta (verificato live: #4459 #4462
// #4465 #4468 #4478, tutte filate lo stesso giorno con identico esito). La
// regola prosa (ISSUES.md categoria `tracker`: "piano umano multi-step") non
// preveniva la ricorrenza — questo detector la rende IMPOSSIBILE BY
// CONSTRUCTION: park pre-promozione, zero token Claude.
//
// CONSERVATIVO (bias a PROMUOVERE — un falso park ritarderebbe un fix
// legittimo): serve la combinazione ESATTA titolo `[EPIC] ...` + sezione
// `## Sub-issues` con ALMENO un riferimento `#N`. Un `[EPIC]` senza quella
// sezione (o con la sezione vuota) promuove normale — potrebbe comunque avere
// uno scope implementabile direttamente.
const SUB_ISSUES_HEADING_RE = /^##\s+Sub-issues\b/im;

/** Testo della sezione `## Sub-issues` (fino alla prossima `##` o a fine body), o '' se assente. */
function subIssuesSection(body) {
  const b = String(body || '');
  const headingMatch = SUB_ISSUES_HEADING_RE.exec(b);
  if (!headingMatch) return '';
  const afterHeading = b.slice(headingMatch.index + headingMatch[0].length);
  const nextHeadingIdx = afterHeading.search(/^##\s+/m);
  return nextHeadingIdx === -1 ? afterHeading : afterHeading.slice(0, nextHeadingIdx);
}

/**
 * Vero se l'issue è un epic di coordinamento che delega l'intero scope a
 * sub-issue già tracciate indipendentemente (titolo `[EPIC] ...` + sezione
 * `## Sub-issues` con ≥1 riferimento `#N`), quindi senza fix diretto da
 * promuovere. Pura → testabile.
 * @param {string} title
 * @param {string} body
 */
export function detectEpicTracker(title, body) {
  if (!/^\[EPIC\]/i.test(String(title || '').trim())) return false;
  return /#\d+/.test(subIssuesSection(body));
}

/**
 * Numeri delle sub-issue elencate nella sezione `## Sub-issues` del body
 * (usati solo per il commento di park — informativo). Pura → testabile.
 * @param {string} body
 * @returns {number[]}
 */
export function extractSubIssueNumbers(body) {
  const section = subIssuesSection(body);
  return [...new Set([...section.matchAll(/#(\d+)/g)].map((m) => Number(m[1])))];
}

// --- BACKLOG-TRACKER PRE-FLIGHT (escalation #5312/#5314/#5283) ---------------
// Stessa classe dell'epic-tracker sopra, altra forma: le issue di *handoff di
// sessione* ("Backlog dalla sessione …", "… il residuo") non descrivono UN
// difetto, elencano il lavoro residuo di una sessione — voci eterogenee (a
// volte già assegnate ad altre issue) che non hanno una root cause comune né un
// target-file comune. Promuoverle a `agent:fix` non può che finire in un fix
// parziale o in un abort: il fixer sceglie una voce delle N, o gira finché non
// esaurisce i turni. Osservato su #5312 (8 voci), #5314 (7), #5283 (13), tutte
// già `fu-parked` DOPO aver bruciato i tentativi invece che prima.
//
// Perché QUI e non in `classify-issue.mjs`: una categoria `backlog` instradata
// a `route:'none'` escluderebbe a monte dal routing, che è esattamente ciò che
// la decisione del proprietario del 2026-07-05 ha rimosso (AGENTS.md → "Issue
// automation": «nessuna categoria è più opt-in-manuale; supervisione umana =
// gate `## LGTM`, non esclusione a monte»), ed è asserito da
// tests/classify-issue.test.ts («nessuna categoria produce più route='none'»).
// Il pre-flight del drainer è l'altro layer: non tocca la policy di categoria,
// decide per-issue su evidenza strutturale al momento del drain, ed è la sede
// che il repo usa già per questa classe di burn (#4517, #5057, #1724, #2291).
// `classifyIssue(title, labels)` non riceve nemmeno il body, quindi un criterio
// strutturale lì non sarebbe esprimibile.
//
// CONSERVATIVO (bias a PROMUOVERE): serve la combinazione ESATTA marker nel
// titolo + body che ENUMERA ≥BACKLOG_MIN_ITEMS voci distinte. Il marker da solo
// non basta, ed è il punto: misurato sulle 2360 issue del repo, il marker
// compare in 14 titoli ma solo 7 hanno un body enumerato (6-13 voci) — le altre
// 7 (#3337, #3029, #3030, #3797, #3621, #3342, #5266) sono backlog *in prosa*
// con UNO scope reale, e restano promuovibili. La separazione è netta: nessuna
// issue del corpus cade fra 1 e 5 voci, quindi la soglia esatta non è
// load-bearing (3, 4 o 5 danno lo stesso identico insieme); 3 è il minimo che
// significhi ancora "più voci eterogenee".
const BACKLOG_TITLE_RE = /^backlog\b|\bil residuo\b/i;
const BACKLOG_MIN_ITEMS = 3;

/**
 * Numero di voci di lavoro DISTINTE enumerate nel body: task-list `- [ ]`/`- [x]`
 * e sezioni numerate `## N.` (le due forme usate dagli handoff di sessione in
 * questo repo). Pura → testabile.
 * @param {string} body
 * @returns {number}
 */
export function countBacklogItems(body) {
  const b = String(body || '');
  const checkboxes = (b.match(/^[ \t]*[-*][ \t]+\[[ xX]\]/gm) || []).length;
  const numberedSections = (b.match(/^##[ \t]*\d+\.[ \t]/gm) || []).length;
  return checkboxes + numberedSections;
}

/**
 * Vero se l'issue è un contenitore di lavoro residuo (marker di handoff nel
 * titolo + body che enumera ≥BACKLOG_MIN_ITEMS voci), quindi senza un difetto
 * singolo da fixare. Pura → testabile.
 * @param {string} title
 * @param {string} body
 */
export function detectBacklogTracker(title, body) {
  if (!BACKLOG_TITLE_RE.test(String(title || '').trim())) return false;
  return countBacklogItems(body) >= BACKLOG_MIN_ITEMS;
}

// --- COMPRESS-CONTRACT-DOCS RATCHET PRE-FLIGHT (escalation #5523) -----------
// `compress-contract-docs.yml` opens/reopens a SINGLE stable-titled issue whenever a
// hot contract doc (AGENTS.md/REVIEW.md/ISSUES.md/FOLLOWUP.md) crosses its
// compress-ceiling, asking for prose-only compression that preserves every heading,
// rule, table, step, code-block, path and exact string verbatim. Across every
// occurrence on record (#1112/#1113/#1569/#3039/#3641/#4136/#4567/#5507, spanning
// 2026-06→08), the autonomous fixer has closed NONE of them — each was eventually
// closed by a human-authored PR. #5507 measured concretely why: trimming redundant
// prose alone left ISSUES.md at ~23.0KB, still over the 22000B ceiling — the fix that
// actually landed (#5519) extracted an appendix into a new file, a structural
// editorial call a mechanical prose-edit does not reach. Promoting it re-pays the
// same run (and, once it exhausts the turn budget, the same needs-human park) every
// time the ratchet re-fires. Park pre-promotion instead — the title is a fixed,
// machine-generated constant the ratchet itself emits verbatim (never edited by a
// human), so an exact match carries no false-positive risk.
//
// Why here and not `classify-issue.mjs` (same rationale as backlog-tracker above):
// a category routed to `route:'none'` would exclude it from routing upstream, which
// is exactly what the 2026-07-05 owner decision removed and what
// `tests/classify-issue.test.ts` asserts against. The drainer pre-flight is the
// layer this repo already uses for per-issue structural evidence at drain time.
const COMPRESS_CONTRACT_DOCS_TITLE = '📏 Contract docs over compress ceiling — gentle-compress needed';

/**
 * Vero se l'issue è quella aperta dal ratchet `compress-contract-docs.yml` (titolo
 * fisso, machine-generated — mai editato a mano). Pura → testabile.
 * @param {string} title
 */
export function detectCompressContractDocsRatchet(title) {
  return String(title || '').trim() === COMPRESS_CONTRACT_DOCS_TITLE;
}

// --- OVERLAP-FILE PRE-FLIGHT (escalation #3810) ----------------------------------
// fix-outcome:overlap-skip ricorre 8×/14gg: il fixer Claude rileva l'overlap solo
// DOPO aver bruciato ~1M token. Questo check zero-Claude rimuove il burn alla fonte:
// il drainer rileva PRIMA della promozione se i file target della issue sono già
// modificati da una PR aperta, rinviando il candidato al prossimo tick (no park:
// l'overlap è transitorio — la PR bloccante può mergiarsi, il candidato diventa
// promuovibile al tick successivo senza aver consumato quota Claude).
//
// CONSERVATIVO (bias a PROMUOVERE — un falso-skip ritarderebbe un fix legittimo):
//   - Nessun path di codice estratto dal body → PROMUOVI (nessun segnale).
//   - Errori gh (pr list / pr diff) → PROMUOVI (transiente, non bloccare su glitch).
//   - Solo path CODE_PATH_RE (scripts/build-plugins/services/…) — mai su data-blob
//     (data/**) o workflow (.github/**) già gestiti dalle pre-flight sopra.

/**
 * Estrae i path di file codice (non-workflow) citati nel testo di una issue.
 * Riusa CODE_PATH_RE già definita (consistenza, no drift). Pura → testabile.
 *
 * Emette DUE forme per ogni path citato, quando differiscono: quella completa e la sua
 * coda a partire dalla prima directory di codice riconosciuta (`repoRelativeTail`).
 * Serve perché il confronto a valle (`findOverlapFile`) è un `Set.has` esatto sui file
 * di una PR, e le due radici non coincidono sempre: un body può citare un URL blob di
 * GitHub, e ciò che il corpus tiene in `content/**` il sito lo tiene in
 * `packages/articles/content/**`. Le due forme insieme sono un SOVRAINSIEME stretto di
 * ciò che l'estrattore produceva prima del fix di `CODE_PATH_RE`: nessun confronto che
 * matchava prima può smettere di matchare. Un falso overlap costa un tick di rinvio (mai
 * un park — vedi il commento della sezione), un falso promote costa ~1M token.
 * @param {string} text  title + body della issue
 * @returns {string[]}
 */
export function extractCodePaths(text) {
  const out = new Set();
  for (const p of String(text || '').match(CODE_PATH_RE) || []) {
    out.add(p);
    out.add(repoRelativeTail(p));
  }
  return [...out];
}

/**
 * Dato l'array di path del candidato e una mappa PR→files (pre-caricata),
 * ritorna il PRIMO overlap trovato {prNumber, prTitle, file} o null se nessuno.
 * Pura (niente gh) → testabile in unit test senza mock.
 * @param {string[]} paths
 * @param {Map<number, {title:string, files:Set<string>}>} prFilesMap
 * @returns {{prNumber:number, prTitle:string, file:string}|null}
 */
export function findOverlapFile(paths, prFilesMap) {
  for (const [prNumber, { title, files }] of prFilesMap) {
    for (const p of paths) {
      if (files.has(p)) return { prNumber, prTitle: String(title || ''), file: p };
    }
  }
  return null;
}

/**
 * Un'issue è "queue-managed" (passata dalla coda `agent:fix-queued` drenata da
 * questo file)? Prima del 2026-07-05 SOLO i `follow-up` la attraversavano;
 * l'auto-fix è stato esteso a TUTTE le categorie (owner decision) — usa
 * `classifyIssue` come single source of truth (stessa regola di
 * `issue-triage.yml`/`triage-sweep.mjs`, no drift): `route==='queue'` copre
 * ogni categoria tranne `crawler` (che resta `route='fix'` immediato,
 * production-critical, gestione separata). Pura → testabile.
 * @param {{title?: string, labels?: Array<{name:string}>}} iss
 */
export function isQueueManaged(iss) {
  const ls = (iss?.labels || []).map((l) => l.name);
  return classifyIssue(iss?.title, ls).route === 'queue';
}

/**
 * Un'issue è eleggibile all'age-out close? Puro (niente gh) → testabile.
 * Vero se: è queue-managed (qualunque categoria autofix ≠ crawler, non più
 * solo follow-up), NON marcata `agent:no-age-out` (issue-contatore/tracker
 * permanente, #5615), NON in lavorazione (né `agent:fix` né
 * `agent:fix-queued`), creata da ≥ageOutDays E inattiva da ≥inactiveDays. I
 * `fu-parked` ricadono qui (non sono in coda). Il chiamante aggiunge la
 * guardia "nessuna PR aperta" (impura).
 * @param {{title?: string, labels?: Array<{name:string}>, createdAt?: string, updatedAt?: string}} iss
 * @param {{now:number, ageOutDays:number, inactiveDays:number}} opts
 */
export function isAgeOutEligible(iss, { now, ageOutDays, inactiveDays }) {
  if (!ageOutDays || ageOutDays <= 0) return false;
  if (!isQueueManaged(iss)) return false;
  const ls = (iss?.labels || []).map((l) => l.name);
  if (ls.includes(LBL_NO_AGE_OUT)) return false; // issue-contatore/tracker permanente, mai eleggibile
  if (ls.includes(LBL_FIX) || ls.includes(LBL_QUEUED)) return false; // in lavorazione/coda
  const created = Date.parse(iss?.createdAt);
  const updated = Date.parse(iss?.updatedAt);
  if (Number.isNaN(created) || Number.isNaN(updated)) return false; // date illeggibili → non chiudere
  const ageDays = (now - created) / 86_400_000;
  const idleDays = (now - updated) / 86_400_000;
  return ageDays >= ageOutDays && idleDays >= inactiveDays;
}

// --- INATTIVITÀ SIGNIFICATIVA vs `updatedAt` (starvation del PARKED-RETRY) ---
// `updatedAt` di GitHub si alza a OGNI commento, compresi quelli dei bot. I
// monitor che hanno APERTO queste issue le ri-commentano ogni 2-3 ore («🔁
// Recurrence on workflow run»), quindi le issue più sorvegliate non raggiungono
// MAI la quiete richiesta dal cooldown del PARKED-RETRY e restano escluse dalla
// riparazione per sempre. Il rinfresco automatico è esattamente ciò che le
// esclude dal venire riparate.
//
// Misurato il 2026-08-11 sulle 35 issue aperte del sito: 19 candidate
// `fu-parked` superano tutti gli altri filtri, **zero** superano il cooldown —
// nessuna arriva a 5 giorni di `updatedAt` fermo (il massimo osservato è 2,67g,
// il minimo 0,02g). Le vittime sono le `fu-prio:high` di SEO, cioè le più
// preziose: #5321 (24 commenti/14gg, gap max 0,86g), #5429 (14, 0,35g), #5323
// (11, 1,00g), #5341 (9, 0,54g).
//
// L'ironia che rende lo stato STABILE invece che transitorio: lo stesso
// `updatedAt` che le affama le protegge anche dall'age-out close, che legge lo
// stesso identico campo (`AGEOUT_INACTIVE_DAYS`, vedi `isAgeOutEligible` sopra)
// → limbo permanente, mai ritentate e mai chiuse.
//
// La fix cambia QUALE tempo si misura, non quanto se ne aspetta:
// `RETRY_COOLDOWN_DAYS`, `MAX_REPARK_GEN` e `RETRY_MAX_PER_RUN` restano
// invariati (abbassati apposta il 2026-06-30 per frugalità di quota; il cap
// 1/run resta l'unica protezione che conta sul volume).

// Riconoscere un bot NON è una lista da mantenere a mano — e questo repo lo
// dimostra da solo. Le due forme in cui GitHub espone lo stesso attore:
//   • REST   `/issues/N/comments` → `user.login: "github-actions[bot]"`,
//                                   `user.type: "Bot"`   ← flag AUTORITATIVO
//   • GraphQL (`gh issue view --json comments`) → `author.login:
//                                   "github-actions"`, nessun flag, NESSUN suffisso
// Verificato il 2026-08-11 sulle 19 candidate del pool: 145 commenti di bot su
// 185, da TRE bot distinti — `github-actions[bot]` (118), `claude[bot]` (24) e
// `frontaliere-automation[bot]` (3). Il terzo è la prova del perché la sola
// allowlist non basta: è comparso senza che nessuno lo aggiungesse a niente, e
// in GraphQL si chiama `frontaliere-automation`, senza suffisso — una regola
// basata solo sul suffisso lo mancherebbe, una basata solo sull'allowlist pure.
// Un bot non riconosciuto rimette la sua issue in starvation IN SILENZIO: è
// esattamente il difetto che questa fix chiude, e non deve poter tornare per il
// solo fatto che è nato un nuovo workflow.
//
// Perciò il cooldown legge i commenti dalla REST (`issueCommentsRest`), dove il
// flag `user.type` arriva da GitHub e si mantiene da solo. `isBotLogin` resta
// come fallback per la forma GraphQL, che il resto di questo file usa già.
export const BOT_COMMENT_LOGINS = new Set(['github-actions', 'claude', 'frontaliere-automation']);

/**
 * Fallback per la forma GraphQL, dove non esiste alcun flag: suffisso `[bot]`
 * (regola generale) oppure allowlist dei bot osservati su questo repo (i login
 * GraphQL sono nudi, quindi il suffisso da solo non li vedrebbe). Login
 * assente/illeggibile → `false`: non si ignora mai una voce potenzialmente
 * umana per un campo mancante. Pura → testabile.
 * @param {string|undefined} login
 */
export function isBotLogin(login) {
  const l = String(login || '').trim().toLowerCase();
  if (!l) return false;
  if (l.endsWith('[bot]')) return true;
  return BOT_COMMENT_LOGINS.has(l);
}

/**
 * Vero se il commento è stato scritto da un bot. Accetta entrambe le forme:
 * REST (`user.type === 'Bot'`, autoritativo → nessuna manutenzione) e GraphQL
 * (`author.login`, via `isBotLogin`). Pura → testabile.
 * @param {{user?: {login?: string, type?: string}, author?: {login?: string}}} comment
 */
export function isBotComment(comment) {
  if (String(comment?.user?.type || '') === 'Bot') return true;
  return isBotLogin(comment?.user?.login ?? comment?.author?.login);
}

/**
 * Timestamp (epoch ms) dell'ultimo evento SIGNIFICATIVO della issue — cioè un
 * evento che dice qualcosa sul suo STATO, invece di limitarsi a rinfrescarla:
 *
 *  - un commento di un autore NON-bot (qualcuno ha davvero detto qualcosa);
 *  - un commento che porta un marker `FIX_OUTCOME`, anche se di un bot: è il
 *    verdetto con cui il fixer chiude una run, quindi la migliore
 *    approssimazione DISPONIBILE del momento del park — che è una pura mutazione
 *    di label e non ha alcun timestamp nel JSON delle issue — e non costa
 *    nessuna chiamata in più, perché i commenti sono già quelli letti qui.
 *    Non ricorre: una issue parkata non viene promossa, quindi non produce nuovi
 *    verdetti. È questo termine a impedire che «ignora i bot» degeneri in
 *    «ri-accoda subito un park di un'ora fa»;
 *  - in mancanza di entrambi, la CREAZIONE della issue.
 *
 * Fuori resta il rumore che causa la starvation: ping ricorrenti dei monitor,
 * digest, commenti di aggiornamento automatico.
 *
 * INVARIANTE: il valore è sempre ≤ `updatedAt`, perché ognuno di questi eventi
 * bumpa `updatedAt`. Quindi il pool calcolato con questa funzione è un
 * SOVRAINSIEME di quello calcolato con `updatedAt`: la fix non può escludere
 * nulla che oggi entri. Pura (niente gh) → testabile.
 *
 * Accetta entrambe le forme di commento: REST (`created_at`, `user`) e GraphQL
 * (`createdAt`, `author`).
 *
 * @param {{createdAt?: string, created_at?: string}} iss
 * @param {Array<{body?: string, createdAt?: string, created_at?: string, author?: {login?: string}, user?: {login?: string, type?: string}}>} comments
 * @returns {number|null} epoch ms, o null se nessuna data è leggibile
 */
export function lastSignificantActivityAt(iss, comments) {
  const created = Date.parse(iss?.createdAt ?? iss?.created_at);
  let at = Number.isNaN(created) ? -Infinity : created;
  for (const c of comments || []) {
    const t = Date.parse(c?.createdAt ?? c?.created_at);
    if (Number.isNaN(t) || t <= at) continue;
    if (!isBotComment(c) || FIX_OUTCOME_RE.test(String(c?.body || ''))) at = t;
  }
  return at === -Infinity ? null : at;
}

/**
 * La issue parkata ha superato il cooldown di ri-accodo? Misura l'inattività
 * dall'ultimo evento significativo (vedi sopra), non da `updatedAt`. Date
 * tutte illeggibili → `false` (non ri-accodare al buio). Pura → testabile.
 *
 * L'interruttore on/off resta del chiamante (`RETRY_COOLDOWN_DAYS > 0` disabilita
 * l'intero pass): qui `cooldownDays = 0` significa letteralmente «nessuna attesa».
 *
 * @param {{createdAt?: string}} iss
 * @param {Array<{body?: string, createdAt?: string, author?: {login?: string}}>} comments
 * @param {{now: number, cooldownDays: number}} opts
 */
export function isRetryCooldownElapsed(iss, comments, { now, cooldownDays }) {
  const at = lastSignificantActivityAt(iss, comments);
  if (at === null) return false;
  return (now - at) / 86_400_000 >= cooldownDays;
}

function gh(args, { json = true } = {}) {
  const out = execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return json ? JSON.parse(out) : out;
}

/** Quante run issue-fix sono in volo (queued|in_progress). 0 = slot libero. */
function inFlightFixCount() {
  let n = 0;
  for (const status of ['queued', 'in_progress']) {
    try {
      const runs = gh([
        'run', 'list', '--workflow', 'issue-fix.yml',
        '--status', status, '--json', 'databaseId', '--limit', '20',
      ]);
      n += Array.isArray(runs) ? runs.length : 0;
    } catch {
      // su errore transient API conta come "occupato" (conservativo: non promuovere)
      return Number.POSITIVE_INFINITY;
    }
  }
  return n;
}

function listIssues(label) {
  try {
    return gh([
      'issue', 'list', '--repo', REPO, '--state', 'open', '--label', label,
      '--json', 'number,title,labels,createdAt,updatedAt', '--limit', '100',
    ]);
  } catch {
    return [];
  }
}

// Age-out scorre TUTTE le categorie queue-managed (non solo `follow-up`, dal
// 2026-07-05), quindi non può più filtrare lato-API su una singola label:
// serve l'elenco open completo, poi isAgeOutEligible/isQueueManaged filtrano
// in-process. Limit bound (no scan illimitato); eccesso oltre il cap non è un
// problema qui perché age-out ha già il suo AGEOUT_MAX_PER_RUN sulle azioni.
function listAllOpenIssues() {
  try {
    return gh([
      'issue', 'list', '--repo', REPO, '--state', 'open',
      '--json', 'number,title,labels,createdAt,updatedAt', '--limit', '300',
    ]);
  } catch {
    return [];
  }
}

const names = (iss) => (iss.labels || []).map((l) => l.name);
const has = (iss, n) => names(iss).includes(n);
const attemptOf = (iss) => {
  const m = names(iss).map((n) => /^fu-attempt:(\d+)$/.exec(n)).find(Boolean);
  return m ? parseInt(m[1], 10) : 0;
};
const prioRank = (iss) => (has(iss, 'fu-prio:high') ? 0 : 1); // high prima

// --- PARKED-RETRY: ri-accoda i parked ritentabili (convergenza backlog) -------
// Un follow-up va `fu-parked` dopo MAX_ATTEMPTS fix falliti. Molti fallirono per
// cause ORA risolte (cap turni #1919/#1952, aggregate-sweep #1979, drift #2007):
// restano un pool stagnante che NON drena fino all'age-out 10gg. Questo ri-prova
// i parked con il fixer migliorato, BOUNDED (no loop infinito):
//   - skip WF-scope (capability-guard: il fixer CI non può toccare workflows →
//     re-fail garantito; restano umani/age-out);
//   - cooldown: solo parked fermi da ≥ RETRY_COOLDOWN_DAYS. «Fermi» si misura
//     sull'ultimo evento SIGNIFICATIVO (`lastSignificantActivityAt`), non su
//     `updatedAt`: i commenti dei bot rinfrescano `updatedAt` senza dire nulla
//     sullo stato, e le issue sorvegliate da un monitor non arrivavano mai a
//     5 giorni di quiete — restavano escluse dalla riparazione per sempre;
//   - generation-cap: `fu-reparked:N` ≤ MAX_REPARK_GEN (poi resta parked stabile);
//   - cap/run anti-burst.
// Token-frugality (2026-06-30): default abbassati per strozzare il ri-burn di
// quota Max sui parked già falliti MAX_ATTEMPTS×. Cooldown 2→5gg (ri-prova meno
// spesso), repark-gen 2→1 (un solo giro di retry, poi parked stabile fino
// all'age-out), cap/run 5→1 (no burst di run Claude su pool a basso rendimento).
// Override via env se serve più aggressività di convergenza.
const RETRY_COOLDOWN_DAYS = Number(process.env.FOLLOWUP_RETRY_COOLDOWN_DAYS || 5);
const MAX_REPARK_GEN = Number(process.env.FOLLOWUP_MAX_REPARK_GEN || 1);
const RETRY_MAX_PER_RUN = Number(process.env.FOLLOWUP_RETRY_MAX_PER_RUN || 1);
// Il cooldown si misura sull'ultimo evento SIGNIFICATIVO, non su `updatedAt`
// (vedi `lastSignificantActivityAt`), e leggerlo costa una `gh issue view --json
// comments` per candidata. Due limiti tengono il costo bounded e indipendente
// dalla lunghezza del backlog:
//  • si legge SOLO chi `updatedAt` da solo escluderebbe. Chi è già quieto entra
//    nel pool con zero chiamate in più, esattamente come prima di questa fix
//    (l'invariante «significativo ≤ updatedAt» rende il salto sicuro);
//  • cap per run, sullo stesso modello di `QUOTA_SCAN_MAX`. 25 copre con margine
//    le 19 candidate misurate il 2026-08-11; l'eccedenza è dichiarata nel log e
//    rivalutata al tick successivo (AGENTS.md "no silent cap").
const RETRY_COMMENT_SCAN_MAX = Number(process.env.FOLLOWUP_RETRY_COMMENT_SCAN_MAX || 25);
// Costo di una singola lettura commenti per il budget di run: una `gh issue
// view`, molto meno della coppia comment+edit di `ITEM_COST_MS`.
const COMMENT_SCAN_COST_MS = Number(process.env.FOLLOWUP_COMMENT_SCAN_COST_MS || 3_000);
const reparkGenOf = (iss) => {
  const m = names(iss).map((n) => /^fu-reparked:(\d+)$/.exec(n)).find(Boolean);
  return m ? parseInt(m[1], 10) : 0;
};
/** WF-scope = il fix toccherebbe .github/workflows (capability-guard) → non
 * auto-fixabile. Riusa `detectWorkflowScoped` (stesso detector di
 * `check-workflows-scope.mjs`, vedi `scripts/lib/workflow-scope-detect.mjs`)
 * invece di un regex locale sulla parola nuda "workflow": issue come
 * `Workflow Failure: <name>` (titolo generato da qualunque monitor CI, mai un
 * vero fix su `.github/workflows/**`) matchavano il bare-word e restavano
 * escluse per sempre dal PARKED-RETRY → mai ripescate → chiuse per age-out
 * senza che il loro fix reale (quasi sempre in `scripts/`/codice) fosse mai
 * ritentato (#5455). `detectWorkflowScoped` richiede un path `.yml`/`.yaml`
 * concreto E nessun path di codice non-workflow citato — niente falsi
 * positivi sulla parola da sola. null/errore → conservativo (skip retry, non
 * rischiare un re-fail garantito). */
function isWorkflowScoped(num, prefetched = null) {
  try {
    // `labels` is fetched (not just title/body) because the shared detector recognises a
    // monitor auto-file by the `ci-timeout` label as well as by the title prefix (#5595).
    // `prefetched` lets `isCapabilityScoped` reuse the SAME `gh issue view` for both
    // capability guards (#5838) instead of paying it twice per candidate.
    const d = prefetched
      || gh(['issue', 'view', String(num), '--repo', REPO, '--json', 'title,body,labels']);
    return detectWorkflowScoped(`${d?.title || ''}\n${d?.body || ''}`, {
      title: d?.title || '',
      labels: d?.labels,
    });
  } catch { return true; }
}

/** Secrets-scope capability-guard for parked-retry (#5057): a park-preemptive gate
 * driven by `detectSecretsScoped` already ran pre-promotion (see main loop below) —
 * this mirrors `isWorkflowScoped` for the reparkable pass so these known
 * credential-blocked categories never cycle un-park → promote → re-park. Pure on
 * already-fetched labels, no extra `gh` call needed. */
function isSecretsScoped(iss) {
  return detectSecretsScoped(names(iss));
}

/**
 * Capability-guard UNICO per il parked-retry: WF-scope **o** secrets-scope, con una
 * sola `gh issue view` invece di due.
 *
 * Prima di #5838 il secrets-scope qui era puro sulle label gia' in mano, quindi
 * gratis — ma per questo non vedeva la forma Remote Config, che vive nel TESTO. Fare
 * una seconda fetch avrebbe raddoppiato il costo per candidata dentro un `runBudget`
 * che conta i millisecondi: `isWorkflowScoped` gia' scarica `title,body,labels`, cioe'
 * esattamente cio' che serve anche a `matchSecretsScopedShape`. Un solo giro, e la
 * copertura sale invece di scendere.
 *
 * Senza questo, una follow-up «scrivi X su Remote Config» parcheggiata dal pre-flight
 * verrebbe ri-accodata dal parked-retry a ogni tick e ri-parcheggiata subito dopo: un
 * ciclo un-park → park che non finisce mai e che sposta il rumore invece di toglierlo.
 *
 * Fail-closed su errore (`true` = resta parked), come `isWorkflowScoped`: un re-fail
 * garantito costa piu' di un retry mancato.
 */
function isCapabilityScoped(iss) {
  if (isSecretsScoped(iss)) return true; // label nota → gratis, nessuna fetch
  try {
    const d = gh(['issue', 'view', String(iss.number), '--repo', REPO, '--json', 'title,body,labels']);
    if (isWorkflowScoped(iss.number, d)) return true;
    return Boolean(matchSecretsScopedShape({
      labels: names(d),
      text: `${d?.title || ''}\n${d?.body || ''}`,
    }));
  } catch { return true; }
}

function edit(num, { add = [], remove = [] }) {
  const args = ['issue', 'edit', String(num), '--repo', REPO];
  for (const l of add) args.push('--add-label', l);
  for (const l of remove) args.push('--remove-label', l);
  if (DRY) { console.log(`[dry] edit #${num} +[${add}] -[${remove}]`); return; }
  try { gh(args, { json: false }); }
  catch (e) { console.log(`::warning::edit #${num} fallito: ${String(e).slice(0, 120)}`); }
}

/** Esiste una PR fix APERTA per questa issue? (head fix/issue-N).
 * Solo `--state open`: una PR MERGED/CLOSED con la issue ancora aperta NON è
 * "in lavorazione" — è il caso aggregate "PR parziale mergiata senza Closes"
 * (#1049/#1707/#1824: agent:fix zombie per giorni perché `--state all`
 * contava la PR mergiata come in-flight per sempre → mai rescue né park).
 * Issue aperta + PR chiusa + vecchia = orfana: re-queue; il pre-flight
 * already-resolved di issue-fix protegge dal re-run inutile se è done. */
function hasFixPR(num) {
  for (const branch of [`fix/issue-${num}`]) {
    try {
      const prs = gh(['pr', 'list', '--repo', REPO, '--head', branch, '--state', 'open', '--json', 'number', '--limit', '1']);
      if (Array.isArray(prs) && prs.length) return true;
    } catch { /* ignore */ }
  }
  return false;
}

/** La issue ha MAI prodotto una fix PR (open|merged|closed)? Distingue un
 * follow-up che il fixer ha almeno parzialmente lavorato (PR creata) da uno che
 * non ha MAI prodotto nulla in N attempt = pattern pure-run-death (error_max_turns
 * ripetuto / too-large). Questi ultimi non vanno ri-tentati all'infinito: ~9 run
 * opus bruciati (3 attempt × 3 generation parked-retry) senza UNA PR (#1801/
 * #1734/#1822 osservati 2026-06-15). fail-safe: errore gh → true (non escalare
 * per un glitch). */
function hasFixPREver(num) {
  try {
    const prs = gh(['pr', 'list', '--repo', REPO, '--head', `fix/issue-${num}`, '--state', 'all', '--json', 'number', '--limit', '1']);
    return Array.isArray(prs) && prs.length > 0;
  } catch { return true; }
}

function minutesSince(iso) {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return Number.POSITIVE_INFINITY;
  return (Date.now() - then) / 60000;
}

/**
 * Vero se un `agent:fix` senza PR va contato come "settling" (promozione
 * fresca, run non ancora registrata in `gh run list`) e deve quindi rinviare
 * il drain di un tick invece di procedere al rescue/orphan. Un commento
 * FIX_OUTCOME bumpa `updatedAt` esattamente come l'edit di promozione, quindi
 * l'età da sola non distingue "appena promosso" da "appena CONCLUSO (fallito)
 * con verdetto già postato" — serve `outcome === null` nel guard, altrimenti
 * un fix appena fallito viene scambiato per settling e il drain dell'intera
 * coda si ferma per un tick a vuoto (bug osservato 2026-07-05: #3578 max-turns
 * commentato a 16:35:59 → il tick di drain successivo lo conta come settling).
 * Pura → testabile.
 * @param {{outcome: string|null, ageMin: number, settleMin: number}} args
 */
export function isSettlingPromotion({ outcome, ageMin, settleMin }) {
  return outcome === null && ageMin < settleMin;
}

// --- CRAWLER RESCUE + PARK (escalation #5514) --------------------------------
// I crawler sono l'UNICA categoria con `route='fix'` (agent:fix diretto, salta la
// coda) e sono per questo l'unica categoria che il rescue orfani sotto esclude
// (`isQueueManaged`). Le due decisioni sono singolarmente ragionevoli e insieme
// lasciavano un buco che non chiudeva nessuno: una run crawler CANCELLATA dalla
// coda concurrency (`issue-fix.yml`: group globale + `cancel-in-progress:false`
// → GitHub tiene UNA sola pending per gruppo e ogni nuova pending sfratta la
// precedente) non veniva né ri-accodata, né parkata, né marcata `needs-human`.
// La issue restava `agent:fix` per sempre: `on: issues:[labeled]` è one-shot,
// l'evento è già stato consumato dalla run sfrattata, e nessun trigger la
// ri-arma. Misurato 2026-08-10: #5392 #5393 #5394 #5395 ferme da due giorni,
// etichettate tutte alle 09:02 del 2026-08-08 (1 run su 5 sopravvissuta), più
// 13 `cancelled` su 100 run `issue-fix`.
//
// Il predecessore di questo blocco (`CRAWLER MAX-TURNS PARK`, #3886) copriva
// SOLO `outcome === 'max-turns'` e faceva `continue` su tutto il resto — quindi
// proprio sul `cancelled`, che non lascia nessun marker.
//
// La risposta giusta al `cancelled` è RI-ARMARE, non parkare: una run cancellata
// in coda non è mai partita, non ha prodotto NESSUN verdetto, quindi non c'è
// niente da cui dedurre che il fix sia impossibile. Parkare qui sarebbe la
// stessa perdita silenziosa in una veste più ordinata. Il ri-arma passa dalla
// coda (`agent:fix-queued`) invece di togliere+rimettere `agent:fix` a mano: è
// il DRAIN sotto a rimettere la label, e lo fa solo a slot libero e una alla
// volta — cioè esattamente la condizione che rende impossibile un secondo
// sfratto. `fu-prio:high` perché un crawler rotto è production-critical (job
// persi in silenzio) e non deve drenare dietro ai follow-up.
//
// BOUND — `CRAWLER_MAX_ATTEMPTS`, default = `MAX_ATTEMPTS` (3). Un ri-arma senza
// contatore è un loop infinito, e i crawler non usavano `fu-attempt`. Tre e non
// altro, per tre ragioni misurabili: (a) è lo stesso guasto delle queue-managed
// (run morta senza verdetto) e lo stesso budget — un crawler non può consumare
// più quota Claude condivisa di qualunque altra categoria; (b) le label
// `fu-attempt:N` esistono nel repo solo per N∈{1,2,3} (vedi ROUTING_LABELS in
// triage-sweep.mjs) e `gh issue edit --add-label` fallisce su una label
// inesistente, quindi un tetto più alto sarebbe rotto in produzione, non solo
// discutibile; (c) col burst disinnescato a monte (triage-sweep: un solo
// `agent:fix` diretto per run, e solo a slot libero) un secondo tentativo è già
// raro — se ne servono tre, a uccidere la run è qualcos'altro rispetto alla coda
// concurrency, ed è esattamente il momento in cui deve guardarla una persona.
// Al tetto: `fu-parked` + `needs-human` (i crawler non passano dal parked-retry,
// che filtra su `isQueueManaged` → `fu-parked` da solo sarebbe uno stato
// terminale che non guarda nessuno).
export const CRAWLER_MAX_ATTEMPTS = Number(process.env.FOLLOWUP_CRAWLER_MAX_ATTEMPTS || MAX_ATTEMPTS);

/**
 * Decide cosa fare di una issue crawler (`route='fix'`, non queue-managed) che
 * porta `agent:fix`. Pura (niente gh) → testabile senza mock.
 *
 * Ordine dei rami, e perché:
 *  1. `hasPR` → la run ha prodotto lavoro, non si tocca.
 *  2/3/4. VERDETTI (`max-turns`, ZERO_WORK, NON_RETRYABLE): un marker FIX_OUTCOME
 *     è la prova che la run è TERMINATA (il fixer lo posta in chiusura), quindi
 *     qui la guardia d'età non serve e agire subito preserva il timing del park
 *     `max-turns` che c'era prima di questo blocco.
 *  5. settling: solo con `outcome === null` per costruzione (vedi
 *     `isSettlingPromotion`) — promozione fresca, run non ancora visibile in
 *     `gh run list`: rinvia il drain di un tick, non toccare la issue.
 *  6. troppo giovane: senza verdetto non si distingue una run morta da una che
 *     non si è ancora registrata → aspetta `orphanMinAgeMin`.
 *  7. NESSUN VERDETTO e vecchia = run cancellata-in-coda / crashata / mai
 *     partita → ri-arma con tentativo consumato, park al tetto.
 *
 * @param {{outcome: string|null, ageMin: number, attempt?: number, hasPR?: boolean,
 *          quotaBackoffActive?: boolean, settleMin?: number, orphanMinAgeMin?: number,
 *          maxAttempts?: number}} args
 * @returns {{action: 'skip'|'settling'|'hold-quota'|'requeue'|'requeue-zero-work'|'park-max-turns'|'park-verdict'|'park-attempts', nextAttempt: number, reason: string}}
 */
export function crawlerFixDecision({
  outcome,
  ageMin,
  attempt = 0,
  hasPR = false,
  quotaBackoffActive = false,
  settleMin = SETTLE_MIN,
  orphanMinAgeMin = ORPHAN_MIN_AGE_MIN,
  maxAttempts = CRAWLER_MAX_ATTEMPTS,
} = {}) {
  const keep = (action, reason) => ({ action, nextAttempt: attempt, reason });
  if (hasPR) return keep('skip', 'ha una PR fix aperta');
  if (outcome === 'max-turns') return keep('park-max-turns', 'error_max_turns (deterministico: stesso cap, stesso esito)');
  if (outcome && ZERO_WORK.has(outcome)) {
    // La run è morta prima di leggere la issue (429): 0 turni, $0, issue INTATTA
    // → ri-accoda SENZA consumare un tentativo. Finestra ancora aperta → non
    // toccare nulla: la issue resta il beacon del backoff per i tick successivi.
    return quotaBackoffActive
      ? keep('hold-quota', `${outcome}, finestra quota ancora aperta`)
      : keep('requeue-zero-work', `${outcome}, finestra quota chiusa (tentativo NON consumato)`);
  }
  if (outcome && NON_RETRYABLE.has(outcome)) return keep('park-verdict', `verdetto non-ri-tentabile: ${outcome}`);
  if (isSettlingPromotion({ outcome: outcome ?? null, ageMin, settleMin })) return keep('settling', 'promozione fresca, run non ancora visibile');
  if (ageMin < orphanMinAgeMin) return keep('skip', `senza verdetto ma giovane (${Math.round(ageMin)}min < ${orphanMinAgeMin}min)`);
  const nextAttempt = attempt + 1;
  const reason = outcome
    ? `esito transiente ${outcome}, nessuna PR`
    : 'nessun verdetto (run cancellata-in-coda / crashata / mai partita)';
  return nextAttempt >= maxAttempts
    ? { action: 'park-attempts', nextAttempt, reason: `${reason}, tentativo ${nextAttempt}/${maxAttempts}` }
    : { action: 'requeue', nextAttempt, reason: `${reason}, tentativo ${nextAttempt}/${maxAttempts}` };
}

/** Commenti della issue in forma GraphQL (`body`/`createdAt`/`author.login`), o
 * `null` su errore gh. Il null è informativo e va distinto da `[]`: «non ho
 * potuto leggerli» non è «non ce ne sono». I chiamanti che non hanno bisogno
 * della distinzione fanno `|| []`. */
function issueComments(num) {
  try {
    const data = gh(['issue', 'view', String(num), '--repo', REPO, '--json', 'comments']);
    return Array.isArray(data?.comments) ? data.comments : [];
  } catch {
    return null;
  }
}

/** Commenti della issue in forma REST, o `null` su errore gh. Serve SOLO al
 * cooldown del PARKED-RETRY, ed è l'unica sorgente che porta `user.type` — il
 * flag di bot autoritativo, che non richiede alcuna allowlist da mantenere
 * (vedi `isBotComment`). `--paginate` è obbligatorio: la REST restituisce i
 * commenti in ordine CRESCENTE, quindi senza paginare una issue con >100
 * commenti darebbe i più VECCHI e l'ultimo evento significativo risulterebbe
 * più antico del vero — cioè un ri-accodo troppo eager, l'errore nel verso
 * sbagliato. `per_page=100` tiene le pagine (e quindi le chiamate) al minimo. */
function issueCommentsRest(num) {
  try {
    const out = gh(['api', `repos/${REPO}/issues/${num}/comments?per_page=100`, '--paginate']);
    return Array.isArray(out) ? out : [];
  } catch {
    return null;
  }
}

/** Ultimo verdetto FIX_OUTCOME sulla issue, o null. Best-effort: null su errore
 * gh/parse → fail-open al rescue normale (mai park per un glitch API). */
function latestFixOutcome(num) {
  return latestFixOutcomeFromComments(issueComments(num) || []);
}

/** Beacon di quota sulla issue (epoch di reset), o null. Best-effort. */
function quotaResetsAt(num) {
  return maxQuotaResetsAt(issueComments(num) || []);
}

/**
 * Carica la mappa PR aperta → {title, files modificati} per il ciclo drainer
 * corrente. In caso di errore gh → mappa vuota (bias a promuovere: mai bloccare
 * una promozione per un glitch API transiente).
 * @returns {Map<number, {title:string, files:Set<string>}>}
 */
function loadOpenPrFilesMap() {
  const map = new Map();
  let openPrs;
  try {
    openPrs = gh(['pr', 'list', '--state', 'open', '--json', 'number,title', '--limit', '50']);
  } catch { return map; } // lista PR non disponibile → mappa vuota → promuovi
  for (const pr of Array.isArray(openPrs) ? openPrs : []) {
    try {
      const diffOut = gh(['pr', 'diff', String(pr.number), '--name-only'], { json: false });
      const files = new Set(
        String(diffOut || '').split('\n').map((l) => l.trim()).filter(Boolean),
      );
      map.set(pr.number, { title: String(pr.title || ''), files });
    } catch { /* diff non disponibile → salta questa PR (bias a promuovere) */ }
  }
  return map;
}

/** Wrapper: qualunque sia il `return` con cui `runDrain` esce, il riepilogo di
 * ciò che è stato rimandato per budget viene sempre stampato (AGENTS.md
 * "no silent cap"). */
function main() {
  try {
    runDrain();
  } finally {
    budget.report();
  }
}

// Esportata (#5524 item 2) così un test può invocarla direttamente con `gh`
// mockato, invece di spawnare un processo reale: è l'unico modo di osservare
// "cosa stampa --dry-run a slot occupato" senza duplicare la logica in un
// secondo file. `main()` resta la sola CLI entry (guardia più sotto).
export function runDrain() {
  if (!REPO) { console.error('GITHUB_REPOSITORY mancante'); process.exit(1); }
  console.log(`followup-drainer${DRY ? ' [DRY-RUN]' : ''} repo=${REPO}`);
  if (budget.enabled) {
    console.log(`budget di run: ${Math.round(budget.remainingMs() / 1000)}s utilizzabili prima della deadline del job.`);
  }

  // --- AGE-OUT CLOSE: drena il ratchet delle issue queue-managed mai chiuse ---
  // Ortogonale allo slot issue-fix (chiudere non tocca il fixer) → gira sempre.
  if (AGEOUT_DAYS > 0) {
    const now = Date.now();
    const candidates = listAllOpenIssues()
      .filter((iss) => isAgeOutEligible(iss, { now, ageOutDays: AGEOUT_DAYS, inactiveDays: AGEOUT_INACTIVE_DAYS }))
      .filter((iss) => !hasFixPR(iss.number)) // mai chiudere una issue con PR aperta
      .sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt)); // più stantii prima
    const toClose = candidates.slice(0, AGEOUT_MAX_PER_RUN);
    if (candidates.length > toClose.length) {
      console.log(`age-out: ${candidates.length} eleggibili, cap ${AGEOUT_MAX_PER_RUN}/run → ${candidates.length - toClose.length} rinviate al prossimo tick (no silent cap).`);
    }
    for (const iss of toClose) {
      // Coppia non atomica (comment → close): senza budget il job può morire fra
      // le due e lasciare la issue commentata-ma-aperta, che al tick successivo
      // viene ri-commentata. Non si comincia se non c'è il tempo di finire.
      if (!budget.take(`#${iss.number} (age-out)`, ITEM_COST_MS)) break;
      const note = `🗑️ Auto-chiusa dal followup-drainer: follow-up inattivo da ≥${AGEOUT_INACTIVE_DAYS}gg e vecchio ≥${AGEOUT_DAYS}gg, mai entrato in lavorazione → non funnel-blocking. **Riapri** se il problema ricorre (o riloggalo: il lessons-harvester lo ricatturerà se è un pattern reale).`;
      if (DRY) { console.log(`[dry] close #${iss.number} (age-out) — "${iss.title}"`); continue; }
      try {
        gh(['issue', 'comment', String(iss.number), '--repo', REPO, '--body', note], { json: false });
        gh(['issue', 'close', String(iss.number), '--repo', REPO, '--reason', 'not planned'], { json: false });
        console.log(`AGE-OUT close #${iss.number} — "${iss.title}"`);
      } catch (e) {
        console.log(`age-out: close #${iss.number} fallita (${e.message}) — continuo col batch.`);
      }
    }
  }

  // --- TOO-LARGE ESCALATION (no cooldown) ------------------------------------
  // Un follow-up parkato che ha GIÀ avuto un giro di parked-retry (reparkGen≥1)
  // col fixer migliorato e NON ha MAI prodotto una PR = pure-run-death
  // (error_max_turns ripetuto / too-large). NON va ri-tentato: ~3 run opus per
  // generazione bruciati per nulla (#1806/#1823/#1688/#1911 osservati parked
  // gen-1 PR-ever:0, 10 fail issue-fix/4h). Escala a `needs-human` SUBITO —
  // è la decisione "smetti di ritentare", l'OPPOSTO di un re-queue, quindi NON
  // deve essere gated dal cooldown del re-queue (bug wave12: il cooldown 2gg
  // teneva questi item parked-e-riciclati invece di escalarli). Gira sempre;
  // needs-human li toglie dal reparkable → mai più ri-bruciati. WF-scope esclusi.
  {
    const tooLarge = listIssues(LBL_PARKED)
      .filter((iss) => isQueueManaged(iss))
      .filter((iss) => !has(iss, LBL_FIX) && !has(iss, LBL_QUEUED) && !has(iss, 'needs-human'))
      .filter((iss) => reparkGenOf(iss) >= 1)
      .filter((iss) => !isWorkflowScoped(iss.number))
      .filter((iss) => !hasFixPREver(iss.number));
    for (const iss of tooLarge) {
      if (!budget.take(`#${iss.number} (too-large)`, ITEM_COST_MS)) break;
      if (DRY) { console.log(`[dry] too-large #${iss.number} (gen ${reparkGenOf(iss)}, 0 PR) → needs-human`); continue; }
      edit(iss.number, { add: ['needs-human'], remove: [] });
      console.log(`TOO-LARGE #${iss.number} → needs-human (gen ${reparkGenOf(iss)}, mai una PR = error_max_turns/too-large; stop al burn opus) — "${iss.title?.slice(0, 45)}"`);
    }
    if (tooLarge.length) console.log(`too-large escalation: ${tooLarge.length} → needs-human (no re-queue, no cooldown).`);
  }

  // --- PARKED-RETRY: ri-accoda i parked ritentabili --------------------------
  // Ortogonale allo slot (sposta solo fu-parked→queued; il drain promuove dopo).
  if (RETRY_COOLDOWN_DAYS > 0) {
    const now = Date.now();
    const cooldownMin = RETRY_COOLDOWN_DAYS * 1440;
    const pool = listIssues(LBL_PARKED)
      .filter((iss) => isQueueManaged(iss))
      .filter((iss) => !has(iss, LBL_FIX) && !has(iss, LBL_QUEUED)) // non già in lavoro/coda
      .filter((iss) => !has(iss, 'needs-human'))                    // già escalato (too-large) → fuori dal retry
      .filter((iss) => reparkGenOf(iss) < MAX_REPARK_GEN);           // generation-cap
    // Cooldown (vedi `lastSignificantActivityAt`): lo scarto è fra chi è quieto
    // DAVVERO e chi lo sembra soltanto perché nessun bot lo sta ri-commentando.
    // `updatedAt` è un limite superiore dell'ultimo evento significativo, quindi
    // chi lo supera è eleggibile per costruzione e non serve leggerne i commenti.
    let commentScans = 0;
    let scanCapped = 0;
    let unreadable = 0;
    const eligible = [];
    for (const iss of pool) {
      if (minutesSince(iss.updatedAt) >= cooldownMin) {
        // Quieto anche sul campo grezzo → eleggibile senza chiamate extra. La
        // chiave d'ordine è `updatedAt`, che sovrastima la staleness reale: chi
        // passa da questo ramo non può quindi scavalcare in coda chi è entrato
        // con un evento significativo davvero più vecchio.
        eligible.push({ iss, at: Date.parse(iss.updatedAt) });
        continue;
      }
      if (commentScans >= RETRY_COMMENT_SCAN_MAX) { scanCapped++; continue; }
      if (!budget.take(`#${iss.number} (cooldown-scan)`, COMMENT_SCAN_COST_MS)) break;
      commentScans++;
      const comments = issueCommentsRest(iss.number);
      if (comments === null) { unreadable++; continue; } // glitch gh → si rivaluta al prossimo tick
      if (!isRetryCooldownElapsed(iss, comments, { now, cooldownDays: RETRY_COOLDOWN_DAYS })) continue;
      eligible.push({ iss, at: lastSignificantActivityAt(iss, comments) });
    }
    if (commentScans) {
      // Osservabilità della fix: senza questa riga l'effetto è invisibile nei
      // log, e «quante ne sblocca davvero» tornerebbe una domanda da misurare a
      // mano fuori dal loop.
      console.log(`parked-retry: ${commentScans}/${pool.length} candidate escluse da \`updatedAt\` e rivalutate sull'ultimo evento significativo → ${eligible.length} nel pool.`);
    }
    if (scanCapped) {
      console.log(`parked-retry: cap di scansione commenti ${RETRY_COMMENT_SCAN_MAX}/run raggiunto, ${scanCapped} candidate non valutate in questo tick (no silent cap).`);
    }
    if (unreadable) {
      console.log(`parked-retry: ${unreadable} candidate con commenti illeggibili (glitch gh) → nessuna decisione presa, rivalutate al prossimo tick.`);
    }
    const reparkable = eligible
      .sort((a, b) => prioRank(a.iss) - prioRank(b.iss) || a.at - b.at) // high prima, poi i più stantii
      .map((e) => e.iss);
    let retried = 0;
    let skippedWf = 0;
    for (const iss of reparkable) {
      if (retried >= RETRY_MAX_PER_RUN) {
        console.log(`parked-retry: cap ${RETRY_MAX_PER_RUN}/run raggiunto, ${reparkable.length - retried - skippedWf} rinviati al prossimo tick (no silent cap).`);
        break;
      }
      if (!budget.take(`#${iss.number} (parked-retry)`, ITEM_COST_MS)) break;
      // capability-guard → resta parked (WF-scope: push bloccato; secrets-scope: credenziali mai disponibili)
      if (isCapabilityScoped(iss)) { skippedWf++; continue; }
      // (too-large escalation gestita dal pass dedicato sopra, no cooldown)
      const gen = reparkGenOf(iss) + 1;
      const prevGen = reparkGenOf(iss) ? `fu-reparked:${reparkGenOf(iss)}` : null;
      const prevAttempt = attemptOf(iss) ? `fu-attempt:${attemptOf(iss)}` : null;
      if (DRY) { console.log(`[dry] parked-retry #${iss.number} → un-park, gen ${gen} (reset attempts)`); retried++; continue; }
      // un-park: rimuovi fu-parked + attempt counter, ri-accoda con generation
      // bump. Reset attempts → il fixer migliorato ha tentativi freschi; se
      // rifallisce MAX_ATTEMPTS torna parked, ma a gen MAX_REPARK_GEN resta
      // parked stabile (no loop infinito).
      edit(iss.number, {
        add: [LBL_QUEUED, `fu-reparked:${gen}`],
        remove: [LBL_PARKED, prevGen, prevAttempt].filter(Boolean),
      });
      console.log(`PARKED-RETRY #${iss.number} → agent:fix-queued (gen ${gen}/${MAX_REPARK_GEN}, attempts reset) — "${iss.title?.slice(0, 50)}"`);
      retried++;
    }
    if (skippedWf) console.log(`parked-retry: ${skippedWf} skip WF-scope (capability-guard → restano parked/age-out).`);
  }

  // (Il pass crawler — ex `CRAWLER MAX-TURNS PARK` #3886, ora rescue completo
  // #5514 — è sceso SOTTO il gate dello slot, accanto al rescue queue-managed:
  // il ri-arma non può girare a slot occupato, e i crawler in assestamento
  // devono contribuire a `settlingPromotions` come tutti gli altri. Vedi lì.)

  // Tutto (rescue + drain) gira SOLO a slot issue-fix libero: così il rescue non
  // può mai toccare la issue di una run viva (evita di togliere agent:fix mentre
  // il fix è in corso), e la promozione resta l'unica pending → mai cancellata.
  //
  // #5524 item 2: quel `return` precedeva ogni ramo che usa `DRY` per stampare
  // "cosa farei" (RESCUE+PARK, CRAWLER RESCUE, DRAIN sono tutti SOTTO questa
  // riga) — quindi `--dry-run` a slot occupato non mostrava mai la preview che
  // è l'unico motivo per cui lo si lancia: chi lo usa per capire cosa
  // succederebbe restava senza risposta, indistinguibile da "non ha nemmeno
  // guardato". In modalità reale il `return` resta invariato (invariante di
  // sicurezza sopra). In `--dry-run` non c'è nessuna mutazione da proteggere —
  // `edit()` e ogni ramo `if (DRY)` sotto sono già no-op — quindi si continua:
  // il resto della funzione calcola e logga cosa accadrebbe SE lo slot fosse
  // libero, invece di uscire muta.
  const inflight = inFlightFixCount();
  if (inflight > 0) {
    if (!DRY) {
      console.log(`slot issue-fix occupato (in-flight=${inflight}) → nessuna azione.`);
      return;
    }
    console.log(`[dry] slot issue-fix occupato (in-flight=${inflight}) → in modalità reale l'esecuzione si fermerebbe qui; continuo a mostrare la preview ipotetica (nessuna mutazione: --dry-run).`);
  }

  // --- RESCUE + PARK: agent:fix orfani (nessuna PR, nessuna run, vecchi) -------
  // Una issue queue-managed promossa la cui run è morta (cancel/error_max_turns)
  // resta agent:fix senza PR e senza nuovo trigger → stuck. Ri-accoda (bump
  // attempt), park a MAX_ATTEMPTS. Solo su categorie queue-managed (route
  // 'queue': ogni categoria tranne crawler, dal 2026-07-05) per non toccare i
  // crawler agent:fix (production-critical, route diretto, gestione separata).
  const allFix = listIssues(LBL_FIX);
  const stuckFix = allFix.filter(
    (i) => isQueueManaged(i) && !has(i, LBL_QUEUED) && !has(i, LBL_PARKED)
  );
  // Il complemento esatto di `stuckFix` dentro `agent:fix`: i crawler
  // (`route='fix'`, unica categoria non queue-managed). Erano l'unica categoria
  // che nessuno strato di recupero guardava — vedi `crawlerFixDecision` (#5514).
  const crawlerFix = allFix.filter(
    (i) => !isQueueManaged(i) && !has(i, LBL_QUEUED) && !has(i, LBL_PARKED) && !has(i, 'needs-human')
  );
  // Promozioni "in assestamento": un agent:fix follow-up giovane e senza PR ha
  // la run viva OPPURE non ancora registrata in `gh run list` (latenza
  // queue→listing di alcuni secondi). In entrambi i casi lo slot issue-fix è
  // logicamente occupato anche se inFlightFixCount()==0 (vedi guard al DRAIN).
  let settlingPromotions = 0;
  // Finestra di quota aperta? Se una run è morta su 429 ha lasciato sulla issue
  // il beacon `<!-- QUOTA_RESETS_AT: <epoch> -->` con la scadenza dichiarata dal
  // server. Finché non è passata, promuovere QUALSIASI issue produce solo un
  // altro 429 identico: stessa quota, stessa risposta, ~5 minuti di slot
  // serializzato bruciati e tutta la coda ritardata. Misurato sulla finestra
  // 7gg 2026-07-29 → 08-05: 49 delle 61 run fallite (80%) sono cadute dentro
  // una finestra già aperta da un fallimento precedente; il 2026-07-31 sono
  // state 27 su 27 (100% di fallimenti in un giorno solo).
  //
  // La scansione copre `agent:fix` INTERO (non solo `stuckFix`) e le
  // `agent:fix-queued` toccate di recente, perché la quota è una risorsa
  // GLOBALE: il beacon può stare su una issue `crawler` (route diretto, esclusa
  // da `stuckFix`) o su una issue che il pre-flight `check-quota-backoff.mjs` ha
  // appena ri-accodato. Restringere lo sguardo alle sole queue-managed lascerebbe
  // proprio il buco che questo guard esiste per chiudere. Bounded per costo: una
  // `gh issue view` per candidato, cap QUOTA_SCAN_MAX, e si esce al primo beacon
  // attivo trovato.
  let quotaBackoffUntil = null;
  const quotaScanPool = [
    ...allFix,
    ...listIssues(LBL_QUEUED)
      .filter((i) => !has(i, LBL_PARKED))
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .slice(0, QUOTA_SCAN_MAX),
  ];
  const quotaSeen = new Set();
  for (const iss of quotaScanPool) {
    if (quotaSeen.size >= QUOTA_SCAN_MAX) break;
    if (quotaSeen.has(iss.number)) continue;
    quotaSeen.add(iss.number);
    const r = quotaResetsAt(iss.number);
    if (r !== null && isBackoffActive(r)) { quotaBackoffUntil = r; break; }
  }
  if (quotaBackoffUntil !== null) {
    const when = new Date(quotaBackoffUntil * 1000).toISOString();
    console.log(`QUOTA BACKOFF attivo fino a ${when} — nessuna promozione e nessun tentativo consumato in questo tick.`);
  }

  for (const iss of stuckFix) {
    // Il rescue MUTA le label (re-queue/park). Fermarsi qui è sicuro: nessuna
    // issue non ancora esaminata è stata toccata, e il prossimo tick ricalcola
    // l'intero insieme da GitHub — non c'è cursore da riprendere.
    if (!budget.take(`#${iss.number} (rescue)`, ITEM_COST_MS)) break;
    const ageMin = minutesSince(iss.updatedAt);
    const hasPR = hasFixPR(iss.number);
    if (hasPR) continue;   // ha PR → run completata con successo, non orfano né settling
    // Da qui: agent:fix SENZA PR. inFlightFixCount() in cima ha già garantito
    // che NESSUNA run è queued/in_progress, quindi questo non è un fix che gira:
    // o è appena stato promosso e la run non è ancora visibile (≤SETTLE_MIN →
    // assestamento, blocca il drain di 1 tick), o è un fix già COMPLETATO senza
    // PR (fallito/skip). Quest'ultimo NON deve bloccare il drain (era il bug del
    // settling a 30min): lo lasciamo all'orphan-rescue quando supera i 30min.
    // `outcome` va calcolato PRIMA del check settling: un commento FIX_OUTCOME
    // bumpa `updatedAt` esattamente come una promozione fresca, quindi age da
    // solo non distingue "appena promosso, run non ancora visibile" da "appena
    // CONCLUSO (fallito) con verdetto già postato". Senza `outcome === null` nel
    // guard, un fix appena fallito veniva riclassificato come settling e
    // rinviava l'intero drain di un tick a vuoto (bug osservato 2026-07-05:
    // #3578 max-turns con commento a 16:35:59 → il drain di 16:36 lo conta come
    // settling e rinvia la promozione del prossimo candidato in coda).
    const outcome = latestFixOutcome(iss.number);
    if (isSettlingPromotion({ outcome, ageMin, settleMin: SETTLE_MIN })) { settlingPromotions++; continue; } // registrazione run
    if (ageMin < ORPHAN_MIN_AGE_MIN) continue; // fix finito senza PR ma non ancora orfano → non bloccare il drain
    // vecchio + nessuna PR → orfano. Ma «nessuna PR» ha due cause diverse:
    // (a) run morta/crashata (nessun verdetto) → ri-tentabile; (b) ABORT pulita
    // del fixer con verdetto deterministico-non-ri-tentabile (no-root-cause,
    // blocked-*, …) → re-queue inutile, riprodurrebbe lo stesso esito bruciando
    // quota (root cause #1478). Distingui via l'ultimo marker FIX_OUTCOME: se è
    // NON_RETRYABLE → park SUBITO senza consumare i tentativi residui (nessuna
    // perdita: resta aperto, ri-triabile a mano se il contesto cambia).
    // ZERO-WORK (429): la run non ha letto la issue — 0 turni, $0. Non è né un
    // verdetto fermo (→ park) né una run crashata a metà lavoro (→ tentativo
    // consumato): la issue è INTATTA. Due comportamenti, entrambi necessari:
    //  • finestra ANCORA aperta → non toccare nulla. Lasciare `agent:fix` fa sì
    //    che questa issue resti il beacon del backoff per i tick successivi, e
    //    il guard al DRAIN sotto impedisce di promuovere qualcun altro contro la
    //    stessa quota esaurita. Nessuna label cambiata = nessun re-trigger.
    //  • finestra CHIUSA → ri-accoda **senza incrementare `fu-attempt`**. Era
    //    esattamente il bump di quel contatore a portare a `fu-parked` (e da lì
    //    all'age-out close) issue mai lette da nessun agent (#5008 #5004 #5001
    //    #4974). Un tentativo si consuma quando l'agent PROVA, non quando la
    //    quota gliel'ha impedito.
    if (outcome && ZERO_WORK.has(outcome)) {
      if (quotaBackoffUntil !== null) {
        console.log(`HOLD #${iss.number} (${outcome}, finestra quota ancora aperta) → resta agent:fix come beacon, nessun tentativo consumato`);
        continue;
      }
      console.log(`RE-QUEUE #${iss.number} (${outcome}, finestra quota chiusa) → tentativo NON consumato (la run non ha mai letto la issue)`);
      edit(iss.number, { add: [LBL_QUEUED], remove: [LBL_FIX] });
      continue;
    }
    if (outcome && NON_RETRYABLE.has(outcome)) {
      console.log(`PARK #${iss.number} (esito non-ri-tentabile: ${outcome}) → no re-queue, evito run identica`);
      edit(iss.number, { add: [LBL_PARKED], remove: [LBL_FIX, LBL_QUEUED] });
      continue;
    }
    // error_max_turns = turn-budget esaurito in modo DETERMINISTICO: ri-tentare
    // lo stesso item lo riproduce a parità di turni. Con il circuit-breaker
    // (is_aggregate un item alla volta) e il cap alzato (50 turni high / 40 normal),
    // chi esaurisce il budget al primo colpo è genuinamente too-large — il retry
    // non lo salva. Park + needs-human SUBITO: 1 attempt invece di 2 (#2052).
    // Marker `max-turns` emesso da issue-fix.yml SOLO sul subtype error_max_turns
    // (i fail transienti hanno altro subtype → restano ri-tentabili: nessuna
    // falsa escalation). Boundary: già fissato dal too-large-escalation pass
    // (reparkGen≥1, 0 PR) — questa path abbrevia il percorso al primo colpo.
    if (outcome === 'max-turns') {
      console.log(`PARK #${iss.number} → needs-human (error_max_turns al 1° attempt = too-large deterministico; stop al 2° attempt sprecato)`);
      edit(iss.number, { add: [LBL_PARKED, 'needs-human'], remove: [LBL_FIX, LBL_QUEUED] });
      continue;
    }
    // rescue/park per età-tentativi (run davvero morta, nessun verdetto)
    const attempt = attemptOf(iss) + 1;
    const prevAttemptLabel = attemptOf(iss) ? `fu-attempt:${attemptOf(iss)}` : null;
    if (attempt >= MAX_ATTEMPTS) {
      console.log(`PARK #${iss.number} (attempt ${attempt} >= ${MAX_ATTEMPTS})`);
      edit(iss.number, {
        add: [LBL_PARKED, `fu-attempt:${attempt}`],
        remove: [LBL_FIX, LBL_QUEUED, prevAttemptLabel].filter(Boolean),
      });
    } else {
      console.log(`RE-QUEUE #${iss.number} (orfano, attempt ${attempt})`);
      edit(iss.number, {
        add: [LBL_QUEUED, `fu-attempt:${attempt}`],
        remove: [LBL_FIX, prevAttemptLabel].filter(Boolean),
      });
    }
  }

  // --- CRAWLER RESCUE + PARK (non-queue-managed, escalation #5514) ------------
  // Il gemello di `stuckFix` per l'unica categoria che il filtro `isQueueManaged`
  // esclude. La decisione è tutta in `crawlerFixDecision` (pura, testata); qui
  // resta solo l'I/O. Gira DOPO il gate dello slot per due ragioni:
  //  • il ri-arma toglie `agent:fix`: farlo a slot occupato significherebbe
  //    poter yankare la label da una run VIVA (una run in corso non lascia
  //    marker finché non finisce → `outcome === null` → sembrerebbe un orfano);
  //  • un crawler appena promosso deve contare in `settlingPromotions`, o il
  //    DRAIN promuove un secondo candidato mentre la sua run non è ancora
  //    visibile → due pending → sfratto. È lo stesso incidente del 2026-08-08,
  //    dove la sesta run cancellata alle 09:02 NON era un crawler.
  for (const iss of crawlerFix) {
    const hasPR = hasFixPR(iss.number);
    const outcome = hasPR ? null : latestFixOutcome(iss.number);
    const attempt = attemptOf(iss);
    const prevAttemptLabel = attempt ? `fu-attempt:${attempt}` : null;
    const d = crawlerFixDecision({
      outcome,
      ageMin: minutesSince(iss.updatedAt),
      attempt,
      hasPR,
      quotaBackoffActive: quotaBackoffUntil !== null,
    });
    const tag = `#${iss.number} — "${iss.title?.slice(0, 50)}"`;
    if (d.action === 'skip') continue;
    if (d.action === 'settling') { settlingPromotions++; continue; }
    if (d.action === 'hold-quota') {
      console.log(`HOLD CRAWLER ${tag} (${d.reason}) → resta agent:fix come beacon, nessun tentativo consumato`);
      continue;
    }
    if (d.action === 'requeue-zero-work') {
      console.log(`RE-ARM CRAWLER ${tag} (${d.reason}) → agent:fix-queued, il DRAIN lo ripromuove a slot libero`);
      edit(iss.number, { add: [LBL_QUEUED, 'fu-prio:high'], remove: [LBL_FIX] });
      continue;
    }
    if (d.action === 'requeue') {
      console.log(`RE-ARM CRAWLER ${tag} (${d.reason}) → agent:fix-queued + fu-attempt:${d.nextAttempt}`);
      edit(iss.number, {
        add: [LBL_QUEUED, 'fu-prio:high', `fu-attempt:${d.nextAttempt}`],
        remove: [LBL_FIX, prevAttemptLabel].filter(Boolean),
      });
      continue;
    }
    // park-max-turns | park-verdict | park-attempts → stato terminale VISIBILE.
    // `needs-human` e non solo `fu-parked`: i crawler non passano dal
    // parked-retry (filtra su `isQueueManaged`) né dall'age-out close (idem),
    // quindi `fu-parked` da solo sarebbe uno stato che non guarda nessuno. Il
    // contatore dei tentativi resta sulla issue come tracciato forense; solo il
    // park al tetto lo aggiorna (prev → next).
    const bumped = d.action === 'park-attempts';
    console.log(`PARK CRAWLER ${tag} (${d.reason}) → fu-parked + needs-human`);
    edit(iss.number, {
      add: [LBL_PARKED, 'needs-human', ...(bumped ? [`fu-attempt:${d.nextAttempt}`] : [])],
      remove: [LBL_FIX, ...(bumped ? [prevAttemptLabel] : [])].filter(Boolean),
    });
  }

  // --- DRAIN: promuovi 1 queued a agent:fix (slot già verificato libero) -------
  // Guard QUOTA (misurato 2026-08-05): lo slot può essere libero e la coda piena
  // e comunque promuovere è dannoso, perché il collo di bottiglia non è lo slot
  // ma la quota Max condivisa. Con la finestra 429 aperta, ogni promozione è una
  // run da ~5 minuti che muore al primo turno senza leggere la issue, occupa lo
  // slot serializzato e ritarda tutte le altre — ed è per giunta la stessa quota
  // dell'uso interattivo del proprietario. Il `resetsAt` del payload rende la
  // condizione DETERMINISTICA, non un'euristica: si aspetta la scadenza
  // dichiarata dal server. Il beacon resta sulla issue in `agent:fix`, quindi il
  // tick successivo lo rilegge senza bisogno di alcuno store esterno.
  if (quotaBackoffUntil !== null) {
    const mins = Math.max(1, Math.round((quotaBackoffUntil - Math.floor(Date.now() / 1000)) / 60));
    console.log(`DRAIN sospeso: quota Claude esaurita per altri ~${mins} min (reset ${new Date(quotaBackoffUntil * 1000).toISOString()}). Nessuna promozione — evito run che morirebbero a turno 1.`);
    return;
  }
  // Guard race-visibilità-run (#1339 item 2): `gh run list` può ancora non
  // mostrare come `queued` la run di una promozione appena fatta (latenza di
  // registrazione). In quella finestra inFlightFixCount()==0 ma lo slot NON è
  // libero: promuovere un secondo → due pending → con cancel-in-progress:false
  // la precedente viene cancellata-in-coda → supersession/starvation, proprio la
  // regressione che il drainer esiste per eliminare. Riusa l'euristica d'età del
  // rescue: se esiste una promozione in assestamento, rinvia il drain di un tick
  // (cron ~20min; al più un giro di ritardo, mai una doppia-promozione).
  if (settlingPromotions > 0) {
    console.log(`promozione in assestamento (settling=${settlingPromotions}, run non ancora visibile) → drain rinviato per evitare doppia-promozione/supersession.`);
    return;
  }

  const queued = listIssues(LBL_QUEUED)
    .filter((i) => !has(i, LBL_PARKED))
    .sort((a, b) => prioRank(a) - prioRank(b) || Date.parse(a.createdAt) - Date.parse(b.createdAt));
  if (!queued.length) { console.log('coda vuota → niente da promuovere.'); return; }

  let overlapSkipped = 0;
  let prFilesMap = null; // lazy: caricato al primo candidato con path estratti, poi cached

  // Promuovi il primo candidato in coda, MA salta (parka) quelli il cui fix è
  // esclusivamente workflow-scoped (#1724): promuoverli brucerebbe ~1M token in
  // un run che il push GitHub-App bloccherebbe comunque (no scope `workflows`).
  // Park preemptivo = stesso esito del NON_RETRYABLE post-hoc, senza il run. Il
  // body serve solo per i candidati realmente considerati → fetch lazy, 1 alla volta.
  for (const cand of queued) {
    // Valutare un candidato costa una `gh issue view` (body) e può finire in
    // comment+edit di park. Senza tempo per la coppia si esce: la coda resta
    // intatta e il tick successivo riparte dallo stesso primo candidato.
    if (!budget.take(`#${cand.number} (drain)`, ITEM_COST_MS)) break;

    // Check: compress-contract-docs ratchet (escalation #5523) — title-only, gira
    // PRIMA del fetch del body (nessuna chiamata gh extra). Mai chiusa dal fixer
    // autonomo in 8 occorrenze storiche, sempre da una PR umana.
    if (detectCompressContractDocsRatchet(cand.title)) {
      console.log(`PARK #${cand.number} (compress-contract-docs ratchet) → no promozione, mai chiusa dal fixer autonomo (8/8 storiche via PR umana)`);
      const note = `⏭️ **Pre-flight drainer (zero-Claude, #5523)**: questa issue è aperta dal ratchet \`compress-contract-docs.yml\` — comprimere un doc "hot" (15-21KB) preservando verbatim heading/regole/tabelle/step/code-block/path/stringhe è un lavoro editoriale, non un difetto meccanico. Nessuna occorrenza storica (#1112 #1113 #1569 #3039 #3641 #4136 #4567 #5507) è mai stata chiusa dal fixer autonomo: tutte hanno richiesto scelte di struttura (es. #5519 ha dovuto estrarre un'appendice in un nuovo file — la sola prosa non bastava a rientrare sotto ceiling) e sono state chiuse da una PR umana. Promuoverla ripaga lo stesso run a vuoto a ogni ri-apertura del ratchet. **Non promuovo**: serve una sessione umana/gentle-compress mirata. Rimuovo \`agent:fix-queued\` e parko (riapribile: togli \`fu-parked\` se il contesto cambia).\n\n<!-- FIX_OUTCOME: revenue-tracker-manual -->`;
      if (DRY) { console.log(`[dry] park #${cand.number} (compress-contract-docs ratchet)`); continue; }
      try { gh(['issue', 'comment', String(cand.number), '--repo', REPO, '--body', note], { json: false }); }
      catch (e) { console.log(`::warning::comment #${cand.number} fallito: ${String(e).slice(0, 120)}`); }
      edit(cand.number, { add: [LBL_PARKED], remove: [LBL_QUEUED, LBL_FIX] });
      continue; // prova il prossimo in coda
    }

    let body = '';
    try {
      const raw = gh(['issue', 'view', String(cand.number), '--repo', REPO, '--json', 'body'], { json: true });
      body = String(raw?.body || '');
    } catch { body = ''; } // body illeggibile → bias a promuovere (non parkare a vuoto)

    // Check: malformed body (escalation #2291) — body vuoto/stub brucia turni inutilmente.
    if (detectMalformedBody(cand.title, body)) {
      const blen = String(body || '').trim().length;
      console.log(`PARK #${cand.number} (malformed body, ${blen} chars) → no promozione, fixer non ha contesto`);
      const note = `⛔ **Pre-flight drainer (zero-Claude, #2291)**: il body di questa follow-up è vuoto o malformato (${blen} chars, nessuna sezione \`## Origine\`/\`### N.\`). Promuoverla a \`agent:fix\` brucerebbe turni senza produrre una PR — il fixer non ha contesto su cosa fixare.\n\n**Non promuovo**: correggi il body dell'issue (sezioni \`## Origine\` + \`## Item\` obbligatorie) o ri-apri il follow-up con una descrizione completa. Parko con \`needs-human\`.\n\n<!-- FIX_OUTCOME: no-root-cause -->`;
      if (DRY) { console.log(`[dry] park #${cand.number} (malformed body)`); continue; }
      try { gh(['issue', 'comment', String(cand.number), '--repo', REPO, '--body', note], { json: false }); }
      catch (e) { console.log(`::warning::comment #${cand.number} fallito: ${String(e).slice(0, 120)}`); }
      edit(cand.number, { add: [LBL_PARKED, 'needs-human'], remove: [LBL_QUEUED, LBL_FIX] });
      continue; // prova il prossimo in coda
    }

    // Check: explicit network audit (escalation #2291) — "network-enabled audit" / "audit curl"
    // indica che il fix richiede verifica HTTP su URL esterni come prerequisito.
    // Il fixer ha solo Bash(node:*) (no curl diretto); scripting node inline multi-turno → max-turns.
    if (detectExplicitNetworkAudit(cand.title, body)) {
      console.log(`PARK #${cand.number} (explicit network audit) → no promozione, allowedTools non include curl`);
      const note = `⛔ **Pre-flight drainer (zero-Claude, #2291)**: questa follow-up richiede un audit HTTP su URL esterni ("network-enabled audit" / "audit curl") come prerequisito al fix del codice. Il fixer CI ha solo \`Bash(node:*)\` in allowedTools (no \`curl\` diretto): implementare la verifica HTTP in node inline richiede molti turni → finisce \`error_max_turns\` deterministicamente.\n\n**Non promuovo**: serve un script autonomo per l'audit curl, o esecuzione manuale con curl. Parko con \`needs-human\`.\n\n<!-- FIX_OUTCOME: no-root-cause -->`;
      if (DRY) { console.log(`[dry] park #${cand.number} (network audit)`); continue; }
      try { gh(['issue', 'comment', String(cand.number), '--repo', REPO, '--body', note], { json: false }); }
      catch (e) { console.log(`::warning::comment #${cand.number} fallito: ${String(e).slice(0, 120)}`); }
      edit(cand.number, { add: [LBL_PARKED, 'needs-human'], remove: [LBL_QUEUED, LBL_FIX] });
      continue; // prova il prossimo in coda
    }

    // Check: epic-tracker (escalation #4517) — `[EPIC] ...` che delega tutto lo
    // scope a `## Sub-issues` già in coda propria. Promuoverla brucia un run
    // Claude intero per riarrivare sempre alla stessa conclusione zero-fix.
    if (detectEpicTracker(cand.title, body)) {
      const subIssues = extractSubIssueNumbers(body);
      const subList = subIssues.length ? subIssues.map((n) => `#${n}`).join(', ') : 'nessuna elencata';
      console.log(`PARK #${cand.number} (epic-tracker: sub-issues ${subList}) → no promozione, scope delegato`);
      const note = `⏭️ **Pre-flight drainer (zero-Claude, #4517)**: questa issue è un \`[EPIC]\` di coordinamento — il body delega l'intero scope implementativo alla sezione \`## Sub-issues\` (${subList}), già tracciate indipendentemente nella propria coda \`agent:fix-queued\`/\`agent:fix\`. Promuoverla brucerebbe un run Claude completo per arrivare sempre alla stessa conclusione (nessun target-file proprio da fixare qui). **Non promuovo**: l'epic si chiude quando tutte le sub-issue sono mergiate (o manualmente, come tracker). Rimuovo \`agent:fix-queued\` e parko (riapribile: togli \`fu-parked\` se il contesto cambia).\n\n<!-- FIX_OUTCOME: revenue-tracker-manual -->`;
      if (DRY) { console.log(`[dry] park #${cand.number} (epic-tracker)`); continue; }
      try { gh(['issue', 'comment', String(cand.number), '--repo', REPO, '--body', note], { json: false }); }
      catch (e) { console.log(`::warning::comment #${cand.number} fallito: ${String(e).slice(0, 120)}`); }
      edit(cand.number, { add: [LBL_PARKED], remove: [LBL_QUEUED, LBL_FIX] });
      continue; // prova il prossimo in coda
    }

    // Check: backlog-tracker (escalation #5312/#5314/#5283) — handoff di sessione
    // che ELENCA il lavoro residuo invece di descrivere un difetto singolo. Non ha
    // una root cause né un target-file propri: il fixer sceglie una voce delle N o
    // esaurisce i turni, sempre.
    if (detectBacklogTracker(cand.title, body)) {
      const itemCount = countBacklogItems(body);
      console.log(`PARK #${cand.number} (backlog-tracker: ${itemCount} voci enumerate) → no promozione, nessun difetto singolo`);
      const note = `⏭️ **Pre-flight drainer (zero-Claude, #5312)**: questa issue è un **contenitore di lavoro residuo** (handoff di sessione), non un difetto singolo — il body enumera **${itemCount} voci distinte**, eterogenee e in parte già tracciate altrove. Non ha una root cause comune né un target-file proprio: promuoverla a \`agent:fix\` produce un fix parziale su UNA delle voci, o un run che esaurisce i turni. **Non promuovo**: le voci vanno scorporate in issue singole (una root cause ciascuna), che il loop instrada normalmente. Rimuovo \`agent:fix-queued\` e parko (riapribile: togli \`fu-parked\` se il contesto cambia).\n\n<!-- FIX_OUTCOME: revenue-tracker-manual -->`;
      if (DRY) { console.log(`[dry] park #${cand.number} (backlog-tracker)`); continue; }
      try { gh(['issue', 'comment', String(cand.number), '--repo', REPO, '--body', note], { json: false }); }
      catch (e) { console.log(`::warning::comment #${cand.number} fallito: ${String(e).slice(0, 120)}`); }
      edit(cand.number, { add: [LBL_PARKED], remove: [LBL_QUEUED, LBL_FIX] });
      continue; // prova il prossimo in coda
    }

    // Check: secrets-scoped category (escalation #5057) — `cloudflare-5xx` /
    // `campaign-goal` / `evergreen-refresh` labels mark issues whose root fix
    // structurally requires a Firebase-RC-loaded credential (CF_API_TOKEN /
    // POSTHOG_* / GEMINI_API_KEY+GH_MODELS_PAT) never available to `issue-fix`
    // (GH_TOKEN only). Promoting always burns a full Claude run that ends
    // `blocked-secrets` — park pre-promotion instead, zero Claude tokens spent.
    //
    // Dal 2026-08-14 il match non e' piu' solo la label (#5838). Rimisurato: il bucket
    // contava ANCORA 7/14gg, e **nessuna delle 7 portava una delle 3 label** — il gate
    // esisteva e non guardava questa forma. La famiglia che accelera (3 delle 7, tutte
    // negli ultimi 3 giorni) e' «imposta un parametro su Remote Config», che il filer
    // delle follow-up etichetta per funnel e non per capability: il segnale deve venire
    // dal TESTO, come per `detectWorkflowScoped`. Vedi l'intestazione di
    // `secrets-scope-detect.mjs` per le tre congiunzioni e la valvola di promozione.
    const secretsMatch = matchSecretsScopedShape({
      labels: names(cand),
      text: `${cand.title}\n${body || ''}`,
    });
    if (secretsMatch) {
      const via = secretsMatch.via === 'label'
        ? `label \`${secretsMatch.label}\``
        : `scrittura Remote Config (${(secretsMatch.params || []).join(', ')})`;
      console.log(`PARK #${cand.number} (secrets-scoped: ${via}) → no promozione, credenziali non disponibili in issue-fix`);
      const preamble = secretsMatch.via === 'label'
        ? `questa issue porta la label \`${secretsMatch.label}\`, categoria il cui fix richiede sempre \`${secretsMatch.secret}\` (${secretsMatch.reason})`
        : `il fix di questa issue e' **esclusivamente** una scrittura su Firebase Remote Config e richiede \`${secretsMatch.secret}\` (${secretsMatch.reason})`;
      const ref = secretsMatch.via === 'label' ? '#5057' : '#5057/#5838';
      const note = `⏭️ **Pre-flight drainer (zero-Claude, ${ref})**: ${preamble} — credenziale caricata via Firebase Remote Config, non disponibile nell'ambiente \`issue-fix\` (solo \`GH_TOKEN\` GitHub App). Promuoverla a \`agent:fix\` brucerebbe un run Claude intero per arrivare sempre alla stessa conclusione \`blocked-secrets\`. **Non promuovo**: serve una sessione con Firebase SA/PAT (locale o owner). Rimuovo \`agent:fix-queued\` e parko (riapribile: togli \`fu-parked\` se il contesto cambia).\n\n<!-- FIX_OUTCOME: blocked-secrets -->`;
      if (DRY) { console.log(`[dry] park #${cand.number} (secrets-scoped)`); continue; }
      try { gh(['issue', 'comment', String(cand.number), '--repo', REPO, '--body', note], { json: false }); }
      catch (e) { console.log(`::warning::comment #${cand.number} fallito: ${String(e).slice(0, 120)}`); }
      edit(cand.number, { add: [LBL_PARKED], remove: [LBL_QUEUED, LBL_FIX] });
      continue; // prova il prossimo in coda
    }

    // Il parcheggio workflow-scoped ha senso SOLO se issue-fix non può pushare quei file.
    // Dal 2026-08-06 può, quando `mint-app-token.mjs` conia un token la cui installazione
    // ha davvero `workflows: write`, e questo stesso workflow conia lo stesso token qualche
    // step più su.
    //
    // La presenza di APP_TOKEN NON è quel segnale (#5288). Il conio riesce — 201, token
    // valido — anche quando il permesso `workflows` è stato richiesto ma mai approvato
    // sull'installazione: semplicemente non compare fra i `permissions`. Leggere la presenza
    // qui sbagliava nel verso peggiore: SBLOCCAVA la promozione di follow-up che il push
    // avrebbe poi rifiutato, mandando ciascuna a bruciare ~1M token per morire al `git push`
    // — cioè esattamente la spesa che questo parcheggio esiste per evitare.
    // `APP_TOKEN_WORKFLOWS` è la capacità LETTA dalla risposta API, ed è fail-closed:
    // non scritta o diversa da 'true' → si parcheggia, come prima del 2026-08-06.
    //
    // Senza questa condizione la follow-up verrebbe parcheggiata come TERMINALE con una
    // motivazione ormai falsa («manca lo scope workflows»): non solo non arriverebbe mai alla
    // capability appena sbloccata, ma lascerebbe agli atti una spiegazione sbagliata di
    // perché. Un parcheggio motivato male è peggio di nessun parcheggio — nessuno lo rimette
    // in discussione.
    const issueFixCanPushWorkflows = process.env.APP_TOKEN_WORKFLOWS === 'true';
    // NB: una riga sola, per contratto — `tests/issue-fix-app-token-wiring.test.ts` asserisce
    // la forma testuale di questa condizione (`!issueFixCanPushWorkflows && body && detectWorkflowScoped`).
    if (!issueFixCanPushWorkflows && body && detectWorkflowScoped(`${cand.title}\n${body}`, { title: cand.title, labels: cand.labels })) {
      // Title INCLUDED (#5595): a monitor auto-file ("Workflow Failure: <name>") names its
      // workflow subject only there, so a body-only scan renders an empty `(...)` list.
      const wfRefs = extractWorkflowRefs(`${cand.title}\n${body}`).slice(0, 5).join(', ');
      const subject = wfRefs || 'workflow indicato dal monitor che ha aperto la issue';
      console.log(`PARK #${cand.number} (workflow-scoped: ${subject}) → no promozione, evito run bloccato`);
      const note = `⏭️ **Pre-flight drainer (zero-Claude, #1724/#5595)**: il fix di questa follow-up tocca **esclusivamente** file \`.github/workflows/**\` (${subject}), che il token GitHub App di \`issue-fix\` non può pushare (manca lo scope \`workflows\`). Promuoverla a \`agent:fix\` brucerebbe ~1M token in un run che finirebbe comunque \`blocked-workflows-scope\`. **Non promuovo**: serve un PAT abilitato o mano umana. Rimuovo \`agent:fix-queued\` e parko (riapribile: togli \`fu-parked\` se il contesto cambia).\n\n<!-- FIX_OUTCOME: blocked-workflows-scope -->`;
      if (DRY) { console.log(`[dry] park #${cand.number} (workflow-scoped)`); continue; }
      try { gh(['issue', 'comment', String(cand.number), '--repo', REPO, '--body', note], { json: false }); }
      catch (e) { console.log(`::warning::comment #${cand.number} fallito: ${String(e).slice(0, 120)}`); }
      edit(cand.number, { add: [LBL_PARKED], remove: [LBL_QUEUED, LBL_FIX] });
      continue; // prova il prossimo in coda
    }

    // Check: overlap-file con PR aperta (escalation #3810). Zero-Claude, pre-promozione.
    const candPaths = extractCodePaths(`${cand.title}\n${body}`);
    if (candPaths.length > 0) {
      if (prFilesMap === null) prFilesMap = loadOpenPrFilesMap(); // lazy init, cached per ciclo
      const overlap = findOverlapFile(candPaths, prFilesMap);
      if (overlap) {
        console.log(`OVERLAP-SKIP #${cand.number} (file \`${overlap.file}\` in-volo in PR #${overlap.prNumber} "${overlap.prTitle.slice(0, 40)}") → rinvio al prossimo tick`);
        overlapSkipped++;
        continue; // NO park: l'overlap è transitorio (la PR bloccante può mergiarsi)
      }
    }

    console.log(`PROMUOVO #${cand.number} (${has(cand, 'fu-prio:high') ? 'high' : 'low'}) → ${LBL_FIX}`);
    edit(cand.number, { add: [LBL_FIX], remove: [LBL_QUEUED] });
    return; // una sola promozione per run (slot issue-fix)
  }
  const skipNote = overlapSkipped ? ` + ${overlapSkipped} overlap-file rinviati al prossimo tick` : '';
  console.log(`coda esaurita (solo candidati parkati${skipNote}) → niente da promuovere.`);
}

// Esegui solo come CLI (non quando importato dai test → evita di lanciare gh).
if (process.argv[1]?.endsWith('followup-drainer.mjs')) {
  main();
}
