import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseBellinzonaListingHtml } from '../scripts/lib/citta-di-bellinzona-job-parser.mjs';
import { fetchMendrisioJobs } from '../scripts/update-mendrisio-jobs.mjs';
import { sourcePostingDateFields } from '../scripts/lib/source-posting-date.mjs';

vi.mock('../scripts/lib/pdf-job-content.mjs', async (importOriginal) => {
  const original = await importOriginal<typeof import('../scripts/lib/pdf-job-content.mjs')>();
  return {
    ...original,
    extractPdfJobContentFromUrl: vi.fn(async (sourceUrl: string) => ({
      text: `Impiegato amministrativo. ${sourceBody}`,
      rawText: sourceBody,
      thin: false,
      totalPages: 1,
      sourceUrl,
    })),
  };
});

const day = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
const future = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
const swiss = (value: string) => value.split('-').reverse().join('.');
const stamp = `${day}T08:12:10.733560+02:00`;
const unknown = { datePosted: '', postedDate: '', postingDateSource: 'unknown' };
const sourceBody = 'La persona assunta collabora con il personale amministrativo e gestisce le pratiche del servizio comunale. '.repeat(6);

afterEach(() => vi.unstubAllGlobals());

describe('Bellinzona complete labelled publication value', () => {
  const listing = (publication: string) => `<h3>Impiegato amministrativo</h3>${publication}
    <p>Termine ${swiss(future)} 23:59</p><a href="/docs/bando.pdf">Bando di concorso</a>`;

  it.each([
    ['native two-cell label', `<table><tr><td><p>Pubbl.</p></td><td>${swiss(day)}</td></tr></table>`, day],
    ['legacy paragraph', `<p>Pubbl. ${swiss(day)}</p>`, day],
    ['letter suffix', `<p>Pubbl. ${swiss(day)}junk</p>`, ''],
    ['unicode suffix', `<p>Pubbl. ${swiss(day)}é</p>`, ''],
    ['separated garbage', `<p>Pubbl. ${swiss(day)} garbage</p>`, ''],
    ['native malformed cell', `<table><tr><td>Pubbl.</td><td>${swiss(day)}junk</td></tr></table>`, ''],
    ['invalid calendar', '<p>Pubbl. 31.02.2020</p>', ''],
    ['duplicate fields', `<p>Pubbl. ${swiss(day)}</p><p>Pubbl. ${swiss(day)}</p>`, ''],
    ['deadline only', '', ''],
    ['future publication', `<p>Pubbl. ${swiss(future)}</p>`, ''],
  ])('%s remains distinct from the application deadline', (_name, html, expected) => {
    const [job] = parseBellinzonaListingHtml(listing(html));
    expect(job.title).toBe('Impiegato amministrativo');
    expect(job.deadline).toBe(future);
    // The production runner applies this same shared validator to datePosted.
    expect(sourcePostingDateFields(job.datePosted)).toEqual(expected
      ? { datePosted: expected, postedDate: expected, postingDateSource: 'reported' }
      : unknown);
  });
});

describe.each(['ajax', 'static'])('Mendrisio %s actual fetch-to-job publication', (mode) => {
  const article = (publication: string) => `<article class="document">${publication}<div class="content">
    <h3>Impiegato amministrativo</h3><span class="note">In scadenza il: <time datetime="${future}">${future}</time></span>
    ${mode === 'ajax' ? '<ul class="download-list"><li><a href="/downloadConcorsiPdf?uuid=406d1993-b1ab-4edb-aa94-ef296eb1e54e">Bando PDF</a></li></ul>' : ''}
    <p>${sourceBody}</p></div></article>`;

  it.each([
    ['explicit label with full timestamp', `<p>Data di pubblicazione: <time datetime="${stamp}">${day}</time></p>`, stamp],
    ['explicit property', `<time itemprop="datePosted" datetime="${day}">${day}</time>`, day],
    ['generic time', `<time datetime="${day}">${day}</time>`, ''],
    ['deadline only', '', ''],
    ['mislabelled property inside deadline', `<span class="note">In scadenza il: <time itemprop="datePosted" datetime="${day}">${day}</time></span>`, ''],
    ['property in locally labelled deadline', `<p>Termine: <time itemprop="datePosted" datetime="${day}">${day}</time></p>`, ''],
    ['malformed suffix', `<time itemprop="datePosted" datetime="${day} junk">${day}</time>`, ''],
    ['invalid calendar', '<time itemprop="datePosted" datetime="2020-02-31">31 febbraio</time>', ''],
    ['future date', `<time itemprop="datePosted" datetime="${future}">${future}</time>`, ''],
    ['modified label', `<p>Aggiornato il: <time datetime="${day}">${day}</time></p>`, ''],
    ['ambiguous publication fields', `<time itemprop="datePosted" datetime="${day}"></time><time itemprop="datePosted" datetime="${day}"></time>`, ''],
  ])('%s', async (_name, publication, expected) => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const ajax = String(input).includes('ajax=true');
      const html = mode === 'ajax'
        ? (ajax ? article(publication) : '<div id="simapItems1"></div>')
        : (ajax ? '' : `<div id="simapItems1"></div>${article(publication)}`);
      return new Response(html, { status: 200 });
    }));
    const jobs = await fetchMendrisioJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ title: 'Impiegato amministrativo', location: 'Mendrisio', validThrough: future });
    expect(jobs[0].description).toContain('gestisce le pratiche');
    expect(jobs[0]).toMatchObject(expected
      ? { datePosted: expected, postedDate: expected, postingDateSource: 'reported' }
      : unknown);
  });
});
