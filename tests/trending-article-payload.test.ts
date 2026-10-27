import { describe, expect, it } from 'vitest';
import { normalizeTrendingArticleEntries } from '@/services/trendingArticlePayload';

describe('normalizeTrendingArticleEntries', () => {
  it('keeps valid entries and drops malformed rows', () => {
    expect(normalizeTrendingArticleEntries([
      null,
      { id: 'valid', views: 3, lastViewed: 1_700_000_000_000 },
      { id: 'bad-views', views: '3', lastViewed: 1_700_000_000_000 },
      { id: 'bad-date', views: 2, lastViewed: Number.POSITIVE_INFINITY },
      { id: '', views: 4, lastViewed: 1_700_000_000_000 },
    ])).toEqual([{ id: 'valid', views: 3, lastViewed: 1_700_000_000_000 }]);
  });

  it('returns an empty list for non-array payloads', () => {
    expect(normalizeTrendingArticleEntries({ entries: [] })).toEqual([]);
  });
});
