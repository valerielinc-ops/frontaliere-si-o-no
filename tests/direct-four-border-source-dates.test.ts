import { afterEach, describe, expect, it, vi } from 'vitest';
import { parsePostings } from '../scripts/lib/bucherer-job-parser.mjs';
import { fetchAllCAndASchweizJobs } from '../scripts/lib/c-and-a-schweiz-job-parser.mjs';
import { fetchAllClimeworksJobs } from '../scripts/lib/climeworks-job-parser.mjs';
import { fetchJobs } from '../scripts/update-casale-jobs.mjs';

const body = 'Our engineering team designs reliable systems and supports customers through careful planning development testing delivery and maintenance. '.repeat(6);
const recent = `${new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10)}T12:34:56+02:00`;
const future = new Date(Date.now() + 10 * 86400000).toISOString();
const cases = [['timestamp', recent], ['missing', undefined], ['invalid', '2026-02-30T12:00:00Z'], ['future', future]] as const;
afterEach(() => vi.unstubAllGlobals());

function flattened(value: unknown) {
  const output: unknown[] = [];
  function add(item: unknown): number {
    const index = output.length;
    output.push(null);
    output[index] = Array.isArray(item) ? item.map(add)
      : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).map(([key, v]) => [key, add(v)])) : item;
    return index;
  }
  add(value);
  return output;
}
function assertDate(job: Record<string, unknown>, expected: string) {
  expect(job).toMatchObject({ datePosted: expected, postedDate: expected, postingDateSource: expected ? 'reported' : 'unknown' });
  expect(String(job.title)).toContain('Engineer');
  expect(String(job.description).split(/\s+/).length).toBeGreaterThan(50);
  expect(job.url).toBeTruthy();
}

describe('Direct source publication dates through actual producer boundaries', () => {
  for (const [label, raw] of cases) {
    it(`Bucherer ${label}: posting availability only, not employment start`, () => {
      const jobs = parsePostings([{
        jobPostingId: 'source-fixture', jobTitle: 'Systems Engineer', jobDescription: `<p>${body}</p>`,
        postingStartTimestampUTC: raw, jobStartDate: recent, createdAt: recent,
        postingLocations: [{ cityName: 'Luzern', stateCode: 'LU', isoCountryCode: 'CH' }],
      }]);
      expect(jobs).toHaveLength(1);
      assertDate(jobs[0], label === 'timestamp' ? recent : '');
    });
    it(`Casale ${label}: real runner projection retains the publication tuple`, async () => {
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ offers: [{
        id: 'source-fixture', slug: 'systems-engineer', title: 'Systems Engineer', description: `<p>${body}</p>`,
        locations: [{ country_code: 'CH', city: 'Lugano', state: 'Ticino' }], published_at: raw,
        created_at: recent, updated_at: recent,
      }] }) })));
      const jobs = await fetchJobs();
      expect(jobs).toHaveLength(1);
      assertDate(jobs[0], label === 'timestamp' ? recent : '');
    });
    it(`Climeworks ${label}: creation/update cannot replace published_at`, async () => {
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ offers: [{
        id: 'source-fixture', slug: 'systems-engineer', title: 'Systems Engineer', country_code: 'CH', city: 'Zürich',
        translations: { en: { description: `<p>${body}</p>` } }, published_at: raw, created_at: recent, updated_at: recent,
      }] }) })));
      const jobs = await fetchAllClimeworksJobs();
      expect(jobs).toHaveLength(1);
      assertDate(jobs[0], label === 'timestamp' ? recent : '');
    });
    it(`C&A ${label}: an uncorroborated creation date remains unknown`, async () => {
      vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () =>
        String(url).includes('loadMoreJobs')
          ? { type: 'success', data: JSON.stringify(flattened({ jobsTotalCount: 1, jobs: [{ title: 'Systems Engineer', slug: 'systems-engineer', tags: ['Zürich (CH)'] }] })) }
          : { nodes: [{ data: flattened({ jobID: 'source-fixture', description: `<p>${body}</p>`, locations: { CH: [{ city: 'Zürich', zipCode: '8000' }] }, createdIsoDate: raw }) }] },
      })));
      const jobs = await fetchAllCAndASchweizJobs();
      expect(jobs).toHaveLength(1);
      assertDate(jobs[0], '');
    });
  }
});
