import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  BENTELER_KEY,
  BENTELER_COMPANY_NAME,
  isBentelerJob,
  isTrustedDomain,
  isSwissLocation,
  parseSearchPage,
  parseJobDetailHtml,
} from '../scripts/lib/benteler-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

const FIXTURES = path.join(__dirname, '__fixtures__');
const listingHtml = readFileSync(path.join(FIXTURES, 'benteler-listing.html'), 'utf8');
const detailHtml = readFileSync(path.join(FIXTURES, 'benteler-detail.html'), 'utf8');

describe('Benteler crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(BENTELER_KEY).toBe('benteler');
    expect(BENTELER_COMPANY_NAME).toBe('Benteler');
  });

  // ── isCompanyJob ──
  describe('isBentelerJob', () => {
    it('matches by companyKey', () => {
      expect(isBentelerJob({ companyKey: 'benteler' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isBentelerJob({ company: 'Benteler' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isBentelerJob({ url: 'https://benteler.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isBentelerJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isBentelerJob(null)).toBe(false);
      expect(isBentelerJob(undefined)).toBe(false);
      expect(isBentelerJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://benteler.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.benteler.com/job/456')).toBe(true);
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
      expect(slugify('Developer benteler ch')).toBe('developer-benteler-ch');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── isSwissLocation (Jobs2Web "City, Region, CC" strings) ──
  describe('isSwissLocation', () => {
    it('accepts a CH country code', () => {
      expect(isSwissLocation('Rothrist, AG, CH')).toBe(true);
      expect(isSwissLocation('Zug, ZG, CH')).toBe(true);
    });

    it('rejects foreign region codes colliding with Swiss cantons', () => {
      // "NW" = Nordrhein-Westfalen here, not Nidwalden.
      expect(isSwissLocation('Paderborn, NW, DE')).toBe(false);
      expect(isSwissLocation('Warburg, NW, DE')).toBe(false);
    });

    it('rejects two-part foreign locations', () => {
      expect(isSwissLocation('Salzburg, AT')).toBe(false);
      expect(isSwissLocation('Palmela, PT')).toBe(false);
    });

    it('accepts explicit country names', () => {
      expect(isSwissLocation('Rothrist, Switzerland')).toBe(true);
    });

    it('rejects empty input', () => {
      expect(isSwissLocation('')).toBe(false);
    });
  });

  // ── parseSearchPage (fixture recalcated from live markup, 2026-07-11) ──
  describe('parseSearchPage', () => {
    const { rows, total } = parseSearchPage(listingHtml);

    it('extracts every data-row', () => {
      expect(rows).toHaveLength(3);
      expect(total).toBe(3);
    });

    it('extracts title, href and location text', () => {
      expect(rows[0]).toMatchObject({
        title: 'Electrician',
        href: '/job/Holland-Electrician-MI/1159663301/',
        locationText: 'Holland, MI, US',
        hasMoreLocations: false,
      });
      expect(rows[2]).toMatchObject({
        title: 'Quality Engineer',
        href: '/job/Rothrist-Quality-Engineer-AG/9999999901/',
        locationText: 'Rothrist, AG, CH',
      });
    });

    it('extracts the visible location on multi-location ("+1 more…") rows and flags them', () => {
      // Regression: the old regex required "…</span>" right after the text, so
      // multi-location rows (text followed by <small>+1 more&hellip;</small>)
      // yielded locationText: '' and could never be classified.
      expect(rows[1]).toMatchObject({
        title: 'Ausbildung zum Mechatroniker (m/w/d) - Start 2027',
        locationText: 'Warburg, NW, DE',
        hasMoreLocations: true,
      });
    });

    it('returns no rows on empty input', () => {
      expect(parseSearchPage('')).toEqual({ rows: [], total: 0 });
    });
  });

  // ── parseJobDetailHtml (fixture recalcated from live markup, 2026-07-11) ──
  describe('parseJobDetailHtml', () => {
    const detail = parseJobDetailHtml(detailHtml, 'https://career.benteler.jobs/job/x/1395036133/');

    it('parses every PostalAddress block even though the tenant emits no postalCode', () => {
      // Regression: the old strict locality→region→postalCode→country regex
      // never matched on this tenant (postalCode itemprop absent).
      expect(detail.addresses).toHaveLength(2);
      expect(detail.addresses[0]).toEqual({
        addressLocality: 'Lichtenau-Kleinenberg',
        addressRegion: 'NW',
        postalCode: '',
        addressCountry: 'DE',
      });
      expect(detail.addressLocality).toBe('Lichtenau-Kleinenberg');
    });

    it('parses the Java-style datePosted', () => {
      expect(detail.postedDate).toBe('2026-06-17');
    });

    it('extracts the jobdescription block up to the job-location marker', () => {
      expect(detail.descriptionHtml).toContain('BENTELER Automotive');
      expect(detail.descriptionHtml).toContain('Ausbildung zum Mechatroniker');
      expect(detail.descriptionHtml).not.toContain('job-location');
    });

    it('prefers the Swiss address on multi-location postings', () => {
      const chDetail = parseJobDetailHtml(
        detailHtml.replace(
          '<meta itemprop="addressLocality" content="Warburg"><meta itemprop="addressRegion" content="NW"><meta itemprop="addressCountry" content="DE">',
          '<meta itemprop="addressLocality" content="Rothrist"><meta itemprop="addressRegion" content="AG"><meta itemprop="addressCountry" content="CH">',
        ),
        'https://career.benteler.jobs/job/x/1/',
      );
      expect(chDetail.addresses).toHaveLength(2);
      expect(chDetail.addressLocality).toBe('Rothrist');
      expect(chDetail.addressRegion).toBe('AG');
      expect(chDetail.addressCountry).toBe('CH');
    });

    it('returns empty fields on empty input', () => {
      const empty = parseJobDetailHtml('', 'https://career.benteler.jobs/');
      expect(empty.addresses).toEqual([]);
      expect(empty.postedDate).toBe('');
      expect(empty.descriptionHtml).toBe('');
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    // A minimal valid job for reference
    const validJob = {
      id: 'benteler-abc123',
      slug: 'test-position-benteler-ch',
      slugByLocale: { de: 'test-position-benteler-ch' },
      company: 'Benteler',
      companyKey: 'benteler',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://benteler.com/jobs/test',
      source: 'Benteler Dedicated Parser',
      sourceLang: 'de',
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
      expect(validJob.id).toMatch(/^benteler-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
