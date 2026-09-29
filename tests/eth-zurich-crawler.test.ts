import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  extractEthZurichDetailDescription,
  ETH_ZURICH_KEY,
  ETH_ZURICH_COMPANY_NAME,
  isEthZurichJob,
  isTrustedDomain,
} from '../scripts/lib/eth-zurich-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('ETH Zürich crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(ETH_ZURICH_KEY).toBe('eth-zurich');
    expect(ETH_ZURICH_COMPANY_NAME).toBe('ETH Zürich');
  });

  // ── isCompanyJob ──
  describe('isEthZurichJob', () => {
    it('matches by companyKey', () => {
      expect(isEthZurichJob({ companyKey: 'eth-zurich' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isEthZurichJob({ company: 'ETH Zürich' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isEthZurichJob({ url: 'https://jobs.ethz.ch/job/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isEthZurichJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isEthZurichJob(null)).toBe(false);
      expect(isEthZurichJob(undefined)).toBe(false);
      expect(isEthZurichJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://ethz.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://jobs.ethz.ch/job/456')).toBe(true);
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
      expect(slugify('Developer eth-zurich ch')).toBe('developer-eth-zurich-ch');
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
      id: 'eth-zurich-abc123',
      slug: 'test-position-eth-zurich-ch',
      slugByLocale: { it: 'test-position-eth-zurich-ch' },
      company: 'ETH Zürich',
      companyKey: 'eth-zurich',
      title: 'Test Position',
      titleByLocale: { it: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { it: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://ethzurich.ch/jobs/test',
      source: 'ETH Zürich Dedicated Parser',
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
      expect(validJob.id).toMatch(/^eth-zurich-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });

  // Issue 5253: a `.slice(0, 4000)` cut long postings mid-list, and only the
  // first `section.description` was read, so the application block and the
  // «About ETH Zürich» paragraph never reached the published description.
  describe('extractEthZurichDetailDescription — whole posting (real page, minimised)', () => {
    const html = readFileSync(resolve(__dirname, 'fixtures', 'eth-zurich', 'detail-doctoral-position.html'), 'utf8');
    const text = extractEthZurichDetailDescription(html);

    it('keeps the task list to its last item instead of cutting at 4000 chars', () => {
      expect(text.length).toBeGreaterThan(4000);
      expect(text).toContain('• Support grant applications for the team and support related activities from Singapore-ETH Centre, Bezos Centre for Sustainable Protein at NUS, ETH World Food System Center WFSC, and ETH for Development ETH4D competence center');
      expect(text).toContain('Profile\n• A MSc in Nutrition and Health');
    });

    it('reads the application block and the employer paragraph', () => {
      expect(text).toContain('Curious? So are we.');
      expect(text).toContain('• Motivation letter (max. 1 page)');
      expect(text).toContain('About ETH Zürich');
    });

    it('drops page furniture and decodes entities', () => {
      expect(text).not.toMatch(/Drucken|chevron_right|\bWorkplace\b/);
      expect(text).not.toMatch(/&[a-zA-Z]+;/);
    });
  });
});
