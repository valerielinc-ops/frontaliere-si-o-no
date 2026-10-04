import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { fetchHtml } = vi.hoisted(() => ({ fetchHtml: vi.fn() }));
vi.mock('../scripts/lib/hospital-custom-html-helpers.mjs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../scripts/lib/hospital-custom-html-helpers.mjs')>()), fetchHtml,
}));
import { fetchAllRehaBellikonJobs } from '../scripts/lib/reha-bellikon-job-parser.mjs';
import { mergePreserveLocaleData } from '../scripts/lib/dedicated-crawler-common.mjs';
const past = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10) + 'T12:30:00+02:00';
const future = new Date(Date.now() + 7 * 86400000).toISOString();
const invalid = `${new Date().getUTCFullYear()}-02-30`;
const unknown = { datePosted: '', postedDate: '', postingDateSource: 'unknown' };

describe('JobPublish Bellikon real wrapper source publication', () => {
  beforeEach(() => { fetchHtml.mockReset(); vi.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
  it.each([
    ['feed timestamp', past, undefined, past], ['missing', '', undefined, ''],
    ['invalid', invalid, undefined, ''], ['future', future, undefined, ''],
    ['JSON-LD only', '', past, past], ['invalid feed with valid JSON-LD', invalid, past, past],
  ])('%s remains atomic through DCC merge', async (_kind, publishStartDate, datePosted, expectedDate) => {
    const xml = `<jobs><job><id>1234</id><title>Fachperson Pflege</title><workload>80-100%</workload><detail_url>https://job.rehabellikon.ch/job/1234/</detail_url><publishStartDate>${publishStartDate}</publishStartDate><jobStartDate>${past}</jobStartDate><created>${past}</created><updated>${past}</updated></job></jobs>`;
    const transport = vi.fn(async () => new Response(xml)); vi.stubGlobal('fetch', transport);
    fetchHtml.mockResolvedValue(`<div class="statement-text">${'Sie arbeiten gemeinsam mit unserem erfahrenen Team. '.repeat(15)}</div><script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', datePosted, dateCreated: past, dateModified: past, jobStartDate: past })}</script>`);
    const jobs = await fetchAllRehaBellikonJobs(); expect(jobs).toHaveLength(1);
    expect(transport).toHaveBeenCalledTimes(1); expect(fetchHtml).toHaveBeenCalledTimes(1);
    const expected = expectedDate ? { datePosted: expectedDate, postedDate: expectedDate, postingDateSource: 'reported' } : unknown;
    expect(jobs[0]).toMatchObject(expected); expect(Number.isFinite(Date.parse(jobs[0].crawledAt))).toBe(true);
    const previous = { ...jobs[0], datePosted: past, postedDate: past, postingDateSource: 'unknown' };
    const merged = mergePreserveLocaleData([previous], jobs, { matchKey: (job: {id: string}) => job.id });
    expect(merged).toHaveLength(1); expect(merged[0]).toMatchObject(expected);
  });
});
