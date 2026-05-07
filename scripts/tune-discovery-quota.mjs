#!/usr/bin/env node
// scripts/tune-discovery-quota.mjs
//
// Phase 4 auto-tune entrypoint. Reads the freshly-built evidence index and
// every Phase-3-era article sidecar, computes the 14-day winner rate per
// pool, and decides whether to nudge `currentQuota` up, down, or hold.
// The new quota is clamped into [60, 95]. Every run appends one JSON line
// to `data/quota-history.jsonl` for audit, and updates
// `data/quota-state.json` (atomic .tmp+rename via saveQuotaState).
//
// Spec: docs/superpowers/specs/2026-05-07-traffic-quality-algorithm-design.md § 7.4

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  QUOTA_LOWER_BOUND,
  QUOTA_UPPER_BOUND,
  QUOTA_STATE_PATH,
  loadQuotaState,
  saveQuotaState,
} from './lib/scheduler/quotaController.mjs';
import { evaluateWinners } from './lib/scheduler/winnerEvaluator.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

export const DEFAULT_EVIDENCE_PATH = 'data/evidence-index.json';
export const DEFAULT_HISTORY_PATH = 'data/quota-history.jsonl';
export const TUNE_MIN_SAMPLE = 30;
export const TUNE_RATIO_HIGH = 1.2;
export const TUNE_RATIO_LOW = 0.7;
export const TUNE_STEP = 5;
export const HISTORY_CAP = 100;

/**
 * Read the evidence index. Missing or malformed → empty skeleton so the
 * tune always exits gracefully (cold-start path).
 */
export function loadEvidenceIndex(path) {
  const target = path ? resolve(REPO_ROOT, path) : resolve(REPO_ROOT, DEFAULT_EVIDENCE_PATH);
  if (!existsSync(target)) {
    return { ga4: { pages: {} }, clusterStats: {}, _missing: true };
  }
  try {
    const raw = readFileSync(target, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return { ga4: { pages: {} }, clusterStats: {} };
    }
    if (!parsed.ga4 || typeof parsed.ga4 !== 'object') parsed.ga4 = { pages: {} };
    if (!parsed.ga4.pages || typeof parsed.ga4.pages !== 'object') parsed.ga4.pages = {};
    if (!parsed.clusterStats || typeof parsed.clusterStats !== 'object') parsed.clusterStats = {};
    return parsed;
  } catch {
    return { ga4: { pages: {} }, clusterStats: {} };
  }
}

/**
 * Decide the new quota given current state + winner stats.
 * Pure — no I/O.
 *
 * @param {object} state
 * @param {{ proven: {winners:number,total:number}, discovery: {winners:number,total:number}, skipped?: object }} winnerStats
 * @returns {{
 *   decision: 'hold'|'more discovery'|'less discovery',
 *   reason: string,
 *   newQuota: number,
 *   provenRate: number,
 *   discoveryRate: number,
 *   ratio: number|null,
 * }}
 */
export function decideTune(state, winnerStats) {
  const currentQuota = clampToBounds(state.currentQuota);
  const proven = winnerStats.proven || { winners: 0, total: 0 };
  const discovery = winnerStats.discovery || { winners: 0, total: 0 };

  if (proven.total === 0 && discovery.total === 0) {
    return {
      decision: 'hold',
      reason: 'cold-start no aged articles',
      newQuota: currentQuota,
      provenRate: 0,
      discoveryRate: 0,
      ratio: null,
    };
  }

  if (Math.min(proven.total, discovery.total) < TUNE_MIN_SAMPLE) {
    return {
      decision: 'hold',
      reason: `insufficient sample proven=${proven.total} discovery=${discovery.total}`,
      newQuota: currentQuota,
      provenRate: safeRate(proven),
      discoveryRate: safeRate(discovery),
      ratio: null,
    };
  }

  const provenRate = safeRate(proven);
  const discoveryRate = safeRate(discovery);
  const ratio = discoveryRate / Math.max(provenRate, 0.01);

  let newQuota = currentQuota;
  let decision = 'hold';
  if (ratio >= TUNE_RATIO_HIGH) {
    newQuota = clampToBounds(currentQuota - TUNE_STEP);
    decision = 'more discovery';
  } else if (ratio <= TUNE_RATIO_LOW) {
    newQuota = clampToBounds(currentQuota + TUNE_STEP);
    decision = 'less discovery';
  }

  return {
    decision,
    reason: `ratio=${ratio.toFixed(2)}`,
    newQuota,
    provenRate,
    discoveryRate,
    ratio,
  };
}

function clampToBounds(value) {
  if (!Number.isFinite(value)) return QUOTA_LOWER_BOUND;
  const intVal = Math.floor(value);
  if (intVal < QUOTA_LOWER_BOUND) return QUOTA_LOWER_BOUND;
  if (intVal > QUOTA_UPPER_BOUND) return QUOTA_UPPER_BOUND;
  return intVal;
}

