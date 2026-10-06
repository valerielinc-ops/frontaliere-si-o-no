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

export const PHASE_TIMING_THRESHOLD = 1.3;
export const MIN_HISTORY_SAMPLES = 3;
export const MAX_PHASE_ROWS = 25;

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

export function parseBuildProfileHistory(jsonl, locale) {
  const rows = [];
  for (const line of String(jsonl).split(/\r?\n/u)) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    // Older rows predate the explicit outcome field. Do not guess that a
    // cancelled or failed leg was a successful baseline; three new green
    // rows establish the advisory median after this observer lands.
    if (
      row?.kind !== 'build-profile'
      || row.locale !== locale
      || row.build_status !== 'success'
      || !Array.isArray(row.phases)
    ) continue;
    rows.push(row);
  }
  return rows;
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

function writeOutput(name, value) {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) return;
  fs.appendFileSync(output, `${name}=${value}\n`, 'utf8');
}

function main() {
  const logPath = process.env.PHASE_TIMING_LOG || '/tmp/build.log';
  const historyPath = process.env.PHASE_TIMING_HISTORY || 'data/build-history/memory-peaks.jsonl';
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
