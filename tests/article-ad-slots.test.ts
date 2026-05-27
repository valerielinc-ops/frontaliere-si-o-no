/**
 * Unit tests for the inter-segment inline-ad placer used by BlogArticles.tsx.
 *
 * Strategy (2026-05-19, post-auth-gate removal):
 *  - plant one ad before every segment after the first,
 *  - stop at `visibleSegmentCount` (defensive — paywall is gone but the API
 *    still accepts the param so existing callers don't need touching),
 *  - never throw on empty input.
 *
 * Per-paragraph in-body ads are tested via BlogArticles render tests; this file
 * only covers the inter-segment fallback.
 */
import { describe, it, expect } from 'vitest';
import {
  computeArticleAdSlots,
  MAX_INLINE_ADS,
  STEP_MIN_WORDS,
  STEP_SEGMENTS,
} from '@/services/articleAdSlots';

const paragraph = (words: number): string =>
  Array.from({ length: words }, (_, i) => `word${i}`).join(' ');

describe('computeArticleAdSlots — max-density inter-segment placer', () => {
  it('exposes max-density tuning constants', () => {
    expect(STEP_SEGMENTS).toBe(1);
    expect(STEP_MIN_WORDS).toBe(0);
    expect(MAX_INLINE_ADS).toBeGreaterThan(1000);
  });

  it('plants no ads for a single-segment article', () => {
    const plan = computeArticleAdSlots([paragraph(200)], 1);
    expect(plan.adsPlaced).toBe(0);
    expect(plan.insertions.size).toBe(0);
  });

  it('plants n-1 ads for an n-segment article (one before every segment after the first)', () => {
    const segments = Array.from({ length: 6 }, () => paragraph(80));
    const plan = computeArticleAdSlots(segments, segments.length);
    expect(plan.adsPlaced).toBe(segments.length - 1);
    expect(plan.insertions.size).toBe(segments.length - 1);
    for (let i = 1; i < segments.length; i += 1) {
      expect(plan.insertions.has(i)).toBe(true);
    }
  });

  it('assigns sequential 1-based positions in segment order', () => {
    const segments = Array.from({ length: 5 }, () => paragraph(80));
    const plan = computeArticleAdSlots(segments, segments.length);
    const positions = Array.from(plan.insertions.entries()).sort(([a], [b]) => a - b).map(([, p]) => p);
    expect(positions).toEqual([1, 2, 3, 4]);
  });

  it('does not insert at or past visibleSegmentCount (defensive bound)', () => {
    const segments = Array.from({ length: 20 }, () => paragraph(150));
    const plan = computeArticleAdSlots(segments, 4);
    for (const idx of plan.insertions.keys()) {
      expect(idx).toBeLessThan(4);
    }
  });

  it('handles empty body without throwing', () => {
    expect(() => computeArticleAdSlots([], 0)).not.toThrow();
    const plan = computeArticleAdSlots([], 0);
    expect(plan.adsPlaced).toBe(0);
  });

  it('ignores legacy minimumWhenEligible (no-op)', () => {
    const segments = Array.from({ length: 3 }, () => paragraph(80));
    const planFloor = computeArticleAdSlots(segments, segments.length, { minimumWhenEligible: 1 });
    const planNoFloor = computeArticleAdSlots(segments, segments.length);
    expect(planFloor.adsPlaced).toBe(planNoFloor.adsPlaced);
  });
});
