#!/usr/bin/env node
/**
 * Request a static rebuild when a verified duty interval crosses a boundary.
 *
 * The SSG renders the duty cards at build time. This bounded, no-fetch check
 * keeps that snapshot from waiting for the next source sync: it only updates
 * the existing status file after a known verified start/end transition, so a
 * normal push to main starts the existing Pages build. It never invents or
 * rewrites duty data.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_PATH = resolve(REPO_ROOT, 'data/pharmacy-duties-ticino.json');
const STATUS_PATH = resolve(REPO_ROOT, 'data/pharmacy-duties-ticino-status.json');

function readJson(filePath, fallback) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function dateMs(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

/** Return the latest verified start/end boundary already crossed by `now`. */
export function latestVerifiedDutyTransition(duties, now = new Date()) {
  if (!Array.isArray(duties)) return null;
  const nowMs = now instanceof Date ? now.getTime() : dateMs(now);
  if (!Number.isFinite(nowMs)) return null;
  let latest = null;
  for (const duty of duties) {
    if (!duty || duty.status !== 'verified') continue;
    for (const boundary of [duty.startsAt, duty.endsAt]) {
      const boundaryMs = dateMs(boundary);
      if (!Number.isFinite(boundaryMs) || boundaryMs > nowMs) continue;
      if (latest === null || boundaryMs > latest) latest = boundaryMs;
    }
  }
  return latest === null ? null : new Date(latest).toISOString();
}

export function needsStaticDutyRefresh(dataset, status, now = new Date()) {
  const transition = latestVerifiedDutyTransition(dataset?.duties, now);
  if (!transition) return false;
  const lastRefreshMs = dateMs(status?._lastStaticRefreshAt);
  return !Number.isFinite(lastRefreshMs) || dateMs(transition) > lastRefreshMs;
}

export function markStaticDutyRefresh(status, transitionAt, now = new Date()) {
  return {
    ...(status && typeof status === 'object' ? status : {}),
    _lastStaticRefreshAt: now.toISOString(),
    _lastStaticDutyTransitionAt: transitionAt,
  };
}

function main() {
  const dataset = readJson(DATA_PATH, { duties: [] });
  const status = readJson(STATUS_PATH, {});
  const now = new Date();
  const transition = latestVerifiedDutyTransition(dataset.duties, now);
  if (!transition || !needsStaticDutyRefresh(dataset, status, now)) {
    console.log('[refresh-pharmacy-duty-expiry] no static rebuild required');
    return 0;
  }

  mkdirSync(dirname(STATUS_PATH), { recursive: true });
  writeFileSync(
    STATUS_PATH,
    `${JSON.stringify(markStaticDutyRefresh(status, transition, now), null, 2)}\n`,
    'utf8',
  );
  console.log(`[refresh-pharmacy-duty-expiry] static rebuild requested after ${transition}`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error('[refresh-pharmacy-duty-expiry] fatal:', error);
    process.exitCode = 1;
  }
}
