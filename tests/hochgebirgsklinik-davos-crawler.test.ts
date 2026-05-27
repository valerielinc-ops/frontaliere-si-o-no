import { describe, it, expect } from 'vitest';
import {
  HOCHGEBIRGSKLINIK_DAVOS_KEY,
  HOCHGEBIRGSKLINIK_DAVOS_COMPANY_NAME,
  isHochgebirgsklinikDavosJob,
  isTrustedDomain,
} from '../scripts/lib/hochgebirgsklinik-davos-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Hochgebirgsklinik Davos crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(HOCHGEBIRGSKLINIK_DAVOS_KEY).toBe('hochgebirgsklinik-davos');
    expect(HOCHGEBIRGSKLINIK_DAVOS_COMPANY_NAME).toBe('Hochgebirgsklinik Davos');
  });

  // ── isCompanyJob ──
  describe('isHochgebirgsklinikDavosJob', () => {
    it('matches by companyKey', () => {
      expect(isHochgebirgsklinikDavosJob({ companyKey: 'hochgebirgsklinik-davos' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isHochgebirgsklinikDavosJob({ company: 'Hochgebirgsklinik Davos' })).toBe(true);
    });

    it('matches by company name case insensitive', () => {
      expect(isHochgebirgsklinikDavosJob({ company: 'HOCHGEBIRGSKLINIK DAVOS AG' })).toBe(true);
    });

    it('matches by URL domain (hochgebirgsklinik.ch)', () => {
      expect(isHochgebirgsklinikDavosJob({ url: 'https://karriere.hochgebirgsklinik.ch/offer/test' })).toBe(true);
    });

    it('matches by URL domain (job-shop.com)', () => {
      expect(isHochgebirgsklinikDavosJob({ url: 'https://api.my-job-shop.com/api/typesense/search' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isHochgebirgsklinikDavosJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isHochgebirgsklinikDavosJob(null)).toBe(false);
      expect(isHochgebirgsklinikDavosJob(undefined)).toBe(false);
      expect(isHochgebirgsklinikDavosJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://hochgebirgsklinik.ch/careers')).toBe(true);
    });

    it('trusts karriere subdomain', () => {
      expect(isTrustedDomain('https://karriere.hochgebirgsklinik.ch/offer/test/uuid')).toBe(true);
    });

    it('trusts job-shop.com domain', () => {
      expect(isTrustedDomain('https://cdn.job-shop.com/uploads/image.jpg')).toBe(true);
    });

    it('trusts my-job-shop.com API domain', () => {
      expect(isTrustedDomain('https://api.my-job-shop.com/api/typesense/search')).toBe(true);
    });

    it('trusts umantis.com application domain', () => {
      expect(isTrustedDomain('https://recruitingapp-2932.umantis.com/Vacancies/595/Application')).toBe(true);
    });

    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
    });

    it('rejects partial domain matches', () => {
      expect(isTrustedDomain('https://not-hochgebirgsklinik.ch/jobs')).toBe(false);
    });

    it('handles invalid URLs', () => {
      expect(isTrustedDomain('')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  // ── slugify (imported from crawler-template) ──
  describe('slugify', () => {
    it('converts title to URL-safe slug', () => {
      const slug = slugify('Pflegefachperson (w/m/d)');
      expect(slug).toBe('pflegefachperson-w-m-d');
    });

    it('strips German umlauts', () => {
      expect(slugify('Oberärztin Kardiologie')).toBe('oberarztin-kardiologie');
    });

    it('builds slug with company suffix', () => {
      expect(slugify('Psychologe hochgebirgsklinik-davos ch')).toBe('psychologe-hochgebirgsklinik-davos-ch');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    const validJob = {
      id: 'hochgebirgsklinik-davos-abc123def456',
      slug: 'pflegefachperson-hochgebirgsklinik-davos-ch',
      slugByLocale: { de: 'pflegefachperson-hochgebirgsklinik-davos-ch' },
      company: 'Hochgebirgsklinik Davos',
      companyKey: 'hochgebirgsklinik-davos',
      companyDomain: 'hochgebirgsklinik.ch',
      title: 'Pflegefachperson (w/m/d)',
      titleByLocale: { de: 'Pflegefachperson (w/m/d)' },
      description: 'Pflegefachperson (w/m/d) — Hochgebirgsklinik Davos. Aufgaben: Betreuung stationärer Patienten.',
      descriptionByLocale: { de: 'Pflegefachperson (w/m/d) — Hochgebirgsklinik Davos. Aufgaben: Betreuung stationärer Patienten.' },
      location: 'Davos',
      canton: 'GR',
      url: 'https://karriere.hochgebirgsklinik.ch/offer-redirect/?offerApiId=test',
      source: 'Hochgebirgsklinik Davos Dedicated Parser (Connectoor/Typesense)',
      sourceLang: 'de',
      crawledAt: new Date().toISOString(),
      postalCode: '7270',
      addressLocality: 'Davos',
      addressCountry: 'CH',
      country: 'CH',
      sector: 'Sanità / Assistenza',
      category: 'Infermieristica',
      contract: 'full-time',
      employmentType: 'FULL_TIME',
      experienceLevel: 'mid',
      currency: 'CHF',
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

    it('has all recommended fields', () => {
      const recommended = [
        'postalCode', 'addressLocality', 'addressCountry', 'country',
        'sector', 'category', 'contract', 'employmentType',
        'experienceLevel', 'currency',
      ];
      for (const field of recommended) {
        expect(validJob).toHaveProperty(field);
      }
    });

    it('slug only contains source locale', () => {
      const locales = Object.keys(validJob.slugByLocale);
      expect(locales).toHaveLength(1);
      expect(locales[0]).toBe(validJob.sourceLang);
    });

    it('id starts with company key', () => {
      expect(validJob.id).toMatch(/^hochgebirgsklinik-davos-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });

    it('uses Davos as default location', () => {
      expect(validJob.location).toBe('Davos');
      expect(validJob.canton).toBe('GR');
      expect(validJob.postalCode).toBe('7270');
    });

    it('uses correct sector for healthcare', () => {
      expect(validJob.sector).toBe('Sanità / Assistenza');
    });
  });
});
