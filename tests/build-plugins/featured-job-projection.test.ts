/**
 * Task 5 — FeaturedJob projection tests.
 *
 * Verifies that the 4 aggregates project the 6 new canonical JobCard fields:
 *   companyKey, companyDomain, addressLocality, canton, contract, url
 *
 * Each test constructs a synthetic JobRecord (via `as any` cast), calls the
 * exported test-helper projector, and asserts the returned object contains the
 * expected new fields. Existing fields are spot-checked for backward compat.
 */

import { describe, it, expect } from 'vitest';

// ── Shared minimal job record ────────────────────────────────────────────────

const BASE_NOW = Date.now();

const BASE_JOB = {
  id: 'job-test-1',
  title: 'Infermiere CAS',
  slug: 'infermiere-cas',
  slugByLocale: { it: 'infermiere-cas', en: 'cas-nurse', de: 'cas-krankenpfleger', fr: 'infirmier-cas' },
  titleByLocale: { it: 'Infermiere CAS', en: 'CAS Nurse', de: 'CAS Krankenpfleger', fr: 'Infirmier CAS' },
  company: 'EOC Lugano',
  companyKey: 'eoc-lugano',
  companyDomain: 'eoc.ch',
  contract: 'full-time',
  employmentType: 'FULL_TIME',
  addressLocality: 'Lugano',
  canton: 'TI',
  url: 'https://eoc.ch/jobs/infermiere-cas',
  salaryMin: 75000,
  salaryMax: 90000,
  postedDate: new Date(BASE_NOW - 2 * 86_400_000).toISOString(),
  featured: true,
} as const;

// ── 1. professionJobsAggregate ───────────────────────────────────────────────

describe('profession aggregate FeaturedJob projection', () => {
  it('projects companyKey, companyDomain, contract, url, canton, addressLocality', async () => {
    const { toFeaturedForTest } = await import(
      '../../build-plugins/professionJobsAggregate'
    );
    const result = toFeaturedForTest(BASE_JOB as any, BASE_NOW);

    expect(result).not.toBeNull();
    // New fields
    expect(result!.companyKey).toBe('eoc-lugano');
    expect(result!.companyDomain).toBe('eoc.ch');
    expect(result!.contract).toBe('FULL_TIME'); // employmentType wins over contract
    expect(result!.addressLocality).toBe('Lugano');
    expect(result!.canton).toBe('TI');
    expect(result!.url).toBe('https://eoc.ch/jobs/infermiere-cas');
    // Backward compat — existing fields must still be present
    expect(result!.id).toBe('job-test-1');
    expect(result!.title).toBe('Infermiere CAS');
    expect(result!.company).toBe('EOC Lugano');
    expect(result!.city).toBe('Lugano');
    expect(result!.salaryMin).toBe(75000);
    expect(result!.salaryMax).toBe(90000);
    expect(result!.slug).toBe('infermiere-cas');
    expect(result!.employmentType).toBe('FULL_TIME');
  });

  it('falls back to job.contract when employmentType is absent', async () => {
    const { toFeaturedForTest } = await import(
      '../../build-plugins/professionJobsAggregate'
    );
    const job = { ...BASE_JOB, employmentType: undefined, contract: 'part-time' };
    const result = toFeaturedForTest(job as any, BASE_NOW);
    expect(result).not.toBeNull();
    expect(result!.contract).toBe('part-time');
  });

  it('returns null for companyDomain when absent', async () => {
    const { toFeaturedForTest } = await import(
      '../../build-plugins/professionJobsAggregate'
    );
    const job = { ...BASE_JOB, companyDomain: undefined };
    const result = toFeaturedForTest(job as any, BASE_NOW);
    expect(result).not.toBeNull();
    expect(result!.companyDomain).toBeNull();
  });
});

// ── 2. careerJobsAggregate ───────────────────────────────────────────────────

describe('career aggregate CareerFeaturedJob projection', () => {
  it('projects companyKey, companyDomain, contract, url, canton, addressLocality', async () => {
    const { toCareerFeaturedForTest } = await import(
      '../../build-plugins/careerJobsAggregate'
    );
    const result = toCareerFeaturedForTest(BASE_JOB as any, BASE_NOW);

    expect(result).not.toBeNull();
    expect(result!.companyKey).toBe('eoc-lugano');
    expect(result!.companyDomain).toBe('eoc.ch');
    expect(result!.contract).toBe('FULL_TIME');
    expect(result!.addressLocality).toBe('Lugano');
    expect(result!.canton).toBe('TI');
    expect(result!.url).toBe('https://eoc.ch/jobs/infermiere-cas');
    // Backward compat
    expect(result!.id).toBe('job-test-1');
    expect(result!.city).toBe('Lugano');
    expect(result!.slug).toBe('infermiere-cas');
  });
});

// ── 3. cityJobsAggregate ─────────────────────────────────────────────────────

describe('city aggregate CityFeaturedJob projection', () => {
  it('projects companyKey, companyDomain, contract, url, canton, addressLocality', async () => {
    const { toCityFeaturedForTest } = await import(
      '../../build-plugins/cityJobsAggregate'
    );
    const result = toCityFeaturedForTest(BASE_JOB as any, BASE_NOW, false);

    expect(result).not.toBeNull();
    expect(result!.companyKey).toBe('eoc-lugano');
    expect(result!.companyDomain).toBe('eoc.ch');
    expect(result!.contract).toBe('FULL_TIME');
    expect(result!.addressLocality).toBe('Lugano');
    expect(result!.canton).toBe('TI');
    expect(result!.url).toBe('https://eoc.ch/jobs/infermiere-cas');
    // Backward compat
    expect(result!.id).toBe('job-test-1');
    expect(result!.city).toBe('Lugano');
    expect(result!.isCantonalFallback).toBe(false);
  });
});

// ── 4. nursingJobsAggregate ──────────────────────────────────────────────────

describe('nursing aggregate NursingFeaturedJob projection', () => {
  it('projects companyKey, companyDomain, contract, url, canton, addressLocality', async () => {
    const { toNursingFeaturedForTest } = await import(
      '../../build-plugins/nursingJobsAggregate'
    );
    const result = toNursingFeaturedForTest(BASE_JOB as any, BASE_NOW);

    expect(result).not.toBeNull();
    expect(result!.companyKey).toBe('eoc-lugano');
    expect(result!.companyDomain).toBe('eoc.ch');
    expect(result!.contract).toBe('FULL_TIME');
    expect(result!.addressLocality).toBe('Lugano');
    expect(result!.canton).toBe('TI');
    expect(result!.url).toBe('https://eoc.ch/jobs/infermiere-cas');
    // Backward compat
    expect(result!.id).toBe('job-test-1');
    expect(result!.city).toBe('Lugano');
    expect(result!.slug).toBe('infermiere-cas');
  });
});
