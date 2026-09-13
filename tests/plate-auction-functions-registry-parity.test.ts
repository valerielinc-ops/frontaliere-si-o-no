import { describe, expect, it } from 'vitest';
import siteRegistry from '../data/plate-auction-sources-registry.json';
import { PUBLIC_PLATE_AUCTION_SOURCE_REGISTRY } from '../functions/src/plateAuctionSourceRegistry.js';

describe('plate-auction deploy registry parity', () => {
  it('keeps the Cloud Function coverage copy aligned with the site registry', () => {
    expect(Object.keys(PUBLIC_PLATE_AUCTION_SOURCE_REGISTRY).sort()).toEqual(Object.keys(siteRegistry.sources).sort());
    for (const [key, expected] of Object.entries(siteRegistry.sources)) {
      const actual = PUBLIC_PLATE_AUCTION_SOURCE_REGISTRY[key];
      expect(actual).toMatchObject({
        canton: expected.canton,
        plateCode: expected.plateCode,
        officialUrl: expected.officialUrl,
        accessMethod: expected.accessMethod,
        fetchFrequency: expected.fetchFrequency,
        timezone: expected.timezone,
        parserVersion: expected.parserVersion,
        availableFields: expected.availableFields,
        rateLimit: expected.rateLimit,
        termsOfUse: expected.termsOfUse,
        owner: expected.owner,
        status: expected.status,
      });
    }
  });
});
