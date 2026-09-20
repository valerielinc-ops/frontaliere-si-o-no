#!/usr/bin/env node
/**
 * report-deploy-run-failure.mjs — l'osservatore CROSS-WORKFLOW del deploy.
 *
 * ─── Il buco che chiude, misurato ────────────────────────────────────────
 *
 * Il 2026-09-19 alle 20:54Z la PR #9238 ha rimesso in `deploy.yml` un gate
 * fail-closed nel job `approve production promotion`. Da lì in poi OGNI run di
 * `Deploy to GitHub Pages` su `main` moriva in ~20 secondi, e nessun allarme è
 * partito per 10 ore e 24 minuti: 78 run rosse consecutive, da 21:11Z a
 * 07:14Z del 20/09, viste per caso da un `gh run list`. Non era la prima
 * volta: lo stesso gate aveva fatto lo stesso danno il 2026-09-16 con #8883.
 *
 * PERCHÉ il canale d'allarme esistente non ha suonato — la risposta è nella
 * Jobs API della run 35469667575, la prima della serie:
 *
 *     validate production promotion trigger  success
 *     approve production promotion           failure   ← step 3
 *     matrix-setup                           skipped
 *     prep                                   skipped
 *     build-locale                           skipped   ←←←
 *     rearm                                  skipped
 *
 * TUTTI i reporter di `deploy.yml` — le quattro chiamate a
 * `scripts/lib/github-issue-creator.mjs` e le due adozioni della composite
 * action — sono step DENTRO il job `build-locale`. Quando il rosso è a monte,
 * `build-locale` non è "rosso": è `skipped`, e uno step `if: failure()` di un
 * job saltato non viene mai valutato. L'unico osservatore che guarda le run
 * dall'esterno, `scan-job-timeouts.mjs` (cron orario di
 * `job-timeout-monitor.yml`), è corretto ma ha un altro mandato: apre solo su
 * due firme PROVATE — `cancelled` con annotation di timeout, e host-kill
 * (`failure` con uno step ancora `in_progress`). Un fallimento pulito di 20
 * secondi non ha nessuna delle due. Nessuno dei due è rotto; insieme lasciano
 * scoperta esattamente la classe di guasto che si è manifestata due volte.
 *
 * ─── Il rumore da NON produrre ───────────────────────────────────────────
 *
 * `Deploy to GitHub Pages` è il workflow più cancellato del repo: 91 righe
 * `cancelled` su 100 nella misura del 2026-08-18 citata da
 * `close-recovered-failure-issues.mjs`, e 38 su 40 nel listing del 2026-09-20.
 * Sono scarti di coda della concorrenza newest-wins, con ZERO job avviati
 * (`total_count: 0` nella Jobs API della run 35522399104) — verificati uno per
 * uno anche dal commento in testa a `deploy.yml`. Un allarme che li contasse
 * sparerebbe decine di volte al giorno e verrebbe ignorato entro un giorno.
 *
 * La discriminante è strutturale, non euristica: `alarmVerdict` guarda la
 * `conclusion` della run, e SOLO `failure` / `timed_out` / `startup_failure`
 * arrivano al ramo di apertura. `cancelled` non ci arriva mai — non per un
 * filtro che si può sbagliare, ma perché non è quel ramo. Lo stesso vale per
 * il workflow: il job di allarme ha l'`if:` a monte del checkout, quindi su
 * una cancellazione non parte nemmeno un runner.
 *
 * ─── Perché NON è un gate ────────────────────────────────────────────────
 *
 * Gira in un workflow SEPARATO su `workflow_run: types: [completed]`, cioè
 * DOPO che la run osservata ha già il suo verdetto. Non può ritardare né far
 * fallire un deploy, un merge o una PR: non è un check di nessuno dei tre.
 * Per la stessa ragione questo script esce SEMPRE 0 in report e resolve — la
 * stessa regola di `report-workflow-failure.mjs`. Il rosso vero è già
 * registrato dalla run osservata; un osservatore che si colora di rosso
 * aggiunge un secondo allarme su se stesso e non aiuta nessuno.
 *
 * ─── Dedup e chiusura ────────────────────────────────────────────────────
 *
 * Titolo FISSO `Workflow Failure: <name del workflow osservato>` — nessun run
 * id, sha o contatore dentro i primi 60 caratteri (#5121). Quindi:
 *   - APERTURA/AGGIORNAMENTO: `createGithubIssue` dedup sul prefisso del
 *     titolo; se la canonica è già aperta posta un commento di ricorrenza 🔁
 *     col contesto nuovo (job, step, streak) invece di coniare un duplicato.
 *   - CHIUSURA: DUE chiuditori, entrambi già nel repo.
 *     a) lo step gemello `--resolve` di questo stesso workflow, che gira sul
 *        primo `workflow_run` con `conclusion == 'success'` — latenza di
 *        secondi;
 *     b) `close-recovered-failure-issues.mjs` (cron :17), che riconosce il
 *        titolo via `TITLE_RE` e fa `gh run list -w "<name>"`. Funziona qui
 *        perché il nome nel titolo è quello del workflow OSSERVATO, che è
 *        esattamente ciò che quel reconciler cerca. Vedi `coverageOf` in
 *        `scripts/ci/failure-issue-inventory.mjs`, esteso nello stesso giro
 *        perché il gate di accoppiamento sappia leggere questa forma.
 *
 * ─── Cosa deve dire l'allarme ────────────────────────────────────────────
 *
 * «il deploy è rosso» non basta: nel caso che ha motivato questo script il
 * rosso era in un job di 20 secondi che gira PRIMA del build, quindi né la
 * durata né gli step del build lo mostravano. Il body nomina il JOB e lo STEP
 * falliti, letti dalla Jobs API, e da QUANTE run consecutive dura la serie
 * (`consecutiveFailureStreak`) — che è il numero che trasforma «una rossa,
 * capita» in «la produzione non riceve niente da N run».
 *
 * ─── CLI ─────────────────────────────────────────────────────────────────
 *
 *   node scripts/ci/report-deploy-run-failure.mjs --mode report  [--dry-run]
 *   node scripts/ci/report-deploy-run-failure.mjs --mode resolve [--dry-run]
 *
 * Input via env (mai come testo di script — `check-workflow-input-injection.mjs`):
 *   ALARM_WORKFLOW_NAME  display name della run osservata (obbligatorio)
 *   ALARM_RUN_ID         id numerico della run osservata
 *   ALARM_RUN_URL        url html della run osservata
 *   ALARM_RUN_CONCLUSION conclusion della run osservata
 *   ALARM_REPO           owner/name (default: GITHUB_REPOSITORY)
 *   ALARM_DESCRIPTION_FILE  dove scrivere il body (default: alarm-description.md)
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { redactWorkflowPaths } from './report-validate-dist-failure.mjs';

/** Conclusioni che sono un guasto del workflow osservato. */
export const FAILING_CONCLUSIONS = new Set(['failure', 'timed_out', 'startup_failure']);

