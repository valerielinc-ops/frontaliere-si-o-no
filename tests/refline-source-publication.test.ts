import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchHtml } = vi.hoisted(() => ({ fetchHtml: vi.fn() }));
vi.mock('../scripts/lib/hospital-custom-html-helpers.mjs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../scripts/lib/hospital-custom-html-helpers.mjs')>()),
  fetchHtml,
}));

import { fetchAllArosaLenzerheideJobs } from '../scripts/lib/arosa-lenzerheide-job-parser.mjs';
import { fetchAllGesundheitsnetzKuesnachtJobs } from '../scripts/lib/gesundheitsnetz-kuesnacht-job-parser.mjs';
import { fetchAllMedicsLaborJobs } from '../scripts/lib/medics-labor-job-parser.mjs';
import { fetchAllPfisterJobs } from '../scripts/lib/pfister-job-parser.mjs';
import { fetchAllPukZuerichJobs } from '../scripts/lib/puk-zuerich-job-parser.mjs';
import { fetchAllStiftungKindAutismusJobs } from '../scripts/lib/stiftung-kind-autismus-job-parser.mjs';
import { fetchAllZkbJobs } from '../scripts/lib/zkb-job-parser.mjs';
import { mergePreserveLocaleData } from '../scripts/lib/dedicated-crawler-common.mjs';

const consumers = [
  ['arosa-lenzerheide', fetchAllArosaLenzerheideJobs],
  ['gesundheitsnetz-kuesnacht', fetchAllGesundheitsnetzKuesnachtJobs],
  ['medics-labor', fetchAllMedicsLaborJobs],
  ['pfister', fetchAllPfisterJobs],
  ['puk-zuerich', fetchAllPukZuerichJobs],
  ['stiftung-kind-autismus', fetchAllStiftungKindAutismusJobs],
  ['zkb', fetchAllZkbJobs],
] as const;
const unknown = { postedDate: '', datePosted: '', postingDateSource: 'unknown' };
// Relative to the actual clock: no stale-prune time bomb in the fixture.
const past = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10) + 'T12:30:00+02:00';
const future = new Date(Date.now() + 7 * 86400000).toISOString();
const invalid = `${new Date().getUTCFullYear()}-02-30`;
const description = 'Sie arbeiten gemeinsam mit unserem erfahrenen Team an anspruchsvollen Aufgaben. '.repeat(12);

describe.each(consumers)('Refline factory through scheduled %s wrapper', (_company, fetchJobs) => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    fetchHtml.mockReset();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it.each([
    ['timestamp', past], ['missing', undefined], ['invalid calendar', invalid], ['future', future],
  ])('carries atomic publication evidence for %s through the actual merge normalizer', async (_kind, datePosted) => {
    fetchHtml.mockImplementation(async (url: string) => {
      const parsed = new URL(url);
      if (!parsed.pathname.includes('/pub/')) {
        const tenant = parsed.pathname.split('/')[1];
        return `<a href="${parsed.origin}/${tenant}/1234/pub/1/index.html">Fachperson Pflege 80%</a><div class="item workName">Zürich</div>`;
      }
      return `<h1>Fachperson Pflege 80%</h1><p>${description}</p><script type="application/ld+json">${JSON.stringify({
        '@type': 'JobPosting', datePosted, description,
        // Neither unrelated source metadata nor start date can establish publication.
        dateCreated: past, dateModified: past, jobStartDate: past,
      })}</script>`;
    });
    const pending = fetchJobs();
    await vi.runAllTimersAsync();
    const jobs = await pending;
    expect(jobs).toHaveLength(1);
    expect(fetchHtml).toHaveBeenCalledTimes(2); // Existing listing + detail; no additional fetch.
    const fresh = jobs[0];
    const expected = datePosted === past
      ? { postedDate: past, datePosted: past, postingDateSource: 'reported' }
      : unknown;
    expect(fresh).toMatchObject(expected);
    expect(Number.isFinite(Date.parse(fresh.crawledAt))).toBe(true);
    // A previous unknown record with stale date strings cannot reintroduce a crawl clock.
    const previous = { ...fresh, postedDate: past, datePosted: past, postingDateSource: 'unknown' };
    const merged = mergePreserveLocaleData([previous], [fresh], { matchKey: (job: { id: string }) => job.id });
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject(expected);
  });
});
