#!/usr/bin/env node
/**
 * report-validate-dist-failure.mjs — reporter diagnostico per i fallimenti di
 * validate-dist (issue #5414, Parte B).
 *
 * Il problema che risolve: la issue canonica "Validation Failure (dist):
 * post-deploy" diceva solo QUALI job erano rossi. Per sapere QUALE gate era
 * fallito e PERCHÉ, un agente doveva scaricare il log del run (decine di MB) e
 * cercarci dentro. Questo reporter fa quel lavoro una volta sola, nel job
 * `validate-dist-report`, e mette il risultato nel body della issue: gate
 * falliti (righe ❌ verbatim), estratto del log dello step fallito, comando di
 * riproduzione locale ricavato da package.json, comando di replay via
 * audit-dist-from-run.yml, e una sezione `## Suggested action` con i path
 * degli script del gate — che è ciò che il fixer estrae.
 *
 * Contratti onorati (verificati sui sorgenti, non dedotti):
 * - DEDUP: il titolo è l'unica chiave (primi 60 char —
 *   scripts/lib/github-issue-creator.mjs, searchSafePrefix). Niente token
 *   variabili nel titolo: run id/SHA/conteggi stanno nel body (#5121).
 *   Un titolo per GATE è un discriminante per-entità (stessa granularità di
 *   cathedral-seo-gates-check), non un token instabile: lo stesso gate che
 *   rifallisce ricade sulla stessa issue canonica.
 * - CLOSER: `Validation Failure (dist): …` sta deliberatamente FUORI dal
 *   TITLE_RE di scripts/ci/close-recovered-failure-issues.mjs (che copre solo
 *   `Workflow|Crawler|CI Failure:`): il ciclo di chiusura è il `--mode
 *   resolve` appaiato qui sotto, che sul verde chiude sia il titolo legacy sia
 *   i per-gate.
 * - TRIAGE: "Validation Failure" nel titolo → categoria validation-failure,
 *   route=queue (scripts/lib/classify-issue.mjs).
 * - FIXER: il body non cita MAI path `.github/workflows/**` (il capability
 *   guard scripts/ci/check-workflows-scope.mjs bloccherebbe il fixer a zero
 *   token); cita invece gli script dei gate sotto `## Suggested action`. Il
 *   riferimento a `audit-dist-from-run.yml` è la sintassi di `gh workflow
 *   run`, senza prefisso di path, e il body cita sempre anche path scripts/
 *   → `detectWorkflowScoped` resta false per costruzione.
 * - SHA: per un run innescato da workflow_run, `github.sha` NON è il commit
 *   della build: il Build SHA nel body è `deploy_ref`
 *   (= workflow_run.head_sha, vedi deploy-publish.yml → validate-dist).
 *
 * Modalità:
 *   --mode report            apre/aggiorna le issue (dist scope di default)
 *   --mode report --scope build   arricchisce la issue `CI Failure (build):`
 *                            (titolo INVARIATO: la matrice 4-locale collassa
 *                            su un'unica issue, ed è load-bearing)
 *   --mode resolve           chiude TUTTE le `Validation Failure (dist): …`
 *   --dry-run                stampa su stdout il JSON dei payload senza
 *                            creare/chiudere nulla (le letture gh restano)
 *
 * Exit code: SEMPRE 0 in report/resolve (il reporter gira in step
 * `continue-on-error` dopo un rosso vero: mai aggiungere un secondo rosso).
 * Non-zero solo per uso errato dei flag.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGithubIssue, resolveGithubIssue } from '../lib/github-issue-creator.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

export const TITLE_PREFIX = 'Validation Failure (dist): ';
export const LEGACY_TITLE = 'Validation Failure (dist): post-deploy';
// Mirrors DEDUP_TITLE_PREFIX_LEN in scripts/lib/github-issue-creator.mjs: i
// primi 60 char del titolo sono la chiave di dedup, quindi il gate name deve
// starci per intero (o essere troncato a token intero da titleForGate).
export const DEDUP_TITLE_PREFIX_LEN = 60;
// Oltre questa soglia di gate falliti, una sola issue riassuntiva col titolo
// legacy: N issue per un rosso sistemico sarebbero rumore, non diagnosi.
export const MAX_PER_GATE_ISSUES = 3;
const EXCERPT_LINES = 40;
const WORKFLOW_DISPLAY_NAME = 'Post-deploy Validate Dist';

/* ── helpers puri (esportati per i test) ─────────────────────────────── */

