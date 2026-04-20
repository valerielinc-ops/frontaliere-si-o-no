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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const FUEL_DATA_PATH = path.join(ROOT, 'data', 'fuel-prices.json');
const HISTORY_DIR = path.join(ROOT, 'data', 'fuel-prices-history');
const RETENTION_DAYS = 90;

const ZONES = ['chiasso', 'mendrisio', 'lugano', 'bellinzona', 'locarno'];
// Mirror of DIESEL_OFFSET_CHF from build-plugins/fuelDailyPagesPlugin.ts.
// Duplicated here (not imported) because this script runs in plain Node —
// no TS tooling in the update-fuel-prices.yml workflow.
const DIESEL_OFFSET_CHF = 0.08;

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

function computeZoneAvg(stations, zone, fuel) {
  const filtered = zone ? stations.filter((s) => stationBelongsToZone(s, zone)) : stations;
  const prices = filtered.map((s) => {
    const sp95 = s.sp95PriceChf;
    if (typeof sp95 !== 'number' || Number.isNaN(sp95)) return null;
    return fuel === 'diesel' ? Number((sp95 + DIESEL_OFFSET_CHF).toFixed(3)) : Number(sp95.toFixed(3));
  }).filter((p) => p !== null);
  return mean(prices);
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

  const snapshot = {
    date: today,
    generatedAt: new Date().toISOString(),
    zones: {},
    regional: {
      diesel: computeZoneAvg(stations, null, 'diesel'),
      benzina: computeZoneAvg(stations, null, 'benzina'),
    },
  };

  for (const zone of ZONES) {
    snapshot.zones[zone] = {
      diesel: computeZoneAvg(stations, zone, 'diesel'),
      benzina: computeZoneAvg(stations, zone, 'benzina'),
    };
  }

  const out = path.join(HISTORY_DIR, `${today}.json`);
  fs.writeFileSync(out, JSON.stringify(snapshot, null, 2), 'utf-8');

  const pruned = pruneOldSnapshots();
  const zoneList = Object.entries(snapshot.zones)
    .map(([z, v]) => `${z}: diesel=${v.diesel} benzina=${v.benzina}`)
    .join(' | ');
  console.log(`[snapshot-fuel-history] wrote ${out}`);
  console.log(`[snapshot-fuel-history] zones → ${zoneList}`);
  if (pruned > 0) console.log(`[snapshot-fuel-history] pruned ${pruned} snapshots older than ${RETENTION_DAYS}d`);
}

main();
