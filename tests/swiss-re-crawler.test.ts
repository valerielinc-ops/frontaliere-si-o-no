import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SWISS_RE_KEY,
  SWISS_RE_COMPANY_NAME,
  isSwissReJob,
  isTrustedDomain,
  parseSwissReDetailPage,
  DETAIL_FETCH_DELAY_MS,
  MAX_DETAIL_FETCHES,
} from '../scripts/lib/swiss-re-job-parser.mjs';
import { slugify, stripHtml } from '../scripts/lib/crawler-template.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadFixture(name: string): string {
  return fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf-8');
}

describe('Swiss Re crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(SWISS_RE_KEY).toBe('swiss-re');
    expect(SWISS_RE_COMPANY_NAME).toBe('Swiss Re');
  });

  // ── isCompanyJob ──
  describe('isSwissReJob', () => {
    it('matches by companyKey', () => {
      expect(isSwissReJob({ companyKey: 'swiss-re' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isSwissReJob({ company: 'Swiss Re' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isSwissReJob({ url: 'https://swissre.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isSwissReJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isSwissReJob(null)).toBe(false);
      expect(isSwissReJob(undefined)).toBe(false);
      expect(isSwissReJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://swissre.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.swissre.ch/job/456')).toBe(true);
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
      expect(slugify('Developer swiss-re ch')).toBe('developer-swiss-re-ch');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Detail-page parser (#3836 — listing cards carry no description) ──
  describe('parseSwissReDetailPage', () => {
    // Real payload captured 2026-07-10 from
    // https://www.swissre.com/careers/job/Senior-Application-Engineer-Angular/1413738333
    const html = loadFixture('swiss-re-detail-application-engineer.html');

    it('extracts a rich, structured description from ArticleSection richtext', () => {
      const detail = parseSwissReDetailPage(html);
      expect(detail).not.toBeNull();
      const text = stripHtml(detail!.descriptionHtml);
      // Parser-quality audit thresholds: not thin (>=100 chars) AND structured
      // (bullet lines after stripHtml turns <li> into "• ").
      expect(text.length).toBeGreaterThan(1000);
      expect(text.split(/\s+/).filter(Boolean).length).toBeGreaterThan(30);
      expect(/^\s*[-•*]\s/m.test(text)).toBe(true);
      expect(detail!.descriptionHtml).toMatch(/<li[\s>]/i);
      expect(text).toContain('Key Responsibilities');
      expect(text).toContain('About the Role');
    });

    it('extracts the Location metadata line without leaking it into the body', () => {
      const detail = parseSwissReDetailPage(html);
      expect(detail!.location).toBe('Hyderabad, TG, IN');
      const text = stripHtml(detail!.descriptionHtml);
      expect(/^\s*Location:\s*Hyderabad/m.test(text)).toBe(false);
    });

    it('extracts the employment-type chip', () => {
      expect(parseSwissReDetailPage(html)!.employmentText).toBe('Regular Employment');
    });

    it('does not leak header navigation into the description', () => {
      const text = stripHtml(parseSwissReDetailPage(html)!.descriptionHtml);
      expect(text).not.toContain('Homepage');
      expect(text).not.toContain('Quick navigation');
    });

    it('returns null for empty or content-free pages', () => {
      expect(parseSwissReDetailPage('')).toBeNull();
      expect(parseSwissReDetailPage('<html><body><p>Access denied</p></body></html>')).toBeNull();
    });

    it('keeps a body that merely mentions "Location:" (only short metadata lines are stripped)', () => {
      const page = `
        <section class="ArticleSection"><div class="richtext">
          <p><strong>Location:</strong> ${'x'.repeat(150)} flexible working across our offices.</p>
          <ul><li>Do things</li><li>Do more things</li></ul>
        </div></section>`;
      const detail = parseSwissReDetailPage(page);
      expect(detail).not.toBeNull();
      expect(detail!.location).toBe('');
      expect(stripHtml(detail!.descriptionHtml)).toContain('flexible working');
    });
  });

  // ── Detail-fetch budget (#3836) ──
  describe('detail fetch budget', () => {
    it('applies a polite delay between detail fetches', () => {
      expect(DETAIL_FETCH_DELAY_MS).toBeGreaterThanOrEqual(300);
    });

    it('caps detail fetches above the live listing count (~320) so no job is silently thinned', () => {
      expect(MAX_DETAIL_FETCHES).toBeGreaterThanOrEqual(400);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    // A minimal valid job for reference
    const validJob = {
      id: 'swiss-re-abc123',
      slug: 'test-position-swiss-re-ch',
      slugByLocale: { it: 'test-position-swiss-re-ch' },
      company: 'Swiss Re',
      companyKey: 'swiss-re',
      title: 'Test Position',
      titleByLocale: { it: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { it: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://swissre.ch/jobs/test',
      source: 'Swiss Re Dedicated Parser',
      sourceLang: 'it',
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
      expect(validJob.id).toMatch(/^swiss-re-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
