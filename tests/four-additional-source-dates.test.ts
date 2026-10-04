import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ raw: '' as unknown, detail: '', secondary: '', legacy: false, body: Array.from({ length: 80 }, () => 'professional').join(' ') }));
vi.mock('../scripts/lib/crawler-template.mjs', async (importOriginal) => {
  const original = await importOriginal<typeof import('../scripts/lib/crawler-template.mjs')>();
  return { ...original, fetchHtml: vi.fn(async (url: string) => {
    if (url.includes('msccruises')) {
      if (url.includes('/search-results')) return `<script>${JSON.stringify({ eagerLoadRefineSearch: { totalHits: 1, data: { jobs: [{ jobId: '123', title: 'Engineer', country: 'Switzerland', location: 'Geneva, Switzerland', descriptionTeaser: state.body, postedDate: state.raw, dateCreated: state.secondary }] } } })}</script>`;
      return `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', datePosted: state.detail, description: state.body })}</script>`;
    }
    if (url.includes('orellfuessli')) {
      if (url.endsWith('/de/offene-stellen')) return '<a href="/de/offene-stellen/engineer-123" class="c-job-teaser">Engineer</a>';
      return `<script type="application/ld+json">${JSON.stringify({ '@graph': [{ '@type': 'JobPosting', title: 'Engineer', description: state.body, datePosted: state.raw, jobLocation: { address: { addressLocality: 'Zürich' } } }] })}</script>`;
    }
    if (url.includes('swissre.com')) return `<section class="ArticleSection"><div class="richtext"><p>${state.body}</p></div></section>`;
    throw new Error(`Unexpected HTML endpoint: ${url}`);
  }) };
});
vi.mock('../scripts/lib/ats-clients/successfactors-client.mjs', async (importOriginal) => {
  const original = await importOriginal<typeof import('../scripts/lib/ats-clients/successfactors-client.mjs')>();
  return { ...original, fetchSuccessFactorsJobs: async function* () {
    yield { title: 'Engineer', location: 'Zurich, CH', applyUrl: 'https://www.swissre.com/careers/job/engineer/123/', jobReqId: '123',
      datePosted: state.raw, postedDate: state.raw, postedAt: state.raw,
      ...(state.legacy ? {} : { postingDateSource: 'reported' }) };
  } };
});
import { fetchAllMscCargoJobs } from '../scripts/lib/msc-cargo-job-parser.mjs';
import { fetchAllOnRunningJobs } from '../scripts/lib/on-running-job-parser.mjs';
import { fetchAllOrellFuessliThaliaJobs } from '../scripts/lib/orell-fuessli-thalia-job-parser.mjs';
import { fetchAllSwissReJobs } from '../scripts/lib/swiss-re-job-parser.mjs';
import { sourceCompactOffsetPostingDateFields } from '../scripts/lib/source-posting-date.mjs';

const source = new Date(Date.now() - 10 * 86400000).toISOString();
const future = new Date(Date.now() + 10 * 86400000).toISOString();
const unknown = { datePosted: '', postedDate: '', postingDateSource: 'unknown' };
const reported = (date: string) => ({ datePosted: date, postedDate: date, postingDateSource: 'reported' });
beforeEach(() => {
  Object.assign(state, { raw: '', detail: '', secondary: source, legacy: false });
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void) => { callback(); return 0 as unknown as ReturnType<typeof setTimeout>; }) as typeof setTimeout);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ jobs: [{ id: 123, title: 'Engineer', location: { name: 'Zurich' }, absolute_url: 'https://boards.greenhouse.io/onrunning/jobs/123', first_published: state.raw, updated_at: state.secondary, content: state.body }] }))));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

for (const [name, fetchAll] of [['MSC', fetchAllMscCargoJobs], ['On', fetchAllOnRunningJobs], ['Orell', fetchAllOrellFuessliThaliaJobs], ['Swiss Re', fetchAllSwissReJobs]] as const) {
  describe(`${name} real producer publication`, () => {
    it.each(['', 'not-a-date', '2025-02-30', future, `junk ${source}`])('keeps invalid source %s unknown despite secondary timestamps', async (raw) => {
      state.raw = raw;
      const jobs = await fetchAll();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject(unknown);
    });
    it('preserves authentic publication precision and marker', async () => {
      state.raw = source;
      const jobs = await fetchAll();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject(reported(source));
    });
  });
}
it('Swiss Re never promotes a legacy unmarked shared date', async () => {
  state.raw = source; state.legacy = true;
  expect((await fetchAllSwissReJobs())[0]).toMatchObject(unknown);
});
it('MSC accepts detail JobPosting publication when listing has none', async () => {
  state.detail = source;
  expect((await fetchAllMscCargoJobs())[0]).toMatchObject(reported(source));
});
it('MSC preserves the API compact timezone without truncating time', async () => {
  state.raw = source.replace('Z', '+0000');
  expect((await fetchAllMscCargoJobs())[0]).toMatchObject(reported(source.replace('Z', '+00:00')));
});
it.each([{ raw: [source] }, { raw: 123 }, { raw: { date: source } }, { raw: '2025-02-30T12:00:00+0000' }, { raw: future.replace('Z', '+0000') }])('Compact-offset publication rejects malformed/non-string input $raw', ({ raw }) => {
  expect(sourceCompactOffsetPostingDateFields(raw)).toEqual(unknown);
});
it('Compact-offset publication keeps the explicit offset and exact timestamp', () => {
  expect(sourceCompactOffsetPostingDateFields(source.replace('Z', '+0130'))).toEqual(reported(source.replace('Z', '+01:30')));
});

it('Orell retains the compact offset used by its real JSON-LD source', async () => {
  state.raw = source.replace('Z', '+0200');
  expect((await fetchAllOrellFuessliThaliaJobs())[0]).toMatchObject(reported(source.replace('Z', '+02:00')));
});
