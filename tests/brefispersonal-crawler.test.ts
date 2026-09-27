import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  BREFISPERSONAL_KEY,
  BREFISPERSONAL_COMPANY_NAME,
  isBrefispersonalJob,
  isTrustedDomain,
} from '../scripts/lib/brefispersonal-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

const brefispersonalSpec = JSON.parse(
  readFileSync(new URL('../data/prospector/crawlers/brefispersonal.json', import.meta.url), 'utf8'),
);

describe('brefis personal ag crawler parser', () => {
  describe('promoted prospector spec', () => {
    it('uses the vacancy index and variable detail template', () => {
      expect(brefispersonalSpec.companyHost).toBe('brefis.ch');
      expect(brefispersonalSpec.seedUrls).toEqual(['https://brefis.ch/Vacancyboard/']);
      expect(brefispersonalSpec.mode).toBe('template');
      expect(brefispersonalSpec.detailTemplate).toBe('/Vacancyboard/Detail/#');
      expect(brefispersonalSpec.detailEnrichment).toBe(true);
      expect(brefispersonalSpec.sampleVacancyCount).toBeGreaterThan(1);
    });
  });

  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(BREFISPERSONAL_KEY).toBe('brefispersonal');
    expect(BREFISPERSONAL_COMPANY_NAME).toBe('brefis personal ag');
  });

  // ── isCompanyJob ──
  describe('isBrefispersonalJob', () => {
    it('matches by companyKey', () => {
      expect(isBrefispersonalJob({ companyKey: 'brefispersonal' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isBrefispersonalJob({ company: 'brefis personal ag' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isBrefispersonalJob({ url: 'https://brefis.ch/Vacancyboard/Detail/46980' })).toBe(true);
      expect(isBrefispersonalJob({ url: 'https://brefispersonal.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isBrefispersonalJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isBrefispersonalJob(null)).toBe(false);
      expect(isBrefispersonalJob(undefined)).toBe(false);
      expect(isBrefispersonalJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://brefis.ch/Vacancyboard/Detail/46980')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.brefis.ch/Vacancyboard/Detail/46980')).toBe(true);
      expect(isTrustedDomain('https://brefispersonal.ch/jobs/123')).toBe(true);
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
      expect(slugify('Developer brefispersonal ch')).toBe('developer-brefispersonal-ch');
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
      id: 'brefispersonal-abc123',
      slug: 'test-position-brefispersonal-ch',
      slugByLocale: { de: 'test-position-brefispersonal-ch' },
      company: 'brefis personal ag',
      companyKey: 'brefispersonal',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://brefis.ch/Vacancyboard/Detail/46980',
      source: 'brefis personal ag Dedicated Parser',
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
      expect(validJob.id).toMatch(/^brefispersonal-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