const ANSI_RE = /\u001b\[[0-9;]*[A-Za-z]/g;
// Prefisso timestamp dei log di GitHub Actions: `2026-08-08T14:17:32.2009366Z `.
const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/;

export function stripAnsi(s) {
  return String(s).replace(ANSI_RE, '');
}

export function cleanLogLine(line) {
  return stripAnsi(String(line).replace(/\r$/, '').replace(TS_RE, ''));
}

// Riga per-gate emessa dai job di post-deploy-validate-dist.yml
// (`printf '%-40s %7.2f rc=%d'` + prefisso ❌/✅ del summary loop).
const GATE_FAIL_RE = /^❌ FAIL\s+(\S+)\s+(\d+(?:\.\d+)?)\s+rc=(\d+)\s*$/;
const SUMMARY_RE = /^\S.*summary:\s*\d+ passed,\s*\d+ failed\s*$/i;

/**
 * Estrae le righe `❌ FAIL <gate> <sec> rc=<n>` e i footer `N passed, M
 * failed` da un log di job (raw: timestamp/ANSI ammessi).
 * @returns {{ failedGates: {gate:string, seconds:number, rc:number, line:string}[], summaryLines: string[] }}
 */
export function parseGateLines(text) {
  const failedGates = new Map();
  const summaryLines = [];
  for (const raw of String(text || '').split('\n')) {
    const line = cleanLogLine(raw);
    const m = GATE_FAIL_RE.exec(line);
    if (m && !failedGates.has(m[1])) {
      failedGates.set(m[1], {
        gate: m[1],
        seconds: Number(m[2]),
        rc: Number(m[3]),
        line,
      });
      continue;
    }
    if (SUMMARY_RE.test(line)) summaryLines.push(line);
  }
  return { failedGates: [...failedGates.values()], summaryLines };
}

/**
 * Ultime ~N righe UTILI dello step fallito da un log di job GitHub Actions.
 *
 * - strip timestamp ISO + sequenze ANSI;
 * - i blocchi `##[group]` … `##[endgroup]` vengono scartati per intero: è lì
 *   che vive il dump `env:` con i secret mascherati (rumore, e nomi di secret
 *   che non devono finire in una issue);
 * - la finestra termina all'ULTIMO `##[error]` del log: i log di job non
 *   hanno delimitatori per-step, ma gli step post-failure (cache save,
 *   upload artifact, reporter) non emettono `##[error]`, quindi l'ultimo
 *   `##[error]` è la coda dello step fallito (verificato sui run
 *   31259344953 e 31247086904).
 */
// Un body che cita un path `.github/workflows/**` fa terminare issue-fix.yml
// PRIMA di Claude (scripts/ci/check-workflows-scope.mjs, Mode 1) — zero token,
// nessuna PR. I log dei job lo contengono davvero: ogni job di un reusable
// workflow apre con `Uses: <owner>/<repo>/.github/workflows/<file>.yml@<ref>`
// (misurato nel log del job 93107610821), e quella riga entra nell'estratto
// ogni volta che il job muore presto — cioè proprio quando la diagnosi serve.
// Redigiamo tenendo il NOME del workflow, che all'umano serve, e togliendo il
// prefisso di path, che è l'unica cosa su cui il guard matcha.
export function redactWorkflowPaths(text) {
  return String(text ?? '').replace(
    /\.github\/workflows\/([A-Za-z0-9._/-]+\.ya?ml)/g,
    (_m, file) => `«workflow ${file}»`,
  );
}

export function extractStepExcerpt(text, { maxLines = EXCERPT_LINES } = {}) {
  const kept = [];
  let inGroup = false;
  for (const raw of String(text || '').split('\n')) {
    const line = cleanLogLine(raw);
    if (line.startsWith('##[group]')) { inGroup = true; continue; }
    if (line.startsWith('##[endgroup]')) { inGroup = false; continue; }
    if (inGroup) continue;
    if (!line.trim()) continue;
    // Belt-and-braces: una riga `  NOME: ***` fuori da un group è comunque un
    // valore mascherato, mai utile in un estratto.
    if (/^\s+[A-Za-z_][A-Za-z0-9_]*:\s*\*\*\*$/.test(line)) continue;
    kept.push(line);
  }
  let end = kept.length;
  for (let i = kept.length - 1; i >= 0; i--) {
    if (kept[i].startsWith('##[error]')) { end = i + 1; break; }
  }
  return redactWorkflowPaths(kept.slice(Math.max(0, end - maxLines), end).join('\n'));
}

/**
 * Titolo per-gate, SEMPRE dentro la finestra di dedup (60 char). Se il gate
 * non ci sta, troncatura deterministica a token intero (separatori `:` `/`
 * `-`), MAI a metà parola: searchSafePrefix scarterebbe il token spezzato e
 * due gate diversi potrebbero collassare su prefissi diversi tra create e
 * resolve.
 */
export function titleForGate(gate) {
  const full = TITLE_PREFIX + gate;
  if (full.length <= DEDUP_TITLE_PREFIX_LEN) return full;
  const budget = DEDUP_TITLE_PREFIX_LEN - TITLE_PREFIX.length;
  let cut = String(gate).slice(0, budget);
  if (/[^:/\-]/.test(String(gate)[budget] || '')) {
    // il taglio ha spezzato un token → scarta il frammento finale
    cut = cut.replace(/[^:/\-]*$/, '');
  }
  cut = cut.replace(/[:/\-]+$/, '');
  if (cut.length < 4) cut = String(gate).slice(0, budget); // guardia anti-vuoto
  return TITLE_PREFIX + cut;
}

/** Label per-gate `ci-gate:<slug>` (kebab-case, solo [a-z0-9-]). */
export function gateLabel(gate) {
  const slug = String(gate)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `ci-gate:${slug || 'unknown'}`;
}

/**
 * Comando npm + path degli script del gate, ricavati da package.json (mai
 * hardcoded: se il gate cambia script, il body segue).
 */
export function gateToRepro(gate, scripts = {}) {
  const has = (k) => Object.prototype.hasOwnProperty.call(scripts, k);
  let npmScript = null;
  if (has(gate)) npmScript = gate;
  else if (String(gate).startsWith('audit:all/')) {
    const sub = `audit:${String(gate).slice('audit:all/'.length)}`;
    if (has(sub)) npmScript = sub;
    else if (has('audit:all')) npmScript = 'audit:all';
  }
  const command = npmScript ? String(scripts[npmScript]) : '';
  const paths = [...new Set(command.match(/(?:scripts|data)\/[A-Za-z0-9._/-]+/g) || [])];
  return { npmScript, command, paths };
}

/**
 * Argomento `audits` per il replay `gh workflow run audit-dist-from-run.yml`:
 * quel workflow esegue `npm run audit:<nome>`, quindi il nome è lo script npm
 * senza prefisso `audit:`. Non-audit (validate:*) → null: servirebbe una
 * rebuild, non un replay da artifact.
 */
export function replayAuditsArg(gate, scripts = {}) {
  const g = String(gate);
  if (!g.startsWith('audit:')) return null;
  const has = (k) => Object.prototype.hasOwnProperty.call(scripts, k);
  if (g.startsWith('audit:all/')) {
    const sub = g.slice('audit:all/'.length);
    return has(`audit:${sub}`) ? sub : 'all';
  }
  const rest = g.slice('audit:'.length);
  return has(g) || rest === 'all' ? rest : null;
}

function runUrl(repo, id) {
  return `https://github.com/${repo}/actions/runs/${id}`;
}

function fence(text) {
  return '```text\n' + String(text || '').replace(/```/g, '`​``') + '\n```';
}

/**
 * Compone i payload issue: uno per gate fallito (max MAX_PER_GATE_ISSUES),
 * altrimenti — zero gate riconosciuti (fallimento infra prima dei gate) o
 * troppi (rosso sistemico) — una sola issue riassuntiva col titolo legacy.
 *
 * Funzione PURA: nessuna chiamata gh, testabile con input sintetici.
 *
 * @param {{
 *   repo: string, runId: string, runAttempt?: string,
 *   deployRunId?: string, deployRef?: string, deployEvent?: string,
 *   results?: { source?: string, postbuild?: string, bfs?: string },
 *   failedJobs?: { name: string, htmlUrl?: string, failedStep?: string,
 *                  gates?: ReturnType<typeof parseGateLines>['failedGates'],
 *                  summaryLines?: string[], excerpt?: string, logNote?: string }[],
 *   pkgScripts?: Record<string, string>,
 * }} input
 * @returns {{ title: string, labels: string[], body: string }[]}
 */
export function buildIssuePayloads(input) {
  const {
    repo, runId, runAttempt = '1',
    deployRunId = '', deployRef = '', deployEvent = '',
    results = {}, failedJobs = [], pkgScripts = {},
  } = input;

  // gate → job che l'ha riportato (primo vince: i gate sono per-job)
  const gateRows = new Map();
  for (const job of failedJobs) {
    for (const g of job.gates || []) {
      if (!gateRows.has(g.gate)) gateRows.set(g.gate, { ...g, job });
    }
  }

  const header = [
    '## Run',
    `- **Validation run:** ${runUrl(repo, runId)} (attempt ${runAttempt})`,
    deployRunId
      ? `- **Build run:** ${runUrl(repo, deployRunId)} (artifact e log della build vivono lì)`
      : '- **Build run:** non determinabile (deploy_run_id assente)',
    '',
    '## Build SHA',
    deployRef
      ? `- **Build SHA:** \`${deployRef}\` (= \`deploy_ref\` = \`workflow_run.head_sha\`: il commit della BUILD. Per un run innescato da workflow_run \`github.sha\` NON è questo commit — non usarlo.)`
      : '- **Build SHA:** non disponibile (deploy_ref non passato: run legacy o dispatch manuale — NON ripiegare su github.sha, che per workflow_run non è il commit della build)',
    deployEvent ? `- **Trigger build:** ${deployEvent}` : null,
    `- **Job results:** source=${results.source || 'n/d'} · postbuild=${results.postbuild || 'n/d'} · bfs=${results.bfs || 'n/d'}`,
    '',
    '## Job/step falliti',
    ...(failedJobs.length > 0
      ? failedJobs.map((j) => {
          const step = j.failedStep ? ` — step fallito: \`${j.failedStep}\`` : '';
          const url = j.htmlUrl ? ` — ${j.htmlUrl}` : '';
          return `- **${j.name}**${step}${url}`;
        })
      : ['- nessun job fallito individuato via jobs API (vedi Job results sopra)']),
  ].filter((l) => l !== null);

  const notes = failedJobs.filter((j) => j.logNote).map((j) => `- ${j.name}: ${j.logNote}`);

  function reproSection(gate) {
    const { npmScript, command, paths } = gateToRepro(gate, pkgScripts);
    const lines = ['## Riproduzione locale'];
    if (npmScript) {
      lines.push(
        `- \`npm run ${npmScript}\` (→ \`${command}\`) — richiede un \`dist/\` completo del sito logico (build locale o rehydrate degli shard).`,
      );
    } else {
      lines.push(
        gate
          ? `- nessuno script npm mappato per \`${gate}\` in package.json — cerca il gate nel job di validazione post-deploy e riproduci lo script corrispondente.`
          : '- nessun gate riconosciuto: la catena è morta prima di stamparne uno (rehydrate, artifact o assert-dist-complete). Partire dagli estratti log qui sopra e da `scripts/ci/assert-dist-complete.mjs`.',
      );
    }
    lines.push(
      `- Offender completi SENZA rilanciare nulla: \`gh run download ${runId} -p "audit-reports*"\` — l'artifact \`audit-reports*-${runId}-${runAttempt}\` contiene i report JSON: contano \`byFeature\` e \`baselineDelta\`; \`topOffenders\` depista (è il campione, non la causa).`,
    );
    return lines;
  }

  function replaySection(gate) {
    const lines = ['## Replay'];
    const auditsArg = gate ? replayAuditsArg(gate, pkgScripts) : null;
    if (auditsArg && deployRunId) {
      lines.push(
        '- Rigira SOLO gli audit dagli artifact del run di build (niente rebuild):',
        '',
        `  \`gh workflow run audit-dist-from-run.yml -f deploy_run_id=${deployRunId} -f audits=${auditsArg}\``,
      );
    } else if (auditsArg) {
      lines.push('- Replay possibile via `gh workflow run audit-dist-from-run.yml -f deploy_run_id=<run della build> -f audits=' + auditsArg + '` — il deploy_run_id non era disponibile a questo reporter.');
    } else {
      lines.push('- Il gate non è un audit rieseguibile da artifact: serve una rebuild per riprodurlo in CI.');
    }
    return lines;
  }

  function suggestedAction(gate) {
    const lines = ['## Suggested action'];
    const paths = gate ? gateToRepro(gate, pkgScripts).paths : [];
    if (paths.length > 0) for (const p of paths) lines.push(`- \`${p}\``);
    else lines.push('- `scripts/ci/classify-validate-dist-failures.mjs` (mappa gate → classe di fallimento; da lì si risale allo script del gate)');
    return lines;
  }

  function excerptSections(jobs) {
    const out = [];
    for (const j of jobs) {
      if (!j.excerpt) continue;
      out.push(`## Estratto log (${j.name})`, fence(j.excerpt), '');
    }
    return out;
  }

  const allGates = [...gateRows.values()];

  if (allGates.length > 0 && allGates.length <= MAX_PER_GATE_ISSUES) {
    return allGates.map(({ gate, line, job }) => {
      const body = [
        `## Dist validation post-deploy fallita — gate \`${gate}\``,
        '',
        ...header,
        '',
        '## Gate falliti',
        fence([line, ...(job.summaryLines || [])].join('\n')),
        '',
        ...excerptSections([job]),
        ...(notes.length > 0 ? ['## Note', ...notes, ''] : []),
        ...reproSection(gate),
        '',
        ...replaySection(gate),
        '',
        ...suggestedAction(gate),
      ].join('\n');
      // Redazione anche sul body completo, non solo sull'estratto: un nome di
      // job/step o una nota futura potrebbero reintrodurre il path che
      // disinnesca il fixer. Un punto solo, applicato sempre.
      return { title: titleForGate(gate), labels: ['Bug', gateLabel(gate)], body: redactWorkflowPaths(body) };
    });
  }

  // Fallback riassuntivo (0 gate riconosciuti, o troppi): titolo legacy.
  const gateBlock = allGates.length > 0
    ? fence(allGates.map((g) => [g.line, ...(g.job.summaryLines || [])].join('\n')).join('\n'))
    : '_nessuna riga `❌ FAIL <gate>` trovata nei log dei job falliti: fallimento infra prima dei gate (rehydrate/artifact/assert-dist-complete) — vedi estratti sotto._';
  const primaryGate = allGates[0]?.gate || null;
  const body = [
    '## Dist validation post-deploy fallita',
    '',
    ...header,
    '',
    '## Gate falliti',
    gateBlock,
    '',
    ...excerptSections(failedJobs.slice(0, MAX_PER_GATE_ISSUES)),
    ...(notes.length > 0 ? ['## Note', ...notes, ''] : []),
    ...reproSection(primaryGate),
    '',
    ...replaySection(primaryGate),
    '',
    ...suggestedAction(primaryGate),
  ].join('\n');
  return [{ title: LEGACY_TITLE, labels: ['Bug'], body: redactWorkflowPaths(body) }];
}

/** Titoli aperti che il resolve deve chiudere: legacy + per-gate, dedup. */
export function selectResolvableTitles(openTitles) {
  return [...new Set((openTitles || []).filter(
    (t) => typeof t === 'string' && t.startsWith(TITLE_PREFIX.trimEnd()),
  ))];
}

/**
 * Individua il job corrente della matrice build (`build-locale (en)`): la
 * jobs API espone il display name, il workflow conosce solo la chiave
 * (`github.job`) e il locale.
 */
export function findCurrentBuildJob(jobs, jobKey, locale) {
  const list = jobs || [];
  const exact = list.find((j) => j.name === (locale ? `${jobKey} (${locale})` : jobKey));
  if (exact) return exact;
  return list.find(
    (j) => typeof j.name === 'string'
      && j.name.startsWith(jobKey)
      && (!locale || j.name.includes(`(${locale}`)),
  ) || null;
}

/* ── strato gh (best-effort: ogni fallimento degrada, mai un exit != 0) ── */

// `gh api` non ha un timeout proprio e il keepalive TCP non copre uno stream
// che rallenta senza morire: su un log da decine di MB execFileSync resterebbe
// bloccato a oltranza. Il tetto per chiamata tiene il job dentro il suo
// timeout-minutes anche nel caso peggiore (3 job × 2 tentativi).
const GH_TIMEOUT_MS = 120_000;

function gh(args, { maxBuffer = 256 * 1024 * 1024 } = {}) {
  try {
    return execFileSync('gh', args, {
      encoding: 'utf8',
      maxBuffer,
      timeout: GH_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      stdio: ['ignore', 'pipe', 'inherit'],
    });
  } catch {
    return null;
  }
}

function fetchRunJobs(repo, runId) {
  const out = gh(['api', `repos/${repo}/actions/runs/${runId}/jobs?per_page=100`]);
  if (out === null) return null;
  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
}

// Primo helper del repo che scarica log via jobs API: robusto per contratto —
// null su qualunque errore (log scaduto, 404 su run in corso, gh vecchio
// senza --allow-escape-sequences), e il chiamante annota la degradazione nel
// body invece di fallire.
function fetchJobLog(repo, jobId) {
  return gh(['api', `repos/${repo}/actions/jobs/${jobId}/logs`, '--allow-escape-sequences'])
    ?? gh(['api', `repos/${repo}/actions/jobs/${jobId}/logs`]);
}

function readPkgScripts() {
  try {
    return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).scripts || {};
  } catch {
    return {};
  }
}

