import { describe, expect, it } from 'vitest';
import { assertNoMatchedAddressRegression, inspectMatchedAddressCoverage } from '../../scripts/check-jobposting-address-cache-regression.mjs';

const key = 'muller sohne ag|zurich|ZH';
const matchedEntry = {
  status: 'matched',
  source: 'zefix-lindas',
  companyName: 'Müller & Söhne AG',
  streetAddress: 'Bahnhofstrasse 10',
  postalCode: '8001',
  addressLocality: 'Zürich',
  addressRegion: 'ZH',
};
const newlyMatchedKey = 'coop genossenschaft|basel|BS';
const newlyMatchedEntry = {
  ...matchedEntry,
  companyName: 'Coop Genossenschaft',
  postalCode: '4000',
  addressLocality: 'Basel',
  addressRegion: 'BS',
};

describe('JobPosting address-cache coverage regression guard', () => {
  it('accepts preserved matches and newly resolved addresses', () => {
    const result = assertNoMatchedAddressRegression(
      { [key]: matchedEntry, 'unresolved|town|ZH': { status: 'not-found' } },
      {
        [key]: { ...matchedEntry, streetAddress: 'Bahnhofstrasse 12' },
        [newlyMatchedKey]: newlyMatchedEntry,
      },
    );

    expect(result).toEqual({ beforeMatched: 1, afterMatched: 2, regressions: [] });
  });

  it('fails when a previous match is removed, declassified, or made incomplete', () => {
    const after = {
      [key]: { ...matchedEntry, status: 'not-found' },
      'incomplete|town|ZH': {
        ...matchedEntry,
        status: 'matched',
        companyName: 'Incomplete AG',
        addressLocality: 'Town',
        postalCode: '',
      },
    };
    const result = inspectMatchedAddressCoverage({
      [key]: matchedEntry,
      'removed|town|ZH': { ...matchedEntry, companyName: 'Removed AG' },
    }, after);

    expect(result.beforeMatched).toBe(2);
    expect(result.afterMatched).toBe(1);
    expect(result.regressions).toHaveLength(3);
    expect(() => assertNoMatchedAddressRegression({ [key]: matchedEntry }, { [key]: { ...matchedEntry, status: 'not-found' } }))
      .toThrow(/coverage regressed/);
  });
});
