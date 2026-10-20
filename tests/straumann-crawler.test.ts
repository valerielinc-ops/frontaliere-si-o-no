import { describe, it, expect } from 'vitest';
import {
  STRAUMANN_KEY,
  STRAUMANN_COMPANY_NAME,
  isStraumannJob,
  isTrustedDomain,
  parseStraumannDetailHtml,
} from '../scripts/lib/straumann-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Straumann crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(STRAUMANN_KEY).toBe('straumann');
    expect(STRAUMANN_COMPANY_NAME).toBe('Straumann');
  });

  // ── isCompanyJob ──
  describe('isStraumannJob', () => {
    it('matches by companyKey', () => {
      expect(isStraumannJob({ companyKey: 'straumann' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isStraumannJob({ company: 'Straumann' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isStraumannJob({ url: 'https://straumann.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isStraumannJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isStraumannJob(null)).toBe(false);
      expect(isStraumannJob(undefined)).toBe(false);
      expect(isStraumannJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://straumann.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.straumann.com/job/456')).toBe(true);
    });

    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
    });

    it('handles invalid URLs', () => {
      expect(isTrustedDomain('')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  describe('detail geography', () => {
    it('marks a foreign JobPosting leaked by the Switzerland listing facet', () => {
      const url = 'https://careers.straumann.com/global/en/job/21681/example';
      const html = `<script type="application/ld+json">${JSON.stringify({
        '@type': 'JobPosting',
        title: 'Global Medical Education Demo Materials Manager',
        description: '<p>Coordinate medical education materials across the global organization.</p>',
        jobLocation: {
          '@type': 'Place',
          address: {
            '@type': 'PostalAddress',
            addressLocality: 'Madrid',
            addressCountry: 'Spain',
          },
        },
      })}</script>`;

      expect(parseStraumannDetailHtml(html, url)).toMatchObject({
        location: 'Madrid',
        explicitlyForeign: true,
      });
    });

    it('selects the matching Swiss posting when a foreign sibling comes first', () => {
      const url = 'https://careers.straumann.com/global/en/job/12345/quality-engineer';
      const title = 'Quality Engineer';
      const html = `<script type="application/ld+json">${JSON.stringify([
        {
          '@type': 'JobPosting',
          title: 'Recommended Sales Manager',
          url: 'https://careers.straumann.com/global/en/job/99999/recommended-sales-manager',
          description: 'Lead the Madrid sales organization.',
          jobLocation: {
            '@type': 'Place',
            address: { '@type': 'PostalAddress', addressLocality: 'Madrid', postalCode: '28001', addressCountry: 'Spain' },
          },
        },
        {
          '@type': 'JobPosting',
          title,
          url,
          description: 'Maintain quality systems for the Swiss manufacturing organization.',
          jobLocation: {
            '@type': 'Place',
            address: { '@type': 'PostalAddress', addressLocality: 'Basel', postalCode: '4002', addressCountry: 'Switzerland' },
          },
        },
      ])}</script>`;

      expect(parseStraumannDetailHtml(html, url, title)).toMatchObject({
        description: 'Maintain quality systems for the Swiss manufacturing organization.',
        location: 'Basel',
        postalCode: '4002',
        explicitlyForeign: false,
      });
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
      expect(slugify('Developer straumann ch')).toBe('developer-straumann-ch');
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
      id: 'straumann-abc123',
      slug: 'test-position-straumann-ch',
      slugByLocale: { en: 'test-position-straumann-ch' },
      company: 'Straumann',
      companyKey: 'straumann',
      title: 'Test Position',
      titleByLocale: { en: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { en: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://straumann.com/jobs/test',
      source: 'Straumann Dedicated Parser',
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
      expect(validJob.id).toMatch(/^straumann-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
