/**
 * triage-sweep.mjs — self-healing del TAGGING (zero-Claude, deterministico).
 *
 * Root cause (2026-06-14): `issue-triage.yml` triggera SOLO su `issues:[opened]`,
 * one-shot. Due buchi lasciano issue orfane senza `agent:triaged` né routing,
 * per sempre (nessun retry):
 *   (a) run di triage cancellato da concurrency-burst (cancel-in-progress:false
 *       mantiene 1 in-progress + 1 pending per gruppo → i pending più vecchi del
 *       burst vengono cancellati-mentre-pending);
 *   (b) issue CREATA da `GITHUB_TOKEN` (tutti i monitor di fallimento:
 *       orchestrate-crawlers, crawler-health, workflow-failure, …) → per
 *       anti-ricorsione GitHub un evento da GITHUB_TOKEN NON triggera altri
 *       workflow → l'issue non scatena MAI `issues:[opened]`.
 * Osservato: 46 issue open senza `agent:triaged`, alcune di 2 settimane
 * (#855/#857 follow-up mai entrati in coda; #1848/#1849 idem).
 *
 * Questo sweep, schedulato, recupera le orfane qualunque sia la causa: riusa il
 * classifier deterministico (`classify-issue.mjs`, stesse regole del path
 * event-driven — niente auto-route di revenue/tracker/validation-failure) e
 * applica `agent:triaged` + routing.
 *
 * GENTLE BY-CONSTRUCTION (anti-burst, frugalità quota):
 *   - crawler-transient → solo `agent:triaged`, NIENTE route: si auto-chiudono
 *     quando il crawler recupera; routarle brucerebbe issue-fix per nulla.
 *   - follow-up → `agent:fix-queued` (+fu-prio): il followup-drainer le promuove
 *     UNA alla volta → nessun burst per costruzione.
 *   - crawler (non-transient) → `agent:fix`, ma CAP per run (ROUTE_FIX_CAP):
 *     ogni agent:fix accende un run issue-fix; il cap fa drenare il backlog su
 *     più tick invece di un'unica raffica. Eccesso loggato (no silent cap).
 *   - revenue/tracker/validation-failure/other → solo `agent:triaged` (umano).
 *
 * `agent:triaged` SEMPRE via GITHUB_TOKEN (idempotenza, non deve triggerare);
 * il routing SEMPRE via GITHUB_PAT (anti-ricorsione + gate sender, come il path
 * event-driven). PAT assente → marca triaged ma non routa (warning), come oggi.
 *
 * Uso:  node scripts/ci/triage-sweep.mjs [--dry-run] [--cap N]
 * Env:  GH_TOKEN (GITHUB_TOKEN: list + agent:triaged + commenti),
 *       GITHUB_PAT (routing), GH_REPO/GITHUB_REPOSITORY.
 */
import { execFileSync } from 'node:child_process';
import { classifyIssue } from '../lib/classify-issue.mjs';

const REPO = process.env.GH_REPO || process.env.GITHUB_REPOSITORY || '';
const PAT = process.env.GITHUB_PAT || '';
const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const ROUTE_FIX_CAP = Number(argv.includes('--cap') ? argv[argv.indexOf('--cap') + 1] : 5);
const SWEEP_MAX = 60; // safety bound sul numero di issue ispezionate per run

function gh(args, { json = true, token } = {}) {
  const env = token ? { ...process.env, GH_TOKEN: token } : process.env;
  const out = execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env });
  return json ? JSON.parse(out) : out;
}

const names = (iss) => (iss.labels || []).map((l) => l.name);
const has = (iss, n) => names(iss).includes(n);

