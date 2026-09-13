import { describe, expect, it } from 'vitest';
import { buildPlateAuctionPath, parsePlateAuctionPath } from '../services/plateAuctions/paths';

describe('plate-auction localized routing', () => {
  it('round-trips a canton detail route', () => {
    const path = buildPlateAuctionPath({ locale: 'it', view: 'detail', canton: 'ZH', plate: 'ZH626' });
    expect(path).toBe('/aste-targhe-svizzera/zurigo-zh/zh626/');
    expect(parsePlateAuctionPath(path)).toEqual({ locale: 'it', view: 'detail', canton: 'ZH', plate: 'ZH626' });
  });

  it('round-trips an English rankings route', () => {
    const path = buildPlateAuctionPath({ locale: 'en', view: 'rankings' });
    expect(path).toBe('/en/swiss-plate-auctions/rankings/');
    expect(parsePlateAuctionPath(path)).toEqual({ locale: 'en', view: 'rankings' });
  });

  it('keeps every canton slug unique in each locale', () => {
    for (const locale of ['it', 'en', 'de', 'fr'] as const) {
      const paths = ['AG', 'AI', 'AR', 'BE', 'BL', 'BS', 'FR', 'GE', 'GL', 'GR', 'JU', 'LU', 'NE', 'NW', 'OW', 'SG', 'SH', 'SO', 'SZ', 'TG', 'TI', 'UR', 'VD', 'VS', 'ZG', 'ZH']
        .map((canton) => buildPlateAuctionPath({ locale, view: 'canton', canton }));
      expect(new Set(paths).size).toBe(26);
    }
  });

  it('fails closed on malformed percent-encoding', () => {
    expect(parsePlateAuctionPath('/aste-targhe-svizzera/%E0%A4%A/')).toBeNull();
  });
});
