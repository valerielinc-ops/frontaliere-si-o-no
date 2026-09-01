import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi } from 'vitest';
import {
  OCST_KEY,
  OCST_COMPANY_NAME,
  OCST_CAREER_URL,
  assertCompleteOcstSnapshot,
  extractOcstCareersSnapshot,
  fetchAllOcstJobs,
  isOcstJob,
  isTrustedDomain,
} from '../scripts/lib/ocst-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'ocst');
const EXPLICIT_EMPTY_HTML = fs.readFileSync(path.join(FIXTURES, 'explicit-empty.html'), 'utf8');
const DEGRADED_NEWS_HTML = fs.readFileSync(path.join(FIXTURES, 'degraded-news-links.html'), 'utf8');

describe('OCST crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(OCST_KEY).toBe('ocst');
    expect(OCST_COMPANY_NAME).toBe('OCST');
  });

  // ── isCompanyJob ──
  describe('isOcstJob', () => {
    it('matches by companyKey', () => {
      expect(isOcstJob({ companyKey: 'ocst' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isOcstJob({ company: 'OCST' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isOcstJob({ url: 'https://ocst.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isOcstJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isOcstJob(null)).toBe(false);
      expect(isOcstJob(undefined)).toBe(false);
      expect(isOcstJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://ocst.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.ocst.ch/job/456')).toBe(true);
    });

    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
    });

    it('handles invalid URLs', () => {
      expect(isTrustedDomain('')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  describe('authoritative careers source', () => {
    it('accepts the explicit empty marker only inside the careers article body', () => {
      expect(extractOcstCareersSnapshot(EXPLICIT_EMPTY_HTML, OCST_CAREER_URL)).toEqual([]);
    });

    it('fails closed when the old news links appear without the authoritative marker', () => {
      expect(() => extractOcstCareersSnapshot(DEGRADED_NEWS_HTML, OCST_CAREER_URL))
        .toThrow(/no supported vacancy list or explicit empty-state marker/);
    });

    it('fails closed when the semantic article boundary disappears', () => {
      expect(() => extractOcstCareersSnapshot('<main>Attualmente non ci sono posizioni aperte</main>', OCST_CAREER_URL))
        .toThrow(/article boundary missing or ambiguous/);
    });

    it('rejects an otherwise-valid marker returned from another page', () => {
      expect(() => extractOcstCareersSnapshot(EXPLICIT_EMPTY_HTML, 'https://www.ocst.ch/contatti'))
        .toThrow(/outside the expected page/);
    });

    it('fetches only the canonical page, bypasses the broken robots redirect, and proves zero', async () => {
      const fetchPage = vi.fn(async () => ({
        ok: true,
        status: 200,
        url: OCST_CAREER_URL,
        body: EXPLICIT_EMPTY_HTML,
        host: 'ocst.ch',
      }));

      const jobs = await fetchAllOcstJobs({ fetchPage });

      expect(jobs).toEqual([]);
      expect(jobs).toHaveProperty('discoveredCount', 0);
      expect(assertCompleteOcstSnapshot(jobs)).toBe(true);
      expect(fetchPage).toHaveBeenCalledOnce();
      expect(fetchPage).toHaveBeenCalledWith(OCST_CAREER_URL, {
        ignoreRobots: true,
        headers: { 'Accept-Encoding': 'identity' },
      });
    });

    it('does not accept an unmarked empty array as authoritative', () => {
      expect(() => assertCompleteOcstSnapshot([])).toThrow(/not an explicit authoritative empty state/);
    });

    it('surfaces fetch failures instead of converting them to an empty snapshot', async () => {
      const fetchPage = vi.fn(async () => ({
        ok: false,
        status: 503,
        url: OCST_CAREER_URL,
        body: '',
        host: 'ocst.ch',
      }));
      await expect(fetchAllOcstJobs({ fetchPage })).rejects.toThrow(/HTTP 503/);
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
      expect(slugify('Developer ocst ch')).toBe('developer-ocst-ch');
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
      id: 'ocst-abc123',
      slug: 'test-position-ocst-ch',
      slugByLocale: { it: 'test-position-ocst-ch' },
      company: 'OCST',
      companyKey: 'ocst',
      title: 'Test Position',
      titleByLocale: { it: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { it: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://ocst.ch/jobs/test',
      source: 'OCST Dedicated Parser',
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
      expect(validJob.id).toMatch(/^ocst-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
