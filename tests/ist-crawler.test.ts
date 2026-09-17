import { describe, expect, it } from 'vitest';
import { isIstDetailJob } from '@/scripts/update-ist-jobs.mjs';

describe('IST detail tenant identity', () => {
  it('accepts the exact hyphenated IST tenant slug without a city allowlist', () => {
    expect(isIstDetailJob({
      hiringOrganization: 'Inspired Education',
      sourceUrl: 'https://jobs.inspirededu.com/job/international-school-of-ticino/12345/',
      location: 'Zürich, CH',
    })).toBe(true);
  });

  it('accepts an exact structured IST company name without relying on the portal host', () => {
    expect(isIstDetailJob({
      company: 'International School of Ticino',
      sourceUrl: 'https://jobs.inspirededu.com/job/campus-role/12345/',
      location: 'Lugano, CH',
    })).toBe(true);
  });

  it('rejects another Inspired tenant even when its description mentions IST', () => {
    expect(isIstDetailJob({
      hiringOrganization: 'Inspired Education',
      sourceUrl: 'https://jobs.inspirededu.com/job/seven-oaks-school/67890/',
      description: 'An opportunity to work with the International School of Ticino team.',
      location: 'Zürich, CH',
    })).toBe(false);
  });
});