function main() {
  if (!REPO) { console.error('GH_REPO/GITHUB_REPOSITORY mancante'); process.exit(1); }
  console.log(`triage-sweep${DRY ? ' [DRY-RUN]' : ''} repo=${REPO} cap=${ROUTE_FIX_CAP}`);

  let issues = [];
  try {
    issues = gh(['issue', 'list', '--repo', REPO, '--state', 'open',
      '--limit', '300', '--json', 'number,title,labels']);
  } catch (e) { console.error(`gh issue list fallito: ${String(e).slice(0, 160)}`); process.exit(0); }

  // Orfane = open senza agent:triaged. Più vecchie prima (numero crescente).
  const orphans = issues
    .filter((i) => !has(i, 'agent:triaged'))
    .sort((a, b) => a.number - b.number)
    .slice(0, SWEEP_MAX);

  if (!orphans.length) { console.log('Nessuna issue orfana (tutte triaged). ✅'); return; }
  console.log(`Issue orfane senza agent:triaged: ${orphans.length}`);

  let routedFix = 0;
  let routedQueue = 0;
  let markedOnly = 0;
  let fixDeferredByCap = 0;

  // Helper: marca agent:triaged (GITHUB_TOKEN, idempotente, non triggera).
  const markTriaged = (n) => {
    if (DRY) { console.log(`[dry] #${n} → +agent:triaged`); return; }
    try { gh(['issue', 'edit', String(n), '--repo', REPO, '--add-label', 'agent:triaged'], { json: false }); }
    catch (e) { console.log(`::warning::#${n} agent:triaged fallito: ${String(e).slice(0, 100)}`); }
  };

  for (const iss of orphans) {
    const n = iss.number;
    const { category, autofix, route, fuPrio } = classifyIssue(iss.title, names(iss));

    // crawler non-transient oltre il cap: NON marcare triaged → resta orfano →
    // il prossimo tick lo riprende (drain del backlog su più run, anti-burst).
    // Decisione PRIMA di qualunque label, altrimenti il filtro orfani lo
    // perderebbe per sempre.
    const isCrawlerFix = autofix === true && route === 'fix' && !has(iss, 'crawler-transient');
    if (isCrawlerFix && PAT && routedFix >= ROUTE_FIX_CAP) {
      fixDeferredByCap++;
      continue;
    }

    // Da qui marchiamo SEMPRE triaged (idempotente).
    markTriaged(n);

    // crawler-transient → solo triaged (si auto-chiudono, routarle = burn).
    if (has(iss, 'crawler-transient')) {
      console.log(`#${n} crawler-transient → solo triaged (auto-close, no route).`);
      markedOnly++;
      continue;
    }

    // categorie non auto-route (revenue/tracker/validation-failure/other) → human.
    if (route === 'none' || autofix !== true) { markedOnly++; continue; }
    if (!PAT) { console.log(`::warning::#${n} route=${route} ma GITHUB_PAT assente → non routato.`); markedOnly++; continue; }

    if (route === 'queue') {
      // follow-up: gentle by-construction (drainer 1-alla-volta) → nessun cap.
      const prio = fuPrio || 'low';
      if (DRY) { console.log(`[dry] #${n} → agent:fix-queued + fu-prio:${prio}`); routedQueue++; continue; }
      try {
        gh(['issue', 'edit', String(n), '--repo', REPO,
          '--add-label', 'agent:fix-queued', '--add-label', `fu-prio:${prio}`], { json: false, token: PAT });
        console.log(`#${n} → agent:fix-queued + fu-prio:${prio} (drainer).`);
        routedQueue++;
      } catch (e) { console.log(`::warning::#${n} accodamento PAT fallito: ${String(e).slice(0, 100)}`); }
    } else {
      // crawler non-transient → agent:fix (sotto cap, già verificato sopra).
      if (DRY) { console.log(`[dry] #${n} → agent:fix (crawler)`); routedFix++; continue; }
      try {
        gh(['issue', 'edit', String(n), '--repo', REPO, '--add-label', 'agent:fix'], { json: false, token: PAT });
        console.log(`#${n} → agent:fix (crawler, triggera issue-fix).`);
        routedFix++;
      } catch (e) { console.log(`::warning::#${n} agent:fix PAT fallito: ${String(e).slice(0, 100)}`); }
    }
  }

  console.log(`\nSweep done: fix=${routedFix} queue=${routedQueue} marked-only=${markedOnly}` +
    (fixDeferredByCap ? ` · ${fixDeferredByCap} crawler-fix rinviati dal cap ${ROUTE_FIX_CAP}/run (no silent cap; prossimo tick).` : ''));
}

main();
