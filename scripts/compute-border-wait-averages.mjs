#!/usr/bin/env node
/**
 * Compute morning/evening average ranges per crossing from the on-disk
 * border-wait history (`data/border-wait-history/*.json`).
 *
 * Output: `data/border-wait-averages.json`, keyed by crossing slug:
 *
 *   {
 *     "chiasso-strada": { "morning": "12-22 min", "evening": "20-35 min" },
 *     ...
 *   }
 *
 * The numbers are TOTAL minutes (approach delay + checkpoint queue) because
 * `snapshot-border-wait-history.mjs` aggregates buckets on
 * `totalCrossingMinutes`. The card "Ora" and the per-card averages share the
 * same metric — no more visual discontinuity between live and historical
 * values.
 *
 * Window definitions (Europe/Rome commuter pattern):
 *   - morning: 06:00-09:59 (UTC; matches Firestore `hour` field stored by
 *               the scheduler, which uses local hour at write time)
 *   - evening: 16:00-19:59
 *
 * Range = [p25, p75] of bucket averages across the rolling window. Falls back
 * to [min, max] when fewer than four samples are available.
 *
 * Output omits crossings with no history; consumers fall back to the
 * editorial defaults in `data/borderCrossings.ts`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const HISTORY_DIR = path.join(REPO_ROOT, 'data', 'border-wait-history');
const OUTPUT_PATH = path.join(REPO_ROOT, 'data', 'border-wait-averages.json');
// Second copy under public/, i.e. served at /data/border-wait-averages.json.
// data/ is not part of the deployed surface, and the article generator moving
// to nanakokyobashi-rgb/frontaliere-articles (issue #4974 item 3, §5.3 REWIRE)
// needs this overlay over HTTP: its data/borderCrossings.ts used to import the
// data/ copy directly, which stops being reachable once it runs in another
// repository. Same both-places pattern border-wait-current.json already uses.
const PUBLIC_OUTPUT_PATH = path.join(REPO_ROOT, 'public', 'data', 'border-wait-averages.json');

/** Write the averages to both the data/ copy and the published public/ one. */
function writeBoth(json) {
  fs.writeFileSync(OUTPUT_PATH, json, 'utf-8');
  fs.mkdirSync(path.dirname(PUBLIC_OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(PUBLIC_OUTPUT_PATH, json, 'utf-8');
}
const ROLLING_DAYS = 30;
const MORNING_HOURS = [6, 7, 8, 9];
const EVENING_HOURS = [16, 17, 18, 19];

function pickRecentFiles() {
  if (!fs.existsSync(HISTORY_DIR)) return [];
  const cutoff = Date.now() - ROLLING_DAYS * 24 * 60 * 60 * 1000;
  return fs
    .readdirSync(HISTORY_DIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .filter((f) => {
      const day = f.slice(0, 10);
      const t = new Date(day).getTime();
      return Number.isFinite(t) && t >= cutoff;
    })
    .sort();
}

function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return null;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.round((p / 100) * (sortedAsc.length - 1))));
  return sortedAsc[idx];
}

function rangeFor(samples) {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  if (sorted.length < 4) {
    return { low: sorted[0], high: sorted[sorted.length - 1] };
  }
  return { low: percentile(sorted, 25), high: percentile(sorted, 75) };
}

function formatRange(range) {
  if (!range) return null;
  const low = Math.max(0, Math.round(range.low));
  const high = Math.max(low, Math.round(range.high));
  // Drop degenerate ranges — editorial fallback in `data/borderCrossings.ts`
  // is more useful than "0 min" / "0-1 min" placeholders for low-traffic
  // crossings or crossings without enough history yet to characterise the
  // commuter peak.
  if (high < 2) return null;
  if (low === high) return `${low} min`;
  return `${low}-${high} min`;
}

function main() {
  const files = pickRecentFiles();
  if (files.length === 0) {
    console.warn(`[averages] no history files in ${HISTORY_DIR} — writing empty averages`);
    writeBoth(JSON.stringify({}, null, 2) + '\n');
    return;
  }

  /** @type {Record<string, { morning: number[]; evening: number[] }>} */
  const acc = {};
  for (const f of files) {
    const raw = fs.readFileSync(path.join(HISTORY_DIR, f), 'utf-8');
    let doc;
    try {
      doc = JSON.parse(raw);
    } catch (err) {
      console.warn(`[averages] skip ${f}: ${err.message}`);
      continue;
    }
    const per = doc.perCrossing || {};
    for (const [slug, hours] of Object.entries(per)) {
      if (!Array.isArray(hours) || hours.length !== 24) continue;
      const bucket = acc[slug] || { morning: [], evening: [] };
      for (const h of MORNING_HOURS) {
        const cell = hours[h];
        if (cell && typeof cell.avg === 'number') bucket.morning.push(cell.avg);
      }
      for (const h of EVENING_HOURS) {
        const cell = hours[h];
        if (cell && typeof cell.avg === 'number') bucket.evening.push(cell.avg);
      }
      acc[slug] = bucket;
    }
  }

  /** @type {Record<string, { morning: string; evening: string }>} */
  const out = {};
  for (const [slug, { morning, evening }] of Object.entries(acc)) {
    const m = formatRange(rangeFor(morning));
    const e = formatRange(rangeFor(evening));
    if (m === null && e === null) continue;
    out[slug] = {
      ...(m !== null ? { morning: m } : {}),
      ...(e !== null ? { evening: e } : {}),
    };
  }

  writeBoth(JSON.stringify(out, null, 2) + '\n');
  console.log(`✅ Wrote ${OUTPUT_PATH} + ${PUBLIC_OUTPUT_PATH} (${Object.keys(out).length} crossings)`);
}

main();
