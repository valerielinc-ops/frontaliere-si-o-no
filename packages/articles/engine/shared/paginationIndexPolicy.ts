// paginationIndexPolicy.ts
//
// One rule for every paginated listing the SSG emits (`/page-N/`,
// `/pagina-N/`, …), P1 noindex plan 2026-10-24:
//
//   - pages 1…10 stay `index,follow`: the first screens of a listing are what
//     a searcher lands on, and Google still uses them to discover items;
//   - page 11 onwards is `noindex,follow`: the page stays 200 and crawlable,
//     so the items it links keep their inbound path, but the deep tail of an
//     alphabetical/chronological list stops competing in the index;
//   - NO paginated page (2+) is listed in a sitemap. Page 1 is the listing's
//     canonical entry point; the others are reached through its own pager.
//
// Measured on the live sitemaps of 2026-10-23: 8 987 `page-N` URLs across
// sitemap-seo-hubs / -search-clusters / -plate-auctions / -jobs / -eventi /
// -fuel-indexes, 0.4 % of them with a Search Console impression in 90 days.
//
// Kept as a module, not a constant per plugin, because the same question
// ("may page N of a listing be indexed / listed?") is asked by several
// emitters and the answer must not drift between them. It sits in
// `packages/articles` so the article archive emitter of this package, which
// may not import from outside its folder, reads the same rule as the site's
// `emitSeoHubs` (the two must stay byte-identical, see
// tests/render-article-hub-pages-narrow-vs-full.test.ts); the site imports it
// through `build-plugins/shared/paginationIndexPolicy.ts`.

/** First page number that ships `noindex,follow`. */
export const PAGINATION_NOINDEX_FROM_PAGE = 11;

/** True when page `page` (1-based) of a listing must not be indexed. */
export function isPaginationNoindex(page: number): boolean {
  return Number.isFinite(page) && page >= PAGINATION_NOINDEX_FROM_PAGE;
}

/** The robots directive for page `page` (1-based) of a listing. */
export function paginationRobots(page: number): 'index,follow' | 'noindex,follow' {
  return isPaginationNoindex(page) ? 'noindex,follow' : 'index,follow';
}

/** Only the first page of a listing may appear in a sitemap. */
export function isPaginationSitemapEligible(page: number): boolean {
  return !(Number.isFinite(page) && page >= 2);
}

const PAGINATED_PATH_RE = /\/(?:page|pagina|seite)-(\d+)\/?$/;

/**
 * Page number of a listing URL path (`/x/page-7/` → 7, `/x/` → 1), for the
 * emitters that only hold the path when they write the sitemap. Accepts every
 * pagination segment the site emits (`page-N`, `pagina-N`, `seite-N`).
 */
export function paginationPageFromPath(urlPath: string): number {
  const match = PAGINATED_PATH_RE.exec(urlPath);
  return match ? Number(match[1]) : 1;
}
