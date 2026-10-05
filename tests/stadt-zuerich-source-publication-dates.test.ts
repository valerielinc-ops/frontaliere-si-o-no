import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAllStadtZuerichJobs } from '../scripts/lib/stadt-zuerich-job-parser.mjs';
const body = 'Wir arbeiten gemeinsam an zuverlässigen öffentlichen Dienstleistungen und unterstützen die Bevölkerung durch sorgfältige Planung Entwicklung Dokumentation Prüfung und Zusammenarbeit. '.repeat(6);
const date = `${new Date(Date.now()-5*86400000).toISOString().slice(0,10)}T12:34:56+02:00`;
function tile(ref: string, unit = 'Stadtkanzlei') {
  return `<li class="job-tile job-id-${ref}" data-url="/job/Engineer/${ref}/"><a class="jobTitle-link">Engineer ${ref}</a><div class="customfield1-value">Präsidialdepartement</div><div class="customfield2-value">${unit}</div><div class="adcode-value">${ref}</div></li>`;
}
function page(ref: string, raw: unknown) {
  return `<script type="application/ld+json">${JSON.stringify({ '@type':'JobPosting',url:`https://www.stadt-zuerich.ch/job-detailseite.${ref}.html`,title:`Engineer ${ref}`,datePosted:raw })}</script><stzh-pagecontent><stzh-richtext>Referenz-Nr.: ${ref}<p>${body}</p></stzh-richtext></stzh-pagecontent>`;
}
function setup(raw: unknown, options: {otherRef?: boolean; unit?: string} = {}) {
  vi.stubEnv('JOBS_CRAWLER_DELAY_MS','1');
  vi.stubGlobal('fetch',vi.fn(async (url: string) => new Response(String(url).includes('jobs.stadt-zuerich.ch/search/')
    ? tile('12345',options.unit)
    : String(url).includes('/stzh/jobsearch?')
      ? JSON.stringify({results:[{href:'/job-detailseite.12345.html',meta:['Stadtkanzlei']}]})
      : page(options.otherRef ? '67890' : '12345',raw), {headers:{'Content-Type':'text/html'}})));
}
afterEach(() => {vi.unstubAllGlobals();vi.unstubAllEnvs();});
describe('Stadt Zürich consumer publicationByRef opt-in', () => {
  for (const [name,raw] of [['timestamp',date],['missing',undefined],['invalid','2026-02-30T12:00:00Z'],['future',new Date(Date.now()+10*86400000).toISOString()]]) {
    it(`${name}: propagates the official ad tuple for the same reference`,async () => {
      setup(raw);
      const jobs=await fetchAllStadtZuerichJobs();
      expect(jobs).toHaveLength(1);
      const expected=name==='timestamp'?date:'';
      expect(jobs[0]).toMatchObject({title:'Engineer 12345',datePosted:expected,postedDate:expected,postingDateSource:expected?'reported':'unknown',canton:'ZH'});
      expect(jobs[0].description.split(/\s+/).length).toBeGreaterThan(50);
      expect(jobs[0].url).toContain('/12345/');
    });
  }
  it('does not borrow another reference ad text or publication date',async () => {
    setup(date,{otherRef:true});
    expect(await fetchAllStadtZuerichJobs()).toEqual([]);
  });
  it('keeps the dedicated Stadtspital exclusion',async () => {
    setup(date,{unit:'Stadtspital Zürich'});
    expect(await fetchAllStadtZuerichJobs()).toEqual([]);
  });
});
