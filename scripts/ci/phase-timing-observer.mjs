#!/usr/bin/env node
/**
 * Build-phase observer: turns the current build's phase markers into a small
 * per-locale summary and compares them with the existing build-profile rows.
 * It is advisory by design: an observation can open an issue, never fail the
 * build that produced the measurement.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { positiveIntFromEnv } from '../lib/int-from-env.mjs';

export const PHASE_TIMING_THRESHOLD = 1.3;
export const MIN_HISTORY_SAMPLES = 3;
export const MAX_PHASE_ROWS = 25;
// Tre run verdi complete rendono una singola oscillazione insufficiente per
// chiudere l'allarme, senza chiedere una nuova baseline piu' lunga di quella
// minima gia' usata per aprirlo.
export const PHASE_TIMING_RECOVERY_RUNS = 3;
export const PHASE_TIMING_LOCALES = Object.freeze(['it', 'en', 'de', 'fr']);

const PHASE_RE = /^\[phase-timing\]\s+(\S+)\s+(\d+(?:\.\d+)?)ms\s+calls=\d+\s*$/u;

export function parsePhaseMarkers(log) {
  const phases = [];
  for (const line of String(log).split(/\r?\n/u)) {
    const match = PHASE_RE.exec(line);
    if (!match) continue;
    phases.push({ marker: match[1], ms: Number(match[2]) });
  }
  return phases
    .filter((phase) => Number.isFinite(phase.ms) && phase.ms >= 0)
    .sort((a, b) => b.ms - a.ms || a.marker.localeCompare(b.marker))
    .slice(0, MAX_PHASE_ROWS);
}

function parseBuildProfileRows(jsonl) {
  const rows = [];
  for (const line of String(jsonl).split(/\r?\n/u)) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      row?.kind !== 'build-profile'
      || typeof row.locale !== 'string'
      || !Array.isArray(row.phases)
    ) continue;
    rows.push(row);
  }
  return rows;
}

export function parseBuildProfileHistory(jsonl, locale) {
  // Older rows predate the explicit outcome field. Do not guess that a
  // cancelled or failed leg was a successful baseline; three new green
  // rows establish the advisory median after this observer lands.
  return parseBuildProfileRows(jsonl).filter((row) => row.locale === locale && row.build_status === 'success');
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function observePhaseTimings({ log, history, locale, threshold = PHASE_TIMING_THRESHOLD, minSamples = MIN_HISTORY_SAMPLES }) {
  const current = parsePhaseMarkers(log);
  const historyRows = parseBuildProfileHistory(history, locale);
  const historyByMarker = new Map();
  for (const row of historyRows) {
    for (const phase of row.phases) {
      const ms = Number(phase?.ms);
      if (typeof phase?.marker !== 'string' || !Number.isFinite(ms) || ms < 0) continue;
      const values = historyByMarker.get(phase.marker) ?? [];
      values.push(ms / 1000);
      historyByMarker.set(phase.marker, values);
    }
  }

  const rows = current.map((phase) => {
    const seconds = phase.ms / 1000;
    const samples = historyByMarker.get(phase.marker) ?? [];
    const baseline = samples.length >= minSamples ? median(samples) : null;
    const deltaPct = baseline && baseline > 0 ? ((seconds / baseline) - 1) * 100 : null;
    return {
      marker: phase.marker,
      seconds,
      baseline,
      samples: samples.length,
      deltaPct,
      regression: baseline !== null && seconds > baseline * threshold,
    };
  });

  return {
    locale,
    historySamples: historyRows.length,
    rows,
    regressions: rows.filter((row) => row.regression),
  };
}

function seconds(value) {
  return `${value.toFixed(2)}s`;
}

function delta(value) {
  return value === null ? '—' : `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`;
}

export function formatPhaseTimingSummary(observation, threshold = PHASE_TIMING_THRESHOLD) {
  const lines = [
    `## Phase timing per lingua (${observation.locale})`,
    '',
    '| fase | secondi | mediana storica | delta | stato |',
    '|---|---:|---:|---:|---|',
  ];
  if (observation.rows.length === 0) {
    lines.push('| _nessun marker_ | — | — | — | log assente o fase non misurata |');
  } else {
    for (const row of observation.rows) {
      const status = row.regression
        ? '⚠️ oltre soglia'
        : row.baseline === null
          ? 'baseline insufficiente'
          : 'ok';
      lines.push(`| \`${row.marker}\` | ${seconds(row.seconds)} | ${row.baseline === null ? '—' : seconds(row.baseline)} | ${delta(row.deltaPct)} | ${status} |`);
    }
  }
  lines.push('', `Soglia advisory: oltre +${((threshold - 1) * 100).toFixed(0)}% sulla mediana della stessa lingua; il deploy non viene bloccato.`);
  return lines.join('\n');
}

function normalizeRunId(value) {
  if (value === undefined || value === null) return null;
  const id = String(value).trim();
  return id || null;
}

function compareRunIds(a, b) {
  const an = Number(a);
  const bn = Number(b);
  if (Number.isSafeInteger(an) && Number.isSafeInteger(bn) && an !== bn) return an - bn;
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

function groupBuildProfileRows(rows) {
  const grouped = new Map();
  for (const row of rows) {
    const runId = normalizeRunId(row.run_id);
    if (!runId) continue;
    const group = grouped.get(runId) ?? { runId, rows: [] };
    group.rows.push(row);
    grouped.set(runId, group);
  }
  return [...grouped.values()].sort((a, b) => compareRunIds(a.runId, b.runId));
}

function phaseMap(row) {
  if (!Array.isArray(row?.phases) || row.phases.length === 0) return null;
  const phases = new Map();
  for (const phase of row.phases) {
    const marker = phase?.marker;
    const ms = Number(phase?.ms);
    // A duplicate marker is ambiguous evidence: do not silently choose one
    // measurement and call the phase recovered.
    if (typeof marker !== 'string' || marker.length === 0 || phases.has(marker) || !Number.isFinite(ms) || ms < 0) {
      return null;
    }
    phases.set(marker, ms);
  }
  return phases;
}

function measuredRowsByLocale(group, locales) {
  const byLocale = new Map();
  for (const row of group.rows) {
    if (!locales.includes(row.locale)) continue;
    if (byLocale.has(row.locale)) return null;
    const phases = phaseMap(row);
    if (row.build_status !== 'success' || phases === null) return null;
    byLocale.set(row.locale, { row, phases });
  }
  if (byLocale.size !== locales.length) return null;
  return byLocale;
}

function parseRunStatuses(input) {
  let value = input;
  if (!Array.isArray(value)) {
    try {
      value = JSON.parse(String(input || ''));
    } catch {
      value = [];
    }
  }
  if (!Array.isArray(value)) return [];
  const byId = new Map();
  for (const run of value) {
    const runId = normalizeRunId(run?.databaseId ?? run?.run_id ?? run?.id);
    if (!runId) continue;
    byId.set(runId, {
      runId,
      status: String(run?.status ?? '').toLowerCase(),
      conclusion: run?.conclusion === null || run?.conclusion === undefined
        ? null
        : String(run.conclusion).toLowerCase(),
    });
  }
  return [...byId.values()].sort((a, b) => compareRunIds(b.runId, a.runId));
}

/**
 * True only when the current deploy is the end of a stable recovery window.
 * The caller supplies the Actions run list because a cancelled run can stop
 * before it writes any build-profile row; history alone cannot prove that no
 * such run occurred between two measured runs.
 */
