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
 */
import { execFileSync } from 'node:child_process';

const DRY = process.argv.includes('--dry-run');
const REPO = process.env.GITHUB_REPOSITORY || '';
const MAX_ATTEMPTS = 3;
// Margine prima di considerare un agent:fix "orfano" (la run deve aver avuto il
// tempo di partire + aprire la PR). Conservativo per non ri-accodare run vive.
const ORPHAN_MIN_AGE_MIN = 30;

const LBL_QUEUED = 'agent:fix-queued';
const LBL_FIX = 'agent:fix';
const LBL_PARKED = 'fu-parked';

// Age-out close: il post-merge-followup apre 1 follow-up per PR mergiata e
// NESSUN workflow le chiude mai → ratchet monotòno (osservate 41 aperte). Un
// follow-up vecchio, inattivo e NON in lavorazione (né agent:fix né
// agent:fix-queued) non verrà mai drenato: chiudilo (riapribile se ricorre). I
// `fu-parked` (tentativi esauriti) sono i candidati principali. Drain, non
// perdita: commento esplicito + reversibile. 0 disabilita.
const AGEOUT_DAYS = Number(process.env.FOLLOWUP_AGEOUT_DAYS || 21);
const AGEOUT_INACTIVE_DAYS = Number(process.env.FOLLOWUP_AGEOUT_INACTIVE_DAYS || 14);
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

/**
 * Un follow-up è eleggibile all'age-out close? Puro (niente gh) → testabile.
 * Vero se: è un `follow-up`, NON in lavorazione (né `agent:fix` né
 * `agent:fix-queued`), creato da ≥ageOutDays E inattivo da ≥inactiveDays. I
 * `fu-parked` ricadono qui (sono follow-up non in coda). Il chiamante aggiunge
 * la guardia "nessuna PR aperta" (impura).
 * @param {{labels?: Array<{name:string}>, createdAt?: string, updatedAt?: string}} iss
 * @param {{now:number, ageOutDays:number, inactiveDays:number}} opts
 */
