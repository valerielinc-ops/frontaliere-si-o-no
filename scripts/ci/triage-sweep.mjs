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
 * event-driven — ogni categoria autofix dal 2026-07-05, owner decision "Rimuovi
 * tutte le guardie") e applica `agent:triaged` + routing.
 *
 * GENTLE BY-CONSTRUCTION (anti-burst, frugalità quota):
 *   - crawler-transient → solo `agent:triaged`, NIENTE route: si auto-chiudono
 *     quando il crawler recupera; routarle brucerebbe issue-fix per nulla.
 *   - crawler (non-transient) → `agent:fix` diretto SOLO se lo slot issue-fix è
 *     libero, e UNO per run (`crawlerDirectFixBudget`); gli altri finiscono in
 *     `agent:fix-queued` + `fu-prio:high` come tutti. Vedi sotto.
 *   - ogni altra categoria (follow-up, revenue, tracker, validation-failure,
 *     other, …) → `agent:fix-queued` (+fu-prio): il followup-drainer le
 *     promuove UNA alla volta → nessun burst per costruzione.
 *
 * IL CAP A 5 ERA CALIBRATO SUL NUMERO SBAGLIATO (#5514, 2026-08-10). Il vecchio
 * `ROUTE_FIX_CAP=5` era nato come anti-burst, ma la coda che doveva proteggere
 * ha profondità **1**, non 5: `issue-fix.yml` ha `concurrency: group: issue-fix`
 * + `cancel-in-progress: false`, e con cancel=false GitHub tiene UNA sola run
 * pending per gruppo — ogni nuova pending SFRATTA la precedente. Cinque
 * `agent:fix` applicati nello stesso minuto da un unico run di questo sweep
 * garantiscono quindi quattro run cancellate, e una run cancellata su una issue
 * crawler non veniva ripresa da nessuno (`on: issues:[labeled]` è one-shot,
 * l'evento è consumato; il rescue del drainer filtra su `isQueueManaged`, che
 * esclude i crawler per definizione). Misurato il 2026-08-08 alle 09:02: cinque
 * `[crawler-health]` etichettate insieme, 1 run riuscita e 4 cancellate —
 * #5392 #5393 #5394 #5395 ancora aperte con `agent:fix` addosso due giorni dopo.
 * Ora l'eccedenza non viene più rinviata (rinviarla ripeteva la raffica al tick
 * successivo): entra nella coda `agent:fix-queued`, che il followup-drainer
 * drena UNO alla volta e solo a slot libero. `fu-prio:high` perché un crawler
 * rotto è production-critical e non deve drenare dietro ai follow-up.
 *
 * Secondo passaggio — triaged-but-not-routed (aggiunto 2026-07-05, follow-up #3580):
 * Copre un terzo buco: issue-triage.yml applica `agent:triaged` e routing nella
 * stessa run; se la run viene cancellata DOPO aver applicato agent:triaged ma
 * PRIMA del routing (race di concurrency) l'issue resta triaged-ma-non-routata
 * per sempre (il primo passaggio non la vede: non è orfana). Usato anche per il
 * backfill one-time post-PR #3554 (nuova policy routing universale: categorie
 * revenue/tracker/validation-failure/other ora ricevono agent:fix-queued). Non
 * tocca le issue già in stato di routing (agent:fix/agent:fix-queued/fu-parked/
 * fu-attempt:*) né le crawler-transient.
 *
 * `agent:triaged` SEMPRE via GITHUB_TOKEN (idempotenza, non deve triggerare);
 * il routing SEMPRE via GITHUB_PAT (anti-ricorsione + gate sender, come il path
 * event-driven). PAT assente → le routabili (fix/queue) restano ORFANE (no
 * triaged): uno sweep post-recovery le routa. Tagghiamo solo crawler-transient
 * (l'unica categoria non-routabile per costruzione, vedi sopra).
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
// Default 1 (era 5): tetto sui `agent:fix` DIRETTI per run. La coda concurrency
// di issue-fix ha profondità 1 — vedi la nota nel docstring — quindi qualunque
// valore >1 produce sfratti garantiti. Resta un knob perché serve poterlo
// azzerare (`--cap 0` → tutti i crawler in coda) in una sessione di debug.
const capArg = argv.includes('--cap') ? Number(argv[argv.indexOf('--cap') + 1]) : 1;
const ROUTE_FIX_CAP = Number.isFinite(capArg) ? capArg : 1; // --cap senza valore/non-numerico → default 1 (no cap-off silenzioso)
const SWEEP_MAX = 60; // safety bound sul numero di issue ispezionate per run

function gh(args, { json = true, token } = {}) {
  const env = token ? { ...process.env, GH_TOKEN: token } : process.env;
  const out = execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env });
  return json ? JSON.parse(out) : out;
}