function safeRate(bucket) {
  if (!bucket || !bucket.total) return 0;
  return bucket.winners / bucket.total;
}

/**
 * Build the audit record appended to quota-history.jsonl AND pushed into
 * `state.history` (capped to HISTORY_CAP).
 */
export function buildHistoryRecord({ tunedAt, tune, prevQuota, winnerStats }) {
  return {
    tunedAt,
    prevQuota,
    newQuota: tune.newQuota,
    decision: tune.decision,
    reason: tune.reason,
    provenWinRate: round(tune.provenRate, 4),
    discoveryWinRate: round(tune.discoveryRate, 4),
    ratio: tune.ratio === null ? null : round(tune.ratio, 4),
    samples: {
      proven: winnerStats.proven,
      discovery: winnerStats.discovery,
    },
  };
}

function round(value, digits) {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * Append a single JSON line to the JSONL audit log. Creates the file (and
 * its directory) if missing — never throws.
 */
export function appendQuotaHistoryLine(record, path) {
  const target = path ? resolve(REPO_ROOT, path) : resolve(REPO_ROOT, DEFAULT_HISTORY_PATH);
  try {
    mkdirSync(dirname(target), { recursive: true });
    appendFileSync(target, `${JSON.stringify(record)}\n`, 'utf-8');
    return true;
  } catch (err) {
    console.warn(`[tune] could not append to ${target}: ${err?.message || err}`);
    return false;
  }
}

/**
 * Atomic write of arbitrary JSON via .tmp+rename — used for state.
 */
export function atomicWriteJson(path, obj) {
  const tmp = `${path}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, 'utf-8');
  renameSync(tmp, path);
}

/**
 * Cap the in-state history at HISTORY_CAP entries (keeps file size bounded
 * — one entry per day yields ~3 months retention).
 */
export function appendStateHistory(state, record) {
  const existing = Array.isArray(state.history) ? state.history : [];
  const next = [...existing, record];
  if (next.length > HISTORY_CAP) {
    return next.slice(next.length - HISTORY_CAP);
  }
  return next;
}

/**
 * Single-shot orchestration. Pure-ish: every I/O path is overridable for
 * tests via opts (statePath, evidencePath, historyPath, blogArticlesDir).
 *
 * @returns {{ state: object, tune: object, record: object, winnerStats: object }}
 */
export function runTune(opts = {}) {
  const statePath = opts.statePath
    ? resolve(REPO_ROOT, opts.statePath)
    : resolve(REPO_ROOT, QUOTA_STATE_PATH);
  const evidence = opts.evidence ?? loadEvidenceIndex(opts.evidencePath);
  const state = loadQuotaState({ path: statePath });
  const winnerStats = evaluateWinners(evidence, {
    blogArticlesDir: opts.blogArticlesDir,
    now: opts.now,
  });
  const tune = decideTune(state, winnerStats);
  const tunedAt = opts.tunedAt || new Date().toISOString();
  const record = buildHistoryRecord({
    tunedAt,
    tune,
    prevQuota: state.currentQuota,
    winnerStats,
  });

  const nextState = {
    ...state,
    currentQuota: tune.newQuota,
    lastTune: tunedAt,
    history: appendStateHistory(state, record),
  };

  if (!opts.dryRun) {
    saveQuotaState(nextState, { path: statePath });
    appendQuotaHistoryLine(record, opts.historyPath);
  }

  return { state: nextState, tune, record, winnerStats };
}

function isMain() {
  try {
    const entry = process.argv[1] ? resolve(process.argv[1]) : '';
    const here = fileURLToPath(import.meta.url);
    return entry === here;
  } catch {
    return false;
  }
}

async function main() {
  const { state, tune, record, winnerStats } = runTune();
  const summary = {
    decision: tune.decision,
    reason: tune.reason,
    prevQuota: record.prevQuota,
    newQuota: state.currentQuota,
    provenWinRate: record.provenWinRate,
    discoveryWinRate: record.discoveryWinRate,
    samples: record.samples,
    skipped: winnerStats.skipped,
  };
  console.error(`TUNE_RESULT ${JSON.stringify(summary)}`);

  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    try {
      const md = [
        `### Tune quota — ${tune.decision}`,
        '',
        `- prev quota: **${record.prevQuota}**`,
        `- new quota: **${state.currentQuota}**`,
        `- reason: ${tune.reason}`,
        `- proven win-rate: ${record.provenWinRate} (n=${winnerStats.proven.total})`,
        `- discovery win-rate: ${record.discoveryWinRate} (n=${winnerStats.discovery.total})`,
        `- skipped: ${JSON.stringify(winnerStats.skipped)}`,
        '',
      ].join('\n');
      appendFileSync(summaryPath, md, 'utf-8');
    } catch {
      // Job summary is best-effort; never fail the workflow on it.
    }
  }
}

if (isMain()) {
  main().catch((err) => {
    console.error('TUNE_FATAL', err?.stack || err);
    process.exit(1);
  });
}
