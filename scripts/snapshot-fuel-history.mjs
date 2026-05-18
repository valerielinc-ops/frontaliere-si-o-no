#!/usr/bin/env node

/**
 * Snapshot today's fuel prices per zone to data/fuel-prices-history/YYYY-MM-DD.json.
 *
 * Runs after scripts/generate-fuel-prices-dataset.mjs in the
 * update-fuel-prices workflow. Builds the rolling 7-day trend that powers
 * the fuel-daily SEO pages and month archives.
 *
 * Retention: 90 days. Older snapshots are pruned in place to keep the repo
 * small and the build tractable.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildStationSlug } from './lib/fuel-station-slug.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const FUEL_DATA_PATH = path.join(ROOT, 'data', 'fuel-prices.json');
const HISTORY_DIR = path.join(ROOT, 'data', 'fuel-prices-history');
const RETENTION_DAYS = 90;

const ZONES = ['chiasso', 'mendrisio', 'lugano', 'bellinzona', 'locarno'];
// Italian curated cities — must mirror FUEL_ITALIAN_CITIES in
// build-plugins/fuelDailyData.ts. matchKey is the lowercase municipality
// name as it appears in data/fuel-prices.json (`municipality` field).
const ITALIAN_CITIES = [
  { slug: 'como', matchKey: 'como' },
  { slug: 'varese', matchKey: 'varese' },
  { slug: 'luino', matchKey: 'luino' },
  { slug: 'lavena-ponte-tresa', matchKey: 'lavena ponte tresa' },
  { slug: 'gallarate', matchKey: 'gallarate' },
  { slug: 'cantu', matchKey: 'cantù' },
  { slug: 'saronno', matchKey: 'saronno' },
  { slug: 'menaggio', matchKey: 'menaggio' },
  { slug: 'porto-ceresio', matchKey: 'porto ceresio' },
  { slug: 'lecco', matchKey: 'lecco' },
  { slug: 'sondrio', matchKey: 'sondrio' },
  { slug: 'tirano', matchKey: 'tirano' },
  { slug: 'chiavenna', matchKey: 'chiavenna' },
  { slug: 'morbegno', matchKey: 'morbegno' },
  { slug: 'cernobbio', matchKey: 'cernobbio' },
];
// Legacy fallback: the TCS Firestore feed now exposes per-station DIESEL prices
// directly (ingested by scripts/generate-fuel-prices-dataset.mjs → `dieselPriceChf`),
// so the SP95+offset derivation is no longer the primary path. We keep the
// constant as a documented fallback for historical snapshot files emitted before
// the real-diesel ingestion rolled out, and in case the DIESEL field
// temporarily disappears from the upstream feed. Observed delta on Swiss retail
// ≈ 0.08 CHF/L (diesel above SP95) as of 2026 — tune centrally if needed.
const LEGACY_DIESEL_OFFSET_CHF = 0.08;

function mean(nums) {
  if (nums.length === 0) return null;
  const sum = nums.reduce((a, b) => a + b, 0);
  return Number((sum / nums.length).toFixed(3));
}

function stationBelongsToZone(station, zone) {
  const addr = String(station?.address || '').toLowerCase();
  return addr.includes(zone.toLowerCase());
}

function collectStations(dataset) {
  const seen = new Set();
  const out = [];
  for (const row of dataset?.municipalities ?? []) {
    const nearby = row?.swiss?.nearbyStations ?? [];
    for (const s of nearby) {
      if (!s || typeof s.sp95PriceChf !== 'number') continue;
      const key = `${s.id ?? s.name ?? ''}:${s.address ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(s);
    }
  }
  return out;
}

/**
 * Resolve a per-station price for the target fuel. Reads the real
 * `dieselPriceChf` field populated by the TCS Firestore feed when available;
 * falls back to SP95 + observed offset only for stations that still lack a
 * direct DIESEL record (reported in logs so coverage gaps stay visible).
 */
function stationPriceForFuel(station, fuel) {
  const sp95 = station.sp95PriceChf;
  if (typeof sp95 !== 'number' || Number.isNaN(sp95)) return null;
  if (fuel === 'benzina') return Number(sp95.toFixed(3));
  // fuel === 'diesel'
  const real = station.dieselPriceChf;
  if (typeof real === 'number' && Number.isFinite(real)) {
    return Number(real.toFixed(3));
  }
  return Number((sp95 + LEGACY_DIESEL_OFFSET_CHF).toFixed(3));
}

function computeZoneAvg(stations, zone, fuel) {
  const filtered = zone ? stations.filter((s) => stationBelongsToZone(s, zone)) : stations;
  const prices = filtered
    .map((s) => stationPriceForFuel(s, fuel))
    .filter((p) => p !== null);
  return mean(prices);
}

/**
 * Snapshot coverage diagnostics — included in the emitted snapshot so we can
 * audit the proportion of "real" vs "derived" diesel prices day by day.
 */
function dieselCoverageStats(stations) {
  const total = stations.length;
  const real = stations.filter((s) => typeof s.dieselPriceChf === 'number' && Number.isFinite(s.dieselPriceChf)).length;
  return {
    totalStations: total,
    realDieselStations: real,
    realDieselPct: total ? Number(((real / total) * 100).toFixed(1)) : 0,
  };
}

