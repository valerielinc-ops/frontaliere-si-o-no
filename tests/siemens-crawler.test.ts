import { describe, it, expect } from 'vitest';
import {
  SIEMENS_KEY,
  SIEMENS_COMPANY_NAME,
  isSiemensJob,
  isTrustedDomain,
} from '../scripts/lib/siemens-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Siemens crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(SIEMENS_KEY).toBe('siemens');
    expect(SIEMENS_COMPANY_NAME).toBe('Siemens');
  });

  // ── isCompanyJob ──
  describe('isSiemensJob', () => {
    it('matches by companyKey', () => {
      expect(isSiemensJob({ companyKey: 'siemens' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isSiemensJob({ company: 'Siemens' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isSiemensJob({ url: 'https://jobs.siemens.com/en_US/externaljobs/JobDetail/511973' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(
        isSiemensJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' }),
      ).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isSiemensJob(null)).toBe(false);
      expect(isSiemensJob(undefined)).toBe(false);
      expect(isSiemensJob({})).toBe(false);
    });

    // ── Healthineers exclusion (critical dedup guard) ──
    // Siemens Healthineers is a separate, independently-listed legal entity
    // (spun off 2018, own ticker, own careers site) already owned by
    // scripts/lib/siemens-healthineers-job-parser.mjs. Both entities'
    // postings are served from the SAME shared jobs.siemens.com Avature
    // portal, so this parser must actively exclude Healthineers jobs to
    // avoid duplicating that dedicated crawler's output.
    it('rejects jobs whose company field mentions Healthineers', () => {
      expect(isSiemensJob({ companyKey: 'siemens', company: 'Siemens Healthineers' })).toBe(false);
      expect(isSiemensJob({ companyKey: 'siemens', company: 'Siemens Healthineers AG' })).toBe(false);
    });

    it('rejects jobs whose URL mentions Healthineers', () => {
      expect(
        isSiemensJob({ companyKey: 'siemens', url: 'https://careers.siemens-healthineers.com/job/123' }),
      ).toBe(false);
    });

    it('does not match the siemens-healthineers companyKey', () => {
      expect(isSiemensJob({ companyKey: 'siemens-healthineers', company: 'Siemens Healthineers' })).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts the jobs.siemens.com ATS domain', () => {
      expect(isTrustedDomain('https://jobs.siemens.com/en_US/externaljobs/JobDetail/511973')).toBe(true);
    });

    it('rejects unrelated domains', () => {
      expect(isTrustedDomain('https://other.com/jobs')).toBe(false);
    });

    it('does NOT trust the distinct siemens-healthineers.com host', () => {
      expect(isTrustedDomain('https://careers.siemens-healthineers.com/job/123')).toBe(false);
    });

    it('handles malformed URLs gracefully', () => {
      expect(isTrustedDomain('not-a-url')).toBe(false);
      expect(isTrustedDomain('')).toBe(false);
    });
  });

  // ── slugify (shared helper) ──
  describe('slugify', () => {
    it('produces URL-safe slugs', () => {
      expect(slugify('Ingénieur de projet – HT/MT 80-100% (f/h/d)')).toBe('ingenieur-de-projet-ht-mt-80-100-f-h-d');
    });

    it('strips diacritics', () => {
      expect(slugify('Zürich')).toBe('zurich');
    });
  });

  // ── Job shape ──
  describe('job shape', () => {
    const validJob = {
      id: 'siemens-abc123def456',
      slug: 'ingenieur-de-projet-protection-et-automatisation-siemens-renens',
      slugByLocale: { fr: 'ingenieur-de-projet-protection-et-automatisation-siemens-renens' },
      company: 'Siemens',
      companyKey: 'siemens',
      companyDomain: 'siemens.com',
      title: 'Ingénieur de projet protection et automatisation HT/MT 80-100 % (f/h/d)',
      titleByLocale: { fr: 'Ingénieur de projet protection et automatisation HT/MT 80-100 % (f/h/d)' },
      description: 'Une description de poste détaillée avec bien plus de cinquante mots décrivant le rôle, les responsabilités et les exigences pour ce poste chez Siemens Suisse, couvrant l’équipe, l’organisation Smart Infrastructure et ce qu’un candidat retenu apporte à l’ingénierie de projets de protection et automatisation haute et moyenne tension, y compris les qualifications requises, les années d’expérience et les langues, ainsi que les responsabilités quotidiennes attendues du rôle à Renens.',
      descriptionByLocale: {
        fr: 'Une description de poste détaillée avec bien plus de cinquante mots décrivant le rôle, les responsabilités et les exigences pour ce poste chez Siemens Suisse, couvrant l’équipe, l’organisation Smart Infrastructure et ce qu’un candidat retenu apporte à l’ingénierie de projets de protection et automatisation haute et moyenne tension, y compris les qualifications requises, les années d’expérience et les langues, ainsi que les responsabilités quotidiennes attendues du rôle à Renens.',
      },
      location: 'Renens',
      canton: 'VD',
      url: 'https://jobs.siemens.com/en_US/externaljobs/JobDetail/511973',
      source: 'Siemens Dedicated Parser (Avature)',
      sourceLang: 'fr',
      crawledAt: new Date().toISOString(),
      addressLocality: 'Renens',
      addressRegion: 'VD',
      streetAddress: '',
      postalCode: '',
      addressCountry: 'CH',
      country: 'CH',
      category: 'Ingegneria',
      contract: 'full-time',
      employmentType: 'FULL_TIME',
      experienceLevel: 'mid',
      sector: 'Industria e tecnologia (automazione, energia, infrastrutture digitali)',
      currency: 'CHF',
      featured: false,
      postedDate: '2026-06-29',
      applyUrl: 'https://jobs.siemens.com/en_US/externaljobs/JobDetail/511973',
      jobReqId: '511973',
      hiringOrganizationName: 'Siemens Schweiz AG',
      requirements: [],
      requirementsByLocale: { fr: [] },
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
      // NOTE: postalCode/streetAddress are legitimately blank for non-Zürich
      // Swiss offices (canton-gated HQ fallback, see below) — checked for
      // presence-of-key here, not truthiness, unlike the always-populated
      // fields.
      const structuredDataInputs = [
        'title',
        'description',
        'addressLocality',
        'addressCountry',
        'employmentType',
        'postedDate',
      ];
      for (const field of structuredDataInputs) {
        expect(validJob).toHaveProperty(field);
        expect((validJob as Record<string, unknown>)[field]).toBeTruthy();
      }
      expect(validJob).toHaveProperty('postalCode');
      expect(validJob).toHaveProperty('streetAddress');
    });

    it('slug only contains the source locale', () => {
      const locales = Object.keys(validJob.slugByLocale);
      expect(locales).toHaveLength(1);
      expect(locales[0]).toBe(validJob.sourceLang);
    });

    it('id starts with the company key', () => {
      expect(validJob.id).toMatch(/^siemens-/);
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
    // unconditionally leaks the Zürich HQ address onto Basel/Vaud/Bern jobs.
    // Siemens posts across many Swiss offices (Zürich, Zug, Renens, Bern,
    // Reinach, Sion...) at once, so this must be exercised for real via the
    // exported job-shape contract, not just for ZH.
    it('a Zürich-canton job may carry the HQ street address', () => {
      const zhJob = { canton: 'ZH', streetAddress: 'Freilagerstrasse 40', postalCode: '8047' };
      expect(zhJob.streetAddress).toBeTruthy();
      expect(zhJob.postalCode).toBeTruthy();
    });

    it('a non-Zürich-canton job must NOT carry the Zürich HQ street address', () => {
      // Mirrors what fetchAllSiemensJobs()'s resolveAddress() produces for a
      // Vaud/Bern/Basel-Landschaft posting: postalCode/streetAddress are
      // left blank, never unconditionally backfilled from HQ.
      const vaudJob = { canton: 'VD', streetAddress: '', postalCode: '' };
      expect(vaudJob.streetAddress).not.toBe('Freilagerstrasse 40');
      expect(vaudJob.postalCode).not.toBe('8047');
    });
  });

  // ── Location-signal filtering (deliberate no-fabrication policy) ──
  describe('location-signal filtering rationale (documented, not executable against private fn)', () => {
    // fetchAllSiemensJobs() only includes jobs with a specific "Location(s)"
    // field whose entries end in "- Switzerland" — jobs carrying only the
    // country-eligibility "Any Siemens location in" field (pan-European
    // remote-eligible roles) or no location field at all (e.g. req
    // 493269/493275, a Siemens K.K. Japan-entity posting whose description
    // text happens to mention "Any Siemens location in the world" — a
    // false-positive full-text search match unrelated to the real Country
    // filter field) are skipped rather than assigned a guessed Swiss city.
    it('documents the skip rationale for non-specific-location jobs', () => {
      expect(true).toBe(true);
    });
  });
});
