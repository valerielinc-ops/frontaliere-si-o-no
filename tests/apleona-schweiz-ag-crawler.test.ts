import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import {
  APLEONA_SCHWEIZ_AG_KEY,
  APLEONA_SCHWEIZ_AG_COMPANY_NAME,
  extractApleonaDetailFields,
  fetchAllApleonaSchweizAgJobs,
  isApleonaSchweizAgJob,
  isTrustedDomain,
} from '../scripts/lib/apleona-schweiz-ag-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';
import { clearPoliteFetchStateForTests } from '../scripts/lib/prospector/polite-fetch.mjs';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'apleona');
const fixture = (name: string) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

function response(url: string, body: string) {
  return {
    ok: true,
    status: 200,
    url,
    headers: { get: () => null },
    body: { cancel: vi.fn() },
    text: async () => body,
  } as any;
}

describe('Apleona Schweiz AG crawler parser', () => {
  beforeEach(() => clearPoliteFetchStateForTests());

  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(APLEONA_SCHWEIZ_AG_KEY).toBe('apleona-schweiz-ag');
    expect(APLEONA_SCHWEIZ_AG_COMPANY_NAME).toBe('Apleona Schweiz AG');
  });

  // ── isCompanyJob ──
  describe('isApleonaSchweizAgJob', () => {
    it('matches by companyKey', () => {
      expect(isApleonaSchweizAgJob({ companyKey: 'apleona-schweiz-ag' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isApleonaSchweizAgJob({ company: 'Apleona Schweiz AG' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isApleonaSchweizAgJob({ url: 'https://recruitingapp-2765.umantis.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isApleonaSchweizAgJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isApleonaSchweizAgJob(null)).toBe(false);
      expect(isApleonaSchweizAgJob(undefined)).toBe(false);
      expect(isApleonaSchweizAgJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://recruitingapp-2765.umantis.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.recruitingapp-2765.umantis.com/job/456')).toBe(true);
    });

    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
    });

    it('handles invalid URLs', () => {
      expect(isTrustedDomain('')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
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
      expect(slugify('Developer apleona-schweiz-ag ch')).toBe('developer-apleona-schweiz-ag-ch');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  describe('Apleona detail boundary', () => {
    it('keeps vacancy sections and hero location without page chrome', () => {
      const detail = extractApleonaDetailFields(
        fixture('detail-servicetechniker.html'),
        'https://recruitingapp-2765.umantis.com/Vacancies/2553/Description/1',
      );
      expect(detail.title).toBe('Servicetechniker Lüftung (m/w/d)');
      expect(detail.locationCandidates).toEqual([expect.objectContaining({
        location: 'Bischofszell',
        addressLocality: 'Bischofszell',
      })]);
      expect(detail.description).toContain('Aufgaben\n• Sicherstellung des Betriebs');
      expect(detail.description).toContain('Anforderungen\n• Abgeschlossene Berufsausbildung');
      expect(detail.description).not.toContain('Stellenmarkt Unternehmen Kontakt');
      expect(detail.description).not.toContain('Recruiting Kontakt und Personaldienstleister');
      expect(detail.description.split(/\s+/).filter(Boolean).length).toBeGreaterThan(50);
    });

    it('keeps job-specific bodies distinct even when benefits are shared', () => {
      const technical = extractApleonaDetailFields(fixture('detail-servicetechniker.html')).description;
      const property = extractApleonaDetailFields(fixture('detail-immobilien.html')).description;
      expect(technical).not.toBe(property);
      expect(technical).toContain('technischen Anlagen');
      expect(property).toContain('Immobilienportfolios');
      expect(technical).toContain('Fortschrittliche Anstellungsbedingungen');
      expect(property).toContain('Fortschrittliche Anstellungsbedingungen');
    });

    it('separates an official canton suffix from the Apleona hero locality', () => {
      const detail = extractApleonaDetailFields(
        fixture('detail-hero-sections.html'),
      );
      expect(detail.title).toBe('Sachbearbeiter Immobilienbewirtschaftung (m/w/d)');
      expect(detail.locationCandidates).toEqual([expect.objectContaining({
        location: 'Köniz-Liebefeld',
        addressLocality: 'Köniz-Liebefeld',
        addressRegion: '',
        addressCountry: 'CH',
      })]);
      expect(detail.description).toContain('Deine Aufgaben\n• Du unterstützt die Bewirtschaftung');
      expect(detail.description).toContain('Deine Anforderungen\n• Du verfügst über eine kaufmännische');
      expect(detail.description).not.toContain('Recruiting Kontakt und Personaldienstleister');
    });

    it('rejects a canton suffix that fails independent verification without leaking the raw string', () => {
      const detail = extractApleonaDetailFields(
        fixture('detail-canton-mismatch.html'),
      );
      // Lugano independently resolves to TI, not the declared ZH suffix: the
      // tenant-specific gate must refuse the candidate.
      expect(detail.locationCandidates).toEqual([]);
      expect(detail.location).toBe('');
      expect(detail.addressLocality).toBe('');
      expect(detail.addressCountry).toBe('');
      // The rejection must be signalled explicitly so the shared resolver
      // (locationEvidenceCandidates' raw fallback, and the generic Umantis
      // re-derivation in spec-crawler.mjs) cannot re-derive a location for
      // this row from a candidate this tenant gate already refused.
      expect(detail.locationGateRejected).toBe(true);
      expect(detail.description).toContain('technische Anlagen');
    });

    it('fails closed when only shared benefits and contact chrome remain', () => {
      const detail = extractApleonaDetailFields(fixture('detail-degraded.html'));
      expect(detail.description).toBe('');
      expect(detail.locationCandidates).toEqual([expect.objectContaining({
        location: 'Wallisellen',
      })]);
    });

    it('publishes rich unique vacancies, quarantines degraded detail and preserves identity', async () => {
      const seed = 'https://recruitingapp-2765.umantis.com/Jobs/1?lang=ger&ContentOnly=&message=';
      const technicalUrl = 'https://recruitingapp-2765.umantis.com/Vacancies/2553/Description/1';
      const propertyUrl = 'https://recruitingapp-2765.umantis.com/Vacancies/2548/Description/1';
      const degradedUrl = 'https://recruitingapp-2765.umantis.com/Vacancies/2554/Description/1';
      const listing = `
        <a href="/Vacancies/2553/Description/1">Servicetechniker Lüftung (m/w/d)</a>
        <a href="/Vacancies/2553/Description/1">Servicetechniker Lüftung (m/w/d)</a>
        <a href="/Vacancies/2548/Description/1">Immobilienbewirtschafter (m/w/d)</a>
        <a href="/Vacancies/2554/Description/1">Degraded Vacancy (m/w/d)</a>`;
      const requested: string[] = [];
      const fetchImpl = vi.fn(async (url: string) => {
        requested.push(url);
        if (url === 'https://recruitingapp-2765.umantis.com/robots.txt') {
          return response(url, 'User-agent: *\nAllow: /');
        }
        if (url === seed) return response(url, listing);
        if (url === technicalUrl) return response(url, fixture('detail-servicetechniker.html'));
        if (url === propertyUrl) return response(url, fixture('detail-immobilien.html'));
        if (url === degradedUrl) return response(url, fixture('detail-degraded.html'));
        throw new Error(`unexpected URL ${url}`);
      });

      const jobs = await fetchAllApleonaSchweizAgJobs({
        fetchImpl,
        lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
        sleepImpl: async () => {},
        retries: 0,
      });

      expect(jobs).toHaveLength(2);
      expect(jobs.map((job) => job.url)).toEqual([technicalUrl, propertyUrl]);
      expect(jobs.map((job) => job.location)).toEqual(['Bischofszell', 'Wallisellen']);
      expect(jobs.map((job) => job.canton)).toEqual(['TG', 'ZH']);
      expect(new Set(jobs.map((job) => job.description)).size).toBe(2);
      expect(new Set(jobs.map((job) => job.id)).size).toBe(2);
      expect(new Set(jobs.map((job) => job.slug)).size).toBe(2);
      for (const job of jobs) {
        const hash = createHash('sha1').update(job.url).digest('hex').slice(0, 12);
        expect(job.id).toBe(`apleona-schweiz-ag-${hash}`);
        expect(job.slug).toBe(slugify(`${job.title} apleona-schweiz-ag ${job.location}`));
        expect(job.descriptionByLocale[job.sourceLang]).toBe(job.description);
        expect(job.description.split(/\s+/).filter(Boolean).length).toBeGreaterThan(50);
      }
      expect(requested.filter((url) => url === technicalUrl)).toHaveLength(1);
      expect(requested).toContain(degradedUrl);
    });

    it('drops a rejected-canton row end-to-end instead of publishing a generically re-derived location', async () => {
      const seed = 'https://recruitingapp-2765.umantis.com/Jobs/1?lang=ger&ContentOnly=&message=';
      const mismatchUrl = 'https://recruitingapp-2765.umantis.com/Vacancies/2555/Description/1';
      const listing = `<a href="/Vacancies/2555/Description/1">Objektbetreuer Facility Management (m/w/d)</a>`;
      const fetchImpl = vi.fn(async (url: string) => {
        if (url === 'https://recruitingapp-2765.umantis.com/robots.txt') {
          return response(url, 'User-agent: *\nAllow: /');
        }
        if (url === seed) return response(url, listing);
        if (url === mismatchUrl) return response(url, fixture('detail-canton-mismatch.html'));
        throw new Error(`unexpected URL ${url}`);
      });

      const jobs = await fetchAllApleonaSchweizAgJobs({
        fetchImpl,
        lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
        sleepImpl: async () => {},
        retries: 0,
      });

      // The declared ZH suffix does not independently resolve for Lugano
      // (which is TI): the row must be quarantined, not published with the
      // raw string or a generic re-derivation of a different canton.
      expect(jobs).toHaveLength(0);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    // A minimal valid job for reference
    const validJob = {
      id: 'apleona-schweiz-ag-abc123',
      slug: 'test-position-apleona-schweiz-ag-ch',
      slugByLocale: { de: 'test-position-apleona-schweiz-ag-ch' },
      company: 'Apleona Schweiz AG',
      companyKey: 'apleona-schweiz-ag',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://recruitingapp-2765.umantis.com/jobs/test',
      source: 'Apleona Schweiz AG Dedicated Parser',
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
      expect(validJob.id).toMatch(/^apleona-schweiz-ag-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
