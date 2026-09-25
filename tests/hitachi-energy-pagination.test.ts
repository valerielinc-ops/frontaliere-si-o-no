// @vitest-environment node
/**
 * Regression tests for the Hitachi Energy listing pagination terminator
 * (issue #4993).
 *
 * The AEM endpoint
 * `.../joblist.listsearchresults.json?location=Switzerland` states its own
 * pagination contract in the payload — `loadMore` (another page exists) and
 * `totalNumber` (full result count). `hasMorePages()` used to ignore both and
 * infer the end of pagination from `items.length >= PAGE_SIZE`, so a page that
 * came back one item short of the page size ended the crawl on the spot.
 *
 * Production incident (run 30585824881, 2026-07-30): page 1 returned 19 of 20
 * items with `loadMore: true`; the loop broke after that page, logged
 * `Total Switzerland listings: 19`, and the slice would have gone from 84 to
 * 18 jobs — a 79% content loss caught only by the shrink guard. Two thirds of
 * a live 87-posting Swiss board would have vanished from the site.
 */

import { describe, it, expect } from 'vitest';

import { hasMorePages, PAGE_SIZE } from '../scripts/lib/hitachi-energy-job-parser.mjs';

/** Build a listing payload with `count` items and explicit metadata. */
function payload(count: number, meta: Record<string, unknown> = {}) {
  return {
    items: Array.from({ length: count }, (_, i) => ({
      title: `Job ${i}`,
      url: `https://www.hitachienergy.com/careers/open-jobs/details/JID3-${100000 + i}`,
    })),
    ...meta,
  };
}

describe('hasMorePages (Hitachi Energy listing pagination)', () => {
  it('keeps paginating on a SHORT page when the API says loadMore (the #4993 break)', () => {
    // Exact production shape: 19 items on a 20-per-page endpoint, 87 declared.
    const shortFirstPage = payload(PAGE_SIZE - 1, { totalNumber: 87, loadMore: true });
    expect(hasMorePages(shortFirstPage, { fetchedCount: PAGE_SIZE - 1 })).toBe(true);
  });

  it('keeps paginating on a short page via totalNumber when loadMore is absent', () => {
    const shortFirstPage = payload(PAGE_SIZE - 1, { totalNumber: 87 });
    expect(hasMorePages(shortFirstPage, { fetchedCount: PAGE_SIZE - 1 })).toBe(true);
  });

  it('stops on the API-declared last page even when the page is full', () => {
    // A full page is NOT proof of a next page either — the previous heuristic
    // over-fetched here as well, relying on an empty page to terminate.
    const lastFullPage = payload(PAGE_SIZE, { totalNumber: PAGE_SIZE, loadMore: false });
    expect(hasMorePages(lastFullPage, { fetchedCount: PAGE_SIZE })).toBe(false);
  });

  it('stops once totalNumber is satisfied when loadMore is absent', () => {
    const finalPage = payload(7, { totalNumber: 87 });
    expect(hasMorePages(finalPage, { fetchedCount: 87 })).toBe(false);
  });

  it('always stops on an empty page regardless of metadata', () => {
    // Defensive: a payload that claims more pages but returns nothing must not
    // spin the loop until MAX_PAGES.
    expect(hasMorePages(payload(0, { totalNumber: 87, loadMore: true }), { fetchedCount: 19 })).toBe(false);
  });

  it('falls back to the page-length heuristic when the payload carries no metadata', () => {
    expect(hasMorePages(payload(PAGE_SIZE), { fetchedCount: PAGE_SIZE })).toBe(true);
    expect(hasMorePages(payload(PAGE_SIZE - 1), { fetchedCount: PAGE_SIZE - 1 })).toBe(false);
  });

  it('tolerates a missing fetchedCount (back-compat with the old 1-arg call)', () => {
    expect(hasMorePages(payload(PAGE_SIZE - 1, { loadMore: true }))).toBe(true);
    expect(hasMorePages(payload(PAGE_SIZE, { loadMore: false }))).toBe(false);
  });

  it('walks a full 87-posting board instead of stopping at the first short page', () => {
    // End-to-end shape of the loop terminator: simulate the live board
    // (87 results, 20 per page) where page 1 is short by one.
    const pages = [
      payload(PAGE_SIZE - 1, { totalNumber: 87, loadMore: true }),
      payload(PAGE_SIZE, { totalNumber: 87, loadMore: true }),
      payload(PAGE_SIZE, { totalNumber: 87, loadMore: true }),
      payload(PAGE_SIZE, { totalNumber: 87, loadMore: true }),
      payload(8, { totalNumber: 87, loadMore: false }),
    ];
    let fetched = 0;
    let visited = 0;
    for (const page of pages) {
      visited += 1;
      fetched += page.items.length;
      if (!hasMorePages(page, { fetchedCount: fetched })) break;
    }
    expect(visited).toBe(pages.length);
    expect(fetched).toBe(87);
  });
});
