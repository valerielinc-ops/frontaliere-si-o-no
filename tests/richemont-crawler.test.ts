import { describe, it, expect } from 'vitest';
import {
  RICHEMONT_KEY,
  RICHEMONT_COMPANY_NAME,
  isRichemontJob,
  isTrustedDomain,
  buildJobDescription,
} from '../scripts/lib/richemont-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Richemont crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(RICHEMONT_KEY).toBe('richemont');
    expect(RICHEMONT_COMPANY_NAME).toBe('Richemont');
  });

  // ── isCompanyJob ──
  describe('isRichemontJob', () => {
    it('matches by companyKey', () => {
      expect(isRichemontJob({ companyKey: 'richemont' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isRichemontJob({ company: 'Richemont' })).toBe(true);
    });

    it('matches by Maison name (Jaeger-LeCoultre)', () => {
      expect(isRichemontJob({ company: 'Jaeger-LeCoultre' })).toBe(true);
    });

    it('matches by Maison name (Cartier)', () => {
      expect(isRichemontJob({ company: 'Cartier Manufacture' })).toBe(true);
    });

    it('matches by Maison name (IWC)', () => {
      expect(isRichemontJob({ company: 'IWC Schaffhausen' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isRichemontJob({ url: 'https://richemont.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isRichemontJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isRichemontJob(null)).toBe(false);
      expect(isRichemontJob(undefined)).toBe(false);
      expect(isRichemontJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://richemont.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.richemont.com/job/456')).toBe(true);
    });

    it('trusts the Workday tenant backing some Maisons', () => {
      expect(isTrustedDomain('https://richemont.wd3.myworkdayjobs.com/job/X')).toBe(true);
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
      expect(slugify('Developer richemont ch')).toBe('developer-richemont-ch');
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
      id: 'richemont-abc123',
      slug: 'test-position-richemont-ch',
      slugByLocale: { en: 'test-position-richemont-ch' },
      company: 'Richemont',
      companyKey: 'richemont',
      title: 'Test Position',
      titleByLocale: { en: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { en: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://richemont.com/jobs/test',
      source: 'Richemont Dedicated Parser (Playwright)',
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
      expect(validJob.id).toMatch(/^richemont-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });

  // ── buildJobDescription ──
  describe('buildJobDescription', () => {
    const cardFields = {
      title: 'HRIS Learning Intern',
      maison: 'Richemont',
      department: 'Technology',
      locationText: 'Meyrin, CH',
    };

    it('returns rich detail text when ≥200 chars', () => {
      const rich = 'Reference code: JR124659. ' + 'Richemont owns leading luxury Maisons. '.repeat(20);
      const out = buildJobDescription({ ...cardFields, detailText: rich });
      expect(out).toContain('JR124659');
      expect(out.length).toBeGreaterThan(200);
    });

    it('falls back to template when detail text is empty', () => {
      const out = buildJobDescription({ ...cardFields, detailText: '' });
      expect(out).toContain('HRIS Learning Intern');
      expect(out).toContain('Maison: Richemont.');
      expect(out).toContain('Department: Technology.');
      expect(out).toContain('Location: Meyrin, CH.');
      expect(out).toContain('Compagnie Financière Richemont');
    });

    it('falls back to template when detail text is too short', () => {
      const out = buildJobDescription({ ...cardFields, detailText: 'too short' });
      expect(out).toContain('Compagnie Financière Richemont');
    });

    it('normalises whitespace in rich text', () => {
      const rich = 'Line one.\n\n\nLine two.   Excessive    spaces. ' + 'x'.repeat(200);
      const out = buildJobDescription({ ...cardFields, detailText: rich });
      expect(out).not.toMatch(/\s{2,}/);
      expect(out).not.toMatch(/\n/);
    });

    it('handles missing card fields gracefully in fallback', () => {
      const out = buildJobDescription({ detailText: '' });
      expect(out).toContain('Compagnie Financière Richemont');
      expect(out).not.toContain('Maison:');
      expect(out).not.toContain('Department:');
    });

    it('never returns empty string', () => {
      expect(buildJobDescription({}).length).toBeGreaterThan(0);
      expect(buildJobDescription({ detailText: '' }).length).toBeGreaterThan(0);
    });
  });
});
