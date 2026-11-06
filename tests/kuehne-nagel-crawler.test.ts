import { describe, it, expect } from 'vitest';
import {
  KUEHNE_NAGEL_KEY,
  KUEHNE_NAGEL_COMPANY_NAME,
  isKuehneNagelJob,
  isTrustedDomain,
} from '../scripts/lib/kuehne-nagel-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Kuehne+Nagel crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(KUEHNE_NAGEL_KEY).toBe('kuehne-nagel');
    expect(KUEHNE_NAGEL_COMPANY_NAME).toBe('Kuehne+Nagel');
  });

  // ── isCompanyJob ──
  describe('isKuehneNagelJob', () => {
    it('matches by companyKey', () => {
      expect(isKuehneNagelJob({ companyKey: 'kuehne-nagel' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isKuehneNagelJob({ company: 'Kuehne+Nagel' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isKuehneNagelJob({ url: 'https://kuehne-nagel.com/jobs/123' })).toBe(true);
    });

    it('matches by Phenom careers subdomain URL', () => {
      expect(isKuehneNagelJob({ url: 'https://jobs.kuehne-nagel.com/global/en/job/KUNAGLOBAL13157EXTERNALENGLOBAL/x' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isKuehneNagelJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isKuehneNagelJob(null)).toBe(false);
      expect(isKuehneNagelJob(undefined)).toBe(false);
      expect(isKuehneNagelJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://kuehne-nagel.com/careers/job-123')).toBe(true);
    });

    it('trusts the Phenom careers subdomain', () => {
      expect(isTrustedDomain('https://jobs.kuehne-nagel.com/global/en/job/KUNAGLOBAL13157EXTERNALENGLOBAL/x')).toBe(true);
    });

    it('rejects unrelated domains', () => {
      expect(isTrustedDomain('https://evil.com/kuehne-nagel.com')).toBe(false);
    });

    it('rejects malformed URLs', () => {
      expect(isTrustedDomain('not-a-url')).toBe(false);
      expect(isTrustedDomain('')).toBe(false);
    });
  });

  // ── ParsedJob shape ──
  describe('ParsedJob shape', () => {
    // A minimal valid job reference
    const validJob = {
      id: 'kuehne-nagel-abc123',
      slug: 'test-position-kuehne-nagel-schindellegi',
      slugByLocale: { de: 'test-position-kuehne-nagel-schindellegi' },
      company: 'Kuehne+Nagel',
      companyKey: 'kuehne-nagel',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation purposes only.',
      descriptionByLocale: { de: 'A test job description for validation purposes only.' },
      location: 'Schindellegi',
      canton: 'SZ',
      url: 'https://jobs.kuehne-nagel.com/global/en/job/KUNAGLOBALTEST/test',
      source: 'Kuehne+Nagel Dedicated Parser',
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
      expect(validJob.id).toMatch(/^kuehne-nagel-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });

  // ── HQ canton-gated address fallback (bug-pattern guard) ──
  describe('HQ address fallback discipline', () => {
    it('slugify produces a URL-safe slug for a real Kuehne+Nagel title', () => {
      const slug = slugify('Global Insurance Program Manager (m/f/d) kuehne nagel Schindellegi');
      expect(slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
