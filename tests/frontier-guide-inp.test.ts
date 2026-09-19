// @vitest-environment node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MUNICIPALITIES } from '../data/municipalities';
import { haversineKm } from '../scripts/lib/haversine.mjs';
import { nearestOpenCrossing, OPEN_BORDER_CROSSINGS } from '../services/nearestBorderCrossing';

const GUIDE_SOURCE = readFileSync(resolve(__dirname, '../components/guide/FrontierGuide.tsx'), 'utf8');
const NEAREST_SOURCE = readFileSync(resolve(__dirname, '../services/nearestBorderCrossing.ts'), 'utf8');

describe('FrontierGuide nearest crossing performance (#8902)', () => {
  it('preserves the previous nearest-open choice and distance for every municipality', () => {
    for (const municipality of MUNICIPALITIES) {
      const expected = OPEN_BORDER_CROSSINGS
        .map((crossing) => ({
          crossing,
          distanceKm: haversineKm(municipality.lat, municipality.lng, crossing.lat, crossing.lng),
        }))
        .sort((a, b) => a.distanceKm - b.distanceKm)[0];
      const actual = nearestOpenCrossing(municipality.lat, municipality.lng);

      expect(actual.crossing).toBe(expected.crossing);
      expect(actual.distanceKm).toBeCloseTo(expected.distanceKm, 10);
    }
  });

  it('keeps the hot path to one reduce and forbids a per-lookup full sort', () => {
    expect(NEAREST_SOURCE).toContain('OPEN_BORDER_CROSSINGS');
    expect(NEAREST_SOURCE).toContain('.reduce<NearestOpenCrossing | null>');
    expect(NEAREST_SOURCE).not.toContain('.sort(');
    expect(GUIDE_SOURCE).not.toMatch(/filter\(.*trafficLevel.*\)[\s\S]*?sort\(/);
  });
});

describe('FrontierGuide live-wait identity (#8903)', () => {
  it('keeps static municipality data outside the live overlay', () => {
    expect(GUIDE_SOURCE).toContain('const LiveWaitContext');
    expect(GUIDE_SOURCE).toContain('const filteredMunicipalities = useMemo(() => lombardyMunicipalitiesBase');
    expect(GUIDE_SOURCE).toContain('<MunicipalityLiveWaitBadge');
    expect(GUIDE_SOURCE).toContain('<MunicipalityLiveWaitSource');
    expect(GUIDE_SOURCE).not.toMatch(
      /lombardyMunicipalitiesBase\.map\(m => \(\{[\s\S]*?\.\.\.m[\s\S]*?liveWait/,
    );
    expect(GUIDE_SOURCE).not.toContain('borderCrossingWaitNow: string');
    expect(GUIDE_SOURCE).not.toContain('borderCrossingWaitSource: string');
  });
});
