import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BELIMO_KEY,
  BELIMO_COMPANY_NAME,
  isBelimoJob,
  isTrustedDomain,
  parseBelimoDetailPage,
  isSwissJobUrlCandidate,
  extractJobReqId,
  detectEmploymentType,
  fetchAllBelimoJobs,
  DETAIL_FETCH_DELAY_MS,
  MAX_DETAIL_FETCHES,
} from '../scripts/lib/belimo-job-parser.mjs';
import { slugify, stripHtml } from '../scripts/lib/crawler-template.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadFixture(name: string): string {
  return fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf-8');
}

describe('Belimo crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(BELIMO_KEY).toBe('belimo');
    expect(BELIMO_COMPANY_NAME).toBe('Belimo');
  });

  // ── isCompanyJob ──
  describe('isBelimoJob', () => {
    it('matches by companyKey', () => {
      expect(isBelimoJob({ companyKey: 'belimo' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isBelimoJob({ company: 'Belimo' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isBelimoJob({ url: 'https://www.belimo.com/us/en_US/jobs/12345' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isBelimoJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isBelimoJob(null)).toBe(false);
      expect(isBelimoJob(undefined)).toBe(false);
      expect(isBelimoJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://www.belimo.com/us/en_US/jobs/12345')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.belimo.com/job/456')).toBe(true);
    });

    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
    });

    it('handles invalid URLs', () => {
      expect(isTrustedDomain('')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  // ── Sitemap URL helpers (SuccessFactors CSB, jobsredirect.belimo.com) ──
  describe('isSwissJobUrlCandidate', () => {
    it('keeps Swiss slugs (4-digit postal tail)', () => {
      expect(
        isSwissJobUrlCandidate(
          'https://jobsredirect.belimo.com/job/Hinwil-Instandhaltungsfachmann-frau-%28100%29-Z%C3%BCri-8340/1164972655/'
        )
      ).toBe(true);
    });

    it('drops US slugs (5-digit ZIP tail)', () => {
      expect(
        isSwissJobUrlCandidate(
          'https://jobsredirect.belimo.com/job/Danbury-Assembler-1-CT-06810/1163819155/'
        )
      ).toBe(false);
    });

    it('keeps slugs without a postal tail (detail-page microdata decides)', () => {
      expect(
        isSwissJobUrlCandidate('https://jobsredirect.belimo.com/job/Somewhere-Engineer/123456/')
      ).toBe(true);
    });

    it('rejects non-job and invalid URLs', () => {
      expect(isSwissJobUrlCandidate('https://jobsredirect.belimo.com/search/')).toBe(false);
      expect(isSwissJobUrlCandidate('not-a-url')).toBe(false);
      expect(isSwissJobUrlCandidate('')).toBe(false);
    });
  });

  describe('extractJobReqId', () => {
    it('extracts the requisition id from a CSB detail URL', () => {
      expect(
        extractJobReqId(
          'https://jobsredirect.belimo.com/job/Hinwil-Working-Student-IPX-%2840%29-Zuri-8340/1164972755/'
        )
      ).toBe('1164972755');
    });

    it('returns empty string when the URL is not a detail page', () => {
      expect(extractJobReqId('https://jobsredirect.belimo.com/search/')).toBe('');
    });
  });

  // ── detectEmploymentType (title-driven, no explicit CSB field) ──
  describe('detectEmploymentType', () => {
    it('detects part-time from a sub-100% workload suffix', () => {
      expect(detectEmploymentType('Working Student IPX (40%)')).toBe('PART_TIME');
    });

    it('treats an 80-100% range as full-time', () => {
      expect(detectEmploymentType('Production Engineer (80-100%)')).toBe('FULL_TIME');
    });

    it('detects temporary roles', () => {
      expect(detectEmploymentType('Montagemitarbeiter:in (temporär)')).toBe('TEMPORARY');
      expect(detectEmploymentType('Ferienaushilfe in der Fertigung')).toBe('TEMPORARY');
    });

    it('defaults to full-time', () => {
      expect(detectEmploymentType('HSE Manager')).toBe('FULL_TIME');
    });
  });

  // ── Detail-page parser (fixture recalcated from live markup, 2026-07-11) ──
  describe('parseBelimoDetailPage', () => {
    const html = loadFixture('belimo-csb-detail-instandhaltung.html');

    it('extracts the title from the itemprop="title" h1', () => {
      const parsed = parseBelimoDetailPage(html);
      expect(parsed).not.toBeNull();
      expect(parsed!.title).toBe('Instandhaltungsfachmann/-frau (100%)');
    });

    it('extracts the address microdata (CH gate inputs)', () => {
      const parsed = parseBelimoDetailPage(html)!;
      expect(parsed.city).toBe('Hinwil');
      expect(parsed.postalCode).toBe('8340');
      expect(parsed.country).toBe('CH');
    });

    it('expands the truncated CSB region label to Zürich', () => {
      const parsed = parseBelimoDetailPage(html)!;
      expect(parsed.region).toBe('Zürich');
    });

    it('normalizes datePosted to ISO (shared SF date parser)', () => {
      const parsed = parseBelimoDetailPage(html)!;
      expect(parsed.postedDate).toBe('2026-06-23');
    });

    it('captures the jobdescription body without the apply chrome', () => {
      const parsed = parseBelimoDetailPage(html)!;
      const text = stripHtml(parsed.descriptionHtml);
      expect(text.length).toBeGreaterThan(500);
      expect(text).toContain('Instandhaltung');
      expect(parsed.descriptionHtml).not.toMatch(/applylink|dialogApply|<script/i);
    });

    it('returns null for empty and job-less pages', () => {
      expect(parseBelimoDetailPage('')).toBeNull();
      expect(parseBelimoDetailPage('<html><body><h2>The desired job cannot be found</h2></body></html>')).toBeNull();
    });

    it('reports an empty country (not "CH") when addressCountry microdata is absent', () => {
      const html = `<html><body>
        <h1 itemprop="title">Montagemitarbeiter/-in (100%)</h1>
        <span itemprop="addressLocality" content="Hinwil"></span>
        <span itemprop="postalCode" content="8340"></span>
        <div itemprop="description">Job description text.</div>
      </body></html>`;
      const parsed = parseBelimoDetailPage(html)!;
      expect(parsed).not.toBeNull();
      expect(parsed.country).toBe('');
    });
  });

  // ── fetchAllBelimoJobs (CH gate: absent addressCountry must not silently drop a Swiss candidate) ──
  describe('fetchAllBelimoJobs', () => {
    const realFetch = globalThis.fetch;
    const SITEMAP_URL = 'https://jobsredirect.belimo.com/sitemap.xml';
    const JOB_URL = 'https://jobsredirect.belimo.com/job/Hinwil-Montagemitarbeiter-in-Zueri-8340/9999999/';

    afterEach(() => {
      globalThis.fetch = realFetch;
    });

    function sitemapResponse() {
      return new Response(
        `<?xml version="1.0"?><urlset><url><loc>${JOB_URL}</loc></url></urlset>`,
        { status: 200, headers: { 'Content-Type': 'application/xml' } },
      );
    }

    function detailResponseWithoutCountry() {
      return new Response(
        `<html><body>
          <h1 itemprop="title">Montagemitarbeiter/-in (100%)</h1>
          <span itemprop="addressLocality" content="Hinwil"></span>
          <span itemprop="postalCode" content="8340"></span>
          <div itemprop="description">Job description text long enough to pass.</div>
        </body></html>`,
        { status: 200, headers: { 'Content-Type': 'text/html' } },
      );
    }

    it('keeps a Swiss candidate whose detail page omits addressCountry, instead of silently dropping it', async () => {
      globalThis.fetch = (async (url: any) => {
        const u = String(url);
        if (u.startsWith(SITEMAP_URL)) return sitemapResponse();
        return detailResponseWithoutCountry();
      }) as any;

      const jobs = await fetchAllBelimoJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0].country).toBe('CH');
      expect(jobs[0].addressCountry).toBe('CH');
    });
  });

  // ── Detail-fetch budget constants ──
  describe('detail fetch budget', () => {
    it('exposes a sane delay and cap', () => {
      expect(DETAIL_FETCH_DELAY_MS).toBeGreaterThanOrEqual(100);
      expect(MAX_DETAIL_FETCHES).toBeGreaterThanOrEqual(100);
    });
  });

  // ── slugify (imported from crawler-template) ──
  describe('slugify', () => {
    it('converts title to URL-safe slug', () => {
      const slug = slugify('Software Engineer (m/f/d)');
      expect(slug).toBe('software-engineer-m-f-d');
    });

    it('strips diacritics', () => {
      expect(slugify('Einkäufer:in Hinwil')).toBe('einkaufer-in-hinwil');
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('Technician belimo hinwil')).toBe('technician-belimo-hinwil');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    // A minimal valid job for reference (mirrors what fetchAllBelimoJobs emits)
    const validJob = {
      id: 'belimo-abc123',
      slug: 'test-position-belimo-hinwil',
      slugByLocale: { de: 'test-position-belimo-hinwil' },
      company: 'Belimo',
      companyKey: 'belimo',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Hinwil',
      canton: 'ZH',
      url: 'https://jobsredirect.belimo.com/job/Hinwil-Test-Position-Z%C3%BCri-8340/1234567890/',
      source: 'Belimo Dedicated Parser (SuccessFactors Career Site Builder)',
      sourceLang: 'de',
      crawledAt: new Date().toISOString(),
      // ── Recommended fields (structured-data completeness, Non-Negotiable #3) ──
      addressLocality: 'Hinwil',
      addressRegion: 'ZH',
      streetAddress: 'Brunnenbachstrasse 1',
      postalCode: '8340',
      addressCountry: 'CH',
      country: 'CH',
      employmentType: 'FULL_TIME',
      postedDate: new Date().toISOString().split('T')[0],
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

    it('has the fields required for job-page structured data (baseSalary source inputs)', () => {
      // baseSalary itself is synthesized downstream from safe defaults; these
      // are the per-job inputs the parser is responsible for supplying.
      const structuredDataInputs = [
        'postalCode', 'streetAddress', 'title', 'description',
        'addressLocality', 'addressCountry', 'employmentType', 'postedDate',
      ];
      for (const field of structuredDataInputs) {
        expect(validJob).toHaveProperty(field);
        expect(validJob[field]).toBeTruthy();
      }
    });

    it('slug only contains source locale', () => {
      const locales = Object.keys(validJob.slugByLocale);
      expect(locales).toHaveLength(1);
      expect(locales[0]).toBe(validJob.sourceLang);
    });

    it('id starts with company key', () => {
      expect(validJob.id).toMatch(/^belimo-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
