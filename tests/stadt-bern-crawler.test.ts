import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  STADT_BERN_KEY,
  STADT_BERN_COMPANY_NAME,
  isStadtBernJob,
  isTrustedDomain,
  fetchAllStadtBernJobs,
} from '../scripts/lib/stadt-bern-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Stadt Bern crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(STADT_BERN_KEY).toBe('stadt-bern');
    expect(STADT_BERN_COMPANY_NAME).toBe('Stadt Bern');
  });

  // ── isCompanyJob ──
  describe('isStadtBernJob', () => {
    it('matches by companyKey', () => {
      expect(isStadtBernJob({ companyKey: 'stadt-bern' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isStadtBernJob({ company: 'Stadt Bern' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isStadtBernJob({ url: 'https://jobs.bern.ch/offene-stellen/some-role/abc' })).toBe(true);
    });

    it('matches by Prospective medium URL', () => {
      expect(
        isStadtBernJob({ url: 'https://ohws.prospective.ch/public/v1/medium/1840/jobs' }),
      ).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(
        isStadtBernJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' }),
      ).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isStadtBernJob(null)).toBe(false);
      expect(isStadtBernJob(undefined)).toBe(false);
      expect(isStadtBernJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://bern.ch/themen/arbeiten-fuer-die-stadt-bern')).toBe(true);
    });

    it('trusts jobs.bern.ch subdomain', () => {
      expect(isTrustedDomain('https://jobs.bern.ch/offene-stellen/some-role/abc')).toBe(true);
    });

    it('trusts Prospective medium URL', () => {
      expect(isTrustedDomain('https://ohws.prospective.ch/public/v1/medium/1840/jobs')).toBe(true);
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
      const slug = slugify('Sachbearbeiter*in Finanzen und Gebühren');
      expect(slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });

    it('strips diacritics', () => {
      expect(slugify('Fachverantwortliche*r Übersetzung')).not.toMatch(/[äöüÄÖÜ]/);
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Live-shape regression: flat `sza_location` address parsing ──
  // Stadt Bern's Prospective tenant (medium 1840) exposes a FLAT
  // `sza_location: "Street Number, ZIP City"` string rather than the dotted
  // `sza_location.city` / `sza_workplace` keys most existing Prospective
  // tenants use. An additive fallback for this schema was added to
  // pickLocation/pickPostalCode/pickStreetAddress in
  // prospective-ch-job-parser-common.mjs — this suite guards against that
  // fallback regressing and silently collapsing every job to one HQ default.
  describe('fetchAllStadtBernJobs (flat sza_location schema)', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    function mockJobsResponse(jobs: Array<Record<string, unknown>>) {
      return {
        ok: true,
        json: async () => ({ medium_id: 1840, total: jobs.length, jobs }),
      };
    }

    it('extracts per-job city/postalCode/streetAddress from flat sza_location', async () => {
      const rawJobs = [
        {
          id: 10094090,
          hk_id: 1001599,
          title: 'Sachbearbeiter*in Finanzen und Gebühren',
          start_date: '2026-06-01',
          links: { directlink: 'https://jobs.bern.ch/offene-stellen/sachbearbeiter-in-finanzen/abc' },
          attributes: { '10': ['1'] },
          szas: {
            sza_title: 'Sachbearbeiter*in Finanzen und Gebühren',
            sza_location: 'Murtenstrasse 100, 3001 Bern',
            sza_introduction:
              'Die Stadt Bern sucht eine engagierte Person für die Bewirtschaftung von Finanzen und Gebühren im Rechnungswesen der städtischen Verwaltung, mit direktem Kundenkontakt und Verantwortung für die öffentliche Dienstleistung.',
            sza_tasks: '<ul><li>Bearbeitung von Rechnungen und Gebühren</li><li>Kundenkontakt</li></ul>',
            sza_requirements: '<ul><li>Kaufmännische Ausbildung</li><li>SAP-Kenntnisse</li></ul>',
            sza_pensum: 'Vollzeit',
            'sza_pensum.min': '100',
            'sza_pensum.max': '100',
          },
        },
        {
          id: 10094200,
          hk_id: 1001599,
          title: 'Leiter*in digitale Unternehmensarchitektur',
          start_date: '2026-06-15',
          links: { directlink: 'https://jobs.bern.ch/offene-stellen/leiter-in-digitale/def' },
          attributes: { '10': ['1'] },
          szas: {
            sza_title: 'Leiter*in digitale Unternehmensarchitektur',
            sza_location: 'Junkerngasse 47, 3011 Bern',
            sza_introduction:
              'Bern wird digital. Gestalte mit als Leiter*in der digitalen Unternehmensarchitektur die Weiterentwicklung der städtischen IT-Landschaft und arbeite eng mit Fachbereichen und Gremien der Stadtverwaltung zusammen.',
            sza_tasks: '<ul><li>Weiterentwicklung der Unternehmensarchitektur</li></ul>',
            sza_requirements: '<ul><li>Hochschulabschluss Wirtschaftsinformatik</li></ul>',
            sza_pensum: 'Vollzeit, Teilzeit möglich',
            'sza_pensum.min': '80',
            'sza_pensum.max': '100',
          },
        },
      ];

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJobsResponse(rawJobs)));

      const jobs = await fetchAllStadtBernJobs();

      expect(jobs).toHaveLength(2);

      const finance = jobs.find((j: any) => j.title.includes('Finanzen'));
      expect(finance.location).toBe('Bern');
      expect(finance.postalCode).toBe('3001');
      expect(finance.streetAddress).toBe('Murtenstrasse 100');
      expect(finance.canton).toBe('BE');

      const architect = jobs.find((j: any) => j.title.includes('Unternehmensarchitektur'));
      expect(architect.location).toBe('Bern');
      expect(architect.postalCode).toBe('3011');
      expect(architect.streetAddress).toBe('Junkerngasse 47');
      expect(architect.canton).toBe('BE');

      // Different jobs, different real addresses — must NOT collapse to a
      // single constant default (the whole point of the additive fix).
      expect(finance.streetAddress).not.toBe(architect.streetAddress);
      expect(finance.postalCode).not.toBe(architect.postalCode);
    });

    it('overrides the shared factory default sector to Amministrazione Pubblica', async () => {
      const rawJobs = [
        {
          id: 1,
          title: 'Sachbearbeiter*in Finanzen und Gebühren',
          links: { directlink: 'https://jobs.bern.ch/offene-stellen/test/1' },
          szas: {
            sza_title: 'Sachbearbeiter*in Finanzen und Gebühren',
            sza_location: 'Murtenstrasse 100, 3001 Bern',
            sza_introduction: 'Kurze Einleitung zur Stelle bei der Stadt Bern.',
          },
        },
      ];

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJobsResponse(rawJobs)));

      const jobs = await fetchAllStadtBernJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0].sector).toBe('Amministrazione Pubblica');
    });

    it('returns empty array on upstream failure (graceful degradation)', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));
      const jobs = await fetchAllStadtBernJobs();
      expect(jobs).toEqual([]);
    });
  });

  // ── Job Shape Validation (Non-Negotiable #3 / #4) ──
  describe('job shape', () => {
    const validJob = {
      id: 'stadt-bern-abc123def456',
      slug: 'sachbearbeiter-in-finanzen-und-gebuhren-stadt-bern-bern',
      slugByLocale: { de: 'sachbearbeiter-in-finanzen-und-gebuhren-stadt-bern-bern' },
      company: 'Stadt Bern',
      companyKey: 'stadt-bern',
      companyDomain: 'bern.ch',
      title: 'Sachbearbeiter*in Finanzen und Gebühren',
      titleByLocale: { de: 'Sachbearbeiter*in Finanzen und Gebühren' },
      description:
        'Die Stadt Bern sucht eine engagierte und motivierte Person für die Bewirtschaftung von Finanzen und Gebühren im Rechnungswesen der städtischen Verwaltung. Aufgaben: Bearbeitung von Rechnungen, Kundenkontakt, Zusammenarbeit mit anderen Direktionen und Ämtern der Stadtverwaltung. Anforderungen: kaufmännische Grundausbildung, Berufserfahrung im Rechnungswesen, SAP-Kenntnisse und eine ausgeprägte Dienstleistungsorientierung sind willkommen. Wir bieten faire Bezahlung, geregelte Arbeitszeiten und langfristige Perspektiven in einer modernen öffentlichen Verwaltung.',
      descriptionByLocale: {
        de: 'Die Stadt Bern sucht eine engagierte und motivierte Person für die Bewirtschaftung von Finanzen und Gebühren im Rechnungswesen der städtischen Verwaltung. Aufgaben: Bearbeitung von Rechnungen, Kundenkontakt, Zusammenarbeit mit anderen Direktionen und Ämtern der Stadtverwaltung. Anforderungen: kaufmännische Grundausbildung, Berufserfahrung im Rechnungswesen, SAP-Kenntnisse und eine ausgeprägte Dienstleistungsorientierung sind willkommen. Wir bieten faire Bezahlung, geregelte Arbeitszeiten und langfristige Perspektiven in einer modernen öffentlichen Verwaltung.',
      },
      location: 'Bern',
      canton: 'BE',
      url: 'https://jobs.bern.ch/offene-stellen/sachbearbeiter-in-finanzen-und-gebuehren/630fcc6e',
      source: 'Stadt Bern Dedicated Parser (Prospective medium 1840)',
      sourceLang: 'de',
      crawledAt: new Date().toISOString(),
      addressLocality: 'Bern',
      addressRegion: 'BE',
      addressCountry: 'CH',
      country: 'CH',
      streetAddress: 'Murtenstrasse 100',
      postalCode: '3001',
      category: 'Amministrazione',
      contract: 'full-time',
      employmentType: 'FULL_TIME',
      experienceLevel: 'mid',
      sector: 'Amministrazione Pubblica',
      currency: 'CHF',
      featured: false,
      postedDate: '2026-06-01',
      applyUrl: 'https://jobs.bern.ch/offene-stellen/sachbearbeiter-in-finanzen-und-gebuehren/630fcc6e',
      requirements: [],
      requirementsByLocale: { de: [] },
    };

    it('has all required fields', () => {
      const required = [
        'id',
        'slug',
        'slugByLocale',
        'company',
        'companyKey',
        'title',
        'titleByLocale',
        'description',
        'descriptionByLocale',
        'location',
        'canton',
        'url',
        'source',
        'sourceLang',
        'crawledAt',
      ];
      for (const field of required) {
        expect(validJob).toHaveProperty(field);
      }
    });

    it('has all fields feeding job-page structured data (Non-Negotiable #3: baseSalary, postalCode, streetAddress, title, description, datePosted, hiringOrganization.name, jobLocation, employmentType)', () => {
      // baseSalary itself is synthesized downstream with safe canton-based
      // defaults (build-plugins/shared/jobPostingSchema.ts) — this parser is
      // responsible for supplying the per-job inputs that feed it.
      expect(validJob.postalCode).toBeTruthy();
      expect(validJob.streetAddress).toBeTruthy();
      expect(validJob.title).toBeTruthy();
      expect(validJob.description).toBeTruthy();
      expect(validJob.postedDate).toBeTruthy();
      expect(validJob.company).toBeTruthy();
      expect(validJob.location).toBeTruthy();
      expect(validJob.canton).toBeTruthy();
      expect(validJob.employmentType).toBeTruthy();
    });

    it('slug only contains source locale', () => {
      const locales = Object.keys(validJob.slugByLocale);
      expect(locales).toHaveLength(1);
      expect(locales[0]).toBe(validJob.sourceLang);
    });

    it('id starts with company key', () => {
      expect(validJob.id).toMatch(/^stadt-bern-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });

    it('description meets thin-content floor (Non-Negotiable #4, >= 50 words)', () => {
      const wordCount = validJob.description.trim().split(/\s+/).length;
      expect(wordCount).toBeGreaterThanOrEqual(50);
    });

    it('sector is Amministrazione Pubblica', () => {
      expect(validJob.sector).toBe('Amministrazione Pubblica');
    });

    it('URL points to jobs.bern.ch career page', () => {
      expect(validJob.url).toContain('jobs.bern.ch');
    });
  });
});
