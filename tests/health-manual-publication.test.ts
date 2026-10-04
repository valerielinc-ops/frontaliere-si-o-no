import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchAllChuvJobs } from '../scripts/lib/chuv-job-parser.mjs';
import { fetchLisDetailPage, buildLisJob } from '../scripts/lib/lis-lugano-istituti-sociali-job-parser.mjs';

const body = 'Les professionnels assurent les soins aux patients avec une équipe multidisciplinaire. '.repeat(18);
const detailUrl = 'https://recrutement.chuv.ch/vacancy/infirmier-123.html';
const lisUrl = 'https://lavoraconnoi.lugano-lis.ch/job/view-job.php?id=25-capireparto&language=it';
const lisHtml = (raw: string) => `<h1 itemprop="title">Capireparto</h1><strong itemprop="datePosted">${raw}</strong><span itemprop="validThrough">31/12/2030</span><div itemprop="description">${body}</div>`;
const urlOf = (input: string | URL | Request) => typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-04T12:00:00Z')); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });

describe('CHUV public feed publication through real producer', () => {
  const cases: ReadonlyArray<readonly [string, unknown, string]> = [
    ['published calendar day', '2026-10-02 00:00:00', '2026-10-02'],
    ['full zoned timestamp', '2026-10-02T08:30:00+02:00', '2026-10-02T08:30:00+02:00'],
    ['missing', undefined, ''], ['invalid', 'n/a', ''],
    ['future', '2030-01-01 00:00:00', ''], ['invalid calendar', '2026-02-30 00:00:00', ''],
    ['unproven local time zone', '2026-10-02 14:30:00', ''], ['non-string', 1780000000, ''],
  ];
  it.each(cases)('%s preserves body and ignores generic timestamp', async (_, raw, expected) => {
    const fetcher = vi.fn(async (input: string | URL | Request) => urlOf(input) === detailUrl
      ? new Response(`<div class="job_description"><p>${body}</p></div>`)
      : Response.json({ jobs: [{ id: 123, title: 'Infirmier diplômé', status: 'open', weblink: detailUrl, timestamp: '2026-09-01', publication: { internet: { publish_date: raw, closing_date: '2030-12-31' } }, locations: [{ city: 'Lausanne' }] }] }));
    vi.stubGlobal('fetch', fetcher);
    vi.stubEnv('CHUV_SKIP_DETAILS', '0');
    const jobs = await fetchAllChuvJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ id: 'chuv-123', url: detailUrl, applyUrl: detailUrl, postedDate: expected, datePosted: expected, postingDateSource: expected ? 'reported' : 'unknown', crawledAt: '2026-10-04T12:00:00.000Z' });
    expect(jobs[0].description).toContain('professionnels assurent');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe('LIS fetched detail into actual builder', () => {
  const cases: ReadonlyArray<readonly [string, string, string]> = [
    ['publication day', '02/10/2026', '2026-10-02'],
    ['zoned timestamp', '2026-10-02T08:30:00+02:00', '2026-10-02T08:30:00+02:00'],
    ['missing', '', ''], ['invalid', 'not a date', ''], ['future', '01/01/2030', ''],
    ['invalid calendar', '30/02/2026', ''], ['embedded plausible date', 'starts 02/10/2026', ''],
  ];
  it.each(cases)('%s retains application record without deadline promotion', async (_, raw, expected) => {
    const fetcher = vi.fn(async () => new Response(lisHtml(raw)));
    vi.stubGlobal('fetch', fetcher);
    const parsed = await fetchLisDetailPage(lisUrl);
    const job = buildLisJob(lisUrl, parsed);
    expect(job).toMatchObject({ title: 'Capireparto', url: lisUrl, datePosted: expected, postedDate: expected, postingDateSource: expected ? 'reported' : 'unknown', validThrough: '2030-12-31' });
    expect(job?.description).toContain('professionnels assurent');
    expect(job?.slug).toBe('capireparto');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('does not promote a legacy parsed alias lacking evidence', () => {
    expect(buildLisJob(lisUrl, { title: 'Capireparto', description: body, datePosted: '2026-09-01' })).toMatchObject({ datePosted: '', postedDate: '', postingDateSource: 'unknown' });
  });
});
