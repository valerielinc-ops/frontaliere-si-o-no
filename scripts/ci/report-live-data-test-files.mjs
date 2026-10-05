#!/usr/bin/env node
/**
 * report-live-data-test-files.mjs — una issue per FILE di test rosso in
 * `.github/workflows/live-data-gates.yml`, chiusa alla prima run in cui quel
 * file torna verde.
 *
 * ─── Il difetto (issue 9453) ──────────────────────────────────────────────
 *
 * Il workflow esegue ~60 file di test su dati vivi e, a rosso, apriva UNA
 * issue: `Workflow Failure: live-data gates`. Ogni rosso, di qualunque file,
 * diventava un commento 🔁 nello stesso thread, e il thread si chiudeva solo
 * quando TUTTI i file erano verdi nella stessa run. Misurato sulla run
 * 37198123353 (2026-10-04, main): tre file rossi insieme — la soglia di
 * `tests/job-locale-consistency.test.ts` (33,04% contro il 33%), la matrice di
 * `tests/build-plugins/pharmacyDirectoryPagesPlugin.test.ts` (4 cantoni su 5) e
 * un terzo file che l'estratto troncato non mostrava nemmeno. Tre difetti con
 * tre riparazioni diverse (un dato da ritradurre, una fonte farmacie, un
 * corpus), un solo thread aperto da settimane: nessuno dei tre aveva un
 * proprietario, una scheda o una chiusura propria.
 *
 * ─── Il contratto ─────────────────────────────────────────────────────────
 *
 *   - una issue per file, titolo stabile `Live-data test rosso: <path>`: la
 *     misura NON sta nel titolo, quindi lo stesso file rosso domani commenta la
 *     stessa issue invece di aprirne un'altra (dedup di github-issue-creator,
 *     a titolo esatto perché il prefisso di 60 caratteri non distingue due file
 *     sotto `tests/build-plugins/`);
 *   - la issue di un file si chiude alla prima run in cui QUEL file è verde,
 *     anche se altri restano rossi;
 *   - un file tutto `skipped` o assente dal report NON è verde: si auto-salta
 *     quando il dato manca, e chiuderlo sarebbe il falso verde per assenza di
 *     dato che il workflow esiste per impedire;
 *   - un file uscito dall'inventario dei dati vivi chiude la sua issue come
 *     `not_planned` (soggetto ritirato, non riparato) — ma solo con un
 *     inventario non vuoto in mano;
 *   - `Workflow Failure: live-data gates` resta l'INDICE: la apre e la chiude
 *     ancora `report-failure` / `close-recovered-failure-issues`, e ogni issue
 *     per file la nomina.
 *
 * Uso (dentro il workflow, dopo lo step vitest):
 *   node scripts/ci/report-live-data-test-files.mjs \
 *     --report live-data-vitest.json --files live-data-files.txt --run-url <url>
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const ISSUE_TITLE_PREFIX = 'Live-data test rosso: ';
export const INDEX_ISSUE_TITLE = 'Workflow Failure: live-data gates';
const WORKFLOW_NAME = 'live-data gates';
const MAX_FAILURES_PER_ISSUE = 15;
const MAX_MESSAGE_CHARS = 1500;
const MAX_BODY_CHARS = 60000;

export function issueTitleFor(file) {
  return `${ISSUE_TITLE_PREFIX}${file}`;
}

export function fileFromIssueTitle(title) {
  if (typeof title !== 'string' || !title.startsWith(ISSUE_TITLE_PREFIX)) return null;
  const file = title.slice(ISSUE_TITLE_PREFIX.length).trim();
  return file || null;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
function clean(text) {
  return String(text ?? '').replace(ANSI, '').trim();
}

function toRepoPath(name, root) {
  const raw = String(name || '');
  const rel = path.isAbsolute(raw) ? path.relative(root, raw) : raw;
  return rel.split(path.sep).join('/');
}

/**
 * Riduce il report json di vitest a un esito per file.
 *   failed  — il file (o un suo test) è rosso
 *   passed  — almeno un test passato e nessuno rosso
 *   skipped — nessun test rosso e nessun test passato (dato assente → autoskip)
 *
 * @returns {Map<string, { status: 'failed'|'passed'|'skipped', failures: Array<{ name: string, message: string }> }>}
 */
