/**
 * Guard the border-wait ranking digest content builder (evergreen sibling of
 * events-digest-content.mjs): valid markdown shape, working crossing links,
 * fun-fact callout, and the sparse-data fallback.
 */
import { describe, it, expect } from 'vitest';
import {
  buildBorderWaitRankingArticle,
  RANKING_ARTICLE_ID,
  RANKING_ARTICLE_SLUGS,
} from '../scripts/lib/border-wait-ranking-content.mjs';
import { BORDER_WAIT_CROSSINGS, buildOggiPath } from '../build-plugins/borderWaitData';

const ranking = BORDER_WAIT_CROSSINGS.slice(0, 8).map((slug, i) => ({
  slug,
  avgMinutes: 5 + i * 5,
  totalSamples: 500,
  rank: i + 1,
}));
const trend = {
  [BORDER_WAIT_CROSSINGS[0]]: { direction: 'better', deltaMinutes: -4 },
  [BORDER_WAIT_CROSSINGS[1]]: { direction: 'worse', deltaMinutes: 6 },
};
const funFacts = {
  bestSlug: ranking[0].slug,
  worstSlug: ranking.at(-1)!.slug,
  deltaMinutesPerCrossing: ranking.at(-1)!.avgMinutes - ranking[0].avgMinutes,
  minutesPerYear: 16100,
  hoursPerYear: 268.3,
  workingDaysLostPerYear: 11.2,
};
const weekStart = '2026-06-27';
const weekEnd = '2026-07-03';
const movers = {
  improved: [{ slug: BORDER_WAIT_CROSSINGS[0], deltaMinutes: -4 }],
  worsened: [{ slug: BORDER_WAIT_CROSSINGS[1], deltaMinutes: 6 }],
};

describe('border-wait ranking content builder', () => {
  it('has a stable evergreen id/slug map (no date embedded)', () => {
    expect(RANKING_ARTICLE_ID).toBe('classifica-dogane-ticino');
    expect(RANKING_ARTICLE_SLUGS.it).toBe(RANKING_ARTICLE_ID);
    expect(Object.keys(RANKING_ARTICLE_SLUGS).sort()).toEqual(['de', 'en', 'fr', 'it']);
  });

  it('builds 4-locale content with title/excerpt/body1-4/faq for every locale', () => {
    const article = buildBorderWaitRankingArticle({ ranking, trend, funFacts, weekStart, weekEnd, movers, todayIso: '2026-07-03' });
    for (const locale of ['it', 'en', 'de', 'fr'] as const) {
      const c = article.content[locale];
      expect(c.title.length).toBeGreaterThan(0);
      expect(c.excerpt.length).toBeGreaterThan(0);
      expect(c.body1).toContain('##');
      expect(c.body2).toContain('|'); // ranking table
      expect(c.body3).toContain('##');
      expect(c.body4).toContain('##'); // advice/region breakdown section (task #6)
      expect(c.faq.length).toBeGreaterThanOrEqual(3);
      expect(article.imageAlt[locale].length).toBeGreaterThan(0);
    }
  });

  it('links every ranked crossing to its real per-crossing page path', () => {
    const article = buildBorderWaitRankingArticle({ ranking, trend, funFacts, weekStart, weekEnd, movers, todayIso: '2026-07-03' });
    const expectedPath = buildOggiPath('it', ranking[0].slug);
    expect(article.content.it.body2).toContain(expectedPath);
  });

  it('renders the fun-fact minutes-of-life callout with the real numbers', () => {
    const article = buildBorderWaitRankingArticle({ ranking, trend, funFacts, weekStart, weekEnd, movers, todayIso: '2026-07-03' });
    expect(article.content.it.body1).toContain('📊');
    expect(article.content.it.body1).toContain(funFacts.minutesPerYear.toLocaleString('it-CH'));
  });

  it('shows the actual data week range, not just the generation date', () => {
    const article = buildBorderWaitRankingArticle({ ranking, trend, funFacts, weekStart, weekEnd, movers, todayIso: '2026-07-03' });
    expect(article.content.it.body1).toContain('27');
    expect(article.content.it.body1.toLowerCase()).toContain('luglio');
  });

  it('surfaces the biggest week-over-week movers in the copy', () => {
    const article = buildBorderWaitRankingArticle({ ranking, trend, funFacts, weekStart, weekEnd, movers, todayIso: '2026-07-03' });
    expect(article.content.it.body1).toContain('4 min'); // improved mover delta
    expect(article.content.it.body1).toContain('6 min'); // worsened mover delta
    expect(article.content.it.body1).not.toContain('6.257211538461538'); // no raw floats (original bug report)
  });

  it('shows a per-row week-over-week delta in the ranking table', () => {
    const article = buildBorderWaitRankingArticle({ ranking, trend, funFacts, weekStart, weekEnd, movers, todayIso: '2026-07-03' });
    expect(article.content.it.body2).toContain('−4 min'); // trend[BORDER_WAIT_CROSSINGS[0]] deltaMinutes -4
    expect(article.content.it.body2).toContain('+6 min'); // trend[BORDER_WAIT_CROSSINGS[1]] deltaMinutes 6
  });

  it('falls back to a no-data message when fewer than 2 ranked crossings exist', () => {
    const article = buildBorderWaitRankingArticle({
      ranking: [ranking[0]],
      trend: {},
      funFacts: null,
      todayIso: '2026-07-03',
    });
    expect(article.content.it.body2).toBe('');
    expect(article.content.it.body4).toBe('');
    expect(article.content.en.body1.toLowerCase()).toMatch(/not enough data/);
  });

  it('does not crash and omits the delta column when trend has no deltaMinutes', () => {
    const article = buildBorderWaitRankingArticle({
      ranking,
      trend: { [BORDER_WAIT_CROSSINGS[0]]: { direction: 'better' } },
      funFacts,
      todayIso: '2026-07-03',
    });
    expect(article.content.it.body2).toContain('|'); // still renders a table
    expect(article.content.it.body2).not.toMatch(/NaN/);
  });
});
