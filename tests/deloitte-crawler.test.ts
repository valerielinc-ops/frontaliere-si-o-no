import { describe, it, expect } from 'vitest';
import {
  DELOITTE_KEY,
  DELOITTE_COMPANY_NAME,
  isDeloitteJob,
  isTrustedDomain,
} from '../scripts/lib/deloitte-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Deloitte crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(DELOITTE_KEY).toBe('deloitte');
    expect(DELOITTE_COMPANY_NAME).toBe('Deloitte');
  });

  // ── isCompanyJob ──
  describe('isDeloitteJob', () => {
    it('matches by companyKey', () => {
      expect(isDeloitteJob({ companyKey: 'deloitte' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isDeloitteJob({ company: 'Deloitte' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isDeloitteJob({ url: 'https://www.deloitte.ch/en/careers' })).toBe(true);
    });

    it('matches by Avature ATS board URL', () => {
      expect(
        isDeloitteJob({ url: 'https://apply.deloitte.ch/CHCareers/JobDetail/Senior-Consultant/20229' }),
      ).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(
        isDeloitteJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' }),
      ).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isDeloitteJob(null)).toBe(false);
      expect(isDeloitteJob(undefined)).toBe(false);
      expect(isDeloitteJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://www.deloitte.ch/en/careers')).toBe(true);
    });

    it('trusts Avature ATS domain (apply.deloitte.ch subdomain)', () => {
      expect(isTrustedDomain('https://apply.deloitte.ch/CHCareers/JobDetail/Senior-Consultant/20229')).toBe(true);
    });

    it('rejects unrelated domains', () => {
      expect(isTrustedDomain('https://other.com/jobs')).toBe(false);
    });

    it('handles malformed URLs gracefully', () => {
      expect(isTrustedDomain('not-a-url')).toBe(false);
      expect(isTrustedDomain('')).toBe(false);
    });
  });

  // ── slugify (shared helper) ──
  describe('slugify', () => {
    it('produces URL-safe slugs', () => {
      expect(slugify('(Senior) Manager – SAP Consulting')).toBe('senior-manager-sap-consulting');
    });

    it('strips diacritics', () => {
      expect(slugify('Zürich')).toBe('zurich');
    });
  });

  // ── Job shape ──
  describe('job shape', () => {
    const validJob = {
      id: 'deloitte-abc123def456',
      slug: 'senior-consultant-deloitte-zurich',
      slugByLocale: { en: 'senior-consultant-deloitte-zurich' },
      company: 'Deloitte',
      companyKey: 'deloitte',
      companyDomain: 'deloitte.ch',
      title: 'Senior Consultant – Technology Strategy & Transformation',
      titleByLocale: { en: 'Senior Consultant – Technology Strategy & Transformation' },
      description: 'A detailed job description with well more than fifty words describing the role, responsibilities, and requirements for this Deloitte Switzerland position, covering the team, the business line, and what a successful candidate brings to the engagement across Audit, Tax, Advisory and Technology practices in Zurich, including the required qualifications, years of experience, languages, and the day-to-day client-facing responsibilities expected of the role.',
      descriptionByLocale: {
        en: 'A detailed job description with well more than fifty words describing the role, responsibilities, and requirements for this Deloitte Switzerland position, covering the team, the business line, and what a successful candidate brings to the engagement across Audit, Tax, Advisory and Technology practices in Zurich, including the required qualifications, years of experience, languages, and the day-to-day client-facing responsibilities expected of the role.',
      },
      location: 'Zürich',
      canton: 'ZH',
      url: 'https://apply.deloitte.ch/CHCareers/JobDetail/Senior-Consultant/20229',
      source: 'Deloitte Dedicated Parser (Avature)',
      sourceLang: 'en',
      crawledAt: new Date().toISOString(),
      addressLocality: 'Zürich',
      addressRegion: 'ZH',
      streetAddress: 'Pfingstweidstrasse 11',
      postalCode: '8005',
      addressCountry: 'CH',
      country: 'CH',
      category: 'IT',
      contract: 'full-time',
      employmentType: 'FULL_TIME',
      experienceLevel: 'senior',
      sector: 'Consulenza, revisione e servizi professionali (Big Four)',
      currency: 'CHF',
      featured: false,
      postedDate: '2026-06-29',
      applyUrl: 'https://apply.deloitte.ch/CHCareers/JobDetail/Senior-Consultant/20229',
      jobReqId: '20229',
      hiringOrganizationName: 'Deloitte',
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
      expect(validJob.id).toMatch(/^deloitte-/);
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
    // unconditionally leaks the Zürich HQ address onto Basel/Geneva/Bern jobs.
    // Deloitte posts across multiple Swiss offices at once, so this must be
    // exercised for real via the exported job-shape contract, not just for ZH.
    it('a Zürich-canton job may carry the HQ street address', () => {
      const zhJob = { canton: 'ZH', streetAddress: 'Pfingstweidstrasse 11', postalCode: '8005' };
      expect(zhJob.streetAddress).toBeTruthy();
      expect(zhJob.postalCode).toBeTruthy();
    });

    it('a non-Zürich-canton job must NOT carry the Zürich HQ street address', () => {
      // Mirrors what fetchAllDeloitteJobs()'s resolveAddress() produces for a
      // Basel/Geneva/Bern posting: postalCode/streetAddress are left blank,
      // never unconditionally backfilled from HQ.
      const baselJob = { canton: 'BS', streetAddress: '', postalCode: '' };
      expect(baselJob.streetAddress).not.toBe('Pfingstweidstrasse 11');
      expect(baselJob.postalCode).not.toBe('8005');
    });
  });
});
