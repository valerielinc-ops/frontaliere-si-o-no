/**
 * Guard the border-wait ranking digest article generator (evergreen sibling
 * of generate-events-digest-article.mjs, #2963 pattern): body-only weekly
 * refresh writes valid per-locale TS files, the compact ranking JSON shape
 * matches what services/borderWaitRankingService.ts expects, and the full
 * pipeline (history fixtures -> computeSnapshot -> buildData) is self-consistent.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  computeSnapshot,
  buildData,
  refreshBodyFiles,
  buildRankingJson,
} from '../scripts/generate-border-wait-ranking-article.mjs';
import { buildBorderWaitRankingArticle } from '../scripts/lib/border-wait-ranking-content.mjs';
import { BORDER_WAIT_CROSSINGS } from '../build-plugins/borderWaitData';

const ranking = BORDER_WAIT_CROSSINGS.slice(0, 4).map((slug, i) => ({
  slug,
  avgMinutes: 5 + i * 10,
  totalSamples: 500,
  rank: i + 1,
}));
const trend = {
  [BORDER_WAIT_CROSSINGS[0]]: { direction: 'better' as const, deltaMinutes: -3 },
  [BORDER_WAIT_CROSSINGS[1]]: { direction: 'worse' as const, deltaMinutes: 7 },
};
const funFacts = {
  bestSlug: ranking[0].slug,
  worstSlug: ranking.at(-1)!.slug,
  deltaMinutesPerCrossing: ranking.at(-1)!.avgMinutes - ranking[0].avgMinutes,
  minutesPerYear: 13800,
  hoursPerYear: 230,
  workingDaysLostPerYear: 9.6,
};
const weekStart = '2026-12-25';
const weekEnd = '2026-12-31';
const movers = {
  improved: [{ slug: BORDER_WAIT_CROSSINGS[0], deltaMinutes: -3 }],
  worsened: [{ slug: BORDER_WAIT_CROSSINGS[1], deltaMinutes: 7 }],
};

function cell(avg: number, samples = 10) {
  return { min: avg - 2, avg, max: avg + 2, samples };
}

function makeHours(avg: number, samples = 10): Array<ReturnType<typeof cell> | null> {
  return Array.from({ length: 24 }, (_, h) => (h >= 6 && h < 20 ? cell(avg, samples) : null));
}

function writeDay(dir: string, date: string, perCrossing: Record<string, Array<ReturnType<typeof cell> | null>>) {
  writeFileSync(path.join(dir, `${date}.json`), JSON.stringify({ date, perCrossing }));
}

describe('border-wait ranking article generator', () => {
  it('refreshBodyFiles writes a valid body file for every locale', () => {
    const article = buildBorderWaitRankingArticle({ ranking, trend, funFacts, todayIso: '2027-01-01' });
    const data = { id: article.id, content: article.content };
    const root = mkdtempSync(path.join(os.tmpdir(), 'bwr-gen-'));
    refreshBodyFiles(data, root, () => {});
    for (const loc of ['it', 'en', 'de', 'fr']) {
      const f = path.join(root, 'services/locales/blog-body', loc, 'classifica-dogane-ticino.ts');
      expect(existsSync(f)).toBe(true);
      const src = readFileSync(f, 'utf-8');
      expect(src).toContain('export default');
      expect(src).toContain('blog.article.classifica-dogane-ticino.body1');
    }
  });

  it('buildRankingJson matches the shape services/borderWaitRankingService.ts expects', () => {
    const json = buildRankingJson({ ranking, trend, funFacts, todayIso: '2027-01-01', weekStart, weekEnd, movers });
    expect(json.updatedAt).toBe('2027-01-01');
    expect(json.windowDays).toBe(7);
    expect(json.weekStart).toBe(weekStart);
    expect(json.weekEnd).toBe(weekEnd);
    expect(json.movers).toEqual(movers);
    expect(json.ranking).toHaveLength(ranking.length);
    for (const [i, row] of json.ranking.entries()) {
      expect(row.slug).toBe(ranking[i].slug);
      expect(row.rank).toBe(ranking[i].rank);
      expect(typeof row.avgMinutes).toBe('number');
      expect(row.totalSamples).toBe(ranking[i].totalSamples);
      expect(['better', 'worse', 'flat']).toContain(row.trend);
    }
    expect(json.ranking[0].trend).toBe('better'); // trend[ranking[0].slug] -> 'better'
    expect(json.ranking[0].deltaMinutes).toBe(-3);
    expect(json.ranking[2].trend).toBe('flat'); // no trend entry -> falls back to 'flat'
    expect(json.ranking[2].deltaMinutes).toBeNull();
    expect(json.funFacts).toEqual(funFacts);
  });

  it('buildRankingJson rounds avgMinutes to 1 decimal', () => {
    const json = buildRankingJson({
      ranking: [{ slug: ranking[0].slug, avgMinutes: 12.3456, totalSamples: 100, rank: 1 }],
      trend: {},
      funFacts: null,
      todayIso: '2027-01-01',
    });
    expect(json.ranking[0].avgMinutes).toBe(12.3);
    expect(json.funFacts).toBeNull();
  });

  it('computeSnapshot -> buildData end-to-end pipeline is self-consistent from history fixtures', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'bwr-gen-hist-'));
    const [best, worst] = BORDER_WAIT_CROSSINGS;
    for (let i = 1; i <= 7; i += 1) {
      const date = `2026-12-${String(24 + i).padStart(2, '0')}`;
      writeDay(dir, date, { [best]: makeHours(5, 10), [worst]: makeHours(45, 10) });
    }

    const snapshot = computeSnapshot('2027-01-01', dir);
    expect(snapshot.ranking.map((r) => r.slug)).toEqual([best, worst]);
    expect(snapshot.ranking[0].avgMinutes).toBeCloseTo(5, 5);
    expect(snapshot.funFacts?.bestSlug).toBe(best);
    expect(snapshot.funFacts?.worstSlug).toBe(worst);
    expect(snapshot.weekStart).toBe('2026-12-25');
    expect(snapshot.weekEnd).toBe('2026-12-31');
    expect(snapshot.movers).toEqual({ improved: [], worsened: [] }); // both crossings flat week-over-week (no prior-window data)

    const data = buildData('2027-01-01', dir);
    expect(data.id).toBe('classifica-dogane-ticino');
    expect(data._rankedCount).toBe(2);
    expect(data.content.it.body2).toContain('|'); // has a ranking table, not the no-data fallback
    expect(data.content.it.body4).toContain('##'); // advice/movers section (task #6)
    expect(data.slugs.it).toBe('classifica-dogane-ticino');
  });

  it('buildData falls back gracefully when the history dir has no usable data', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'bwr-gen-empty-'));
    const data = buildData('2027-01-01', dir);
    expect(data._rankedCount).toBe(0);
    expect(data.content.it.body2).toBe('');
    expect(data.content.en.body1.toLowerCase()).toMatch(/not enough data/);
  });
});
