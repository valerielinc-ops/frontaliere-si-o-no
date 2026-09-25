import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  KSA_KEY,
  KSA_COMPANY_NAME,
  isKsaJob,
  isTrustedDomain,
  parseKsaListingPage,
  extractPagingToken,
  buildKsaDetailDescription,
  buildProspectiveDescriptionMap,
} from '../scripts/lib/ksa-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, 'fixtures');

const listingHtml = fs.readFileSync(path.join(FIXTURES, 'ksa-umantis-listing.html'), 'utf8');
const prospectiveFeed = JSON.parse(
  fs.readFileSync(path.join(FIXTURES, 'ksa-prospective-jobs.json'), 'utf8'),
);

describe('Kantonsspital Aarau (KSA) crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(KSA_KEY).toBe('ksa');
    expect(KSA_COMPANY_NAME).toBe('Kantonsspital Aarau (KSA)');
  });

  // ── isCompanyJob ──
  describe('isKsaJob', () => {
    it('matches by companyKey', () => {
      expect(isKsaJob({ companyKey: 'ksa' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isKsaJob({ company: 'Kantonsspital Aarau (KSA)' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isKsaJob({ url: 'https://ksa.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isKsaJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isKsaJob(null)).toBe(false);
      expect(isKsaJob(undefined)).toBe(false);
      expect(isKsaJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://ksa.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.ksa.ch/job/456')).toBe(true);
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
      expect(slugify('Developer ksa ch')).toBe('developer-ksa-ch');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Listing page parsing (real Umantis fixture, July 2026) ──
  describe('parseKsaListingPage', () => {
    const listings = parseKsaListingPage(listingHtml);

    it('parses all rows with vacancy IDs and titles', () => {
      expect(listings.length).toBe(3);
      const ids = listings.map((l) => l.vacancyId).sort();
      expect(ids).toEqual(['5562', '5563', '5564']);
      const ict = listings.find((l) => l.vacancyId === '5564');
      expect(ict.title).toBe('Leiter/in ICT Support Onsite');
    });

    it('points detail/apply URLs at the live CheckLogin page', () => {
      for (const l of listings) {
        expect(l.detailUrl).toBe(
          `https://recruitingapp-122706.umantis.com/Vacancies/${l.vacancyId}/Application/CheckLogin/1`,
        );
        expect(l.applyUrl).toBe(l.detailUrl);
      }
    });

    it('extracts the pagination token', () => {
      expect(extractPagingToken(listingHtml)).toEqual({ searchToken: '2003449082' });
    });

    it('returns [] on empty/garbage input', () => {
      expect(parseKsaListingPage('')).toEqual([]);
      expect(parseKsaListingPage('<html><body>nope</body></html>')).toEqual([]);
    });
  });

  // ── Prospective enrichment (real medium-1003009 fixture, July 2026) ──
  describe('buildKsaDetailDescription', () => {
    const szas = prospectiveFeed.jobs[0].szas;

    it('builds a section-headed rich description', () => {
      const desc = buildKsaDetailDescription(szas);
      expect(desc).toContain('Aufgaben:');
      expect(desc).toContain('Anforderungen:');
      expect(desc.length).toBeGreaterThan(500);
    });

    it('converts <li> markup to bullets (structured content)', () => {
      const desc = buildKsaDetailDescription(szas);
      expect(desc).toMatch(/^\s*[-•*]\s/m);
    });

    it('strips all HTML tags', () => {
      const desc = buildKsaDetailDescription(szas);
      expect(desc).not.toMatch(/<[a-z][^>]*>/i);
    });

    it('returns empty string for an empty bag', () => {
      expect(buildKsaDetailDescription({})).toBe('');
      expect(buildKsaDetailDescription(undefined)).toBe('');
    });
  });

  describe('buildProspectiveDescriptionMap', () => {
    it('indexes rich bodies by Umantis vacancy ID (sza_apply_link)', () => {
      const map = buildProspectiveDescriptionMap(prospectiveFeed.jobs);
      expect(map.size).toBe(3);
      expect([...map.keys()].sort()).toEqual(['5273', '5563', '5564']);
      for (const desc of map.values()) {
        expect(desc.length).toBeGreaterThan(100);
      }
    });

    it('joins against listing vacancy IDs from the Umantis fixture', () => {
      const map = buildProspectiveDescriptionMap(prospectiveFeed.jobs);
      const listings = parseKsaListingPage(listingHtml);
      const enriched = listings.filter((l) => map.has(l.vacancyId));
      // 5563 + 5564 appear in both fixtures (5562 has no Prospective row here).
      expect(enriched.map((l) => l.vacancyId).sort()).toEqual(['5563', '5564']);
    });

    it('skips entries with non-numeric apply link or empty body', () => {
      const map = buildProspectiveDescriptionMap([
        { szas: { sza_apply_link: 'https://example.com/apply', sza_tasks: '<ul><li>Long enough task line to pass the minimum body length check for the map builder</li></ul>' } },
        { szas: { sza_apply_link: '1234' } }, // no body
        null,
      ] as never[]);
      expect(map.size).toBe(0);
    });

    it('handles non-array input gracefully', () => {
      expect(buildProspectiveDescriptionMap(undefined).size).toBe(0);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    // A minimal valid job for reference
    const validJob = {
      id: 'ksa-abc123',
      slug: 'test-position-ksa-ch',
      slugByLocale: { de: 'test-position-ksa-ch' },
      company: 'Kantonsspital Aarau (KSA)',
      companyKey: 'ksa',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://ksa.ch/jobs/test',
      source: 'Kantonsspital Aarau (KSA) Dedicated Parser',
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
      expect(validJob.id).toMatch(/^ksa-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
