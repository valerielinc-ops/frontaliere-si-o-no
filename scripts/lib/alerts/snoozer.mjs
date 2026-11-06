// scripts/lib/alerts/snoozer.mjs
//
// Auto-snooze logic. Spec § 8.4 — same alert ID firing for ≥3 consecutive
// days gets snoozed for the next 7 days. Snoozed alerts are still logged
// (and surface in the job-summary "snoozed" section) but do NOT count
// toward the workflow exit-1 / meta-alert decision.
//
// State shape (data/alert-snoozes.json):
// {
//   "version": 1,
//   "snoozes": {
//     "<alertId>": {
//       "consecutiveDays": 4,
//       "lastSeen": "2026-05-07",
//       "snoozedUntil": "2026-05-14"
//     }
//   }
// }

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const SNOOZE_PATH = 'data/alert-snoozes.json';

function defaultState() {
  return { version: 1, snoozes: {} };
}

function isoDay(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

function addDaysIso(dayIso, days) {
  const t = Date.parse(`${dayIso}T00:00:00Z`);
  return isoDay(t + days * 24 * 3600 * 1000);
}

function normalize(raw) {
  if (!raw || typeof raw !== 'object') return defaultState();
  const snoozes = raw.snoozes && typeof raw.snoozes === 'object' ? raw.snoozes : {};
  return { version: Number.isInteger(raw.version) ? raw.version : 1, snoozes };
}

export function loadSnoozes({ path = SNOOZE_PATH } = {}) {
  try {
    if (!existsSync(path)) return defaultState();
    return normalize(JSON.parse(readFileSync(path, 'utf-8')));
  } catch {
    return defaultState();
  }
}

export function saveSnoozes(state, { path = SNOOZE_PATH } = {}) {
  const safe = normalize(state);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(safe, null, 2)}\n`, 'utf-8');
    return true;
  } catch (err) {
    console.warn(`[snoozer] write failed: ${err?.message || err}`);
    return false;
  }
}

/**
 * Split alerts into active (still surface, drive exit-1) and snoozed
 * (logged only). An alert is snoozed when the stored `snoozedUntil` day
 * is strictly greater than today.
 *
 * @param {object[]} alerts
 * @param {{snoozes: object}} snoozeState
 * @param {{ now?: number }} [opts]
 * @returns {{ activeAlerts: object[], snoozedAlerts: object[] }}
 */
export function applySnoozer(alerts, snoozeState, { now = Date.now() } = {}) {
  const today = isoDay(now);
  const activeAlerts = [];
  const snoozedAlerts = [];
  for (const alert of alerts) {
    const entry = snoozeState?.snoozes?.[alert.id];
    if (entry && entry.snoozedUntil && entry.snoozedUntil > today) {
      snoozedAlerts.push({ ...alert, _snoozedUntil: entry.snoozedUntil });
    } else {
      activeAlerts.push(alert);
    }
  }
  return { activeAlerts, snoozedAlerts };
}

/**
 * Update snooze state given today's alerts:
 *   - alerts that fired today increment consecutiveDays (or start at 1)
 *   - any tracked alert NOT firing today resets to 0
 *   - if consecutiveDays ≥ snooze_after_consecutive_days, set snoozedUntil
 *     to today + snooze_duration_days
 *   - existing snoozes whose snoozedUntil ≤ today are dropped
 *
 * @param {{snoozes: object}} prev
 * @param {object[]} todaysAlerts
 * @param {{snooze_after_consecutive_days: number, snooze_duration_days: number}} config
 * @param {{ now?: number }} [opts]
 * @returns {{snoozes: object, version: number}}
 */
export function updateSnoozeState(prev, todaysAlerts, config, { now = Date.now() } = {}) {
  const today = isoDay(now);
  const consecutiveThreshold = config.snooze_after_consecutive_days;
  const durationDays = config.snooze_duration_days;
  const previousSnoozes = (prev && prev.snoozes) || {};
  const next = {};
  const todaysIds = new Set(todaysAlerts.map((a) => a.id));

  for (const id of todaysIds) {
    const prior = previousSnoozes[id];
    const consecutiveDays = (prior?.consecutiveDays || 0) + 1;
    const stillSnoozed = prior?.snoozedUntil && prior.snoozedUntil > today;
    const snoozedUntil = consecutiveDays >= consecutiveThreshold
      ? addDaysIso(today, durationDays)
      : (stillSnoozed ? prior.snoozedUntil : null);
    next[id] = { consecutiveDays, lastSeen: today, snoozedUntil: snoozedUntil || null };
  }

  for (const id of Object.keys(previousSnoozes)) {
    if (todaysIds.has(id)) continue;
    const prior = previousSnoozes[id];
    if (prior?.snoozedUntil && prior.snoozedUntil > today) {
      next[id] = { consecutiveDays: 0, lastSeen: prior.lastSeen || today, snoozedUntil: prior.snoozedUntil };
    }
  }

  return { version: 1, snoozes: next };
}
