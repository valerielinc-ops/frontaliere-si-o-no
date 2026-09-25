/**
 * Persist-time repair of `company` values that are a slice of the job
 * DESCRIPTION rather than the employer name.
 *
 * The extraction bug was fixed upstream on 2026-07-27 (`looksLikeShortLabelValue`
 * in scripts/lib/shared-jobs-crawler.mjs, #4810), but 37 records crawled between
 * 2026-07-06 and 2026-07-21 kept the bad value: a job is only rewritten when it
 * is re-crawled. `company` feeds the job page's structured-data
 * `hiringOrganization.name` (AGENTS.md Non-Negotiable #3), so this net repairs
 * the stale ones and closes the class for every other parser.
 *
 * The values below are verbatim from the live dataset.
 */
import { describe, expect, it } from 'vitest';
import { sanitizeJobCompanyField, normalizeParsedJobsForSlice } from '../scripts/assemble-jobs-dataset.mjs';

const CORRUPTED = [
  'al and prioritisation skills. Customer Focus: A customer-centric mindset, always prioritising the needs of our',
  '). Vorab erhältst du einen Überblick über Ablauf und Lernziele – so weißt du immer, was dich erwartet und was du',
  '. Ready to make the change? If this sounds like the kind of work that would challenge you, grow you and give y',
];

// Real employers from the same dataset. A false positive here would erase a
// genuine name from a live job page, so each is asserted individually.
const LEGITIMATE = [
  'EOC – Ente Ospedaliero Cantonale',
  'A++ Group',
  'asana Spital AG (Menziken / Leuggern)',
  'tl (Transports publics de la région lausannoise)',
  'KSML — Kantonaler Stellenmarkt für Lehrerinnen und Lehrer (Kanton Bern)',
  'IKEA',
  'SUPSI / DTI',
  'Città di Mendrisio',
  "McDonald's Switzerland",
  'Ferrovia Retica (RhB)',
];

describe('sanitizeJobCompanyField', () => {
  it.each(CORRUPTED)('replaces the description fragment %#', (value) => {
    expect(sanitizeJobCompanyField(value, 'Zurich Insurance Sede Ticino')).toBe('Zurich Insurance Sede Ticino');
  });

  it.each(LEGITIMATE)('leaves the real employer "%s" untouched', (value) => {
    expect(sanitizeJobCompanyField(value, 'FALLBACK')).toBe(value);
  });

  it('drops the value rather than keeping prose when no fallback is available', () => {
    expect(sanitizeJobCompanyField(CORRUPTED[0])).toBe('');
  });

  it('rejects control, bidi and zero-width characters anywhere', () => {
    expect(sanitizeJobCompanyField('Acme‮Corp', 'FALLBACK')).toBe('FALLBACK');
    expect(sanitizeJobCompanyField('Acme​Corp', 'FALLBACK')).toBe('FALLBACK');
  });

  it('handles empty and non-string input without throwing', () => {
    expect(sanitizeJobCompanyField('', 'FALLBACK')).toBe('FALLBACK');
    expect(() => sanitizeJobCompanyField(undefined as unknown as string)).not.toThrow();
    expect(() => sanitizeJobCompanyField(null as unknown as string)).not.toThrow();
  });
});

describe('normalizeParsedJobsForSlice — company repair', () => {
  it('repairs a corrupted company from the record companyKey', () => {
    const jobs = [{
      company: CORRUPTED[0],
      companyKey: 'zurich-insurance-sede-ticino',
      location: 'Zürich',
    }];
    normalizeParsedJobsForSlice(jobs);
    expect(jobs[0].company).toBe('Zurich Insurance Sede Ticino');
  });

  it('leaves a healthy record alone', () => {
    const jobs = [{ company: 'EOC – Ente Ospedaliero Cantonale', companyKey: 'eoc', location: 'Lugano' }];
    normalizeParsedJobsForSlice(jobs);
    expect(jobs[0].company).toBe('EOC – Ente Ospedaliero Cantonale');
  });
});
