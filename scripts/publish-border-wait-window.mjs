#!/usr/bin/env node
/**
 * Publish the border-wait ranking window as a small public artifact
 * (issue #4974 item 3 — the REWIRE that lets `generate-border-wait-ranking-article.mjs`
 * move to nanakokyobashi-rgb/frontaliere-articles).
 *
 * WHY
 *
 * The weekly ranking article is computed from `data/border-wait-history/*.json`:
 * 90 daily files, 1.7 GB, committed here and nowhere else, and deliberately not
 * part of the deployed surface (`deploy.yml` ignores it as a deploy trigger).
 * The generator cannot take that with it, and should not — it is site telemetry
 * this repository collects from Firestore, not article content.
 *
 * What the generator actually needs is much smaller than the history. Every one
 * of `computeRanking` / `computeTrend` / `computeFunFacts` bottoms out on
 * `aggregateCrossingStats()`, whose output is ~23 crossings x 2 numbers. So this
 * publishes that aggregate — a few KB — and nanako runs the identical pure
 * functions over it. The heavy data never leaves this repo, and the editorial
 * half (ranking, trend, fun facts, article text) lives with the generator.
 *
 * TWO windows, not one: `computeTrend()` compares the current window against the
 * immediately preceding one of equal length. Publishing only `current` would
 * silently cost the article its week-over-week trend section.
 *
 * The numbers here come from the SAME `aggregateCrossingStats()` the in-repo
 * producer uses — imported, not reimplemented — so there is no second definition
 * of the statistic to drift.
 *
 * Usage:
 *   node scripts/publish-border-wait-window.mjs
 *   node scripts/publish-border-wait-window.mjs --check    # validate, write nothing
 *   node scripts/publish-border-wait-window.mjs --today=2026-07-15   # pin the clock
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';
import {
  DEFAULT_WINDOW_DAYS,
  aggregateCrossingStats,
  computeWeekWindow,
} from './lib/border-wait-ranking.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const HISTORY_DIR = path.join(REPO_ROOT, 'data', 'border-wait-history');
const OUT_PATH = path.join(REPO_ROOT, 'public', 'data', 'border-wait-ranking-window.json');

const CHECK_ONLY = process.argv.includes('--check');
const todayArg = process.argv.find((a) => a.startsWith('--today='))?.slice('--today='.length);

const log = (msg) => console.log(`[publish-border-wait-window] ${msg}`);
const fail = (msg) => {
  console.error(`::error::[publish-border-wait-window] ${msg}`);
  process.exit(1);
};

if (todayArg && !/^\d{4}-\d{2}-\d{2}$/.test(todayArg)) {
  fail(`--today must be YYYY-MM-DD, got ${JSON.stringify(todayArg)}`);
}
const todayIso = todayArg ?? new Date().toISOString().slice(0, 10);

if (!fs.existsSync(HISTORY_DIR)) {
  fail(`${path.relative(REPO_ROOT, HISTORY_DIR)} does not exist — nothing to aggregate`);
}

const days = DEFAULT_WINDOW_DAYS;

/** ISO "today" for the previous window: the current window shifted back `days`. */
function isoDayOffset(iso, delta) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

const previousTodayIso = isoDayOffset(todayIso, -days);

const current = aggregateCrossingStats(HISTORY_DIR, todayIso, days);
const previous = aggregateCrossingStats(HISTORY_DIR, previousTodayIso, days);

// An empty current window means the snapshot job has not landed anything for a
// week. Publishing it would hand the generator a document that looks valid and
// produces an article with no ranking in it, so refuse instead — the consumer's
// own guard would catch it, but failing at the source names the real cause.
if (Object.keys(current).length === 0) {
  fail(`no crossings in the current ${days}-day window ending ${todayIso} — refusing to publish`);
}

const payload = {
  generatedFor: todayIso,
  windowDays: days,
  current: { ...computeWeekWindow(todayIso, days), perCrossing: current },
  previous: { ...computeWeekWindow(previousTodayIso, days), perCrossing: previous },
};

const body = `${JSON.stringify(payload, null, 2)}\n`;

if (CHECK_ONLY) {
  log(
    `--check: ${Object.keys(current).length} crossings current / ` +
      `${Object.keys(previous).length} previous, wrote nothing`,
  );
  process.exit(0);
}

writeJsonAtomic(OUT_PATH, payload);
log(
  `wrote ${path.relative(REPO_ROOT, OUT_PATH)} — ` +
    `${payload.current.weekStart}..${payload.current.weekEnd}, ` +
    `${Object.keys(current).length} crossings (${(body.length / 1024).toFixed(1)} KB)`,
);