function firstFailedStep(job) {
  return (job.steps || []).find((s) => s.conclusion === 'failure')?.name || '';
}

/* ── modalità ────────────────────────────────────────────────────────── */

function reportDist({ dryRun }) {
  const repo = process.env.GH_REPO || process.env.GITHUB_REPOSITORY || '';
  const runId = process.env.RUN_ID || process.env.GITHUB_RUN_ID || '';
  const runAttempt = process.env.RUN_ATTEMPT || process.env.GITHUB_RUN_ATTEMPT || '1';
  const deployRunId = process.env.INPUT_DEPLOY_RUN_ID || process.env.DEPLOY_RUN_ID || '';
  const deployRef = process.env.INPUT_DEPLOY_REF || process.env.DEPLOY_REF || '';
  const deployEvent = process.env.INPUT_DEPLOY_EVENT || process.env.DEPLOY_EVENT || '';
  const results = {
    source: process.env.SOURCE_RESULT || '',
    postbuild: process.env.POSTBUILD_RESULT || '',
    bfs: process.env.BFS_RESULT || '',
  };

  const failedJobs = [];
  if (repo && runId) {
    const data = fetchRunJobs(repo, runId);
    if (data) {
      // Solo i job di validate-dist: il run chiamante (deploy-publish) contiene
      // anche deploy/publish, che hanno i loro reporter.
      const failed = (data.jobs || []).filter(
        (j) => j.conclusion === 'failure' && /validate-dist/.test(j.name || ''),
      );
      for (const job of failed.slice(0, MAX_PER_GATE_ISSUES)) {
        const log = fetchJobLog(repo, job.id);
        const parsed = log ? parseGateLines(log) : { failedGates: [], summaryLines: [] };
        failedJobs.push({
          name: job.name,
          htmlUrl: job.html_url,
          failedStep: firstFailedStep(job),
          gates: parsed.failedGates,
          summaryLines: parsed.summaryLines,
          excerpt: log ? extractStepExcerpt(log) : '',
          logNote: log ? '' : 'log del job non scaricabile via API (scaduto o non ancora disponibile) — diagnosi limitata a job/step',
        });
      }
    } else {
      console.error('[report-validate-dist-failure] jobs API non raggiungibile — degrado a issue riassuntiva senza dettaglio job');
    }
  }

  const payloads = buildIssuePayloads({
    repo, runId, runAttempt, deployRunId, deployRef, deployEvent,
    results, failedJobs, pkgScripts: readPkgScripts(),
  });

  if (dryRun) {
    process.stdout.write(JSON.stringify(payloads, null, 2) + '\n');
    return Promise.resolve();
  }

  // Sequenziale: createGithubIssue dedupa per titolo (prefisso 60 char),
  // reopen entro 6h per il flap rosso→verde→rosso (#928/#931/#937/#941).
  // deployRef è il commit della BUILD (workflow_run.head_sha), distinto dal
  // run che la valida — passarlo abilita il guard anti-latenza (#5539): se
  // predata la fix che ha chiuso la issue, il reopener non la riapre.
  return payloads.reduce(
    (p, payload) => p.then(() => createGithubIssue({
      title: payload.title,
      description: payload.body,
      priority: 1,
      labels: payload.labels,
      workflow: WORKFLOW_DISPLAY_NAME,
      reopenWithinHours: 6,
      buildSha: deployRef || null,
    })),
    Promise.resolve(),
  );
}

