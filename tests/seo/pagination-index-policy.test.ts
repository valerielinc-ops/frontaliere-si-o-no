import { describe, expect, it } from 'vitest';
import {
  PAGINATION_NOINDEX_FROM_PAGE,
  isPaginationNoindex,
  isPaginationSitemapEligible,
  paginationRobots,
} from '../../build-plugins/shared/paginationIndexPolicy';

// P1 noindex plan (2026-10-24): one rule for every `/page-N/` listing the SSG
// emits — seo-hubs, cluster hub, plate-auction canton pages.
describe('paginationIndexPolicy', () => {
  it('keeps pages 1-10 indexable and ships 11+ as noindex,follow', () => {
    expect(PAGINATION_NOINDEX_FROM_PAGE).toBe(11);
    for (let page = 1; page <= 10; page++) {
      expect(isPaginationNoindex(page), String(page)).toBe(false);
      expect(paginationRobots(page)).toBe('index,follow');
    }
    for (const page of [11, 12, 99, 5011]) {
      expect(isPaginationNoindex(page), String(page)).toBe(true);
      expect(paginationRobots(page)).toBe('noindex,follow');
    }
  });

  it('never noindexes on a non-numeric page (fail towards the pre-P1 behaviour)', () => {
    expect(isPaginationNoindex(Number.NaN)).toBe(false);
    expect(paginationRobots(Number.NaN)).toBe('index,follow');
  });

  it('lists only page 1 of a listing in a sitemap', () => {
    expect(isPaginationSitemapEligible(1)).toBe(true);
    for (const page of [2, 5, 10, 11, 5011]) expect(isPaginationSitemapEligible(page), String(page)).toBe(false);
  });
});
