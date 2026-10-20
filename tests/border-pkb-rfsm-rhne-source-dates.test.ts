import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchPkbJobUrls, fetchPkbDetailPage, buildPkbJob } from '../scripts/lib/pkb-private-bank-job-parser.mjs';
import { fetchAllRfsmFribourgJobs } from '../scripts/lib/rfsm-fribourg-job-parser.mjs';
import { fetchAllRhneJobs } from '../scripts/lib/rhne-reseau-hospitalier-neuchatelois-job-parser.mjs';
const unknown = { datePosted: '', postedDate: '', postingDateSource: 'unknown' };
const reported = (value: string) => ({ datePosted: value, postedDate: value.slice(0, 10), postingDateSource: 'reported' });
afterEach(() => vi.unstubAllGlobals());

describe('PKB runner discovery/detail/builder contract', () => {
  it.each([
    { raw: '15/06/2020', expected: reported('2020-06-15') },
    { raw: '2020-06-15T10:11:12+02:00', expected: reported('2020-06-15T10:11:12+02:00') },
    { raw: '', expected: unknown },
    { raw: '30/02/2020', expected: unknown },
    { raw: '15/06/20200', expected: unknown },
    { raw: '15/06/2020junk', expected: unknown },
    { raw: '15/06/2999', expected: unknown },
  ])('attests only the whole publication field $raw', async ({ raw, expected }) => {
    const listing = '<div class="singleResult responsiveOnly" role="listitem"><a href="../job/view-job.php?id=123&language=it"><h3>Compliance Officer</h3></a><span class="citySpan">Lugano</span><span class="date">01/01/2020 - 01/01/2021</span></div><footer>end</footer>';
    const detail = `<h1 itemprop="title">Compliance Officer</h1><span itemprop="datePosted">${raw}</span><span itemprop="validThrough">01/01/2020</span><div itemprop="description">Official bank role involving compliance checks and reporting to the relevant teams in Lugano.</div>`;
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => new Response(String(url).includes('jobs.php') ? listing : detail)));
    const rows = await fetchPkbJobUrls();
    expect(rows.jobs).toHaveLength(1);
    const parsed = await fetchPkbDetailPage(rows.jobs[0].url);
    expect(parsed).not.toBeNull();
    const result = buildPkbJob(rows.jobs[0].url, parsed);
    expect(result).toMatchObject({ ...expected, companyKey: 'pkb-private-bank', title: 'Compliance Officer' });
  });
});

describe('RHNE scoped explicit publication through builder', () => {
  it.each([
    { raw: '15.06.2020', expected: reported('2020-06-15') },
    { raw: '5.6.2020', expected: reported('2020-06-05') },
    { raw: '2020-06-15T10:11:12+02:00', expected: reported('2020-06-15T10:11:12+02:00') },
    { raw: '', expected: unknown },
    { raw: '30.02.2020', expected: unknown },
    { raw: '15.06.20200', expected: unknown },
    { raw: '15.06.2020junk', expected: unknown },
    { raw: '15.06.2999', expected: unknown },
  ])('ignores decoy date and validates $raw', async ({ raw, expected }) => {
    const listing = '<a href="/espace-emploi/emploi/postuler/tous-les-postes?jobId=123456&cat=all" class="jobLink">Infirmier RHNE</a>';
    const detail = `<section id="portlet_decoy"><div class="portlet-body">Date de publication: 01.01.2020</div></section><section id="portlet_rhne_web_jobup_RHNeWebJobupPortlet_test"><div class="portlet-body"><h1 class="titlepage">Infirmier RHNE</h1><p class="date">Date de publication: ${raw}</p><div style="text-align: justify"><p>Soins spécialisés et accompagnement des patients au sein de notre équipe hospitalière.</p></div></div></section>`;
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => new Response(String(url).includes('jobId=') ? detail : listing)));
    const jobs = await fetchAllRhneJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ ...expected, title: 'Infirmier RHNE' });
  });
});

it.each(['', '<span data-careersite-propertyid="createdDate">2020-06-15</span><span>Dernière mise à jour: 2020-06-15</span>'])('RFSM has unknown publication despite non-publication metadata %s', async (metadata) => {
  const listing = '<a href="/job/Infirmier-RFSM-Marsens/123456789/">Infirmier RFSM Marsens</a><a href="/job/Enseignant/123456780/">Enseignant primaire</a>';
  const detail = `<span data-careersite-propertyid="title">Infirmier RFSM Marsens</span><span data-careersite-propertyid="location">Marsens</span><span class="jobdescription">Prise en charge des patients en soins psychiatriques.</span>${metadata}`;
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => new Response(String(url).includes('/search/') ? listing : detail)));
  const jobs = await fetchAllRfsmFribourgJobs();
  expect(jobs).toHaveLength(1);
  expect(jobs[0]).toMatchObject({ ...unknown, title: 'Infirmier RFSM Marsens', canton: 'FR' });
});