/** Quante run issue-fix sono in volo (queued|in_progress). Errore API →
 * +Infinity (conservativo: slot considerato occupato → nessun route diretto,
 * tutto in coda — che è comunque una destinazione corretta, non una perdita). */
function inFlightFixCount() {
  let n = 0;
  for (const status of ['queued', 'in_progress']) {
    try {
      const runs = gh(['run', 'list', '--repo', REPO, '--workflow', 'issue-fix.yml',
        '--status', status, '--json', 'databaseId', '--limit', '20']);
      n += Array.isArray(runs) ? runs.length : 0;
    } catch { return Number.POSITIVE_INFINITY; }
  }
  return n;
}

/**
 * Quanti `agent:fix` DIRETTI (route='fix', crawler) questo run può applicare.
 * Pura → testabile senza mock.
 *
 * Lo slot è "rivendicato" se una run issue-fix è già queued/in_progress OPPURE
 * se una issue aperta porta già `agent:fix` (una run può non essere ancora
 * registrata in `gh run list`: la label è il claim, la run la conseguenza).
 * In quel caso il budget è 0 e ogni crawler va in coda: applicare la label
 * adesso sfratterebbe la pending esistente. Slot libero → `cap` (default 1).
 *
 * @param {{inFlightFixRuns: number, openFixLabeled: number, cap?: number}} args
 */
export function crawlerDirectFixBudget({ inFlightFixRuns, openFixLabeled, cap = ROUTE_FIX_CAP }) {
  const slotClaimed = !(inFlightFixRuns === 0) || openFixLabeled > 0;
  if (slotClaimed) return 0;
  return Number.isFinite(cap) && cap > 0 ? cap : 0;
}

const names = (iss) => (iss.labels || []).map((l) => l.name);
const has = (iss, n) => names(iss).includes(n);

// Labels che indicano che il routing è già stato applicato (in qualsiasi forma).
//
// Exported (#5524 item 3): i tre `fu-attempt:N` qui sono un DUPLICATO manuale
// di `MAX_ATTEMPTS` in followup-drainer.mjs (quel modulo alza il contatore fino
// a `MAX_ATTEMPTS`; questo elenca le label che ne risultano, così `unrouted`
// sotto non ri-tratta come orfana una issue che il drainer ha già preso in
// carico). Nessun test legava i due prima d'ora — vedi
// tests/followup-drainer-max-attempts-labels.test.ts, che pretende
// `ROUTING_LABELS` contenga esattamente `fu-attempt:1..MAX_ATTEMPTS`, né più né
// meno. Se `MAX_ATTEMPTS` sale senza toccare questa riga, il tetto reale del
// drainer supera l'ultima label che questo sweep riconosce come "instradata":
// `gh issue edit --add-label` su una label che il repo non ha mai creato fallisce
// (silenziosamente, catturato dal try/catch di `edit()` in followup-drainer.mjs),
// quindi la label non nuova non arriva mai sulla issue mentre quella vecchia non
// viene mai rimossa — la issue resta bloccata sul contatore precedente,
// ritentata a ogni giro senza mai raggiungere `fu-parked`.
export const ROUTING_LABELS = ['agent:fix', 'agent:fix-queued', 'fu-parked', 'fu-attempt:1', 'fu-attempt:2', 'fu-attempt:3'];

