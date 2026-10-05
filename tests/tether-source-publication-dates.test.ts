import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAllTetherJobs } from '../scripts/lib/tether-job-parser.mjs';
const text = 'Engineering teams design reliable systems and maintain high quality through planning testing documentation and collaboration with colleagues and customers. '.repeat(5);
const date = `${new Date(Date.now() - 5 * 86400000).toISOString().slice(0,10)}T12:34:56+02:00`;
const offer = (raw: unknown, slug = 'systems-engineer') => ({ id: slug, slug, title: 'Systems Engineer', description: `<p>${text}</p>`, locations: [{ city: 'Lugano', state: 'Ticino', country_code: 'CH' }], published_at: raw, created_at: date, updated_at: date });
const response = (offers: unknown[]) => new Response(JSON.stringify({ offers }), { headers: { 'Content-Type': 'application/json' } });
afterEach(() => vi.unstubAllGlobals());
describe('Tether source publication provenance', () => {
  for (const [label, raw] of [['timestamp', date], ['missing', undefined], ['invalid', '2026-02-30T12:00:00Z'], ['future', new Date(Date.now()+10*86400000).toISOString()]]) {
    it(`${label}: keeps only valid explicit published_at`, async () => {
      vi.stubGlobal('fetch', vi.fn(async () => response([offer(raw)])));
      const jobs = await fetchAllTetherJobs();
      expect(jobs).toHaveLength(1);
      const expected = label === 'timestamp' ? date : '';
      expect(jobs[0]).toMatchObject({ datePosted: expected, postedDate: expected, postingDateSource: expected ? 'reported' : 'unknown', canton: 'TI' });
      expect(jobs[0].description.split(/\s+/).length).toBeGreaterThan(50);
      expect(jobs[0].url).toContain('/o/systems-engineer');
    });
  }
  it('keeps the Swiss record and its unknown tuple during dedup, without copying a foreign date', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response([{ ...offer(date, 'foreign'), locations: [{ city: 'London', state: 'England' }] }, offer(undefined, 'swiss')])));
    const jobs = await fetchAllTetherJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ datePosted: '', postedDate: '', postingDateSource: 'unknown', canton: 'TI' });
    expect(jobs[0].url).toContain('/o/swiss');
  });
  it('preserves the timestamp and matching URL on the custom-origin fallback', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => String(url).startsWith('https://tether.recruitee.com') ? new Response('', { status: 503 }) : response([offer(date)])));
    const jobs = await fetchAllTetherJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ datePosted: date, postedDate: date, postingDateSource: 'reported' });
    expect(jobs[0].url).toBe('https://careers.tether.io/o/systems-engineer');
  });
});
