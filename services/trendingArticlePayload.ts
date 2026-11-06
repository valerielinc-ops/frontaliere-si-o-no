export interface TrendingArticleEntry {
  id: string;
  views: number;
  lastViewed: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Keep valid records from a remote/cache trending payload and drop bad rows. */
export function normalizeTrendingArticleEntries(value: unknown): TrendingArticleEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): TrendingArticleEntry[] => {
    if (!isRecord(entry)
      || typeof entry.id !== 'string'
      || !entry.id.trim()
      || typeof entry.views !== 'number'
      || !Number.isFinite(entry.views)
      || entry.views < 0
      || typeof entry.lastViewed !== 'number'
      || !Number.isFinite(entry.lastViewed)
      || entry.lastViewed < 0) return [];
    return [{ id: entry.id, views: entry.views, lastViewed: entry.lastViewed }];
  });
}
