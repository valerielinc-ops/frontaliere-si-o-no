import { describe, it, expect } from 'vitest';
import {
  INTERESTS,
  CONTENT_STRATEGIES,
  inferInterest,
  contentStrategyForLevel,
  describeSegment,
  resolveSegment,
  summarizeSegments,
  selectWinnerCandidates,
  selectArticleCandidates,
} from '../services/newsletter-segments.mjs';

function makeSub(overrides = {}) {
  return {
    email: 'x@example.com',
    engagementLevel: 'dormant',
    sourceRouteFamily: null,
    sourceComponent: null,
    ...overrides,
  };
}

describe('inferInterest', () => {
  it('reads jobs interest from a job-board source component', () => {
    expect(inferInterest(makeSub({ sourceComponent: 'JobBoard' }))).toBe(INTERESTS.JOBS);
  });

  it('reads utility interest from the tax-calendar component', () => {
    expect(inferInterest(makeSub({ sourceComponent: 'TaxCalendar' }))).toBe(INTERESTS.UTILITY);
  });

  it('falls back to route family when no component is set', () => {
    expect(inferInterest(makeSub({ sourceRouteFamily: 'job_detail' }))).toBe(INTERESTS.JOBS);
    expect(inferInterest(makeSub({ sourceRouteFamily: 'article_detail' }))).toBe(INTERESTS.ARTICLES);
    expect(inferInterest(makeSub({ sourceRouteFamily: 'tax' }))).toBe(INTERESTS.UTILITY);
  });

  it('prefers component over route family when both are present', () => {
    expect(inferInterest(makeSub({ sourceComponent: 'JobBoard', sourceRouteFamily: 'article_detail' }))).toBe(INTERESTS.JOBS);
  });

  it('falls back to legacy job-alert fields for subscribers acquired before route tracking', () => {
    expect(inferInterest(makeSub({ job_slug: 'some-job' }))).toBe(INTERESTS.JOBS);
    expect(inferInterest(makeSub({ job_search_query: 'infermiere' }))).toBe(INTERESTS.JOBS);
  });

  it('defaults to general when no signal is available', () => {
    expect(inferInterest(makeSub())).toBe(INTERESTS.GENERAL);
  });
});

describe('contentStrategyForLevel', () => {
  it('routes hot/warm to novelty_interest', () => {
    expect(contentStrategyForLevel('hot')).toBe(CONTENT_STRATEGIES.NOVELTY_INTEREST);
    expect(contentStrategyForLevel('warm')).toBe(CONTENT_STRATEGIES.NOVELTY_INTEREST);
  });

  it('routes cool/cold to digest', () => {
    expect(contentStrategyForLevel('cool')).toBe(CONTENT_STRATEGIES.DIGEST);
    expect(contentStrategyForLevel('cold')).toBe(CONTENT_STRATEGIES.DIGEST);
  });

  it('routes dormant to winback', () => {
    expect(contentStrategyForLevel('dormant')).toBe(CONTENT_STRATEGIES.WINBACK);
  });

  it('treats an unknown/missing level as digest-safe dormant→ no, defaults conservatively to dormant/winback', () => {
    // Unknown levels normalize to 'dormant' (see normalizeLevel) so an
    // unrecognized value never accidentally gets the "everyone" digest.
    expect(contentStrategyForLevel('bogus')).toBe(CONTENT_STRATEGIES.WINBACK);
    expect(contentStrategyForLevel(undefined)).toBe(CONTENT_STRATEGIES.WINBACK);
  });
});

describe('describeSegment / resolveSegment', () => {
  it('builds a level_interest segment id for hot/warm subscribers', () => {
    const seg = describeSegment(makeSub({ engagementLevel: 'hot', sourceComponent: 'JobBoard' }));
    expect(seg).toEqual({ segmentId: 'hot_jobs', strategy: 'novelty_interest', interest: 'jobs', level: 'hot' });
    expect(resolveSegment(makeSub({ engagementLevel: 'hot', sourceComponent: 'JobBoard' }))).toBe('hot_jobs');
  });

  it('collapses cool/cold into the flat "digest" segment', () => {
    expect(resolveSegment(makeSub({ engagementLevel: 'cool' }))).toBe('digest');
    expect(resolveSegment(makeSub({ engagementLevel: 'cold' }))).toBe('digest');
  });

  it('collapses dormant into the flat "dormant" segment', () => {
    expect(resolveSegment(makeSub({ engagementLevel: 'dormant' }))).toBe('dormant');
  });

  it('defaults a missing engagementLevel to dormant (never crashes)', () => {
    expect(resolveSegment({ email: 'x@example.com' })).toBe('dormant');
  });
});