export function hasStablePhaseTimingRecovery({
  history,
  runStatuses,
  currentRunId,
  locales = PHASE_TIMING_LOCALES,
  threshold = PHASE_TIMING_THRESHOLD,
  minSamples = MIN_HISTORY_SAMPLES,
  recoveryRuns = PHASE_TIMING_RECOVERY_RUNS,
}) {
  const currentId = normalizeRunId(currentRunId);
  const requiredLocales = [...new Set((Array.isArray(locales) ? locales : []).map((locale) => String(locale).trim()).filter(Boolean))];
  if (!currentId || requiredLocales.length === 0 || !Number.isInteger(recoveryRuns) || recoveryRuns < 1) return false;

  const statuses = parseRunStatuses(runStatuses);
  const currentIndex = statuses.findIndex((run) => run.runId === currentId);
  if (currentIndex < 0) return false;
  const currentStatus = statuses[currentIndex];
  if (currentStatus.status === 'completed' && currentStatus.conclusion !== 'success') return false;
  if (!['queued', 'pending', 'requested', 'waiting', 'in_progress', 'completed'].includes(currentStatus.status)) return false;

  // The current run must be followed backwards through the Actions list. A
  // failure/cancellation is therefore a hard break, even when it emitted no
  // row in memory-peaks.jsonl.
  const recent = statuses
    .filter((run) => compareRunIds(run.runId, currentId) <= 0)
    .slice(0, recoveryRuns);
  if (recent.length !== recoveryRuns || recent[0]?.runId !== currentId) return false;
  for (const run of recent.slice(1)) {
    if (run.status !== 'completed' || run.conclusion !== 'success') return false;
  }

  const profileRows = parseBuildProfileRows(history);
  const groups = groupBuildProfileRows(profileRows);
  const groupsById = new Map(groups.map((group) => [group.runId, group]));
  const recentAscending = [...recent].reverse();
  const measuredByRun = new Map();
  for (const run of recentAscending) {
    const measured = measuredRowsByLocale(groupsById.get(run.runId) ?? { rows: [] }, requiredLocales);
    if (!measured) return false;
    measuredByRun.set(run.runId, measured);
  }

  for (const run of recentAscending) {
    const measured = measuredByRun.get(run.runId);
    for (const locale of requiredLocales) {
      const current = measured.get(locale);
      const previousRows = profileRows
        .filter((row) => row.locale === locale && row.build_status === 'success' && compareRunIds(String(row.run_id), run.runId) < 0)
        .sort((a, b) => compareRunIds(String(a.run_id), String(b.run_id)));
      const previous = previousRows.at(-1);
      const previousPhases = phaseMap(previous);
      if (!previousPhases) return false;

      // If a previously observed phase disappears, its recovery is unknown;
      // absence is not evidence of being below the threshold.
      for (const marker of previousPhases.keys()) {
        if (!current.phases.has(marker)) return false;
      }

      for (const [marker, currentMs] of current.phases) {
        const samples = previousRows
          .map((row) => phaseMap(row)?.get(marker))
          .filter((ms) => Number.isFinite(ms));
        const baseline = samples.length >= minSamples ? median(samples) : null;
        // Strictly below +30%: a value exactly on the alarm boundary is not
        // sufficient proof for closing an advisory regression.
        if (baseline === null || baseline <= 0 || !(currentMs < baseline * threshold)) return false;
      }
    }
  }
  return true;
}

