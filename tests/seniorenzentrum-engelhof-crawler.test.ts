import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

const specCrawlerMocks = vi.hoisted(() => ({
  loadSpec: vi.fn(),
  runSpecInProduction: vi.fn(),
}));

vi.mock('../scripts/lib/prospector/spec-crawler.mjs', () => specCrawlerMocks);

import {
  extractSeniorenzentrumEngelhofDetailFields,
  fetchAllSeniorenzentrumEngelhofJobs,
  isSeniorenzentrumEngelhofJob,
  isSeniorenzentrumEngelhofOssJob,
  isTrustedDomain,
  SENIORENZENTRUM_ENGELHOF_COMPANY_NAME,
  SENIORENZENTRUM_ENGELHOF_KEY,
} from '../scripts/lib/seniorenzentrum-engelhof-job-parser.mjs';

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
      expect(isTrustedDomain('https://other.employerboard.ch/job/1')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);

      expect(isSeniorenzentrumEngelhofJob({ companyKey: SENIORENZENTRUM_ENGELHOF_KEY })).toBe(true);
      expect(isSeniorenzentrumEngelhofJob({ url: sourceListing.url })).toBe(true);
      expect(isSeniorenzentrumEngelhofJob({ companyKey: 'other', url: 'https://other.example/job/1' })).toBe(false);
    });
  });

  it('recovers the source-backed workplace from the EmployerBoard vacancy body', () => {
    expect(extractSeniorenzentrumEngelhofDetailFields(
      detailHtml,
      sourceListing.url,
    )).toMatchObject({
      location: '8852 Altendorf',
      canton: 'SZ',
      addressLocality: 'Altendorf',
      addressRegion: 'SZ',
      postalCode: '8852',
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

      await expect(fetchAllSeniorenzentrumEngelhofJobs()).resolves.toEqual([]);
    });
  });
});
