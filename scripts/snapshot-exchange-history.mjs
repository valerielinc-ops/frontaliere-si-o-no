#!/usr/bin/env node
/**
 * Snapshot CHF→EUR exchange history → data/exchange-rate-snapshot.json.
 *
 * This is the pre-build snapshot that the static SEO build reads (via
 * build-plugins/exchangeRatePagesPlugin.ts). It mirrors the border-wait /
 * fuel-daily pattern: a cron job refreshes a committed JSON file, the build
 * itself only reads the file (deterministic, no Firestore at build time).
 *
 * Data sources, in priority order:
 *   1. Firestore `exchangeHistory/chf-eur-1y` (points) + `config/exchange_rate`
 *      (current rate) — the authoritative series the daily cron
 *      (scripts/update-exchange-history.mjs) already maintains. Used when
 *      GOOGLE_APPLICATION_CREDENTIALS is set and readable (CI).
 *   2. Frankfurter API (https://frankfurter.dev — free, ECB reference rates,
 *      $0, no key) — the exact same upstream update-exchange-history.mjs pulls
 *      from. Used as the bootstrap/fallback so the script works locally with no
 *      credentials and can seed the initial committed snapshot.
 *
 * Output shape (consumed by exchangeRateSsgData.ts#loadExchangeSnapshot):
 *   {
 *     updatedAt, rateDate, currentRate, source,
 *     windows: { "30": {startRate,startDate,min,max,avg,changePct}, "90": ..., "365": ... },
 *     sparkline: [{date, rate}, ...],   // ~53 downsampled points over 1y
 *     monthly:   [{date, rate}, ...]    // last 12 month-end points (history table)
 *   }
 *
 * The script validates its own output (finite current rate > 0, non-empty
 * series, plausible CHF→EUR band) and exits non-zero on failure, so the
 * committing workflow never poisons `main` with a malformed dump
 * (AGENTS.md § bot-direct-to-main).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';
import { httpFetchWithRetry } from './lib/transient-fetch.mjs';
import { FRANKFURTER_ENDPOINTS } from './lib/frankfurter-endpoints.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const OUT_PATH = path.join(REPO_ROOT, 'data', 'exchange-rate-snapshot.json');


// Sanity band for a CHF→EUR rate (1 CHF ≈ 0.9–1.2 EUR historically). Used to
// reject a corrupt point before it lands in the committed snapshot.
const RATE_MIN = 0.6;
const RATE_MAX = 1.6;

function isPlausibleRate(rate) {
  return Number.isFinite(rate) && rate >= RATE_MIN && rate <= RATE_MAX;
}

function isoDay(d) {
  return new Date(d).toISOString().slice(0, 10);
}

/** Fetch the trailing 12-month CHF→EUR daily series from Frankfurter. */
async function fetchFromFrankfurter() {
  const end = new Date();
  const start = new Date();
  start.setFullYear(end.getFullYear() - 1);
  start.setDate(start.getDate() - 5); // small margin so 365d-ago has a point

  for (const base of FRANKFURTER_ENDPOINTS) {
    try {
      const from = isoDay(start);
      const to = isoDay(end);
      const url = `${base}/v2/rates?base=CHF&quotes=EUR&from=${from}&to=${to}`;
      const res = await httpFetchWithRetry(url, {}, { timeout: 15000, label: `exchange ${from}..${to}` });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const points = [];
      // Frankfurter v2 returns an ARRAY of { date, base, quote, rate } —
      // same shape scripts/update-exchange-history.mjs consumes.
      if (Array.isArray(data)) {
        for (const entry of data) {
          const rate = Number(entry && entry.rate);
          const date = entry && entry.date;
          if (/^\d{4}-\d{2}-\d{2}$/.test(String(date)) && isPlausibleRate(rate)) {
            points.push({ date, rate });
          }
        }
      }
      points.sort((a, b) => a.date.localeCompare(b.date));
      if (points.length >= 30) return points;
      console.warn(`⚠️ ${base}: only ${points.length} points`);
    } catch (e) {
      console.warn(`⚠️ ${base} failed:`, e.message);
    }
  }
  throw new Error('All Frankfurter endpoints failed');
}

/**
 * Try the authoritative Firestore series. Returns { points, currentRate } or
 * null when credentials/module are unavailable — the caller then falls back to
 * Frankfurter. Never throws (best-effort enrichment).
 */
async function fetchFromFirestore() {
  const creds = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!creds || !fs.existsSync(creds)) return null;
  try {
    const { default: admin } = await import('firebase-admin');
    if (admin.apps.length === 0) {
      admin.initializeApp({
        credential: admin.credential.applicationDefault(),
        projectId: process.env.GCLOUD_PROJECT || 'frontaliere-ticino',
      });
    }
    const db = admin.firestore();
    const histDoc = await db.collection('exchangeHistory').doc('chf-eur-1y').get();
    const raw = histDoc.exists ? histDoc.data() : null;
    const points = [];
    if (raw && Array.isArray(raw.points)) {
      for (const p of raw.points) {
        const rate = Number(p && p.rate);
        const date = p && p.date;
        if (/^\d{4}-\d{2}-\d{2}$/.test(String(date)) && isPlausibleRate(rate)) {
          points.push({ date, rate });
        }
      }
    }
    points.sort((a, b) => a.date.localeCompare(b.date));
    if (points.length < 30) return null;

    // Prefer the live rate the SPA shows (config/exchange_rate.rate) so the
    // static hub matches the interactive comparator; fall back to the last
    // series point.
    let currentRate = points[points.length - 1].rate;
    try {
      const cfg = await db.collection('config').doc('exchange_rate').get();
      const liveRate = Number(cfg.exists ? cfg.data()?.rate : NaN);
      if (isPlausibleRate(liveRate)) currentRate = liveRate;
    } catch { /* ignore — series last point is a fine fallback */ }

    return { points, currentRate };
  } catch (e) {
    console.warn('⚠️ Firestore read failed, falling back to Frankfurter:', e.message);
    return null;
  }
}

