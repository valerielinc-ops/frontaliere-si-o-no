import { describe, expect, it } from 'vitest';
import { coordinateFromWkt } from '../scripts/generate-swiss-municipality-map.mjs';

describe('coordinateFromWkt', () => {
  it('parses Wikidata Point coordinates as longitude then latitude', () => {
    expect(coordinateFromWkt('Point(8.55 47.37)')).toEqual({ lat: 47.37, lng: 8.55 });
    expect(coordinateFromWkt('POINT(-0.1276 51.5072)')).toEqual({ lat: 51.5072, lng: -0.1276 });
  });

  it('rejects non-point or malformed coordinates', () => {
    expect(coordinateFromWkt('Polygon((8.5 47.3))')).toBeNull();
    expect(coordinateFromWkt('Point(8.5)')).toBeNull();
  });
});
