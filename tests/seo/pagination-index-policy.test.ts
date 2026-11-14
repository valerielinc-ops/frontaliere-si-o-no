import { describe, expect, it } from 'vitest';
import {
  PAGINATION_NOINDEX_FROM_PAGE,
  isPaginationNoindex,
  isPaginationSitemapEligible,
  paginationPageFromPath,
  paginationRobots,
  pushPaginationSitemapEntry,
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

  it('rejects non-integer and non-first page inputs from the sitemap', () => {
    for (const page of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(isPaginationSitemapEligible(page), String(page)).toBe(false);
    }
  });

  it('keeps the sitemap mutation behind the same page policy', () => {
    const entries: string[] = [];

    expect(pushPaginationSitemapEntry(entries, 1, 'page-1')).toBe(true);
    expect(pushPaginationSitemapEntry(entries, 2, 'page-2')).toBe(false);
    expect(entries).toEqual(['page-1']);
  });

  it('reads the page number of every pagination segment the site emits', () => {
    expect(paginationPageFromPath('/prezzi-diesel/stazioni-italia/')).toBe(1);
    expect(paginationPageFromPath('/prezzi-diesel/stazioni-italia/page-6/')).toBe(6);
    expect(paginationPageFromPath('/cerca-lavoro-zurigo/pagina-25/')).toBe(25);
    expect(paginationPageFromPath('/de/jobs-zuerich/seite-11')).toBe(11);
    // A slug that merely contains the word is not a page.
    expect(paginationPageFromPath('/articoli-frontaliere/page-turner-guide/')).toBe(1);
  });

  it('rejects non-canonical and unsafe pagination numbers without making them page 1', () => {
    for (const path of [
      '/x/page-0/',
      '/x/page-01/',
      '/x/pagina-01/',
      '/x/seite-01/',
      '/x/page-9007199254740992/',
      '/x/pagina-9007199254740993/',
      '/x/seite-9007199254740993/',
    ]) {
      const page = paginationPageFromPath(path);
      expect(Number.isNaN(page), path).toBe(true);
      expect(isPaginationSitemapEligible(page), path).toBe(false);
    }
  });
});
