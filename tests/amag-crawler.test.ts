import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { assertDetailFetchComplete } from '../scripts/lib/detail-fetch-cap.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const DETAIL_CAP_CRAWLERS = [
  'amag', 'afry', 'axa', 'convit', 'engelvoelkers', 'hoval', 'mtic',
  'tarchini-group', 'hitachi-energy',
];

describe('detail-fetch completeness', () => {
  it('refuses to publish a listing set truncated by the detail cap', () => {
    const listings = [{ jobId: '1' }, { jobId: '2' }, { jobId: '3' }];

    expect(() => assertDetailFetchComplete(listings, 2, 'AMAG'))
      .toThrow(/refusing to publish a truncated set as complete/i);
  });

  it('keeps the complete set when it fits within the configured cap', () => {
    const listings = [{ jobId: '1' }, { jobId: '2' }];

    expect(assertDetailFetchComplete(listings, 2, 'AMAG')).toBe(listings);
  });

  it('does not reintroduce silent detail-list truncation in the crawler class', () => {
    for (const crawler of DETAIL_CAP_CRAWLERS) {
      const source = readFileSync(
        path.resolve(TEST_DIR, `../scripts/update-${crawler}-jobs.mjs`),
        'utf8',
      );
      expect(source, crawler).not.toMatch(/(?:listings|swissJobs)\.slice\(\s*0\s*,\s*MAX_DETAIL_PAGES/);
    }
  });
});