/** Find the point on-or-before a target date (series must be date-sorted asc). */
function rateAtOrBefore(points, targetDate) {
  let found = null;
  for (const p of points) {
    if (p.date <= targetDate) found = p;
    else break;
  }
  return found || points[0];
}

function windowStats(points, currentRate, days) {
  const target = isoDay(Date.now() - days * 86400000);
  const start = rateAtOrBefore(points, target);
  const inWindow = points.filter((p) => p.date >= start.date);
  const rates = inWindow.map((p) => p.rate);
  const min = Math.min(...rates);
  const max = Math.max(...rates);
  const avg = rates.reduce((s, r) => s + r, 0) / rates.length;
  const changePct = ((currentRate - start.rate) / start.rate) * 100;
  return {
    startRate: round4(start.rate),
    startDate: start.date,
    min: round4(min),
    max: round4(max),
    avg: round4(avg),
    changePct: Math.round(changePct * 100) / 100,
  };
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

/** Downsample a series to ~targetCount evenly-spaced points (keeps last). */
function downsample(points, targetCount) {
  if (points.length <= targetCount) return points.map((p) => ({ date: p.date, rate: round4(p.rate) }));
  const step = (points.length - 1) / (targetCount - 1);
  const out = [];
  for (let i = 0; i < targetCount; i++) {
    const idx = Math.round(i * step);
    const p = points[Math.min(idx, points.length - 1)];
    out.push({ date: p.date, rate: round4(p.rate) });
  }
  return out;
}

/** Last month-end point for each of the trailing 12 months. */
function monthlyPoints(points) {
  const byMonth = new Map();
  for (const p of points) {
    byMonth.set(p.date.slice(0, 7), p); // sorted asc → last wins = month-end
  }
  return Array.from(byMonth.values())
    .slice(-12)
    .map((p) => ({ date: p.date, rate: round4(p.rate) }));
}

function buildSnapshot(points, currentRate, source) {
  const last = points[points.length - 1];
  return {
    updatedAt: new Date().toISOString(),
    rateDate: last.date,
    currentRate: round4(currentRate),
    source,
    windows: {
      30: windowStats(points, currentRate, 30),
      90: windowStats(points, currentRate, 90),
      365: windowStats(points, currentRate, 365),
    },
    sparkline: downsample(points, 53),
    monthly: monthlyPoints(points),
  };
}

function validate(snapshot) {
  const errs = [];
  if (!isPlausibleRate(snapshot.currentRate)) errs.push(`currentRate out of band: ${snapshot.currentRate}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(snapshot.rateDate)) errs.push(`bad rateDate: ${snapshot.rateDate}`);
  if (!Array.isArray(snapshot.sparkline) || snapshot.sparkline.length < 10) {
    errs.push(`sparkline too short: ${snapshot.sparkline?.length}`);
  }
  for (const d of ['30', '90', '365']) {
    const w = snapshot.windows[d];
    if (!w || !isPlausibleRate(w.startRate)) errs.push(`window ${d} startRate invalid`);
  }
  return errs;
}

async function main() {
  console.log('💱 Exchange Rate SSG snapshot\n');

  let points;
  let currentRate;
  let source;

  const fs1 = await fetchFromFirestore();
  if (fs1) {
    points = fs1.points;
    currentRate = fs1.currentRate;
    source = 'firestore';
    console.log(`✅ Firestore series: ${points.length} points`);
  } else {
    points = await fetchFromFrankfurter();
    currentRate = points[points.length - 1].rate;
    source = 'frankfurter';
    console.log(`✅ Frankfurter series: ${points.length} points`);
  }

  const snapshot = buildSnapshot(points, currentRate, source);
  const errs = validate(snapshot);
  if (errs.length > 0) {
    console.error('❌ Snapshot validation failed:\n  - ' + errs.join('\n  - '));
    process.exit(1);
  }

  writeJsonAtomic(OUT_PATH, snapshot);
  console.log(
    `\n✅ Wrote ${path.relative(REPO_ROOT, OUT_PATH)}\n` +
      `   current: 1 CHF = ${snapshot.currentRate} EUR (${snapshot.rateDate}, ${source})\n` +
      `   30d Δ ${snapshot.windows[30].changePct}% · 90d Δ ${snapshot.windows[90].changePct}% · 365d Δ ${snapshot.windows[365].changePct}%`,
  );
  process.exit(0);
}

main().catch((e) => {
  console.error('❌ Fatal:', e.message);
  process.exit(1);
});
