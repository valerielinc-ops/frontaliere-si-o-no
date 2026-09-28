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
const CURRENT_REPORT_SCHEMA_VERSION = 2;

export const TRANSLATION_COST_COMPARISON_POLICY = Object.freeze({
  requiredWindows: 5,
  maxBudgetRatio: 1.2,
  historyCap: SEEN_CAP,
});

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
    schemaVersion: report.schemaVersion,
    runId: report.runId, finishedAt: report.finishedAt, digest: report.digest, outcome: report.outcome,
    finalCommit: report.finalCommit, stateTransition: report.stateTransition,
    before: report.before, final: report.final, delta: report.delta,
    cohorts: report.cohorts, quality: report.quality, languageQuality: report.languageQuality, continuity,
    runPhases: report.runPhases,
    rungAttribution: report.rungAttribution,
    companyConcentration: report.companyConcentration,
  };
}

function finiteNonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function positiveFinite(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function validJobTiming(timing) {
  return timing
    && Number.isSafeInteger(timing.count)
    && timing.count > 0
    && finiteNonNegative(timing.p50Ms)
    && finiteNonNegative(timing.p90Ms)
    && finiteNonNegative(timing.maxMs);
}

/**
 * A cost window is comparable only when every field emitted by the current
 * instrumentation is present. Legacy reports and starved windows remain
 * operational evidence, but must break the consecutive-window streak.
 */
export function classifyTranslationCostObservation(report) {
  if (report?.outcome !== 'success') {
    return { comparable: false, reason: 'outcome_not_success', windowMs: null };
  }
  if (report?.schemaVersion !== CURRENT_REPORT_SCHEMA_VERSION) {
    return { comparable: false, reason: 'legacy_report_schema', windowMs: null };
  }
  const cascade = report?.runPhases?.cascade;
  if (!cascade) {
    return { comparable: false, reason: 'cascade_observation_missing', windowMs: null };
  }
  if (cascade.starved !== false) {
    return { comparable: false, reason: 'cascade_starved_or_unknown', windowMs: null };
  }
  if (!positiveFinite(cascade.windowMs)) {
    return { comparable: false, reason: 'cascade_window_invalid', windowMs: null };
  }
  if (!validJobTiming(cascade.jobTiming)) {
    return { comparable: false, reason: 'job_timing_incomplete', windowMs: null };
  }
  if (!finiteNonNegative(cascade.jobsPerWindowMinute)) {
    return { comparable: false, reason: 'window_throughput_missing', windowMs: null };
  }
  if (!Array.isArray(report.rungAttribution) || !Array.isArray(report.companyConcentration)) {
    return { comparable: false, reason: 'attribution_schema_incomplete', windowMs: null };
  }
  return { comparable: true, reason: null, windowMs: cascade.windowMs };
}

function compactCostComparisonObservation(report) {
  const classification = classifyTranslationCostObservation(report);
  return {
    runId: report?.runId ?? null,
    finishedAt: report?.finishedAt ?? null,
    digest: report?.digest ?? null,
    ...classification,
  };
}

function costObservationKey(observation) {
  return `${observation?.runId ?? ''}:${observation?.digest ?? ''}`;
}

function validCostComparisonObservation(observation) {
  const validWindow = observation?.comparable
    ? positiveFinite(observation.windowMs)
    : observation?.windowMs === null;
  return observation
    && typeof observation === 'object'
    && typeof observation.comparable === 'boolean'
    && validWindow
    && (observation.runId === null || typeof observation.runId === 'string')
    && (observation.finishedAt === null || typeof observation.finishedAt === 'string')
    && (observation.digest === null || typeof observation.digest === 'string');
}

function compareCostObservations(left, right) {
  const leftTime = Date.parse(left.finishedAt || '');
  const rightTime = Date.parse(right.finishedAt || '');
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) return leftTime - rightTime;
  if (Number.isFinite(leftTime) !== Number.isFinite(rightTime)) return Number.isFinite(leftTime) ? -1 : 1;
  return String(left.finishedAt || '').localeCompare(String(right.finishedAt || ''))
    || String(left.digest || '').localeCompare(String(right.digest || ''))
    || String(left.runId || '').localeCompare(String(right.runId || ''));
}

