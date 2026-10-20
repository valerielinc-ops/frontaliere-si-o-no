import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

const specCrawlerMocks = vi.hoisted(() => ({
  loadSpec: vi.fn(),
  runSpecInProduction: vi.fn(),
}));

vi.mock('../scripts/lib/prospector/spec-crawler.mjs', async (importOriginal) => ({
  ...(await importOriginal()),
  ...specCrawlerMocks,
}));

import {
  extractSeniorenzentrumEngelhofDetailFields,
  fetchAllSeniorenzentrumEngelhofJobs,
  isSeniorenzentrumEngelhofJob,
  isSeniorenzentrumEngelhofOssJob,
  isTrustedDomain,
  SENIORENZENTRUM_ENGELHOF_COMPANY_NAME,
  SENIORENZENTRUM_ENGELHOF_KEY,
} from '../scripts/lib/seniorenzentrum-engelhof-job-parser.mjs';
import { sourceAdapterRuntimeObservationFor, sourceCrawlerAdapterFor } from '../scripts/lib/prospector/source-adapters.mjs';

const sourceDescription = [
  '<p>Im Seniorenzentrum Engelhof begleiten wir ältere Menschen in ihrem Alltag.</p>',
  '<p>Sie übernehmen die Betreuung und Pflege der Bewohnerinnen und Bewohner,',
  'arbeiten aufmerksam im Team und dokumentieren die ausgeführten Tätigkeiten.</p>',
  '<p>Wir erwarten eine abgeschlossene Ausbildung, Freude am Kontakt mit Menschen,',
  'Verantwortungsbewusstsein, gute Deutschkenntnisse und Bereitschaft zu wechselnden',
  'Einsätzen. Wir bieten eine sorgfältige Einführung, Weiterbildung und ein kollegiales',
  'Arbeitsumfeld in Altendorf.</p>',
].join(' ');

const sourceListing = {
  title: 'Pflegehelferin / Pflegehelfer SRK 60-100%',
  description: sourceDescription,
  location: '8852 Altendorf',
  addressLocality: 'Altendorf',
  addressRegion: 'SZ',
  addressCountry: 'CH',
  postalCode: '8852',
  streetAddress: 'Engelhofstrasse 1',
  datePosted: '2026-09-14',
  postingDateSource: 'reported',
  employmentType: 'PART_TIME',
  url: 'https://seniorenzentrum-engelhof.employerboard.ch/job/pflegehelferin-pflegehelfer-srk/J993250/1526A5DC-5936-45AF-9A3322C77271510E',
};

const detailHtml = `
  <html>
    <head><title>Lernende/-r Assistent/-in Gesundheit &amp; Soziales EBA - Altendorf</title></head>
    <body>
      <div class="wwj-content">
        <div class="wwj-text" data-cy="job-detail">
          <p>Wir wünschen uns eine aufgestellte und motivierte Persönlichkeit.</p>
          <p>Seniorenzentrum Engelhof, Engelhofstrasse 1, 8852 Altendorf.</p>
          <p>Arbeitsort: 8853 Lachen.</p>
        </div>
      </div>
    </body>
  </html>
`;

afterEach(() => {
  specCrawlerMocks.loadSpec.mockReset();
  specCrawlerMocks.runSpecInProduction.mockReset();
});

