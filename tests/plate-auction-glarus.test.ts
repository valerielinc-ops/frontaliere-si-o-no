import { afterEach, describe, expect, it, vi } from 'vitest';
import * as core from '../functions/src/plateAuctionsCore.js';
import { fetchFixedPriceSource } from '../scripts/plate-auctions/connectors/fixed-price.mjs';

// Public eSchild response shape, without SVGs or reservation/customer data.
const car = { id: 1368, number: 4913, price: 700, available: 1, deleted: 0, registered: 0, reservationid: null, typeid: 1, platetype: 'car_long_plate' };
const motorcycle = { ...car, id: 1585, number: 3100, price: 150, typeid: 3, platetype: 'motorcycle_plate' };
const fetchedAt = new Date().toISOString();
const options = { fetchedAt };
const parse = (payload: unknown) => core.parseGlFixedPriceJson(payload, options);
const payload = (data: unknown[]) => ({ status: true, message: 'Plate list found', data });
afterEach(() => vi.unstubAllGlobals());

describe('verified Glarus public fixed-price catalogue', () => {
  it('preserves plate, vehicle, price and source identity without inventing bids or sales', () => {
    const rows = parse(payload([car, motorcycle]));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: 'gl-1368', sourceKey: 'GL', normalizedPlate: 'GL4913', vehicleType: 'car', listingType: 'fixed-price', startingPriceChf: 700, auctionStatus: 'active', sourceFetchedAt: fetchedAt });
    expect(rows[1]).toMatchObject({ id: 'gl-1585', normalizedPlate: 'GL3100', vehicleType: 'motorcycle', startingPriceChf: 150 });
    for (const row of rows) {
      expect(row).not.toHaveProperty('currentBidChf');
      expect(row).not.toHaveProperty('finalPriceChf');
      expect(row).not.toHaveProperty('bidCount');
      expect(row).not.toHaveProperty('reservationid');
      expect(row).not.toHaveProperty('svg');
      expect(row.officialDetailUrl).toBe('https://eschild.gl.ch/api/v1/plate');
    }
  });

  it.each([null, '<html>Unavailable</html>', {}, { status: false, data: [] }, { status: true, data: {} }])('rejects an unverified envelope instead of publishing zero rows: %j', (value) => {
    expect(() => parse(value)).toThrow(/Glarus/);
  });

  it('recognizes only an explicit successful empty catalogue', () => {
    expect(core.isExplicitlyEmptyCatalogue(parse(payload([])))).toBe(true);
  });

  it.each([
    { number: '4913' }, { id: -1 }, { price: '700' }, { price: -1 }, { price: NaN },
    { available: undefined }, { deleted: undefined }, { registered: undefined },
    { platetype: 'unknown_plate' }, { typeid: 1 }, { number: 0 },
  ])('fails closed on malformed/ambiguous rows: %j', (change) => {
    expect(() => parse(payload([car, { ...motorcycle, ...change }]))).toThrow(/Glarus/);
  });

  it('does not publish reserved, deleted, registered or unavailable records', () => {
    const rows = parse(payload([car, ...[
      { available: 0 }, { deleted: 1 }, { registered: 1 }, { reservationid: 123 },
    ].map((change, index) => ({ ...motorcycle, id: 2000 + index, number: 3100 + index, ...change }))]));
    expect(rows.map(row => row.normalizedPlate)).toEqual(['GL4913']);
  });

  it('rejects duplicate plate/vehicle ownership instead of choosing the first price', () => {
    expect(() => parse(payload([car, { ...car, id: 999, price: 701 }]))).toThrow(/Glarus/);
  });

  it('uses the same parser through the static collector JSON path', async () => {
    const fetch = vi.fn(async (_url: string) => new Response(JSON.stringify(payload([car, motorcycle])), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetch);
    const rows = await fetchFixedPriceSource('gl', { now: new Date(fetchedAt) });
    expect(rows).toEqual(parse(payload([car, motorcycle])));
    expect(fetch.mock.calls[0][0]).toBe('https://eschild.gl.ch/api/v1/plate');
  });
});
