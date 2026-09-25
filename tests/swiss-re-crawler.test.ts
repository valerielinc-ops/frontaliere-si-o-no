import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Replay seams (issue 9843): the listing comes from the shared SuccessFactors
// client and every detail page from fetchHtml. Only those two network calls
// are replaced; parsing and geography run for real.
vi.mock('../scripts/lib/ats-clients/successfactors-client.mjs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../scripts/lib/ats-clients/successfactors-client.mjs')>();
  return { ...actual, fetchSuccessFactorsJobs: vi.fn() };
});
vi.mock('../scripts/lib/crawler-template.mjs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../scripts/lib/crawler-template.mjs')>();
  return { ...actual, fetchHtml: vi.fn() };
});

import {
  SWISS_RE_KEY,
  SWISS_RE_COMPANY_NAME,
  isSwissReJob,
  isTrustedDomain,
  parseSwissReDetailPage,
  fetchAllSwissReJobs,
  resolveSwissReGeography,
  swissReEntryCountryCode,
  DETAIL_FETCH_DELAY_MS,
  MAX_DETAIL_FETCHES,
} from '../scripts/lib/swiss-re-job-parser.mjs';
import { slugify, stripHtml, fetchHtml } from '../scripts/lib/crawler-template.mjs';
import { fetchSuccessFactorsJobs } from '../scripts/lib/ats-clients/successfactors-client.mjs';
import { isLocationExplicitlyForeign } from '../scripts/lib/dedicated-crawler-common.mjs';
import { isKnownSwissCity, isSwissLocationText } from '../scripts/lib/target-swiss-locations.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadFixture(name: string): string {
  return fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf-8');
}

type ListingRow = { title: string; location: string; applyUrl: string; jobReqId: string };
type Capture = {
  listing: ListingRow[];
  details: Record<string, { employment: string; locationSection: string }>;
};

function detailPage(locationSection: string, employment = 'Regular Employment'): string {
  return `<html><body>
    <div class="SectionTitle--content">${employment}</div>
    <section class="ArticleSection">${locationSection}</section>
    <section class="ArticleSection"><div class="richtext">
      <p><strong>About the Role</strong></p>
      <p>You will partner with underwriting, claims and finance teams across the business.</p>
      <ul><li>Own the analysis end to end</li><li>Present results to senior stakeholders</li></ul>
    </div></section>
  </body></html>`;
}

/**
 * Run the real fetchAllSwissReJobs() over replayed listing rows and detail
 * pages. The polite per-detail delay is collapsed to 0 ms for the replay.
 */
