// tests/job-enrichment.test.ts
//
// Tests for the SEO field-enrichment helpers used by
// scripts/assemble-jobs-dataset.mjs to populate the fields JobSchema
// (rule #3) requires from the flat shape crawler slices provide.
import { describe, expect, it } from 'vitest';

// @ts-expect-error — .mjs without companion .d.ts
import {
  enrichHiringOrganization,
  enrichDatePosted,
  enrichJobLocation,
  enrichStreetAddress,
  enrichJobForSeo,
} from '../scripts/lib/job-enrichment.mjs';

describe('enrichHiringOrganization', () => {
  it('leaves an already-populated hiringOrganization untouched', () => {
    const job = { company: 'Acme', hiringOrganization: { name: 'AcmeCorp' } };
    const out = enrichHiringOrganization(job);
    expect(out.hiringOrganization).toEqual({ name: 'AcmeCorp' });
  });

  it('derives hiringOrganization.name from company when absent', () => {
    const job = { company: 'Vaudoise Assurances' };
    const out = enrichHiringOrganization(job);
    expect(out.hiringOrganization).toEqual({ name: 'Vaudoise Assurances' });
  });

  it('returns a NEW object (immutability)', () => {
    const job = { company: 'Acme' };
    const out = enrichHiringOrganization(job);
    expect(out).not.toBe(job);
    expect(job.hiringOrganization).toBeUndefined();
  });

  it('leaves hiringOrganization undefined when company is missing/empty', () => {
    const job = { id: 'x' };
    const out = enrichHiringOrganization(job);
    expect(out.hiringOrganization).toBeUndefined();
  });
});

describe('enrichDatePosted', () => {
  it('leaves a valid ISO datePosted untouched', () => {
    const job = { datePosted: '2026-04-17' };
    const out = enrichDatePosted(job);
    expect(out.datePosted).toBe('2026-04-17');
  });

  it("parses 'DD/MM/YY' (two-digit year → 20YY)", () => {
    const job = { postedDate: '17/04/26' };
    const out = enrichDatePosted(job);
    expect(out.datePosted).toBe('2026-04-17');
  });

  it("parses 'DD/MM/YYYY'", () => {
    const job = { postedDate: '17/04/2026' };
    const out = enrichDatePosted(job);
    expect(out.datePosted).toBe('2026-04-17');
  });

  it("parses 'YYYY-MM-DD' postedDate", () => {
    const job = { postedDate: '2026-04-17' };
    const out = enrichDatePosted(job);
    expect(out.datePosted).toBe('2026-04-17');
  });

  it("parses 'DD.MM.YYYY' (observed in some crawlers)", () => {
    const job = { postedDate: '14.08.2025' };
    const out = enrichDatePosted(job);
    expect(out.datePosted).toBe('2025-08-14');
  });

  it('parses ISO-8601 with timezone offset', () => {
    const job = { postedDate: '2026-05-18T16:52:12+0200' };
    const out = enrichDatePosted(job);
    expect(out.datePosted).toBe('2026-05-18');
  });

  it('leaves datePosted undefined for unparseable strings', () => {
    const job = { postedDate: 'garbage' };
    const out = enrichDatePosted(job);
    expect(out.datePosted).toBeUndefined();
  });

  it('leaves datePosted undefined when no source field is present', () => {
    const job = { id: 'x' };
    const out = enrichDatePosted(job);
    expect(out.datePosted).toBeUndefined();
  });

  it('rejects implausibly-future years (>current+1) and returns undefined', () => {
    // /99 would map to 2099 — that's not a real job ad.
    const job = { postedDate: '17/04/99' };
    const out = enrichDatePosted(job);
    expect(out.datePosted).toBeUndefined();
  });

  it('returns a NEW object (immutability)', () => {
    const job = { postedDate: '17/04/26' };
    const out = enrichDatePosted(job);
    expect(out).not.toBe(job);
    expect(job.datePosted).toBeUndefined();
  });

  it('rejects Feb 31 (invalid calendar date)', () => {
    expect(enrichDatePosted({ postedDate: '31/02/26' }).datePosted).toBeUndefined();
  });

  it('rejects April 31 (invalid calendar date)', () => {
    expect(enrichDatePosted({ postedDate: '31/04/26' }).datePosted).toBeUndefined();
  });

  it('accepts Feb 29 on a leap year (2024)', () => {
    expect(enrichDatePosted({ postedDate: '29/02/24' }).datePosted).toBe('2024-02-29');
  });

  it('rejects Feb 29 on a non-leap year (2026)', () => {
    expect(enrichDatePosted({ postedDate: '29/02/26' }).datePosted).toBeUndefined();
  });
});

