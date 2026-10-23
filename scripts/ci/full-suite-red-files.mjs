#!/usr/bin/env node
import { realpathSync } from 'node:fs';
/**
 * Riassume il report JSON di Vitest della suite COMPLETA in un elenco di file
 * rossi, per `.github/workflows/full-suite-dispatch.yml` (issue #9740,
 * FU-2026-09-18-013).
 *
 * Perché esiste: la CI bloccante (`tests.yml`) esegue solo i test collegati al
 * diff in un checkout sparse, quindi nessuno ha mai misurato quanti file della
 * suite sono rossi su `main` in un checkout pieno. Il numero che mancava è il
 * conteggio dei FILE rossi più il loro elenco: questo script lo estrae dal
 * report e lo scrive nel riepilogo della run (`$GITHUB_STEP_SUMMARY`) e in
 * tre artifact: elenco dei file rossi, report grezzo e snapshot normalizzato
 * di performance/invarianti, confrontabile tra run.
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
 *     --out full-suite-red-files.txt --metrics-out full-suite-performance.json
 *
 * Exit code: 0 quando il report è leggibile (il rosso della suite lo porta già
 * lo step `npm test`, qui non va duplicato); 1 quando il report manca o non è
 * JSON valido — una run senza report non ha misurato niente e non deve
 * sembrare verde.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isRedTestFileResult } from './lib/vitest-json-report.mjs';

const MAX_MESSAGE_LENGTH = 300;
const PERFORMANCE_SCHEMA_VERSION = 1;

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

function finiteNonNegative(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function percentileNearestRank(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(sorted.length * fraction));
  return sorted[rank - 1];
}

/**
 * Reduces Vitest's per-file timestamps to stable fields that can be compared
 * between full-suite runs. Missing or malformed timestamps stay null rather
 * than becoming a fabricated zero.
 */
export function summarizePerformance(report) {
  const reportStartTimeMs = finiteNonNegative(report?.startTime);
  const durations = [];
  let reportEndTimeMs = null;

  for (const result of report?.testResults ?? []) {
    const startTime = finiteNonNegative(result?.startTime);
    const endTime = finiteNonNegative(result?.endTime);
    if (endTime !== null && (reportEndTimeMs === null || endTime > reportEndTimeMs)) {
      reportEndTimeMs = endTime;
    }
    if (startTime !== null && endTime !== null && endTime >= startTime) {
      durations.push(endTime - startTime);
    }
  }

  const maxFileDurationMs = durations.length > 0
    ? durations.reduce((max, duration) => Math.max(max, duration), 0)
    : null;
  const suiteDurationMs = reportStartTimeMs !== null
    && reportEndTimeMs !== null
    && reportEndTimeMs >= reportStartTimeMs
    ? reportEndTimeMs - reportStartTimeMs
    : null;

  return {
    reportStartTimeMs,
    reportEndTimeMs,
    suiteDurationMs,
    timedFiles: durations.length,
    medianFileDurationMs: median(durations),
    p95FileDurationMs: percentileNearestRank(durations, 0.95),
    maxFileDurationMs,
  };
}

function optionalEnv(name) {
  const value = process.env[name];
  return value ? value : null;
}

