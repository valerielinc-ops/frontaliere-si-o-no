import { firstParsableMs } from './firstParsableDate';

export const CATEGORY_LISTING_PAGE_SIZE = 30;
export const CATEGORY_LISTING_MAX_PAGES = 10;

type CategoryListingOrderFields = {
  crawledAt?: unknown;
  datePosted?: unknown;
  id?: unknown;
  qualityScore?: number | null;
  slug?: unknown;
};

export function compareCategoryListingJobs<T extends CategoryListingOrderFields>(a: T, b: T): number {
  const da = firstParsableMs(b.crawledAt, b.datePosted);
  const db = firstParsableMs(a.crawledAt, a.datePosted);
  if (da !== db) return da - db;
  const qualityDifference = (b.qualityScore ?? 0) - (a.qualityScore ?? 0);
  if (qualityDifference !== 0) return qualityDifference;
  return String(a.id || a.slug || '').localeCompare(String(b.id || b.slug || ''));
}

export function sortCategoryListingJobs<T extends CategoryListingOrderFields>(jobs: readonly T[]): T[] {
  return [...jobs].sort(compareCategoryListingJobs);
}