describe('Seniorenzentrum Engelhof crawler parser', () => {
  it('exports the stable company identity', () => {
    expect(SENIORENZENTRUM_ENGELHOF_KEY).toBe('seniorenzentrum-engelhof');
    expect(SENIORENZENTRUM_ENGELHOF_COMPANY_NAME).toBe('Seniorenzentrum Engelhof');
  });

  it('opts into clean-IP rescue when the listing page yields no candidates', () => {
    const spec = JSON.parse(readFileSync(
      new URL('../data/prospector/crawlers/seniorenzentrum-engelhof.json', import.meta.url),
      'utf8',
    ));

    expect(spec).toMatchObject({
      rescueOnEmptyListing: true,
      revalidateRejectedWithSourceAdapter: true,
    });
  });

  describe('source and profession filters', () => {
    it('keeps OSS/assistente di cura titles and the explicit Swiss EBA qualification', () => {
      expect(isSeniorenzentrumEngelhofOssJob({ title: sourceListing.title })).toBe(true);
      expect(isSeniorenzentrumEngelhofOssJob({
        title: 'Lernende/-r Assistent/-in Gesundheit & Soziales EBA',
      })).toBe(true);
      expect(isSeniorenzentrumEngelhofOssJob({
        title: 'Studium Pflegefachperson HF',
      })).toBe(false);
      expect(isSeniorenzentrumEngelhofOssJob({
        title: 'Abteilungsleiterin / Abteilungsleiter Pflege 100%',
      })).toBe(false);
    });

    it('matches only the official site and its dedicated EmployerBoard tenant', () => {
      expect(isTrustedDomain('https://seniorenzentrum-engelhof.ch/arbeiten-im-engelhof/freie-stellen')).toBe(true);
      expect(isTrustedDomain(sourceListing.url)).toBe(true);
      expect(isTrustedDomain('https://www.sozjobs.ch/job/role/J993249/partnerDetail/easypublish/widgetid/widget')).toBe(true);
      expect(isTrustedDomain('https://other.employerboard.ch/job/1')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);

      expect(isSeniorenzentrumEngelhofJob({ companyKey: SENIORENZENTRUM_ENGELHOF_KEY })).toBe(true);
      expect(isSeniorenzentrumEngelhofJob({ url: sourceListing.url })).toBe(true);
      expect(isSeniorenzentrumEngelhofJob({
        companyKey: 'other-company',
        company: 'Other employer',
        url: 'https://www.sozjobs.ch/job/other/J123456/partnerDetail/easypublish/widgetid/1',
      })).toBe(false);
      expect(isSeniorenzentrumEngelhofJob({ companyKey: 'other', url: 'https://other.example/job/1' })).toBe(false);
    });
  });

  it('recovers Altendorf from the reviewed EasyPublish detail title', () => {
    const detail = extractSeniorenzentrumEngelhofDetailFields(
      '<html><head><title>Lernende/-r Assistent/-in Gesundheit &amp; Soziales EBA - Altendorf</title></head><body><p>Seniorenzentrum Engelhof</p></body></html>',
      'https://www.sozjobs.ch/job/lernende-r-assistent-in-gesundheit-soziales-eba/J993249/partnerDetail/easypublish/widgetid/C340F41D-F9B5-4321-9E415FE28675D925',
    );

    expect(detail).toMatchObject({
      location: 'Altendorf',
      canton: 'SZ',
      addressLocality: 'Altendorf',
      addressRegion: 'SZ',
    });
  });

  it('recovers the source-backed workplace from the EmployerBoard vacancy body', () => {
    expect(extractSeniorenzentrumEngelhofDetailFields(
      detailHtml,
      sourceListing.url,
    )).toMatchObject({
      location: '8853 Lachen',
      canton: 'SZ',
      addressLocality: 'Lachen',
      addressRegion: 'SZ',
      postalCode: '8853',
    });
    expect(extractSeniorenzentrumEngelhofDetailFields(
      detailHtml,
      sourceListing.url,
    ).location).not.toBe('8852 Altendorf');
  });

  it('rejects the employer seat when no variable workplace is present', () => {
    const detail = extractSeniorenzentrumEngelhofDetailFields(
      '<div data-cy="job-detail"><p>Arbeitsort: 8852 Altendorf.</p></div>',
      sourceListing.url,
    );

    expect(detail.location).toBe('');
    expect(detail.locationCandidates).toEqual([]);
    expect(detail.locationGateRejected).toBe(true);
  });

  it('accepts an unlabelled variable postal pair only after the employer seat', () => {
    const detail = extractSeniorenzentrumEngelhofDetailFields(
      '<div data-cy="job-detail"><p>8852 Altendorf.</p><p>8853 Lachen.</p></div>',
      sourceListing.url,
    );

    expect(detail).toMatchObject({
      location: '8853 Lachen',
      addressLocality: 'Lachen',
      postalCode: '8853',
      canton: 'SZ',
    });
  });

  describe('fetchAllSeniorenzentrumEngelhofJobs', () => {
    it('publishes source-backed target jobs and drops neighbouring roles', async () => {
      specCrawlerMocks.loadSpec.mockReturnValue({ companyKey: SENIORENZENTRUM_ENGELHOF_KEY });
      specCrawlerMocks.runSpecInProduction.mockResolvedValue([
        sourceListing,
        {
          ...sourceListing,
          title: 'Lernende/-r Assistent/-in Gesundheit & Soziales EBA',
          url: sourceListing.url + '-eba',
        },
        {
          ...sourceListing,
          title: 'Studium Pflegefachperson HF',
          url: sourceListing.url + '-hf',
        },
      ]);

      const jobs = await fetchAllSeniorenzentrumEngelhofJobs();

      expect(jobs).toHaveLength(2);
      expect(jobs[0]).toMatchObject({
        company: SENIORENZENTRUM_ENGELHOF_COMPANY_NAME,
        companyKey: SENIORENZENTRUM_ENGELHOF_KEY,
        location: '8852 Altendorf',
        canton: 'SZ',
        addressLocality: 'Altendorf',
        addressRegion: 'SZ',
        addressCountry: 'CH',
        country: 'CH',
        postalCode: '8852',
        streetAddress: 'Engelhofstrasse 1',
        datePosted: '2026-09-14',
        postedDate: '2026-09-14',
        postingDateSource: 'reported',
        baseSalary: null,
        employmentType: 'PART_TIME',
      });
      expect(jobs[0].description.split(/\s+/).length).toBeGreaterThanOrEqual(50);
      expect(jobs.every((job) => job.sourceLang === 'de')).toBe(true);
      expect(jobs.every((job) => job.url.includes('employerboard.ch/job/'))).toBe(true);
      expect(specCrawlerMocks.loadSpec).toHaveBeenCalledWith(SENIORENZENTRUM_ENGELHOF_KEY);
      expect(Object.getOwnPropertyDescriptor(jobs, 'expectedFilterCount')).toMatchObject({ value: 1 });
      expect(Object.getOwnPropertyDescriptor(jobs, 'expectedFilters').value)
        .toMatchObject({ engelhof_target_job_scope: 1 });
      expect(Object.getOwnPropertyDescriptor(jobs, 'detailDrop').value)
        .toMatchObject({ candidates: 2, dropped: 0 });
      expect(sourceAdapterRuntimeObservationFor(jobs, {
        companyKey: SENIORENZENTRUM_ENGELHOF_KEY,
        adapter: sourceCrawlerAdapterFor({ companyKey: SENIORENZENTRUM_ENGELHOF_KEY }),
      })).toMatchObject({
        listingCount: 3,
        expectedFilterCount: 1,
        complete: true,
      });
    });

    it('does not replace missing workplace evidence with the employer address', async () => {
      specCrawlerMocks.loadSpec.mockReturnValue({ companyKey: SENIORENZENTRUM_ENGELHOF_KEY });
      specCrawlerMocks.runSpecInProduction.mockResolvedValue([{
        ...sourceListing,
        location: 'Remote',
        addressLocality: '',
        addressRegion: '',
        addressCountry: '',
        postalCode: '',
        streetAddress: '',
      }]);

      const jobs = await fetchAllSeniorenzentrumEngelhofJobs();
      expect(jobs).toEqual([]);
      expect(Object.getOwnPropertyDescriptor(jobs, 'detailDrop').value)
        .toMatchObject({ candidates: 1, gone: 1, dropped: 1 });
      expect(sourceAdapterRuntimeObservationFor(jobs, {
        companyKey: SENIORENZENTRUM_ENGELHOF_KEY,
        adapter: sourceCrawlerAdapterFor({ companyKey: SENIORENZENTRUM_ENGELHOF_KEY }),
      })).toMatchObject({
        snapshotAccepted: true,
        productionSnapshotAccepted: true,
        complete: false,
        dropCounts: { detail_runtime_gone: 1 },
      });
    });

    it('preserves non-enumerable fetch metadata through row mapping and empty output', async () => {
      const failedPartialListings: any[] = [sourceListing];
      Object.defineProperties(failedPartialListings, {
        fetchOutcome: { value: 'anti_bot_block', enumerable: false },
        discoveredCount: { value: 3, enumerable: false },
        detailDrop: {
          value: { candidates: 3, gone: 1, rejected: 1, dropped: 2 },
          enumerable: false,
        },
      });
      specCrawlerMocks.loadSpec.mockReturnValue({ companyKey: SENIORENZENTRUM_ENGELHOF_KEY });
      specCrawlerMocks.runSpecInProduction.mockResolvedValue(failedPartialListings);

      const jobs = await fetchAllSeniorenzentrumEngelhofJobs();
      expect(jobs).toHaveLength(1);
      expect(Object.keys(jobs)).not.toContain('fetchOutcome');
      expect(Object.getOwnPropertyDescriptor(jobs, 'fetchOutcome')).toMatchObject({
        value: 'anti_bot_block', enumerable: false,
      });
      expect(Object.getOwnPropertyDescriptor(jobs, 'discoveredCount')).toMatchObject({
        value: 3, enumerable: false,
      });
      expect(Object.getOwnPropertyDescriptor(jobs, 'detailDrop')).toMatchObject({
        value: { candidates: 3, gone: 1, rejected: 1, dropped: 2 }, enumerable: false,
      });
      expect(sourceAdapterRuntimeObservationFor(jobs, {
        companyKey: SENIORENZENTRUM_ENGELHOF_KEY,
        adapter: sourceCrawlerAdapterFor({ companyKey: SENIORENZENTRUM_ENGELHOF_KEY }),
      })).toMatchObject({
        fetchOutcome: 'anti_bot_block',
        listingCount: 3,
        snapshotAccepted: false,
        complete: false,
      });

      const blockedEmpty: any[] = [];
      Object.defineProperties(blockedEmpty, {
        fetchOutcome: { value: 'selector_miss', enumerable: false },
        discoveredCount: { value: 0, enumerable: false },
        detailDrop: {
          value: { candidates: 0, gone: 0, rejected: 0, dropped: 0 },
          enumerable: false,
        },
      });
      specCrawlerMocks.runSpecInProduction.mockResolvedValue(blockedEmpty);
      const emptyJobs = await fetchAllSeniorenzentrumEngelhofJobs();
      expect(emptyJobs).toHaveLength(0);
      expect(Object.getOwnPropertyDescriptor(emptyJobs, 'fetchOutcome')).toMatchObject({
        value: 'selector_miss', enumerable: false,
      });
      expect(sourceAdapterRuntimeObservationFor(emptyJobs)).toMatchObject({
        fetchOutcome: 'selector_miss',
        snapshotAccepted: false,
        complete: false,
      });
    });

    it('keeps a failed endpoint outcome when a later endpoint succeeds', async () => {
      const failedBatch: any[] = [];
      Object.defineProperty(failedBatch, 'fetchOutcome', {
        value: 'connection_error',
        enumerable: false,
      });
      const successfulBatch: any[] = [sourceListing];
      Object.defineProperty(successfulBatch, 'fetchOutcome', {
        value: 'ok',
        enumerable: false,
      });
      specCrawlerMocks.loadSpec.mockReturnValue({
        companyKey: SENIORENZENTRUM_ENGELHOF_KEY,
        listingEndpoints: ['current', 'apprenticeships'],
      });
      specCrawlerMocks.runSpecInProduction
        .mockResolvedValueOnce(failedBatch)
        .mockResolvedValueOnce(successfulBatch);

      const jobs = await fetchAllSeniorenzentrumEngelhofJobs();

      expect(jobs).toHaveLength(1);
      expect(Object.getOwnPropertyDescriptor(jobs, 'fetchOutcome')).toMatchObject({
        value: 'connection_error', enumerable: false,
      });
    });
  });
});
