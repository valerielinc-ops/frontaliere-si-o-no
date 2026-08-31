import { describe, it, expect } from 'vitest';
import {
  HILTI_KEY,
  HILTI_COMPANY_NAME,
  isHiltiJob,
  isTrustedDomain,
  resolveHiltiListingGeography,
} from '../scripts/lib/hilti-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';
import { schemaJobLocationCandidates } from '../scripts/lib/prospector/location-evidence.mjs';

describe('Hilti crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(HILTI_KEY).toBe('hilti');
    expect(HILTI_COMPANY_NAME).toBe('Hilti');
  });

  // ── isCompanyJob ──
  describe('isHiltiJob', () => {
    it('matches by companyKey', () => {
      expect(isHiltiJob({ companyKey: 'hilti' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isHiltiJob({ company: 'Hilti' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isHiltiJob({ url: 'https://hilti.group/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isHiltiJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isHiltiJob(null)).toBe(false);
      expect(isHiltiJob(undefined)).toBe(false);
      expect(isHiltiJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://hilti.group/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.hilti.group/job/456')).toBe(true);
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
      expect(slugify('Developer hilti ch')).toBe('developer-hilti-ch');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  describe('structured location evidence', () => {
    it('blocks a Swiss-looking listing when detail country is authoritative foreign', () => {
      const locationCandidates = schemaJobLocationCandidates({
        address: { addressLocality: 'Geneva', addressRegion: 'NY', addressCountry: 'US' },
      });
      expect(resolveHiltiListingGeography({ location: 'Geneva', locationCandidates }).geography).toBeNull();
    });

    it('selects the Swiss candidate after a foreign first jobLocation', () => {
      const locationCandidates = schemaJobLocationCandidates([
        { address: { addressLocality: 'Paris', addressCountry: 'FR' } },
        { address: { addressLocality: 'Zürich', addressRegion: 'ZH', addressCountry: 'CH' } },
      ]);
      expect(resolveHiltiListingGeography({ location: 'Geneva', locationCandidates }).geography)
        .toMatchObject({ location: 'Zürich, ZH', canton: 'ZH', addressCountry: 'CH' });
    });

    it('does not let an LI candidate pre-empt a later Swiss location', () => {
      const locationCandidates = schemaJobLocationCandidates([
        { address: { addressLocality: 'Schaan', addressCountry: 'LI' } },
        { address: { addressLocality: 'Buchs', addressRegion: 'SG', addressCountry: 'CH', postalCode: '9470' } },
      ]);
      const decision = resolveHiltiListingGeography({ location: 'Multiple locations', locationCandidates });
      expect(decision.geography).toMatchObject({ location: 'Buchs, SG', canton: 'SG' });
      expect(decision.candidate).toMatchObject({ addressLocality: 'Buchs', postalCode: '9470' });
    });

    it('keeps the listing location when detail geography is unresolved', () => {
      expect(resolveHiltiListingGeography({ location: 'Chiasso' }).geography)
        .toMatchObject({ location: 'Chiasso', canton: 'TI' });
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    // A minimal valid job for reference
    const validJob = {
      id: 'hilti-abc123',
      slug: 'test-position-hilti-ch',
      slugByLocale: { en: 'test-position-hilti-ch' },
      company: 'Hilti',
      companyKey: 'hilti',
      title: 'Test Position',
      titleByLocale: { en: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { en: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://hilti.group/jobs/test',
      source: 'Hilti Dedicated Parser',
      sourceLang: 'en',
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
      expect(validJob.id).toMatch(/^hilti-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