export function summarizeVitestReport(report, { root = ROOT } = {}) {
  const byFile = new Map();
  const results = Array.isArray(report?.testResults) ? report.testResults : [];
  for (const entry of results) {
    const file = toRepoPath(entry?.name, root);
    if (!file) continue;
    const assertions = Array.isArray(entry.assertionResults) ? entry.assertionResults : [];
    const failures = assertions
      .filter((a) => a?.status === 'failed')
      .map((a) => ({
        name: clean(a.fullName || a.title || '(test senza nome)'),
        message: clean((a.failureMessages || []).join('\n')),
      }));
    const fileMessage = clean(entry.message);
    if (entry.status === 'failed' && failures.length === 0) {
      failures.push({ name: '(errore del file, fuori dai test)', message: fileMessage || '(nessun messaggio nel report)' });
    }
    let status;
    if (failures.length > 0 || entry.status === 'failed') status = 'failed';
    else if (assertions.some((a) => a?.status === 'passed')) status = 'passed';
    else status = 'skipped';
    byFile.set(file, { status, failures });
  }
  return byFile;
}

/**
 * Decide cosa scrivere, senza toccare GitHub.
 *
 * @param {{
 *   byFile: ReturnType<typeof summarizeVitestReport>,
 *   files: string[],
 *   openIssues: Array<{ number: number, title: string }> | null,
 * }} input
 */
export function planLiveDataFileIssues({ byFile, files, openIssues }) {
  const inventory = new Set((files || []).filter(Boolean));
  const report = [];
  for (const [file, result] of byFile) {
    if (result.status !== 'failed') continue;
    report.push({ file, title: issueTitleFor(file), result });
  }
  // Un file dell'inventario tutto `skipped` o assente dal report non è verde
  // (vedi l'intestazione): oltre a tenere aperta la sua issue, la deve APRIRE
  // alla prima run in cui succede, altrimenti un dato che manca da subito
  // lascerebbe il workflow verde e il file senza proprietario.
  for (const file of inventory) {
    const result = byFile.get(file);
    if (result?.status === 'failed' || result?.status === 'passed') continue;
    report.push({
      file,
      title: issueTitleFor(file),
      result: result || { status: 'absent', failures: [] },
    });
  }
  report.sort((a, b) => a.file.localeCompare(b.file));

  const close = [];
  const keep = [];
  for (const issue of openIssues || []) {
    const file = fileFromIssueTitle(issue?.title);
    if (!file) continue; // la issue indice e le issue altrui non si toccano
    const result = byFile.get(file);
    if (result?.status === 'passed') {
      close.push({ number: issue.number, title: issue.title, file, reason: 'completed' });
    } else if (inventory.size > 0 && !inventory.has(file) && !result) {
      close.push({ number: issue.number, title: issue.title, file, reason: 'not_planned' });
    } else if (result?.status === 'failed') {
      keep.push({ number: issue.number, file, why: 'still-red' });
    } else {
      keep.push({ number: issue.number, file, why: result ? 'all-skipped' : 'no-result' });
    }
  }
  return { report, close, keep };
}

/** Una riga che dice perché il file non è verde (rosso, tutto saltato, assente). */
export function nonGreenSummary(file, result) {
  if (result.status === 'skipped') return `tutti i test saltati in ${file} (dato assente)`;
  if (result.status === 'absent') return `${file} assente dal report di vitest`;
  return `${result.failures.length} test rossi in ${file}`;
}

