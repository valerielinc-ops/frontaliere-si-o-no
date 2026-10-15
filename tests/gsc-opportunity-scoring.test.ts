import { describe, expect, it } from 'vitest';
import {
  computeCtrGaps,
  computeOpportunityScore,
  computePositionOpportunity,
  rankPageOpportunities,
} from '../scripts/lib/gsc-opportunity-scoring.mjs';

describe('gsc-opportunity-scoring', () => {
  it('computePositionOpportunity ramps toward 1 near position 4 and is 0 outside [4,20]', () => {
    expect(computePositionOpportunity(1)).toBe(0);
    expect(computePositionOpportunity(4)).toBe(1);
    expect(computePositionOpportunity(20)).toBe(0);
    expect(computePositionOpportunity(21)).toBe(0);
    expect(computePositionOpportunity(12)).toBeCloseTo(0.5, 5);
  });

  it('computeCtrGaps flags a page well below its position-peer median CTR', () => {
    const pages = [
      { page: '/a', ctr: 1, position: 8 },
      { page: '/b', ctr: 5, position: 9 },
      { page: '/c', ctr: 6, position: 7 },
      { page: '/d', ctr: 5.5, position: 10 },
    ];
    const withGaps = computeCtrGaps(pages);
    const a = withGaps.find((p) => p.page === '/a');
    const c = withGaps.find((p) => p.page === '/c');
    expect(a.ctrGap).toBeGreaterThan(0.5);
    expect(c.ctrGap).toBe(0);
    expect(withGaps.every((p) => p.ctrGapLowConfidence === false)).toBe(true);
  });

  it('computeCtrGaps widens the peer band to +/-10 (not the whole dataset) when +/-3 has fewer than 3 peers, and flags low confidence', () => {
    const pages = [
      { page: '/target', ctr: 1, position: 10 },
      // only 1 peer within +/-3 (position 12), but 3 more appear within +/-10
      { page: '/near', ctr: 6, position: 12 },
      { page: '/mid1', ctr: 6, position: 18 },
      { page: '/mid2', ctr: 6, position: 19 },
      { page: '/mid3', ctr: 6, position: 20 },
      // a distant outlier that must NOT be pulled in once the wide band suffices
      { page: '/far', ctr: 0.1, position: 90 },
    ];
    const withGaps = computeCtrGaps(pages);
    const target = withGaps.find((p) => p.page === '/target');
    expect(target.ctrGapLowConfidence).toBe(true);
    expect(target.peerMedianCtr).toBe(6);
  });

  it('computeOpportunityScore combines the five weighted signals and clamps out-of-range inputs', () => {
    const { score } = computeOpportunityScore({
      impressions: 1000,
      maxImpressions: 1000,
      ctrGap: 1,
      position: 4,
      businessValue: 1,
      contentGapConfidence: 1,
    });
    expect(score).toBe(1);

    const zero = computeOpportunityScore({ impressions: 0, maxImpressions: 1000, ctrGap: 0, position: 1, businessValue: 0, contentGapConfidence: 0 });
    expect(zero.score).toBe(0);

    const clamped = computeOpportunityScore({ impressions: 1000, maxImpressions: 1000, ctrGap: 5, position: 4, businessValue: -2, contentGapConfidence: 0.5 });
    expect(clamped.score).toBeLessThanOrEqual(1);
  });

  it('rankPageOpportunities sorts by score and applies weight overrides by path prefix', () => {
    const pages = [
      { page: '/guida-frontaliere/permesso-g', impressions: 500, ctr: 1, position: 8 },
      { page: '/articoli-frontaliere/foo', impressions: 500, ctr: 5, position: 8 },
    ];
    const ranked = rankPageOpportunities(pages);
    expect(ranked[0].page).toBe('/guida-frontaliere/permesso-g');
    expect(ranked.every((p) => typeof p.opportunityScore === 'number')).toBe(true);

    const weighted = rankPageOpportunities(pages, { weights: { '/articoli-frontaliere': 1 } });
    const article = weighted.find((p) => p.page === '/articoli-frontaliere/foo');
    expect(article.businessValue).toBe(1);
  });
});
