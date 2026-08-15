import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  MCDO_KEY,
  COMPANY_NAME,
  parseMcdoPreloadState,
  extractListingJobs,
  listingEntryToParsed,
  parseMcdoDetailPage,
  buildMcdoJob,
  inferCanton,
  inferEmploymentType,
  listingPageUrl,
} from '../scripts/lib/mcdonalds-job-parser.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

// Real HTML captured 2026-08-14 from the live portal (issue #5852):
//   https://jobs.mcdonalds.ch/fr/emplois-restauration                   → mcdonalds-emplois-restauration.html
//   https://jobs.mcdonalds.ch/fr-ch/agent-e-de-maintenance/job/P8-317484-1 → mcdonalds-job-p8-317484-1.html
const listingHtml = readFileSync(path.join(FIXTURES, 'mcdonalds-emplois-restauration.html'), 'utf8');
const detailHtml = readFileSync(path.join(FIXTURES, 'mcdonalds-job-p8-317484-1.html'), 'utf8');

describe("McDonald's Switzerland crawler parser", () => {
  it('exports valid company key and name', () => {
    expect(MCDO_KEY).toBe('mcdonald-s-switzerland');
    expect(COMPANY_NAME).toBe("McDonald's Switzerland");
  });

  // ── Listing URL contract ──
  //
  // The #5852 break was not a parsing bug: the parser kept working on the
  // fixtures while the live crawl returned zero, because the URL it fetched
  // and the shape the fixtures prove it can read had drifted apart. Nothing
  // failed, because no test tied the two together. These do — the fixture
  // records its own provenance in `<link rel="canonical">`, so pointing the
  // crawler at a different route without recapturing the fixture is red.
  describe('listing URL contract', () => {
    const canonical = listingHtml.match(/<link rel="canonical" href="([^"]+)">/)?.[1];

    it('fetches page 1 at exactly the URL the fixture was captured from', () => {
      expect(canonical).toBe('https://jobs.mcdonalds.ch/fr/emplois-restauration');
      expect(listingPageUrl(1)).toBe(canonical);
    });

    it('paginates as /page/{n} off that same base, from page 2 up', () => {
      expect(listingPageUrl(2)).toBe(`${canonical}/page/2`);
      expect(listingPageUrl(17)).toBe(`${canonical}/page/17`);
      // Page 1 has no /page/1 suffix — the portal 404s that form.
      expect(listingPageUrl(1)).not.toContain('/page/');
    });
  });

  // ── Listing discovery (the #5852 regression surface) ──
  describe('parseMcdoPreloadState / extractListingJobs', () => {
    it('extracts window.__PRELOAD_STATE__.jobSearch from the live listing page', () => {
      const state = parseMcdoPreloadState(listingHtml);
      expect(state?.jobSearch?.totalJob).toBe(4);
      expect(state?.jobSearch?.jobs).toHaveLength(4);
    });

    it('brace-matches past nested `}` characters before the trailing statement', () => {
      // The object literal is immediately followed by `window.__BUILD__ = ...`
      // on the same line — a naive "stop at first `}`" scan would truncate
      // inside the nested `locations[0]` object.
      expect(listingHtml).toContain("window.__BUILD__ = '70ed2245a1'");
      expect(extractListingJobs(listingHtml).jobs.length).toBeGreaterThan(0);
    });

    it('returns jobs: [] / totalJob: 0 rather than throwing when the state is absent or malformed', () => {
      expect(extractListingJobs('<html><body>no jobs here</body></html>')).toEqual({ jobs: [], totalJob: 0 });
      expect(extractListingJobs('<script>window.__PRELOAD_STATE__ = {broken</script>')).toEqual({ jobs: [], totalJob: 0 });
      expect(extractListingJobs('')).toEqual({ jobs: [], totalJob: 0 });
      expect(extractListingJobs(undefined as unknown as string)).toEqual({ jobs: [], totalJob: 0 });
    });

    it('does NOT depend on the retired mcdo_jobs_mapEntries Drupal shape', () => {
      // Regression guard for the actual break: the #5393 discovery looked
      // for `mcdo_jobs_mapEntries` inside a Drupal settings blob, and the
      // live page no longer serves that markup at all (the fixture's own
      // provenance comment mentions the old name in prose, so scope the
      // assertion to the actual embedded script).
      const [, script] = listingHtml.split('<script>');
      expect(script).not.toContain('mcdo_jobs_mapEntries');
    });
  });

  describe('listingEntryToParsed', () => {
    it('maps a Thurgau maintenance posting to the shared parsed shape', () => {
      const [kreuzlingen] = extractListingJobs(listingHtml).jobs;
      const parsed = listingEntryToParsed(kreuzlingen)!;
      expect(parsed.title).toBe('Agent·e de Maintenance');
      expect(parsed.city).toBe('KREUZLINGEN');
      expect(parsed.canton).toBe('TG');
      expect(parsed.jobReqId).toBe('P8-317484-1');
      expect(parsed.postalCode).toBe('8280');
      expect(parsed.streetAddress).toBe('ROMANSHORNERSTRASSE 120');
      // Listing entries carry no description/date — enrichment happens later.
      expect(parsed.description).toBe('');
      expect(parsed.datePosted).toBe('');
    });

    it('absolutises the relative originalURL onto the canonical https host', () => {
      const [kreuzlingen] = extractListingJobs(listingHtml).jobs;
      expect(listingEntryToParsed(kreuzlingen)!.url).toBe(
        'https://jobs.mcdonalds.ch/fr-ch/agent-e-de-maintenance/job/P8-317484-1'
      );
    });

    it('infers the canton of every fixture entry from stateAbbr/city', () => {
      const cantons = extractListingJobs(listingHtml).jobs.map((e) => listingEntryToParsed(e)!.canton);
      expect(cantons).toEqual(['TG', 'GR', 'NE', 'TI']);
    });

    it('returns null for entries without a title or originalURL', () => {
      expect(listingEntryToParsed(null)).toBeNull();
      expect(listingEntryToParsed({ title: 'x' })).toBeNull();
      expect(listingEntryToParsed({ originalURL: 'fr-ch/x/job/1' })).toBeNull();
    });
  });

  // ── Detail page (enrichment is now mandatory, not optional) ──
  describe('parseMcdoDetailPage', () => {
    it('extracts JSON-LD JobPosting fields from the live detail page', () => {
      const parsed = parseMcdoDetailPage(
        detailHtml,
        'https://jobs.mcdonalds.ch/fr-ch/agent-e-de-maintenance/job/P8-317484-1'
      )!;
      expect(parsed).not.toBeNull();
      expect(parsed.title).toBe('Agent·e de Maintenance');
      expect(parsed.city).toBe('KREUZLINGEN');
      expect(parsed.canton).toBe('TG');
      expect(parsed.jobReqId).toBe('P8-317484-1');
      expect(parsed.datePosted).toBe('2026-07-10');
    });

    it('falls back cleanly when employmentType/validThrough are absent, as on the live portal today', () => {
      // The current JSON-LD block omits both fields entirely (present
      // pre-2026-08-10, absent again as of the #5852 rewrite).
      expect(detailHtml).not.toContain('"validThrough"');
      expect(detailHtml).not.toContain('"employmentType"');
      const parsed = parseMcdoDetailPage(detailHtml)!;
      expect(parsed.validThrough).toBe('');
      expect(parsed.employmentType).toBe('PART_TIME');
    });

    it('returns null when no JobPosting block is present', () => {
      expect(parseMcdoDetailPage('<html><body>no ld+json</body></html>')).toBeNull();
      expect(parseMcdoDetailPage('')).toBeNull();
    });
  });

  describe('buildMcdoJob', () => {
    const parsed = parseMcdoDetailPage(detailHtml)!;

    it('emits the canonical postedDate field (never datePosted)', () => {
      const job = buildMcdoJob(parsed)!;
      // #3843 item 5: the pipeline/consumers (JobBoard, sitemap, newsletter,
      // assemble-jobs-dataset churn guard) read `postedDate`; the schema.org
      // name `datePosted` must not leak into the built job object.
      expect(job.postedDate).toBe('2026-07-10');
      expect(job).not.toHaveProperty('datePosted');
    });

    it('falls back to today for postedDate when the source has no date', () => {
      const job = buildMcdoJob({ ...parsed, datePosted: '' })!;
      expect(job.postedDate).toBe(new Date().toISOString().split('T')[0]);
    });

    it('builds a stable slug and company identity', () => {
      const job = buildMcdoJob(parsed)!;
      expect(job.companyKey).toBe(MCDO_KEY);
      expect(job.company).toBe(COMPANY_NAME);
      expect(job.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
      expect(job.slug).toContain('agent-e-de-maintenance');
    });

    it('builds a complete Ticino job straight from a listing entry', () => {
      const [, , , lugano] = extractListingJobs(listingHtml).jobs;
      const job = buildMcdoJob(listingEntryToParsed(lugano))!;
      expect(job.canton).toBe('TI');
      expect(job.location).toBe('LUGANO PAZZALLO');
      expect(job.country).toBe('CH');
      expect(job.url).toBe(
        'https://jobs.mcdonalds.ch/fr-ch/assistant-e-manager-de-restaurant/job/P8-310079-1'
      );
      expect(job.sector).toBe('Ristorazione / Fast Food');
      // Listing-only build has no enrichment yet, so it falls back to the
      // synthesized description rather than a scraped one.
      expect(job.description.length).toBeGreaterThan(20);
    });

    it('returns null for empty parse results', () => {
      expect(buildMcdoJob(null)).toBeNull();
      expect(buildMcdoJob({ title: '' } as never)).toBeNull();
    });
  });

  describe('inferCanton', () => {
    it('passes through 2-letter codes', () => {
      expect(inferCanton('VD', 'Nyon')).toBe('VD');
    });

    it('maps full canton names', () => {
      expect(inferCanton('Ticino', '')).toBe('TI');
      expect(inferCanton('', 'Genève')).toBe('GE');
    });

    it('returns empty string when unknown', () => {
      expect(inferCanton('', 'Nowhere')).toBe('');
    });
  });

  describe('inferEmploymentType', () => {
    it('defaults crew postings to PART_TIME', () => {
      expect(inferEmploymentType('Crew Member', [])).toBe('PART_TIME');
    });

    it('detects apprenticeships as FULL_TIME', () => {
      expect(inferEmploymentType('Apprenti(e) employé(e) de commerce', [])).toBe('FULL_TIME');
      expect(inferEmploymentType('Apprenti·e en restauration de système CFC', [])).toBe('FULL_TIME');
    });

    it('respects explicit JSON-LD employmentType in both array and string form', () => {
      expect(inferEmploymentType('Crew Member', ['FULL_TIME'])).toBe('FULL_TIME');
      expect(inferEmploymentType('Crew Member', 'Contrat plein temps')).toBe('FULL_TIME');
      expect(inferEmploymentType('Crew Member', 'Vollzeit')).toBe('FULL_TIME');
      expect(inferEmploymentType('Crew Member', 'Teilzeit')).toBe('PART_TIME');
    });

    it('reads the workload percentage in the title when the source has no type', () => {
      // Head-office rows carry only a department, or the listing's empty
      // `employmentType: []`.
      expect(inferEmploymentType('Manager Asset Management & Real Estate (100%)', [])).toBe('FULL_TIME');
      expect(inferEmploymentType('Mitarbeiter Marketing (60%)', [])).toBe('PART_TIME');
    });
  });
});
