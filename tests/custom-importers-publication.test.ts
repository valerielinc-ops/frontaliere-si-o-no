import { afterEach, expect, it, vi } from 'vitest';
import { fetchAllKuhnRikonJobs } from '../scripts/lib/kuhn-rikon-job-parser.mjs';
import { fetchAllBkwJobs } from '../scripts/lib/bkw-job-parser.mjs';
import { fetchAllConcordiaJobs } from '../scripts/lib/concordia-job-parser.mjs';
import { fetchAllPblJobs } from '../scripts/lib/pbl-job-parser.mjs';
import { fetchAllTransgourmetJobs } from '../scripts/lib/transgourmet-job-parser.mjs';
const body = 'Wir suchen eine qualifizierte Fachperson für die Betreuung unserer Kunden und die Zusammenarbeit im engagierten Team. '.repeat(8);
const uuid = '00000000-0000-4000-8000-000000000000';
afterEach(() => vi.unstubAllGlobals());
for (const [name, producer] of [['Kuhn', fetchAllKuhnRikonJobs], ['BKW', fetchAllBkwJobs], ['Concordia', fetchAllConcordiaJobs], ['PBL', fetchAllPblJobs]] as const) {
  for (const kind of ['valid', 'missing', 'invalid', 'future'] as const) {
    it(`${name}: original detail publication ${kind}`, async () => {
      const year = new Date().getUTCFullYear() - 1;
      const raw = kind === 'valid' ? `${year}-06-15T13:00:00+02:00` : kind === 'invalid' ? `${year}-02-30T12:00:00Z` : kind === 'future' ? new Date(Date.now() + 3600000).toISOString() : undefined;
      const ld = { '@type': 'JobPosting', title: 'Fachperson Beratung', description: body, datePosted: raw, dateCreated: `${year}-01-01`, jobLocation: { address: { addressCountry: 'Schweiz', addressLocality: 'Bern', postalCode: '3000', addressRegion: 'BE' } } };
      const html = `<html lang="de"><h1>Fachperson Beratung</h1><script type="application/ld+json">${JSON.stringify(ld)}</script><section id="topTitleArea">${body}</section></html>`;
      const detail = name === 'Kuhn' ? 'https://my.jobalino.ch/job/abcdef123456/fachperson' : name === 'BKW' ? `https://job.bkw.com/offene-stellen/fachperson/${uuid}` : name === 'Concordia' ? `https://jobs.concordia.ch/offene-stellen/fachperson/${uuid}` : `https://jobs.pbl.ch/offene-stellen/fachperson/${uuid}`;
      const listing = name === 'Kuhn'
        ? `jb_ShowJsonHtml(${JSON.stringify({ error: '', html: `<a href="${detail}" class="reflink"><span class="title">Fachperson Beratung</span><span class="city">Bern</span><span class="zip">3000</span><span class="country">Schweiz</span></a>` })}, 'kuhn-rikon');`
        : name === 'BKW' ? `<a id="job-123" href="${detail}" title="Fachperson Beratung" data-location="Bern" data-workload="100%"></a>`
        : name === 'Concordia' ? `<div class="total-jobs">1 Jobs</div><a href="${detail}">Fachperson Beratung</a>`
        : `<a class="job-title" href="${detail}" title="Fachperson Beratung">Fachperson Beratung<p class="job-meta">Liestal</p></a>`;
      const fetchPage = async (url: string) => url === detail ? html : listing;
      vi.stubGlobal('fetch', vi.fn(async (url) => new Response(await fetchPage(String(url)), { status: 200 })));
      const jobs = name === 'Concordia' ? await fetchAllConcordiaJobs({ fetchPage, delayMs: 0 }) : await producer();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject(kind === 'valid' ? { datePosted: raw, postedDate: raw, postingDateSource: 'reported' } : { datePosted: '', postedDate: '', postingDateSource: 'unknown' });
      expect(jobs[0].description).toContain('engagierten Team');
      expect(jobs[0].crawledAt).toBeTruthy();
    });
  }
}
for (const kind of ['unverified-start', 'missing', 'modified-only', 'invalid', 'future']) {
  it(`Transgourmet: unverified listing field stays unknown (${kind})`, async () => {
    const year = new Date().getUTCFullYear() - 1;
    const raw = kind === 'unverified-start' ? `${year}-06-15T13:00:00+02:00` : kind === 'invalid' ? `${year}-02-30` : kind === 'future' ? new Date(Date.now() + 3600000).toISOString() : undefined;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ jobs: [{ start_date: raw, last_modification_timestamp: `${year}-07-01`, links: { directlink: 'https://jobs.transgourmet.ch/fixture' }, szas: { sza_title: 'Fachperson Beratung', sza_introduction: body, 'sza_workplace.city': 'Bern', 'sza_workplace.region': 'BE' } }], total: 1 }), { status: 200 })));
    const jobs = await fetchAllTransgourmetJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ datePosted: '', postedDate: '', postingDateSource: 'unknown' });
    expect(jobs[0].crawledAt).toBeTruthy();
  });
}
