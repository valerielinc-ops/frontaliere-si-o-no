import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchAllAsanaSpitalJobs } from '../scripts/lib/asana-spital-job-parser.mjs';
import { fetchAllBalgristJobs } from '../scripts/lib/balgrist-job-parser.mjs';
import { fetchAllBaloiseJobs } from '../scripts/lib/baloise-job-parser.mjs';
import { fetchAllBrackAlltronJobs } from '../scripts/lib/brack-alltron-job-parser.mjs';
import { fetchAllBuehlerJobs } from '../scripts/lib/buehler-job-parser.mjs';
import { fetchAllClaraspitalJobs } from '../scripts/lib/claraspital-job-parser.mjs';
import { fetchAllConcaraJobs } from '../scripts/lib/concara-job-parser.mjs';
import { fetchAllEpiStiftungJobs } from '../scripts/lib/epi-stiftung-job-parser.mjs';
import { fetchAllEquansJobs } from '../scripts/lib/equans-job-parser.mjs';
import { fetchAllGrandResortBadRagazJobs } from '../scripts/lib/grand-resort-bad-ragaz-job-parser.mjs';
import { fetchAllGzDielsdorfJobs } from '../scripts/lib/gz-dielsdorf-job-parser.mjs';
import { fetchAllHelvetiaJobs } from '../scripts/lib/helvetia-job-parser.mjs';
import { fetchAllKantonBaselLandschaftJobs } from '../scripts/lib/kanton-basel-landschaft-job-parser.mjs';
import { fetchAllKlinikLenggJobs } from '../scripts/lib/klinik-lengg-job-parser.mjs';
import { fetchAllKlinikSgmJobs } from '../scripts/lib/klinik-sgm-job-parser.mjs';
import { fetchAllKlinikenValensJobs } from '../scripts/lib/kliniken-valens-job-parser.mjs';
import { fetchAllLivitJobs } from '../scripts/lib/livit-job-parser.mjs';
import { fetchAllLuksJobs } from '../scripts/lib/luks-job-parser.mjs';
import { fetchAllParaplegieJobs } from '../scripts/lib/paraplegie-job-parser.mjs';
import { fetchAllPdagJobs } from '../scripts/lib/pdag-job-parser.mjs';
import { fetchAllRaiffeisenJobs } from '../scripts/lib/raiffeisen-job-parser.mjs';
import { fetchAllSchulthessKlinikJobs } from '../scripts/lib/schulthess-klinik-job-parser.mjs';
import { fetchAllSpitaelerSchaffhausenJobs } from '../scripts/lib/spitaeler-schaffhausen-job-parser.mjs';
import { fetchAllSpitalBuelachJobs } from '../scripts/lib/spital-buelach-job-parser.mjs';
import { fetchAllSpitalNidwaldenJobs } from '../scripts/lib/spital-nidwalden-job-parser.mjs';
import { fetchAllSpitexBaselJobs } from '../scripts/lib/spitex-basel-job-parser.mjs';
import { fetchAllStadtBernJobs } from '../scripts/lib/stadt-bern-job-parser.mjs';
import { fetchAllStadtLuzernJobs } from '../scripts/lib/stadt-luzern-job-parser.mjs';
import { fetchAllUnibeJobs } from '../scripts/lib/unibe-job-parser.mjs';
import { fetchAllUpdJobs } from '../scripts/lib/upd-job-parser.mjs';
import { fetchAllUzhJobs } from '../scripts/lib/uzh-job-parser.mjs';
import { fetchAllVivaLuzernJobs } from '../scripts/lib/viva-luzern-job-parser.mjs';
import { fetchAllVolksschuleLuzernJobs } from '../scripts/lib/volksschule-luzern-job-parser.mjs';
import { mergePreserveLocaleData } from '../scripts/lib/dedicated-crawler-common.mjs';
const consumers = [
  ['asana-spital', fetchAllAsanaSpitalJobs, true],
  ['balgrist', fetchAllBalgristJobs, false],
  ['baloise', fetchAllBaloiseJobs, false],
  ['brack-alltron', fetchAllBrackAlltronJobs, false],
  ['buehler', fetchAllBuehlerJobs, false],
  ['claraspital', fetchAllClaraspitalJobs, true],
  ['concara', fetchAllConcaraJobs, false],
  ['epi-stiftung', fetchAllEpiStiftungJobs, true],
  ['equans', fetchAllEquansJobs, true],
  ['grand-resort-bad-ragaz', fetchAllGrandResortBadRagazJobs, false],
  ['gz-dielsdorf', fetchAllGzDielsdorfJobs, true],
  ['helvetia', fetchAllHelvetiaJobs, false],
  ['kanton-basel-landschaft', fetchAllKantonBaselLandschaftJobs, true],
  ['klinik-lengg', fetchAllKlinikLenggJobs, false],
  ['klinik-sgm', fetchAllKlinikSgmJobs, true],
  ['kliniken-valens', fetchAllKlinikenValensJobs, false],
  ['livit', fetchAllLivitJobs, true],
  ['luks', fetchAllLuksJobs, false],
  ['paraplegie', fetchAllParaplegieJobs, false],
  ['pdag', fetchAllPdagJobs, true],
  ['raiffeisen', fetchAllRaiffeisenJobs, true],
  ['schulthess-klinik', fetchAllSchulthessKlinikJobs, false],
  ['spitaeler-schaffhausen', fetchAllSpitaelerSchaffhausenJobs, true],
  ['spital-buelach', fetchAllSpitalBuelachJobs, true],
  ['spital-nidwalden', fetchAllSpitalNidwaldenJobs, true],
  ['spitex-basel', fetchAllSpitexBaselJobs, true],
  ['stadt-bern', fetchAllStadtBernJobs, false],
  ['stadt-luzern', fetchAllStadtLuzernJobs, true],
  ['unibe', fetchAllUnibeJobs, true],
  ['upd', fetchAllUpdJobs, true],
  ['uzh', fetchAllUzhJobs, true],
  ['viva-luzern', fetchAllVivaLuzernJobs, true],
  ['volksschule-luzern', fetchAllVolksschuleLuzernJobs, true],
] as const;
const past = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10) + 'T12:30:00+02:00';
const future = new Date(Date.now() + 7 * 86400000).toISOString();
const invalid = `${new Date().getUTCFullYear()}-02-30`;
const unknown = { datePosted: '', postedDate: '', postingDateSource: 'unknown' };
const title = 'Fachperson Pflege';
const text = 'Sie arbeiten gemeinsam mit unserem erfahrenen Team an abwechslungsreichen Aufgaben und begleiten unsere Mitarbeitenden jeden Tag mit grosser Sorgfalt und Freude. '.repeat(5);

