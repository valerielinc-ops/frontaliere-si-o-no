import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { fetchAllAarrehaSchinznachJobs } from '../scripts/lib/aarreha-schinznach-job-parser.mjs';
import { fetchAllAmeosChJobs } from '../scripts/lib/ameos-ch-job-parser.mjs';
import { fetchAllArsanteJobs } from '../scripts/lib/arsante-clinique-de-carouge-job-parser.mjs';
import { fetchAllBernerKlinikMontanaJobs } from '../scripts/lib/berner-klinik-montana-job-parser.mjs';

const now = new Date();
const past = new Date(now.getTime() - 7 * 86400000).toISOString();
const future = new Date(now.getTime() + 7 * 86400000).toISOString();
const text = 'Notre équipe clinique assure les soins et la réadaptation des patients avec une collaboration professionnelle. '.repeat(8);
const jsonld = (date: unknown) => `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', datePosted: date, validThrough: past, dateModified: past, jobStartDate: past })}</script>`;
const fixture = (file: string) => fs.readFileSync(new URL(`./fixtures/${file}`, import.meta.url), 'utf8');
const sources = [
  ['aarreha', fetchAllAarrehaSchinznachJobs], ['ameos', fetchAllAmeosChJobs],
  ['arsante', fetchAllArsanteJobs], ['berner', fetchAllBernerKlinikMontanaJobs],
] as const;
const cases: ReadonlyArray<readonly [string, unknown, string]> = [
  ['reported', past, past], ['missing', undefined, ''], ['invalid', 'invalid', ''],
  ['future', future, ''], ['invalid calendar', `${now.getUTCFullYear() - 1}-02-30`, ''],
];
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

for (const [source, producer] of sources) describe(`${source} publication through actual producer`, () => {
  it.each(cases)('%s preserves the available job and its evidence', async (_name, raw, expected) => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now);
    const mock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      let html = '';
      if (source === 'aarreha') html = url.includes('liste-aller')
        ? url.includes('&page=') ? '' : `<li class="ts-offer-list-item" onclick="location.href='/stelle/soins.aspx';"><a class="ts-offer-list-item__title-link">Pflegefachperson</a><span data-reference="1-1"></span><ul class="ts-offer-list-item__description"><li>Pflege</li><li>Schinznach-Bad</li></ul></li>`
        : `${jsonld(raw)}${fixture('talentsoft-aarreha-schinznach-detail.html')}`;
      if (source === 'ameos') html = url.includes('/stelle/')
        ? `${jsonld(raw)}<h1>Pflegefachperson</h1><div class="frame-type-ameosjobs_detail">${text}</div></section>`
        : `<a href="/offene-stellen/stelle/889-pflegefachperson-in-brunnen">Pflegefachperson</a><a href="/offene-stellen/stelle/888-pflegefachperson-in-berlin">Ausland</a>`;
      if (source === 'arsante') html = url.includes('/emploi/')
        ? `${jsonld(raw)}<h2 class="post__subtitle">Clinique de Carouge</h2><main>${text}</main>`
        : url.includes('?page=') ? '' : `<main><div itemscope itemtype="https://schema.org/JobPosting"><h2 itemprop="title">Infirmier</h2><div itemprop="description">${text}<a href="/emploi/infirmier-123" itemprop="url">Details</a></div></div></main>`;
      if (source === 'berner') html = url.includes('/job-test/')
        ? `${jsonld(raw)}${fixture('berner-klinik-montana/detail-infirmier.html')}`
        : `<article class="page-list-item"><a class="post-link" href="https://bernerklinik.ch/job-test/"><h3 class="post-title-in-data">Infirmier</h3><span class="post-resume-wrapper">${text}</span></a></article>`;
      return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
    });
    vi.stubGlobal('fetch', mock);
    const jobs = await producer();
    expect(jobs).toHaveLength(1);
    const job = jobs[0];
    expect(job).toMatchObject({ datePosted: expected, postedDate: expected, postingDateSource: expected ? 'reported' : 'unknown' });
    expect(job.description.split(/\s+/).length).toBeGreaterThan(50);
    expect(job.id).toBeTruthy(); expect(job.slug).toBeTruthy();
    expect(job.url).toMatch(/^https:\/\//); expect(job.applyUrl).toBe(job.url);
    expect(Date.parse(job.crawledAt)).toBe(now.getTime());
    expect(job.canton).toBe(({ aarreha: 'AG', ameos: 'SZ', arsante: 'GE', berner: 'VS' })[source]);
    expect(mock).toHaveBeenCalledTimes(({ aarreha: 3, ameos: 4, arsante: 3, berner: 2 })[source]);
  });
});

describe('AMEOS existing microdata and Solique path', () => {
  it.each([['microdata only', 'invalid', past, past], ['ad only', past, '', past], ['invalid sources', 'invalid', '', '']] as const)('%s', async (_name, adDate, microDate, expected) => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      const html = url.includes('solique.ch') ? `${jsonld(adDate)}${fixture('ameos-ch/solique-ad-4037222.html')}`
        : url.includes('/stelle/') ? fixture('ameos-ch/detail-7902.html').replace(/(<meta itemprop="datePosted" content=")[^"]+/, `$1${microDate}`)
        : '<a href="/offene-stellen/stelle/7902-oberarzt-in-brunnen">Oberarzt</a>';
      return new Response(html, { status: 200 });
    }));
    const [job] = await fetchAllAmeosChJobs();
    expect(job).toMatchObject({ postedDate: expected, datePosted: expected, postingDateSource: expected ? 'reported' : 'unknown' });
    expect(job.description).toContain('Ihre Aufgaben'); expect(job.canton).toBe('SZ');
  });
});


describe('Arsanté observed French publication microdata', () => {
  const day = new Date(now.getTime() - 7 * 86400000);
  const human = new Intl.DateTimeFormat('fr', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(day);
  const expectedDay = day.toISOString().slice(0, 10);
  it.each([[human, expectedDay], ['30 février ' + (now.getUTCFullYear() - 1), ''], ['', '']] as const)('validates source calendar %s', async (raw, expected) => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      const html = url.includes('/emploi/') ? `<main><div itemscope itemtype="https://schema.org/JobPosting"><span class="post__date" itemprop="datePosted">${raw}</span><div itemprop="description">${text}</div></div></main>`
        : url.includes('?page=') ? '' : `<main><div itemscope itemtype="https://schema.org/JobPosting"><h2 itemprop="title">Infirmier</h2><div itemprop="description">${text}<a href="/emploi/infirmier-123" itemprop="url">Details</a></div></div></main>`;
      return new Response(html, { status: 200 });
    }));
    const [job] = await fetchAllArsanteJobs();
    expect(job).toMatchObject({ postedDate: expected, datePosted: expected, postingDateSource: expected ? 'reported' : 'unknown' });
    expect(job.description).toContain('Notre équipe'); expect(job.applyUrl).toContain('/emploi/infirmier-123');
  });
});
