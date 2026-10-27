import { afterEach, describe, expect, it, vi } from 'vitest';
import { jsPDF } from 'jspdf';
import { fetchAllCantonTicinoOscJobs } from '../scripts/lib/canton-ticino-osc-job-parser.mjs';
import { fetchAllCdsSavogninJobs } from '../scripts/lib/cds-savognin-job-parser.mjs';
import { fetchAllCereneoJobs } from '../scripts/lib/cereneo-job-parser.mjs';
import { fetchAllClinicaHildebrandJobs } from '../scripts/lib/clinica-hildebrand-job-parser.mjs';
import { fetchAllClinicaVariniJobs } from '../scripts/lib/clinica-varini-job-parser.mjs';

const now = new Date();
const past = new Date(now.getTime() - 7 * 86400000).toISOString();
const future = new Date(now.getTime() + 7 * 86400000).toISOString();
const body = 'La nostra clinica cerca personale qualificato per assistere i pazienti e collaborare con il gruppo multidisciplinare nelle cure quotidiane. '.repeat(5);
const ld = (raw: unknown) => `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', datePosted: raw, validThrough: past, dateModified: past, jobStartDate: past })}</script>`;
const cases: ReadonlyArray<readonly [string, unknown, string]> = [['reported', past, past], ['missing', undefined, ''], ['invalid', 'bad', ''], ['future', future, ''], ['invalid calendar', `${now.getUTCFullYear() - 1}-02-30`, '']];
const sources = [['osc', fetchAllCantonTicinoOscJobs], ['cds', fetchAllCdsSavogninJobs], ['cereneo', fetchAllCereneoJobs]] as const;
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });
for (const [source, producer] of sources) describe(`${source} same-detail publication`, () => {
  it.each(cases)('%s preserves source record without clock inference', async (_name, raw, expected) => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now);
    const transport = vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      let html = '';
      if (source === 'osc') html = url.includes('?yid=') ? `${ld(raw)}<h2>Dipartimento della sanità e della socialità</h2><h2>1/26</h2><h2>Infermiere OSC Mendrisio</h2><p>${body}</p><h2>Scadenza</h2><p>${past}</p>` : `<a href="https://www.concorsi.ti.ch/offerte-d'impieghi.html?yid=1">Infermiere OSC</a>`;
      if (source === 'cds') html = url.includes('/aktuelles/') ? `${ld(raw)}<h3 id="subtitle_DE:123:text">Pflegefachperson</h3><div id="text1_DE:123:text:idtext">${body}</div><div id="text2_DE:123:text:idtext">Eintritt ${past}</div>` : `<div class="news-item"><h4>Pflegefachperson</h4><div>${body}</div><a class="mehrlesen" href="/DE/aktuelles/123.html">Mehr</a></div>`;
      if (source === 'cereneo') html = url.includes('/detail') ? `${ld(raw)}<div class="advertisementResponsibilitiesText">${body}</div>` : `<a class="jobElement" data-eventData="{&quot;startDate&quot;:&quot;ab sofort&quot;,&quot;location&quot;:&quot;cereneo Schweiz AG - Vitznau&quot;}" href="muy5swcr/e92babc9-d7a7-43ad-90f7-d07c64aae4f0/detail?lang=DE"><span class="jobName">Pflegefachperson</span></a>`;
      return new Response(html, { status: 200 });
    });
    vi.stubGlobal('fetch', transport);
    const jobs = await producer(); expect(jobs).toHaveLength(1);
    const job = jobs[0];
    expect(job).toMatchObject({ postedDate: expected, datePosted: expected, postingDateSource: expected ? 'reported' : 'unknown' });
    expect(job.description).toContain('La nostra clinica'); expect(job.id).toBeTruthy(); expect(job.slug).toBeTruthy();
    expect(job.url).toMatch(/^https:\/\//); expect(job.applyUrl).toMatch(/^https:\/\//);
    expect(Date.parse(job.crawledAt)).toBe(now.getTime()); expect(transport).toHaveBeenCalledTimes(2);
    if (source === 'cereneo') expect(job.description).toContain('ab sofort');
  });
});

