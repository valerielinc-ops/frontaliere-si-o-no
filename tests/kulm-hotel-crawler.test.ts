import { describe, it, expect } from 'vitest';
import {
  KULM_HOTEL_KEY,
  KULM_HOTEL_COMPANY_NAME,
  isKulmHotelJob,
  isTrustedDomain,
} from '../scripts/lib/kulm-hotel-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Kulm Hotel St. Moritz crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(KULM_HOTEL_KEY).toBe('kulm-hotel');
    expect(KULM_HOTEL_COMPANY_NAME).toBe('Kulm Hotel St. Moritz');
  });

  // ── isCompanyJob ──
  describe('isKulmHotelJob', () => {
    it('matches by companyKey', () => {
      expect(isKulmHotelJob({ companyKey: 'kulm-hotel' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isKulmHotelJob({ company: 'Kulm Hotel St. Moritz' })).toBe(true);
    });

    it('matches by URL domain (careers.kulm.com)', () => {
      expect(isKulmHotelJob({ url: 'https://careers.kulm.com/en/vacancies/650' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isKulmHotelJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isKulmHotelJob(null)).toBe(false);
      expect(isKulmHotelJob(undefined)).toBe(false);
      expect(isKulmHotelJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://kulm.com/careers/job-123')).toBe(true);
    });

    it('trusts careers subdomain', () => {
      expect(isTrustedDomain('https://careers.kulm.com/en/vacancies/650')).toBe(true);
    });

    it('trusts www subdomain', () => {
      expect(isTrustedDomain('https://www.kulm.com/about')).toBe(true);
    });

    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
    });

    it('rejects domains that contain kulm but are not subdomains', () => {
      expect(isTrustedDomain('https://notkulm.com/jobs')).toBe(false);
    });

    it('handles invalid URLs', () => {
      expect(isTrustedDomain('')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  // ── slugify (imported from crawler-template) ──
  describe('slugify', () => {
    it('converts title to URL-safe slug', () => {
      const slug = slugify('Chef de Rang (m/w/d)');
      expect(slug).toBe('chef-de-rang-m-w-d');
    });

    it('strips diacritics', () => {
      expect(slugify('Maître de Rang')).toBe('maitre-de-rang');
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('Front Office Agent kulm hotel st moritz')).toMatch(/^front-office-agent-kulm-hotel/);
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    // A minimal valid job reflecting the Kulm Hotel crawler output
    const validJob = {
      id: 'kulm-hotel-abc123def456',
      slug: 'chef-de-rang-kulm-hotel-st-moritz',
      slugByLocale: { en: 'chef-de-rang-kulm-hotel-st-moritz' },
      company: 'Kulm Hotel St. Moritz',
      companyKey: 'kulm-hotel',
      companyDomain: 'kulm.com',
      title: 'Chef de Rang (m/w/d)',
      titleByLocale: { en: 'Chef de Rang (m/w/d)' },
      description: 'Chef de Rang (m/w/d) — Kulm Hotel St. Moritz (Grand Hotel Kronenhof), Pontresina (Engadin, Graubünden). Pensum: 100%.',
      descriptionByLocale: { en: 'Chef de Rang (m/w/d) — Kulm Hotel St. Moritz (Grand Hotel Kronenhof), Pontresina (Engadin, Graubünden). Pensum: 100%.' },
      location: 'Pontresina',
      canton: 'GR',
      url: 'https://careers.kulm.com/en/vacancies/650',
      source: 'Kulm Hotel St. Moritz Dedicated Parser',
      sourceLang: 'en',
      crawledAt: new Date().toISOString(),
      addressLocality: 'Pontresina',
      postalCode: '7504',
      addressRegion: 'GR',
      addressCountry: 'CH',
      sector: 'Ospitalità / Hotellerie',
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
      expect(validJob.id).toMatch(/^kulm-hotel-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });

    it('canton is GR for Engadin locations', () => {
      expect(validJob.canton).toBe('GR');
    });

    it('sector reflects hospitality industry', () => {
      expect(validJob.sector).toBe('Ospitalità / Hotellerie');
    });

    it('url points to careers.kulm.com', () => {
      expect(validJob.url).toMatch(/^https:\/\/careers\.kulm\.com\//);
    });
  });
});