function reportBuild({ dryRun }) {
  const repo = process.env.GH_REPO || process.env.GITHUB_REPOSITORY || '';
  const runId = process.env.RUN_ID || process.env.GITHUB_RUN_ID || '';
  const jobKey = process.env.JOB_KEY || process.env.GITHUB_JOB || '';
  const locale = process.env.LOCALE || '';
  const workflowName = process.env.WORKFLOW_NAME || process.env.GITHUB_WORKFLOW || 'Deploy to GitHub Pages';
  const branch = process.env.BRANCH || process.env.GITHUB_REF_NAME || '';
  const eventName = process.env.EVENT_NAME || process.env.GITHUB_EVENT_NAME || '';
  const diagFile = process.env.DIAG_FILE || '/tmp/build-failure-diag.txt';

  // Il job è ancora in corso quando questo step gira (`if: failure()` dopo lo
  // step rotto): la jobs API espone già gli step COMPLETATI con la loro
  // conclusion, ma il LOG del job in corso non è scaricabile — l'estratto
  // arriva solo dal diag file locale, se uno step l'ha scritto.
  let failedStep = '';
  if (repo && runId && jobKey) {
    const data = fetchRunJobs(repo, runId);
    const current = findCurrentBuildJob(data?.jobs, jobKey, locale);
    if (current) failedStep = firstFailedStep(current);
  }

  let diagTail = '';
  try {
    if (fs.existsSync(diagFile)) {
      diagTail = extractStepExcerpt(fs.readFileSync(diagFile, 'utf8'));
    }
  } catch { /* best-effort */ }

  const description = [
    '## Build fallito',
    `**Run:** ${runUrl(repo, runId)}`,
    `**Job:** ${jobKey}${locale ? ` (${locale})` : ''}`,
    locale ? `**Locale:** ${locale}` : null,
    failedStep ? `**Step fallito:** \`${failedStep}\`` : '**Step fallito:** non determinabile via jobs API',
    branch ? `**Branch:** ${branch}` : null,
    eventName ? `**Trigger:** ${eventName}` : null,
    ...(diagTail ? ['', '## Estratto diagnostico', fence(diagTail)] : []),
  ].filter((l) => l !== null).join('\n');

  // Titolo INVARIATO rispetto allo step storico: le 4 build della matrice
  // locale collassano sulla stessa issue canonica (load-bearing, #5121).
  const title = `CI Failure (build): ${workflowName}`;

  if (dryRun) {
    process.stdout.write(JSON.stringify([{ title, labels: ['Bug'], body: description }], null, 2) + '\n');
    return Promise.resolve();
  }
  // NIENTE `reopenWithinHours` qui: si eredita DEFAULT_REOPEN_WITHIN_HOURS
  // (720h). C'era `6`, ereditato dal reporter post-deploy qui sopra, dove i 6h
  // sono giusti — quello collassa un flap rosso→verde→rosso dentro UN ciclo di
  // deploy (#928/#931/#937/#941) e ha `buildSha` per il guard anti-latenza
  // #5539. Questo NO: gira dentro il job di build, la build che ha rotto è
  // sempre quella corrente, e il rosso torna a distanza di giorni. Misurato
  // 2026-08-14: 22 issue con il titolo IDENTICO `CI Failure (build): Deploy to
  // GitHub Pages` (#1290 … #5864) — una coniatura per ogni ricaduta oltre i 6h
  // dal verde che aveva chiuso la precedente, sulla issue che #5121 dichiara
  // canonica. Il collasso della matrice a 4 locali NON dipende da questa
  // finestra: quello lo fa il dedup sulle issue APERTE, che è incondizionato.
  return createGithubIssue({
    title,
    description,
    priority: 1,
    labels: ['Bug'],
    workflow: workflowName,
  });
}

