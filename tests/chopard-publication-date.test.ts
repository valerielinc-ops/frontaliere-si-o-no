import { afterEach, describe, expect, it, vi } from 'vitest';
const source = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock('../scripts/lib/ats-clients/csod-client.mjs', () => ({ fetchCsodJobs: vi.fn(async () => source.rows) }));
import { fetchAllChopardJobs } from '../scripts/lib/chopard-job-parser.mjs';
afterEach(() => { source.rows = []; vi.restoreAllMocks(); vi.useRealTimers(); });

describe('Chopard source publication date through the real producer', () => {
  it.each([
    ['9/29/2026', '2026-09-29'], ['02/29/2024', '2024-02-29'],
    [undefined, ''], ['', ''], ['2/30/2026', ''], ['2/29/2025', ''],
    ['13/1/2026', ''], ['10/5/2026', ''], ['9/29/2026 extra', ''],
    ['9/29/26', ''], [123, ''],
  ])('validates postingEffectiveDate %s without crawl-date fallback', async (raw, expected) => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-04T12:00:00Z'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    source.rows = [{ requisitionId: 2529, displayJobTitle: 'IT Project Manager',
      locations: [{ country: 'CH', city: 'Meyrin' }],
      externalDescription: '<p>Gestion des projets informatiques de notre entreprise.</p>',
      postingEffectiveDate: raw, createdDate: '2026-09-01', lastModifiedDate: '2026-10-03' }];
    const jobs = await fetchAllChopardJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({datePosted: expected, postedDate: expected ? expected.slice(0, 10) : '',
      postingDateSource: expected ? 'reported' : 'unknown'});
    expect(jobs[0].crawledAt).toBe('2026-10-04T12:00:00.000Z');
  });
});
