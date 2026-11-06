import { afterEach, describe, it, expect, vi } from 'vitest';
import { clearPoliteFetchStateForTests } from '../scripts/lib/prospector/polite-fetch.mjs';
import { loadSpec, runSpecInProduction } from '../scripts/lib/prospector/spec-crawler.mjs';
import {
  CSL_IMMOBILIEN_AG_KEY,
  CSL_IMMOBILIEN_AG_COMPANY_NAME,
  isCslImmobilienAgJob,
  isTrustedDomain,
} from '../scripts/lib/csl-immobilien-ag-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

function response(url: string, body: string) {
  return {
    ok: true,
    status: 200,
    url,
    headers: { get: () => null },
    body: { cancel: vi.fn() },
    text: async () => body,
    clone: () => response(url, body),
  } as any;
}

afterEach(() => clearPoliteFetchStateForTests());

describe('CSL Immobilien AG crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(CSL_IMMOBILIEN_AG_KEY).toBe('csl-immobilien-ag');
    expect(CSL_IMMOBILIEN_AG_COMPANY_NAME).toBe('CSL Immobilien AG');
  });

  // ── isCompanyJob ──
  describe('isCslImmobilienAgJob', () => {
    it('matches by companyKey', () => {
      expect(isCslImmobilienAgJob({ companyKey: 'csl-immobilien-ag' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isCslImmobilienAgJob({ company: 'CSL Immobilien AG' })).toBe(true);
    });

    it('matches by the employer-specific tenant path', () => {
      expect(isCslImmobilienAgJob({
        url: 'https://app.jobportal.abaservices.ch/job-advertisement/cslimmobilien/bbd3d75a-b43f-7a18-7bde-02cdebbadb22?jp=ABACUS',
      })).toBe(true);
    });

    it('rejects an unrelated posting on the shared Abaservices host', () => {
      expect(isCslImmobilienAgJob({
        companyKey: 'other-company',
        company: 'Other AG',
        url: 'https://app.jobportal.abaservices.ch/job-advertisement/other-employer/38316cd1-2655-177d-5ac2-49bfb8252c24',
      })).toBe(false);
    });

    it('rejects unrelated jobs', () => {
      expect(isCslImmobilienAgJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isCslImmobilienAgJob(null)).toBe(false);
      expect(isCslImmobilienAgJob(undefined)).toBe(false);
      expect(isCslImmobilienAgJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://app.jobportal.abaservices.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.app.jobportal.abaservices.ch/job/456')).toBe(true);
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
      expect(slugify('Developer csl-immobilien-ag ch')).toBe('developer-csl-immobilien-ag-ch');
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
      id: 'csl-immobilien-ag-abc123',
      slug: 'test-position-csl-immobilien-ag-ch',
      slugByLocale: { de: 'test-position-csl-immobilien-ag-ch' },
      company: 'CSL Immobilien AG',
      companyKey: 'csl-immobilien-ag',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://app.jobportal.abaservices.ch/jobs/test',
      source: 'CSL Immobilien AG Dedicated Parser',
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
      expect(validJob.id).toMatch(/^csl-immobilien-ag-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });

  describe('live source spec', () => {
    it('discovers current ATS vacancies from the official career page', async () => {
      const spec = loadSpec(CSL_IMMOBILIEN_AG_KEY);
      expect(spec.seedUrls).toEqual(['https://csl-immobilien.ch/karriere/']);
      expect(spec.detailTemplate).toBe('/job-advertisement/cslimmobilien/*');
      expect(spec.allowedDetailOrigins).toContain('https://app.jobportal.abaservices.ch/');
      expect(spec.detailEnrichment).toBe(true);

      const detailUrl = 'https://app.jobportal.abaservices.ch/job-advertisement/cslimmobilien/7fdb40d6-c3ba-5548-b8ad-e55232c8a90b?jp=ABACUS';
      const listingHtml = `<a href="${detailUrl}">Sachbearbeiter Immobilienbewirtschaftung (M/W/D) 100%</a>`;
      const detailHtml = `<script type="application/ld+json">${JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'JobPosting',
        url: detailUrl,
        title: 'Sachbearbeiter Immobilienbewirtschaftung (M/W/D) 100%',
        description: 'CSL Immobilien sucht eine engagierte Persönlichkeit für die Bewirtschaftung eines abwechslungsreichen Portfolios. Die Stelle umfasst die Organisation von Besichtigungen, die Bearbeitung von Mietverträgen, die Zusammenarbeit mit Mietern und Handwerkern sowie die Unterstützung des Teams im täglichen Geschäft.',
        datePosted: '2026-10-28',
        employmentType: 'FULL_TIME',
        hiringOrganization: { '@type': 'Organization', name: 'CSL Immobilien AG' },
        jobLocation: {
          '@type': 'Place',
          address: {
            '@type': 'PostalAddress',
            streetAddress: 'Schärenmoosstrasse 77',
            postalCode: '8052',
            addressLocality: 'Zürich',
            addressRegion: 'ZH',
            addressCountry: 'CH',
          },
        },
      })}</script>`;
      const fetchImpl = vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith('/robots.txt')) return response(url, 'User-agent: *\nAllow: /');
        if (url === spec.seedUrls[0]) return response(url, listingHtml);
        if (url === detailUrl) return response(url, detailHtml);
        throw new Error(`unexpected URL ${url}`);
      });

      const rows = await runSpecInProduction(spec, {
        fetchImpl,
        lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
        sleepImpl: async () => {},
        retries: 0,
      });

      expect(rows).toEqual([expect.objectContaining({
        url: detailUrl,
        title: 'Sachbearbeiter Immobilienbewirtschaftung (M/W/D) 100%',
        addressLocality: 'Zürich',
        addressRegion: 'ZH',
        addressCountry: 'CH',
        canton: 'ZH',
      })]);
    });
  });
});
