// scripts/lib/scheduler/quotaController.mjs
//
// Slot assignment for the proven/discovery pool split. Reads
// `data/quota-state.json`, decides which pool the next article-generator
// run should draw from, and (after a SUCCESSFUL publish) increments the
// run counter.
//
// Counter rule: increment exactly ONCE per successful slot assignment,
// AT THE END of create-article.mjs after a successful publish — never
// before, never on failure (so a stuck run does not silently burn quota
// counters).
//
// Spec: docs/superpowers/specs/2026-05-07-traffic-quality-algorithm-design.md § 6.6

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const QUOTA_STATE_PATH = 'data/quota-state.json';

export const QUOTA_LOWER_BOUND = 60;
export const QUOTA_UPPER_BOUND = 95;
export const QUOTA_DEFAULT = 80;
export const COUNTER_MODULO = 100;

/**
 * @typedef {{
 *   version: number,
 *   runCounter: number,
 *   currentQuota: number,
 *   lastTune: string|null,
 *   history: object[],
 * }} QuotaState
 */

function defaultState() {
  return {
    version: 1,
    runCounter: 0,
    currentQuota: QUOTA_DEFAULT,
    lastTune: null,
    history: [],
  };
}

function clampQuota(value) {
  if (!Number.isFinite(value)) return QUOTA_DEFAULT;
  const intVal = Math.floor(value);
  if (intVal < QUOTA_LOWER_BOUND) return QUOTA_LOWER_BOUND;
  if (intVal > QUOTA_UPPER_BOUND) return QUOTA_UPPER_BOUND;
  return intVal;
}

function normalizeState(raw) {
  const base = defaultState();
  if (!raw || typeof raw !== 'object') return base;
  return {
    version: Number.isInteger(raw.version) ? raw.version : base.version,
    runCounter: Number.isInteger(raw.runCounter) && raw.runCounter >= 0 ? raw.runCounter : 0,
    currentQuota: clampQuota(Number(raw.currentQuota)),
    lastTune: typeof raw.lastTune === 'string' ? raw.lastTune : null,
    history: Array.isArray(raw.history) ? raw.history : [],
  };
}

/**
 * Load the quota state from disk. Returns a default state on any
 * read/parse failure — the controller never blocks article generation
 * because of a missing/corrupt state file.
 *
 * @param {{ path?: string }} [opts]
 * @returns {QuotaState}
 */
export function loadQuotaState(opts = {}) {
  const path = (opts && opts.path) || QUOTA_STATE_PATH;
  try {
    if (!existsSync(path)) return defaultState();
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    return normalizeState(raw);
  } catch {
    return defaultState();
  }
}

/**
 * Persist the quota state to disk. Returns true on success, false on
 * write failure (caller decides whether to surface or swallow).
 *
 * @param {QuotaState} state
 * @param {{ path?: string }} [opts]
 * @returns {boolean}
 */
export function saveQuotaState(state, opts = {}) {
  const path = (opts && opts.path) || QUOTA_STATE_PATH;
  const normalized = normalizeState(state);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(normalized, null, 2)}\n`, 'utf-8');
    return true;
  } catch (err) {
    console.warn(`[quota] could not write ${path}: ${err?.message || err}`);
    return false;
  }
}

/**
 * Decide whether the next slot is 'proven' or 'discovery'. Uses a
 * deterministic counter modulo 100: counter % 100 < quota → proven, else
 * discovery. With quota=80, runs 0..79 → proven, 80..99 → discovery.
 *
 * Optional override: env `DISCOVERY_QUOTA_OVERRIDE=100` forces all slots
 * to proven (rollback lever per spec § 13.2).
 *
 * @param {QuotaState} state
 * @returns {{ slotKind: 'proven'|'discovery', counterValue: number, currentQuota: number }}
 */
export function decideSlot(state) {
  const safe = normalizeState(state);
  const override = Number(process.env.DISCOVERY_QUOTA_OVERRIDE);
  const effectiveQuota = Number.isFinite(override) && override >= 0 && override <= 100
    ? Math.floor(override)
    : safe.currentQuota;
  const counterValue = safe.runCounter % COUNTER_MODULO;
  const slotKind = counterValue < effectiveQuota ? 'proven' : 'discovery';
  return { slotKind, counterValue, currentQuota: effectiveQuota };
}

/**
 * Return a NEW state with `runCounter` incremented by 1. Pure — does NOT
 * touch disk. Caller must follow up with `saveQuotaState`.
 *
 * @param {QuotaState} state
 * @returns {QuotaState}
 */
export function incrementCounter(state) {
  const safe = normalizeState(state);
  return { ...safe, runCounter: safe.runCounter + 1 };
}
