import { describe, it, expect, vi } from 'vitest';
import { runSpecInProduction } from '../scripts/lib/prospector/spec-crawler.mjs';
import {
  REHAKLINIK_SEEWIS_KEY,
  REHAKLINIK_SEEWIS_COMPANY_NAME,
  fetchAllRehaklinikSeewisJobs,
  isRehaklinikSeewisJob,
  isTrustedDomain,
} from '../scripts/lib/rehaklinik-seewis-job-parser.mjs';
import {
  resolveSourceBackedSwissGeography,
  sourceBackedSwissGeographyFields,
} from '../scripts/lib/prospector/location-evidence.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

vi.mock('../scripts/lib/prospector/spec-crawler.mjs', () => ({
  loadSpec: vi.fn(() => ({})),
  runSpecInProduction: vi.fn(async () => []),
}));

describe('Kurhaus crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(REHAKLINIK_SEEWIS_KEY).toBe('rehaklinik-seewis');
    expect(REHAKLINIK_SEEWIS_COMPANY_NAME).toBe('Kurhaus');
  });

  // ── isCompanyJob ──
  describe('isRehaklinikSeewisJob', () => {
    it('matches by companyKey', () => {
      expect(isRehaklinikSeewisJob({ companyKey: 'rehaklinik-seewis' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isRehaklinikSeewisJob({ company: 'Kurhaus' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isRehaklinikSeewisJob({ url: 'https://vitrea-gesundheit.ch/jobs/123' })).toBe(true);
    });

    it('rejects a URL whose hostname only contains the domain as a suffix', () => {
      expect(isRehaklinikSeewisJob({
        url: 'https://vitrea-gesundheit.ch.evil.invalid/job',
        company: 'Other',
      })).toBe(false);
    });

    it('rejects unrelated jobs', () => {
      expect(isRehaklinikSeewisJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isRehaklinikSeewisJob(null)).toBe(false);
      expect(isRehaklinikSeewisJob(undefined)).toBe(false);
      expect(isRehaklinikSeewisJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://vitrea-gesundheit.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.vitrea-gesundheit.ch/job/456')).toBe(true);
    });

    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
    });

    it('handles invalid URLs', () => {
      expect(isTrustedDomain('')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  it('carries resolver-backed postal and street evidence into the published geography', () => {
    const resolved = resolveSourceBackedSwissGeography({
      location: 'Chur, GR',
      addressLocality: 'Chur',
      addressRegion: 'GR',
      addressCountry: 'CH',
      postalCode: '7212',
      streetAddress: 'Via fonte',
    });
    const listingWithoutAddressFields = { location: 'Chur, GR', addressCountry: 'CH' };
    const geography = sourceBackedSwissGeographyFields(listingWithoutAddressFields, resolved);

    expect(geography).toMatchObject({ postalCode: '7212', streetAddress: 'Via fonte' });
  });

  it('publishes a complete source-locality address when a valid Swiss listing omits postal and street fields', async () => {
    vi.mocked(runSpecInProduction).mockResolvedValueOnce([{
      title: 'Oberarzt Orthopädie',
      location: 'Chur, GR',
      addressCountry: 'CH',
      description: '<p>Behandlung und Betreuung der Patientinnen und Patienten.</p>',
      url: 'https://www.vitrea-gesundheit.ch/de/karriere/aerztinnenaerzte/oberarzt-orthopaedie',
    }]);

    const jobs = await fetchAllRehaklinikSeewisJobs();

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      addressLocality: 'Chur',
      addressRegion: 'GR',
      postalCode: '7000',
    });
    expect(jobs[0].streetAddress).toBeTruthy();
  });

  it('uses the canton-scoped official postal directory for a valid locality absent from the narrow city table', async () => {
    vi.mocked(runSpecInProduction).mockResolvedValueOnce([{
      title: 'Physiotherapeutin',
      location: 'Andeer, GR',
      addressCountry: 'CH',
      description: '<p>Therapie und Betreuung der Patientinnen und Patienten.</p>',
      url: 'https://www.vitrea-gesundheit.ch/de/karriere/physiotherapie/andeer',
    }]);

    const jobs = await fetchAllRehaklinikSeewisJobs();

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      addressLocality: 'Andeer',
      addressRegion: 'GR',
      postalCode: '7440',
      streetAddress: 'Andeer',
    });
  });

  it('keeps a valid source-backed locality when the locality resolver only has a canton-capital fallback', async () => {
    vi.mocked(runSpecInProduction).mockResolvedValueOnce([{
      title: 'Pflegefachperson',
      location: 'Seewis Dorf, GR',
      addressCountry: 'CH',
      description: '<p>Pflege und Betreuung in der Rehaklinik.</p>',
      url: 'https://www.vitrea-gesundheit.ch/de/karriere/pflege/seewis-dorf',
    }]);

    const jobs = await fetchAllRehaklinikSeewisJobs();

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      addressLocality: 'Seewis Dorf',
      addressRegion: 'GR',
      postalCode: '7212',
      streetAddress: 'Seewis Dorf',
    });
  });

  // ── slugify (imported from crawler-template) ──
  describe('slugify', () => {
    it('converts title to URL-safe slug', () => {
      const slug = slugify('Software Engineer (m/f/d)');
      expect(slug).toBe('software-engineer-m-f-d');
    });

    it('strips diacritics', () => {
      expect(slugify('Ingénieur qualité')).toBe('ingenieur-qualite');
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('Developer rehaklinik-seewis ch')).toBe('developer-rehaklinik-seewis-ch');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    // A minimal valid job for reference
    const validJob = {
      id: 'rehaklinik-seewis-abc123',
      slug: 'test-position-rehaklinik-seewis-ch',
      slugByLocale: { de: 'test-position-rehaklinik-seewis-ch' },
      company: 'Kurhaus',
      companyKey: 'rehaklinik-seewis',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://vitrea-gesundheit.ch/jobs/test',
      source: 'Kurhaus Dedicated Parser',
      sourceLang: 'de',
      crawledAt: new Date().toISOString(),
    };

    it('has all required fields', () => {
      const required = [
        'id', 'slug', 'slugByLocale', 'company', 'companyKey',
        'title', 'titleByLocale', 'description', 'descriptionByLocale',
        'location', 'canton', 'url', 'source', 'sourceLang', 'crawledAt',
      ];
      for (const field of required) {
        expect(validJob).toHaveProperty(field);
      }
    });

    it('slug only contains source locale', () => {
      const locales = Object.keys(validJob.slugByLocale);
      expect(locales).toHaveLength(1);
      expect(locales[0]).toBe(validJob.sourceLang);
    });

    it('id starts with company key', () => {
      expect(validJob.id).toMatch(/^rehaklinik-seewis-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
