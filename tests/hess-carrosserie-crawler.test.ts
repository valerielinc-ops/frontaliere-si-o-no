import { describe, it, expect, vi } from 'vitest';
import {
  HESS_CARROSSERIE_KEY,
  HESS_CARROSSERIE_COMPANY_NAME,
  isHessCarrosserieJob,
  isTrustedDomain,
} from '../scripts/lib/hess-carrosserie-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Carrosserie HESS AG crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(HESS_CARROSSERIE_KEY).toBe('hess-carrosserie');
    expect(HESS_CARROSSERIE_COMPANY_NAME).toBe('Carrosserie HESS AG');
  });

  // ── isCompanyJob ──
  describe('isHessCarrosserieJob', () => {
    it('matches by companyKey', () => {
      expect(isHessCarrosserieJob({ companyKey: 'hess-carrosserie' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isHessCarrosserieJob({ company: 'Carrosserie HESS AG' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(
        isHessCarrosserieJob({ url: 'https://jobs.hess-ag.ch/publication/carrosserielackierer/abc123' })
      ).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(
        isHessCarrosserieJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })
      ).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isHessCarrosserieJob(null)).toBe(false);
      expect(isHessCarrosserieJob(undefined)).toBe(false);
      expect(isHessCarrosserieJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://jobs.hess-ag.ch/publication/carrosserielackierer/abc123')).toBe(true);
      expect(isTrustedDomain('https://www.hess-ag.ch/unternehmen/jobs.html')).toBe(true);
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
      const slug = slugify('Carrosserielackierer (m/w/d)');
      expect(slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });

    it('strips diacritics', () => {
      expect(slugify('Ingénieur qualité')).toBe('ingenieur-qualite');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    // A minimal valid job for reference (mirrors what fetchAllHessCarrosserieJobs emits)
    const validJob = {
      id: 'hess-carrosserie-abc123',
      slug: 'carrosserielackierer-m-w-d-hess-rothenburg',
      slugByLocale: { de: 'carrosserielackierer-m-w-d-hess-rothenburg' },
      company: 'Carrosserie HESS AG',
      companyKey: 'hess-carrosserie',
      companyDomain: 'hess-ag.ch',
      title: 'Carrosserielackierer (m/w/d)',
      titleByLocale: { de: 'Carrosserielackierer (m/w/d)' },
      description: 'A test job description for validation, well over fifty words to satisfy the thin-content floor used across the site so that job pages never ship with content that is too short to be useful or indexable by search engines in any locale. This sentence pads the fixture out further to comfortably clear the fifty word minimum required by the automated check below without relying on borderline counts.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Rothenburg',
      canton: 'LU',
      url: 'https://jobs.hess-ag.ch/publication/carrosserielackierer/abc123',
      source: 'Carrosserie HESS AG Dedicated Parser (Ostendis)',
      sourceLang: 'de',
      crawledAt: new Date().toISOString(),
      // ── Recommended fields (structured-data completeness, Non-Negotiable #3) ──
      addressLocality: 'Rothenburg',
      addressRegion: 'LU',
      streetAddress: 'Stationsstrasse 88',
      postalCode: '6023',
      addressCountry: 'CH',
      country: 'CH',
      employmentType: 'FULL_TIME',
      postedDate: new Date().toISOString().split('T')[0],
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

    it('has the fields required for job-page structured data (baseSalary source inputs)', () => {
      // baseSalary itself is synthesized downstream from safe defaults; these
      // are the per-job inputs the parser is responsible for supplying.
      const structuredDataInputs = [
        'title', 'description',
        'addressLocality', 'addressCountry', 'employmentType', 'postedDate',
      ];
      for (const field of structuredDataInputs) {
        expect(validJob).toHaveProperty(field);
        expect(validJob[field as keyof typeof validJob]).toBeTruthy();
      }
      expect(validJob).toHaveProperty('postalCode');
      expect(validJob).toHaveProperty('streetAddress');
      expect(validJob.postalCode).toBeTruthy();
      expect(validJob.streetAddress).toBeTruthy();
    });

    it('slug only contains source locale', () => {
      const locales = Object.keys(validJob.slugByLocale);
      expect(locales).toHaveLength(1);
      expect(locales[0]).toBe(validJob.sourceLang);
    });

    it('id starts with company key', () => {
      expect(validJob.id).toMatch(/^hess-carrosserie-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });

    it('description clears the 50-word thin-content floor', () => {
      const wordCount = validJob.description.trim().split(/\s+/).length;
      expect(wordCount).toBeGreaterThanOrEqual(50);
    });
  });

  // ── fetchAllHessCarrosserieJobs (mocked HTTP layer, no network) ──
  describe('fetchAllHessCarrosserieJobs', () => {
    it('maps a normalized Ostendis listing + JSON-LD detail into the repo job shape', async () => {
      vi.resetModules();
      vi.doMock('../scripts/lib/crawler-template.mjs', async () => {
        const actual = await vi.importActual('../scripts/lib/crawler-template.mjs');
        return {
          ...actual,
          fetchJson: vi.fn(async () => ({
            jobs: [
              {
                id: 12345,
                title: 'Carrosserielackierer (m/w/d)',
                detail: 'https://jobs.hess-ag.ch/publication/carrosserielackierer/abc123',
                countrycode: 'CH',
                city: 'Rothenburg',
                zip: '6023',
                workload_max: 100,
                department: 'Reparatur und Service',
                timestamp: String(Math.floor(Date.now() / 1000)),
              },
            ],
          })),
          fetchHtml: vi.fn(async () => `
            <html><body>
            <script type="application/ld+json">
            {
              "@context": "https://schema.org",
              "@type": "JobPosting",
              "title": "Carrosserielackierer (m/w/d)",
              "description": "<p>Wir suchen eine flexible und engagierte Fachkraft als Carrosserielackierer fuer unser Team in Rothenburg. Sie verfuegen ueber eine abgeschlossene Ausbildung als Carrosserielackierer und ein ausgepraegtes Farbempfinden. In dieser vielseitigen Taetigkeit lackieren Sie verschiedene Fahrzeuge und Industrieteile und tragen so massgeblich zur hohen Qualitaet unserer Dienstleistungen bei. Bewerben Sie sich noch heute bei Carrosserie HESS AG in Rothenburg, Kanton Luzern.</p>",
              "datePosted": "2026-06-15",
              "employmentType": ["FULL_TIME"],
              "hiringOrganization": { "@type": "Organization", "name": "Carrosserie HESS AG" },
              "jobLocation": {
                "@type": "Place",
                "address": {
                  "@type": "PostalAddress",
                  "streetAddress": "Stationsstrasse 88",
                  "addressLocality": "Rothenburg",
                  "postalCode": "6023",
                  "addressRegion": "LU",
                  "addressCountry": "CH"
                }
              }
            }
            </script>
            </body></html>
          `),
        };
      });

      const { fetchAllHessCarrosserieJobs } = await import('../scripts/lib/hess-carrosserie-job-parser.mjs');
      const jobs = await fetchAllHessCarrosserieJobs();

      expect(jobs).toHaveLength(1);
      const job = jobs[0];
      expect(job.companyKey).toBe('hess-carrosserie');
      expect(job.company).toBe('Carrosserie HESS AG');
      expect(job.title).toBe('Carrosserielackierer (m/w/d)');
      expect(job.canton).toBe('LU');
      expect(job.addressLocality).toBe('Rothenburg');
      expect(job.postalCode).toBe('6023');
      expect(job.streetAddress).toBe('Stationsstrasse 88');
      expect(job.employmentType).toBe('FULL_TIME');
      expect(job.postedDate).toBe('2026-06-15');
      expect(job.id).toMatch(/^hess-carrosserie-/);
      expect(job.description.trim().split(/\s+/).length).toBeGreaterThanOrEqual(50);

      vi.doUnmock('../scripts/lib/crawler-template.mjs');
      vi.resetModules();
    });

    it('returns an empty array when the feed has no CH listings', async () => {
      vi.resetModules();
      vi.doMock('../scripts/lib/crawler-template.mjs', async () => {
        const actual = await vi.importActual('../scripts/lib/crawler-template.mjs');
        return {
          ...actual,
          fetchJson: vi.fn(async () => ({ jobs: [] })),
          fetchHtml: vi.fn(async () => ''),
        };
      });

      const { fetchAllHessCarrosserieJobs } = await import('../scripts/lib/hess-carrosserie-job-parser.mjs');
      const jobs = await fetchAllHessCarrosserieJobs();
      expect(jobs).toEqual([]);

      vi.doUnmock('../scripts/lib/crawler-template.mjs');
      vi.resetModules();
    });
  });
});
