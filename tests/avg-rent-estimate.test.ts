/**
 * `avgRentMonthly` zone-estimate disclosure (issue #4545 residual 4).
 *
 * The field is a per-fascia stand-in, not a measured per-comune figure, and
 * the dataset has said so in a docblock since #4922 — but a docblock is not
 * disclosure: every surface printed the number bare, and two of them turned it
 * into a colour scale and a ranking axis.
 *
 * Same corrective as #4875 for `irpefAddizionale`: one shared module, one
 * React wrapper, text helpers for the SSG side, and a guard test that keeps
 * every surface wired to them. The last part is the one that matters over
 * time — a disclosure that silently drops off one of several surfaces is
 * worse than none, because the reader cannot tell which numbers were
 * qualified.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { MUNICIPALITIES } from '@/data/municipalities';
import {
  isSharedRentEstimate,
  rentAxisNote,
  rentCaptionSuffix,
  rentDisplayTitle,
  rentEstimateNote,
  sharedRentCohortSize,
  SHARED_RENT_COHORT_THRESHOLD,
} from '@/services/avgRentEstimate';

const LOCALES = ['it', 'en', 'de', 'fr'] as const;
const ROOT = path.resolve(__dirname, '..');

describe('the dataset really is a zone-level estimate', () => {
  it('holds far fewer distinct rent values than comuni', () => {
    const distinct = new Set(MUNICIPALITIES.map((m) => m.avgRentMonthly));
    // 518 comuni, ~32 distinct values. The disclosure copy quotes these
    // numbers, so a drift here means the copy has gone stale.
    expect(MUNICIPALITIES.length).toBeGreaterThan(500);
    expect(distinct.size).toBeLessThan(50);
  });

  it('has the overwhelming majority of comuni sharing a value with others', () => {
    const shared = MUNICIPALITIES.filter(isSharedRentEstimate).length;
    expect(shared / MUNICIPALITIES.length).toBeGreaterThan(0.9);
  });

  it('counts the cohort of a repeated value correctly', () => {
    const counts = new Map<number, number>();
    for (const m of MUNICIPALITIES) counts.set(m.avgRentMonthly, (counts.get(m.avgRentMonthly) ?? 0) + 1);
    const [value, expected] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    const sample = MUNICIPALITIES.find((m) => m.avgRentMonthly === value)!;
    expect(sharedRentCohortSize(sample)).toBe(expected);
    expect(expected).toBeGreaterThanOrEqual(SHARED_RENT_COHORT_THRESHOLD);
  });
});

describe('the disclosure is localized and specific', () => {
  const sample = MUNICIPALITIES.find(isSharedRentEstimate)!;

  it.each(LOCALES)('%s note names the estimate and the cohort size', (locale) => {
    const note = rentEstimateNote(sample, locale);
    expect(note.length).toBeGreaterThan(20);
    // The cohort size is the checkable part — a vague "approx" would not do.
    expect(note).toContain(String(sharedRentCohortSize(sample)));
  });

  it('produces a different note per locale (no untranslated fallback)', () => {
    const notes = new Set(LOCALES.map((l) => rentEstimateNote(sample, l)));
    expect(notes.size).toBe(LOCALES.length);
  });

  it('still discloses for a value that is NOT widely shared', () => {
    const counts = new Map<number, number>();
    for (const m of MUNICIPALITIES) counts.set(m.avgRentMonthly, (counts.get(m.avgRentMonthly) ?? 0) + 1);
    const rare = MUNICIPALITIES.find((m) => (counts.get(m.avgRentMonthly) ?? 0) < SHARED_RENT_COHORT_THRESHOLD);
    if (!rare) return; // dataset has no rare values — nothing to assert
    // Every value in this dataset is an estimate, not only the repeated ones.
    expect(rentEstimateNote(rare, 'it').toLowerCase()).toContain('stima');
    expect(rentDisplayTitle(rare, 'it')).toBe(rentEstimateNote(rare, 'it'));
  });

  it.each(LOCALES)('%s caption suffix and axis note are non-empty', (locale) => {
    expect(rentCaptionSuffix(sample, locale).length).toBeGreaterThan(3);
    expect(rentAxisNote(locale).length).toBeGreaterThan(20);
  });

  it('falls back to Italian for an unknown locale rather than throwing', () => {
    expect(rentEstimateNote(sample, 'xx')).toBe(rentEstimateNote(sample, 'it'));
    expect(rentEstimateNote(sample, '')).toBe(rentEstimateNote(sample, 'it'));
  });
});

describe('every surface that shows avgRentMonthly routes through the shared disclosure', () => {
  // The guard that matters long-term: a new bare `{m.avgRentMonthly}` in JSX
  // would print an unqualified number again.
  const SPA_SURFACES = [
    'components/guide/BorderMunicipalitiesMap.tsx',
    'components/guide/FrontierGuide.tsx',
    'components/guide/PermitCompare.tsx',
    'components/pages/UserProfile.tsx',
    'components/vita/LivabilityIndex.tsx',
    'components/vita/LivabilityMap.tsx',
  ];

  it.each(SPA_SURFACES)('%s uses AvgRentValue', (rel) => {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
    expect(src).toContain('AvgRentValue');
  });

  it.each(SPA_SURFACES)('%s renders no bare {…avgRentMonthly} in JSX', (rel) => {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
    // `{x.avgRentMonthly}` as a JSX expression child — the exact shape that
    // prints an unqualified figure. Arithmetic uses (cost models, min/max
    // normalisation) are fine: those feed maths, not the reader's eye.
    const bare = src.match(/\{\s*[A-Za-z_$][\w$]*\.avgRentMonthly\s*\}/g) ?? [];
    expect(bare).toEqual([]);
  });

  it('the indexed SSG page qualifies its rent tile', () => {
    const src = fs.readFileSync(path.join(ROOT, 'build-plugins/borderMunicipalityPagesPlugin.ts'), 'utf-8');
    expect(src).toContain('rentCaptionSuffix');
  });

  it('the surfaces that rank or colour by rent disclose the axis', () => {
    for (const rel of ['components/guide/BorderMunicipalitiesMap.tsx', 'components/vita/LivabilityIndex.tsx']) {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
      expect(src, `${rel} should call rentAxisNote`).toContain('rentAxisNote');
    }
  });

  it('does NOT label the French corridor rent, which is genuinely sourced', () => {
    // data/frenchBorderMunicipalities.ts carries DGALN/DHUP observations with
    // per-commune counts; marking it an estimate would be the opposite error.
    const src = fs.readFileSync(path.join(ROOT, 'build-plugins/frenchBorderMunicipalityPagesPlugin.ts'), 'utf-8');
    expect(src).not.toContain('avgRentEstimate');
  });
});