export function resolveMode({ dryRun }) {
  const repo = process.env.GH_REPO || process.env.GITHUB_REPOSITORY || '';
  const runId = process.env.RUN_ID || process.env.GITHUB_RUN_ID || '';
  // DUE query, unite. Il listato semplice è ordinato per data di creazione
  // discendente: da solo perderebbe una issue canonica vecchia appena il
  // backlog aperto supera il limite — e queste issue sono longeve per design
  // (si riaprono, non si ricreano), quindi invecchiano verso il fondo. Il
  // search server-side le recupera a qualunque età; resta il listato perché
  // l'indice di ricerca è eventualmente consistente e può non vedere una
  // issue aperta pochi secondi fa (stessa ragione del fallback in
  // github-issue-creator.mjs). Nessuna delle due da sola basta.
  const repoArgs = repo ? ['--repo', repo] : [];
  const readTitles = (args) => {
    const out = gh(args, { maxBuffer: 32 * 1024 * 1024 });
    if (out === null) return [];
    try {
      return JSON.parse(out).map((i) => i.title);
    } catch {
      return [];
    }
  };
  const titles = [
    ...readTitles(['issue', 'list', '--state', 'open', '--limit', '200', '--json', 'title', ...repoArgs]),
    ...readTitles(['issue', 'list', '--state', 'open', '--limit', '100', '--json', 'title',
      '--search', `in:title "${TITLE_PREFIX.trim()}"`, ...repoArgs]),
  ];
  const toResolve = selectResolvableTitles(titles);
  if (dryRun) {
    process.stdout.write(JSON.stringify(toResolve, null, 2) + '\n');
    return;
  }
  if (toResolve.length === 0) {
    console.log('[report-validate-dist-failure] resolve: nessuna issue "Validation Failure (dist):" aperta');
    return;
  }
  for (const title of toResolve) {
    resolveGithubIssue(title, {
      workflow: WORKFLOW_DISPLAY_NAME,
      runUrl: repo && runId ? runUrl(repo, runId) : undefined,
    });
  }
}

/* ── CLI ─────────────────────────────────────────────────────────────── */

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const args = process.argv.slice(2);
  const argOf = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
  };
  const mode = argOf('--mode');
  const scope = argOf('--scope') || 'dist';
  const dryRun = args.includes('--dry-run');

  if (!['report', 'resolve'].includes(mode) || !['dist', 'build'].includes(scope)) {
    console.error('Usage: node scripts/ci/report-validate-dist-failure.mjs --mode report|resolve [--scope dist|build] [--dry-run]');
    process.exit(2); // solo l'uso errato dei flag esce non-zero
  }

  const run = mode === 'resolve'
    ? Promise.resolve().then(() => resolveMode({ dryRun }))
    : (scope === 'build' ? reportBuild({ dryRun }) : reportDist({ dryRun }));

  run.then(() => process.exit(0)).catch((err) => {
    // Mai un secondo rosso: il fallimento vero è già registrato dai job gate.
    console.error(`[report-validate-dist-failure] errore (best-effort): ${err?.message || err}`);
    process.exit(0);
  });
}
