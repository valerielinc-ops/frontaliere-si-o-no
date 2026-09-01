#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';
import { digestDocument } from './lib/canonical-json-digest.mjs';

const SELF = fileURLToPath(import.meta.url);
const WEEK_CAP = 104;
const MONTH_CAP = 36;
const BASELINE_CAP = 14;
const SEEN_CAP = 500;
function period(date, month = false) {
  const value = new Date(date); const year = value.getUTCFullYear();
  if (month) return `${year}-${String(value.getUTCMonth() + 1).padStart(2, '0')}`;
  const day = new Date(Date.UTC(year, value.getUTCMonth(), value.getUTCDate()));
  day.setUTCDate(day.getUTCDate() + 4 - (day.getUTCDay() || 7));
  const weekYear = day.getUTCFullYear(); const start = new Date(Date.UTC(weekYear, 0, 1));
  return `${weekYear}-W${String(Math.ceil((((day - start) / 86_400_000) + 1) / 7)).padStart(2, '0')}`;
}
function compactReport(report) {
  const { fingerprints: _fingerprints, ...continuity } = report.continuity || {};
  return {
    runId: report.runId, finishedAt: report.finishedAt, digest: report.digest, outcome: report.outcome,
    finalCommit: report.finalCommit, stateTransition: report.stateTransition,
    before: report.before, final: report.final, delta: report.delta,
    cohorts: report.cohorts, quality: report.quality, continuity,
  };
}
function validDigest(report) {
  if (!report?.digest) return false;
  const copy = structuredClone(report);
  delete copy.digest;
  return report.digest === digestDocument(copy);
}
function append(series, key, entry, cap) {
  const index = series.findIndex((item) => item.period === key);
  if (index >= 0) { series[index] = { ...series[index], runs: series[index].runs + 1, latest: entry }; }
  else series.push({ period: key, runs: 1, latest: entry });
  series.sort((a, b) => a.period.localeCompare(b.period));
  if (series.length > cap) series.splice(0, series.length - cap);
}
export function rollupTranslationObservability(history, report) {
  const output = history?.schemaVersion === 1 ? structuredClone(history) : { schemaVersion: 1, weeks: [], months: [], baselineReports: [], seenReports: [] };
  output.seenReports ||= [];
  if (!validDigest(report)) throw new TypeError('Translation observability report digest mismatch');
  const dedupKey = `${report?.runId || ''}:${report?.digest || ''}`;
  if (output.seenReports.includes(dedupKey)) return output;
  const entry = compactReport(report);
  append(output.weeks, period(report.finishedAt), entry, WEEK_CAP);
  append(output.months, period(report.finishedAt, true), entry, MONTH_CAP);
  if (output.baselineReports.length < BASELINE_CAP) {
    output.baselineReports.push(entry);
    output.baselineReports.sort((left, right) => left.finishedAt.localeCompare(right.finishedAt) || left.digest.localeCompare(right.digest));
  }
  output.seenReports.push(dedupKey);
  if (output.seenReports.length > SEEN_CAP) output.seenReports.splice(0, output.seenReports.length - SEEN_CAP);
  return output;
}
function main(argv) {
  const [reportPath, historyPath, dryRun] = argv;
  if (!reportPath || !historyPath) throw new TypeError('Usage: <report.json> <history.json> [--dry-run]');
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const history = fs.existsSync(historyPath) ? JSON.parse(fs.readFileSync(historyPath, 'utf8')) : null;
  const result = rollupTranslationObservability(history, report);
  if (dryRun !== '--dry-run') writeJsonAtomic(historyPath, result);
  return result;
}
if (path.resolve(process.argv[1] || '') === SELF) {
  try { const history = main(process.argv.slice(2)); process.stdout.write(`${history.weeks.length} weekly rollups\n`); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