function budgetRange(observations) {
  const values = observations.map((observation) => observation.windowMs).filter(positiveFinite);
  if (values.length === 0) return { minMs: null, maxMs: null, ratio: null };
  const minMs = Math.min(...values);
  const maxMs = Math.max(...values);
  return { minMs, maxMs, ratio: Math.round((maxMs / minMs) * 1000) / 1000 };
}

function buildCostComparisonStatus(observations) {
  let streak = [];
  for (const observation of observations) {
    if (!observation.comparable || !positiveFinite(observation.windowMs)) {
      streak = [];
      continue;
    }
    const candidate = [...streak, observation];
    if (budgetRange(candidate).ratio <= TRANSLATION_COST_COMPARISON_POLICY.maxBudgetRatio) streak = candidate;
    else streak = [observation];
  }
  const range = budgetRange(streak);
  const ready = streak.length >= TRANSLATION_COST_COMPARISON_POLICY.requiredWindows;
  const last = streak.at(-1) || null;
  return {
    requiredWindows: TRANSLATION_COST_COMPARISON_POLICY.requiredWindows,
    maxBudgetRatio: TRANSLATION_COST_COMPARISON_POLICY.maxBudgetRatio,
    observedReports: observations.length,
    comparableReports: observations.filter((observation) => observation.comparable).length,
    consecutiveComparableWindows: streak.length,
    windowMsRange: range,
    ready,
    reason: ready ? null : 'insufficient_consecutive_comparable_windows',
    lastRunId: last?.runId ?? null,
    lastFinishedAt: last?.finishedAt ?? null,
  };
}

function updateCostComparison(output, report = null) {
  const observations = (Array.isArray(output.costComparisonReports) ? output.costComparisonReports : [])
    .filter(validCostComparisonObservation);
  if (report) {
    const observation = compactCostComparisonObservation(report);
    const key = costObservationKey(observation);
    if (!observations.some((candidate) => costObservationKey(candidate) === key)) observations.push(observation);
  }
  observations.sort(compareCostObservations);
  if (observations.length > TRANSLATION_COST_COMPARISON_POLICY.historyCap) {
    observations.splice(0, observations.length - TRANSLATION_COST_COMPARISON_POLICY.historyCap);
  }
  output.costComparisonReports = observations;
  output.costComparisonStatus = buildCostComparisonStatus(observations);
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
function baselineEligible(report) {
  return report?.outcome === 'success'
    && report?.stateTransition?.advanced === true
    && Number.isSafeInteger(report.stateTransition.generation)
    && report.stateTransition.generation > 0
    && report?.languageQuality?.trueFinal?.measured === true;
}
function updateBaseline(output, entry) {
  output.baselineReports = (output.baselineReports || []).filter(baselineEligible);
  if (baselineEligible(entry)) output.baselineReports.push(entry);
  output.baselineReports.sort((left, right) => left.finishedAt.localeCompare(right.finishedAt) || left.digest.localeCompare(right.digest));
  // After the stable sort, retain the earliest report for each generation.
  const generations = new Set();
  output.baselineReports = output.baselineReports.filter((report) => {
    const { generation } = report.stateTransition;
    if (generations.has(generation)) return false;
    generations.add(generation);
    return true;
  });
  if (output.baselineReports.length > BASELINE_CAP) output.baselineReports.splice(BASELINE_CAP);
  output.baselineStatus = {
    requiredGenerations: BASELINE_CAP,
    collectedGenerations: output.baselineReports.length,
    ready: output.baselineReports.length === BASELINE_CAP,
  };
}
export function rollupTranslationObservability(history, report) {
  const output = history?.schemaVersion === 1 ? structuredClone(history) : { schemaVersion: 1, weeks: [], months: [], baselineReports: [], seenReports: [] };
  output.seenReports ||= [];
  output.costComparisonReports ||= [];
  updateBaseline(output);
  updateCostComparison(output);
  if (!validDigest(report)) throw new TypeError('Translation observability report digest mismatch');
  const dedupKey = `${report?.runId || ''}:${report?.digest || ''}`;
  if (output.seenReports.includes(dedupKey)) return output;
  const entry = compactReport(report);
  append(output.weeks, period(report.finishedAt), entry, WEEK_CAP);
  append(output.months, period(report.finishedAt, true), entry, MONTH_CAP);
  updateBaseline(output, entry);
  updateCostComparison(output, report);
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