describe.each(consumers)('Prospective scheduled %s runtime publication coverage', (company, fetchJobs, readsDetail) => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout'] }); vi.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
  it.each([['timestamp', past], ['missing', undefined], ['invalid', invalid], ['future', future]])(
    '%s uses only this validated detail response; non-opt-in stays unknown', async (_kind, datePosted) => {
      const transport = vi.fn(async (url: string) => {
        if (url.includes('/medium/')) return new Response(JSON.stringify({ total: 1, jobs: [{
          id: '123456', title, start_date: past, last_modification_timestamp: past,
          links: { directlink: 'https://ohws.prospective.ch/public/v1/jobs/audit123' },
          attributes: { '40': company === 'spital-nidwalden' ? ['KSNW'] : [], arbeitsort: ['Zürich'] },
          szas: { sza_title: title, sza_introduction: text, 'sza_location.city': 'Zürich',
            'sza_location.country': 'CH', sza_workplace: company === 'baloise' ? 'Baloise' : 'Zürich' },
        }] }), { headers: { 'content-type': 'application/json' } });
        return new Response(`<main><h1>${title}</h1><p>${text}</p><p>Weitere Angaben zum Arbeitsplatz und zum Team finden Sie in dieser Stellenbeschreibung.</p></main><script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title, datePosted, dateCreated: past, dateModified: past, jobStartDate: past })}</script>`, { headers: { 'content-type': 'text/html' } });
      });
      vi.stubGlobal('fetch', transport);
      const pending = fetchJobs(); await vi.runAllTimersAsync(); const jobs = await pending;
      expect(jobs).toHaveLength(1); expect(transport).toHaveBeenCalledTimes(readsDetail ? 2 : 1);
      const expected = readsDetail && datePosted === past ? { datePosted: past, postedDate: past, postingDateSource: 'reported' } : unknown;
      expect(jobs[0]).toMatchObject(expected); expect(Number.isFinite(Date.parse(jobs[0].crawledAt))).toBe(true);
      const previous = { ...jobs[0], datePosted: past, postedDate: past, postingDateSource: 'unknown' };
      const merged = mergePreserveLocaleData([previous], jobs, { matchKey: (job: { id: string }) => job.id });
      expect(merged).toHaveLength(1); expect(merged[0]).toMatchObject(expected);
    },
  );
});

describe('Prospective publication identity and existing helper callers', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
  it.each(['unrelated body', 'other structured title', 'existing description-only caller'])(
    '%s cannot establish publication', async (scenario) => {
      const { enrichProspectiveJobsFromDetailPages } = await import('../scripts/lib/prospective-ch-job-parser-common.mjs');
      const job = { title, url: 'https://ohws.prospective.ch/public/v1/jobs/audit123', description: text,
        sourceLang: 'de', descriptionByLocale: { de: text }, ...unknown };
      const html = `<main><h1>${title}</h1><p>${scenario === 'unrelated body' ? 'Unrelated vacancy for a different employer.' : text}</p><p>Weitere Aufgaben und Informationen.</p></main><script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title: scenario === 'other structured title' ? 'Different role' : title, datePosted: past })}</script>`;
      const transport = vi.fn(async () => new Response(html, { headers: { 'content-type': 'text/html' } }));
      vi.spyOn(console, 'log').mockImplementation(() => {});
      await enrichProspectiveJobsFromDetailPages([job], { delayMs: 0, fetchImpl: transport,
        ...(scenario === 'existing description-only caller' ? {} : { includePostingDate: true }) });
      expect(job).toMatchObject(unknown); expect(transport).toHaveBeenCalledTimes(1);
    },
  );
});
