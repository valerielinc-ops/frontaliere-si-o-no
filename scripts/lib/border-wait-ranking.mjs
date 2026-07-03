/**
 * Pure aggregation over the on-disk border-wait history
 * (`data/border-wait-history/*.json`) for the weekly "best/worst dogane"
 * ranking digest. Slug-driven only — mirrors compute-border-wait-averages.mjs
 * (no crossing-metadata import, so this runs under plain `node`, no `tsx`).
 * Display names / regions / page links are layered on top by the content
 * builder, which needs `build-plugins/borderWaitData.ts` and therefore runs
 * via `tsx` (same split as check-border-data-health.mjs).
 *
 * History file schema (one per day, `YYYY-MM-DD.json`):
 *   { date: 'YYYY-MM-DD', perCrossing: { [slug]: Array(24 hourly cells) } }
 *   cell = null | { min, avg, max, samples }
 * `avg`/`samples` are TOTAL crossing minutes (approach + checkpoint queue),
 * same metric as compute-border-wait-averages.mjs.
 */
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_WINDOW_DAYS = 7;
export const MIN_SAMPLES_FOR_RANKING = 20;

function isoDayOffset(todayIso, deltaDays) {
  const d = new Date(`${todayIso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

/** File names (not existence-checked) for the `days` window ending the day BEFORE todayIso. */
export function windowFileNames(todayIso, days = DEFAULT_WINDOW_DAYS) {
  const names = [];
  for (let i = 1; i <= days; i += 1) names.push(`${isoDayOffset(todayIso, -i)}.json`);
  return names.sort();
}

function readHistoryDoc(historyDir, fileName) {
  const file = path.join(historyDir, fileName);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Weighted-average total-crossing-minutes per slug over a trailing window.
 * Weight = `samples` per hourly cell, so busier hours count proportionally
 * more than a lightly-sampled overnight cell.
 * @returns {Record<string, { weightedAvgMinutes: number, totalSamples: number }>}
 */
export function aggregateCrossingStats(historyDir, todayIso, days = DEFAULT_WINDOW_DAYS) {
  /** @type {Record<string, { sum: number, samples: number }>} */
  const acc = {};
  for (const fileName of windowFileNames(todayIso, days)) {
    const doc = readHistoryDoc(historyDir, fileName);
    if (!doc || typeof doc.perCrossing !== 'object' || doc.perCrossing === null) continue;
    for (const [slug, hours] of Object.entries(doc.perCrossing)) {
      if (!Array.isArray(hours)) continue;
      const bucket = acc[slug] || { sum: 0, samples: 0 };
      for (const cell of hours) {
        if (!cell || typeof cell.avg !== 'number' || typeof cell.samples !== 'number') continue;
        bucket.sum += cell.avg * cell.samples;
        bucket.samples += cell.samples;
      }
      acc[slug] = bucket;
    }
  }

  /** @type {Record<string, { weightedAvgMinutes: number, totalSamples: number }>} */
  const out = {};
  for (const [slug, { sum, samples }] of Object.entries(acc)) {
    if (samples <= 0) continue;
    out[slug] = { weightedAvgMinutes: sum / samples, totalSamples: samples };
  }
  return out;
}

/**
 * Best→worst ranking (ascending average wait). Crossings under
 * `minSamples` total observations are dropped — not enough data to rank fairly.
 * @returns {Array<{ slug: string, avgMinutes: number, totalSamples: number, rank: number }>}
 */
export function computeRanking(historyDir, todayIso, { days = DEFAULT_WINDOW_DAYS, minSamples = MIN_SAMPLES_FOR_RANKING } = {}) {
  const stats = aggregateCrossingStats(historyDir, todayIso, days);
  return Object.entries(stats)
    .filter(([, s]) => s.totalSamples >= minSamples)
    .map(([slug, s]) => ({ slug, avgMinutes: s.weightedAvgMinutes, totalSamples: s.totalSamples }))
    .sort((a, b) => a.avgMinutes - b.avgMinutes)
    .map((entry, idx) => ({ ...entry, rank: idx + 1 }));
}

/**
 * Week-over-week trend per slug: current window vs. the immediately
 * preceding window of equal length. `deltaMinutes` > 0 means it got WORSE
 * (slower) week over week.
 * @returns {Record<string, { currentAvgMinutes: number, previousAvgMinutes: number, deltaMinutes: number, direction: 'better'|'worse'|'flat' }>}
 */
export function computeTrend(historyDir, todayIso, { days = DEFAULT_WINDOW_DAYS, minSamples = MIN_SAMPLES_FOR_RANKING } = {}) {
  const current = aggregateCrossingStats(historyDir, todayIso, days);
  const previousTodayIso = isoDayOffset(todayIso, -days);
  const previous = aggregateCrossingStats(historyDir, previousTodayIso, days);

  /** @type {Record<string, ReturnType<typeof computeTrend>[string]>} */
  const out = {};
  for (const [slug, curr] of Object.entries(current)) {
    const prev = previous[slug];
    if (!prev || curr.totalSamples < minSamples || prev.totalSamples < minSamples) continue;
    const deltaMinutes = curr.weightedAvgMinutes - prev.weightedAvgMinutes;
    const direction = Math.abs(deltaMinutes) < 0.5 ? 'flat' : deltaMinutes > 0 ? 'worse' : 'better';
    out[slug] = {
      currentAvgMinutes: curr.weightedAvgMinutes,
      previousAvgMinutes: prev.weightedAvgMinutes,
      deltaMinutes,
      direction,
    };
  }
  return out;
}

/**
 * "Minutes of life" fun facts comparing the best vs. worst ranked crossing —
 * the engaging hook the article is built around. Pure arithmetic on an
 * explicit commuter assumption (round trip = 2 crossings/day).
 */
export function computeFunFacts(ranking, { crossingsPerDay = 2, workingDaysPerYear = 230 } = {}) {
  if (ranking.length < 2) return null;
  const best = ranking[0];
  const worst = ranking[ranking.length - 1];
  const deltaMinutesPerCrossing = worst.avgMinutes - best.avgMinutes;
  const minutesPerYear = deltaMinutesPerCrossing * crossingsPerDay * workingDaysPerYear;
  return {
    bestSlug: best.slug,
    worstSlug: worst.slug,
    deltaMinutesPerCrossing,
    minutesPerYear: Math.round(minutesPerYear),
    hoursPerYear: Math.round((minutesPerYear / 60) * 10) / 10,
    workingDaysLostPerYear: Math.round((minutesPerYear / (24 * 60)) * 10) / 10,
  };
}
