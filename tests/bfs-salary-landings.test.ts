/**
 * #4481 — BFS salary-by-age / salary-by-education landings.
 * Path builders/parsers, dataset invariants, and render smoke tests.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  SALARY_LOCALES,
  SALARY_AGE_ANCHORS,
  SALARY_EDUCATION_IDS,
  SALARY_LANDING_ROUTES,
  buildSalaryAgeLandingPath,
  buildSalaryEducationLandingPath,
  parseSalaryLandingPath,
  isSalaryLandingPath,
  type BfsSalaryDataset,
} from '@/build-plugins/bfsSalaryLandingsData';
import {
  __renderAgePageForTest,
  __renderEducationPageForTest,
} from '@/build-plugins/bfsSalaryLandingsPlugin';
import { MIN_INDEXABLE_WORDS } from '@/build-plugins/constants';

const DATASET = JSON.parse(
  readFileSync(resolve(__dirname, '..', 'data', 'seo', 'bfs-salary-by-age.json'), 'utf8'),
) as BfsSalaryDataset;

describe('bfs salary landings — routing', () => {
  it('produces 36 canonical routes (20 age + 16 education), all trailing-slash & unique', () => {
    expect(SALARY_LANDING_ROUTES).toHaveLength(36);
    for (const r of SALARY_LANDING_ROUTES) {
      expect(r.endsWith('/')).toBe(true);
      expect(r.startsWith('/')).toBe(true);
    }
    expect(new Set(SALARY_LANDING_ROUTES).size).toBe(36);
  });

  it('round-trips age paths build → parse', () => {
    for (const locale of SALARY_LOCALES) {
      for (const age of SALARY_AGE_ANCHORS) {
        const p = buildSalaryAgeLandingPath(locale, age);
        expect(parseSalaryLandingPath(p)).toEqual({ kind: 'age', locale, age });
        expect(isSalaryLandingPath(p)).toBe(true);
      }
    }
  });

  it('round-trips education paths build → parse', () => {
    for (const locale of SALARY_LOCALES) {
      for (const eduId of SALARY_EDUCATION_IDS) {
        const p = buildSalaryEducationLandingPath(locale, eduId);
        expect(parseSalaryLandingPath(p)).toEqual({ kind: 'education', locale, eduId });
        expect(isSalaryLandingPath(p)).toBe(true);
      }
    }
  });

  it('IT canonical slugs are the expected keyword URLs', () => {
    expect(buildSalaryAgeLandingPath('it', 30)).toBe('/stipendio-medio-svizzera-30-anni/');
    expect(buildSalaryAgeLandingPath('en', 30)).toBe('/en/average-salary-switzerland-age-30/');
    expect(buildSalaryEducationLandingPath('it', 'universita')).toBe('/stipendio-svizzera-laurea/');
    expect(buildSalaryEducationLandingPath('fr', 'apprendistato-afc')).toBe('/fr/salaire-suisse-apprentissage/');
  });

  it('rejects unrelated paths', () => {
    expect(parseSalaryLandingPath('/stipendio-medio-svizzera-99-anni/')).toBeNull();
    expect(isSalaryLandingPath('/calcola-stipendio/')).toBe(false);
  });
});

describe('bfs salary dataset — invariants', () => {
  it('has 5 age bands and 4 education levels, all with positive medians', () => {
    expect(DATASET.ageBands).toHaveLength(5);
    expect(DATASET.educationLevels).toHaveLength(4);
    for (const b of DATASET.ageBands) expect(b.medianChf).toBeGreaterThan(0);
    for (const e of DATASET.educationLevels) expect(e.medianChf).toBeGreaterThan(0);
    expect(DATASET.nationalMedianChf).toBeGreaterThan(0);
  });

  it('every anchor age maps to exactly one band', () => {
    for (const age of SALARY_AGE_ANCHORS) {
      const bands = DATASET.ageBands.filter((b) => b.anchorAges.includes(age));
      expect(bands, `age ${age}`).toHaveLength(1);
    }
  });

  it('education level ids match the route enum', () => {
    expect(DATASET.educationLevels.map((e) => e.id).sort()).toEqual([...SALARY_EDUCATION_IDS].sort());
    for (const e of DATASET.educationLevels) {
      for (const loc of SALARY_LOCALES) expect(e.name[loc]).toBeTruthy();
    }
  });
});

describe('bfs salary landings — render smoke', () => {
  it('age pages render above the floor with the median CHF value + calculator CTA', () => {
    for (const locale of SALARY_LOCALES) {
      for (const age of SALARY_AGE_ANCHORS) {
        const r = __renderAgePageForTest({ locale, age, dateStamp: '2026-07-19' });
        expect(r.wordCount, `${locale}/age-${age} thin`).toBeGreaterThanOrEqual(MIN_INDEXABLE_WORDS);
        expect(r.html).toContain('CHF');
        expect(r.html).toContain('<h1');
        // primary CTA to the net-salary calculator
        expect(r.html).toMatch(/calcola-stipendio|calculate-salary|gehalt-berechnen|calculer-salaire/);
      }
    }
  });

  it('education pages render above the floor with the median CHF value', () => {
    for (const locale of SALARY_LOCALES) {
      for (const eduId of SALARY_EDUCATION_IDS) {
        const r = __renderEducationPageForTest({ locale, eduId, dateStamp: '2026-07-19' });
        expect(r.wordCount, `${locale}/${eduId} thin`).toBeGreaterThanOrEqual(MIN_INDEXABLE_WORDS);
        expect(r.html).toContain('CHF');
        expect(r.html).toContain('<h1');
      }
    }
  });

  it('canonical URL carries the trailing slash', () => {
    const r = __renderAgePageForTest({ locale: 'it', age: 30, dateStamp: '2026-07-19' });
    expect(r.html).toContain('https://frontaliereticino.ch/stipendio-medio-svizzera-30-anni/');
  });
});