/**
 * Conclusioni TRASPARENTI per la streak: non sono un guasto, ma nemmeno una
 * prova che il guasto sia finito. Una run mai partita non è né un fallimento
 * né un'osservazione — stesso ragionamento di `dropPhantomCancellations` in
 * `close-recovered-failure-issues.mjs`, senza il suo costo (lì serve una
 * chiamata `gh api` per riga `cancelled`, e su questo workflow sarebbero ~91
 * chiamate per passata).
 */
export const TRANSPARENT_CONCLUSIONS = new Set(['cancelled', 'skipped', 'neutral', 'action_required', 'stale']);

/**
 * Il verdetto dell'osservatore per una run completata.
 *
 * Deliberatamente una funzione pura di UN campo: è la riga che separa il
 * rumore dall'allarme, e va provata con un test, non a occhio.
 *
 * @param {{ conclusion?: string|null }} run
 * @returns {'report'|'resolve'|'ignore'}
 */
export function alarmVerdict(run) {
  const c = String(run?.conclusion ?? '').toLowerCase();
  if (c === 'success') return 'resolve';
  if (FAILING_CONCLUSIONS.has(c)) return 'report';
  // `cancelled` (scarto di concorrenza), `skipped`, e qualunque conclusion
  // futura che GitHub aggiunga: silenzio. Il bias è verso il silenzio perché
  // un falso allarme su questo workflow significa decine di issue al giorno.
  return 'ignore';
}

