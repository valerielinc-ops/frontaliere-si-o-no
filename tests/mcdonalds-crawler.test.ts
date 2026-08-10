import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  MCDO_KEY,
  COMPANY_NAME,
  parseMcdoMapEntries,
  mapEntryToParsed,
  parseMcdoDetailPage,
  buildMcdoJob,
  inferCanton,
  inferEmploymentType,
} from '../scripts/lib/mcdonalds-job-parser.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

// Real HTML captured 2026-08-10 from the live portal (issue #5393):
//   https://jobs.mcdonalds.ch/postes-vacants     → mcdonalds-postes-vacants.html
//   https://jobs.mcdonalds.ch/details-offre/8187 → mcdonalds-details-offre-8187.html
const listingHtml = readFileSync(path.join(FIXTURES, 'mcdonalds-postes-vacants.html'), 'utf8');
const detailHtml = readFileSync(path.join(FIXTURES, 'mcdonalds-details-offre-8187.html'), 'utf8');

describe("McDonald's Switzerland crawler parser", () => {
  it('exports valid company key and name', () => {
    expect(MCDO_KEY).toBe('mcdonald-s-switzerland');
    expect(COMPANY_NAME).toBe("McDonald's Switzerland");
  });

  // ── Listing discovery (the #5393 regression surface) ──
  describe('parseMcdoMapEntries', () => {
    it('extracts the mcdo_jobs_mapEntries array from the live vacancies page', () => {
      const entries = parseMcdoMapEntries(listingHtml);
      expect(entries).toHaveLength(4);
      expect(entries[0]).toMatchObject({
        id: '10488',
        title: 'CREW - Locarno',
        url: '/details-offre/8266',
        city_name: 'Locarno',
      });
    });

    it('bracket-matches past `]` characters inside the surrounding settings blob', () => {
      // The array lives inside the Drupal settings JSON, which contains other
      // arrays (e.g. "ajaxTrustedUrl":[]) before it. A non-greedy `\[.*?\]`
      // regex stops at the first `]` and yields nothing usable.
      expect(listingHtml).toContain('"ajaxTrustedUrl":[]');
      expect(parseMcdoMapEntries(listingHtml).length).toBeGreaterThan(0);
    });

    it('returns [] rather than throwing when the array is absent or malformed', () => {
      expect(parseMcdoMapEntries('<html><body>no jobs here</body></html>')).toEqual([]);
      expect(parseMcdoMapEntries('<script>var mcdo_jobs_mapEntries = [ {broken</script>')).toEqual([]);
      expect(parseMcdoMapEntries('')).toEqual([]);
      expect(parseMcdoMapEntries(undefined as unknown as string)).toEqual([]);
    });

    it('does NOT depend on the retired sitemap-index shape', () => {
      // Regression guard for the actual break: the old discovery filtered
      // `/sitemap-<hash>-<locale>.xml` children out of a sitemap INDEX, and
      // the live /sitemap.xml is now a flat 18-URL <urlset> with none.
      const flatSitemap =
        '<urlset><url><loc>https://jobs.mcdonalds.ch/details-offre/8187</loc></url></urlset>';
      expect(/\/sitemap-[0-9a-f]+-/.test(flatSitemap)).toBe(false);
    });
  });

  describe('mapEntryToParsed', () => {
    it('maps a Ticino crew posting to the shared parsed shape', () => {
      const [locarno] = parseMcdoMapEntries(listingHtml);
      const parsed = mapEntryToParsed(locarno)!;
      expect(parsed.title).toBe('CREW - Locarno');
      expect(parsed.city).toBe('Locarno');
      expect(parsed.canton).toBe('TI');
      expect(parsed.jobReqId).toBe('10488');
      expect(parsed.datePosted).toBe('2026-05-04');
      expect(parsed.description.length).toBeGreaterThan(50);
    });

    it('absolutises the relative /details-offre/ URL onto the canonical https host', () => {
      const [locarno] = parseMcdoMapEntries(listingHtml);
      expect(mapEntryToParsed(locarno)!.url).toBe('https://jobs.mcdonalds.ch/details-offre/8266');
    });

    it('infers the canton of every fixture entry from city_name alone', () => {
      const cantons = parseMcdoMapEntries(listingHtml).map((e) => mapEntryToParsed(e)!.canton);
      expect(cantons).toEqual(['TI', 'VD', 'ZH', 'BE']);
    });

    it('returns null for entries without a title or url', () => {
      expect(mapEntryToParsed(null)).toBeNull();
      expect(mapEntryToParsed({ title: 'x' })).toBeNull();
      expect(mapEntryToParsed({ url: '/details-offre/1' })).toBeNull();
    });
  });

  // ── Detail page (kept as the enrichment / fallback path) ──
  describe('parseMcdoDetailPage', () => {
    it('extracts JSON-LD JobPosting fields from the live detail page', () => {
      const parsed = parseMcdoDetailPage(detailHtml, 'https://jobs.mcdonalds.ch/details-offre/8187')!;
      expect(parsed).not.toBeNull();
      expect(parsed.title).toBe('Manager Asset Management & Real Estate (100%)');
      expect(parsed.city).toBe('Crissier');
      expect(parsed.canton).toBe('VD');
      expect(parsed.jobReqId).toBe('8187');
      expect(parsed.datePosted).toBe('2026-03-19');
      expect(parsed.validThrough).toBe('2027-04-24');
    });

    it('reads the localized employmentType string the new portal emits', () => {
      // The retired SPA sent an array; this portal sends "Contrat plein temps".
      expect(detailHtml).toContain('Contrat plein temps');
      expect(parseMcdoDetailPage(detailHtml)!.employmentType).toBe('FULL_TIME');
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
      expect(job.postedDate).toBe('2026-03-19');
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
      expect(job.slug).toContain('manager-asset-management');
    });

    it('builds a complete Ticino job straight from a listing entry', () => {
      const [locarno] = parseMcdoMapEntries(listingHtml);
      const job = buildMcdoJob(mapEntryToParsed(locarno))!;
      expect(job.canton).toBe('TI');
      expect(job.location).toBe('Locarno');
      expect(job.country).toBe('CH');
      expect(job.url).toBe('https://jobs.mcdonalds.ch/details-offre/8266');
      expect(job.sector).toBe('Ristorazione / Fast Food');
      expect(job.description.length).toBeGreaterThan(50);
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
      expect(inferEmploymentType('Systemgastronomie LEHRE - EFZ', 'Restaurant - Apprentissage')).toBe('FULL_TIME');
    });

    it('respects explicit JSON-LD employmentType in both array and string form', () => {
      expect(inferEmploymentType('Crew Member', ['FULL_TIME'])).toBe('FULL_TIME');
      expect(inferEmploymentType('Crew Member', 'Contrat plein temps')).toBe('FULL_TIME');
      expect(inferEmploymentType('Crew Member', 'Vollzeit')).toBe('FULL_TIME');
      expect(inferEmploymentType('Crew Member', 'Teilzeit')).toBe('PART_TIME');
    });

    it('reads the workload percentage in the title when the source has no type', () => {
      // Head-office rows carry only a department in `type_name`.
      expect(inferEmploymentType('Manager Asset Management & Real Estate (100%)', 'Siège Administratif - Postes vacants')).toBe('FULL_TIME');
      expect(inferEmploymentType('Mitarbeiter Marketing (60%)', 'Siège Administratif - Postes vacants')).toBe('PART_TIME');
    });
  });
});
