import { describe, expect, it } from 'vitest';

const { selectFeaturedArticleId } = await import('@/services/newsletter-article-rotation.mjs');

const NOW = new Date('2026-04-21T08:00:00Z').getTime();
const daysAgo = (n: number) => new Date(NOW - n * 24 * 60 * 60 * 1000);

const alwaysHasMeta = () => true;

describe('selectFeaturedArticleId', () => {
  it('picks highest-viewed article among recent when none excluded', () => {
    const top = [
      { id: 'a', views: 100, lastViewed: daysAgo(2) },
      { id: 'b', views: 50, lastViewed: daysAgo(1) },
    ];
    const pick = selectFeaturedArticleId(top, [], alwaysHasMeta, NOW);
    expect(pick).toEqual({ id: 'a', reason: 'fresh' });
  });

  it('excludes recently-featured articles (core rotation rule)', () => {
    const top = [
      { id: 'a', views: 100, lastViewed: daysAgo(2) },
      { id: 'b', views: 50, lastViewed: daysAgo(3) },
    ];
    const pick = selectFeaturedArticleId(top, ['a'], alwaysHasMeta, NOW);
    expect(pick).toEqual({ id: 'b', reason: 'fresh' });
  });

  // Regression test: the real-world bug that kept showing the same article.
  // When only ONE article had a recent view and it was already featured,
  // the "recent-only" filter collapsed candidates to [a], and the code
  // fell through to 'rotation-exhausted' reusing 'a' forever.
  it('falls back to all-time top when only recent article is already featured', () => {
    const top = [
      { id: 'a', views: 100, lastViewed: daysAgo(1) }, // only recent, excluded
      { id: 'b', views: 90, lastViewed: daysAgo(30) }, // older, not excluded
      { id: 'c', views: 80, lastViewed: daysAgo(40) },
    ];
    const pick = selectFeaturedArticleId(top, ['a'], alwaysHasMeta, NOW);
    expect(pick).toEqual({ id: 'b', reason: 'fresh' });
  });

  it('marks reason=rotation-exhausted only when every article is in the exclude list', () => {
    const top = [
      { id: 'a', views: 100, lastViewed: daysAgo(10) },
      { id: 'b', views: 90, lastViewed: daysAgo(20) },
    ];
    const pick = selectFeaturedArticleId(top, ['a', 'b'], alwaysHasMeta, NOW);
    expect(pick.reason).toBe('rotation-exhausted');
    expect(['a', 'b']).toContain(pick.id);
  });

  it('skips articles without blog meta', () => {
    const top = [
      { id: 'has-meta', views: 100, lastViewed: daysAgo(10) },
      { id: 'no-meta', views: 200, lastViewed: daysAgo(5) },
    ];
    const hasMeta = (id: string) => id === 'has-meta';
    const pick = selectFeaturedArticleId(top, [], hasMeta, NOW);
    expect(pick.id).toBe('has-meta');
  });

  it('returns null reason=no-top-articles for empty input', () => {
    expect(selectFeaturedArticleId([], [], alwaysHasMeta, NOW)).toEqual({
      id: null,
      reason: 'no-top-articles',
    });
  });

  it('breaks view ties by lastViewed desc', () => {
    const top = [
      { id: 'older', views: 50, lastViewed: daysAgo(5) },
      { id: 'newer', views: 50, lastViewed: daysAgo(1) },
    ];
    const pick = selectFeaturedArticleId(top, [], alwaysHasMeta, NOW);
    expect(pick.id).toBe('newer');
  });

  it('does not mutate the input array', () => {
    const top = [
      { id: 'a', views: 10, lastViewed: daysAgo(1) },
      { id: 'b', views: 100, lastViewed: daysAgo(1) },
    ];
    const before = top.map((a) => a.id);
    selectFeaturedArticleId(top, [], alwaysHasMeta, NOW);
    expect(top.map((a) => a.id)).toEqual(before);
  });
});
