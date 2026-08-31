import fs from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  ACCOR_KEY,
  ACCOR_COMPANY_NAME,
  extractAccorDetailFields,
  isAccorJob,
  isTrustedDomain,
} from '../scripts/lib/accor-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

const RICH_DETAIL = fs.readFileSync(
  new URL('./__fixtures__/accor/detail-rich.html', import.meta.url),
  'utf8',
);
const DEGRADED_DETAIL = fs.readFileSync(
  new URL('./__fixtures__/accor/detail-degraded.html', import.meta.url),
  'utf8',
);
const DETAIL_URL = 'https://careers.accor.com/fr/fr/job/receptionniste-in-geneva-switzerland-jid-12345';

describe('Ibis Budget crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(ACCOR_KEY).toBe('accor');
    expect(ACCOR_COMPANY_NAME).toBe('Ibis Budget');
  });

  // ── isCompanyJob ──
  describe('isAccorJob', () => {
    it('matches by companyKey', () => {
      expect(isAccorJob({ companyKey: 'accor' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isAccorJob({ company: 'Ibis Budget' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isAccorJob({ url: 'https://careers.accor.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isAccorJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isAccorJob(null)).toBe(false);
      expect(isAccorJob(undefined)).toBe(false);
      expect(isAccorJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://careers.accor.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.careers.accor.com/job/456')).toBe(true);
    });

    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
    });

    it('handles invalid URLs', () => {
      expect(isTrustedDomain('')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  describe('Attrax detail boundary', () => {
    it('extracts only the semantic DescriptionWidget body', () => {
      const detail = extractAccorDetailFields(RICH_DETAIL, DETAIL_URL);

      expect(detail.description).toContain('Vous accueillez les clients');
      expect(detail.description).toContain('Garantir un service attentif');
      expect(detail.description).not.toContain('Postuler Partager');
      expect(detail.description).not.toContain('Director in Paris');
      expect(detail).toMatchObject({
        title: 'Réceptionniste (H/F/X)',
        location: 'Genève, GE',
        addressCountry: 'CH',
      });
    });

    it('quarantines a degraded widget instead of promoting surrounding chrome', () => {
      const detail = extractAccorDetailFields(DEGRADED_DETAIL, DETAIL_URL);

      expect(detail.description).toBe('');
      expect(detail.location).toContain('Genève');
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
      expect(slugify('Developer accor ch')).toBe('developer-accor-ch');
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
      id: 'accor-abc123',
      slug: 'test-position-accor-ch',
      slugByLocale: { fr: 'test-position-accor-ch' },
      company: 'Ibis Budget',
      companyKey: 'accor',
      title: 'Test Position',
      titleByLocale: { fr: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { fr: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://careers.accor.com/jobs/test',
      source: 'Ibis Budget Dedicated Parser',
      sourceLang: 'fr',
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
      expect(validJob.id).toMatch(/^accor-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
