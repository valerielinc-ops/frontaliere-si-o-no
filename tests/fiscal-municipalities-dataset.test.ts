/**
 * Dataset-level coherence coverage for data/municipalities.ts and the
 * fiscal-guide builder that consumes it (issue #4922 population-placeholder
 * fix). Complements tests/fiscal-municipality-pages.test.ts (which covers
 * the render layer) and tests/municipality-plausibility-guard.test.ts
 * (which covers the shared guard in isolation) — this file is the one that
 * fails if data/municipalities.ts itself regresses back to placeholder
 * data, or if data/fiscal-municipalities.json drifts from its source.
 *
 * Reads the LIVE data/municipalities.ts via the builder's own exported
 * parse/build functions (never a hardcoded copy of counts), so a future
 * edit to the source data is checked automatically, not just today's fix.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  buildDataset,
  parseMunicipalities,
  CORRIDOR_PROVINCES,
  MIN_POPULATION,
  MAX_DISTANCE_KM,
} from '../scripts/build-fiscal-municipalities.mjs';
import {
  assertPlausibleDistribution,
  MIN_PLAUSIBLE_POPULATION,
  MAX_PLAUSIBLE_POPULATION,
} from '../scripts/lib/municipality-plausibility-guard.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'data', 'municipalities.ts');
const JSON_OUT = path.join(ROOT, 'data', 'fiscal-municipalities.json');

const tsSource = fs.readFileSync(SRC, 'utf-8');
const all = parseMunicipalities(tsSource);
const dataset = buildDataset(all);
const corridorRecords = [...dataset.aboveFloor, ...dataset.belowFloor];
const PLACEHOLDER_POPULATION = 2000;

describe('data/municipalities.ts — no unreplaced population placeholder (issue #4922)', () => {
  it('parses the full 518-comune dataset (no silent drop)', () => {
    expect(all.length).toBe(518);
  });

  it('no single population value covers an implausible share of the corridor', () => {
    // Real regression test: this call must NOT throw against the live,
    // fixed data/municipalities.ts. Before the #4922 fix, population: 2000
    // covered 417/518 rows (80%) and this same assertion — run against the
    // pre-fix data — throws (see the paired "fails loud" describe below).
    const corridorRaw = all.filter(
      (m) => CORRIDOR_PROVINCES.includes(m.province) && Number.isFinite(m.population),
    );
    expect(() =>
      assertPlausibleDistribution(corridorRaw, { field: 'population', sourceLabel: 'test' }),
    ).not.toThrow();
  });

  it('the placeholder value (2000) is no longer the population of every corridor comune', () => {
    const corridorAll = all.filter((m) => CORRIDOR_PROVINCES.includes(m.province));
    const stillPlaceholder = corridorAll.filter((m) => m.population === PLACEHOLDER_POPULATION);
    // A handful of genuine comuni landing on exactly 2000 by coincidence is
    // plausible; hundreds is the placeholder-default signature #4922 fixed.
    expect(stillPlaceholder.length).toBeLessThan(corridorAll.length * 0.05);
  });

  it('every corridor municipality has a population within the shared plausible range', () => {
    for (const m of all.filter((mm) => CORRIDOR_PROVINCES.includes(mm.province))) {
      expect(m.population, `population for "${m.name}" (${m.province})`).toBeGreaterThanOrEqual(
        MIN_PLAUSIBLE_POPULATION,
      );
      expect(m.population, `population for "${m.name}" (${m.province})`).toBeLessThanOrEqual(
        MAX_PLAUSIBLE_POPULATION,
      );
      expect(Number.isFinite(m.population), `population for "${m.name}" must be a real number`).toBe(true);
      expect(m.population, `population for "${m.name}" must not be zero`).toBeGreaterThan(0);
    }
  });
});

describe('data/municipalities.ts — fails loud against the pre-fix placeholder-dominated shape', () => {
  it('buildDataset() throws the distribution guard when fed a synthetic dataset shaped like the original defect', () => {
    // Reconstructs the pre-#4922 shape WITHOUT depending on git history or
    // any external fixture: same corridor provinces, same ~80% share of
    // rows pinned to the placeholder, same total order of magnitude — this
    // is what data/municipalities.ts looked like before this fix, and
    // proves the guard would have caught it.
    const total = 320;
    const placeholderShare = 0.8;
    const placeholderCount = Math.round(total * placeholderShare);
    const synthetic: Array<Record<string, unknown>> = [];
    for (let i = 0; i < placeholderCount; i++) {
      synthetic.push({
        name: `Placeholder Comune ${i}`,
        province: CORRIDOR_PROVINCES[i % CORRIDOR_PROVINCES.length],
        irpefAddizionale: 0.5,
        distanceKm: 10,
        population: PLACEHOLDER_POPULATION,
      });
    }
    for (let i = placeholderCount; i < total; i++) {
      synthetic.push({
        name: `Real Comune ${i}`,
        province: CORRIDOR_PROVINCES[i % CORRIDOR_PROVINCES.length],
        irpefAddizionale: 0.5,
        distanceKm: 10,
        population: 3000 + i,
      });
    }
    expect(() => buildDataset(synthetic)).toThrow(/implausible distribution/);
    expect(() => buildDataset(synthetic)).toThrow(new RegExp(`population=${PLACEHOLDER_POPULATION}`));
  });
});

describe('fiscal-municipalities floor classification stays correct after the population fix', () => {
  it('every above-floor record actually satisfies the floor (population AND distance) — floor itself untouched', () => {
    expect(MIN_POPULATION).toBe(5000);
    expect(MAX_DISTANCE_KM).toBe(20);
    for (const m of dataset.aboveFloor) {
      expect(m.population, `above-floor population for "${m.name}"`).toBeGreaterThanOrEqual(MIN_POPULATION);
      expect(m.distanceKm, `above-floor distanceKm for "${m.name}"`).toBeLessThanOrEqual(MAX_DISTANCE_KM);
      expect(CORRIDOR_PROVINCES).toContain(m.province);
    }
  });

  it('every below-floor record actually fails at least one leg of the floor', () => {
    for (const m of dataset.belowFloor) {
      const passesFloor = m.population >= MIN_POPULATION && m.distanceKm <= MAX_DISTANCE_KM;
      expect(passesFloor, `below-floor "${m.name}" unexpectedly satisfies the floor`).toBe(false);
    }
  });

  it('has no duplicate slugs across the corridor dataset', () => {
    const slugs = corridorRecords.map((m) => m.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});

describe('data/fiscal-municipalities.json — committed JSON matches the live source', () => {
  it('is not stale (re-run node scripts/build-fiscal-municipalities.mjs if this fails)', () => {
    expect(fs.existsSync(JSON_OUT), 'data/fiscal-municipalities.json must be committed').toBe(true);
    const committed = JSON.parse(fs.readFileSync(JSON_OUT, 'utf-8'));
    expect(committed.aboveFloor.length).toBe(dataset.aboveFloor.length);
    expect(committed.belowFloor.length).toBe(dataset.belowFloor.length);
    expect(committed).toEqual(dataset);
  });
});