describe('summarizeSegments', () => {
  it('counts subscribers per segment, sorted descending', () => {
    const subs = [
      makeSub({ engagementLevel: 'hot', sourceComponent: 'JobBoard' }),
      makeSub({ engagementLevel: 'hot', sourceComponent: 'JobBoard' }),
      makeSub({ engagementLevel: 'warm', sourceRouteFamily: 'article_detail' }),
      makeSub({ engagementLevel: 'cool' }),
      makeSub({ engagementLevel: 'dormant' }),
    ];
    expect(summarizeSegments(subs)).toEqual({
      hot_jobs: 2,
      warm_articles: 1,
      digest: 1,
      dormant: 1,
    });
  });

  it('handles an empty list', () => {
    expect(summarizeSegments([])).toEqual({});
  });

  it('preserves the total subscriber count across all segments', () => {
    const subs = Array.from({ length: 37 }, (_, i) =>
      makeSub({ engagementLevel: ['hot', 'warm', 'cool', 'cold', 'dormant'][i % 5] }),
    );
    const summary = summarizeSegments(subs);
    const total = Object.values(summary).reduce((a, b) => a + b, 0);
    expect(total).toBe(37);
  });
});

const WINNERS = [
  { slug: 'a-pratico', cluster: 'pratico', score: 10 },
  { slug: 'b-fiscale', cluster: 'fiscale', score: 9 },
  { slug: 'c-novita', cluster: 'novita', score: 15 },
  { slug: 'd-lavoro', cluster: 'lavoro', score: 5 },
  { slug: 'e-generic', cluster: 'generic', score: 20 },
  { slug: 'f-mobilita', cluster: 'mobilita', score: 3 },
];

describe('selectWinnerCandidates', () => {
  it('excludes the generic cluster by default', () => {
    const slugs = selectWinnerCandidates(INTERESTS.GENERAL, WINNERS);
    expect(slugs).not.toContain('e-generic');
  });

  it('ranks preferred-cluster winners ahead of the rest, each internally by score', () => {
    const slugs = selectWinnerCandidates(INTERESTS.JOBS, WINNERS);
    // jobs prefers lavoro/pratico
    expect(slugs.slice(0, 2)).toEqual(['a-pratico', 'd-lavoro']);
  });

  it('falls back to score-only ranking when the interest has no cluster preference', () => {
    const slugs = selectWinnerCandidates(INTERESTS.GENERAL, WINNERS);
    expect(slugs[0]).toBe('c-novita'); // highest score among non-generic
  });

  it('respects the limit option', () => {
    expect(selectWinnerCandidates(INTERESTS.GENERAL, WINNERS, { limit: 2 })).toHaveLength(2);
  });

  it('handles an empty winners array', () => {
    expect(selectWinnerCandidates(INTERESTS.JOBS, [])).toEqual([]);
  });
});

describe('selectArticleCandidates', () => {
  it('picks a single-mode candidate list for hot/warm (novelty_interest)', () => {
    const result = selectArticleCandidates(makeSub({ engagementLevel: 'hot', sourceComponent: 'JobBoard' }), WINNERS);
    expect(result.mode).toBe('single');
    expect(result.slugs.length).toBeGreaterThan(0);
  });

  it('picks a digest-mode candidate list for cool/cold', () => {
    const result = selectArticleCandidates(makeSub({ engagementLevel: 'cool' }), WINNERS, { digestLimit: 3 });
    expect(result.mode).toBe('digest');
    expect(result.slugs).toHaveLength(3);
    expect(result.slugs).not.toContain('e-generic');
  });

  it('returns mode "none" for dormant (handled by the separate win-back campaign)', () => {
    const result = selectArticleCandidates(makeSub({ engagementLevel: 'dormant' }), WINNERS);
    expect(result.mode).toBe('none');
    expect(result.slugs).toEqual([]);
  });

  it('also accepts a pre-computed segment descriptor instead of a raw subscriber', () => {
    const info = describeSegment(makeSub({ engagementLevel: 'warm', sourceRouteFamily: 'tax' }));
    const result = selectArticleCandidates(info, WINNERS);
    expect(result.mode).toBe('single');
  });
});
