import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchAllHfrJobs } from '../scripts/lib/hfr-hopital-fribourgeois-job-parser.mjs';
import { fetchAllSiemensJobs } from '../scripts/lib/siemens-job-parser.mjs';

const { fetchHtml } = vi.hoisted(() => ({ fetchHtml: vi.fn() }));
vi.mock('../scripts/lib/crawler-template.mjs', async (importOriginal) => ({
  ...await importOriginal<typeof import('../scripts/lib/crawler-template.mjs')>(), fetchHtml,
}));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-04T12:00:00Z'));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

function expectPublication(job: Record<string, unknown>, date: string) {
  expect(job).toMatchObject({ datePosted: date, postedDate: date ? date.slice(0, 10) : '', postingDateSource: date ? 'reported' : 'unknown' });
  expect(job.title).toBeTruthy();
  expect(job.description).toBeTruthy();
  expect(job.url).toBeTruthy();
  expect(job.canton).toBeTruthy();
}

const dateDaysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
const dateDaysAhead = (days: number) => new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
const HFR_SOURCE_DESCRIPTION = [
  'Accompagner les patients et coordonner les soins avec les équipes médicales de notre hôpital.',
  'Participer aux projets du service, documenter les interventions et respecter les procédures de qualité et de sécurité.',
  'Collaborer avec les équipes interdisciplinaires dans un environnement bilingue et contribuer à la formation continue.',
  'Assurer un accueil attentif, transmettre les informations nécessaires et participer aux améliorations continues de la prise en charge.',
].join(' ');

describe('Oracle publication through the real HFR consumer', () => {
  it.each([
    ['detail timestamp', () => dateDaysAgo(14), undefined, () => dateDaysAgo(14)],
    ['listing timestamp', undefined, () => dateDaysAgo(10), () => dateDaysAgo(10)],
    ['older original detail', () => dateDaysAgo(100), () => dateDaysAgo(2), () => dateDaysAgo(100)],
    ['missing', undefined, undefined, () => ''],
    ['invalid calendar', '2026-02-30', 'nonsense', () => ''],
    ['future', () => dateDaysAhead(1), () => dateDaysAhead(2), () => ''],
    ['valid fallback after invalid detail', '2026-02-30', () => dateDaysAgo(10), () => dateDaysAgo(10)],
  ])('%s preserves the atomic evidence fields', async (_label, detailValue, listingValue, expectedValue) => {
    const detailDate = typeof detailValue === 'function' ? detailValue() : detailValue;
    const listingDate = typeof listingValue === 'function' ? listingValue() : listingValue;
    const expected = (expectedValue as () => string)();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/recruitingCEJobRequisitionDetails/')) {
        return new Response(JSON.stringify({
          ExternalDescriptionStr: `<div>${HFR_SOURCE_DESCRIPTION}</div>`,
          ExternalPostedStartDate: detailDate,
        }), { status: 200 });
      }
      if (url.includes('/recruitingCEJobRequisitions?')) {
        return new Response(JSON.stringify({
          items: [{
            TotalJobsCount: 1,
            requisitionList: [{
              Id: 'example',
              Title: 'Infirmier hospitalier',
              PrimaryLocation: 'Fribourg, Switzerland',
              PrimaryLocationCountry: 'CH',
              PostedDate: listingDate,
            }],
          }],
        }), { status: 200 });
      }
      return new Response('', { status: 404 });
    }));
    const result = await fetchAllHfrJobs();
    expect(result.jobs).toHaveLength(1);
    expectPublication(result.jobs[0], expected);
    expect(result.jobs[0].companyKey).toBe('hfr-hopital-fribourgeois');
  });
});

describe('Siemens explicit Posted since through listing and detail', () => {
  it.each([
    ['29-Jun-2026', '2026-06-29'],
    ['2026-09-30T23:30:00-03:00', '2026-09-30T23:30:00-03:00'],
    ['', ''], ['30-Feb-2026', ''], ['05-Oct-2026', ''], ['not a date', ''],
  ])('%s yields source evidence or explicit unknown', async (raw, expected) => {
    const url = 'https://jobs.siemens.com/en_US/externaljobs/JobDetail/12345';
    const listing = `<div class="list-controls__text__legend">1 of 1</div><article class="article article--result"><h3><a href="${url}">Automation Engineer</a></h3></article>`;
    const field = (label: string, value: string) => `<div class="field__label">${label}</div><div class="field__value">${value}</div>`;
    const detail = field('Posted since', raw) + field('Company', 'Siemens Schweiz AG')
      + field('Location(s)', '<ul><li>Zürich - Zürich - Switzerland</li></ul>')
      + field('Job type', 'Full-time')
      + '<article><div id="section1__content">Develop automation systems and collaborate with engineers to deliver reliable industrial solutions.</div></article>';
    fetchHtml.mockImplementation(async (target: string) => target === url ? detail : listing);
    const jobs = await fetchAllSiemensJobs();
    expect(jobs).toHaveLength(1);
    expectPublication(jobs[0], expected);
    expect(jobs[0].companyKey).toBe('siemens');
  });
});
