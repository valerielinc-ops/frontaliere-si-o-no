/**
 * Canton of a point (P9a): offline point-in-polygon on the committed
 * swisstopo canton boundaries, plus the assembler stage that uses it to fill
 * an empty `canton`. No network: the boundaries file is committed data.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { cantonAtPoint, indexCantonBoundaries, SWISS_CANTON_BOUNDARIES_PATH } from '../scripts/lib/swiss-canton-geo.mjs';
import { attachCantonFromGeo } from '../scripts/assemble-events-dataset.mjs';
import { compactGeometry, simplifyRing } from '../scripts/generate-swiss-canton-boundaries.mjs';

// Two unit squares sharing the x=1 edge, AA with a hole, plus a BB square
// that overlaps AA on the strip 0.9 < x < 1 (the "simplification sliver").
const square = (x0: number, y0: number, x1: number, y1: number) => [x0, y0, x1, y0, x1, y1, x0, y1, x0, y0];
const FIXTURE = {
  cantons: {
    AA: [[square(0, 0, 1, 1), square(0.2, 0.2, 0.4, 0.4)]],
    BB: [[square(0.9, 0, 2, 1)]],
  },
};
const fixtureIndex = indexCantonBoundaries(FIXTURE);

describe('cantonAtPoint (fixture polygons)', () => {
  it('returns the single containing canton', () => {
    expect(cantonAtPoint({ lat: 0.5, lng: 0.6 }, fixtureIndex)).toBe('AA');
    expect(cantonAtPoint({ lat: 0.5, lng: 1.5 }, fixtureIndex)).toBe('BB');
  });

  it('treats a hole as outside its canton', () => {
    expect(cantonAtPoint({ lat: 0.3, lng: 0.3 }, fixtureIndex)).toBeNull();
  });

  it('returns null for an ambiguous point inside two cantons, never a guess', () => {
    expect(cantonAtPoint({ lat: 0.5, lng: 0.95 }, fixtureIndex)).toBeNull();
  });

  it('returns null outside every canton and for unusable coordinates', () => {
    expect(cantonAtPoint({ lat: 5, lng: 5 }, fixtureIndex)).toBeNull();
    expect(cantonAtPoint({ lat: Number.NaN, lng: 0.5 }, fixtureIndex)).toBeNull();
    expect(cantonAtPoint(undefined, fixtureIndex)).toBeNull();
    expect(cantonAtPoint({ lat: '0.5', lng: '0.5' } as any, fixtureIndex)).toBeNull();
  });

  it('rejects a malformed boundaries document loudly', () => {
    expect(() => indexCantonBoundaries({})).toThrow(/cantons/);
    expect(() => indexCantonBoundaries({ cantons: { AA: [[[0, 0, 1]]] } })).toThrow(/malformed ring/);
  });
});

describe('cantonAtPoint (committed swisstopo boundaries)', () => {
  it('covers the 26 cantons with the declared simplification', () => {
    const doc = JSON.parse(fs.readFileSync(SWISS_CANTON_BOUNDARIES_PATH, 'utf8'));
    expect(Object.keys(doc.cantons).sort()).toEqual([
      'AG', 'AI', 'AR', 'BE', 'BL', 'BS', 'FR', 'GE', 'GL', 'GR', 'JU', 'LU', 'NE',
      'NW', 'OW', 'SG', 'SH', 'SO', 'SZ', 'TG', 'TI', 'UR', 'VD', 'VS', 'ZG', 'ZH',
    ]);
    expect(doc.simplification).toEqual({ method: 'douglas-peucker', toleranceDeg: 0.0005, decimals: 4 });
  });

  // Coordinates of real canton-less events in the 2026-10-03 dataset, plus
  // well-known places on both sides of national and cantonal borders.
  it.each([
    ['Altdorf (event venue)', 46.8787844, 8.6467731, 'UR'],
    ['Mitlödi (event venue)', 47.0114079, 9.0810399, 'GL'],
    ['Petersplatz, Basel', 47.5594679, 7.5837621, 'BS'],
    ['Langnau i.E.', 46.9393887, 7.7752147, 'BE'],
    ['Appenzell', 47.3318122, 9.4078574, 'AI'],
    ['Lugano', 46.0037, 8.9511, 'TI'],
    ['Pfäffikon SZ', 47.201496, 8.780915, 'SZ'],
    ['Zürich Odeon', 47.3677832, 8.5451643, 'ZH'],
  ])('%s → %s', (_label, lat, lng, expected) => {
    expect(cantonAtPoint({ lat, lng })).toBe(expected);
  });

  it.each([
    ['Vaduz (LI)', 47.1382, 9.5227],
    ['Schaan (LI)', 47.1656, 9.4927],
    ['Konstanz (DE)', 47.6614, 9.1714],
    ["Campione d'Italia (IT enclave in TI)", 45.9685, 8.9725],
    ['Como (IT)', 45.8081, 9.0852],
  ])('%s → null (not Swiss)', (_label, lat, lng) => {
    expect(cantonAtPoint({ lat, lng })).toBeNull();
  });
});

describe('attachCantonFromGeo (assembler stage)', () => {
  it('fills only an empty canton, and leaves comune alone', () => {
    const events = [
      { id: 'a', canton: '', geo: { lat: 46.8787844, lng: 8.6467731 } },
      { id: 'b', geo: { lat: 47.0114079, lng: 9.0810399 } },
      { id: 'c', canton: 'ZH', geo: { lat: 47.201496, lng: 8.780915 } },
      { id: 'd', canton: '' },
      { id: 'e', canton: '', geo: { lat: 47.1382, lng: 9.5227 } },
    ];
    expect(attachCantonFromGeo(events)).toBe(2);
    expect(events.map((e) => e.canton)).toEqual(['UR', 'GL', 'ZH', '', '']);
    expect(events.every((e) => !('comune' in e))).toBe(true);
  });

  it('uses the injected resolver', () => {
    const events = [{ id: 'x', canton: '', geo: { lat: 1, lng: 1 } }];
    expect(attachCantonFromGeo(events, () => 'TI')).toBe(1);
    expect(events[0].canton).toBe('TI');
  });
});

describe('boundary generator helpers', () => {
  it('Douglas-Peucker keeps the endpoints and drops collinear points', () => {
    expect(simplifyRing([[0, 0], [1, 0.00001], [2, 0], [2, 2], [0, 0]], 0.001)).toEqual([[0, 0], [2, 0], [2, 2], [0, 0]]);
  });

  it('compacts a MultiPolygon into flat rounded rings and drops collapsed holes', () => {
    const geometry = {
      type: 'MultiPolygon',
      coordinates: [[
        [[0, 0], [1.123456, 0], [1.123456, 1], [0, 1], [0, 0]],
        [[0.5, 0.5], [0.50001, 0.5], [0.5, 0.5]],
      ]],
    };
    expect(compactGeometry(geometry, 0.0005, 4)).toEqual([[[0, 0, 1.1235, 0, 1.1235, 1, 0, 1, 0, 0]]]);
  });
});
