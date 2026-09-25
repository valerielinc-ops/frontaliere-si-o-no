import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  CSD_ENGINEERS_KEY,
  CSD_ENGINEERS_COMPANY_NAME,
  isCsdEngineersJob,
  isTrustedDomain,
  parseCsdDetailPage,
} from '../scripts/lib/csd-engineers-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

const DETAIL_FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'csd-engineers-detail-raw-control.html',
);

describe('CSD ENGINEERS crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(CSD_ENGINEERS_KEY).toBe('csd-engineers');
    expect(CSD_ENGINEERS_COMPANY_NAME).toBe('CSD ENGINEERS');
  });

  // ── isCompanyJob ──
  describe('isCsdEngineersJob', () => {
    it('matches by companyKey', () => {
      expect(isCsdEngineersJob({ companyKey: 'csd-engineers' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isCsdEngineersJob({ company: 'CSD ENGINEERS' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isCsdEngineersJob({ url: 'https://csd.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isCsdEngineersJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isCsdEngineersJob(null)).toBe(false);
      expect(isCsdEngineersJob(undefined)).toBe(false);
      expect(isCsdEngineersJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://csd.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.csd.ch/job/456')).toBe(true);
    });

    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
    });

    it('handles invalid URLs', () => {
      expect(isTrustedDomain('')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  describe('parseCsdDetailPage', () => {
    it('recovers the rich description from entity-escaped JSON-LD with raw line breaks', () => {
      const parsed = parseCsdDetailPage(fs.readFileSync(DETAIL_FIXTURE, 'utf8'));

      expect(parsed).toMatchObject({
        city: 'Zürich',
        postalCode: '8005',
        street: 'Hardturmstrasse 253',
        employmentType: 'FULL_TIME',
      });
      expect(parsed?.description).toContain('Leitung von anspruchsvollen Hochbauprojekten');
      expect(parsed?.description).toContain('Bauingenieur:innen');
      expect(parsed?.description.length).toBeGreaterThan(180);
      expect(parsed?.description).not.toMatch(/<[^>]+>/);
      expect(parsed?.description).not.toContain('CSD ENGINEERS, Zürich');
    });

    it('selects the current posting by its structured URL before recommendations', () => {
      const pageUrl = 'https://jobs.csd.ch/jobs/current-role';
      const html = `<h1>Current Role</h1><script type="application/ld+json">${JSON.stringify([
        {
          '@type': 'JobPosting',
          title: 'Current Role',
          url: pageUrl,
          description: '<p>Current detail description with enough content to publish safely.</p>',
          jobLocation: { address: { addressLocality: 'Zürich' } },
        },
        {
          '@type': 'JobPosting',
          title: 'Recommended Role',
          url: 'https://jobs.csd.ch/jobs/recommended-role',
          description: '<p>Recommended detail description that must not be published for the current page.</p>',
          jobLocation: { address: { addressLocality: 'Genève' } },
        },
      ])}</script>`;

      expect(parseCsdDetailPage(html, { url: pageUrl, title: 'Current Role' })).toMatchObject({
        city: 'Zürich',
        description: 'Current detail description with enough content to publish safely.',
      });
    });

    it('uses a unique current title when structured URLs are absent', () => {
      const html = `<h1>Current Role</h1><script type="application/ld+json">${JSON.stringify([
        {
          '@type': 'JobPosting',
          title: 'Current Role',
          description: '<p>Current detail description with enough content to publish safely.</p>',
          jobLocation: { address: { addressLocality: 'Zürich' } },
        },
        {
          '@type': 'JobPosting',
          title: 'Recommended Role',
          description: '<p>Recommended detail description that must not be published for the current page.</p>',
          jobLocation: { address: { addressLocality: 'Genève' } },
        },
      ])}</script>`;

      expect(parseCsdDetailPage(html, { title: 'Current Role' })).toMatchObject({ city: 'Zürich' });
    });

    it('fails closed when multiple postings cannot be tied to the current page', () => {
      const html = `<script type="application/ld+json">${JSON.stringify([
        { '@type': 'JobPosting', title: 'First Role', description: '<p>First role.</p>' },
        { '@type': 'JobPosting', title: 'Second Role', description: '<p>Second role.</p>' },
      ])}</script>`;

      expect(parseCsdDetailPage(html, { url: 'https://jobs.csd.ch/jobs/current-role' })).toBeNull();
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
      expect(slugify('Developer csd-engineers ch')).toBe('developer-csd-engineers-ch');
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
      id: 'csd-engineers-abc123',
      slug: 'test-position-csd-engineers-ch',
      slugByLocale: { fr: 'test-position-csd-engineers-ch' },
      company: 'CSD ENGINEERS',
      companyKey: 'csd-engineers',
      title: 'Test Position',
      titleByLocale: { fr: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { fr: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://csd.ch/jobs/test',
      source: 'CSD ENGINEERS Dedicated Parser',
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
      expect(validJob.id).toMatch(/^csd-engineers-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
