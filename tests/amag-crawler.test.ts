import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { assertDetailFetchComplete } from '../scripts/lib/detail-fetch-cap.mjs';

const { fetchHtmlMock } = vi.hoisted(() => ({ fetchHtmlMock: vi.fn() }));

vi.mock('../scripts/lib/crawler-template.mjs', () => ({
  exitCrawlerOnError: vi.fn(),
  fetchHtml: fetchHtmlMock,
}));

import { fetchAllListings } from '../scripts/update-amag-jobs.mjs';

const DETAIL_CRAWLERS = [
  'amag', 'afry', 'axa', 'convit', 'engelvoelkers',
  'hitachi-energy', 'hoval', 'mtic', 'tarchini-group',
];

describe('detail fetch completeness guard', () => {
  it('fails instead of publishing a source listing truncated by the detail cap', () => {
    const listings = [{ id: 1 }, { id: 2 }, { id: 3 }];
    expect(() => assertDetailFetchComplete(listings, 2, 'AMAG'))
      .toThrow(/refusing to publish a truncated set as complete/i);
    expect(assertDetailFetchComplete(listings, 3, 'AMAG')).toBe(listings);
  });

  it('has no silent prefix slice left in the sibling detail crawlers', () => {
    for (const crawler of DETAIL_CRAWLERS) {
      const source = readFileSync(`scripts/update-${crawler}-jobs.mjs`, 'utf8');
      expect(source, crawler).not.toMatch(/(?:listings|swissJobs)\.slice\(0, MAX_DETAIL_PAGES\)/);
      expect(source, crawler).toContain('assertDetailFetchComplete');
    }
  });
});

describe('AMAG listing completeness', () => {
  it('fails closed when the Italian response has no listing source container', async () => {
    fetchHtmlMock
      .mockResolvedValueOnce('<html><body>temporary upstream error</body></html>');

    await expect(fetchAllListings()).rejects.toThrow(/Italian listing fetch failed/i);
  });

  it('fails closed when the German listing cannot be fetched', async () => {
    fetchHtmlMock
      .mockResolvedValueOnce('<table id="joboffers"><tbody></tbody></table>')
      .mockRejectedValueOnce(new Error('German listing unavailable'));

    await expect(fetchAllListings()).rejects.toThrow(/German listing fetch failed/i);
  });

  it('fails closed when the German response has job rows but none are parseable', async () => {
    fetchHtmlMock
      .mockResolvedValueOnce('<table id="joboffers"><tbody></tbody></table>')
      .mockResolvedValueOnce(
        '<table id="joboffers"><tbody><tr><td id="jobTitel">drift</td></tr></tbody></table>',
      );

    await expect(fetchAllListings()).rejects.toThrow(/German listing fetch failed/i);
  });
});
