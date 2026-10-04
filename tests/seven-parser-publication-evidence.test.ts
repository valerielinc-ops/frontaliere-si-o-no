import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

const source = vi.hoisted(() => ({
  html: (_url: string): string => { throw new Error('Unconfigured HTML fixture'); },
  json: (_url: string): unknown => { throw new Error('Unconfigured JSON fixture'); },
}));
vi.mock('../scripts/lib/crawler-template.mjs', async (importOriginal) => ({
  ...await importOriginal<typeof import('../scripts/lib/crawler-template.mjs')>(),
  fetchHtml: async (url: string) => source.html(String(url)),
  fetchJson: async (url: string) => source.json(String(url)),
}));
vi.mock('../scripts/lib/hospital-custom-html-helpers.mjs', async (importOriginal) => ({
  ...await importOriginal<typeof import('../scripts/lib/hospital-custom-html-helpers.mjs')>(),
  fetchHtml: async (url: string) => source.html(String(url)),
}));
vi.mock('../scripts/lib/jobs-ch-company-pages.mjs', async (importOriginal) => ({
  ...await importOriginal<typeof import('../scripts/lib/jobs-ch-company-pages.mjs')>(),
  collectJobsChVacancyUrls: async () => ({ vacancyUrls: ['https://www.jobs.ch/de/stellenangebote/detail/fixture/'], provenEmpty: false }),
  fetchJobsChVacancyInOriginalLanguage: async (url: string) => ({ html: source.html(url), url, sourceLang: 'de' }),
}));
import { fetchAllSenevitaJobs } from '../scripts/lib/senevita-job-parser.mjs';
import { fetchAllSpitexChJobs } from '../scripts/lib/spitex-ch-job-parser.mjs';
import { fetchAllStrabagJobs } from '../scripts/lib/strabag-job-parser.mjs';
import { fetchAllVisionapartmentsJobs } from '../scripts/lib/visionapartments-job-parser.mjs';
import { fetchAllVillaImParkJobs } from '../scripts/lib/villa-im-park-job-parser.mjs';
import { fetchAllTotalEnergiesJobs } from '../scripts/lib/totalenergies-job-parser.mjs';
import { fetchAllWuerthInternationalJobs } from '../scripts/lib/wuerth-international-job-parser.mjs';

const unknown = { datePosted: '', postedDate: '', postingDateSource: 'unknown' };
const body = 'The employer describes duties, required experience and working conditions for this role. '.repeat(8);
const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString();
const detail = (datePosted: string) => `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title: 'Engineer', description: body, datePosted, jobLocation: { address: { addressLocality: 'Zurich', addressCountry: 'CH' } } })}</script>`;
const senevitaListing = readFileSync(new URL('./fixtures/senevita-listing.html', import.meta.url), 'utf8').replace(/data-all-count="\d+"/, 'data-all-count="3"');
afterEach(() => { vi.unstubAllGlobals(); });

for (const [name, fetchJobs] of [['Senevita', fetchAllSenevitaJobs], ['Spitex', fetchAllSpitexChJobs], ['Strabag', fetchAllStrabagJobs], ['Visionapartments', fetchAllVisionapartmentsJobs]] as const) {
  describe(`${name} publication pipeline`, () => {
    it('preserves explicit timestamps and never manufactures publication when absent or invalid', async () => {
      const valid = daysAgo(5);
      for (const date of [valid, '', 'invalid', daysAgo(-2)]) {
        source.html = (url) => url.includes('stellenangebote.html') ? senevitaListing
          : url.includes('/suche/page/') ? '<div data-total="1" data-url="https://www.spitexjobs.ch/job/engineer/J123"></div>'
          : detail(date);
        const jobs = await fetchJobs();
        expect(jobs.length).toBeGreaterThan(0);
        for (const job of jobs) expect(job).toMatchObject(date === valid ? { datePosted: valid, postedDate: valid, postingDateSource: 'reported' } : unknown);
      }
    });
  });
}

describe('Villa im Park release provenance', () => {
  it('carries public releasedDate through the actual SmartRecruiters producer', async () => {
    const valid = daysAgo(4);
    for (const releasedDate of [valid, '', 'invalid', daysAgo(-2)]) {
      const posting = { id: 'fixture', name: 'Engineer', releasedDate, createdOn: valid, customField: [{ fieldLabel: 'Brands', valueId: 'PKV' }], location: { city: 'Rothrist', country: 'ch' }, jobAd: { sections: { jobDescription: { text: body } } } };
      source.json = (url) => url.includes('?limit=') ? { totalFound: 1, content: [posting] } : posting;
      const jobs = await fetchAllVillaImParkJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject(releasedDate === valid ? { datePosted: valid, postedDate: valid, postingDateSource: 'reported' } : unknown);
    }
  });
});

describe('TotalEnergies source publication versus creation field', () => {
  it('uses detail JobPosting publication and does not infer the meaning of jobCreationDate', async () => {
    const valid = daysAgo(4);
    const listing = `<div class="list-controls__text__legend">1 result</div><div class="article article--result"><h3><a href="https://jobs.totalenergies.com/en_US/careers/JobDetail/Engineer/123">Engineer</a></h3><li class="list-item-jobCountry">Switzerland</li><li class="list-item-jobCreationDate">${daysAgo(12).slice(0, 10).split('-').reverse().join('-')}</li></div>`;
    for (const date of [valid, '', 'invalid', daysAgo(-2)]) {
      source.html = (url) => url.includes('/JobDetail/')
        ? `${detail(date)}<dt class="field__label">Country</dt><dd class="field__value">Switzerland</dd><h3 class="title--04"><strong>Responsibilities</strong></h3><dd class="field__value">${body}</dd>`
        : listing;
      const jobs = await fetchAllTotalEnergiesJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject(date === valid ? { datePosted: valid, postedDate: valid, postingDateSource: 'reported' } : unknown);
    }
  });
});

describe('Würth explicitly labelled publication', () => {
  it('validates Erschienen am and rejects missing, impossible and future dates', async () => {
    const valid = daysAgo(5).slice(0, 10);
    const [year, month, day] = valid.split('-');
    const sourceDate = `${day}.${month}.${year}`;
    const listing = '<table><tr><td>Engineer</td><td>Chur</td><td>Vollzeit</td><td><a href="Job-details_123.php">Mehr</a></td></tr></table>';
    for (const date of [sourceDate, '', `30.02.${year}`, `01.01.${Number(year) + 2}`]) {
      source.html = (url) => url.includes('Job-details_')
        ? `<h1>Engineer</h1><div class="atribute-container">Erschienen am: ${date}</div><div class="card-body">${body}</div></div>`
        : listing;
      const jobs = await fetchAllWuerthInternationalJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject(date === sourceDate ? { datePosted: valid, postedDate: valid, postingDateSource: 'reported' } : unknown);
    }
  });
});
