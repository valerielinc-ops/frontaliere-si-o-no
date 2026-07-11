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
 */
import { execFileSync } from 'node:child_process';
import { classifyIssue } from '../lib/classify-issue.mjs';

const DRY = process.argv.includes('--dry-run');
const REPO = process.env.GITHUB_REPOSITORY || '';
const MAX_ATTEMPTS = 3;
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
export const NON_RETRYABLE = new Set([
  'no-root-cause',
  'blocked-workflows-scope',
  'blocked-secrets',
  'blocked-admin-settings',
  'revenue-tracker-manual',
  'already-fixed',
]);

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
// CONSERVATIVA (bias a PROMUOVERE — un falso park ritarda un fix reale): scatta
// SOLO sul segnale forte «il fix è esclusivamente workflow-scoped» = il body cita
// ≥1 path di workflow (`.github/workflows/x.yml` o un bare `x.yml`) E NESSUN path
// di codice non-workflow (scripts/build-plugins/services/components/hooks/build/
// src/...). Se cita anche un file di codice → il fix potrebbe vivere lì → PROMUOVI
// (lascia decidere il fixer). Nessun path citato → PROMUOVI. Mirror del bias
// dell'already-resolved gate (check-issue-already-resolved.mjs).
const WORKFLOW_PATH_RE = /\.github\/workflows\/[A-Za-z0-9._/-]+\.ya?ml\b/g;
// Bare `<name>.yml` (un workflow è sempre .yml; in una follow-up un bare .yml
// che non sia un file di config noto indica quasi sempre un workflow file).
const BARE_YML_RE = /\b[A-Za-z0-9][A-Za-z0-9._-]*\.ya?ml\b/g;
// File di codice NON-workflow: se citati, il fix potrebbe vivere lì → non scoped.
const CODE_PATH_RE = /\b(?:scripts|build-plugins|services|components|hooks|build|src)\/[A-Za-z0-9._/-]+\.[A-Za-z0-9]+\b/g;
// `.yml` di config che NON sono workflow (non implicano scope workflows).
const NON_WORKFLOW_YML = new Set([
  'lighthouserc.yml', 'pnpm-workspace.yml', 'docker-compose.yml',
  '.prettierrc.yml', 'vitest.yml',
]);

/**
 * Vero se il fix della follow-up è ESCLUSIVAMENTE workflow-scoped (richiede di
 * editare `.github/workflows/**`), così la promozione a agent:fix brucerebbe
 * quota in un run che il push bloccherebbe comunque. Pura → testabile.
 * @param {string} text  title + body della issue
 */
export function detectWorkflowScoped(text) {
  const s = String(text || '');
  const wfFull = s.match(WORKFLOW_PATH_RE) || [];
  const bareYml = (s.match(BARE_YML_RE) || []).filter(
    (y) => !NON_WORKFLOW_YML.has(y.toLowerCase()),
  );
  const workflowRefs = [...new Set([...wfFull, ...bareYml])];
  if (workflowRefs.length === 0) return false; // nessun riferimento a workflow → promuovi
  const codeRefs = s.match(CODE_PATH_RE) || [];
  if (codeRefs.length > 0) return false; // cita anche codice non-workflow → potrebbe fixarsi lì → promuovi
  return true; // solo workflow → blocked-workflows-scope by-construction
}

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
 * @param {string} text  title + body della issue
 * @returns {string[]}
 */
export function extractCodePaths(text) {
  return [...new Set((String(text || '').match(CODE_PATH_RE) || []))];
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
 * solo follow-up), NON in lavorazione (né `agent:fix` né `agent:fix-queued`),
 * creata da ≥ageOutDays E inattiva da ≥inactiveDays. I `fu-parked` ricadono
 * qui (non sono in coda). Il chiamante aggiunge la guardia "nessuna PR aperta"
 * (impura).
 * @param {{title?: string, labels?: Array<{name:string}>, createdAt?: string, updatedAt?: string}} iss
 * @param {{now:number, ageOutDays:number, inactiveDays:number}} opts
 */
