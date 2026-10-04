import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAllCsebJobs } from '../scripts/lib/cseb-job-parser.mjs';
const body='Wir unterstützen unsere Patientinnen und Patienten durch fachgerechte Pflege sorgfältige Planung Dokumentation und Zusammenarbeit mit dem medizinischen Team und den Angehörigen. '.repeat(5);
const date=`${new Date(Date.now()-5*86400000).toISOString().slice(0,10)}T12:34:56+02:00`;
function publication(raw:unknown,id='one') {return {JobId:id,PublicationId:`publication-${id}`,JobTitle:`Pflegefachperson ${id}`,Introduction:`<p>${body}</p>`,PlaceOfWorkCity:'Scuol',PublicationStartDate:raw,CreatedDate:date,ModifiedDate:date,EmploymentStartDate:date,PublicationUrlAbacusJobPortal:`https://jobs.cseb.ch/job-advertisement/portal/${id}`};}
function setup(records:unknown[]){vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify(records),{headers:{'Content-Type':'application/json'}})));}
afterEach(()=>vi.unstubAllGlobals());
describe('CSEB corroborated Abacus publication start',()=>{
  for(const [name,raw] of [['timestamp',date],['day',date.slice(0,10)],['missing',undefined],['invalid','2026-02-30'],['future',new Date(Date.now()+10*86400000).toISOString()]]){
    it(`${name}: uses only validated publication start`,async()=>{
      setup([publication(raw)]);
      const jobs=await fetchAllCsebJobs();
      expect(jobs).toHaveLength(1);
      const expected=name==='timestamp'?date:name==='day'?date.slice(0,10):'';
      expect(jobs[0]).toMatchObject({datePosted:expected,postedDate:expected,postingDateSource:expected?'reported':'unknown',canton:'GR',location:'Scuol'});
      expect(jobs[0].description.split(/\s+/).length).toBeGreaterThan(50);
      expect(jobs[0].url).toBe('https://jobs.cseb.ch/job-advertisement/portal/one');
    });
  }
  it('keeps neighbouring publication identities and dates separate',async()=>{
    setup([publication(undefined,'unknown'),publication(date,'reported')]);
    const jobs=await fetchAllCsebJobs();
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({postedDate:'',datePosted:'',postingDateSource:'unknown'});
    expect(jobs[1]).toMatchObject({postedDate:date,datePosted:date,postingDateSource:'reported'});
    expect(jobs[0].id).not.toBe(jobs[1].id);
  });
});
