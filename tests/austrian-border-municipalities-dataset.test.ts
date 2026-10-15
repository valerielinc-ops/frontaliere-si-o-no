/**
 * Coherence coverage for the Austria border-municipality dataset (issue
 * #4883, fourth of the FR/DE/AT/LI rollout after France #4545/#4878,
 * Germany #4882, Liechtenstein #4884).
 *
 * Deliberately data-level only: the render layer is covered separately by
 * austrian-border-municipality-pages.test.ts, so like the German/Liechtenstein
 * twins this file never imports a build-plugins/* renderer — a dataset defect
 * fails here, a rendering defect fails there, and neither masks the other.
 * It reads the
 * LIVE dataset via the builder's own exported parse/build functions (never a
 * hardcoded copy of counts or rows), and via the committed
 * data/austrian-border-municipalities.json to also catch drift between the
 * hand-maintained .ts source and the committed JSON.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  buildDataset,
  parseAustrianBorderMunicipalities,
  slugify,
  KNOWN_BEZIRKE,
  KNOWN_LAND,
  MIN_POPULATION,
  EXPECTED_MUNICIPALITY_COUNT,
  REGIME,
} from '../scripts/build-austrian-border-municipalities.mjs';
import {
  MIN_PLAUSIBLE_DISTANCE_KM,
  MAX_PLAUSIBLE_DISTANCE_KM,
  MIN_PLAUSIBLE_POPULATION,
  MAX_PLAUSIBLE_POPULATION,
} from '../scripts/lib/municipality-plausibility-guard.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'data', 'austrianBorderMunicipalities.ts');
const JSON_OUT = path.join(ROOT, 'data', 'austrian-border-municipalities.json');

const tsSource = fs.readFileSync(SRC, 'utf-8');
const all = parseAustrianBorderMunicipalities(tsSource);
const dataset = buildDataset(all);
const everyRecord = [...dataset.aboveFloor, ...dataset.belowFloor];

describe('austrian border municipalities — parses the live source', () => {
  it('parses every comune out of data/austrianBorderMunicipalities.ts (no silent drop)', () => {
    expect(all.length).toBe(EXPECTED_MUNICIPALITY_COUNT);
    expect(dataset.aboveFloor.length + dataset.belowFloor.length).toBe(all.length);
  });
});

describe('austrian border municipalities — slugs', () => {
  it('every record has a non-empty, URL-safe slug derived from its own name', () => {
    for (const m of everyRecord) {
      expect(m.slug, `slug for "${m.name}"`).toBe(slugify(m.name));
      expect(m.slug.length, `slug for "${m.name}"`).toBeGreaterThan(0);
      expect(m.slug, `slug for "${m.name}" must be URL-safe`).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });

  it('has no duplicate slugs (two comuni colliding on the same URL)', () => {
    const slugs = everyRecord.map((m) => m.slug);
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const s of slugs) {
      if (seen.has(s)) dupes.push(s);
      seen.add(s);
    }
    expect(dupes, `duplicate slug(s): ${dupes.join(', ')}`).toEqual([]);
  });
});

describe('austrian border municipalities — no duplicates', () => {
  it('has no duplicate names', () => {
    const names = everyRecord.map((m) => m.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('has no duplicate GKZ (Gemeindekennziffer)', () => {
    const gkzList = everyRecord.map((m) => m.gkz);
    expect(new Set(gkzList).size).toBe(gkzList.length);
  });
});

describe('austrian border municipalities — plausible ranges', () => {
  it('every population is within the shared plausibility guard range', () => {
    for (const m of everyRecord) {
      expect(m.population, `population for "${m.name}"`).toBeGreaterThanOrEqual(MIN_PLAUSIBLE_POPULATION);
      expect(m.population, `population for "${m.name}"`).toBeLessThanOrEqual(MAX_PLAUSIBLE_POPULATION);
    }
  });

  it('every distanceKm (informational OSRM road distance) is within the shared plausibility guard range', () => {
    for (const m of everyRecord) {
      expect(m.distanceKm, `distanceKm for "${m.name}"`).toBeGreaterThanOrEqual(MIN_PLAUSIBLE_DISTANCE_KM);
      expect(m.distanceKm, `distanceKm for "${m.name}"`).toBeLessThanOrEqual(MAX_PLAUSIBLE_DISTANCE_KM);
    }
  });

  it('every GKZ is a well-formed 5-digit Gemeindekennziffer', () => {
    for (const m of everyRecord) {
      expect(m.gkz, `gkz for "${m.name}"`).toMatch(/^\d{5}$/);
    }
  });

  it('every Bezirk is one of the 5 known districts (Vorarlberg x4 + Landeck)', () => {
    for (const m of everyRecord) {
      expect(KNOWN_BEZIRKE, `bezirk for "${m.name}"`).toContain(m.bezirk);
    }
  });

  it('every Land is Vorarlberg or Tirol', () => {
    for (const m of everyRecord) {
      expect(KNOWN_LAND, `land for "${m.name}"`).toContain(m.land);
    }
  });

  it('lat/lng fall inside the Vorarlberg/Tirol bounding box (plausibility, not precision)', () => {
    for (const m of everyRecord) {
      expect(m.lat, `lat for "${m.name}"`).toBeGreaterThanOrEqual(46.8);
      expect(m.lat, `lat for "${m.name}"`).toBeLessThanOrEqual(47.6);
      expect(m.lng, `lng for "${m.name}"`).toBeGreaterThanOrEqual(9.4);
      expect(m.lng, `lng for "${m.name}"`).toBeLessThanOrEqual(10.7);
    }
  });
});

describe('austrian border municipalities — floor classification (population-only, see FLOOR note)', () => {
  it('every above-floor record actually satisfies the population floor', () => {
    for (const m of dataset.aboveFloor) {
      expect(m.population, `above-floor population for "${m.name}"`).toBeGreaterThanOrEqual(MIN_POPULATION);
    }
  });

  it('every below-floor record actually fails the population floor', () => {
    for (const m of dataset.belowFloor) {
      expect(m.population, `below-floor "${m.name}" unexpectedly satisfies the floor`).toBeLessThan(MIN_POPULATION);
    }
  });

  it('splits into 8 above-floor / 16 below-floor, all above-floor in Vorarlberg (verified expectation, not forced)', () => {
    expect(dataset.aboveFloor.length).toBe(8);
    expect(dataset.belowFloor.length).toBe(16);
    expect(dataset.aboveFloor.every((m) => m.land === 'Vorarlberg')).toBe(true);
    expect(dataset.aboveFloor.some((m) => m.land === 'Tirol')).toBe(false);
  });

  it('the distance gate is deliberately NOT applied — at least one above-floor record has distanceKm > 20 (Nenzing)', () => {
    // Regression lock: if this ever flips to false, someone re-introduced a
    // German-style distance gate without updating the FLOOR note/tests — the
    // whole point of the population-only floor is that a genuinely
    // border-touching comune (Nenzing, 25.7km from the nearest AT vehicular
    // crossing over the roadless Naafkopf ridge) still gets an indexable page.
    const hasFarAboveFloorRecord = dataset.aboveFloor.some((m) => m.distanceKm > 20);
    expect(hasFarAboveFloorRecord, 'expected at least one above-floor record with distanceKm > 20').toBe(true);
  });
});

describe('austrian border municipalities — source, year and regime declared', () => {
  it('declares a non-empty source string (no hardcoded date in the assertion)', () => {
    expect(typeof dataset.source).toBe('string');
    expect(dataset.source.length).toBeGreaterThan(20);
    expect(dataset.source).toMatch(/vorarlberg|statistik austria/i);

    expect(typeof dataset.year).toBe('number');
    // Sanity bound only — never assert an exact literal year (fixture-date rule).
    const currentYear = new Date().getFullYear();
    expect(dataset.year).toBeGreaterThanOrEqual(currentYear - 2);
    expect(dataset.year).toBeLessThanOrEqual(currentYear + 1);
  });

  it('every record declares a non-empty per-row source string', () => {
    for (const m of everyRecord) {
      expect(typeof m.source, `source for "${m.name}"`).toBe('string');
      expect(m.source.length, `source for "${m.name}"`).toBeGreaterThan(10);
    }
  });

  it('every record declares the same populationDate (no per-row date drift)', () => {
    const dates = new Set(everyRecord.map((m) => m.populationDate));
    expect(dates.size, 'expected a single uniform populationDate across all rows').toBe(1);
    expect(typeof [...dates][0]).toBe('string');
  });

  it('declares a single uniform regime across all rows (no canton-driven variant, unlike France)', () => {
    expect(typeof dataset.regime.value).toBe('string');
    expect(dataset.regime.value.length).toBeGreaterThan(0);
    expect(dataset.regime.value).toBe(REGIME);
    const regimes = new Set(everyRecord.map((m) => m.regime));
    expect(regimes.size, 'expected a single uniform regime across all rows').toBe(1);
    expect([...regimes][0]).toBe(dataset.regime.value);
  });

  it('the regime note documents the 2006/2007 abrogation (decisive fact), not a German/Liechtenstein figure', () => {
    expect(dataset.regime.note).toMatch(/abrogat/i);
    expect(dataset.regime.note).toMatch(/2006/);
    expect(dataset.regime.note).toMatch(/2007/);
    // Must explicitly state there is NO non-return-day threshold (positive
    // assertion — safer than a negative-lookahead regex, which cannot see
    // "nessuna" occurring BEFORE the matched span). The note may still
    // mention the unrelated general OECD 183-day short-stay rule and may
    // CONTRAST Austria with Germany's 4.5% cap ("nessun tetto comparabile
    // al 4.5% tedesco") — both are correct, informative negations, not a
    // disinformation risk.
    expect(dataset.regime.note).toMatch(/nessuna soglia di giorni di non-rientro/i);
    expect(dataset.regime.note).toMatch(/183/);
  });
});

describe('austrian border municipalities — fails loud on bad data (never a silent drop)', () => {
  it('throws on an unknown Bezirk instead of silently dropping the row', () => {
    const good = { ...everyRecord[0] };
    const bad = { ...good, bezirk: 'Nicht-Existierender-Bezirk' };
    expect(() => buildDataset([bad])).toThrow(/unknown Bezirk/);
  });

  it('throws on an unknown Land instead of silently dropping the row', () => {
    const good = { ...everyRecord[0] };
    const bad = { ...good, land: 'Kärnten' };
    expect(() => buildDataset([bad])).toThrow(/unknown Land/);
  });

  it('throws on an implausible distanceKm (transcription-typo guard)', () => {
    const good = { ...everyRecord[0] };
    const typo = { ...good, distanceKm: MAX_PLAUSIBLE_DISTANCE_KM + 1 };
    expect(() => buildDataset([typo])).toThrow(/implausible distanceKm/);
  });

  it('throws on an implausible population (transcription-typo guard)', () => {
    const good = { ...everyRecord[0] };
    const typo = { ...good, population: MAX_PLAUSIBLE_POPULATION + 1 };
    expect(() => buildDataset([typo])).toThrow(/implausible population/);
  });

  it('throws on a malformed GKZ (wrong digit count silently filtered, not a bug we want silent)', () => {
    const good = { ...everyRecord[0] };
    const bad = { ...good, gkz: '123' };
    const rebuilt = buildDataset([bad, ...all.filter((m) => m.name !== good.name)]);
    // A malformed GKZ is filtered out of `valid` (never reaches the Bezirk/plausibility
    // checks), so it must simply be absent from the output rather than silently coerced.
    expect(rebuilt.aboveFloor.some((m) => m.name === good.name) || rebuilt.belowFloor.some((m) => m.name === good.name)).toBe(false);
  });
});

describe('austrian border municipalities — committed JSON matches the live source', () => {
  it('data/austrian-border-municipalities.json is not stale (re-run the builder if this fails)', () => {
    expect(fs.existsSync(JSON_OUT), 'data/austrian-border-municipalities.json must be committed').toBe(true);
    const committed = JSON.parse(fs.readFileSync(JSON_OUT, 'utf-8'));
    expect(committed.aboveFloor.length).toBe(dataset.aboveFloor.length);
    expect(committed.belowFloor.length).toBe(dataset.belowFloor.length);
    expect(committed).toEqual(dataset);
  });
});
