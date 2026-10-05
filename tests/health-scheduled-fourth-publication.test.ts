import { afterEach, describe, expect, it, vi } from 'vitest';
import { jsPDF } from 'jspdf';
import { fetchAllFmiJobs } from '../scripts/lib/fmi-job-parser.mjs';
import { fetchAllForelKlinikJobs } from '../scripts/lib/forel-klinik-job-parser.mjs';
import { fetchAllGzoWetzikonJobs } from '../scripts/lib/gzo-wetzikon-job-parser.mjs';
import { fetchAllFluryStiftungJobs } from '../scripts/lib/flury-stiftung-job-parser.mjs';
const now = new Date();
const past = new Date(now.getTime()-7*86400000).toISOString();
const future = new Date(now.getTime()+7*86400000).toISOString();
const body = 'Unsere Klinik sucht qualifizierte Pflegefachpersonen für die interdisziplinäre Zusammenarbeit und professionelle Betreuung unserer Patientinnen und Patienten. '.repeat(7);
const ld = (raw: unknown) => `<script type="application/ld+json">${JSON.stringify({'@type':'JobPosting',title:'Pflegefachperson',description:body,datePosted:raw,validThrough:past,jobStartDate:past})}</script>`;
const cases = [['reported',past,past],['missing',undefined,''],['invalid','bad',''],['future',future,''],['invalidcalendar',`${now.getUTCFullYear()-1}-02-30`,'']] as const;
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();});
for (const [source,producer] of [['fmi',fetchAllFmiJobs],['forel',fetchAllForelKlinikJobs],['gzo',fetchAllGzoWetzikonJobs]] as const) describe(`${source} detail publication`,()=>{
 it.each(cases)('%s keeps job without promoting start or booking fields',async(_name,raw,expected)=>{
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(now);
  const transport=vi.fn(async(input:RequestInfo|URL)=>{
   const url=input instanceof Request?input.url:String(input);let html='';
   if(source==='fmi')html=url.includes('fmi.prospective')?'<a class="job" href="https://jobs.spitalfmi.ch/offene-stellen/pflege/42"><div class="jobTitle"><span>Pflege</span><h2>Pflegefachperson</h2></div><div class="jobArbeitsOrt">Interlaken</div><div class="mehrErfahren"></div></a>':ld(raw);
   if(source==='forel')html=url.includes('/detail')?`${ld(raw)}<div class="advertisementResponsibilitiesText">${body}</div>`:'<a class="jobElement" data-eventData="{&quot;startDate&quot;:&quot;ab sofort&quot;,&quot;location&quot;:&quot;Ellikon an der Thur&quot;}" href="w1f713hy/e92babc9-d7a7-43ad-90f7-d07c64aae4f0/detail?lang=DE"><span class="jobName">Pflegefachperson</span></a>';
   if(source==='gzo'){
    if(url.endsWith('/widget'))return new Response(JSON.stringify({success:true,data:[{job_title:'Pflegefachperson',job_detail_url:'https://www.publicjobs.ch/jobs/~job42',org_name:'GZO Spital Wetzikon',org_city:'Wetzikon ZH',job_booking_start:'01.01.'+(now.getUTCFullYear()-1),job_start_date:past}]}),{status:200});
    html=`${ld(raw)}<div id="template_preview_job_description">${body}</div>`;
   }
   return new Response(html,{status:200});
  });vi.stubGlobal('fetch',transport);
  const jobs=await producer();expect(jobs).toHaveLength(1);
  expect(jobs[0]).toMatchObject({postedDate:expected,datePosted:expected,postingDateSource:expected?'reported':'unknown'});
  expect(jobs[0].description).toContain('Unsere Klinik');expect(jobs[0].id).toBeTruthy();expect(jobs[0].slug).toBeTruthy();expect(jobs[0].applyUrl).toMatch(/^https:\/\//);expect(Date.parse(jobs[0].crawledAt)).toBe(now.getTime());expect(transport).toHaveBeenCalledTimes(2);
  if(source==='forel')expect(jobs[0].description).toContain('ab sofort');
 });
});
it('Flury preserves PDF body but never promotes PDF creation or deadlines',async()=>{
 const doc=new jsPDF();doc.setCreationDate(now);doc.text(doc.splitTextToSize(body+' Bewerbungsschluss '+past+' Eintritt '+future,175),15,20);const bytes=doc.output('arraybuffer');
 vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL)=>{
  const url=input instanceof Request?input.url:String(input);
  return url.endsWith('.pdf')?new Response(bytes,{status:200,headers:{'content-type':'application/pdf'}}):new Response('<div class="table-responsive"><caption>Spital Schiers</caption><span class="file file--mime-application-pdf"><a href="/sites/default/files/pflege.pdf" type="application/pdf">Pflegefachperson</a></span></div>',{status:200});
 }));
 const jobs=await fetchAllFluryStiftungJobs({delayMs:0});expect(jobs).toHaveLength(1);
 expect(jobs[0]).toMatchObject({postedDate:'',datePosted:'',postingDateSource:'unknown'});expect(jobs[0].description).toContain('Unsere Klinik');expect(jobs[0].applyUrl).toContain('pflege.pdf');
});
