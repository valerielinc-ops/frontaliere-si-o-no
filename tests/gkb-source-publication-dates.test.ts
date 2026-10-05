import { describe, expect, it } from 'vitest';
import { fetchAllGkbJobs, LISTING_URLS } from '../scripts/lib/gkb-job-parser.mjs';
const day=new Date(Date.now()-5*86400000).toISOString().slice(0,10);
const swiss=(d:string)=>d.split('-').reverse().join('.');
const body='Wir unterstützen unsere Kundinnen und Kunden mit sorgfältiger Beratung und Planung und arbeiten gemeinsam an zuverlässigen Dienstleistungen sowie einer hohen Qualität. '.repeat(6);
function row(raw:string,id='1234'){return `<tr class="tableaslist_contentrow1"><td><a href="/Vacancies/${id}/Description/1">Kundenberater ${id}</a><span class="tableaslist_element_1152495">Hauptsitz Chur</span><span class="tableaslist_element_1152487">${raw}</span></td></tr>`;}
function runtime(first:string,second=first){return {fetchImpl:async(url:string)=>new Response(LISTING_URLS.includes(url)?`<table>${url===LISTING_URLS[0]?first:second}</table>`:`<div class="customdatablock">${body}</div>`,{headers:{'Content-Type':'text/html'}}),retries:0};}
describe('GKB same-row Online seit publication evidence',()=>{
  for(const [name,raw] of [['valid',`Online seit: ${swiss(day)}`],['missing',''],['invalid','Online seit: 30.02.2026'],['future',`Online seit: ${swiss(new Date(Date.now()+10*86400000).toISOString().slice(0,10))}`],['suffix',`Online seit: ${swiss(day)}junk`],['unlabelled',swiss(day)]]){
    it(`${name}: validates labelled complete date`,async()=>{
      const jobs=await fetchAllGkbJobs(runtime(row(raw)));
      expect(jobs).toHaveLength(1);
      const expected=name==='valid'?day:'';
      expect(jobs[0]).toMatchObject({datePosted:expected,postedDate:expected,postingDateSource:expected?'reported':'unknown',canton:'GR'});
      expect(jobs[0].description.split(/\s+/).length).toBeGreaterThan(50);
      expect(jobs[0].url).toContain('/Vacancies/1234/');
    });
  }
  it('atomically recovers verified evidence from the second view of the same vacancy',async()=>{
    const jobs=await fetchAllGkbJobs(runtime(row(''),row(`Online seit: ${swiss(day)}`)));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({datePosted:day,postedDate:day,postingDateSource:'reported'});
  });
  it('does not copy a neighbouring vacancy date into a missing-date row',async()=>{
    const jobs=await fetchAllGkbJobs(runtime(row('','1234')+row(`Online seit: ${swiss(day)}`,'5678')));
    expect(jobs).toHaveLength(2);
    expect(jobs.find(j=>j.url.includes('/1234/'))).toMatchObject({datePosted:'',postedDate:'',postingDateSource:'unknown'});
    expect(jobs.find(j=>j.url.includes('/5678/'))).toMatchObject({datePosted:day,postedDate:day,postingDateSource:'reported'});
  });
});