async function replay(rows: ListingRow[], detailFor: (url: string) => string) {
  vi.mocked(fetchSuccessFactorsJobs).mockImplementation(async function* () {
    for (const row of rows) yield row as never;
  } as never);
  vi.mocked(fetchHtml).mockImplementation((async (url: string) => detailFor(url)) as never);
  const realSetTimeout = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number, ...args: unknown[]) =>
    realSetTimeout(fn, ms === DETAIL_FETCH_DELAY_MS ? 0 : ms, ...args)) as typeof setTimeout);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  return fetchAllSwissReJobs();
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

  // ── Source geography (issue 9843) ──
  describe('source geography', () => {
    it('reads the terminal segment of a Swiss Re entry as the ISO country, not a canton', () => {
      expect(swissReEntryCountryCode('Paris, FR')).toBe('FR');
      expect(swissReEntryCountryCode('Singapore, SG')).toBe('SG');
      expect(swissReEntryCountryCode('Luxembourg, LU')).toBe('LU');
      expect(swissReEntryCountryCode('Kansas City, MO, US')).toBe('US');
      expect(swissReEntryCountryCode('Zurich, Zurich, CH')).toBe('CH');
      // Not a country segment: no comma, or a canton code that is no ISO country.
      expect(swissReEntryCountryCode('Zürich')).toBe('');
      expect(swissReEntryCountryCode('Lugano, TI')).toBe('');
    });

    it('drops explicitly foreign entries and resolves Swiss ones without an HQ fallback', () => {
      for (const foreign of [
        'Bratislava, SK', 'Paris, FR', 'Singapore, SG', 'Luxembourg, LU',
        'Mexico City, MX', 'Armonk, NY, US', 'Washington D.C., DC, US', '',
      ]) {
        expect(resolveSwissReGeography(foreign), foreign).toBeNull();
      }
      expect(resolveSwissReGeography('Zurich, CH')).toEqual({ location: 'Zurich, CH', canton: 'ZH' });
      expect(resolveSwissReGeography('Zurich, Zurich, CH')).toEqual({ location: 'Zurich, Zurich, CH', canton: 'ZH' });
      expect(resolveSwissReGeography('London, GB | Zurich, CH')).toEqual({ location: 'Zurich, CH', canton: 'ZH' });
    });

    it('parses the multi-location "Locations:" line and keeps it out of the body', () => {
      const capture = JSON.parse(loadFixture('swiss-re-listing-2026-09-25.json')) as Capture;
      const detail = parseSwissReDetailPage(detailPage(capture.details['1429719133'].locationSection));
      expect(detail!.location).toBe('Schaumburg, IL, US | Armonk, NY, US | Kansas City, MO, US');
      expect(stripHtml(detail!.descriptionHtml)).not.toContain('Locations:');
    });
  });

  describe('replay of the 2026-09-25 global listing (issue 9843)', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('publishes only the Swiss cards, with a Swiss canton, and fetches no detail for a foreign card', async () => {
      const capture = JSON.parse(loadFixture('swiss-re-listing-2026-09-25.json')) as Capture;
      expect(capture.listing).toHaveLength(272);
      const zurichTemplate = capture.details['1441240133'];
      const jobs = await replay(capture.listing, (url) => {
        const id = url.match(/\/(\d+)\/?$/)?.[1] || '';
        const captured = capture.details[id];
        if (captured) return detailPage(captured.locationSection, captured.employment);
        return detailPage(zurichTemplate.locationSection, zurichTemplate.employment);
      });

      const swissCards = capture.listing.filter((row) => row.location === 'Zurich, CH');
      expect(swissCards).toHaveLength(16);
      expect(jobs).toHaveLength(16);
      expect(jobs.map((job: { url: string }) => job.url).sort())
        .toEqual(swissCards.map((row) => row.applyUrl).sort());
      for (const job of jobs as Array<{ location: string; canton: string }>) {
        expect(job.location).toBe('Zurich, CH');
        expect(job.canton).toBe('ZH');
      }

      // The issue's METRICA predicate over the produced rows: 0 / 0.
      const explicitForeign = jobs.filter((job: { location: string }) => isLocationExplicitlyForeign(job.location));
      const noSwissEvidence = jobs.filter((job: { location: string }) => !isLocationExplicitlyForeign(job.location)
        && !isSwissLocationText(job.location) && !isKnownSwissCity(job.location));
      expect(explicitForeign).toHaveLength(0);
      expect(noSwissEvidence).toHaveLength(0);

      // Details only for the 16 Swiss cards and the 14 multi-location cards
      // whose listing span is empty; the 242 foreign cards cost nothing.
      expect(vi.mocked(fetchHtml)).toHaveBeenCalledTimes(30);
    });

    it('drops the observed foreign cards, the no-location row, and keeps a mixed posting on its Swiss office', async () => {
      const row = (id: string, location: string): ListingRow => ({
        title: `Replay role ${id}`,
        location,
        applyUrl: `https://www.swissre.com/careers/job/Replay-role/${id}`,
        jobReqId: id,
      });
      const rows = [
        row('1', 'Bratislava, SK'),
        row('2', 'Paris, FR'),
        row('3', 'Singapore, SG'),
        row('4', 'Luxembourg, LU'),
        row('5', 'Mexico City, MX'),
        row('6', 'Armonk, NY, US'),
        row('7', ''), // no location in the listing nor in the detail
        row('8', ''), // multi-location card: London and Zurich
        row('9', 'Zurich, CH'),
      ];
      const sections: Record<string, string> = {
        '7': '',
        '8': '<div class="richtext"><p><strong>Locations:</strong> London, GB | Zurich, CH</p></div>',
        '9': '<div class="richtext"><p><strong>Location:</strong> Zurich, Zurich, CH</p></div>',
      };
      const jobs = await replay(rows, (url) => {
        const id = url.match(/\/(\d+)\/?$/)?.[1] || '';
        return detailPage(sections[id] ?? '');
      }) as Array<{ url: string; location: string; canton: string }>;

      expect(jobs.map((job) => [job.url.split('/').pop(), job.location, job.canton])).toEqual([
        ['8', 'Zurich, CH', 'ZH'],
        ['9', 'Zurich, CH', 'ZH'],
      ]);
      expect(jobs.some((job) => ['FR', 'SG', 'LU'].includes(job.canton))).toBe(false);
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
