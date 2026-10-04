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
  expect(job).toMatchObject({ datePosted: date, postedDate: date, postingDateSource: date ? 'reported' : 'unknown' });
  expect(job.title).toBeTruthy();
  expect(job.description).toBeTruthy();
  expect(job.url).toBeTruthy();
  expect(job.canton).toBeTruthy();
}

describe('Breezy publication through the real HFR consumer', () => {
  it.each([
    ['detail timestamp', '2026-09-20T23:30:00-03:00', undefined, '2026-09-20T23:30:00-03:00'],
    ['listing timestamp', undefined, '2026-09-24T12:29:43.403Z', '2026-09-24T12:29:43.403Z'],
    ['older original detail', '2026-06-25', '2026-10-02', '2026-06-25'],
    ['missing', undefined, undefined, ''],
    ['invalid calendar', '2026-02-30', 'nonsense', ''],
    ['future', '2026-10-05', '2026-10-06', ''],
    ['valid fallback after invalid detail', '2026-02-30', '2026-09-24', '2026-09-24'],
  ])('%s preserves the atomic evidence fields', async (_label, detailDate, listingDate, expected) => {
    const listing = [{ id: 'example', friendly_id: 'example', name: 'Infirmier hospitalier',
      url: 'https://hopital-fribourgeois.breezy.hr/p/example', published_date: listingDate,
      created_date: '2026-09-01', updated_date: '2026-10-03' }];
    const detail = `<script type="application/ld+json">${JSON.stringify({
      '@type': 'JobPosting', title: 'Infirmier hospitalier', datePosted: detailDate,
      description: 'Accompagner les patients et coordonner les soins avec les équipes médicales de notre hôpital.',
      jobLocation: { address: { addressLocality: 'Fribourg', addressRegion: 'FR', postalCode: '1708' } },
      employmentType: 'FULL_TIME',
    })}</script>`;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/json')
      ? { ok: true, json: async () => listing }
      : { ok: true, text: async () => detail }));
    const jobs = await fetchAllHfrJobs();
    expect(jobs).toHaveLength(1);
    expectPublication(jobs[0], expected as string);
    expect(jobs[0].companyKey).toBe('hfr-hopital-fribourgeois');
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
