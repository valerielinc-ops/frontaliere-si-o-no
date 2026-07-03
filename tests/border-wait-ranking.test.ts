/**
 * Guard the border-wait ranking aggregation lib (dogane best/worst digest,
 * chained on #2963's evergreen-article pattern): weighted averages, ranking
 * order, week-over-week trend, and the "minutes of life" fun-fact arithmetic.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  aggregateCrossingStats,
  computeRanking,
  computeTrend,
  computeFunFacts,
  windowFileNames,
} from '../scripts/lib/border-wait-ranking.mjs';

function cell(avg: number, samples = 10) {
  return { min: avg - 2, avg, max: avg + 2, samples };
}

function writeDay(dir: string, date: string, perCrossing: Record<string, Array<ReturnType<typeof cell> | null>>) {
  writeFileSync(path.join(dir, `${date}.json`), JSON.stringify({ date, perCrossing }));
}

function makeHours(avg: number, samples = 10): Array<ReturnType<typeof cell> | null> {
  return Array.from({ length: 24 }, (_, h) => (h >= 6 && h < 20 ? cell(avg, samples) : null));
}

describe('border-wait ranking lib', () => {
  it('windowFileNames returns the N days strictly before todayIso, sorted', () => {
    const names = windowFileNames('2026-07-10', 3);
    expect(names).toEqual(['2026-07-07.json', '2026-07-08.json', '2026-07-09.json']);
  });

  it('aggregateCrossingStats computes a samples-weighted average across the window', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'bwr-agg-'));
    writeDay(dir, '2026-07-01', { fast: makeHours(10, 10), slow: makeHours(40, 10) });
    writeDay(dir, '2026-07-02', { fast: makeHours(10, 10), slow: makeHours(40, 10) });
    const stats = aggregateCrossingStats(dir, '2026-07-03', 7);
    expect(stats.fast.weightedAvgMinutes).toBeCloseTo(10, 5);
    expect(stats.slow.weightedAvgMinutes).toBeCloseTo(40, 5);
    expect(stats.fast.totalSamples).toBe(14 * 10 * 2);
  });

  it('ignores null cells and files outside the window', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'bwr-agg-null-'));
    writeDay(dir, '2026-06-01', { fast: makeHours(999, 999) }); // way outside a 7-day window
    writeDay(dir, '2026-07-02', { fast: makeHours(12, 5) });
    const stats = aggregateCrossingStats(dir, '2026-07-03', 7);
    expect(stats.fast.weightedAvgMinutes).toBeCloseTo(12, 5);
  });

  it('computeRanking sorts best (lowest wait) to worst and drops under-sampled crossings', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'bwr-rank-'));
    writeDay(dir, '2026-07-02', {
      best: makeHours(5, 10),
      mid: makeHours(20, 10),
      worst: makeHours(45, 10),
      sparse: [cell(1, 2)].concat(Array(23).fill(null)), // below minSamples
    });
    const ranking = computeRanking(dir, '2026-07-03', { days: 7 });
    expect(ranking.map((r) => r.slug)).toEqual(['best', 'mid', 'worst']);
    expect(ranking[0].rank).toBe(1);
    expect(ranking.at(-1)!.rank).toBe(3);
  });

  it('computeTrend compares current window vs. the prior equal-length window', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'bwr-trend-'));
    // previous 7-day window (2026-06-19..2026-06-25 for todayIso=2026-07-03, days=7)
    writeDay(dir, '2026-06-20', { x: makeHours(10, 20) });
    writeDay(dir, '2026-06-21', { x: makeHours(10, 20) });
    // current 7-day window (2026-06-26..2026-07-02) — worse
    writeDay(dir, '2026-07-02', { x: makeHours(30, 20) });
    const trend = computeTrend(dir, '2026-07-03', { days: 7 });
    expect(trend.x.direction).toBe('worse');
    expect(trend.x.deltaMinutes).toBeGreaterThan(0);
    expect(trend.x.previousAvgMinutes).toBeCloseTo(10, 5);
    expect(trend.x.currentAvgMinutes).toBeCloseTo(30, 5);
  });

  it('computeFunFacts derives yearly minutes lost between best and worst crossing', () => {
    const ranking = [
      { slug: 'best', avgMinutes: 5, totalSamples: 100, rank: 1 },
      { slug: 'mid', avgMinutes: 20, totalSamples: 100, rank: 2 },
      { slug: 'worst', avgMinutes: 45, totalSamples: 100, rank: 3 },
    ];
    const facts = computeFunFacts(ranking, { crossingsPerDay: 2, workingDaysPerYear: 230 });
    expect(facts).not.toBeNull();
    expect(facts!.bestSlug).toBe('best');
    expect(facts!.worstSlug).toBe('worst');
    expect(facts!.deltaMinutesPerCrossing).toBe(40);
    expect(facts!.minutesPerYear).toBe(40 * 2 * 230);
  });

  it('computeFunFacts returns null when fewer than 2 ranked crossings', () => {
    expect(computeFunFacts([{ slug: 'only', avgMinutes: 5, totalSamples: 10, rank: 1 }])).toBeNull();
    expect(computeFunFacts([])).toBeNull();
  });
});
