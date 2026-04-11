import { describe, it, expect } from 'vitest';
import {
  PDGR_KEY,
  PDGR_COMPANY_NAME,
  isPdgrJob,
  isTrustedDomain,
} from '../scripts/lib/pdgr-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Psychiatrische Dienste Graubünden crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(PDGR_KEY).toBe('pdgr');
    expect(PDGR_COMPANY_NAME).toBe('Psychiatrische Dienste Graubünden');
  });

  // ── isCompanyJob ──
  describe('isPdgrJob', () => {
    it('matches by companyKey', () => {
      expect(isPdgrJob({ companyKey: 'pdgr' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isPdgrJob({ company: 'Psychiatrische Dienste Graubünden' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isPdgrJob({ url: 'https://pdgr.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isPdgrJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isPdgrJob(null)).toBe(false);
      expect(isPdgrJob(undefined)).toBe(false);
      expect(isPdgrJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://pdgr.ch/careers/job-123')).toBe(true);
    });

    it('trusts www subdomain', () => {
      expect(isTrustedDomain('https://www.pdgr.ch/jobs/assistenz-oder-fachpsychologe-in-3-2/')).toBe(true);
    });

    it('trusts other subdomains', () => {
      expect(isTrustedDomain('https://careers.pdgr.ch/job/456')).toBe(true);
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
      expect(slugify('Developer pdgr ch')).toBe('developer-pdgr-ch');
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
      id: 'pdgr-abc123def456',
      slug: 'fachperson-gesundheit-pdgr-ch',
      slugByLocale: { de: 'fachperson-gesundheit-pdgr-ch' },
      company: 'Psychiatrische Dienste Graubünden',
      companyKey: 'pdgr',
      title: 'Fachperson Gesundheit',
      titleByLocale: { de: 'Fachperson Gesundheit' },
      description: 'Fachperson Gesundheit — Psychiatrische Dienste Graubünden (PDGR). Arbeitsort: Chur (GR). Pensum: 80 - 100%',
      descriptionByLocale: { de: 'Fachperson Gesundheit — Psychiatrische Dienste Graubünden (PDGR). Arbeitsort: Chur (GR). Pensum: 80 - 100%' },
      location: 'Chur',
      canton: 'GR',
      url: 'https://www.pdgr.ch/jobs/fachperson-gesundheit-2-3/',
      source: 'Psychiatrische Dienste Graubünden Dedicated Parser',
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
      expect(validJob.id).toMatch(/^pdgr-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