describe('OSC official listing transport fallback', () => {
  it('recovers OSC detail ids from the official Canton Ticino page after a portal connection failure', async () => {
    vi.stubEnv('JOBS_CRAWLER_RETRIES', '0');
    vi.stubEnv('JOBS_CRAWLER_RETRY_BASE_MS', '0');
    vi.stubEnv('JOBS_JINA_RETRIES', '0');
    vi.stubEnv('JOBS_JINA_RETRY_BASE_MS', '0');
    const officialUrl = 'https://www4.ti.ch/index.php?id=147427';
    const officialHtml = `
      <h1>Concorsi generali nell'Amministrazione cantonale</h1>
      <p>www.concorsi.ti.ch</p>
      <div class="ce-bodytext">
        <p>no. 1/26</p>
        <p><strong>Concorso generale Infermiere presso Organizzazione Sociopsichiatrica Cantonale (OSC), Mendrisio</strong></p>
        <p>Scadenza: 31.12.2026</p>
        <a href="https://www.concorsi.ti.ch/offerte-d'impieghi.html?yid=1">Vai al concorso</a>
      </div>`;
    const transport = vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === 'https://www.concorsi.ti.ch/') {
        const error = new TypeError('fetch failed');
        error.cause = { code: 'ENOTFOUND' };
        throw error;
      }
      if (url.startsWith('https://r.jina.ai/')) return new Response('', { status: 502 });
      if (url === officialUrl) return new Response(officialHtml, { status: 200 });
      if (url.includes("offerte-d'impieghi.html?yid=1")) {
        return new Response(`${ld(past)}<h2>Dipartimento della sanità e della socialità</h2><h2>1/26</h2><h2>Infermiere OSC Mendrisio</h2><p>${body}</p><h2>Scadenza</h2><p>${past}</p>`, { status: 200 });
      }
      return new Response('', { status: 404 });
    });
    vi.stubGlobal('fetch', transport);

    const jobs = await fetchAllCantonTicinoOscJobs();

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ companyKey: 'canton-ticino-osc', title: 'Infermiere OSC Mendrisio' });
    expect(transport.mock.calls.some(([url]) => String(url) === officialUrl)).toBe(true);
  });

  it('uses the shared Google Translate egress when the official page is unreachable too', async () => {
    vi.stubEnv('JOBS_CRAWLER_RETRIES', '0');
    vi.stubEnv('JOBS_CRAWLER_RETRY_BASE_MS', '0');
    vi.stubEnv('JOBS_JINA_RETRIES', '0');
    vi.stubEnv('JOBS_JINA_RETRY_BASE_MS', '0');
    const officialUrl = 'https://www4.ti.ch/index.php?id=147427';
    const translateUrl = 'https://www4-ti-ch.translate.goog/index.php?id=147427&_x_tr_sl=auto&_x_tr_tl=it&_x_tr_hl=it&_x_tr_pto=wapp';
    const officialHtml = `
      <h1>Concorsi generali nell'Amministrazione cantonale</h1>
      <p>www.concorsi.ti.ch</p>
      <div class="ce-bodytext">
        <p>no. 1/26</p>
        <p><strong>Concorso generale Infermiere presso Organizzazione Sociopsichiatrica Cantonale (OSC), Mendrisio</strong></p>
        <p>Scadenza: 31.12.2026</p>
        <a href="https://www-concorsi-ti-ch.translate.goog/offerte-d%27impieghi.html?yid=1&amp;_x_tr_sl=auto&amp;_x_tr_tl=it&amp;_x_tr_hl=it&amp;_x_tr_pto=wapp">Vai al concorso</a>
      </div>`;
    const transport = vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === translateUrl) return new Response(officialHtml, { status: 200 });
      if (url.startsWith('https://r.jina.ai/')) return new Response('', { status: 502 });
      if (url.includes("offerte-d'impieghi.html?yid=1")) {
        return new Response(`${ld(past)}<h2>Dipartimento della sanità e della socialità</h2><h2>1/26</h2><h2>Infermiere OSC Mendrisio</h2><p>${body}</p><h2>Scadenza</h2><p>${past}</p>`, { status: 200 });
      }
      if (url === officialUrl) {
        return new Response('<html>temporarily unavailable</html>', { status: 200 });
      }
      if (url === 'https://www.concorsi.ti.ch/') {
        const error = new TypeError('fetch failed');
        error.cause = { code: 'ENOTFOUND' };
        throw error;
      }
      return new Response('', { status: 404 });
    });
    vi.stubGlobal('fetch', transport);

    const jobs = await fetchAllCantonTicinoOscJobs();

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ companyKey: 'canton-ticino-osc', title: 'Infermiere OSC Mendrisio' });
    expect(transport.mock.calls.some(([url]) => String(url) === translateUrl)).toBe(true);
  });
});

describe('PDF-only clinic offers have no verified publication field', () => {
  for (const [source, producer, base] of [['hildebrand', fetchAllClinicaHildebrandJobs, 'https://www.clinica-hildebrand.ch'], ['varini', fetchAllClinicaVariniJobs, 'https://clinicavarini.ch']] as const) {
    it.each(['deadline and start', 'no date'])('%s does not promote attachment creation for ' + source, async (variant) => {
      const doc = new jsPDF(); doc.setCreationDate(now);
      const content = body + (variant === 'deadline and start' ? ` Scadenza candidature: ${past}. Entrata in servizio: ${future}.` : '');
      doc.text(doc.splitTextToSize(content, 175), 15, 20);
      const bytes = doc.output('arraybuffer');
      const transport = vi.fn(async (input: RequestInfo | URL) => {
        const url = input instanceof Request ? input.url : String(input);
        return url.endsWith('.pdf') ? new Response(bytes, { status: 200, headers: { 'content-type': 'application/pdf' } }) : new Response(`<a href="${base}/uploads/annuncio_infermiere.pdf">Annuncio infermiere</a>`, { status: 200 });
      });
      vi.stubGlobal('fetch', transport);
      const jobs = await producer(); expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({ postedDate: '', datePosted: '', postingDateSource: 'unknown' });
      expect(jobs[0].description).toContain('La nostra clinica');
      expect(jobs[0].applyUrl).toMatch(/^https:\/\//); expect(jobs[0].id).toBeTruthy();
      expect(transport).toHaveBeenCalledTimes(2);
    });
  }
});
