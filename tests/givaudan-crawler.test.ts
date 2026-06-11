import { describe, it, expect } from 'vitest';
import {
  GIVAUDAN_KEY,
  GIVAUDAN_COMPANY_NAME,
  isGivaudanJob,
  isTrustedDomain,
} from '../scripts/lib/givaudan-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';
import { htmlToMarkdown } from '../scripts/lib/axpo-job-parser.mjs';

describe('Givaudan crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(GIVAUDAN_KEY).toBe('givaudan');
    expect(GIVAUDAN_COMPANY_NAME).toBe('Givaudan');
  });

  // ── isCompanyJob ──
  describe('isGivaudanJob', () => {
    it('matches by companyKey', () => {
      expect(isGivaudanJob({ companyKey: 'givaudan' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isGivaudanJob({ company: 'Givaudan' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isGivaudanJob({ url: 'https://givaudan.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isGivaudanJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isGivaudanJob(null)).toBe(false);
      expect(isGivaudanJob(undefined)).toBe(false);
      expect(isGivaudanJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://givaudan.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.givaudan.com/job/456')).toBe(true);
    });

    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
    });

    it('handles invalid URLs', () => {
      expect(isTrustedDomain('')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  // ── detail-page description → structured markdown ──
  // The fix replaces the flat listing `descriptionTeaser` with the full
  // schema.org JobPosting description from the detail page. That description is
  // entity-encoded HTML (&lt;ul&gt;&lt;li&gt;…) and is converted via the shared
  // htmlToMarkdown so bullets/headings survive — otherwise the parser-quality
  // audit flags the crawler "no structured content (no bullets/lists)".
  describe('detail description → structured markdown (no-structure audit fix)', () => {
    // Mirrors the entity-encoded JSON-LD JobPosting.description Givaudan serves.
    const JSONLD_DESC =
      '&lt;p&gt;Join us and celebrate the beauty of human experience.&lt;/p&gt;' +
      '&lt;p&gt;&lt;strong&gt;Your responsibilities&lt;/strong&gt;&lt;/p&gt;' +
      '&lt;ul&gt;&lt;li&gt;Drive continuous improvement initiatives across production.&lt;/li&gt;' +
      '&lt;li&gt;Analyse processes and propose data-driven optimisations.&lt;/li&gt;&lt;/ul&gt;';

    it('decodes entities and preserves list structure as "- " bullets', () => {
      const { markdown, bulletCount } = htmlToMarkdown(JSONLD_DESC);
      expect(bulletCount).toBeGreaterThanOrEqual(2);
      expect(/^- /m.test(markdown)).toBe(true);
      expect(markdown).toContain('continuous improvement');
    });

    it('produces content the parser-quality structure check accepts', () => {
      const { markdown } = htmlToMarkdown(JSONLD_DESC);
      // Mirrors hasStructuredContent() in scripts/audit-parser-quality.mjs.
      const hasStructure =
        /<li[\s>]/i.test(markdown) || /^\s*[-•*]\s/m.test(markdown) || /^\s*\d+[.)]\s/m.test(markdown);
      expect(hasStructure).toBe(true);
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
      expect(slugify('Developer givaudan ch')).toBe('developer-givaudan-ch');
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
      id: 'givaudan-abc123',
      slug: 'test-position-givaudan-ch',
      slugByLocale: { en: 'test-position-givaudan-ch' },
      company: 'Givaudan',
      companyKey: 'givaudan',
      title: 'Test Position',
      titleByLocale: { en: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { en: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://givaudan.com/jobs/test',
      source: 'Givaudan Dedicated Parser',
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
      expect(validJob.id).toMatch(/^givaudan-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
