import { describe, it, expect } from 'vitest';
import {
  VISIONAPARTMENTS_KEY,
  VISIONAPARTMENTS_COMPANY_NAME,
  isVisionapartmentsJob,
  isTrustedDomain,
  parseVacancyLinks,
  extractJobPostingJsonLd,
  cleanStreetAddress,
  detectCategory,
  detectEmploymentType,
  detectExperienceLevel,
} from '../scripts/lib/visionapartments-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('VISIONAPARTMENTS crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(VISIONAPARTMENTS_KEY).toBe('visionapartments');
    expect(VISIONAPARTMENTS_COMPANY_NAME).toBe('VISIONAPARTMENTS');
  });

  // ── isVisionapartmentsJob ──
  describe('isVisionapartmentsJob', () => {
    it('matches by companyKey', () => {
      expect(isVisionapartmentsJob({ companyKey: 'visionapartments' })).toBe(true);
    });

    it('matches by brand company name', () => {
      expect(isVisionapartmentsJob({ company: 'VISIONAPARTMENTS' })).toBe(true);
      expect(isVisionapartmentsJob({ company: 'Vision Apartments' })).toBe(true);
    });

    it('matches by legal entity name (jobs.ch hiringOrganization)', () => {
      expect(isVisionapartmentsJob({ company: 'Vision Management Services GmbH' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isVisionapartmentsJob({ url: 'https://visionapartments.com/en/career' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isVisionapartmentsJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isVisionapartmentsJob(null as unknown as Record<string, unknown>)).toBe(false);
      expect(isVisionapartmentsJob(undefined as unknown as Record<string, unknown>)).toBe(false);
      expect(isVisionapartmentsJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts jobs.ch (actual publishing channel)', () => {
      expect(isTrustedDomain('https://www.jobs.ch/en/vacancies/detail/abc123/')).toBe(true);
    });

    it('trusts jobs.ch subdomains', () => {
      expect(isTrustedDomain('https://media.jobs.ch/images/x.png')).toBe(true);
    });

    it('trusts the visionapartments.com corporate domain', () => {
      expect(isTrustedDomain('https://visionapartments.com/en/career')).toBe(true);
      expect(isTrustedDomain('https://www.visionapartments.com/en/career')).toBe(true);
    });

    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
    });

    it('handles invalid URLs', () => {
      expect(isTrustedDomain('')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  // ── parseVacancyLinks ──
  describe('parseVacancyLinks', () => {
    it('extracts vacancy detail links from a jobs.ch company page', () => {
      const html = `
        <a class="link" href="/en/vacancies/detail/6216972a-b5d4-4577-aeb4-a2f2a2ea5dfb/" data-discover="true">
          <div data-cy="vacancy-serp-item">GROUP HEAD OF REAL ESTATE DEVELOPMENT & MAINTENANCE - 100%</div>
        </a>
      `;
      expect(parseVacancyLinks(html)).toEqual([
        'https://www.jobs.ch/en/vacancies/detail/6216972a-b5d4-4577-aeb4-a2f2a2ea5dfb/',
      ]);
    });

    it('returns empty array when no vacancies are present', () => {
      expect(parseVacancyLinks('<html><body>No open positions</body></html>')).toEqual([]);
    });

    it('returns empty array for invalid input', () => {
      expect(parseVacancyLinks('')).toEqual([]);
      expect(parseVacancyLinks(null as unknown as string)).toEqual([]);
      expect(parseVacancyLinks(undefined as unknown as string)).toEqual([]);
    });

    it('deduplicates repeated links', () => {
      const html = `
        <a href="/en/vacancies/detail/6216972a-b5d4-4577-aeb4-a2f2a2ea5dfb/">A</a>
        <a href="/en/vacancies/detail/6216972a-b5d4-4577-aeb4-a2f2a2ea5dfb/">A dup</a>
      `;
      expect(parseVacancyLinks(html)).toHaveLength(1);
    });
  });

  // ── extractJobPostingJsonLd ──
  describe('extractJobPostingJsonLd', () => {
    it('extracts a JobPosting object from a single ld+json script', () => {
      const html = `
        <script type="application/ld+json">
          {"@context":"https://schema.org","@type":"JobPosting","title":"GROUP HEAD OF REAL ESTATE DEVELOPMENT & MAINTENANCE - 100%"}
        </script>
      `;
      const posting = extractJobPostingJsonLd(html);
      expect(posting).not.toBeNull();
      expect(posting.title).toBe('GROUP HEAD OF REAL ESTATE DEVELOPMENT & MAINTENANCE - 100%');
    });

    it('finds JobPosting inside an array of ld+json entries', () => {
      const html = `
        <script type="application/ld+json">
          [{"@type":"BreadcrumbList","itemListElement":[]},{"@type":"JobPosting","title":"Receptionist"}]
        </script>
      `;
      const posting = extractJobPostingJsonLd(html);
      expect(posting).not.toBeNull();
      expect(posting.title).toBe('Receptionist');
    });

    it('returns null when no JobPosting block is present', () => {
      const html = `<script type="application/ld+json">{"@type":"BreadcrumbList","itemListElement":[]}</script>`;
      expect(extractJobPostingJsonLd(html)).toBeNull();
    });

    it('returns null for invalid input', () => {
      expect(extractJobPostingJsonLd('')).toBeNull();
      expect(extractJobPostingJsonLd(undefined as unknown as string)).toBeNull();
    });

    it('parses the full real-world jobs.ch fixture (address, hiringOrganization, dates)', () => {
      const html = `
        <script type="application/ld+json">
          {
            "@context": "https://schema.org",
            "@type": "JobPosting",
            "title": "GROUP HEAD OF REAL ESTATE DEVELOPMENT & MAINTENANCE - 100%",
            "description": "<p>Zur Verstärkung unseres professionellen Teams in Zürich suchen wir per sofort oder nach Vereinbarung eine/n Group Head of Real Estate Development. Sie verantworten die Entwicklung von Architekturprojekten, Bauprojekte, Bestandesarchitektur, Projektverantwortung, Finanzcontrolling und Reporting fuer unsere Liegenschaften in der ganzen Schweiz. Sie bringen mehrjaehrige Erfahrung im Immobilienbereich mit und fuehren ein kleines Team von zwei bis drei Mitarbeitenden.</p>",
            "datePosted": "2026-06-29T14:01:21+02:00",
            "employmentType": "Permanent",
            "hiringOrganization": {
              "@type": "Organization",
              "name": "Vision Management Services GmbH",
              "sameAs": "https://www.visionapartments.com"
            },
            "jobLocation": {
              "@type": "Place",
              "address": {
                "@type": "PostalAddress",
                "streetAddress": "Talstrasse 62",
                "addressRegion": "Zürich",
                "postalCode": "8001",
                "addressCountry": "CH"
              }
            },
            "baseSalary": {
              "@type": "MonetaryAmount",
              "currency": "CHF",
              "value": { "@type": "QuantitativeValue" }
            }
          }
        </script>
      `;
      const posting = extractJobPostingJsonLd(html);
      expect(posting).not.toBeNull();
      expect(posting.title).toBe('GROUP HEAD OF REAL ESTATE DEVELOPMENT & MAINTENANCE - 100%');
      expect(posting.hiringOrganization.name).toBe('Vision Management Services GmbH');
      expect(posting.jobLocation.address.streetAddress).toBe('Talstrasse 62');
      expect(posting.jobLocation.address.postalCode).toBe('8001');
      // jobs.ch quirk: addressRegion holds the CITY, not a canton code.
      expect(posting.jobLocation.address.addressRegion).toBe('Zürich');
      expect(posting.datePosted).toBe('2026-06-29T14:01:21+02:00');
    });
  });

  // ── cleanStreetAddress ──
  describe('cleanStreetAddress', () => {
    it('strips the redundant trailing "postal city" segment', () => {
      expect(cleanStreetAddress('Talstrasse 62, 8001 Zürich', 'Zürich', '8001')).toBe('Talstrasse 62');
    });

    it('falls back to city when streetAddress is empty (safe default)', () => {
      expect(cleanStreetAddress('', 'Zürich', '8001')).toBe('Zürich');
    });

    it('returns the raw value unchanged when there is no redundant suffix', () => {
      expect(cleanStreetAddress('Talstrasse 62', 'Zürich', '8001')).toBe('Talstrasse 62');
    });
  });

  // ── detectCategory ──
  describe('detectCategory', () => {
    it('detects real-estate/construction roles', () => {
      expect(detectCategory('Group Head of Real Estate Development & Maintenance', 'Civil Engineering / Supervision')).toBe('Ingegneria');
    });

    it('detects hospitality/housekeeping roles', () => {
      expect(detectCategory('Housekeeping Supervisor', '')).toBe('Ospitalità');
    });

    it('detects reception roles', () => {
      expect(detectCategory('Receptionist Zürich', '')).toBe('Ospitalità');
    });

    it('detects sales/leasing roles', () => {
      expect(detectCategory('Key Account Manager Leasing', '')).toBe('Commerciale');
    });

    it('defaults to Altro for unknown titles', () => {
      expect(detectCategory('Praktikant Nachhaltigkeit', '')).toBe('Altro');
    });
  });

  // ── detectEmploymentType ──
  describe('detectEmploymentType', () => {
    it('detects full-time from percentage in title', () => {
      expect(detectEmploymentType('Group Head of Real Estate Development & Maintenance - 100%', '')).toBe('FULL_TIME');
    });

    it('detects part-time from percentage in title', () => {
      expect(detectEmploymentType('Receptionist 60%', '')).toBe('PART_TIME');
    });

    it('detects part-time from keyword', () => {
      expect(detectEmploymentType('Teilzeit Position', '')).toBe('PART_TIME');
    });

    it('defaults to FULL_TIME', () => {
      expect(detectEmploymentType('Housekeeping Supervisor', '')).toBe('FULL_TIME');
    });
  });

  // ── detectExperienceLevel ──
  describe('detectExperienceLevel', () => {
    it('detects intern/apprentice roles', () => {
      expect(detectExperienceLevel('Praktikant Immobilien')).toBe('intern');
    });

    it('detects senior/lead/head roles', () => {
      expect(detectExperienceLevel('Group Head of Real Estate Development & Maintenance')).toBe('senior');
    });

    it('defaults to mid', () => {
      expect(detectExperienceLevel('Receptionist')).toBe('mid');
    });
  });

  // ── slugify (imported from crawler-template) ──
  describe('slugify', () => {
    it('converts title to URL-safe slug', () => {
      const slug = slugify('Group Head of Real Estate Development & Maintenance');
      expect(slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });

    it('strips diacritics', () => {
      expect(slugify('Ingénieur qualité Zürich')).toBe('ingenieur-qualite-zurich');
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('Receptionist visionapartments Zurich')).toBe('receptionist-visionapartments-zurich');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    const validJob = {
      id: 'visionapartments-abc123def456',
      slug: 'group-head-of-real-estate-development-maintenance-visionapartments-zurich',
      slugByLocale: { de: 'group-head-of-real-estate-development-maintenance-visionapartments-zurich' },
      company: 'Vision Management Services GmbH',
      companyKey: 'visionapartments',
      companyDomain: 'visionapartments.com',
      title: 'GROUP HEAD OF REAL ESTATE DEVELOPMENT & MAINTENANCE - 100%',
      titleByLocale: { de: 'GROUP HEAD OF REAL ESTATE DEVELOPMENT & MAINTENANCE - 100%' },
      description: 'A test job description for validation with enough words to pass the minimum threshold for content quality checks required by the SEO gate for indexed pages on this site.',
      descriptionByLocale: {
        de: 'A test job description for validation with enough words to pass the minimum threshold for content quality checks required by the SEO gate for indexed pages on this site.',
      },
      location: 'Zürich',
      canton: 'ZH',
      addressLocality: 'Zürich',
      addressRegion: 'ZH',
      addressCountry: 'CH',
      country: 'CH',
      postalCode: '8001',
      streetAddress: 'Talstrasse 62',
      url: 'https://www.jobs.ch/en/vacancies/detail/6216972a-b5d4-4577-aeb4-a2f2a2ea5dfb/',
      applyUrl: 'https://www.jobs.ch/en/vacancies/detail/6216972a-b5d4-4577-aeb4-a2f2a2ea5dfb/',
      source: 'VISIONAPARTMENTS Dedicated Parser (jobs.ch)',
      sourceLang: 'de',
      crawledAt: new Date().toISOString(),
      category: 'Ingegneria',
      sector: 'Immobiliare / Ospitalità',
      contract: 'full-time',
      employmentType: 'FULL_TIME',
      experienceLevel: 'senior',
      featured: false,
      postedDate: '2026-06-29',
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

    it('has all SEO-required fields', () => {
      const seoFields = [
        'addressLocality', 'addressRegion', 'addressCountry',
        'postalCode', 'streetAddress', 'employmentType',
        'sector', 'postedDate',
      ];
      for (const field of seoFields) {
        expect(validJob).toHaveProperty(field);
        expect(validJob[field as keyof typeof validJob]).toBeTruthy();
      }
    });

    it('slug only contains source locale', () => {
      const locales = Object.keys(validJob.slugByLocale);
      expect(locales).toHaveLength(1);
      expect(locales[0]).toBe(validJob.sourceLang);
    });

    it('id starts with company key', () => {
      expect(validJob.id).toMatch(/^visionapartments-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });

    it('canton is ZH for Zürich', () => {
      expect(validJob.canton).toBe('ZH');
    });

    it('sector reflects real estate / hospitality domain', () => {
      expect(validJob.sector).toBe('Immobiliare / Ospitalità');
    });
  });
});
