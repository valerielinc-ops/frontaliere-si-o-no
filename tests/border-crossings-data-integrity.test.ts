/**
 * Structural/schema validation for `data/borderCrossings.ts`.
 *
 * Follow-up from #4542 review: post-merge verification only checked
 * name-uniqueness + count, which would not catch a misplaced-but-still-valid
 * object (e.g. one nested under the wrong parent during a diff3 merge, or
 * missing/extra keys from a truncated entry). This test walks every entry
 * and asserts the full `BorderCrossing` shape, catching malformed records
 * that `tsc`/build (esbuild transform, no type-check) would silently pass.
 */

import { describe, expect, it } from 'vitest';
import { borderCrossings } from '../data/borderCrossings';

const REQUIRED_KEYS = [
  'name',
  'country',
  'foreignSide',
  'canton',
  'province',
  'lat',
  'lng',
  'type',
  'open24h',
  'customsPresent',
  'hours',
  'tips',
] as const;

const OPTIONAL_KEYS = [
  'avgWaitMorning',
  'avgWaitEvening',
  'trafficLevel',
  'peak',
  'bazgCoverage',
  'webcams',
] as const;

const KNOWN_KEYS = new Set<string>([...REQUIRED_KEYS, ...OPTIONAL_KEYS]);
const KNOWN_WEBCAM_KEYS = new Set([
  'label',
  'imageUrl',
  'sourceName',
  'sourceUrl',
  'refreshIntervalMs',
  'license',
  'minBytes',
]);

const VALID_COUNTRIES = new Set(['IT', 'FR', 'DE', 'AT', 'LI']);
const VALID_TYPES = new Set(['autostrada', 'statale', 'locale']);
const VALID_TRAFFIC_LEVELS = new Set(['high', 'medium', 'low', 'closed']);

describe('borderCrossings — structural integrity', () => {
  it('is a non-empty array', () => {
    expect(Array.isArray(borderCrossings)).toBe(true);
    expect(borderCrossings.length).toBeGreaterThan(0);
  });

  it('has no unexpected/missing keys — every entry matches the BorderCrossing shape exactly', () => {
    for (const c of borderCrossings) {
      const keys = Object.keys(c);
      const unknown = keys.filter(k => !KNOWN_KEYS.has(k));
      expect(unknown, `unexpected key(s) on "${c.name}": ${unknown.join(', ')}`).toEqual([]);

      const missing = REQUIRED_KEYS.filter(k => !(k in c));
      expect(missing, `missing required key(s) on "${c.name ?? '<no name>'}": ${missing.join(', ')}`).toEqual([]);
    }
  });

  it('has correctly-typed required fields on every entry', () => {
    for (const c of borderCrossings) {
      expect(typeof c.name, `name on entry near lat/lng ${c.lat},${c.lng}`).toBe('string');
      expect(c.name.length).toBeGreaterThan(0);

      expect(VALID_COUNTRIES.has(c.country), `invalid country "${c.country}" on "${c.name}"`).toBe(true);

      expect(typeof c.foreignSide, `foreignSide on "${c.name}"`).toBe('string');
      expect(c.foreignSide.length).toBeGreaterThan(0);

      expect(typeof c.canton, `canton on "${c.name}"`).toBe('string');
      expect(c.canton.length).toBeGreaterThan(0);

      expect(typeof c.province, `province on "${c.name}"`).toBe('string');
      expect(c.province.length).toBeGreaterThan(0);

      expect(typeof c.lat, `lat on "${c.name}"`).toBe('number');
      expect(Number.isFinite(c.lat)).toBe(true);
      expect(typeof c.lng, `lng on "${c.name}"`).toBe('number');
      expect(Number.isFinite(c.lng)).toBe(true);

      expect(VALID_TYPES.has(c.type), `invalid type "${c.type}" on "${c.name}"`).toBe(true);

      expect(typeof c.open24h, `open24h on "${c.name}"`).toBe('boolean');
      expect(typeof c.customsPresent, `customsPresent on "${c.name}"`).toBe('boolean');

      expect(typeof c.hours, `hours on "${c.name}"`).toBe('string');
      expect(c.hours.length).toBeGreaterThan(0);

      expect(typeof c.tips, `tips on "${c.name}"`).toBe('string');
      expect(c.tips.length).toBeGreaterThan(0);
    }
  });

  it('has correctly-typed optional fields when present', () => {
    for (const c of borderCrossings) {
      if (c.avgWaitMorning !== undefined) expect(typeof c.avgWaitMorning).toBe('string');
      if (c.avgWaitEvening !== undefined) expect(typeof c.avgWaitEvening).toBe('string');
      if (c.peak !== undefined) expect(typeof c.peak).toBe('string');
      if (c.bazgCoverage !== undefined) expect(typeof c.bazgCoverage).toBe('boolean');

      if (c.trafficLevel !== undefined) {
        expect(VALID_TRAFFIC_LEVELS.has(c.trafficLevel), `invalid trafficLevel "${c.trafficLevel}" on "${c.name}"`).toBe(true);
      }

      if (c.webcams !== undefined) {
        expect(Array.isArray(c.webcams), `webcams on "${c.name}" must be an array`).toBe(true);
        for (const cam of c.webcams) {
          const keys = Object.keys(cam);
          const unknown = keys.filter(k => !KNOWN_WEBCAM_KEYS.has(k));
          expect(unknown, `unexpected webcam key(s) on "${c.name}": ${unknown.join(', ')}`).toEqual([]);

          expect(typeof cam.label, `webcam.label on "${c.name}"`).toBe('string');
          expect(cam.label.length).toBeGreaterThan(0);
          expect(typeof cam.imageUrl, `webcam.imageUrl on "${c.name}"`).toBe('string');
          expect(cam.imageUrl.length).toBeGreaterThan(0);
          expect(typeof cam.sourceName, `webcam.sourceName on "${c.name}"`).toBe('string');
          expect(cam.sourceName.length).toBeGreaterThan(0);
          expect(typeof cam.sourceUrl, `webcam.sourceUrl on "${c.name}"`).toBe('string');
          expect(cam.sourceUrl.length).toBeGreaterThan(0);

          if (cam.refreshIntervalMs !== undefined) expect(typeof cam.refreshIntervalMs).toBe('number');
          if (cam.license !== undefined) expect(typeof cam.license).toBe('string');
          if (cam.minBytes !== undefined) expect(typeof cam.minBytes).toBe('number');
        }
      }
    }
  });

  it('has no duplicate names (dataset-wide, not just at merge time)', () => {
    const names = borderCrossings.map(c => c.name);
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const n of names) {
      if (seen.has(n)) dupes.push(n);
      seen.add(n);
    }
    expect(dupes, `duplicate name(s): ${dupes.join(', ')}`).toEqual([]);
  });

  it('has no duplicate lat/lng pairs (catches a copy-pasted/misplaced entry with a stale name)', () => {
    const coordKey = (c: (typeof borderCrossings)[number]) => `${c.lat},${c.lng}`;
    const byCoord = new Map<string, string[]>();
    for (const c of borderCrossings) {
      const key = coordKey(c);
      const names = byCoord.get(key) ?? [];
      names.push(c.name);
      byCoord.set(key, names);
    }
    const collisions = [...byCoord.entries()].filter(([, names]) => names.length > 1);
    expect(collisions, `crossings sharing identical coordinates: ${JSON.stringify(collisions)}`).toEqual([]);
  });
});
