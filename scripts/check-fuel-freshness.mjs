#!/usr/bin/env node
/**
 * Freshness gate for the fuel caches behind the /prezzi-*\/oggi/ pages.
 *
 * Why: from 2026-10-17 to 2026-10-23 every daily `update-fuel-prices` run was
 * green while `data/fuel-prices.json` stayed on the 16.10 cut — the generator
 * exits 0 on a "transient" fetch failure, and MIMIT kept failing. The pages
 * were honest (their title printed «TCS 16.10.2026»), but nobody was told.
 * This check turns that silence into a failed step and an issue.
 *
 *   node scripts/check-fuel-freshness.mjs [--max-age-hours 48] [--now ISO]
 *        [--fuel data/fuel-prices.json] [--cantons data/fuel-prices-cantons.json]
 *
 * Exit 1 when any tracked source is older than the window (or undated),
 * 0 otherwise. Prints one JSON line with the measured ages either way, so the
 * run log carries the number even when it passes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_MAX_AGE_HOURS = 48;

function ageHours(now, iso, { dateOnly = false } = {}) {
  if (typeof iso !== 'string' || !iso.trim()) return null;
  // A date-only stamp (MIMIT `priceSnapshotDate`) covers its whole day.
  const ms = Date.parse(dateOnly && /^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T23:59:59.999Z` : iso);
  if (!Number.isFinite(ms)) return null;
  return Number(((now.getTime() - ms) / 3_600_000).toFixed(1));
}

/**
 * Pure evaluation, exported for tests. Returns one entry per source with its
 * age and whether it breaches the window, plus the overall verdict.
 */
export function evaluateFuelFreshness({ fuel, cantons, now = new Date(), maxAgeHours = DEFAULT_MAX_AGE_HOURS }) {
  const checks = [
    {
      source: 'TCS (prezzi Svizzera, pagine /oggi/)',
      key: 'tcs',
      age: ageHours(now, fuel?.sources?.switzerland?.latestObservedUpdate),
    },
    {
      source: 'MIMIT (prezzi Italia)',
      key: 'mimit',
      age: ageHours(now, fuel?.sources?.italy?.priceSnapshotDate, { dateOnly: true }),
      status: fuel?.sources?.italy?.status ?? 'live',
    },
    {
      source: 'fuel-prices.json generatedAt',
      key: 'generatedAt',
      age: ageHours(now, fuel?.generatedAt),
    },
  ];
  if (cantons !== undefined) {
    checks.push({ source: 'fuel-prices-cantons.json generatedAt', key: 'cantons', age: ageHours(now, cantons?.generatedAt) });
  }
  for (const check of checks) check.stale = check.age === null || check.age > maxAgeHours;
  return { ok: checks.every((c) => !c.stale), maxAgeHours, checks };
}

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function readJsonOrNull(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function main() {
  const maxAgeHours = Number(argValue('--max-age-hours') ?? DEFAULT_MAX_AGE_HOURS);
  const nowArg = argValue('--now');
  const now = nowArg ? new Date(nowArg) : new Date();
  const fuelPath = path.resolve(ROOT, argValue('--fuel') ?? 'data/fuel-prices.json');
  const cantonsPath = path.resolve(ROOT, argValue('--cantons') ?? 'data/fuel-prices-cantons.json');
  const verdict = evaluateFuelFreshness({
    fuel: readJsonOrNull(fuelPath),
    cantons: fs.existsSync(cantonsPath) ? readJsonOrNull(cantonsPath) : undefined,
    now,
    maxAgeHours,
  });
  console.log(JSON.stringify({ check: 'fuel-freshness', now: now.toISOString(), ...verdict }));
  for (const c of verdict.checks.filter((x) => x.stale)) {
    console.error(`::error::[fuel-freshness] ${c.source}: ${c.age === null ? 'non datato' : `${c.age}h`} (max ${maxAgeHours}h)${c.status && c.status !== 'live' ? ` — stato ${c.status}` : ''}`);
  }
  if (!verdict.ok) process.exit(1);
}

const invokedAsCli = process.argv[1] && (() => { try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; } })();
if (invokedAsCli) main();
