import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  CANTON_VALAIS_KEY,
  CANTON_VALAIS_COMPANY_NAME,
  isCantonValaisJob,
  isTrustedDomain,
  resolveServiceNowPageCap,
  parseOtbListings,
} from '../scripts/lib/canton-valais-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

describe('Canton du Valais crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(CANTON_VALAIS_KEY).toBe('canton-valais');
    expect(CANTON_VALAIS_COMPANY_NAME).toBe('Canton du Valais');
  });

  // ── isCompanyJob ──
  describe('isCantonValaisJob', () => {
    it('matches by companyKey', () => {
      expect(isCantonValaisJob({ companyKey: 'canton-valais' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isCantonValaisJob({ company: 'Canton du Valais' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isCantonValaisJob({ url: 'https://vs.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isCantonValaisJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isCantonValaisJob(null)).toBe(false);
      expect(isCantonValaisJob(undefined)).toBe(false);
      expect(isCantonValaisJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://vs.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.vs.ch/job/456')).toBe(true);
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
      expect(slugify('Developer canton-valais ch')).toBe('developer-canton-valais-ch');
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
      id: 'canton-valais-abc123',
      slug: 'test-position-canton-valais-ch',
      slugByLocale: { fr: 'test-position-canton-valais-ch' },
      company: 'Canton du Valais',
      companyKey: 'canton-valais',
      title: 'Test Position',
      titleByLocale: { fr: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { fr: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://vs.ch/jobs/test',
      source: 'Canton du Valais Dedicated Parser',
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
      expect(validJob.id).toMatch(/^canton-valais-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });

  // ── parseOtbListings (real portlet fixture, issue #3836) ──
  describe('parseOtbListings', () => {
    // Live-captured 2026-07-10 from the vs.ch "vsotbportlet" render_portlet
    // fragment (25 job offers).
    const html = readFileSync(join(FIXTURES, 'canton-valais-otb-portlet.html'), 'utf8');
    const listings = parseOtbListings(html);

    it('extracts every job-offer block', () => {
      expect(listings.length).toBe(25);
    });

    it('captures title, department blurb, and Valais city', () => {
      const first = listings[0];
      expect(first.title).toBe('Un analyste criminel opérationnel ou une analyste criminelle opérationnelle (100%)');
      expect(first.description).toContain('Police cantonale');
      expect(first.location).toBe('Sion');
    });

    it('captures the per-job PDF URL for description enrichment (issue #3836)', () => {
      expect(listings[0].pdfUrl).toBe('https://otb.apps.vs.ch/svc/api/joboffersdocument/20157?language=fr');
      // Every offer on the board carries a PDF link
      expect(listings.every((l: { pdfUrl?: string }) => /joboffersdocument\/\d+/.test(l.pdfUrl || ''))).toBe(true);
    });

    it('prefers the iapply apply link as the public URL, falling back to the PDF', () => {
      expect(listings[0].url).toBe('https://otb.apps.vs.ch/iapply?source=EXTERNAL&job=102355&publication=2628');
      // "psychologue" offer has no iapply link on the live board → PDF fallback
      const pdfOnly = listings.find((l: { title: string }) => l.title.includes('psychologue'));
      expect(pdfOnly?.url).toContain('joboffersdocument/20135');
    });

    it('returns empty array for empty/unrecognised HTML', () => {
      expect(parseOtbListings('')).toEqual([]);
      expect(parseOtbListings('<html><body>maintenance</body></html>')).toEqual([]);
    });
  });

  // ── resolveServiceNowPageCap (issue #3578) ──
  // SN_API_URLS[0] has no `sysparm_limit` query param, so before this fix
  // the truncation-warning guard (`if (limitParam)`) silently no-op'd for it.
  describe('resolveServiceNowPageCap', () => {
    it('reads the cap from an explicit sysparm_limit param', () => {
      expect(
        resolveServiceNowPageCap('https://vs.service-now.com/api/x_hdvi2_hvs_ats/ats_portal_api/jobs?sysparm_limit=100&language=fr'),
      ).toBe(100);
    });

    it('respects a non-default explicit sysparm_limit value', () => {
      expect(
        resolveServiceNowPageCap('https://vs.service-now.com/api/x_hdvi2_hvs_ats/ats_portal_api/jobs?sysparm_limit=250'),
      ).toBe(250);
    });

    it('falls back to the sentinel cap when sysparm_limit is absent (SN_API_URLS[0])', () => {
      expect(
        resolveServiceNowPageCap('https://vs.service-now.com/api/x_hdvi2_hvs_ats/ats_portal/jobs?language=fr'),
      ).toBe(100);
    });
  });
});