function writeOutput(name, value) {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) return;
  fs.appendFileSync(output, `${name}=${value}\n`, 'utf8');
}

function main() {
  const logPath = process.env.PHASE_TIMING_LOG || '/tmp/build.log';
  const historyPath = process.env.PHASE_TIMING_HISTORY || 'data/build-history/memory-peaks.jsonl';

  if (process.argv.includes('--recovery-ready')) {
    const runStatusesPath = process.env.PHASE_TIMING_RUNS_FILE || '';
    const runStatuses = runStatusesPath && fs.existsSync(runStatusesPath)
      ? fs.readFileSync(runStatusesPath, 'utf8')
      : '';
    const locales = (process.env.PHASE_TIMING_REQUIRED_LOCALES || PHASE_TIMING_LOCALES.join(','))
      .split(/[,\s]+/u)
      .filter(Boolean);
    // Un valore non intero o non positivo ricade sul default con un avviso:
    // passato cosi' com'e' renderebbe la recovery sempre falsa, in silenzio.
    const recoveryRuns = positiveIntFromEnv('PHASE_TIMING_RECOVERY_RUNS', PHASE_TIMING_RECOVERY_RUNS);
    const ready = hasStablePhaseTimingRecovery({
      history: fs.existsSync(historyPath) ? fs.readFileSync(historyPath, 'utf8') : '',
      runStatuses,
      currentRunId: process.env.PHASE_TIMING_RUN_ID,
      locales,
      recoveryRuns,
    });
    process.stdout.write(`${ready}\n`);
    return;
  }

  const locale = process.env.PHASE_TIMING_LOCALE || 'unknown';
  const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
  const history = fs.existsSync(historyPath) ? fs.readFileSync(historyPath, 'utf8') : '';
  const observation = observePhaseTimings({ log, history, locale });
  const summary = formatPhaseTimingSummary(observation);
  process.stdout.write(`${summary}\n`);

  const isAlert = observation.regressions.length > 0;
  writeOutput('alert', isAlert ? 'true' : 'false');
  writeOutput('regressions', String(observation.regressions.length));

  const alertPath = process.env.PHASE_TIMING_ALERT_FILE;
  if (alertPath && isAlert) {
    const body = [
      `Regressione advisory delle fasi di build per la lingua ${locale}.`,
      '',
      `La fase corrente supera del 30% la mediana storica dopo ${observation.historySamples} righe comparabili.`,
      '',
      '| fase | corrente | mediana | delta | campioni |',
      '|---|---:|---:|---:|---:|',
      ...observation.regressions.map((row) => `| \`${row.marker}\` | ${seconds(row.seconds)} | ${seconds(row.baseline)} | ${delta(row.deltaPct)} | ${row.samples} |`),
    ].join('\n');
    fs.writeFileSync(alertPath, `${body}\n`, 'utf8');
  }
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (entry === fileURLToPath(import.meta.url)) main();
