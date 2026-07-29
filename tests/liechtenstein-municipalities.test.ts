/**
 * Data-integrity coverage for the Liechtenstein corridor dataset (issue
 * #4884, third of the FR/DE/AT/LI rollout started by #4545).
 *
 * No SSG plugin exists yet for this corridor (out of scope for this slice —
 * see scripts/build-liechtenstein-municipalities.mjs header), so unlike
 * tests/french-border-municipality-pages.test.ts / fiscal-municipality-pages.test.ts
 * this file cannot import any `@/build-plugins/*` render path. It follows
 * tests/border-crossings-data-integrity.test.ts's pattern instead: validate
 * the live data + builder directly, no hard-coded copies of the dataset, no
 * absolute calendar dates (population `year` is checked to be plausible and
 * not in the future via `new Date().getFullYear()`, never a literal year).
 *
 * Every assertion here reads either the committed JSON output, the raw
 * `.ts` source, or the builder's own exported constants — never a duplicated
 * literal of the data itself, so a future edit to the dataset cannot drift
 * silently out of sync with this test.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import committedDataset from '../data/liechtenstein-municipalities.json';
import { LIECHTENSTEIN_MUNICIPALITIES } from '../data/liechtensteinMunicipalities';
import {
  buildDataset,
  parseLiechtensteinMunicipalities,
  slugify,
  MIN_POPULATION,
  EXPECTED_MUNICIPALITY_COUNT,
  NATIONAL_POPULATION,
  LIECHTENSTEIN_COMMUTING_CONTEXT,
} from '../scripts/build-liechtenstein-municipalities.mjs';
import {
  assertPlausibleMunicipality,
  MIN_PLAUSIBLE_POPULATION,
  MAX_PLAUSIBLE_POPULATION,
} from '../scripts/lib/municipality-plausibility-guard.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'data', 'liechtensteinMunicipalities.ts');
const OUT = path.join(ROOT, 'data', 'liechtenstein-municipalities.json');

type Record_ = {
  name: string;
  slug: string;
  wikidataId: string;
  lat: number;
  lng: number;
  population: number;
  populationYear: number;
};

const allRecords: Record_[] = [...committedDataset.aboveFloor, ...committedDataset.belowFloor];

// Rough bounding box for the Principality of Liechtenstein (whole territory
// is ~160 km^2 in the Rhine valley) — wide enough to never false-positive on
// a real Liechtenstein coordinate, tight enough to catch a fat-fingered
// digit or a coordinate copy-pasted from the wrong country.
const LI_LAT_RANGE: [number, number] = [47.0, 47.3];
const LI_LNG_RANGE: [number, number] = [9.4, 9.6];

describe('liechtenstein-municipalities.json — committed output is not stale (#4884)', () => {
  it('matches a fresh build from the live data/liechtensteinMunicipalities.ts source', () => {
    const tsSource = fs.readFileSync(SRC, 'utf-8');
    const parsed = parseLiechtensteinMunicipalities(tsSource);
    const fresh = buildDataset(parsed);
    const committedRaw = fs.readFileSync(OUT, 'utf-8');
    expect(JSON.parse(committedRaw)).toEqual(fresh);
  });
});

describe('liechtenstein-municipalities dataset — source, year, national total, direction (#4884)', () => {
  it('declares a non-empty source and a plausible (not future, not absolute-literal) year', () => {
    expect(typeof committedDataset.source).toBe('string');
    expect(committedDataset.source.length).toBeGreaterThan(0);
    expect(Number.isFinite(committedDataset.year)).toBe(true);
    expect(committedDataset.year).toBeLessThanOrEqual(new Date().getFullYear());
    expect(committedDataset.year).toBeGreaterThan(2000);
  });

  it('declares nationalPopulation with a source and a plausible year', () => {
    expect(committedDataset.nationalPopulation.value).toBe(NATIONAL_POPULATION.value);
    expect(committedDataset.nationalPopulation.year).toBeLessThanOrEqual(new Date().getFullYear());
    expect(typeof committedDataset.nationalPopulation.source).toBe('string');
    expect(committedDataset.nationalPopulation.source.length).toBeGreaterThan(0);
  });

  it('the sum of every above+below-floor population equals the declared national total (no hard-coded total)', () => {
    const sum = allRecords.reduce((acc, m) => acc + m.population, 0);
    expect(sum).toBe(committedDataset.nationalPopulation.value);
  });

  it('parsing the live raw .ts source also sums to the declared national total', () => {
    expect(LIECHTENSTEIN_MUNICIPALITIES.length).toBe(EXPECTED_MUNICIPALITY_COUNT);
    const sum = LIECHTENSTEIN_MUNICIPALITIES.reduce((acc, m) => acc + m.population, 0);
    expect(sum).toBe(NATIONAL_POPULATION.value);
  });

  it('declares the inverted commuting direction structurally: CH->LI outnumbers LI->CH, sourced', () => {
    const ctx = committedDataset.commutingContext;
    expect(ctx).toEqual(LIECHTENSTEIN_COMMUTING_CONTEXT);
    // The editorial-decisive fact as a regression test, not just prose: if a
    // future edit ever flips or drops these two numbers, this test catches
    // it rather than letting the page silently misstate which direction is
    // dominant (see data/liechtensteinMunicipalities.ts header, "EDITORIAL
    // CONTEXT").
    expect(ctx.chToLi).toBeGreaterThan(ctx.liToCh);
    expect(typeof ctx.source).toBe('string');
    expect(ctx.source.length).toBeGreaterThan(0);
    expect(typeof ctx.note).toBe('string');
    expect(ctx.note.length).toBeGreaterThan(0);
  });
});

describe('liechtenstein-municipalities dataset — per-record shape (#4884)', () => {
  it('has exactly EXPECTED_MUNICIPALITY_COUNT records total, none dropped or duplicated by the floor split', () => {
    expect(allRecords.length).toBe(EXPECTED_MUNICIPALITY_COUNT);
  });

  it('every above-floor record has population >= MIN_POPULATION and every below-floor record is under it', () => {
    for (const m of committedDataset.aboveFloor) {
      expect(m.population).toBeGreaterThanOrEqual(MIN_POPULATION);
    }
    for (const m of committedDataset.belowFloor) {
      expect(m.population).toBeLessThan(MIN_POPULATION);
    }
  });

  it('every record has a valid slug, a real name, a Wikidata QID, and a coordinate inside Liechtenstein', () => {
    for (const m of allRecords) {
      expect(m.slug).toMatch(/^[a-z0-9-]+$/);
      expect(m.slug.length).toBeGreaterThan(0);
      expect(m.slug).toBe(slugify(m.name));

      expect(typeof m.name).toBe('string');
      expect(m.name.length).toBeGreaterThan(0);

      expect(m.wikidataId).toMatch(/^Q\d+$/);

      expect(m.lat).toBeGreaterThanOrEqual(LI_LAT_RANGE[0]);
      expect(m.lat).toBeLessThanOrEqual(LI_LAT_RANGE[1]);
      expect(m.lng).toBeGreaterThanOrEqual(LI_LNG_RANGE[0]);
      expect(m.lng).toBeLessThanOrEqual(LI_LNG_RANGE[1]);

      expect(m.population).toBeGreaterThanOrEqual(MIN_PLAUSIBLE_POPULATION);
      expect(m.population).toBeLessThanOrEqual(MAX_PLAUSIBLE_POPULATION);

      expect(Number.isFinite(m.populationYear)).toBe(true);
      expect(m.populationYear).toBeLessThanOrEqual(new Date().getFullYear());
    }
  });

  it('has no duplicate slugs, names, Wikidata QIDs, or lat/lng pairs', () => {
    const dupesOf = (values: string[]) => {
      const seen = new Set<string>();
      const dupes: string[] = [];
      for (const v of values) {
        if (seen.has(v)) dupes.push(v);
        seen.add(v);
      }
      return dupes;
    };

    expect(dupesOf(allRecords.map((m) => m.slug))).toEqual([]);
    expect(dupesOf(allRecords.map((m) => m.name))).toEqual([]);
    expect(dupesOf(allRecords.map((m) => m.wikidataId))).toEqual([]);
    expect(dupesOf(allRecords.map((m) => `${m.lat},${m.lng}`))).toEqual([]);
  });
});

describe('liechtenstein-municipalities buildDataset — plausibility guard (mirrors #4886)', () => {
  it('rejects a transcribed-typo population (e.g. an extra digit) before it can misclassify the floor tier', () => {
    const good = LIECHTENSTEIN_MUNICIPALITIES[0];
    const typo = { ...good, population: good.population * 1000 };
    expect(() => buildDataset([typo])).toThrow(/implausible population/);
    expect(() => buildDataset([good])).not.toThrow();
  });

  it('the shared guard itself throws only outside the plausible range, not for any real comune in this dataset', () => {
    for (const m of LIECHTENSTEIN_MUNICIPALITIES) {
      expect(() => assertPlausibleMunicipality(m, { sourceLabel: 'test' })).not.toThrow();
    }
  });
});
