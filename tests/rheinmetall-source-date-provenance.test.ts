import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAllRheinmetallAirDefenceJobs } from '../scripts/lib/rheinmetall-air-defence-job-parser.mjs';
const body = 'Engineering specialists design and verify reliable equipment through careful analysis testing documentation and collaboration with colleagues and customers. '.repeat(5);
const recent = new Date(Date.now() - 5 * 86400000).toISOString();
afterEach(() => vi.unstubAllGlobals());
describe('Rheinmetall corroborated corporate publication date', () => {
  for (const [label, date] of [['valid timestamp', recent], ['invalid detail', recent], ['invalid listing', 'broken'], ['timezone-free', recent.slice(0, 19).replace('T', ' ')], ['missing', undefined], ['invalid calendar', '2026-02-30 00:00:00'], ['future', new Date(Date.now() + 86400000 * 10).toISOString()]]) {
    it(`validates ${label} through actual listing/detail producer`, async () => {
      vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(
        String(url).includes('?filter=')
          ? { elements: { areablock: [{ type: 'search', data: { search: { results: [{ id: 'fixture', url: '/en/job/systems-engineer', title: 'Systems Engineer', date, cities: [['Zürich']] }] } } }] } }
          : { elements: { title: 'Systems Engineer', date: label === 'invalid detail' ? 'broken' : label === 'invalid listing' ? recent : date, cities: [['Zürich']], jobBlocks: [{ content: { data: `<p>${body}</p>` } }] } }
      ), { headers: { 'Content-Type': 'application/json' } })));
      const jobs = await fetchAllRheinmetallAirDefenceJobs();
      expect(jobs).toHaveLength(1);
      const expected = ['valid timestamp', 'invalid detail', 'invalid listing'].includes(String(label)) ? recent : '';
      expect(jobs[0]).toMatchObject({ title: 'Systems Engineer', datePosted: expected, postedDate: expected, postingDateSource: expected ? 'reported' : 'unknown', canton: 'ZH' });
      expect(jobs[0].description.split(/\s+/).length).toBeGreaterThan(50);
      expect(Number.isFinite(Date.parse(jobs[0].crawledAt))).toBe(true);
      expect(jobs[0].url).toBe('https://www.rheinmetall.com/en/job/systems-engineer');
    });
  }
});
