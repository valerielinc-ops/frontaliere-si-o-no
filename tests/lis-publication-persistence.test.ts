import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const storage = vi.hoisted(() => ({ previous: [] as Array<Record<string, unknown>>, writes: [] as unknown[] }));
vi.mock('../scripts/assemble-jobs-dataset.mjs', async (importOriginal) => ({
  ...await importOriginal<typeof import('../scripts/assemble-jobs-dataset.mjs')>(),
  readExistingCrawlerJobs: () => storage.previous,
}));
vi.mock('../scripts/lib/atomic-write-json.mjs', () => ({ writeJsonAtomic: (_path: string, data: unknown) => { storage.writes.push(data); } }));
import { crawlArca24Direct } from '../scripts/update-lis-jobs.mjs';

const url = 'https://lavoraconnoi.lugano-lis.ch/job/view-job.php?id=25-capireparto&language=it';
const body = 'I professionisti assicurano cure qualificate alle persone ospitate nella struttura. '.repeat(20);
const listing = `<div class="singleResult"><a href="${url}"><h3>Capireparto</h3></a></div>`;
const page = (date: string) => `<h1 itemprop="title">Capireparto</h1><strong itemprop="datePosted">${date}</strong><div itemprop="description">${body}</div>`;
function transport(date: string, partial = false, allFailed = false) {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (allFailed || (partial && requestUrl.includes('page=2'))) return new Response('', { status: 404 });
    return new Response(requestUrl.includes('view-job.php') ? page(date) : listing);
  }));
}
beforeEach(() => { storage.previous = []; storage.writes = []; vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-04T12:00:00Z')); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('LIS custom runner persistence boundary', () => {
  it('persists reported full timestamp from real fetched detail', async () => {
    transport('2026-10-02T08:30:00+02:00');
    const result = await crawlArca24Direct();
    expect(result).toMatchObject({ discovered: 1, parsed: 1, merged: 1 });
    expect(storage.writes[0]).toEqual([expect.objectContaining({ url, datePosted: '2026-10-02T08:30:00+02:00', postedDate: '2026-10-02T08:30:00+02:00', postingDateSource: 'reported' })]);
  });
  it('persists unknown without promoting a valid-looking legacy stored alias', async () => {
    storage.previous = [{ url, companyKey: 'lis-lugano-istituti-sociali', datePosted: '2026-09-01', title: 'Capireparto' }];
    transport('');
    await crawlArca24Direct();
    expect(storage.writes[0]).toEqual([expect.objectContaining({ url, datePosted: '', postedDate: '', postingDateSource: 'unknown', description: expect.stringContaining('cure qualificate') })]);
  });
  it('preserves earlier attested publication when new source has no date', async () => {
    storage.previous = [{ url, companyKey: 'lis-lugano-istituti-sociali', datePosted: '2026-09-01', postedDate: '2026-09-01', postingDateSource: 'reported' }];
    transport('');
    await crawlArca24Direct();
    expect(storage.writes[0]).toEqual([expect.objectContaining({ url, datePosted: '2026-09-01', postedDate: '2026-09-01', postingDateSource: 'reported' })]);
  });
  it('retains the unseen record on partial listing discovery', async () => {
    const retained = { url: url.replace('25-capireparto', '99-infermieri'), companyKey: 'lis-lugano-istituti-sociali', description: body, datePosted: '', postedDate: '', postingDateSource: 'unknown' };
    storage.previous = [retained];
    transport('', true);
    const result = await crawlArca24Direct();
    expect(result).toMatchObject({ merged: 1, preservedExisting: 1 });
    expect(storage.writes[0]).toEqual([expect.objectContaining({ url, postingDateSource: 'unknown' }), retained]);
  });
  it('does not write when both listing pages fail', async () => {
    transport('', false, true);
    expect(await crawlArca24Direct()).toMatchObject({ aborted: 'all_listings_failed' });
    expect(storage.writes).toEqual([]);
  });
});
