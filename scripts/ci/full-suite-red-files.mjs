#!/usr/bin/env node
/**
 * Riassume il report JSON di Vitest della suite COMPLETA in un elenco di file
 * rossi, per `.github/workflows/full-suite-dispatch.yml` (issue #9740,
 * FU-2026-09-18-013).
 *
 * Perché esiste: la CI bloccante (`tests.yml`) esegue solo i test collegati al
 * diff in un checkout sparse, quindi nessuno ha mai misurato quanti file della
 * suite sono rossi su `main` in un checkout pieno. Il numero che mancava è il
 * conteggio dei FILE rossi più il loro elenco: questo script lo estrae dal
 * report e lo scrive in due posti, il riepilogo della run
 * (`$GITHUB_STEP_SUMMARY`) e un file di testo che il workflow carica come
 * artifact insieme al report.
 *
 * File, non `numFailedTestSuites`. Il reporter JSON di Vitest calcola
 * `numTotalTestSuites`/`numFailedTestSuites` con `getSuites(files)`, cioè il
 * file PIÙ ogni blocco `describe` annidato: un solo test rosso dentro un
 * `describe` conta due suite rosse. Misurato su un report reale di tre file
 * (uno verde con quattro `describe`, due rossi senza): `numTotalTestSuites` = 7,
 * file = 3. Il `192 failed` che questa misura sostituisce è la riga
 * `Test Files N failed` della console, cioè file. Il conteggio dei file si
 * ricava quindi da `testResults` (una voce per file); `numFailedTestSuites`
 * resta nel riepilogo con la sua etichetta vera, mai come «file».
 *
 * Uso:
 *   node scripts/ci/full-suite-red-files.mjs --report full-suite-report.json \
 *     --out full-suite-red-files.txt
 *
 * Exit code: 0 quando il report è leggibile (il rosso della suite lo porta già
 * lo step `npm test`, qui non va duplicato); 1 quando il report manca o non è
 * JSON valido — una run senza report non ha misurato niente e non deve
 * sembrare verde.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_MESSAGE_LENGTH = 300;

function relativeTestFile(file, rootDir) {
  const normalized = String(file || '').replaceAll('\\', '/');
  if (!normalized) return '(file non disponibile)';
  const root = String(rootDir || '').replaceAll('\\', '/').replace(/\/+$/u, '');
  if (root && normalized.startsWith(`${root}/`)) return normalized.slice(root.length + 1);
  const match = normalized.match(/(?:^|\/)(tests\/.+)$/u);
  return match?.[1] ?? normalized;
}

function firstLine(message) {
  const text = String(message || '')
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/gu, '')
    .trim()
    .split('\n')[0]
    ?.trim() ?? '';
  return text.length <= MAX_MESSAGE_LENGTH ? text : `${text.slice(0, MAX_MESSAGE_LENGTH - 1)}…`;
}

/**
 * Estrae i file rossi dal report JSON di Vitest (formato jest-compatibile).
 * Un file è rosso quando il suo `status` non è `passed`/`skipped`/`pending`/
 * `todo`, oppure quando contiene almeno un'asserzione `failed`: il secondo caso
 * copre un report in cui lo stato del file e quello dei test divergono.
 */
