import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assertDetailFetchComplete } from '../scripts/lib/detail-fetch-cap.mjs';

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