/**
 * Il primo job fallito e il suo primo step fallito, nell'ordine della Jobs API
 * (che è l'ordine di avvio). È il primo, non l'ultimo: su un fallimento a
 * monte i job a valle risultano `skipped`, e la causa è sempre il primo rosso.
 *
 * @param {{ jobs?: Array<{name?: string, conclusion?: string, steps?: Array<{name?: string, number?: number, conclusion?: string}>}> }} payload
 * @returns {{ job: string, step: string|null, stepNumber: number|null } | null}
 */
export function firstFailure(payload) {
  const jobs = Array.isArray(payload?.jobs) ? payload.jobs : [];
  const job = jobs.find((j) => FAILING_CONCLUSIONS.has(String(j?.conclusion ?? '')));
  if (!job) return null;
  const steps = Array.isArray(job.steps) ? job.steps : [];
  const step = steps.find((s) => FAILING_CONCLUSIONS.has(String(s?.conclusion ?? '')));
  return {
    job: String(job.name ?? '(job senza nome)'),
    step: step ? String(step.name ?? '(step senza nome)') : null,
    stepNumber: step && Number.isInteger(step.number) ? step.number : null,
  };
}

/**
 * Quante run CONSECUTIVE sono fallite, dalla più recente all'indietro.
 *
 * Le run non completate e le conclusion trasparenti (sopra tutte `cancelled`)
 * non contano né come fallimento né come verde: vengono SALTATE, non spezzano
 * la serie. Senza questa regola la streak su `Deploy to GitHub Pages` sarebbe
 * quasi sempre 1, perché fra due rosse si infila regolarmente uno scarto di
 * coda — ed è proprio il numero che dice quanto dura il guasto.
 *
 * `fromRunId` ancora il conteggio alla run OSSERVATA invece che alla più
 * recente del listing. In esercizio le due coincidono, ma non sempre: fra il
 * fallimento e questo osservatore può essersi già accodata un'altra run, e
 * soprattutto è ciò che rende RIPRODUCIBILE il conteggio su una run passata
 * (`--mode report` via dispatch su un id storico). Se l'id non è nel listing
 * — run più vecchia della pagina — si parte dalla più recente, che è il
 * comportamento conservativo già in uso altrove nel repo.
 *
 * `saturated` dice che la serie ha consumato TUTTA la finestra letta senza
 * incontrare un verde: il numero è allora un limite inferiore, non la misura.
 * Non è un dettaglio: nel guasto del 19/09 la serie vera era 78 run, e su una
 * pagina da 100 righe ancorata all'ultima rossa se ne vedono 29. Un allarme
 * che dicesse «29» senza dire «almeno» farebbe sembrare il guasto più corto
 * di quanto è.
 *
 * @param {Array<{databaseId?: number, status?: string, conclusion?: string|null}>} runs newest-first
 * @param {{ fromRunId?: string|number|null }} [opts]
 * @returns {{ streak: number, saturated: boolean }}
 */
export function consecutiveFailureStreak(runs, opts = {}) {
  if (!Array.isArray(runs)) return { streak: 0, saturated: false };
  let window = runs;
  const from = opts?.fromRunId == null ? null : String(opts.fromRunId);
  if (from) {
    const at = runs.findIndex((r) => String(r?.databaseId ?? '') === from);
    if (at >= 0) window = runs.slice(at);
  }
  let streak = 0;
  let sawGreen = false;
  for (const r of window) {
    if (String(r?.status ?? 'completed') !== 'completed') continue;
    const c = String(r?.conclusion ?? '').toLowerCase();
    if (TRANSPARENT_CONCLUSIONS.has(c) || c === '') continue;
    if (FAILING_CONCLUSIONS.has(c)) {
      streak++;
      continue;
    }
    sawGreen = true;
    break; // `success` (o qualunque esito non-guasto): la serie finisce qui.
  }
  return { streak, saturated: streak > 0 && !sawGreen };
}

/**
 * Il body dell'allarme.
 *
 * Non cita MAI un path `.github/workflows/**` né un `<nome>.yml` nudo: li
 * riscriverebbe `redactWorkflowPaths`, ma soprattutto
 * `scripts/ci/check-workflows-scope.mjs` Mode 1 terminerebbe `issue-fix.yml` a
 * zero token su una issue che li nomina, rendendo l'allarme inutile per il
 * fixer. Stessa regola di `report-workflow-failure.mjs`.
 *
 * @returns {string}
 */
