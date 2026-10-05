import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAllGeberitJobs } from '../scripts/lib/geberit-job-parser.mjs';
const text='Unser Team entwickelt zuverlässige Systeme durch sorgfältige Planung Prüfung Dokumentation Zusammenarbeit und Unterstützung unserer Kunden sowie Kolleginnen und Kollegen. '.repeat(6);
const timestamp=`${new Date(Date.now()-5*86400000).toISOString().slice(0,10)}T12:34:56+02:00`;
function record(datePosted: unknown, language='de_DE') {
  return {jobId:`123-${language}`,language,title:'Systems Engineer',description:`<p>${text}</p>`,datePosted,createdAt:timestamp,updatedAt:timestamp,
    addresses:[{country:'Deutschland',city:'Berlin',postalCode:'10115'},{country:'Schweiz',city:'Rapperswil-Jona',postalCode:'8645',street:'Schachenstrasse 77'}],link:`https://jobs.geberit.com/job-invite/123/?locale=${language}`};
}
function setup(records:unknown[]){vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({'@odata.count':records.length,value:records}),{headers:{'Content-Type':'application/json'}})));}
afterEach(()=>vi.unstubAllGlobals());
describe('Geberit RMK source publication dates',()=>{
  for(const [name,raw] of [['timestamp',timestamp],['day',timestamp.slice(0,10)],['missing',undefined],['invalid','2026-02-30T12:00:00Z'],['future',new Date(Date.now()+10*86400000).toISOString()]]){
    it(`${name}: validates the complete explicit datePosted without crawl fallback`,async()=>{
      setup([record(raw)]);
      const jobs=await fetchAllGeberitJobs();
      expect(jobs).toHaveLength(1);
      const expected=name==='timestamp'?timestamp:name==='day'?timestamp.slice(0,10):'';
      expect(jobs[0]).toMatchObject({id:'geberit-123',datePosted:expected,postedDate:expected,postingDateSource:expected?'reported':'unknown',canton:'SG',addressLocality:'Rapperswil-Jona',postalCode:'8645'});
      expect(jobs[0].description.split(/\s+/).length).toBeGreaterThan(50);
    });
  }
  it('keeps the preferred German record unknown instead of borrowing the English variant date',async()=>{
    setup([record(timestamp,'en_US'),record(undefined,'de_DE')]);
    const jobs=await fetchAllGeberitJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({sourceLang:'de',datePosted:'',postedDate:'',postingDateSource:'unknown'});
    expect(jobs[0].url).toContain('locale=de_DE');
  });
});
