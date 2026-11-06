#!/usr/bin/env node
/**
 * compute-weekly-employer-delta.mjs — F5 utility
 *
 * Reads the last two weekly snapshots from `data/jobs-snapshots-history/`
 * and writes `data/weekly-employers-delta.json`:
 *
 *   {
 *     generatedAt: ISO string,
 *     currentWeek: "YYYY-WW",
 *     previousWeek: "YYYY-WW",
 *     cities: {
 *       [city]: {
 *         totalActive: N,
 *         topCompanies: [{ employer, employerKey?, active, delta }, …],
 *         newcomers:   [{ employer, employerKey?, active }, …],
 *       }
 *     }
 *   }
 *
 * Used by the CI snapshot workflow as a human-readable report (the
 * Vite build plugin re-computes the same thing at build time, but
 * persisting a JSON is convenient for dashboards and QA).
 *
 * Degradation: if fewer than 2 snapshots exist, writes a minimal
 * file with `degraded: true` and empty deltas. Never exits non-zero.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(__dirname, '..');
const HISTORY_DIR = join(ROOT, 'data', 'jobs-snapshots-history');
const OUT_PATH = join(ROOT, 'data', 'weekly-employers-delta.json');

const CITIES = ['ticino', 'lugano', 'mendrisio', 'chiasso', 'stabio', 'bellinzona', 'locarno'];
const CITY_DISPLAY = {
  ticino: 'Ticino',
  lugano: 'Lugano',
  mendrisio: 'Mendrisio',
  chiasso: 'Chiasso',
  stabio: 'Stabio',
  bellinzona: 'Bellinzona',
  locarno: 'Locarno',
};

function normEmployerKey(employer, employerKey) {
  const raw = String(employerKey || employer || '').trim().toLowerCase();
  return raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function cityMatches(rowCity, city) {
  if (city === 'ticino') return true;
  return String(rowCity || '').toLowerCase().includes(CITY_DISPLAY[city].toLowerCase());
}

function readSnapshots() {
  if (!existsSync(HISTORY_DIR)) return [];
  const files = readdirSync(HISTORY_DIR)
    .filter((f) => /^\d{4}-\d{2}\.json$/.test(f))
    .sort();
  const out = [];
  for (const file of files) {
    try {
      const raw = JSON.parse(readFileSync(join(HISTORY_DIR, file), 'utf-8'));
      if (raw && typeof raw.week === 'string' && Array.isArray(raw.jobs)) {
        out.push(raw);
      }
    } catch (err) {
      console.warn(`[compute-weekly-employer-delta] skip malformed ${file}: ${err?.message || err}`);
    }
  }
  return out;
}

function aggregateCity(city, snapshot) {
  const counts = new Map();
  for (const row of snapshot.jobs) {
    if (!cityMatches(row.city, city)) continue;
    const key = normEmployerKey(row.employer, row.employerKey);
    if (!key) continue;
    const cur = counts.get(key) ?? { employer: row.employer, employerKey: row.employerKey || key, active: 0 };
    cur.active++;
    counts.set(key, cur);
  }
  return counts;
}

function computeCityDelta(city, current, previous) {
  const curCounts = aggregateCity(city, current);
  const prevCounts = previous ? aggregateCity(city, previous) : new Map();

  const topCompanies = Array.from(curCounts.entries())
    .map(([key, rec]) => {
      const prev = prevCounts.get(key)?.active ?? 0;
      return {
        employer: rec.employer,
        employerKey: rec.employerKey,
        active: rec.active,
        delta: rec.active - prev,
      };
    })
    .sort((a, b) => {
      if (b.delta !== a.delta) return b.delta - a.delta;
      return b.active - a.active;
    })
    .slice(0, 20);

  const newcomers = Array.from(curCounts.entries())
    .filter(([key]) => !prevCounts.has(key))
    .map(([, rec]) => ({
      employer: rec.employer,
      employerKey: rec.employerKey,
      active: rec.active,
    }))
    .sort((a, b) => b.active - a.active)
    .slice(0, 10);

  let totalActive = 0;
  for (const rec of curCounts.values()) totalActive += rec.active;

  return { totalActive, topCompanies, newcomers };
}

function main() {
  mkdirSync(resolve(OUT_PATH, '..'), { recursive: true });
  const snapshots = readSnapshots();

  if (snapshots.length === 0) {
    const out = {
      generatedAt: new Date().toISOString(),
      degraded: true,
      reason: 'No snapshots found in data/jobs-snapshots-history/.',
      cities: Object.fromEntries(CITIES.map((c) => [c, { totalActive: 0, topCompanies: [], newcomers: [] }])),
    };
    writeFileSync(OUT_PATH, JSON.stringify(out, null, 2) + '\n', 'utf-8');
    console.log('[compute-weekly-employer-delta] No snapshots — wrote degraded file.');
    return;
  }

  const current = snapshots[snapshots.length - 1];
  const previous = snapshots.length >= 2 ? snapshots[snapshots.length - 2] : null;

  const cities = {};
  for (const city of CITIES) {
    cities[city] = computeCityDelta(city, current, previous);
  }

  const out = {
    generatedAt: new Date().toISOString(),
    degraded: previous === null,
    currentWeek: current.week,
    previousWeek: previous?.week ?? null,
    cities,
  };
  writeFileSync(OUT_PATH, JSON.stringify(out, null, 2) + '\n', 'utf-8');
  console.log(
    `[compute-weekly-employer-delta] Wrote delta for week ${current.week} (previous=${previous?.week ?? 'none'}).`,
  );
}

main();