function main() {
  if (!REPO) { console.error('GH_REPO/GITHUB_REPOSITORY mancante'); process.exit(1); }
  console.log(`triage-sweep${DRY ? ' [DRY-RUN]' : ''} repo=${REPO} cap=${ROUTE_FIX_CAP}`);

  let issues = [];
  try {
    issues = gh(['issue', 'list', '--repo', REPO, '--state', 'open',
      '--limit', '300', '--json', 'number,title,labels']);
  } catch (e) { console.error(`gh issue list fallito: ${String(e).slice(0, 160)}`); process.exit(0); }

  // Orfane = open senza agent:triaged. Più vecchie prima (numero crescente).
  const allOrphans = issues
    .filter((i) => !has(i, 'agent:triaged'))
    .sort((a, b) => a.number - b.number);
  const orphans = allOrphans.slice(0, SWEEP_MAX);

  // Budget di route DIRETTO per questo run (#5514): 0 se lo slot issue-fix è già
  // rivendicato, altrimenti `ROUTE_FIX_CAP` (default 1). Calcolato UNA volta:
  // `routedFix` lo consuma, e da lì in poi i crawler vanno in coda invece che
  // sfrattarsi a vicenda. Il conteggio delle `agent:fix` aperte è gratis (la
  // lista open è già in mano); la sola chiamata extra è `gh run list`.
  const directFixBudget = crawlerDirectFixBudget({
    inFlightFixRuns: inFlightFixCount(),
    openFixLabeled: issues.filter((i) => has(i, 'agent:fix')).length,
  });
  console.log(`budget route diretto (crawler→agent:fix) per questo run: ${directFixBudget}` +
    (directFixBudget === 0 ? ' — slot issue-fix già rivendicato → tutti i crawler in coda.' : '.'));

  // Contatori condivisi tra i due passaggi (aggregati nel summary finale).
  let routedFix = 0;
  let routedQueue = 0;
  let markedOnly = 0;
  let crawlerQueued = 0;
  let routeDeferredNoPat = 0;

  // Helper: marca agent:triaged (GITHUB_TOKEN, idempotente, non triggera).
  const markTriaged = (n) => {
    if (DRY) { console.log(`[dry] #${n} → +agent:triaged`); return; }
    try { gh(['issue', 'edit', String(n), '--repo', REPO, '--add-label', 'agent:triaged'], { json: false }); }
    catch (e) { console.log(`::warning::#${n} agent:triaged fallito: ${String(e).slice(0, 100)}`); }
  };

  // --- Primo passaggio: orfane (senza agent:triaged) ---
  if (!orphans.length) {
    console.log('Nessuna issue orfana (tutte triaged). ✅');
  } else {
    // Logga il TOTALE pre-slice (no silent cap): l'eccesso oltre SWEEP_MAX è ripreso al prossimo tick.
    console.log(`Issue orfane senza agent:triaged: ${allOrphans.length}` +
      (allOrphans.length > orphans.length
        ? ` (ispeziono prime ${orphans.length}/${allOrphans.length} questo run, resto al prossimo tick).`
        : ''));

    for (const iss of orphans) {
      const n = iss.number;
      const { category, autofix, route, fuPrio } = classifyIssue(iss.title, names(iss));

      // Routable = ha un routing reale (fix/queue), auto-route consentito, non transient.
      // Decisione PRIMA di qualunque label: marcare triaged una routabile che NON
      // riusciamo a routare (PAT assente o oltre cap) la perderebbe dal filtro
      // orfani per sempre → nessuno sweep successivo la routa mai (defeat-self).
      const isCrawlerTransient = has(iss, 'crawler-transient');
      const isRoutable = autofix === true && (route === 'fix' || route === 'queue') && !isCrawlerTransient;
      const isCrawlerFix = isRoutable && route === 'fix';

      // PAT assente: routing impossibile. Lascia orfana (NO triaged) → uno sweep
      // post-recovery (PAT ripristinato — evento ricorrente, vedi gh-pat-expiry-monitor)
      // la routa. Tagghiamo solo le NON-routabili (crawler-transient) sotto.
      if (isRoutable && !PAT) {
        routeDeferredNoPat++;
        console.log(`::warning::#${n} route=${route} ma GITHUB_PAT assente → lasciata orfana (no triaged), retry al prossimo sweep con PAT.`);
        continue;
      }

      // crawler non-transient oltre il budget diretto (#5514): NON lo lasciamo
      // più orfano (rinviarlo ripeteva la raffica identica al tick successivo, e
      // nel frattempo la issue restava invisibile al drainer). Va nella coda
      // `agent:fix-queued` come tutti, con priorità alta.
      const crawlerToQueue = isCrawlerFix && routedFix >= directFixBudget;
      const effRoute = crawlerToQueue ? 'queue' : route;

      // Da qui marchiamo SEMPRE triaged (idempotente).
      markTriaged(n);

      // crawler-transient → solo triaged (si auto-chiudono, routarle = burn).
      if (isCrawlerTransient) {
        console.log(`#${n} crawler-transient → solo triaged (auto-close, no route).`);
        markedOnly++;
        continue;
      }

      // Difensivo: dal 2026-07-05 classifyIssue non produce più route='none'/
      // autofix=false per nessuna categoria — questo branch resta come guard
      // contro un futuro classifier che reintroduca una categoria human-only.
      if (route === 'none' || autofix !== true) { markedOnly++; continue; }
      // PAT garantito qui: le routabili con !PAT sono già state lasciate orfane sopra.

      if (effRoute === 'queue') {
        // follow-up: gentle by-construction (drainer 1-alla-volta) → nessun cap.
        // crawler in eccedenza: stessa coda, ma priorità alta (production-critical).
        const prio = crawlerToQueue ? 'high' : (fuPrio || 'low');
        const why = crawlerToQueue ? ' [crawler oltre il budget diretto: coda invece di sfratto]' : '';
        if (DRY) { console.log(`[dry] #${n} → agent:fix-queued + fu-prio:${prio}${why}`); if (crawlerToQueue) crawlerQueued++; else routedQueue++; continue; }
        try {
          gh(['issue', 'edit', String(n), '--repo', REPO,
            '--add-label', 'agent:fix-queued', '--add-label', `fu-prio:${prio}`], { json: false, token: PAT });
          console.log(`#${n} → agent:fix-queued + fu-prio:${prio} (drainer).${why}`);
          if (crawlerToQueue) crawlerQueued++; else routedQueue++;
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
  }

  // --- Secondo passaggio: triaged-but-not-routed ---
  // Copre issue che hanno agent:triaged ma nessuna label di routing: triage
  // interrotto dopo agent:triaged (race concurrency), o issue triagiate sotto
  // la vecchia policy prima che il routing universale fosse esteso (PR #3554).
  let allTriaged = [];
  try {
    allTriaged = gh(['issue', 'list', '--repo', REPO, '--state', 'open',
      '--label', 'agent:triaged', '--limit', '300', '--json', 'number,title,labels']);
  } catch (e) { console.error(`gh issue list (triaged-no-route): ${String(e).slice(0, 160)}`); }

  const unrouted = allTriaged.filter((i) => !ROUTING_LABELS.some((r) => has(i, r)));
  if (!unrouted.length) {
    console.log('Nessuna issue triaged-but-not-routed. ✅');
  } else {
    console.log(`Issue triaged-but-not-routed: ${unrouted.length}`);
    for (const iss of unrouted) {
      const n = iss.number;
      const { route, fuPrio } = classifyIssue(iss.title, names(iss));
      const isCrawlerTransient = has(iss, 'crawler-transient');

      // crawler-transient: si auto-chiudono quando il crawler recupera.
      if (isCrawlerTransient) {
        console.log(`#${n} triaged-no-route crawler-transient → skip (auto-close).`);
        markedOnly++;
        continue;
      }

      if (!PAT) {
        routeDeferredNoPat++;
        console.log(`::warning::#${n} triaged-no-route route=${route} GITHUB_PAT assente → skip, retry al prossimo sweep.`);
        continue;
      }

      // crawler oltre il budget diretto: coda ad alta priorità, mai rinviato (#5514).
      const crawlerToQueue = route === 'fix' && routedFix >= directFixBudget;
      if (route === 'queue' || crawlerToQueue) {
        const prio = crawlerToQueue ? 'high' : (fuPrio || 'low');
        const why = crawlerToQueue ? ' [crawler oltre il budget diretto: coda invece di sfratto]' : '';
        if (DRY) { console.log(`[dry] #${n} triaged-no-route → agent:fix-queued + fu-prio:${prio}${why}`); if (crawlerToQueue) crawlerQueued++; else routedQueue++; continue; }
        try {
          gh(['issue', 'edit', String(n), '--repo', REPO,
            '--add-label', 'agent:fix-queued', '--add-label', `fu-prio:${prio}`], { json: false, token: PAT });
          console.log(`#${n} triaged-no-route → agent:fix-queued + fu-prio:${prio}.${why}`);
          if (crawlerToQueue) crawlerQueued++; else routedQueue++;
        } catch (e) { console.log(`::warning::#${n} triaged-no-route accodamento fallito: ${String(e).slice(0, 100)}`); }
      } else if (route === 'fix') {
        if (DRY) { console.log(`[dry] #${n} triaged-no-route → agent:fix (crawler)`); routedFix++; continue; }
        try {
          gh(['issue', 'edit', String(n), '--repo', REPO, '--add-label', 'agent:fix'], { json: false, token: PAT });
          console.log(`#${n} triaged-no-route → agent:fix (crawler).`);
          routedFix++;
        } catch (e) { console.log(`::warning::#${n} triaged-no-route agent:fix fallito: ${String(e).slice(0, 100)}`); }
      }
    }
  }

  console.log(`\nSweep done: fix=${routedFix} queue=${routedQueue} marked-only=${markedOnly}` +
    (crawlerQueued ? ` · ${crawlerQueued} crawler oltre il budget diretto ${directFixBudget}/run → agent:fix-queued fu-prio:high (drainer 1-alla-volta, nessuno sfrattato).` : '') +
    (routeDeferredNoPat ? ` · ${routeDeferredNoPat} routabili lasciate orfane/skip (GITHUB_PAT assente; retry sweep post-recovery).` : ''));
}

// Esegui solo come CLI (non quando importato dai test → evita di lanciare gh).
if (process.argv[1]?.endsWith('triage-sweep.mjs')) {
  main();
}
