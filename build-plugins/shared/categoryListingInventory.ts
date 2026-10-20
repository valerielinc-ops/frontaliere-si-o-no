import { firstParsableMs } from './firstParsableDate';

export const CATEGORY_LISTING_PAGE_SIZE = 30;
export const CATEGORY_LISTING_MAX_PAGES = 10;

type CategoryListingOrderFields = {
  crawledAt?: unknown;
  datePosted?: unknown;
  qualityScore?: number | null;
};

export function compareCategoryListingJobs<T extends CategoryListingOrderFields>(a: T, b: T): number {
  const da = firstParsableMs(b.crawledAt, b.datePosted);
  const db = firstParsableMs(a.crawledAt, a.datePosted);
  if (da !== db) return da - db;
  return (b.qualityScore ?? 0) - (a.qualityScore ?? 0);
}

export function sortCategoryListingJobs<T extends CategoryListingOrderFields>(jobs: readonly T[]): T[] {
  return [...jobs].sort(compareCategoryListingJobs);
}