function suiteExitCode() {
  const value = process.env.FULL_SUITE_EXIT_CODE;
  if (value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function performanceSnapshot({ report, summary, performance, reportAvailable, reason, reportPath }) {
  const exitCode = suiteExitCode();
  return {
    schemaVersion: PERFORMANCE_SCHEMA_VERSION,
    status: reportAvailable ? 'measured' : 'unavailable',
    source: { report: path.basename(reportPath) },
    run: {
      id: optionalEnv('GITHUB_RUN_ID'),
      attempt: optionalEnv('GITHUB_RUN_ATTEMPT'),
      sha: optionalEnv('GITHUB_SHA'),
      ref: optionalEnv('GITHUB_REF_NAME'),
    },
    suiteExitCode: exitCode,
    reportAvailable,
    ...(reason ? { reason } : {}),
    invariants: {
      reportSuccess: typeof report?.success === 'boolean' ? report.success : null,
      totalFiles: summary?.totalFiles ?? null,
      redFiles: summary?.redFiles?.length ?? null,
      numFailedTests: summary?.numFailedTests ?? null,
      numFailedTestSuites: summary?.numFailedTestSuites ?? null,
      numTotalTestSuites: summary?.numTotalTestSuites ?? null,
    },
    performance: reportAvailable ? performance : {
      reportStartTimeMs: null,
      reportEndTimeMs: null,
      suiteDurationMs: null,
      timedFiles: 0,
      medianFileDurationMs: null,
      p95FileDurationMs: null,
      maxFileDurationMs: null,
    },
  };
}

function writePerformanceSnapshot(outputPath, snapshot) {
  fs.writeFileSync(path.resolve(outputPath), `${JSON.stringify(snapshot, null, 2)}\n`);
}

/**
 * Estrae i file rossi dal report JSON di Vitest (formato jest-compatibile).
 * Quale file è rosso lo decide `isRedTestFileResult`
 * (`scripts/ci/lib/vitest-json-report.mjs`), la stessa regola che usa
 * `report-vitest-failure.mjs`.
 */
export function summarizeVitestReport(report, rootDir = process.cwd()) {
  if (!report || typeof report !== 'object' || !Array.isArray(report.testResults)) {
    throw new Error('report Vitest senza `testResults`: formato non riconosciuto');
  }
  const redFiles = [];
  for (const result of report.testResults) {
    if (!isRedTestFileResult(result)) continue;
    const assertions = Array.isArray(result?.assertionResults) ? result.assertionResults : [];
    const failedTests = assertions.filter((a) => a?.status === 'failed').length;
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
    performance: summarizePerformance(report),
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
  if (summary.performance?.suiteDurationMs !== null) {
    lines.push(`- durata Vitest: **${summary.performance.suiteDurationMs} ms**`);
  }
  if (summary.performance?.medianFileDurationMs !== null) {
    lines.push(`- durata file: mediana **${summary.performance.medianFileDurationMs} ms**, p95 **${summary.performance.p95FileDurationMs} ms**, massimo **${summary.performance.maxFileDurationMs} ms**`);
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
  const out = {
    report: 'full-suite-report.json',
    out: 'full-suite-red-files.txt',
    metricsOut: 'full-suite-performance.json',
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--report') out.report = argv[++i];
    else if (argv[i] === '--out') out.out = argv[++i];
    else if (argv[i] === '--metrics-out') out.metricsOut = argv[++i];
    else throw new Error(`argomento sconosciuto: ${argv[i]}`);
  }
  return out;
}

function appendStepSummary(text) {
  const target = process.env.GITHUB_STEP_SUMMARY;
  if (target) fs.appendFileSync(target, text);
}

function reportFailure(args, reason) {
  writePerformanceSnapshot(args.metricsOut, performanceSnapshot({
    report: null,
    summary: null,
    performance: null,
    reportAvailable: false,
    reason,
    reportPath: args.report,
  }));
  const text = `## Suite completa (checkout pieno)\n\n**Report Vitest ${reason}: \`${args.report}\`.** `
    + 'La run non ha misurato i file rossi: guarda il log dello step `npm test` '
    + '(timeout dello step, crash del processo o reporter JSON non scritto).\n';
  appendStepSummary(text);
  process.stderr.write(`::error::report Vitest ${reason}: ${args.report}\n`);
  return 1;
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  let report;
  try {
    report = JSON.parse(fs.readFileSync(args.report, 'utf8'));
  } catch (error) {
    const reason = error?.code === 'ENOENT' ? 'file assente' : `non leggibile (${error?.message ?? error})`;
    return reportFailure(args, reason);
  }
  let summary;
  try {
    summary = summarizeVitestReport(report, process.cwd());
  } catch (error) {
    return reportFailure(args, `formato non riconosciuto (${error?.message ?? error})`);
  }
  writePerformanceSnapshot(args.metricsOut, performanceSnapshot({
    report,
    summary,
    performance: summary.performance,
    reportAvailable: true,
    reportPath: args.report,
  }));
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

if (process.argv[1] && (() => { try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; } })()) {
  process.exitCode = main();
}
