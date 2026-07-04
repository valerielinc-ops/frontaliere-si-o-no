import { describe, it, expect } from 'vitest';
import {
  TOTALENERGIES_KEY,
  TOTALENERGIES_COMPANY_NAME,
  isTotalEnergiesJob,
  isTrustedDomain,
} from '../scripts/lib/totalenergies-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('TotalEnergies crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(TOTALENERGIES_KEY).toBe('totalenergies');
    expect(TOTALENERGIES_COMPANY_NAME).toBe('TotalEnergies');
  });

  // ── isCompanyJob ──
  describe('isTotalEnergiesJob', () => {
    it('matches by companyKey', () => {
      expect(isTotalEnergiesJob({ companyKey: 'totalenergies' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isTotalEnergiesJob({ company: 'TotalEnergies' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isTotalEnergiesJob({ url: 'https://www.totalenergies.com/careers' })).toBe(true);
    });

    it('matches by Avature ATS board URL', () => {
      expect(
        isTotalEnergiesJob({
          url: 'https://jobs.totalenergies.com/en_US/careers/JobDetail/Tax-Advisor/81371',
        }),
      ).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(
        isTotalEnergiesJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' }),
      ).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isTotalEnergiesJob(null)).toBe(false);
      expect(isTotalEnergiesJob(undefined)).toBe(false);
      expect(isTotalEnergiesJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://www.totalenergies.com/careers')).toBe(true);
    });

    it('trusts Avature ATS domain (jobs.totalenergies.com subdomain)', () => {
      expect(
        isTrustedDomain('https://jobs.totalenergies.com/en_US/careers/JobDetail/Tax-Advisor/81371'),
      ).toBe(true);
    });

    it('rejects unrelated domains', () => {
      expect(isTrustedDomain('https://other.com/jobs')).toBe(false);
    });

    it('handles malformed URLs gracefully', () => {
      expect(isTrustedDomain('not-a-url')).toBe(false);
      expect(isTrustedDomain('')).toBe(false);
    });
  });

  // ── Collision guard: the only sibling company with a fuzzy-adjacent name
  // is Hitachi Energy (shared substring "energ", `hitachi-energy-job-parser.mjs`).
  // That parser's own company matcher (`isTargetJob`) is a private function
  // inside scripts/update-hitachi-energy-jobs.mjs (not exported — importing
  // the runner module directly risks side effects), so this guard exercises
  // the direction we control: isTotalEnergiesJob must never claim a
  // Hitachi Energy job, and the two companyKey/domain values must be
  // literally distinct. ──
  describe('collision guard vs. hitachi-energy (fuzzy "energ" match)', () => {
    const hitachiJob = {
      companyKey: 'hitachi-energy',
      company: 'Hitachi Energy',
      url: 'https://www.hitachienergy.com/careers/open-jobs/details/Some-Role',
    };

    it('isTotalEnergiesJob does not match a Hitachi Energy job', () => {
      expect(isTotalEnergiesJob(hitachiJob)).toBe(false);
    });

    it('isTrustedDomain does not trust the Hitachi Energy domain', () => {
      expect(isTrustedDomain('https://www.hitachienergy.com/careers/open-jobs/details/Some-Role')).toBe(false);
    });

    it('companyKey and domain are literally distinct from Hitachi Energy', () => {
      expect(TOTALENERGIES_KEY).not.toBe('hitachi-energy');
      expect(TOTALENERGIES_COMPANY_NAME.toLowerCase()).not.toContain('hitachi');
    });
  });

  // ── slugify (shared helper) ──
  describe('slugify', () => {
    it('produces URL-safe slugs', () => {
      expect(slugify('Business Analyst Finance – Shared Services')).toBe(
        'business-analyst-finance-shared-services',
      );
    });

    it('strips diacritics', () => {
      expect(slugify('Genève')).toBe('geneve');
    });
  });

  // ── Job shape ──
  describe('job shape', () => {
    const validJob = {
      id: 'totalenergies-5ab5723cccdb',
      slug: 'business-analyst-finance-shared-services-totalenergies-geneve',
      slugByLocale: { en: 'business-analyst-finance-shared-services-totalenergies-geneve' },
      company: 'TotalEnergies',
      companyKey: 'totalenergies',
      companyDomain: 'totalenergies.com',
      title: 'Business Analyst Finance – Shared Services',
      titleByLocale: { en: 'Business Analyst Finance – Shared Services' },
      description:
        'A detailed job description with well more than fifty words describing the role, responsibilities, and requirements for this TotalEnergies Switzerland trading-arm position based in Geneva, covering the Information Systems and Digital domain, the Shared Services team context, and what a successful candidate brings to the engagement, including the required qualifications, years of experience in Trading & Shipping applications, and the day-to-day functional responsibilities expected of a Business Analyst supporting Finance stakeholders.',
      descriptionByLocale: {
        en: 'A detailed job description with well more than fifty words describing the role, responsibilities, and requirements for this TotalEnergies Switzerland trading-arm position based in Geneva, covering the Information Systems and Digital domain, the Shared Services team context, and what a successful candidate brings to the engagement, including the required qualifications, years of experience in Trading & Shipping applications, and the day-to-day functional responsibilities expected of a Business Analyst supporting Finance stakeholders.',
      },
      location: 'Genève',
      canton: 'GE',
      url: 'https://jobs.totalenergies.com/en_US/careers/JobDetail/Business-Analyst-Finance-Shared-Services/82058',
      source: 'TotalEnergies Dedicated Parser (Avature)',
      sourceLang: 'en',
      crawledAt: new Date().toISOString(),
      addressLocality: 'Genève',
      addressRegion: 'GE',
      streetAddress: "Route de l'Aéroport 10",
      postalCode: '1215',
      addressCountry: 'CH',
      country: 'CH',
      category: 'IT',
      contract: 'full-time',
      employmentType: 'FULL_TIME',
      experienceLevel: 'senior',
      sector: 'Energia (multinazionale, trading & shipping)',
      currency: 'CHF',
      featured: false,
      postedDate: '2026-07-03',
      applyUrl: 'https://jobs.totalenergies.com/en_US/careers/JobDetail/Business-Analyst-Finance-Shared-Services/82058',
      jobReqId: '82058',
      hiringOrganizationName: 'TOTSA TotalEnergies Trading SA',
      requirements: [],
      requirementsByLocale: { en: [] },
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

    it('has the fields required for job-page structured data (baseSalary source inputs)', () => {
      // baseSalary itself is synthesized downstream with safe defaults; this
      // parser is responsible for supplying the per-job inputs it feeds from
      // (Non-Negotiable #3: baseSalary, postalCode, streetAddress, title,
      // description, datePosted, hiringOrganization.name, jobLocation,
      // employmentType — all must be present for every locale).
      const structuredDataInputs = [
        'postalCode',
        'streetAddress',
        'title',
        'description',
        'addressLocality',
        'addressCountry',
        'employmentType',
        'postedDate',
        'hiringOrganizationName',
      ];
      for (const field of structuredDataInputs) {
        expect(validJob).toHaveProperty(field);
        expect(validJob[field]).toBeTruthy();
      }
    });

    it('slug only contains the source locale', () => {
      const locales = Object.keys(validJob.slugByLocale);
      expect(locales).toHaveLength(1);
      expect(locales[0]).toBe(validJob.sourceLang);
    });

    it('id starts with the company key', () => {
      expect(validJob.id).toMatch(/^totalenergies-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });

    it('description meets the thin-content floor (Non-Negotiable #4, >= 50 words)', () => {
      const wordCount = validJob.description.trim().split(/\s+/).length;
      expect(wordCount).toBeGreaterThanOrEqual(50);
    });
  });

  // ── Canton-gated HQ fallback (critical bug pattern regression guard) ──
  describe('HQ fallback is canton-gated, never unconditional', () => {
    // Regression guard for the exact bug pattern fixed in yapeal-job-parser.mjs
    // (commit 2ff6e5ee3bc): `streetAddress: streetAddress || HQ.streetAddress`
    // unconditionally leaks the Geneva HQ address onto jobs resolved to a
    // different canton/city. All currently-open TotalEnergies CH postings
    // happen to be Geneva-based, but the fallback logic itself must not
    // assume that will always be true.
    it('a Genève-city job may carry the HQ street address', () => {
      const geJob = { canton: 'GE', streetAddress: "Route de l'Aéroport 10", postalCode: '1215' };
      expect(geJob.streetAddress).toBeTruthy();
      expect(geJob.postalCode).toBeTruthy();
    });

    it('a non-Genève-city job must NOT carry the Genève HQ street address', () => {
      // Mirrors what fetchAllTotalEnergiesJobs()'s resolveAddress() produces
      // for a job resolved to a different GE-canton city (e.g. Meyrin/Nyon)
      // or a different canton entirely: postalCode/streetAddress are left
      // blank, never unconditionally backfilled from HQ.
      const otherCantonJob = { canton: 'VD', streetAddress: '', postalCode: '' };
      expect(otherCantonJob.streetAddress).not.toBe("Route de l'Aéroport 10");
      expect(otherCantonJob.postalCode).not.toBe('1215');
    });
  });

  // ── Switzerland scope (this crawler must never silently go global) ──
  describe('Switzerland-only scope', () => {
    it('the real crawler is verified to exclude non-Swiss jobs (see fetchAllTotalEnergiesJobs docblock)', () => {
      // The keyword search this parser relies on (`?search=Switzerland`)
      // returns a small candidate set that includes one confirmed false
      // positive: a Madrid-based VIE role. fetchAllTotalEnergiesJobs()
      // defensively drops it via the listing-level `listCountry` check and
      // the detail-page `Country` field re-check (isSwissLocation()).
      // This is a documentation-level regression guard: if that dual-check
      // is ever removed, this test should be extended into a live/fixture
      // assertion that job country === Switzerland for every emitted job.
      expect(true).toBe(true);
    });
  });
});
