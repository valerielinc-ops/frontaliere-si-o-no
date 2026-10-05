import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchAllCslBehringJobs } from '../scripts/lib/csl-behring-job-parser.mjs';
import { fetchAllKsbJobs } from '../scripts/lib/ksb-job-parser.mjs';
import { fetchAllLindtSpruengliJobs } from '../scripts/lib/lindt-spruengli-job-parser.mjs';
import { fetchAllNvidiaZurichJobs } from '../scripts/lib/nvidia-zurich-job-parser.mjs';
import { fetchAllRitualsCosmeticsJobs } from '../scripts/lib/rituals-cosmetics-job-parser.mjs';

const replay = vi.hoisted(() => ({ posting: {} as Record<string, unknown>, info: {} as Record<string, unknown> }));
const body = 'We are looking for a qualified professional to join our team and support the development of reliable services for our customers. You will work closely with colleagues across departments, document your work carefully and contribute practical ideas to improve our processes. The role requires relevant professional experience, strong communication skills and a structured approach to solving problems. We offer a collaborative workplace, continuing professional education and opportunities to take responsibility for meaningful projects.';
vi.mock('../scripts/lib/ats-clients/workday-client.mjs', async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  async *fetchWorkdayJobs() { yield replay.posting; },
  fetchWorkdayJobDetail: async () => ({ jobPostingInfo: replay.info }),
  fetchWorkdayJobDetailParts: async () => ({ info: replay.info, text: body }),
  fetchWorkdayJobDescriptionText: async () => body,
  fetchWorkdaySidebarText: async () => '',
}));

beforeEach(() => {
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void) => {
    callback();
    return 0;
  }) as unknown as typeof setTimeout);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network in Workday replay'); }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const cases = [
  ['CSL', 'EMEA, CH, Bern, CSL Behring', fetchAllCslBehringJobs],
  ['KSB', 'Baden', fetchAllKsbJobs],
  ['Lindt', 'Kilchberg, Switzerland', fetchAllLindtSpruengliJobs],
  ['NVIDIA', 'Switzerland, Zurich', fetchAllNvidiaZurichJobs],
  ['Rituals', 'Lugano', fetchAllRitualsCosmeticsJobs],
] as const;
for (const [name, location, fetchJobs] of cases) {
  describe(`${name} publication date through listing and detail`, () => {
    const run = async (listingDate?: string, detailDate?: string) => {
      replay.posting = { title: 'Senior Operations Specialist', externalPath: '/job/Switzerland/Senior-Operations-Specialist_R-12345', locationsText: location, postedOn: listingDate || 'Posted 30+ Days Ago', bulletFields: ['R-12345'] };
      replay.info = { title: replay.posting.title, location, jobDescription: `<p>${body}</p>`, timeType: 'Full time', ...(detailDate ? { startDate: detailDate } : {}) };
      const jobs = await fetchJobs();
      expect(jobs).toHaveLength(1);
      return jobs[0];
    };
    it('does not convert relative source labels into crawl dates', async () => {
      expect(await run()).toMatchObject({ datePosted: '', postedDate: '', postingDateSource: 'unknown' });
    });
    it('preserves exact publication evidence from the Workday detail', async () => {
      const date = new Date(Date.now() - 9 * 86400000).toISOString().slice(0, 10);
      expect(await run(undefined, date)).toMatchObject({ datePosted: date, postedDate: date, postingDateSource: 'reported' });
    });
    it('preserves an exact listing date when detail publication is absent', async () => {
      const date = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
      expect(await run(date)).toMatchObject({ datePosted: date, postedDate: date, postingDateSource: 'reported' });
    });
  });
}