export function buildFailureDescription({ file, result, runUrl }) {
  const shown = result.failures.slice(0, MAX_FAILURES_PER_ISSUE);
  const headline = result.status === 'skipped'
    ? `Il file di test su DATI VIVI \`${file}\` non è verde su \`main\` nel workflow \`${WORKFLOW_NAME}\`: tutti i suoi test si sono saltati, cioè il dato che legge manca.`
    : result.status === 'absent'
      ? `Il file di test su DATI VIVI \`${file}\` non è verde su \`main\` nel workflow \`${WORKFLOW_NAME}\`: non compare nel report di vitest (non è stato eseguito o non è stato raccolto).`
      : `Il file di test su DATI VIVI \`${file}\` è rosso su \`main\` nel workflow \`${WORKFLOW_NAME}\`.`;
  const lines = [
    headline,
    '',
    'Un rosso qui è quasi sempre un **difetto del dato** (slice dei crawler, dataset',
    'assemblato, corpus articoli, farmacie, valichi, registri slug), non di una PR:',
    'la riparazione va nel dato o nella pipeline che lo produce, non nella soglia del test.',
    '',
    `Questa issue segue SOLO questo file: si chiude da sola alla prima run in cui \`${file}\``,
    'torna verde, anche se altri file dello stesso workflow restano rossi. L\'indice di tutti',
    `i rossi del workflow resta la issue \`${INDEX_ISSUE_TITLE}\` (#9453).`,
    '',
    runUrl ? `Run: ${runUrl}` : '',
    '',
    ...(result.failures.length > 0 ? [`## Test rossi (${result.failures.length})`, ''] : []),
  ];
  for (const f of shown) {
    lines.push(`### ${f.name}`, '', '```text', f.message.slice(0, MAX_MESSAGE_CHARS) || '(nessun messaggio)', '```', '');
  }
  if (result.failures.length > shown.length) {
    lines.push(`…e altri ${result.failures.length - shown.length} test rossi nello stesso file (vedi il log della run).`, '');
  }
  lines.push(
    '## Riproduzione',
    '',
    'Serve il checkout PIENO (non un worktree sparse): questi test leggono `data/`,',
    '`packages/articles/content/` e `public/`.',
    '',
    '```',
    'node scripts/assemble-jobs-dataset.mjs --stats',
    'node scripts/migrate-all-known-job-slugs-canton-aware.mjs',
    `npx vitest run ${file}`,
    '```',
  );
  const body = lines.join('\n');
  return body.length > MAX_BODY_CHARS ? `${body.slice(0, MAX_BODY_CHARS)}\n\n…(troncato)` : body;
}

/**
 * Esegue il piano. `io` è iniettabile per i test; in produzione è github-issue-creator.
 *
 * @returns {Promise<{ plan: ReturnType<typeof planLiveDataFileIssues>, undelivered: string[], closed: number[], closeErrors: string[] }>}
 */
export async function runLiveDataFileReporter({ report, files, root = ROOT, runUrl = '', io }) {
  const byFile = summarizeVitestReport(report, { root });
  const openIssues = io.listOpenIssues();
  if (openIssues === null) {
    console.error('[live-data-files] lista delle issue aperte non leggibile: nessuna chiusura in questa run');
  }
  const plan = planLiveDataFileIssues({ byFile, files, openIssues: openIssues || [] });

  const undelivered = [];
  for (const item of plan.report) {
    let res = null;
    try {
      res = await io.createIssue({
        title: item.title,
        description: buildFailureDescription({ file: item.file, result: item.result, runUrl }),
        priority: 2,
        labels: ['Bug'],
        workflow: WORKFLOW_NAME,
        exactTitle: true,
        signals: {
          cosa: nonGreenSummary(item.file, item.result),
          comando: `npx vitest run ${item.file}`,
          evidenza: [runUrl || null],
        },
      });
    } catch (err) {
      console.error(`[live-data-files] report non consegnato per ${item.file}: ${err?.message || err}`);
    }
    if (!res || res.persisted === false) undelivered.push(item.file);
  }

  const closed = [];
  const closeErrors = [];
  for (const item of plan.close) {
    try {
      const res = io.resolveByNumber(item.number, {
        expectedTitle: item.title,
        workflow: WORKFLOW_NAME,
        runUrl,
        reason: item.reason,
        preface: item.reason === 'not_planned'
          ? `\`${item.file}\` non è più nel gruppo dati vivi di \`${WORKFLOW_NAME}\` (\`scripts/ci/live-data-test-guard.mjs --monitor-files\`): questo monitor non lo esegue più.`
          : undefined,
      });
      if (res?.persisted) closed.push(item.number);
    } catch (err) {
      closeErrors.push(`#${item.number}: ${err?.message || err}`);
    }
  }
  return { plan, undelivered, closed, closeErrors };
}

