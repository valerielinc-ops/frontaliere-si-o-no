#!/usr/bin/env node
/**
 * report-workflow-failure.mjs — il reporter diagnostico di #5423, reso
 * invocabile da QUALUNQUE workflow (issue #5437).
 *
 * ─── Cosa risolve ────────────────────────────────────────────────────────
 *
 * `scripts/ci/report-validate-dist-failure.mjs` (PR #5423) trasforma una issue
 * di fallimento povera ("quali job erano rossi") in una diagnostica: quale
 * step, estratto del log, comando di riproduzione locale, e una sezione
 * `## Suggested action` coi path degli script — che è ciò che il fixer
 * autonomo estrae per lavorare. Vale però per UN solo workflow.
 *
 * Gli altri aprono ancora il body povero:
 *
 *     ## Workflow fallito
 *     **Run:** https://github.com/…/actions/runs/123
 *     **Trigger:** schedule
 *     **Ref:** main
 *
 * Da lì il fixer deve ripartire dal log del run — esattamente il costo che
 * #5423 ha eliminato dall'altro lato.
 *
 * Questo modulo NON riscrive quella logica: IMPORTA le funzioni pure del
 * reporter dist (`extractStepExcerpt`, `redactWorkflowPaths`, `gateToRepro`,
 * `findCurrentBuildJob`) e le rende parametriche su titolo/job/step. Il punto
 * di ingresso per i workflow è la composite action
 * `.github/actions/report-failure` — vedi il suo action.yml per come si adotta
 * il prossimo workflow.
 *
 * ─── LA REGOLA (issue #5437, dimostrata da #5470) ────────────────────────
 *
 * **Nessun workflow riceve il reporter finché non è scritto, nello stesso
 * giro, CHI CHIUDE le sue issue.** Le due metà sono accoppiate: col dedup sul
 * titolo (primi 60 char, scripts/lib/github-issue-creator.mjs) una issue che
 * nessuno può chiudere resta aperta per sempre.
 *
 * I chiuditori esistenti, e SOLO questi:
 *   - `scripts/ci/close-recovered-failure-issues.mjs` — cron, chiude i titoli
 *     che matchano `TITLE_RE` (`Workflow|Crawler|CI Failure: <nome>`) quando
 *     il run successivo del workflow `<nome>` è verde. `<nome>` deve essere il
 *     display name risolvibile da `gh run list -w <nome>`, cioè il `name:` del
 *     workflow.
 *   - `scripts/ci/report-validate-dist-failure.mjs --mode resolve` — chiude i
 *     `Validation Failure (dist): …`.
 *   - uno step gemello `--resolve` nello stesso workflow (modello
 *     `rpm-canary.yml`, step "Resolve open issue on green"), per i titoli
 *     custom fuori da entrambi i pattern sopra.
 *
 * Perciò l'input `closed-by` della composite action è OBBLIGATORIO, e questo
 * script lo VERIFICA a runtime (`closerFor`): se un workflow dichiara
 * `close-recovered-failure-issues` ma il titolo non matcha `TITLE_RE`, il body
 * lo dice a chiare lettere e lo step emette un `::warning::`. Il gate
 * deterministico è però statico, in `tests/failure-issue-closers.test.ts`:
 * quello fallisce in CI, questo si limita a non restare muto.
 *
 * ─── Contratti onorati (verificati sui sorgenti) ─────────────────────────
 *
 * - DEDUP: il titolo è l'unica chiave e arriva dal chiamante invariato —
 *   nessun token variabile aggiunto qui (#5121).
 * - FIXER: il body non cita MAI un path `.github/workflows/**`
 *   (`scripts/ci/check-workflows-scope.mjs` Mode 1 terminerebbe issue-fix.yml
 *   a zero token). `redactWorkflowPaths` è applicato al body INTERO, non solo
 *   all'estratto — i log dei job contengono davvero quei path (riga
 *   `Uses: <owner>/<repo>/.github/workflows/<file>@<ref>`). Per la stessa
 *   ragione il body non nomina mai `action.yml`: `BARE_YML_RE` in
 *   `scripts/lib/workflow-scope-detect.mjs` matcha qualunque `<nome>.yml`.
 * - LOG: uno step `if: failure()` gira mentre il SUO job è ancora in corso, e
 *   il log di un job in corso NON è scaricabile via API (404). In quella
 *   posizione l'estratto può arrivare solo da un file di diagnostica scritto
 *   da uno step precedente (`diag-file`). Il log completo si ottiene solo dal
 *   modo post-job (`log-from-job`), cioè da un job separato che `needs:` il
 *   job fallito — la forma che usa `post-deploy-validate-dist.yml`. Le due
 *   forme sono entrambe supportate ed entrambe degradano invece di fallire.
 * - EXIT CODE: SEMPRE 0 in report/resolve. Il rosso vero è già registrato
 *   dallo step che ha fallito; un reporter che fallisce non deve aggiungere un
 *   secondo rosso né nascondere il primo. Non-zero solo per uso errato dei
 *   flag.
 *
 * ─── CLI ─────────────────────────────────────────────────────────────────
 *
 *   node scripts/ci/report-workflow-failure.mjs --mode report  [--dry-run]
 *   node scripts/ci/report-workflow-failure.mjs --mode resolve [--dry-run]
 *
 * Tutti gli input passano da env (mai come testo di script: i valori di
 * dispatch/matrix devono restare DATI — scripts/ci/check-workflow-input-injection.mjs).
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGithubIssue, resolveGithubIssue } from '../lib/github-issue-creator.mjs';
import {
  extractStepExcerpt,
  redactWorkflowPaths,
  gateToRepro,
  findCurrentBuildJob,
} from './report-validate-dist-failure.mjs';
import { TITLE_RE } from './close-recovered-failure-issues.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** Chiuditori riconosciuti. L'input `closed-by` deve essere una di queste chiavi. */
export const CLOSERS = {
  'close-recovered-failure-issues': {
    label: 'scripts/ci/close-recovered-failure-issues.mjs (cron, sul primo run verde successivo)',
    // Il reconciler estrae il display name dal titolo e fa `gh run list -w <nome>`:
    // se il titolo non matcha, non lo vede proprio.
    verify: ({ title, workflowName }) => {
      const m = TITLE_RE.exec(title);
      if (!m) {
        return `il titolo non matcha TITLE_RE di close-recovered-failure-issues.mjs (\`${TITLE_RE.source}\`): quel reconciler non lo vedrà mai`;
      }
      if (workflowName && m[1].trim() !== workflowName.trim()) {
        return `il nome nel titolo (\`${m[1].trim()}\`) non è il \`name:\` del workflow (\`${workflowName.trim()}\`): il reconciler fa \`gh run list -w <nome>\` e non troverà nessun run`;
      }
      return null;
    },
  },
  'sibling-resolve-step': {
    label: 'lo step gemello `--resolve` di questo stesso workflow (modello rpm-canary.yml)',
    // Verificabile solo staticamente, sul file del workflow → il gate vive nel
    // test, non qui: a runtime non abbiamo il file dello step gemello.
    verify: () => null,
  },
  'report-validate-dist-failure': {
    label: 'scripts/ci/report-validate-dist-failure.mjs --mode resolve',
    verify: ({ title }) => (title.startsWith('Validation Failure (dist):')
      ? null
      : 'il titolo non ha il prefisso `Validation Failure (dist):`, l\'unico che quel resolve chiude'),
  },
};

