import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  collectUmantisListingPages,
  extractUmantisNextPageQuery,
} from '../scripts/lib/umantis-listing-common.mjs';

// Real Bethesda Spital (tenant 2998) listing pages, minimised to two rows each
// plus the pager. The live table shows 10 rows per page: page 1 held 10 of the
// 14 vacancies and the other 4 were only on page 2, so a first-page-only
// crawler missed them and a prospector spec re-published the employer under a
// second key (`im-bethesda-spital`) to fill the gap.
const fixture = (name: string) => readFileSync(resolve(__dirname, 'fixtures', name), 'utf8');
const PAGE_1 = fixture('umantis-bethesda-listing-p1.html');
const PAGE_2 = fixture('umantis-bethesda-listing-p2.html');
const LISTING_URL = 'https://recruitingapp-2998.umantis.com/Jobs/All?lang=ger';

describe('Umantis listing pagination', () => {
  it('reads the next-page query from the pager, decoding the HTML entity', () => {
    expect(extractUmantisNextPageQuery(PAGE_1)).toBe('tc1152481=p2&_search_token1152481=2000494253');
    expect(extractUmantisNextPageQuery(PAGE_2)).toBe('tc1152481=p3&_search_token1152481=2000494253');
    expect(extractUmantisNextPageQuery('<table></table>')).toBe('');
  });

  it('walks every page and stops when the past-the-end page repeats page 1', async () => {
    const requested: string[] = [];
    // Umantis 302-redirects `p{last+1}` back to page 1: the walk must stop on
    // a page with no unseen vacancy instead of looping to the page cap.
    const pages: Record<string, string> = {
      [`${LISTING_URL}&tc1152481=p2&_search_token1152481=2000494253`]: PAGE_2,
      [`${LISTING_URL}&tc1152481=p3&_search_token1152481=2000494253`]: PAGE_1,
    };
    const fetchPage = async (url: string) => {
      requested.push(url);
      if (!(url in pages)) throw new Error(`unexpected ${url}`);
      return pages[url];
    };

    const { entries, ui, pages: walked } = await collectUmantisListingPages(PAGE_1, LISTING_URL, fetchPage, { delayMs: 0 });

    expect(ui).toBe('newer');
    expect(walked).toBe(2);
    expect(entries.map((e: { id: string }) => e.id)).toEqual(['451', '454', '328', '408']);
    expect(entries.find((e: { id: string }) => e.id === '328')?.title)
      .toBe('Assistenzärztin/Assistenzarzt Klinik Rheumatologie und Schmerzmedizin 100%');
    expect(requested).toHaveLength(2);
  });

  it('keeps the pages already read when a later page fails', async () => {
    const fetchPage = async () => { throw new Error('HTTP 503'); };
    const { entries, pages } = await collectUmantisListingPages(PAGE_1, LISTING_URL, fetchPage, { delayMs: 0 });
    expect(pages).toBe(1);
    expect(entries.map((e: { id: string }) => e.id)).toEqual(['451', '454']);
  });

  it('respects the page cap', async () => {
    let calls = 0;
    const fetchPage = async () => { calls += 1; return PAGE_2; };
    const { pages } = await collectUmantisListingPages(PAGE_1, LISTING_URL, fetchPage, { delayMs: 0, maxPages: 1 });
    expect(pages).toBe(1);
    expect(calls).toBe(0);
  });
});