export function summarizeVitestReport(report, rootDir = process.cwd()) {
  if (!report || typeof report !== 'object' || !Array.isArray(report.testResults)) {
    throw new Error('report Vitest senza `testResults`: formato non riconosciuto');
  }
  const okStatuses = new Set(['passed', 'skipped', 'pending', 'todo']);
  const redFiles = [];
  for (const result of report.testResults) {
    const assertions = Array.isArray(result?.assertionResults) ? result.assertionResults : [];
    const failedTests = assertions.filter((a) => a?.status === 'failed').length;
    const status = String(result?.status ?? '');
    if (okStatuses.has(status) && failedTests === 0) continue;
    const firstFailure = assertions.find((a) => a?.status === 'failed');
    redFiles.push({
      file: relativeTestFile(result?.name, rootDir),
      failedTests,
      message: firstLine(result?.message || firstFailure?.failureMessages?.[0] || ''),
    });
  }
  redFiles.sort((a, b) => a.file.localeCompare(b.file));
  const finiteOrNull = (value) => (Number.isFinite(value) ? value : null);
  return {
    // Una voce di `testResults` per file: è il denominatore dei file, non
    // `numTotalTestSuites`, che conta anche i `describe`.
    totalFiles: report.testResults.length,
    numFailedTestSuites: finiteOrNull(report.numFailedTestSuites),
    numTotalTestSuites: finiteOrNull(report.numTotalTestSuites),
    numFailedTests: finiteOrNull(report.numFailedTests),
    redFiles,
  };
}

export function renderRedFilesText(summary) {
  return summary.redFiles.map((entry) => entry.file).join('\n') + (summary.redFiles.length ? '\n' : '');
}

export function renderStepSummary(summary, { sha = '', ref = '' } = {}) {
  const lines = [
    '## Suite completa (checkout pieno)',
    '',
    `- commit: \`${sha || 'n/d'}\`${ref ? ` (${ref})` : ''}`,
    `- file di test: ${summary.totalFiles}`,
    `- file rossi: **${summary.redFiles.length}** (elencati qui sotto)`,
  ];
  if (summary.numFailedTests !== null) lines.push(`- test rossi: ${summary.numFailedTests}`);
  if (summary.numFailedTestSuites !== null) {
    const total = summary.numTotalTestSuites !== null ? ` su ${summary.numTotalTestSuites}` : '';
    lines.push(`- suite rosse secondo Vitest (\`numFailedTestSuites\`, file + blocchi \`describe\`): ${summary.numFailedTestSuites}${total}`);
  }
  lines.push('');
  if (summary.redFiles.length === 0) {
    lines.push('Nessun file rosso.');
  } else {
    lines.push('| file | test rossi | primo messaggio |', '|---|---:|---|');
    for (const entry of summary.redFiles) {
      const message = entry.message.replaceAll('|', '\\|').replaceAll('`', "'");
      lines.push(`| \`${entry.file}\` | ${entry.failedTests} | ${message} |`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function parseArgs(argv) {
  const out = { report: 'full-suite-report.json', out: 'full-suite-red-files.txt' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--report') out.report = argv[++i];
    else if (argv[i] === '--out') out.out = argv[++i];
    else throw new Error(`argomento sconosciuto: ${argv[i]}`);
  }
  return out;
}

function appendStepSummary(text) {
  const target = process.env.GITHUB_STEP_SUMMARY;
  if (target) fs.appendFileSync(target, text);
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  let report;
  try {
    report = JSON.parse(fs.readFileSync(args.report, 'utf8'));
  } catch (error) {
    const reason = error?.code === 'ENOENT' ? 'file assente' : `non leggibile (${error?.message ?? error})`;
    const text = `## Suite completa (checkout pieno)\n\n**Report Vitest ${reason}: \`${args.report}\`.** `
      + 'La run non ha misurato i file rossi: guarda il log dello step `npm test` '
      + '(timeout dello step, crash del processo o reporter JSON non scritto).\n';
    appendStepSummary(text);
    process.stderr.write(`::error::report Vitest ${reason}: ${args.report}\n`);
    return 1;
  }
  const summary = summarizeVitestReport(report, process.cwd());
  fs.writeFileSync(path.resolve(args.out), renderRedFilesText(summary));
  appendStepSummary(renderStepSummary(summary, {
    sha: process.env.GITHUB_SHA,
    ref: process.env.GITHUB_REF_NAME,
  }));
  process.stdout.write(
    `redFiles=${summary.redFiles.length} totalFiles=${summary.totalFiles} numFailedTestSuites=${summary.numFailedTestSuites ?? 'n/d'}\n`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main();
}
