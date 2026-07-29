/**
 * Coherence coverage for the Germany border-municipality dataset (issue
 * #4882, third of the FR/DE/AT/LI rollout after France #4545/#4878).
 *
 * Deliberately data-level only — no SSG plugin exists yet for Germany (the
 * orchestrator integrates that separately), so unlike
 * french-border-municipality-pages.test.ts this test never imports a
 * build-plugins/* renderer. It reads the LIVE dataset via the builder's own
 * exported parse/build functions (never a hardcoded copy of counts or rows),
 * and via the committed data/german-border-municipalities.json to also catch
 * drift between the hand-maintained .ts source and the committed JSON.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  buildDataset,
  parseGermanBorderMunicipalities,
  slugify,
  KNOWN_LANDKREISE,
  MIN_POPULATION,
  MAX_DISTANCE_KM,
} from '../scripts/build-german-border-municipalities.mjs';
import {
  MIN_PLAUSIBLE_DISTANCE_KM,
  MAX_PLAUSIBLE_DISTANCE_KM,
  MIN_PLAUSIBLE_POPULATION,
  MAX_PLAUSIBLE_POPULATION,
} from '../scripts/lib/municipality-plausibility-guard.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'data', 'germanBorderMunicipalities.ts');
const JSON_OUT = path.join(ROOT, 'data', 'german-border-municipalities.json');

const tsSource = fs.readFileSync(SRC, 'utf-8');
const all = parseGermanBorderMunicipalities(tsSource);
const dataset = buildDataset(all);
const everyRecord = [...dataset.aboveFloor, ...dataset.belowFloor];

describe('german border municipalities — parses the live source', () => {
  it('parses every Gemeinde out of data/germanBorderMunicipalities.ts (no silent drop)', () => {
    // Candidate universe = all Gemeinden of the 4 known Landkreise — not a
    // magic number, just "at least one row per row parsed" plus a sane floor
    // so an accidental near-empty parse fails loud.
    expect(all.length).toBeGreaterThanOrEqual(100);
    expect(dataset.aboveFloor.length + dataset.belowFloor.length).toBe(all.length);
  });
});

describe('german border municipalities — slugs', () => {
  it('every record has a non-empty, URL-safe slug derived from its own name', () => {
    for (const m of everyRecord) {
      expect(m.slug, `slug for "${m.name}"`).toBe(slugify(m.name));
      expect(m.slug.length, `slug for "${m.name}"`).toBeGreaterThan(0);
      expect(m.slug, `slug for "${m.name}" must be URL-safe`).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });

  it('has no duplicate slugs (two Gemeinden colliding on the same URL)', () => {
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

describe('german border municipalities — no duplicates', () => {
  it('has no duplicate names', () => {
    const names = everyRecord.map((m) => m.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('has no duplicate AGS (Amtlicher Gemeindeschlüssel)', () => {
    const agsList = everyRecord.map((m) => m.ags);
    expect(new Set(agsList).size).toBe(agsList.length);
  });
});

describe('german border municipalities — plausible ranges', () => {
  it('every population is within the shared plausibility guard range', () => {
    for (const m of everyRecord) {
      expect(m.population, `population for "${m.name}"`).toBeGreaterThanOrEqual(MIN_PLAUSIBLE_POPULATION);
      expect(m.population, `population for "${m.name}"`).toBeLessThanOrEqual(MAX_PLAUSIBLE_POPULATION);
    }
  });

  it('every distanceKm is within the shared plausibility guard range', () => {
    for (const m of everyRecord) {
      expect(m.distanceKm, `distanceKm for "${m.name}"`).toBeGreaterThanOrEqual(MIN_PLAUSIBLE_DISTANCE_KM);
      expect(m.distanceKm, `distanceKm for "${m.name}"`).toBeLessThanOrEqual(MAX_PLAUSIBLE_DISTANCE_KM);
    }
  });

  it('every AGS is a well-formed 8-digit Amtlicher Gemeindeschlüssel', () => {
    for (const m of everyRecord) {
      expect(m.ags, `ags for "${m.name}"`).toMatch(/^\d{8}$/);
    }
  });

  it('every Landkreis is one of the 4 verified against data/borderCrossings.ts', () => {
    for (const m of everyRecord) {
      expect(KNOWN_LANDKREISE, `landkreis for "${m.name}"`).toContain(m.landkreis);
    }
  });
});

describe('german border municipalities — floor classification', () => {
  it('every above-floor record actually satisfies the floor (population AND distance)', () => {
    for (const m of dataset.aboveFloor) {
      expect(m.population, `above-floor population for "${m.name}"`).toBeGreaterThanOrEqual(MIN_POPULATION);
      expect(m.distanceKm, `above-floor distanceKm for "${m.name}"`).toBeLessThanOrEqual(MAX_DISTANCE_KM);
    }
  });

  it('every below-floor record actually fails at least one leg of the floor', () => {
    for (const m of dataset.belowFloor) {
      const passesFloor = m.population >= MIN_POPULATION && m.distanceKm <= MAX_DISTANCE_KM;
      expect(passesFloor, `below-floor "${m.name}" unexpectedly satisfies the floor`).toBe(false);
    }
  });
});

describe('german border municipalities — source and year declared', () => {
  it('declares a non-empty source string and a plausible year (no hardcoded date)', () => {
    expect(typeof dataset.source).toBe('string');
    expect(dataset.source.length).toBeGreaterThan(20);
    expect(dataset.source).toMatch(/destatis/i);

    expect(typeof dataset.year).toBe('number');
    // Sanity bound only — never assert an exact literal year (fixture-date rule).
    const currentYear = new Date().getFullYear();
    expect(dataset.year).toBeGreaterThanOrEqual(currentYear - 2);
    expect(dataset.year).toBeLessThanOrEqual(currentYear + 1);
  });

  it('declares the floor method and a uniform regime (Art. 15a, not per-canton)', () => {
    expect(dataset.floor.distanceMethod).toBe('osrm-road-routing');
    expect(dataset.floor.minPopulation).toBe(MIN_POPULATION);
    expect(dataset.floor.maxDistanceKm).toBe(MAX_DISTANCE_KM);
    expect(typeof dataset.regime.value).toBe('string');
    expect(dataset.regime.value.length).toBeGreaterThan(0);
    // Every row must carry the SAME regime — unlike the French per-canton split.
    const regimes = new Set(everyRecord.map((m) => m.regime));
    expect(regimes.size, 'expected a single uniform regime across all rows').toBe(1);
    expect([...regimes][0]).toBe(dataset.regime.value);
  });
});

describe('german border municipalities — fails loud on bad data (never a silent drop)', () => {
  it('throws on an unknown Landkreis instead of silently dropping the row', () => {
    const good = { ...everyRecord[0] };
    const bad = { ...good, landkreis: 'Nicht-Existierender-Kreis' };
    expect(() => buildDataset([bad])).toThrow(/unknown Landkreis/);
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
});

describe('german border municipalities — committed JSON matches the live source', () => {
  it('data/german-border-municipalities.json is not stale (re-run the builder if this fails)', () => {
    expect(fs.existsSync(JSON_OUT), 'data/german-border-municipalities.json must be committed').toBe(true);
    const committed = JSON.parse(fs.readFileSync(JSON_OUT, 'utf-8'));
    expect(committed.aboveFloor.length).toBe(dataset.aboveFloor.length);
    expect(committed.belowFloor.length).toBe(dataset.belowFloor.length);
    expect(committed).toEqual(dataset);
  });
});
