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

  it('uses recently-published pool when every top-viewed is excluded', () => {
    const top = [
      { id: 'a', views: 100, lastViewed: daysAgo(10) },
      { id: 'b', views: 90, lastViewed: daysAgo(20) },
    ];
    const recentlyPublished = ['new-1', 'new-2'];
    const pick = selectFeaturedArticleId(top, ['a', 'b'], alwaysHasMeta, NOW, recentlyPublished);
    expect(pick).toEqual({ id: 'new-1', reason: 'recent-publication' });
  });

  it('skips recently-published articles already in the exclude list', () => {
    const top = [
      { id: 'a', views: 100, lastViewed: daysAgo(10) },
    ];
    const recentlyPublished = ['new-1', 'new-2'];
    const pick = selectFeaturedArticleId(top, ['a', 'new-1'], alwaysHasMeta, NOW, recentlyPublished);
    expect(pick).toEqual({ id: 'new-2', reason: 'recent-publication' });
  });

  it('skips recently-published articles without blog meta', () => {
    const top = [
      { id: 'a', views: 100, lastViewed: daysAgo(10) },
    ];
    const recentlyPublished = ['has-no-meta', 'has-meta'];
    const hasMeta = (id: string) => id === 'has-meta' || id === 'a';
    const pick = selectFeaturedArticleId(top, ['a'], hasMeta, NOW, recentlyPublished);
    expect(pick).toEqual({ id: 'has-meta', reason: 'recent-publication' });
  });

  it('marks reason=rotation-exhausted only when top-viewed AND recently-published are all in exclude', () => {
    const top = [
      { id: 'a', views: 100, lastViewed: daysAgo(10) },
      { id: 'b', views: 90, lastViewed: daysAgo(20) },
    ];
    const pick = selectFeaturedArticleId(top, ['a', 'b'], alwaysHasMeta, NOW, []);
    expect(pick.reason).toBe('rotation-exhausted');
    expect(['a', 'b']).toContain(pick.id);
  });

  it('exhausted fallback picks the LEAST recently featured, not the all-time #1', () => {
    const top = [
      { id: 'a', views: 200, lastViewed: daysAgo(2) }, // featured last week (idx 0)
      { id: 'b', views: 150, lastViewed: daysAgo(8) }, // featured 5 weeks ago (idx 4)
      { id: 'c', views: 120, lastViewed: daysAgo(10) }, // featured 2 weeks ago (idx 1)
    ];
    // recentlyFeatured ordered most-recent first: [a, c, ..., b]
    const recentlyFeatured = ['a', 'c', 'x', 'y', 'b'];
    const pick = selectFeaturedArticleId(top, recentlyFeatured, alwaysHasMeta, NOW, []);
    expect(pick).toEqual({ id: 'b', reason: 'rotation-exhausted' });
  });

  it('exhausted fallback prefers a never-featured top article over any reused one', () => {
    const top = [
      { id: 'a', views: 200, lastViewed: daysAgo(2) },
      { id: 'b', views: 150, lastViewed: daysAgo(8) },
      { id: 'unseen', views: 50, lastViewed: daysAgo(50) },
    ];
    const recentlyFeatured = ['a', 'b'];
    // 'unseen' is in top-viewed but never featured AND not in recentlyPublished.
    const pick = selectFeaturedArticleId(top, recentlyFeatured, alwaysHasMeta, NOW, []);
    // With no recentlyPublished pool, 'unseen' should still come out as fresh
    // because it isn't in the exclude list.
    expect(pick).toEqual({ id: 'unseen', reason: 'fresh' });
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

  // ── Evergreen penalty (opt-in via `getPublishedAt`) ──────────────────────
  describe('evergreen penalty', () => {
    it('prefers a fresh-published article over a high-view evergreen', () => {
      const top = [
        { id: 'evergreen', views: 200, lastViewed: daysAgo(2) },
        { id: 'fresh', views: 50, lastViewed: daysAgo(2) },
      ];
      const getPublishedAt = (id: string) => {
        if (id === 'evergreen') return new Date(NOW - 2 * 365 * 24 * 60 * 60 * 1000);
        if (id === 'fresh') return new Date(NOW - 30 * 24 * 60 * 60 * 1000);
        return null;
      };
      const pick = selectFeaturedArticleId(top, [], alwaysHasMeta, NOW, [], getPublishedAt);
      expect(pick).toEqual({ id: 'fresh', reason: 'fresh' });
    });

    it('treats unknown publish date as evergreen', () => {
      const top = [
        { id: 'legacy', views: 200, lastViewed: daysAgo(2) }, // no publishedAt
        { id: 'recent', views: 50, lastViewed: daysAgo(2) },
      ];
      const getPublishedAt = (id: string) =>
        id === 'recent' ? new Date(NOW - 30 * 24 * 60 * 60 * 1000) : null;
      const pick = selectFeaturedArticleId(top, [], alwaysHasMeta, NOW, [], getPublishedAt);
      expect(pick).toEqual({ id: 'recent', reason: 'fresh' });
    });

    it('falls back to evergreen when no fresh-published alternative qualifies', () => {
      const top = [
        { id: 'evergreen', views: 200, lastViewed: daysAgo(2) },
      ];
      const getPublishedAt = () => new Date(NOW - 2 * 365 * 24 * 60 * 60 * 1000);
      const pick = selectFeaturedArticleId(top, [], alwaysHasMeta, NOW, [], getPublishedAt);
      expect(pick).toEqual({ id: 'evergreen', reason: 'fresh-evergreen' });
    });

    it('prefers recently-published over evergreen fallback', () => {
      // The user's actual bug: 'comuni-migliori-frontalieri' (evergreen) kept
      // winning over fresh news articles purely on accumulated views.
      const top = [
        { id: 'comuni-migliori-frontalieri', views: 52, lastViewed: daysAgo(2) },
      ];
      const recentlyPublished = ['ffs-riorganizza-traffico', 'svizzera-economia-2026'];
      const getPublishedAt = (id: string) => {
        if (id === 'comuni-migliori-frontalieri') return null; // legacy
        if (id === 'ffs-riorganizza-traffico') return new Date(NOW - 1 * 24 * 60 * 60 * 1000);
        if (id === 'svizzera-economia-2026') return new Date(NOW - 2 * 24 * 60 * 60 * 1000);
        return null;
      };
      const pick = selectFeaturedArticleId(
        top, [], alwaysHasMeta, NOW, recentlyPublished, getPublishedAt,
      );
      expect(pick).toEqual({ id: 'ffs-riorganizza-traffico', reason: 'recent-publication' });
    });

    it('back-compat: existing callers (no getPublishedAt) keep old behaviour', () => {
      // Tests passing 5 args (no getter) should not see evergreen penalty.
      const top = [
        { id: 'a', views: 100, lastViewed: daysAgo(2) }, // would be evergreen if checked
        { id: 'b', views: 50, lastViewed: daysAgo(2) },
      ];
      const pick = selectFeaturedArticleId(top, [], alwaysHasMeta, NOW);
      expect(pick).toEqual({ id: 'a', reason: 'fresh' });
    });
  });
});