function listOpenIssuesViaGh() {
  const bin = String(process.env.TRUSTED_GH_BIN || '').trim() || 'gh';
  try {
    const out = execFileSync(bin, [
      'issue', 'list', '--state', 'open', '--limit', '300',
      '--search', `in:title "${ISSUE_TITLE_PREFIX.trim()}"`,
      '--json', 'number,title',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 10 * 1024 * 1024 });
    const parsed = JSON.parse(out || '[]');
    return Array.isArray(parsed) ? parsed : null;
  } catch (err) {
    console.error(`[live-data-files] gh issue list fallito: ${err?.message || err}`);
    return null;
  }
}

function argValue(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function appendSummary(lines) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  try {
    fs.appendFileSync(file, `${lines.join('\n')}\n`);
  } catch {
    // il summary è una comodità, non la traccia primaria
  }
}

async function main(argv = process.argv.slice(2)) {
  const reportPath = argValue(argv, '--report') || 'live-data-vitest.json';
  const filesPath = argValue(argv, '--files') || 'live-data-files.txt';
  const runUrl = argValue(argv, '--run-url') || '';

  let report;
  try {
    report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  } catch (err) {
    // Senza report non si sa quale file è rosso né quale è verde: nessuna
    // scrittura. Il rosso arriva comunque nella issue indice via report-failure.
    console.error(`[live-data-files] report vitest non leggibile (${reportPath}): ${err?.message || err}`);
    appendSummary([`⚠️ live-data per file: report \`${reportPath}\` assente o illeggibile, nessuna issue per file aggiornata.`]);
    return 1;
  }
  let files = [];
  try {
    files = fs.readFileSync(filesPath, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
  } catch {
    files = [];
  }

  const { createGithubIssue, resolveGithubIssueByNumber } = await import('../lib/github-issue-creator.mjs');
  const result = await runLiveDataFileReporter({
    report,
    files,
    runUrl,
    io: {
      listOpenIssues: listOpenIssuesViaGh,
      createIssue: (opts) => createGithubIssue(opts),
      resolveByNumber: (n, opts) => resolveGithubIssueByNumber(n, opts),
    },
  });

  const summary = ['### live-data: issue per file', ''];
  for (const r of result.plan.report) summary.push(`- 🔴 \`${r.file}\` — ${r.result.failures.length} test rossi`);
  for (const c of result.plan.close) summary.push(`- ✅ \`${c.file}\` — chiusura #${c.number} (${c.reason})`);
  for (const k of result.plan.keep) summary.push(`- ⏸️ \`${k.file}\` — #${k.number} resta aperta (${k.why})`);
  if (summary.length === 2) summary.push('- nessun file rosso, nessuna issue per file aperta');
  appendSummary(summary);
  console.log(summary.join('\n'));

  if (result.closeErrors.length) console.error(`[live-data-files] chiusure fallite: ${result.closeErrors.join('; ')}`);
  if (result.undelivered.length) {
    console.error(`[live-data-files] report NON consegnati: ${result.undelivered.join(', ')}`);
    return 1;
  }
  return result.closeErrors.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; }, (err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
