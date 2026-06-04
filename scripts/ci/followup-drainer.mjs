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

function main() {
  if (!REPO) { console.error('GITHUB_REPOSITORY mancante'); process.exit(1); }
  console.log(`followup-drainer${DRY ? ' [DRY-RUN]' : ''} repo=${REPO}`);

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
  for (const iss of stuckFix) {
    if (minutesSince(iss.updatedAt) < ORPHAN_MIN_AGE_MIN) continue; // run forse viva
    if (hasFixPR(iss.number)) continue; // ha già prodotto una PR → non orfano
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
  const queued = listIssues(LBL_QUEUED)
    .filter((i) => !has(i, LBL_PARKED))
    .sort((a, b) => prioRank(a) - prioRank(b) || Date.parse(a.createdAt) - Date.parse(b.createdAt));
  if (!queued.length) { console.log('coda vuota → niente da promuovere.'); return; }

  const pick = queued[0];
  console.log(`PROMUOVO #${pick.number} (${has(pick, 'fu-prio:high') ? 'high' : 'low'}) → ${LBL_FIX} [coda residua: ${queued.length - 1}]`);
  edit(pick.number, { add: [LBL_FIX], remove: [LBL_QUEUED] });
}

main();