describe('enrichJobLocation', () => {
  it('leaves a complete jobLocation untouched', () => {
    const job = {
      addressLocality: 'Lugano',
      postalCode: '6900',
      jobLocation: { addressLocality: 'Lugano', postalCode: '6900', addressCountry: 'CH' },
    };
    const out = enrichJobLocation(job);
    expect(out.jobLocation).toEqual({ addressLocality: 'Lugano', postalCode: '6900', addressCountry: 'CH' });
  });

  it('builds jobLocation from flat fields when missing', () => {
    const job = { addressLocality: 'Lausanne', postalCode: '1003' };
    const out = enrichJobLocation(job);
    expect(out.jobLocation).toEqual({
      addressLocality: 'Lausanne',
      postalCode: '1003',
      addressCountry: 'CH',
    });
  });

  it('leaves jobLocation undefined when addressLocality is missing', () => {
    const job = { postalCode: '6900' };
    const out = enrichJobLocation(job);
    expect(out.jobLocation).toBeUndefined();
  });

  it('leaves jobLocation undefined when postalCode is missing', () => {
    const job = { addressLocality: 'Lugano' };
    const out = enrichJobLocation(job);
    expect(out.jobLocation).toBeUndefined();
  });

  it('returns a NEW object (immutability)', () => {
    const job = { addressLocality: 'Lugano', postalCode: '6900' };
    const out = enrichJobLocation(job);
    expect(out).not.toBe(job);
    expect(job.jobLocation).toBeUndefined();
  });
});

describe('enrichStreetAddress', () => {
  it('leaves a non-empty streetAddress untouched', () => {
    const job = { streetAddress: 'Via Test 1', addressLocality: 'Lugano' };
    const out = enrichStreetAddress(job);
    expect(out.streetAddress).toBe('Via Test 1');
  });

  it('falls back to addressLocality when streetAddress is absent', () => {
    const job = { addressLocality: 'Lugano' };
    const out = enrichStreetAddress(job);
    expect(out.streetAddress).toBe('Lugano');
  });

  it('falls back to addressLocality when streetAddress is empty string', () => {
    const job = { streetAddress: '', addressLocality: 'Bern' };
    const out = enrichStreetAddress(job);
    expect(out.streetAddress).toBe('Bern');
  });

  it('leaves streetAddress undefined when both sources are missing', () => {
    const job = { id: 'x' };
    const out = enrichStreetAddress(job);
    expect(out.streetAddress).toBeUndefined();
  });

  it('returns a NEW object (immutability)', () => {
    const job = { addressLocality: 'Lugano' };
    const out = enrichStreetAddress(job);
    expect(out).not.toBe(job);
    expect(job.streetAddress).toBeUndefined();
  });
});

describe('enrichJobForSeo', () => {
  it('applies all four enrichments in sequence', () => {
    const job = {
      id: 'x',
      company: 'Vaudoise',
      addressLocality: 'Lausanne',
      postalCode: '1003',
      postedDate: '17/04/26',
    };
    const out = enrichJobForSeo(job);
    expect(out.hiringOrganization).toEqual({ name: 'Vaudoise' });
    expect(out.datePosted).toBe('2026-04-17');
    expect(out.jobLocation).toEqual({
      addressLocality: 'Lausanne',
      postalCode: '1003',
      addressCountry: 'CH',
    });
    expect(out.streetAddress).toBe('Lausanne');
  });

  it('does not mutate the input job', () => {
    const job = {
      id: 'x',
      company: 'Vaudoise',
      addressLocality: 'Lausanne',
      postalCode: '1003',
      postedDate: '17/04/26',
    };
    const before = JSON.stringify(job);
    enrichJobForSeo(job);
    expect(JSON.stringify(job)).toBe(before);
  });
});
