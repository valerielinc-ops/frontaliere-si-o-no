import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
const writes = vi.hoisted(() => vi.fn());
vi.mock('fs', async (importOriginal) => ({ ...(await importOriginal<typeof import('node:fs')>()), existsSync: () => true, mkdirSync: vi.fn(), writeFileSync: writes }));
import { main, fetchArbeitSwissJobs } from '../scripts/update-jobs';

describe('manual job writer publication', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-04T12:00:00Z')); writes.mockReset(); });
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
  it('preserves the previous dataset and invents no vacancies when sources are unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })));
    const rejection = expect(main()).rejects.toThrow('preserving existing data/jobs.json');
    await vi.runAllTimersAsync(); await rejection;
    expect(writes).not.toHaveBeenCalled();
    expect(readFileSync('scripts/update-jobs.ts', 'utf8')).not.toContain('generatePlaceholderJobs');
  });
  it('writes the source tuple through the real manual assembly without placeholders', async () => {
    const datePosted = '2026-10-02T10:00:00.123456+02:00';
    const posting = { '@type': 'JobPosting', title: 'Engineer', url: 'https://employer.example/job/1', datePosted, description: 'Real source role', hiringOrganization: { name: 'Acme' } };
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'HEAD') return new Response('', { status: 200 });
      if (url.includes('job-room.ch')) return new Response(`<script type="application/ld+json">${JSON.stringify(posting)}</script>`);
      return new Response('', { status: 503 });
    }));
    const task = main(); await vi.runAllTimersAsync(); expect(await task).toBe(1);
    const output = writes.mock.calls.find(([file]) => String(file).endsWith('/jobs.json'));
    expect(JSON.parse(output![1])).toEqual([expect.objectContaining({ title: 'Engineer', datePosted, postedDate: datePosted, postingDateSource: 'reported' })]);
  });
  it.each(['2026-10-02T10:00:00.123456+02:00', '', '2026-02-30', '2026-10-05'])('preserves only genuine valid JSONLD publication %s', async (datePosted) => {
    const posting = { '@type': 'JobPosting', title: 'Engineer', url: 'https://employer.example/job/1', datePosted, description: 'Real role', hiringOrganization: { name: 'Acme' } };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(`<script type="application/ld+json">${JSON.stringify(posting)}</script>`)));
    const jobs = await fetchArbeitSwissJobs(); expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject(datePosted.startsWith('2026-10-02')
      ? { datePosted, postedDate: datePosted, postingDateSource: 'reported' }
      : { datePosted: '', postedDate: '', postingDateSource: 'unknown' });
  });
});
