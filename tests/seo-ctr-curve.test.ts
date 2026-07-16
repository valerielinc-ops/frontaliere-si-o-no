import { describe, it, expect } from 'vitest';
import {
  expectedCtrForPosition,
  ctrGapRatio,
  aggregateFamilyRows,
  SEO_CTR_FAMILIES,
} from '../scripts/lib/seo-ctr-curve.mjs';

describe('seo-ctr-curve (issue #4300)', () => {
  describe('expectedCtrForPosition', () => {
    it('returns the position-1 CTR for position 1', () => {
      expect(expectedCtrForPosition(1)).toBe(0.316);
    });

    it('returns the tail CTR beyond position 20', () => {
      expect(expectedCtrForPosition(25)).toBe(0.006);
    });

    it('rounds fractional positions to the nearest integer bucket', () => {
      expect(expectedCtrForPosition(7.4)).toBe(expectedCtrForPosition(7));
    });

    it('clamps non-finite / sub-1 positions to position 1', () => {
      expect(expectedCtrForPosition(0)).toBe(expectedCtrForPosition(1));
      expect(expectedCtrForPosition(NaN)).toBe(expectedCtrForPosition(1));
    });
  });

  describe('ctrGapRatio', () => {
    it('returns >1 when actual CTR beats the position curve', () => {
      const ratio = ctrGapRatio(0.5, 1); // expected @ pos1 = 0.316
      expect(ratio).toBeGreaterThan(1);
    });

    it('returns <1 when actual CTR underperforms the position curve', () => {
      const ratio = ctrGapRatio(0.01, 1);
      expect(ratio).toBeLessThan(1);
    });
  });

  describe('SEO_CTR_FAMILIES', () => {
    it('has the 3 monitored families from the issue with their target CTRs', () => {
      const byId = Object.fromEntries(SEO_CTR_FAMILIES.map((f) => [f.id, f]));
      expect(byId['articoli-frontaliere'].targetCtr).toBe(0.03);
      expect(byId['guida-frontaliere'].targetCtr).toBe(0.035);
      expect(byId['tasse-e-pensione'].targetCtr).toBe(0.03);
      expect(byId['articoli-frontaliere'].monitored).toBe(true);
      expect(byId['guida-frontaliere'].monitored).toBe(true);
      expect(byId['tasse-e-pensione'].monitored).toBe(true);
    });

    it('marks the 2 reference families as report-only (unmonitored, no target)', () => {
      const byId = Object.fromEntries(SEO_CTR_FAMILIES.map((f) => [f.id, f]));
      expect(byId['de'].monitored).toBe(false);
      expect(byId['de'].targetCtr).toBeNull();
      expect(byId['cerca-lavoro-ticino'].monitored).toBe(false);
      expect(byId['cerca-lavoro-ticino'].targetCtr).toBeNull();
    });
  });

  describe('aggregateFamilyRows', () => {
    const rows = [
      { path: '/a', clicks: 10, impressions: 200, position: 3, ctr: 0.05 },
      { path: '/b', clicks: 1, impressions: 100, position: 5, ctr: 0.01 }, // well below curve
      { path: '/c', clicks: 2, impressions: 10, position: 2, ctr: 0.2 }, // below minImpressions, excluded
    ];

    it('filters rows below minImpressions and aggregates the rest', () => {
      const agg = aggregateFamilyRows(rows, { minImpressions: 20 });
      expect(agg.pageCount).toBe(2);
      expect(agg.totalClicks).toBe(11);
      expect(agg.totalImpressions).toBe(300);
      expect(agg.avgCtr).toBeCloseTo(11 / 300, 6);
    });

    it('computes an impressions-weighted average position', () => {
      const agg = aggregateFamilyRows(rows, { minImpressions: 20 });
      const expected = (3 * 200 + 5 * 100) / 300;
      expect(agg.avgPosition).toBeCloseTo(expected, 6);
    });

    it('flags pages whose CTR falls below underperformRatio × expected-for-position', () => {
      // Expected CTR @ position 3 ≈ 0.106: /healthy sits well above it,
      // /weak sits well below it (ratio < 0.6) and should be the only flag.
      const flagRows = [
        { path: '/healthy', clicks: 30, impressions: 200, position: 3, ctr: 0.15 },
        { path: '/weak', clicks: 1, impressions: 100, position: 3, ctr: 0.01 },
      ];
      const agg = aggregateFamilyRows(flagRows, { minImpressions: 20, underperformRatio: 0.6 });
      expect(agg.belowCurveCount).toBe(1);
      expect(agg.belowCurvePages[0].path).toBe('/weak');
    });

    it('returns null avgCtr/avgPosition and zero counts for an empty/all-filtered input', () => {
      const agg = aggregateFamilyRows([], { minImpressions: 20 });
      expect(agg.pageCount).toBe(0);
      expect(agg.totalClicks).toBe(0);
      expect(agg.totalImpressions).toBe(0);
      expect(agg.avgCtr).toBeNull();
      expect(agg.avgPosition).toBeNull();
      expect(agg.belowCurveCount).toBe(0);
    });
  });
});