export function isAgeOutEligible(iss, { now, ageOutDays, inactiveDays }) {
  if (!ageOutDays || ageOutDays <= 0) return false;
  if (!isQueueManaged(iss)) return false;
  const ls = (iss?.labels || []).map((l) => l.name);
  if (ls.includes(LBL_FIX) || ls.includes(LBL_QUEUED)) return false; // in lavorazione/coda
  const created = Date.parse(iss?.createdAt);
  const updated = Date.parse(iss?.updatedAt);
  if (Number.isNaN(created) || Number.isNaN(updated)) return false; // date illeggibili → non chiudere
  const ageDays = (now - created) / 86_400_000;
  const idleDays = (now - updated) / 86_400_000;
  return ageDays >= ageOutDays && idleDays >= inactiveDays;
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
//   - cooldown: solo parked fermi da ≥ RETRY_COOLDOWN_DAYS (non i freschi);
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
const reparkGenOf = (iss) => {
  const m = names(iss).map((n) => /^fu-reparked:(\d+)$/.exec(n)).find(Boolean);
  return m ? parseInt(m[1], 10) : 0;
};
/** WF-scope = il fix toccherebbe .github/workflows (capability-guard) → non
 * auto-fixabile. Best-effort sul body+titolo; null/errore → conservativo (skip
 * retry, non rischiare un re-fail garantito). */
function isWorkflowScoped(num) {
  try {
    const d = gh(['issue', 'view', String(num), '--repo', REPO, '--json', 'title,body']);
    const t = `${d?.title || ''}\n${d?.body || ''}`;
    return /\.github\/workflows|\bworkflow(s)?\b/i.test(t);
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

/** Ultimo verdetto FIX_OUTCOME sulla issue, o null. Best-effort: null su errore
 * gh/parse → fail-open al rescue normale (mai park per un glitch API). */
function latestFixOutcome(num) {
  try {
    const data = gh(['issue', 'view', String(num), '--repo', REPO, '--json', 'comments']);
    return latestFixOutcomeFromComments(Array.isArray(data?.comments) ? data.comments : []);
  } catch {
    return null;
  }
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

function main() {
  if (!REPO) { console.error('GITHUB_REPOSITORY mancante'); process.exit(1); }
  console.log(`followup-drainer${DRY ? ' [DRY-RUN]' : ''} repo=${REPO}`);

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
    const reparkable = listIssues(LBL_PARKED)
      .filter((iss) => isQueueManaged(iss))
      .filter((iss) => !has(iss, LBL_FIX) && !has(iss, LBL_QUEUED)) // non già in lavoro/coda
      .filter((iss) => !has(iss, 'needs-human'))                    // già escalato (too-large) → fuori dal retry
      .filter((iss) => reparkGenOf(iss) < MAX_REPARK_GEN)            // generation-cap
      .filter((iss) => minutesSince(iss.updatedAt) >= RETRY_COOLDOWN_DAYS * 1440) // cooldown
      .sort((a, b) => prioRank(a) - prioRank(b) || Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
    let retried = 0;
    let skippedWf = 0;
    for (const iss of reparkable) {
      if (retried >= RETRY_MAX_PER_RUN) {
        console.log(`parked-retry: cap ${RETRY_MAX_PER_RUN}/run raggiunto, ${reparkable.length - retried - skippedWf} rinviati al prossimo tick (no silent cap).`);
        break;
      }
      if (isWorkflowScoped(iss.number)) { skippedWf++; continue; } // capability-guard → resta parked
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

  // --- CRAWLER MAX-TURNS PARK (non-queue-managed, escalation #3886) -----------
  // Crawler issues (route='fix', !isQueueManaged) che colpiscono error_max_turns
  // sono ESCLUSE dal rescue loop sotto (filtro isQueueManaged → solo queue-managed).
  // Senza questo pass il marker `max-turns` resta senza park → needs-human non
  // viene mai aggiunto → isAvoidableMaxTurns() li conta come "loop fixabile"
  // → harvester escalation ricorre deterministicamente (#3853/#3858/#3862).
  // Park con needs-human AL PRIMO max-turns: stessa logica del rescue queue-managed
  // (error_max_turns è deterministico — ri-tentare lo stesso crawler riproduce
  // identico esito al medesimo cap). I crawler non usano fu-attempt: nessun
  // bump attempt qui, solo il segnale park + needs-human (human → rigenera parser).
  // Gira PRIMA del gate slot (park non richiede lo slot libero).
  {
    const crawlersFix = listIssues(LBL_FIX).filter(
      (i) => !isQueueManaged(i) && !has(i, 'needs-human') && !has(i, LBL_PARKED),
    );
    for (const iss of crawlersFix) {
      if (hasFixPR(iss.number)) continue;
      const outcome = latestFixOutcome(iss.number);
      if (outcome !== 'max-turns') continue;
      console.log(`PARK CRAWLER #${iss.number} → fu-parked + needs-human (error_max_turns deterministico, crawler non-queue-managed) — "${iss.title?.slice(0, 50)}"`);
      edit(iss.number, { add: [LBL_PARKED, 'needs-human'], remove: [LBL_FIX] });
    }
  }

  // Tutto (rescue + drain) gira SOLO a slot issue-fix libero: così il rescue non
  // può mai toccare la issue di una run viva (evita di togliere agent:fix mentre
  // il fix è in corso), e la promozione resta l'unica pending → mai cancellata.
  const inflight = inFlightFixCount();
  if (inflight > 0) {
    console.log(`slot issue-fix occupato (in-flight=${inflight}) → nessuna azione.`);
    return;
  }

  // --- RESCUE + PARK: agent:fix orfani (nessuna PR, nessuna run, vecchi) -------
  // Una issue queue-managed promossa la cui run è morta (cancel/error_max_turns)
  // resta agent:fix senza PR e senza nuovo trigger → stuck. Ri-accoda (bump
  // attempt), park a MAX_ATTEMPTS. Solo su categorie queue-managed (route
  // 'queue': ogni categoria tranne crawler, dal 2026-07-05) per non toccare i
  // crawler agent:fix (production-critical, route diretto, gestione separata).
  const stuckFix = listIssues(LBL_FIX).filter(
    (i) => isQueueManaged(i) && !has(i, LBL_QUEUED) && !has(i, LBL_PARKED)
  );
  // Promozioni "in assestamento": un agent:fix follow-up giovane e senza PR ha
  // la run viva OPPURE non ancora registrata in `gh run list` (latenza
  // queue→listing di alcuni secondi). In entrambi i casi lo slot issue-fix è
  // logicamente occupato anche se inFlightFixCount()==0 (vedi guard al DRAIN).
  let settlingPromotions = 0;
  for (const iss of stuckFix) {
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

  // --- DRAIN: promuovi 1 queued a agent:fix (slot già verificato libero) -------
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

    if (body && detectWorkflowScoped(`${cand.title}\n${body}`)) {
      const wfRefs = [...new Set((body.match(WORKFLOW_PATH_RE) || []).concat(
        (body.match(BARE_YML_RE) || []).filter((y) => !NON_WORKFLOW_YML.has(y.toLowerCase())),
      ))].slice(0, 5).join(', ');
      console.log(`PARK #${cand.number} (workflow-scoped: ${wfRefs}) → no promozione, evito run bloccato`);
      const note = `⏭️ **Pre-flight drainer (zero-Claude, #1724)**: il fix di questa follow-up tocca **esclusivamente** file \`.github/workflows/**\` (${wfRefs}), che il token GitHub App di \`issue-fix\` non può pushare (manca lo scope \`workflows\`). Promuoverla a \`agent:fix\` brucerebbe ~1M token in un run che finirebbe comunque \`blocked-workflows-scope\`. **Non promuovo**: serve un PAT abilitato o mano umana. Rimuovo \`agent:fix-queued\` e parko (riapribile: togli \`fu-parked\` se il contesto cambia).\n\n<!-- FIX_OUTCOME: blocked-workflows-scope -->`;
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
