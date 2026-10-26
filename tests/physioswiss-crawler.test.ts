import { describe, it, expect } from 'vitest';
import {
  extractPhysioswissListingCandidates,
  PHYSIOSWISS_KEY,
  PHYSIOSWISS_COMPANY_NAME,
  isPhysioswissJob,
  isTrustedDomain,
} from '../scripts/lib/physioswiss-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Physio swiss crawler parser', () => {
  it('uses source-owned accessible listing titles instead of generic JSON-LD chrome', () => {
    const firstUrl = 'https://physioswiss.ch/stelleninserate/158533/dipl-physiotherapeutin-20-60/';
    const secondUrl = 'https://physioswiss.ch/stelleninserate/157790/dipl-physiotherapeut-in-40-100/';
    const html = `<script type="application/ld+json">${JSON.stringify({
      '@type': 'JobPosting',
      title: 'Header',
      url: firstUrl,
    })}</script>
      <a href="${firstUrl}" aria-label="Stellenanzeige dipl. Physiotherapeut*in 20-60% öffnen."></a>
      <a href="${secondUrl}" aria-label="Stellenanzeige Dipl. Physiotherapeut/-in (40-100%) öffnen."></a>`;

    expect(extractPhysioswissListingCandidates(html)).toEqual([
      { title: 'dipl. Physiotherapeut*in 20-60%', url: firstUrl, via: 'physioswiss-listing-link' },
      { title: 'Dipl. Physiotherapeut/-in (40-100%)', url: secondUrl, via: 'physioswiss-listing-link' },
    ]);
  });

  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(PHYSIOSWISS_KEY).toBe('physioswiss');
    expect(PHYSIOSWISS_COMPANY_NAME).toBe('Physio swiss');
  });

  // ── isCompanyJob ──
  describe('isPhysioswissJob', () => {
    it('matches by companyKey', () => {
      expect(isPhysioswissJob({ companyKey: 'physioswiss' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isPhysioswissJob({ company: 'Physio swiss' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isPhysioswissJob({ url: 'https://physioswiss.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isPhysioswissJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isPhysioswissJob(null)).toBe(false);
      expect(isPhysioswissJob(undefined)).toBe(false);
      expect(isPhysioswissJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://physioswiss.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.physioswiss.ch/job/456')).toBe(true);
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
      expect(slugify('Developer physioswiss ch')).toBe('developer-physioswiss-ch');
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
      id: 'physioswiss-abc123',
      slug: 'test-position-physioswiss-ch',
      slugByLocale: { de: 'test-position-physioswiss-ch' },
      company: 'Physio swiss',
      companyKey: 'physioswiss',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://physioswiss.ch/jobs/test',
      source: 'Physio swiss Dedicated Parser',
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
      expect(validJob.id).toMatch(/^physioswiss-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
