import { afterEach, describe, it, expect, vi } from 'vitest';
import { fetchAllAlconJobs } from '../scripts/lib/alcon-job-parser.mjs';
import { fetchAllArdianJobs } from '../scripts/lib/ardian-job-parser.mjs';
import { fetchAllBossardJobs } from '../scripts/lib/bossard-job-parser.mjs';
import { fetchAllNovartisJobs } from '../scripts/lib/novartis-job-parser.mjs';
import { fetchAllRocheJobs } from '../scripts/lib/roche-job-parser.mjs';
import { fetchAllStrykerJobs } from '../scripts/lib/stryker-job-parser.mjs';
import { fetchAllRitualsCosmeticsJobs } from '../scripts/lib/rituals-cosmetics-job-parser.mjs';
import { fetchAllEdmondDeRothschildJobs } from '../scripts/lib/edmond-de-rothschild-job-parser.mjs';

/**
 * Only the posting's own text is published (issue 5253). These dedicated
 * parsers built a synthetic "Key details" stub (title — employer, city;
 * location line; employer blurb; "apply on the portal") whenever the
 * requisition's detail carried fewer than 100 characters of body. Such a
 * requisition is not published any more — the same rule the shared Workday
 * factory, ksb and nestle follow. Workday CXS and Oracle HCM shapes as served
 * by the tenants on 2026-09-29.
 */

const BODY = '<p>'
  + 'Responsibilities and requirements of the role, described at length by the employer. '.repeat(5)
  + '</p>';

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const WORKDAY_CASES = [
  { name: 'alcon', fetchAll: fetchAllAlconJobs, swiss: 'Geneva, Switzerland' },
  { name: 'ardian', fetchAll: fetchAllArdianJobs, swiss: 'Zurich' },
  { name: 'bossard', fetchAll: fetchAllBossardJobs, swiss: 'Zug' },
  { name: 'novartis', fetchAll: fetchAllNovartisJobs, swiss: 'Basel' },
  { name: 'roche', fetchAll: fetchAllRocheJobs, swiss: 'Basel' },
  { name: 'stryker', fetchAll: fetchAllStrykerJobs, swiss: 'Bern, Switzerland' },
  { name: 'rituals-cosmetics', fetchAll: fetchAllRitualsCosmeticsJobs, swiss: 'Manor Winterthur' },
] as const;

describe('dedicated Workday parsers — req without a vacancy body', () => {
  for (const { name, fetchAll, swiss } of WORKDAY_CASES) {
    it(`${name}: publishes the req with a body and skips the one without, never inventing text`, async () => {
      const postings = [
        { title: 'Senior Engineer', externalPath: '/job/Swiss/Senior-Engineer_JR1', locationsText: swiss, postedOn: 'Posted Today', bulletFields: ['JR1'] },
        { title: 'Project Manager', externalPath: '/job/Swiss/Project-Manager_JR2', locationsText: swiss, postedOn: 'Posted Today', bulletFields: ['JR2'] },
      ];
      vi.stubGlobal('fetch', vi.fn(async (url: string, init: any = {}) => {
        const href = String(url);
        if (init?.method === 'POST' && href.endsWith('/jobs')) {
          const body = JSON.parse(init.body || '{}');
          return json({ total: 2, jobPostings: body.offset > 0 ? [] : postings });
        }
        if (href.endsWith('_JR1')) return json({ jobPostingInfo: { title: 'Senior Engineer', location: swiss, jobDescription: BODY } });
        if (href.endsWith('_JR2')) return json({ jobPostingInfo: { title: 'Project Manager', location: swiss, jobDescription: '<p>Apply now</p>' } });
        return new Response('', { status: 404 });
      }));
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      const jobs: any[] = await fetchAll();

      expect(jobs.map((job) => job.title)).toEqual(['Senior Engineer']);
      expect(jobs[0].description).toContain('Responsibilities and requirements of the role');
      for (const job of jobs) expect(job.description).not.toContain('Key details');
    }, 20_000);
  }
});

describe('edmond-de-rothschild — requisition without a vacancy body', () => {
  it('publishes the requisition with a body and skips the one without, never inventing text', async () => {
    const req = (Id: string, Title: string) => ({ Id, Title, PrimaryLocation: 'Geneva', PrimaryLocationCountry: 'CH', PostedDate: '2026-09-20', ShortDescriptionStr: '' });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('recruitingCEJobRequisitions?')) {
        return json({ items: [{ TotalJobsCount: 2, requisitionList: [req('9001', 'Private Banker'), req('9002', 'Compliance Officer')] }] });
      }
      if (u.includes('recruitingCEJobRequisitionDetails/9001')) {
        return json({ ExternalDescriptionStr: `<p>${'You advise private clients on wealth planning and build long-term relationships with them. '.repeat(4)}</p>` });
      }
      if (u.includes('recruitingCEJobRequisitionDetails/9002')) return json({ ExternalDescriptionStr: '' });
      return new Response('', { status: 404 });
    }));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const jobs: any[] = await fetchAllEdmondDeRothschildJobs();

    expect(jobs.map((job) => job.title)).toEqual(['Private Banker']);
    for (const job of jobs) expect(job.description).not.toContain('Key details');
  }, 20_000);
});
