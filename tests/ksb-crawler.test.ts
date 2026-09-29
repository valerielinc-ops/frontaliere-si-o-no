import { afterEach, describe, it, expect, vi } from 'vitest';
import { fetchAllKsbJobs } from '../scripts/lib/ksb-job-parser.mjs';

afterEach(() => {
  vi.unstubAllGlobals();
});

// Only the posting's own text is published (issue 5253). A req whose Workday
// detail has no body used to go out as a synthetic "Key details" stub
// (location, employer, "apply on the portal"); it is not published any more.
// CXS shapes minimised from kantonsspitalbaden.wd3.myworkdayjobs.com
// ksb-careers (2026-09-29): listing, `/sidebar` "About us", job detail.
describe('fetchAllKsbJobs — req without a vacancy body', () => {
  it('publishes the req with a body (plus the About-us sidebar) and skips the one without', async () => {
    const body = '<p>Für unsere Intensivstation suchen wir per sofort oder nach Vereinbarung eine engagierte Pflegefachperson.</p>'
      + '<ul><li>Betreuung von kritisch kranken Patientinnen und Patienten</li><li>Enge Zusammenarbeit im interprofessionellen Team</li></ul>';
    const json = (payload: unknown) => new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      if (u.endsWith('/jobs')) {
        return json({
          total: 2,
          jobPostings: [
            { title: 'Dipl. Pflegefachperson Intensivpflege 80-100%', externalPath: '/job/Baden/Dipl-Pflegefachperson-Intensivpflege_R-10001', locationsText: 'Baden', postedOn: 'Posted Today', bulletFields: ['R-10001'] },
            { title: 'Spontanbewerbung Pflege', externalPath: '/job/Baden/Spontanbewerbung-Pflege_R-10002', locationsText: 'Baden', postedOn: 'Posted Today', bulletFields: ['R-10002'] },
          ],
        });
      }
      if (u.endsWith('/sidebar')) {
        return json([{ type: 'IMAGE', title: 'About us', text: '<p>The KSB provides safe and close to home healthcare for more than 300,000 residents in the eastern part of the canton of Argovia.</p>' }]);
      }
      if (u.includes('R-10001')) return json({ jobPostingInfo: { title: 'Dipl. Pflegefachperson Intensivpflege 80-100%', jobDescription: body, location: 'Baden' } });
      if (u.includes('R-10002')) return json({ jobPostingInfo: { title: 'Spontanbewerbung Pflege', jobDescription: '<p>Jetzt bewerben</p>', location: 'Baden' } });
      return new Response('not found', { status: 404 });
    }));

    const jobs = await fetchAllKsbJobs();

    expect(jobs).toHaveLength(1);
    expect(jobs[0].title).toBe('Dipl. Pflegefachperson Intensivpflege 80-100%');
    expect(jobs[0].description).toContain('• Betreuung von kritisch kranken Patientinnen und Patienten');
    expect(jobs[0].description).toContain('The KSB provides safe and close to home healthcare');
    expect(jobs[0].sourceLang).toBe('de');
    for (const job of jobs) expect(job.description).not.toContain('Key details');
  });
});