export function isAgeOutEligible(iss, { now, ageOutDays, inactiveDays }) {
  if (!ageOutDays || ageOutDays <= 0) return false;
  const ls = (iss?.labels || []).map((l) => l.name);
  if (!ls.includes('follow-up')) return false;
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

const names = (iss) => (iss.labels || []).map((l) => l.name);
const has = (iss, n) => names(iss).includes(n);
const attemptOf = (iss) => {
  const m = names(iss).map((n) => /^fu-attempt:(\d+)$/.exec(n)).find(Boolean);
  return m ? parseInt(m[1], 10) : 0;
};
const prioRank = (iss) => (has(iss, 'fu-prio:high') ? 0 : 1); // high prima

function edit(num, { add = [], remove = [] }) {
  const args = ['issue', 'edit', String(num), '--repo', REPO];
  for (const l of add) args.push('--add-label', l);
  for (const l of remove) args.push('--remove-label', l);
  if (DRY) { console.log(`[dry] edit #${num} +[${add}] -[${remove}]`); return; }
  try { gh(args, { json: false }); }
  catch (e) { console.log(`::warning::edit #${num} fallito: ${String(e).slice(0, 120)}`); }
}

/** Esiste una PR fix aperta o mergiata per questa issue? (head fix/issue-N) */
function hasFixPR(num) {
  for (const branch of [`fix/issue-${num}`]) {
    try {
      const prs = gh(['pr', 'list', '--repo', REPO, '--head', branch, '--state', 'all', '--json', 'number', '--limit', '1']);
      if (Array.isArray(prs) && prs.length) return true;
    } catch { /* ignore */ }
  }
  return false;
}

function minutesSince(iso) {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return Number.POSITIVE_INFINITY;
  return (Date.now() - then) / 60000;
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

function main() {
  if (!REPO) { console.error('GITHUB_REPOSITORY mancante'); process.exit(1); }
  console.log(`followup-drainer${DRY ? ' [DRY-RUN]' : ''} repo=${REPO}`);

  // --- AGE-OUT CLOSE: drena il ratchet dei follow-up mai chiusi --------------
  // Ortogonale allo slot issue-fix (chiudere non tocca il fixer) → gira sempre.
  if (AGEOUT_DAYS > 0) {
    const now = Date.now();
    const candidates = listIssues('follow-up')
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

  // Tutto (rescue + drain) gira SOLO a slot issue-fix libero: così il rescue non
  // può mai toccare la issue di una run viva (evita di togliere agent:fix mentre
  // il fix è in corso), e la promozione resta l'unica pending → mai cancellata.
  const inflight = inFlightFixCount();
  if (inflight > 0) {
    console.log(`slot issue-fix occupato (in-flight=${inflight}) → nessuna azione.`);
    return;
  }

  // --- RESCUE + PARK: agent:fix orfani (nessuna PR, nessuna run, vecchi) -------
  // Un follow-up promosso la cui run è morta (cancel/error_max_turns) resta
  // agent:fix senza PR e senza nuovo trigger → stuck. Ri-accoda (bump attempt),
  // park a MAX_ATTEMPTS. Solo su follow-up (label `follow-up`) per non toccare i
  // crawler agent:fix (production-critical, gestione separata).
  const stuckFix = listIssues(LBL_FIX).filter(
    (i) => has(i, 'follow-up') && !has(i, LBL_QUEUED) && !has(i, LBL_PARKED)
  );
  // Promozioni "in assestamento": un agent:fix follow-up giovane e senza PR ha
  // la run viva OPPURE non ancora registrata in `gh run list` (latenza
  // queue→listing di alcuni secondi). In entrambi i casi lo slot issue-fix è
  // logicamente occupato anche se inFlightFixCount()==0 (vedi guard al DRAIN).
  let settlingPromotions = 0;
  for (const iss of stuckFix) {
    const young = minutesSince(iss.updatedAt) < ORPHAN_MIN_AGE_MIN;
    const hasPR = hasFixPR(iss.number);
    if (young && !hasPR) { settlingPromotions++; continue; } // run viva o in registrazione
    if (young) continue;   // giovane + PR → run completata, non orfano
    if (hasPR) continue;   // vecchio + PR → non orfano
    // vecchio + nessuna PR → orfano. Ma «nessuna PR» ha due cause diverse:
    // (a) run morta/crashata (nessun verdetto) → ri-tentabile; (b) ABORT pulita
    // del fixer con verdetto deterministico-non-ri-tentabile (no-root-cause,
    // blocked-*, …) → re-queue inutile, riprodurrebbe lo stesso esito bruciando
    // quota (root cause #1478). Distingui via l'ultimo marker FIX_OUTCOME: se è
    // NON_RETRYABLE → park SUBITO senza consumare i tentativi residui (nessuna
    // perdita: resta aperto, ri-triabile a mano se il contesto cambia).
    const outcome = latestFixOutcome(iss.number);
    if (outcome && NON_RETRYABLE.has(outcome)) {
      console.log(`PARK #${iss.number} (esito non-ri-tentabile: ${outcome}) → no re-queue, evito run identica`);
      edit(iss.number, { add: [LBL_PARKED], remove: [LBL_FIX, LBL_QUEUED] });
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

  const pick = queued[0];
  console.log(`PROMUOVO #${pick.number} (${has(pick, 'fu-prio:high') ? 'high' : 'low'}) → ${LBL_FIX} [coda residua: ${queued.length - 1}]`);
  edit(pick.number, { add: [LBL_FIX], remove: [LBL_QUEUED] });
}

// Esegui solo come CLI (non quando importato dai test → evita di lanciare gh).
if (process.argv[1]?.endsWith('followup-drainer.mjs')) {
  main();
}