export function buildAlarmDescription({
  workflowName,
  runUrl,
  runId,
  conclusion,
  failure,
  streak,
  streakSaturated,
}) {
  const where = failure
    ? (failure.step
      ? `job \`${failure.job}\`, step ${failure.stepNumber ?? '?'} \`${failure.step}\``
      : `job \`${failure.job}\` (nessuno step con esito \`failure\`: il job è morto prima di attribuirne uno)`)
    : 'nessun job con esito `failure` nella Jobs API — la run è morta prima di avviare i job (startup failure o cancellazione dell\'intero workflow)';

  const streakLine = streakSaturated
    ? `**almeno ${streak}** (la serie copre tutto lo storico letto senza un solo verde: potrebbe essere più lunga)`
    : `**${streak}**`;

  const lines = [
    `Il workflow **${workflowName}** è rosso su \`main\` e nessuno step del suo`,
    'stesso run può segnalarlo: quando il guasto è a monte del build, i job a',
    'valle risultano `skipped` e i loro reporter `if: failure()` non vengono mai',
    'valutati. Questo allarme arriva da un osservatore esterno.',
    '',
    '## Dove',
    '',
    `- **Fallito in:** ${where}`,
    `- **Esito della run:** \`${conclusion}\``,
    `- **Run:** ${runUrl || `(id ${runId})`}`,
    '',
    '## Da quanto',
    '',
    `- **Run consecutive fallite:** ${streakLine}`,
    '- Le run `cancelled` non contano: su questo workflow sono scarti di coda',
    '  della concorrenza newest-wins, con zero job avviati. Non spezzano la',
    '  serie e non la allungano.',
    '',
    '## Cosa significa',
    '',
    'Finché la serie non si interrompe con un `success`, la produzione NON sta',
    'ricevendo niente, anche se il ciclo di merge continua a mergiare',
    'normalmente. È la firma del guasto: verde a monte, silenzio a valle.',
    '',
    '## Chiusura',
    '',
    'Automatica, senza intervento: questa issue si chiude da sola al primo run',
    `di **${workflowName}** con esito \`success\` — dall'osservatore stesso in`,
    'pochi secondi, e comunque dal reconciler orario come seconda rete.',
  ];
  return redactWorkflowPaths(lines.join('\n'));
}

/* ── plumbing gh (non testato: parla con la rete, come da convenzione) ── */

function gh(args, { allowFailure = true } = {}) {
  try {
    return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  } catch (err) {
    if (!allowFailure) throw err;
    console.error(`[deploy-alarm] \`gh ${args.slice(0, 3).join(' ')}…\` fallito: ${err?.message ?? err}`);
    return null;
  }
}

/** Quante run di storico leggiamo per la streak. Una pagina piena di `gh run list`. */
export const RUN_HISTORY_LIMIT = 100;

