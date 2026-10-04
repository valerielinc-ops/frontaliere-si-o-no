import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ listingDate: '' as unknown, detailDate: '', creationDate: '', legacy: false, failDetail: false }));
vi.mock('../scripts/lib/ats-clients/successfactors-client.mjs', async (importOriginal) => {
  const original = await importOriginal<typeof import('../scripts/lib/ats-clients/successfactors-client.mjs')>();
  return { ...original, fetchSuccessFactorsJobs: async function* () {
    yield {
      title: 'Production Engineer', location: 'Basel, CH',
      applyUrl: 'https://jobdetails.nestle.com/job/Basel-Engineer/123/', jobReqId: '123',
      datePosted: state.listingDate, postedDate: state.listingDate, postedAt: state.listingDate,
      ...(state.legacy ? {} : { postingDateSource: 'reported' }),
    };
  } };
});
vi.mock('../scripts/lib/crawler-template.mjs', async (importOriginal) => {
  const original = await importOriginal<typeof import('../scripts/lib/crawler-template.mjs')>();
  return { ...original, fetchJson: vi.fn(async () => ({ refineSearch: { totalHits: 1, data: { jobs: [{
    jobId: '123', title: 'Production Engineer', country: 'Switzerland', location: 'Basel, Switzerland',
    postedDate: state.listingDate, dateCreated: state.creationDate,
    descriptionTeaser: Array.from({ length: 80 }, () => 'production').join(' '),
  }] } } })) };
});
import { fetchAllNestleJobs } from '../scripts/lib/nestle-job-parser.mjs';
import { fetchAllThermoFisherScientificJobs } from '../scripts/lib/thermo-fisher-scientific-job-parser.mjs';

const sourceDate = new Date(Date.now() - 10 * 86400000).toISOString();
const newerDate = new Date(Date.now() - 5 * 86400000).toISOString();
const unknown = { datePosted: '', postedDate: '', postingDateSource: 'unknown' };
const reported = (date: string) => ({ datePosted: date, postedDate: date, postingDateSource: 'reported' });

beforeEach(() => {
  Object.assign(state, { listingDate: '', detailDate: '', creationDate: newerDate, legacy: false, failDetail: false });
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void) => {
    callback(); return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (state.failDetail) return new Response('', { status: 503 });
    const body = Array.from({ length: 80 }, () => 'production').join(' ');
    return new Response(String(url).includes('nestle.com')
      ? `<html><body><meta itemprop="datePosted" content="${state.detailDate}"><span data-careersite-propertyid="description">${body}</span></body></html>`
      : `<script type="application/ld+json">${JSON.stringify({ '@graph': [{ '@type': 'JobPosting', datePosted: state.detailDate, description: body }] })}</script>`);
  }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

for (const [company, fetchAll] of [['Nestlé', fetchAllNestleJobs], ['Thermo Fisher', fetchAllThermoFisherScientificJobs]] as const) {
  describe(`${company} source publication propagation`, () => {
    it.each(['', 'not-a-date', '2025-02-30', `junk ${sourceDate}`])('rejects missing/invalid source %s without collection fallback', async (value) => {
      state.listingDate = value; state.detailDate = value;
      const jobs = await fetchAll();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject(unknown);
    });
    it('preserves the full detail publication timestamp', async () => {
      state.detailDate = sourceDate;
      const jobs = await fetchAll();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject(reported(sourceDate));
    });
    it('retains a genuine listing date when detail publication is unknown', async () => {
      state.listingDate = sourceDate;
      const jobs = await fetchAll();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject(reported(sourceDate));
    });
    it('keeps the earlier genuine publication when both surfaces report one', async () => {
      state.listingDate = sourceDate; state.detailDate = newerDate;
      const jobs = await fetchAll();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject(reported(sourceDate));
    });
  });
}
it('Nestlé does not attest an unmarked shared-client legacy date', async () => {
  state.listingDate = sourceDate; state.legacy = true;
  expect((await fetchAllNestleJobs())[0]).toMatchObject(unknown);
});
it('Thermo Fisher normalizes the API compact offset without truncating time', async () => {
  state.listingDate = sourceDate.replace('Z', '+0000');
  expect((await fetchAllThermoFisherScientificJobs())[0]).toMatchObject(reported(sourceDate.replace('Z', '+00:00')));
});
it('Thermo Fisher does not promote dateCreated on detail failure', async () => {
  state.failDetail = true;
  expect((await fetchAllThermoFisherScientificJobs())[0]).toMatchObject(unknown);
});

it.each([{ value: [sourceDate] }, { value: Date.now() }, { value: { datePosted: sourceDate } }])('Thermo Fisher does not coerce a non-string API date $value', async ({ value }) => {
  state.listingDate = value;
  expect((await fetchAllThermoFisherScientificJobs())[0]).toMatchObject(unknown);
});