const MAX_REPRO_PATHS = 12;
const MAX_EXCERPT_LINES = 40;
const GH_TIMEOUT_MS = 120_000;

/* ── helpers puri (esportati per i test) ─────────────────────────────── */

/**
 * Il `run:` dello step fallito, estratto dal SORGENTE del workflow.
 *
 * Serve a rispondere alla domanda che oggi costa al fixer il primo giro di
 * diagnosi: «quale script ha fallito?». La jobs API dà il NOME dello step, non
 * il comando; il comando sta nel file del workflow, che è già nel workspace.
 *
 * Il nome di uno step può contenere interpolazioni (`Rerender ${{ matrix.section }}
 * hubs`): il confronto avviene su un pattern in cui ogni `${{ … }}` diventa un
 * jolly, mai su uguaglianza letterale — altrimenti ogni step di una matrice
 * risulterebbe introvabile.
 *
 * @returns {{ name: string, run: string } | null}
 */
export function findStepRun(workflowSource, failedStepName) {
  if (!workflowSource || !failedStepName) return null;
  const lines = String(workflowSource).split('\n');
  const starts = [];
  lines.forEach((l, i) => {
    if (/^\s*-\s+name:\s*\S/.test(l)) starts.push(i);
  });
  for (let k = 0; k < starts.length; k++) {
    const a = starts[k];
    const b = k + 1 < starts.length ? starts[k + 1] : lines.length;
    const rawName = lines[a].replace(/^\s*-\s+name:\s*/, '').trim().replace(/^["']|["']$/g, '');
    const pattern = new RegExp(
      `^${rawName
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        // `\$\{\{ … \}\}` dopo l'escape: interpolazione → jolly
        .replace(/\\\$\\\{\\\{[^}]*\\\}\\\}/g, '.*')}$`,
    );
    if (!pattern.test(String(failedStepName).trim())) continue;
    const block = lines.slice(a, b);
    const runIdx = block.findIndex((l) => /^\s*run:\s*/.test(l));
    if (runIdx < 0) return { name: rawName, run: '' };
    const runLine = block[runIdx];
    const inline = runLine.replace(/^\s*run:\s*/, '');
    if (inline && !/^[|>][-+]?\s*$/.test(inline.trim())) {
      return { name: rawName, run: inline.trim() };
    }
    const indent = (runLine.match(/^(\s*)/) || ['', ''])[1].length;
    const body = [];
    for (let i = runIdx + 1; i < block.length; i++) {
      const l = block[i];
      if (l.trim() === '') { body.push(''); continue; }
      const li = (l.match(/^(\s*)/) || ['', ''])[1].length;
      if (li <= indent) break;
      body.push(l);
    }
    // Dedent sull'indentazione comune: il blocco finisce dentro un fence nel
    // body della issue, e otto spazi di rientro YAML lì sono solo rumore.
    const widths = body.filter((l) => l.trim()).map((l) => (l.match(/^(\s*)/) || ['', ''])[1].length);
    const cut = widths.length > 0 ? Math.min(...widths) : 0;
    return { name: rawName, run: body.map((l) => l.slice(cut)).join('\n').trim() };
  }
  return null;
}

/**
 * Comandi di riproduzione e path degli script, ricavati dal `run:` dello step.
 *
 * Mai hardcoded: se lo step cambia script, il body segue. Gli `npm run <x>`
 * vengono risolti attraverso package.json con `gateToRepro` — la STESSA
 * funzione che il reporter dist usa per i gate, non una copia.
 *
 * @returns {{ commands: string[], paths: string[] }}
 */
export function reproFromRun(runText, pkgScripts = {}) {
  const text = String(runText || '');
  const commands = [];
  const paths = new Set();

  for (const m of text.matchAll(/\bnpm run ([A-Za-z0-9:._/-]+)/g)) {
    const name = m[1];
    const { command, paths: p } = gateToRepro(name, pkgScripts);
    commands.push(command ? `npm run ${name}  (→ ${command})` : `npm run ${name}`);
    for (const x of p) paths.add(x);
  }
  for (const m of text.matchAll(/\b(?:node|bash|npx -y tsx@\d+|tsx)\s+((?:scripts|data)\/[A-Za-z0-9._/-]+)(?:\s+(--[^\n\\]*))?/g)) {
    commands.push(`node ${m[1]}${m[2] ? ` ${m[2].trim()}` : ''}`.replace(/^node (?=scripts\/lib\/[^\s]+\.sh)/, 'bash '));
    paths.add(m[1]);
  }
  for (const m of text.matchAll(/(?:scripts|data)\/[A-Za-z0-9._/-]+/g)) paths.add(m[0]);

  return {
    commands: [...new Set(commands)].slice(0, MAX_REPRO_PATHS),
    paths: [...paths].slice(0, MAX_REPRO_PATHS),
  };
}

/**
 * Risolve `closed-by` in una riga di body + un eventuale problema.
 * @returns {{ id: string, label: string, problem: string|null }}
 */
export function closerFor(closedBy, { title, workflowName } = {}) {
  const entry = CLOSERS[closedBy];
  if (!entry) {
    return {
      id: String(closedBy || '(non dichiarato)'),
      label: '(sconosciuto)',
      problem: `\`closed-by\` non è uno dei chiuditori riconosciuti (${Object.keys(CLOSERS).join(', ')}): questa issue potrebbe non chiudersi mai`,
    };
  }
  return { id: closedBy, label: entry.label, problem: entry.verify({ title: title || '', workflowName: workflowName || '' }) };
}

function fence(text) {
  return '```text\n' + String(text || '').replace(/```/g, '`​``') + '\n```';
}

/**
 * Body diagnostico. Funzione PURA: nessuna chiamata gh, testabile con input
 * sintetici. La forma delle sezioni ricalca quella di
 * report-validate-dist-failure.mjs — `## Suggested action` in fondo è ciò che
 * il fixer estrae.
 */
export function buildFailureBody(input) {
  const {
    repo = '', runId = '', runAttempt = '1',
    workflowName = '', jobName = '', entity = '',
    eventName = '', refName = '',
    failedStep = null, stepRun = null,
    repro = { commands: [], paths: [] },
    excerpt = '', excerptSource = '',
    context = '',
    closer = null,
    jobsApiNote = '',
  } = input;

  const runUrl = repo && runId ? `https://github.com/${repo}/actions/runs/${runId}` : '';
  const dur = failedStep && failedStep.startedAt && failedStep.completedAt
    ? Math.round((Date.parse(failedStep.completedAt) - Date.parse(failedStep.startedAt)) / 1000)
    : null;

  const lines = [
    `## ${workflowName || 'Workflow'} fallito`,
    '',
    '## Run',
    runUrl ? `- **Run:** ${runUrl} (attempt ${runAttempt})` : '- **Run:** non determinabile',
    `- **Job:** \`${jobName || 'n/d'}\`${entity ? ` — \`${entity}\`` : ''}`,
    eventName ? `- **Trigger:** ${eventName}` : null,
    refName ? `- **Ref:** ${refName}` : null,
    '',
    '## Step fallito',
    failedStep && failedStep.name
      ? `- \`${failedStep.name}\`${dur !== null ? ` — durato ${dur}s` : ''}${failedStep.htmlUrl ? ` — ${failedStep.htmlUrl}` : ''}`
      : `- non determinabile via jobs API${jobsApiNote ? ` (${jobsApiNote})` : ''} — la diagnosi riparte dal log del run`,
    stepRun
      ? `- comando dello step:\n\n${fence(stepRun.slice(0, 1200))}`
      : null,
    '',
  ].filter((l) => l !== null);

  if (excerpt) {
    lines.push(`## Estratto${excerptSource ? ` (${excerptSource})` : ''}`, fence(excerpt), '');
  } else {
    lines.push(
      '## Estratto',
      "- nessun estratto disponibile. Uno step `if: failure()` gira mentre il suo job è ancora in corso, e il log di un job in corso non è scaricabile via API: per averlo qui serve un `diag-file` scritto da uno step precedente, oppure la forma post-job (`log-from-job`).",
      '',
    );
  }

  if (context) lines.push('## Contesto', context, '');

  lines.push('## Riproduzione locale');
  if (repro.commands.length > 0) {
    for (const c of repro.commands) lines.push(`- \`${c}\``);
  } else {
    lines.push('- nessun comando ricavabile dal `run:` dello step (step non trovato nel sorgente del workflow, o step non-`run:`): partire dai path sotto.');
  }
  lines.push('');

  lines.push('## Chiusura');
  if (closer) {
    lines.push(`- chiude: ${closer.label}`);
    if (closer.problem) {
      lines.push(
        `- ⚠️ **accoppiamento rotto**: ${closer.problem}. Finché resta così, questa issue non si chiude da sola (dedup sul titolo → resta aperta per sempre). Vedi #5437.`,
      );
    }
  } else {
    lines.push('- ⚠️ nessun chiuditore dichiarato — vedi #5437.');
  }
  lines.push('');

  lines.push('## Suggested action');
  if (repro.paths.length > 0) {
    for (const p of repro.paths) lines.push(`- \`${p}\``);
  } else {
    lines.push('- `scripts/ci/report-workflow-failure.mjs` (non è stato possibile ricavare i path del gate dallo step: il fix parte dal log del run)');
  }

  // Un punto solo di redazione, applicato sempre: un nome di step o una nota
  // futura potrebbero reintrodurre il path che disinnesca il fixer.
  return redactWorkflowPaths(lines.join('\n'));
}

/* ── strato gh (best-effort: ogni fallimento degrada, mai un exit != 0) ── */

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

function fetchJobLog(repo, jobId) {
  return gh(['api', `repos/${repo}/actions/jobs/${jobId}/logs`, '--allow-escape-sequences'])
    ?? gh(['api', `repos/${repo}/actions/jobs/${jobId}/logs`]);
}

function failedStepOf(job) {
  const s = (job?.steps || []).find((x) => x.conclusion === 'failure');
  if (!s) return null;
  return { name: s.name, startedAt: s.started_at, completedAt: s.completed_at, htmlUrl: job.html_url };
}

function readPkgScripts() {
  try {
    return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).scripts || {};
  } catch {
    return {};
  }
}

/**
 * Il sorgente del workflow corrente. `GITHUB_WORKFLOW_REF` ha la forma
 * `<owner>/<repo>/.github/workflows/<file>@refs/heads/main`; il file è già nel
 * workspace (il job ha fatto checkout), quindi si legge da disco senza
 * chiamate API.
 */
function readWorkflowSource() {
  const explicit = process.env.WORKFLOW_FILE || '';
  const ref = process.env.GITHUB_WORKFLOW_REF || '';
  const fromRef = ref.includes('/.github/workflows/')
    ? ref.split('@')[0].slice(ref.split('@')[0].indexOf('.github/workflows/'))
    : '';
  for (const rel of [explicit, fromRef].filter(Boolean)) {
    try {
      return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
    } catch { /* best-effort */ }
  }
  return '';
}

/* ── modalità ────────────────────────────────────────────────────────── */

function collect() {
  const repo = process.env.GH_REPO || process.env.GITHUB_REPOSITORY || '';
  const runId = process.env.RUN_ID || process.env.GITHUB_RUN_ID || '';
  const runAttempt = process.env.RUN_ATTEMPT || process.env.GITHUB_RUN_ATTEMPT || '1';
  const jobKey = process.env.JOB_KEY || process.env.GITHUB_JOB || '';
  const entity = process.env.ENTITY || '';
  const workflowName = process.env.WORKFLOW_NAME || process.env.GITHUB_WORKFLOW || '';
  const title = process.env.FAILURE_TITLE || '';
  return { repo, runId, runAttempt, jobKey, entity, workflowName, title };
}

export function reportMode({ dryRun }) {
  const { repo, runId, runAttempt, jobKey, entity, workflowName, title } = collect();
  const eventName = process.env.EVENT_NAME || process.env.GITHUB_EVENT_NAME || '';
  const refName = process.env.REF_NAME || process.env.GITHUB_REF_NAME || '';
  const context = process.env.CONTEXT || '';
  const diagFile = process.env.DIAG_FILE || '';
  const logFromJob = process.env.LOG_FROM_JOB || '';
  const closedBy = process.env.CLOSED_BY || '';
  const priority = Number(process.env.ISSUE_PRIORITY || '2') || 2;
  // REOPEN_WITHIN_HOURS assente/vuoto → `null` → il creator applica
  // DEFAULT_REOPEN_WITHIN_HOURS (720h). Il fallback `|| '6') || 6` che stava
  // qui era il secondo DEFAULT OMBRA di questa catena: nessun chiamante di
  // report-failure/action.yml chiedeva 6h, le riceveva e basta, e la
  // riapertura resa normale da #5850 non arrivava a nessuno di loro.
  //
  // `0` esplicito DEVE sopravvivere (è l'opt-out documentato), quindi la
  // conversione non può passare da `||`: si testa `Number.isFinite` sul valore
  // grezzo e si lascia `null` in tutti gli altri casi.
  const rawReopen = (process.env.REOPEN_WITHIN_HOURS || '').trim();
  const parsedReopen = rawReopen === '' ? NaN : Number(rawReopen);
  const reopenWithinHours = Number.isFinite(parsedReopen) ? parsedReopen : null;
  const labels = (process.env.ISSUE_LABELS || 'Bug')
    .split(/[\n,]/).map((s) => s.trim()).filter(Boolean);

  let failedStep = null;
  let jobsApiNote = '';
  let excerpt = '';
  let excerptSource = '';

  if (repo && runId) {
    const data = fetchRunJobs(repo, runId);
    if (!data) {
      jobsApiNote = 'jobs API non raggiungibile (manca `actions: read` nei permissions del job?)';
    } else {
      // Forma post-job: il job nominato è già COMPLETO, quindi il suo log è
      // scaricabile e l'estratto è quello vero. Forma in-job: il job corrente
      // è ancora in corso, si prende solo lo step fallito.
      const target = logFromJob
        ? (data.jobs || []).find((j) => j.name === logFromJob || String(j.name || '').startsWith(logFromJob))
        : findCurrentBuildJob(data.jobs, jobKey, entity);
      if (!target) {
        jobsApiNote = `job \`${logFromJob || jobKey}\`${entity ? ` (${entity})` : ''} non trovato nella jobs API del run`;
      } else {
        failedStep = failedStepOf(target);
        if (!failedStep) jobsApiNote = 'nessuno step con conclusion=failure nella jobs API (job ancora in corso o fallito fuori dagli step)';
        if (logFromJob) {
          const log = fetchJobLog(repo, target.id);
          if (log) {
            excerpt = extractStepExcerpt(log, { maxLines: MAX_EXCERPT_LINES });
            excerptSource = `log del job ${target.name}`;
          } else {
            jobsApiNote = jobsApiNote || 'log del job non scaricabile via API (scaduto, o job non ancora completo)';
          }
        }
      }
    }
  }

  if (!excerpt && diagFile) {
    try {
      if (fs.existsSync(diagFile)) {
        excerpt = extractStepExcerpt(fs.readFileSync(diagFile, 'utf8'), { maxLines: MAX_EXCERPT_LINES });
        excerptSource = `diag file ${path.basename(diagFile)}`;
      }
    } catch { /* best-effort */ }
  }

  const stepSrc = failedStep ? findStepRun(readWorkflowSource(), failedStep.name) : null;
  const repro = stepSrc ? reproFromRun(stepSrc.run, readPkgScripts()) : { commands: [], paths: [] };
  const closer = closerFor(closedBy, { title, workflowName });
  if (closer.problem) {
    console.log(`::warning::report-failure: accoppiamento apertura/chiusura rotto per "${title}" — ${closer.problem}`);
  }

  const body = buildFailureBody({
    repo, runId, runAttempt, workflowName, jobName: jobKey, entity,
    eventName, refName, failedStep, stepRun: stepSrc ? stepSrc.run : null,
    repro, excerpt, excerptSource, context, closer, jobsApiNote,
  });

  if (!title) {
    console.error('[report-workflow-failure] FAILURE_TITLE mancante — nessuna issue aperta');
    return Promise.resolve();
  }
  if (dryRun) {
    process.stdout.write(JSON.stringify([{ title, labels, body }], null, 2) + '\n');
    return Promise.resolve();
  }
  return createGithubIssue({
    title,
    description: body,
    priority,
    labels,
    workflow: workflowName,
    reopenWithinHours,
  });
}

export function resolveMode({ dryRun }) {
  const { repo, runId, workflowName, title } = collect();
  if (!title) {
    console.error('[report-workflow-failure] FAILURE_TITLE mancante — niente da chiudere');
    return;
  }
  if (dryRun) {
    process.stdout.write(JSON.stringify([title], null, 2) + '\n');
    return;
  }
  resolveGithubIssue(title, {
    workflow: workflowName,
    runUrl: repo && runId ? `https://github.com/${repo}/actions/runs/${runId}` : undefined,
  });
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
  const dryRun = args.includes('--dry-run');

  if (!['report', 'resolve'].includes(mode)) {
    console.error('Usage: node scripts/ci/report-workflow-failure.mjs --mode report|resolve [--dry-run]');
    process.exit(2); // solo l'uso errato dei flag esce non-zero
  }

  const run = mode === 'resolve'
    ? Promise.resolve().then(() => resolveMode({ dryRun }))
    : reportMode({ dryRun });

  run.then(() => process.exit(0)).catch((err) => {
    console.error(`[report-workflow-failure] errore (best-effort): ${err?.message || err}`);
    process.exit(0);
  });
}