function main() {
  const argv = process.argv.slice(2);
  const modeIdx = argv.indexOf('--mode');
  const mode = modeIdx >= 0 ? argv[modeIdx + 1] : 'report';
  const dryRun = argv.includes('--dry-run');

  if (mode !== 'report' && mode !== 'resolve') {
    console.error('Usage: report-deploy-run-failure.mjs --mode report|resolve [--dry-run]');
    process.exit(2); // uso errato dei flag: l'UNICA uscita non-zero.
  }

  const workflowName = process.env.ALARM_WORKFLOW_NAME || '';
  const repo = process.env.ALARM_REPO || process.env.GITHUB_REPOSITORY || '';
  const runId = process.env.ALARM_RUN_ID || '';
  let runUrl = process.env.ALARM_RUN_URL || '';
  let conclusion = process.env.ALARM_RUN_CONCLUSION || '';
  const outFile = process.env.ALARM_DESCRIPTION_FILE || 'alarm-description.md';
  const repoForFetch = process.env.ALARM_REPO || process.env.GITHUB_REPOSITORY || '';

  // `workflow_dispatch` non porta `github.event.workflow_run`: la conclusion va
  // letta dalla run indicata. È il modo in cui questo osservatore si verifica a
  // mano su una run PASSATA senza doverne rompere una nuova — vedi il replay
  // dichiarato nel PR body.
  if (!conclusion && runId) {
    const raw = gh(['api', `repos/${repoForFetch || '{owner}/{repo}'}/actions/runs/${runId}`,
      '--jq', '{conclusion,html_url}']);
    if (raw) {
      try {
        const run = JSON.parse(raw);
        conclusion = String(run?.conclusion ?? '');
        if (!runUrl) runUrl = String(run?.html_url ?? '');
      } catch {
        console.error('[deploy-alarm] run illeggibile: nessun allarme.');
      }
    }
  }

  if (!workflowName) {
    console.error('[deploy-alarm] ALARM_WORKFLOW_NAME mancante: niente da osservare.');
    writeOutput({ verdict: 'ignore' });
    return;
  }

  const verdict = mode === 'resolve' ? 'resolve' : alarmVerdict({ conclusion });
  console.log(`[deploy-alarm] workflow="${workflowName}" conclusion="${conclusion}" → ${verdict}`);

  if (verdict === 'ignore') {
    console.log('[deploy-alarm] nessun allarme: la run non è un guasto del workflow.');
    writeOutput({ verdict: 'ignore' });
    return;
  }
  if (verdict === 'resolve') {
    // La chiusura la fa lo step gemello via `github-issue-creator.mjs --resolve`,
    // così l'inventario di `failure-issue-inventory.mjs` la VEDE nel YAML.
    writeOutput({ verdict: 'resolve' });
    return;
  }

  const repoFlag = repo ? `repos/${repo}` : 'repos/{owner}/{repo}';
  const jobsRaw = runId
    ? gh(['api', `${repoFlag}/actions/runs/${runId}/jobs?per_page=100`])
    : null;
  let failure = null;
  if (jobsRaw) {
    try {
      failure = firstFailure(JSON.parse(jobsRaw));
    } catch {
      console.error('[deploy-alarm] Jobs API illeggibile: il body dirà «job non attribuito».');
    }
  }

  const listArgs = ['run', 'list', '-w', workflowName, '-b', 'main', '-L', String(RUN_HISTORY_LIMIT),
    '--json', 'databaseId,status,conclusion,createdAt'];
  if (repo) listArgs.push('--repo', repo);
  const listRaw = gh(listArgs);
  let streak = 0;
  let streakSaturated = false;
  if (listRaw) {
    try {
      ({ streak, saturated: streakSaturated } = consecutiveFailureStreak(
        JSON.parse(listRaw), { fromRunId: runId || null },
      ));
    } catch {
      console.error('[deploy-alarm] listing dello storico illeggibile: streak non calcolata.');
    }
  }
  // Lo storico può non contenere ancora QUESTA run (indicizzazione): la serie
  // è comunque almeno 1, perché il guasto che stiamo osservando esiste.
  if (streak < 1) streak = 1;

  const description = buildAlarmDescription({
    workflowName, runUrl, runId, conclusion, failure, streak, streakSaturated,
  });

  const summary = failure
    ? `${failure.job} / ${failure.step ?? '(step non attribuito)'}`
    : '(job non attribuito)';

  if (dryRun) {
    console.log(`[deploy-alarm] DRY-RUN — aprirebbe/aggiornerebbe "Workflow Failure: ${workflowName}"`);
    console.log(`[deploy-alarm] DRY-RUN — job/step: ${summary} — streak: ${streak}`);
    console.log('─'.repeat(72));
    console.log(description);
    console.log('─'.repeat(72));
    writeOutput({ verdict: 'report', summary, streak });
    return;
  }

  fs.writeFileSync(outFile, description, 'utf8');
  console.log(`[deploy-alarm] body scritto in ${outFile} (${description.length} char).`);
  writeOutput({ verdict: 'report', summary, streak });
}

/** Espone il verdetto agli step successivi del job, senza farli indovinare. */
function writeOutput({ verdict, summary = '', streak = 0 }) {
  const out = process.env.GITHUB_OUTPUT;
  if (!out) return;
  fs.appendFileSync(out, `verdict=${verdict}\nsummary=${summary}\nstreak=${streak}\n`, 'utf8');
}

const invokedDirectly = process.argv[1] && /report-deploy-run-failure\.mjs$/.test(process.argv[1]);
if (invokedDirectly) main();