/**
 * Compute per-curated-city average benzina price from the Italian station
 * data. Dedupes by station id (each station appears twice: self + served)
 * keeping the cheapest variant. Returns null when a city has no stations
 * (e.g. Cernobbio). Only benzina is tracked — MIMIT diesel ingestion is
 * not yet wired into generate-fuel-prices-dataset.mjs.
 */
function computeItalianCityAverages(dataset) {
  const out = {};
  for (const city of ITALIAN_CITIES) {
    const seen = new Map();
    for (const row of dataset?.municipalities ?? []) {
      const muniKey = String(row?.municipality || '').toLowerCase();
      if (muniKey !== city.matchKey) continue;
      const stations = row?.italy?.stations ?? [];
      for (const s of stations) {
        if (!s?.id || typeof s.priceEur !== 'number') continue;
        const existing = seen.get(s.id);
        if (!existing || existing > s.priceEur) {
          seen.set(s.id, s.priceEur);
        }
      }
    }
    const prices = Array.from(seen.values());
    out[city.slug] = {
      benzina: mean(prices),
      stationCount: prices.length,
    };
  }
  return out;
}

function pruneOldSnapshots() {
  if (!fs.existsSync(HISTORY_DIR)) return 0;
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let pruned = 0;
  for (const file of fs.readdirSync(HISTORY_DIR)) {
    const m = /^(\d{4}-\d{2}-\d{2})\.json$/.exec(file);
    if (!m) continue;
    const fileDate = new Date(m[1]).getTime();
    if (Number.isNaN(fileDate)) continue;
    if (fileDate < cutoff) {
      fs.unlinkSync(path.join(HISTORY_DIR, file));
      pruned++;
    }
  }
  return pruned;
}

function main() {
  if (!fs.existsSync(FUEL_DATA_PATH)) {
    console.error('[snapshot-fuel-history] data/fuel-prices.json not found — skip');
    process.exit(0);
  }

  let dataset;
  try {
    dataset = JSON.parse(fs.readFileSync(FUEL_DATA_PATH, 'utf-8'));
  } catch (err) {
    console.error('[snapshot-fuel-history] failed to parse fuel-prices.json:', err.message);
    process.exit(1);
  }

  fs.mkdirSync(HISTORY_DIR, { recursive: true });

  const stations = collectStations(dataset);
  const today = new Date().toISOString().slice(0, 10);
  const coverage = dieselCoverageStats(stations);
  const dieselSource = coverage.realDieselStations === 0
    ? 'derived'
    : coverage.realDieselStations === coverage.totalStations
      ? 'api'
      : 'mixed';

  const snapshot = {
    date: today,
    generatedAt: new Date().toISOString(),
    zones: {},
    regional: {
      diesel: computeZoneAvg(stations, null, 'diesel'),
      benzina: computeZoneAvg(stations, null, 'benzina'),
    },
    diesel: {
      source: dieselSource,
      realCoveragePct: coverage.realDieselPct,
      realStationCount: coverage.realDieselStations,
      totalStationCount: coverage.totalStations,
    },
  };

  for (const zone of ZONES) {
    snapshot.zones[zone] = {
      diesel: computeZoneAvg(stations, zone, 'diesel'),
      benzina: computeZoneAvg(stations, zone, 'benzina'),
    };
  }

  // Italian per-city averages (benzina only — see comment on computeItalianCityAverages)
  snapshot.italianCities = computeItalianCityAverages(dataset);

  // Per-station prices (added 2026-05-18). Keyed by the same slug the SEO
  // renderer computes via build-plugins/fuelDailyData.ts → buildStationSlug.
  // Going forward, this populates the per-station price-history chart on
  // /prezzi-{fuel}/{zone}/stazioni/{slug}/ pages. Older snapshots (pre this
  // commit) only carry zone averages; the renderer falls back to zone with a
  // disclaimer when station-level points are <3.
  //
  // Collision handling: when two stations resolve to the same slug (rare —
  // same brand + same street prefix across cities), the LAST one wins. The
  // renderer side adds `-2`/`-3` suffixes for uniqueness; those suffixed
  // slugs won't match here and will fall back to zone, which is acceptable.
  const stationsByslug = {};
  for (const s of stations) {
    const slug = buildStationSlug({ brand: s.brand, name: s.name, address: s.address });
    if (!slug) continue;
    const diesel = stationPriceForFuel(s, 'diesel');
    const benzina = stationPriceForFuel(s, 'benzina');
    if (diesel === null && benzina === null) continue;
    const entry = {};
    if (diesel !== null) entry.diesel = diesel;
    if (benzina !== null) entry.benzina = benzina;
    stationsByslug[slug] = entry;
  }
  snapshot.stations = stationsByslug;

  const out = path.join(HISTORY_DIR, `${today}.json`);
  fs.writeFileSync(out, JSON.stringify(snapshot, null, 2), 'utf-8');

  const pruned = pruneOldSnapshots();
  const zoneList = Object.entries(snapshot.zones)
    .map(([z, v]) => `${z}: diesel=${v.diesel} benzina=${v.benzina}`)
    .join(' | ');
  console.log(`[snapshot-fuel-history] wrote ${out}`);
  console.log(`[snapshot-fuel-history] zones → ${zoneList}`);
  console.log(
    `[snapshot-fuel-history] diesel source=${dieselSource} real=${coverage.realDieselStations}/${coverage.totalStations} (${coverage.realDieselPct}%)`,
  );
  if (pruned > 0) console.log(`[snapshot-fuel-history] pruned ${pruned} snapshots older than ${RETENTION_DAYS}d`);
}

main();
