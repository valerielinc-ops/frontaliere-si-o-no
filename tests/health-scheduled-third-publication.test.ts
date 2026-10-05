import { afterEach, describe, expect, it, vi } from 'vitest';
import { jsPDF } from 'jspdf';
import { fetchAllCliniqueLaSourceJobs } from '../scripts/lib/clinique-la-source-job-parser.mjs';
import { fetchAllCsBregagliaJobs } from '../scripts/lib/cs-bregaglia-job-parser.mjs';
import { fetchAllCsvmMustairJobs } from '../scripts/lib/csvm-mustair-job-parser.mjs';
import { fetchAllCsvpPoschiavoJobs } from '../scripts/lib/csvp-poschiavo-job-parser.mjs';
import { fetchAllErgolzKlinikJobs } from '../scripts/lib/ergolz-klinik-job-parser.mjs';
import { parseErecruitRss, fetchErecruitDetail } from '../scripts/lib/erecruit-common.mjs';
const now = new Date();
const day = new Date(now.getTime() - 7 * 86400000);
const rss = day.toUTCString();
const past = day.toISOString().replace(/\.\d{3}Z$/, 'Z');
const future = new Date(now.getTime() + 7 * 86400000).toUTCString();
const body = 'La nostra clinica cerca personale qualificato per assistere i pazienti e collaborare con il gruppo multidisciplinare nelle cure quotidiane. '.repeat(5);
const pdf = () => { const doc = new jsPDF(); doc.setCreationDate(now); doc.text(doc.splitTextToSize(body + ' Entrata da concordare. Scadenza ' + past, 175), 15, 20); return doc.output('arraybuffer'); };
const response = (text: string) => new Response(text, { status: 200 });
const cases = [['reported', rss, past], ['missing', '', ''], ['invalid', 'bad', ''], ['future', future, ''], ['invalid calendar', `30 Feb ${now.getUTCFullYear()-1} 12:00:00 GMT`, '']] as const;
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
for (const [source, producer] of [['lasource', fetchAllCliniqueLaSourceJobs], ['bregaglia', fetchAllCsBregagliaJobs]] as const) describe(`${source} RSS publication`, () => {
  it.each(cases)('%s through the real producer and detail', async (_name, raw, expected) => {
    const transport = vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes('rss')) return response(`<rss><channel><item><title>Infermiere</title><JobID>42</JobID><link>https://${source === 'lasource' ? 'emploi.lasource.ch/?page=advertisement_display&amp;id=42' : 'www.csbregaglia.ch/offerta/42'}</link><pubDate>${raw}</pubDate><description>${body}</description></item></channel></rss>`);
      return response(source === 'lasource' ? `<div class="title-container"><h2>Infermiere</h2></div><div id="advert">${body}</div></main>` : `<article class="uk-article"><h1>Infermiere</h1><p>${body}</p></article>`);
    });
    vi.stubGlobal('fetch', transport);
    const jobs = await producer(); expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ postedDate: expected, datePosted: expected, postingDateSource: expected ? 'reported' : 'unknown' });
    expect(jobs[0].description).toContain('La nostra clinica'); expect(jobs[0].applyUrl).toBeTruthy(); expect(jobs[0].id).toBeTruthy();
    expect(transport).toHaveBeenCalledTimes(2);
  });
});

describe('CSVM vacancy-scoped BlogPosting publication', () => {
  const localDay = `${String(day.getUTCDate()).padStart(2,'0')}.${String(day.getUTCMonth()+1).padStart(2,'0')}.${day.getUTCFullYear()}`;
  it.each([[localDay, day.toISOString().slice(0,10)], ['', ''], ['bad',''], [`30.02.${now.getUTCFullYear()-1}`, ''], ['01.01.'+(now.getUTCFullYear()+1), '']] as const)('validates %s without borrowing neighbour publication', async (raw, expected) => {
    const bytes = pdf();
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      return url.endsWith('.pdf') ? new Response(bytes, { status: 200, headers: { 'content-type': 'application/pdf' } }) : response(`<div itemprop="blogPosts"><a href="/de/aktuelles/pflegefachperson.html">Pflegefachperson</a><div itemprop="datePublished" content="${raw}"></div><a href="/images/easyblog_articles/job.pdf">PDF</a></div><div itemprop="blogPosts"><a href="/de/aktuelles/neue-website.html">Neue Website</a><div itemprop="datePublished" content="${localDay}"></div></div>`);
    }));
    const jobs = await fetchAllCsvmMustairJobs(); expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ postedDate: expected, datePosted: expected, postingDateSource: expected ? 'reported' : 'unknown' });
    expect(jobs[0].description).toContain('La nostra clinica'); expect(jobs[0].canton).toBe('GR');
  });
});

for (const [source, producer] of [['poschiavo', fetchAllCsvpPoschiavoJobs], ['ergolz', fetchAllErgolzKlinikJobs]] as const) it(`${source} PDF metadata and page update are not publication`, async () => {
  const bytes = pdf();
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith('.pdf')) return new Response(bytes, { status: 200, headers: { 'content-type': 'application/pdf' } });
    const listing = source === 'poschiavo' ? `<article><h1><a href="/it/lavora-con-noi/cerchiamo/infermiere">Infermiere</a></h1><p>${body}</p><a href="/images/job.pdf">PDF</a></article>` : '<h2>Pflegefachperson</h2><a href="https://ergolz.cardiance.com/uploads/pflege.pdf">PDF</a>';
    return response(listing + `<script type="application/ld+json">${JSON.stringify({ '@type':'WebPage', datePublished:past,dateModified:past })}</script>`);
  }));
  const jobs = await producer(); expect(jobs).toHaveLength(1);
  expect(jobs[0]).toMatchObject({ postedDate:'',datePosted:'',postingDateSource:'unknown' });
  expect(jobs[0].description).toContain('La nostra clinica'); expect(jobs[0].applyUrl).toBeTruthy();
});

it('eRecruit default callers retain their legacy shape', async () => {
  expect(parseErecruitRss('<item><JobID>42</JobID><link>https://emploi.lasource.ch/job</link><pubDate>'+rss+'</pubDate></item>')).toEqual([{id:'42',link:'https://emploi.lasource.ch/job'}]);
  vi.stubGlobal('fetch', vi.fn(async () => response('<div class="title-container"><h2>Infirmier</h2></div><div id="advert">'+body+'</div></main>')));
  const detail = await fetchErecruitDetail('https://emploi.lasource.ch/job');
  if (!detail) throw new Error('Expected existing eRecruit detail');
  expect(Object.keys(detail).sort()).toEqual(['description','title']);
});

it('La Source detail publication survives an invalid feed candidate', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    return response(url.includes('rss') ? '<item><JobID>42</JobID><link>https://emploi.lasource.ch/job</link><pubDate>invalid</pubDate></item>' : `<script type="application/ld+json">${JSON.stringify({'@type':'JobPosting',datePosted:past})}</script><div class="title-container"><h2>Infirmier</h2></div><div id="advert">${body}</div></main>`);
  }));
  const [job] = await fetchAllCliniqueLaSourceJobs(); expect(job).toMatchObject({postedDate:past,datePosted:past,postingDateSource:'reported'});
});
