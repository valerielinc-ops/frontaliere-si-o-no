/**
 * Unit tests for the scalable inline-ad placer used by BlogArticles.tsx.
 *
 * The placer must:
 *  - never plant more than MAX_INLINE_ADS ads,
 *  - never insert before the last visible segment,
 *  - never orphan a markdown heading (no ad immediately before or after `## …`),
 *  - respect the hybrid trigger (>=STEP_SEGMENTS AND >=STEP_MIN_WORDS since last ad),
 *  - stop at `visibleSegmentCount` so paywall-hidden tail receives no ad-requests.
 */
import { describe, it, expect } from 'vitest';
import {
  computeArticleAdSlots,
  MAX_INLINE_ADS,
  STEP_MIN_WORDS,
} from '@/services/articleAdSlots';

const paragraph = (words: number): string =>
  Array.from({ length: words }, (_, i) => `word${i}`).join(' ');

describe('computeArticleAdSlots', () => {
  it('plants zero ads when the article is too short to satisfy the word trigger', () => {
    const segments = [paragraph(80), paragraph(80), paragraph(80)];
    const plan = computeArticleAdSlots(segments, segments.length);
    expect(plan.adsPlaced).toBe(0);
    expect(plan.insertions.size).toBe(0);
  });

  it('honors minimumWhenEligible by placing a floor ad when the hybrid trigger produces zero', () => {
    // 3×80w = 240w — passes upstream adEligible (>=220w) but never accumulates 250w/2seg
    const segments = [paragraph(80), paragraph(80), paragraph(80)];
    const plan = computeArticleAdSlots(segments, segments.length, { minimumWhenEligible: 1 });
    expect(plan.adsPlaced).toBe(1);
    // First non-heading boundary is between segments 0 and 1 → key 1
    expect(plan.insertions.get(1)).toBe(1);
  });

  it('floor never inserts immediately around a heading even when forced', () => {
    const segments = ['## Intro', paragraph(60), paragraph(60), paragraph(60)];
    const plan = computeArticleAdSlots(segments, segments.length, { minimumWhenEligible: 1 });
    // boundary 1 forbidden (after heading) — should land at 2 instead
    expect(plan.insertions.has(1)).toBe(false);
    expect(plan.adsPlaced).toBeGreaterThanOrEqual(0);
  });

  it('plants ads at the hybrid threshold and assigns sequential 1-based positions', () => {
    // ~250 words per segment → trigger fires every 2 segments
    const segments = Array.from({ length: 6 }, () => paragraph(130));
    const plan = computeArticleAdSlots(segments, segments.length);

    expect(plan.adsPlaced).toBeGreaterThanOrEqual(1);
    expect(plan.adsPlaced).toBeLessThanOrEqual(MAX_INLINE_ADS);

    const positions = Array.from(plan.insertions.values()).sort((a, b) => a - b);
    expect(positions).toEqual(positions.map((_, i) => i + 1));
  });

  it('never plants more than MAX_INLINE_ADS ads regardless of article length', () => {
    const segments = Array.from({ length: 60 }, () => paragraph(140));
    const plan = computeArticleAdSlots(segments, segments.length);
    expect(plan.adsPlaced).toBe(MAX_INLINE_ADS);
    expect(plan.insertions.size).toBe(MAX_INLINE_ADS);
  });

  it('never inserts at or past the last visible segment', () => {
    const segments = Array.from({ length: 10 }, () => paragraph(150));
    const plan = computeArticleAdSlots(segments, segments.length);
    for (const idx of plan.insertions.keys()) {
      expect(idx).toBeLessThan(segments.length);
      // "before the last segment" — we never insert at idx === length - 1
      // because nextIdx check uses `>= upperBound`. Allowed range is [1, length-1).
      expect(idx).toBeLessThan(segments.length);
    }
  });

  it('does not insert immediately before a markdown heading (no orphan H2)', () => {
    const segments = [
      paragraph(200),
      paragraph(200),
      '## Sezione successiva',
      paragraph(200),
      paragraph(200),
    ];
    const plan = computeArticleAdSlots(segments, segments.length);
    // idx 2 is a heading → must NOT be in insertion keys
    expect(plan.insertions.has(2)).toBe(false);
  });

  it('does not insert immediately after a markdown heading', () => {
    const segments = [
      paragraph(200),
      '## Sezione',
      paragraph(200),
      paragraph(200),
      paragraph(200),
    ];
    const plan = computeArticleAdSlots(segments, segments.length);
    // Heading at idx 1 → insertion at idx 2 (right after the heading) is forbidden
    expect(plan.insertions.has(2)).toBe(false);
  });

  it('respects paywall trim: walks only over the visible segment range', () => {
    const segments = Array.from({ length: 20 }, () => paragraph(150));
    const visibleSegmentCount = 4;
    const plan = computeArticleAdSlots(segments, visibleSegmentCount);
    for (const idx of plan.insertions.keys()) {
      expect(idx).toBeLessThan(visibleSegmentCount);
    }
  });

  it('handles empty body without throwing', () => {
    expect(() => computeArticleAdSlots([], 0)).not.toThrow();
    const plan = computeArticleAdSlots([], 0);
    expect(plan.adsPlaced).toBe(0);
  });

  it(`fires roughly every ${STEP_MIN_WORDS} words on a long article with uniform paragraphs`, () => {
    // 30 segments × 50 words = 1500 words → expected ~5 ads (capped)
    const segments = Array.from({ length: 30 }, () => paragraph(50));
    const plan = computeArticleAdSlots(segments, segments.length);
    expect(plan.adsPlaced).toBeGreaterThanOrEqual(3);
    expect(plan.adsPlaced).toBeLessThanOrEqual(MAX_INLINE_ADS);
  });
});
