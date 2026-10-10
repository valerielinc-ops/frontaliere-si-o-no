import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchAllKlinikSchoenbergJobs } from '../scripts/lib/klinik-schoenberg-job-parser.mjs';
import { fetchAllMichelGruppeJobs } from '../scripts/lib/michel-gruppe-job-parser.mjs';
import { fetchAllPrivatklinikMeiringenJobs } from '../scripts/lib/privatklinik-meiringen-job-parser.mjs';
import { fetchAllRehaklinikHaslibergJobs } from '../scripts/lib/rehaklinik-hasliberg-job-parser.mjs';
import { mergePreserveLocaleData } from '../scripts/lib/dedicated-crawler-common.mjs';
const consumers = [
  ['Schönberg', fetchAllKlinikSchoenbergJobs], ['Michel Gruppe', fetchAllMichelGruppeJobs],
  ['Meiringen', fetchAllPrivatklinikMeiringenJobs], ['Hasliberg', fetchAllRehaklinikHaslibergJobs],
] as const;
const past = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10) + 'T12:30:00+02:00';
const future = new Date(Date.now() + 7 * 86400000).toISOString();
const invalid = `${new Date().getUTCFullYear()}-02-30`;
const unknown = { datePosted: '', postedDate: '', postingDateSource: 'unknown' };

const haslibergListing = `<a href="https://my.jobalino.ch/job/de/abc123/pflege?origin=joblist" class="reflink"><span class="title">Fachperson Pflege</span><span class="company">Rehaklinik Hasliberg</span><span class="city">Meiringen</span></a>`;
const haslibergSourceHtml = `<!doctype html><html><head><link rel="stylesheet" href="https://my.jobalino.ch/css/externallist.css"></head><body><div id="ajaxjoblistresult" class="jobalino-joblist">${haslibergListing}</div><script>function jb_reloadframelist() { return true; }</script></body></html>`;
const haslibergDetail = `<script type="application/ld+json">${JSON.stringify({
  '@type': 'JobPosting',
  title: 'Fachperson Pflege',
  datePosted: past,
  description: 'Sie arbeiten gemeinsam mit unserem erfahrenen Team. '.repeat(15),
})}</script>`;

describe.each(consumers)('Jobalino actual %s producer', (company, fetchJobs) => {
  beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
  it.each([['timestamp', past], ['missing', undefined], ['invalid', invalid], ['future', future]])(
    '%s keeps publication provenance through DCC merge', async (_kind, datePosted) => {
      const transport = vi.fn(async (url: string) => {
        const listing = `<a href="https://my.jobalino.ch/job/abc123/pflege" class="reflink"><span class="title">Fachperson Pflege</span><span class="company">${company}</span><span class="city">Meiringen</span></a>`;
        const detail = `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title: 'Fachperson Pflege', datePosted,
          dateCreated: past, dateModified: past, jobStartDate: past, description: 'Sie arbeiten gemeinsam mit unserem erfahrenen Team. '.repeat(15),
        })}</script>`;
        return new Response(url.includes('/custel_jobExternalList/') ? `jb_ShowJsonHtml(${JSON.stringify({html: listing})});` : detail);
      });
      vi.stubGlobal('fetch', transport);
      const jobs = await fetchJobs(); expect(jobs).toHaveLength(1); expect(transport).toHaveBeenCalledTimes(2);
      const expected = datePosted === past ? { datePosted: past, postedDate: past, postingDateSource: 'reported' } : unknown;
      expect(jobs[0]).toMatchObject(expected); expect(Number.isFinite(Date.parse(jobs[0].crawledAt))).toBe(true);
      const previous = { ...jobs[0], datePosted: past, postedDate: past, postingDateSource: 'unknown' };
      const merged = mergePreserveLocaleData([previous], jobs, { matchKey: (job: {id: string}) => job.id });
      expect(merged).toHaveLength(1); expect(merged[0]).toMatchObject(expected);
    },
  );
});

describe('Jobalino HTTP 415 recovery', () => {
  beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('recovers the Hasliberg listing once through the source-validated HTML endpoint', async () => {
    const transport = vi.fn(async (url: string) => {
      if (url.includes('/custel_jobExternalList/')) {
        return new Response('Unsupported Media Type', { status: 415 });
      }
      if (url.includes('/jobExternalList/de/rehaklinik-hasliberg')) {
        return new Response(haslibergSourceHtml);
      }
      return new Response(haslibergDetail);
    });
    vi.stubGlobal('fetch', transport);

    const jobs = await fetchAllRehaklinikHaslibergJobs();

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      title: 'Fachperson Pflege',
      url: 'https://my.jobalino.ch/job/abc123/pflege',
      datePosted: past,
      postingDateSource: 'reported',
    });
    expect(transport).toHaveBeenCalledTimes(3);
    expect(transport.mock.calls.map(([url]) => url)).toEqual([
      'https://my.jobalino.ch/custel_jobExternalList/rehaklinik-hasliberg',
      'https://my.jobalino.ch/jobExternalList/de/rehaklinik-hasliberg',
      'https://my.jobalino.ch/job/abc123/pflege',
    ]);
  });

  it('rejects an unrelated HTML body instead of treating it as a recovered source', async () => {
    const unrelatedHtml = `<!doctype html><html><body>${'unrelated page '.repeat(30)}</body></html>`;
    const transport = vi
      .fn()
      .mockResolvedValueOnce(new Response('Unsupported Media Type', { status: 415 }))
      .mockResolvedValueOnce(new Response(unrelatedHtml));
    vi.stubGlobal('fetch', transport);

    await expect(fetchAllRehaklinikHaslibergJobs()).rejects.toThrow(/HTTP 415/);
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('source-validates a detail page recovered after HTTP 415', async () => {
    const directListing = `jb_ShowJsonHtml(${JSON.stringify({ html: haslibergListing.replace('/job/de/', '/job/') })});`;
    const transport = vi
      .fn()
      .mockResolvedValueOnce(new Response(directListing))
      .mockResolvedValueOnce(new Response('Unsupported Media Type', { status: 415 }))
      .mockResolvedValueOnce(new Response(haslibergDetail));
    vi.stubGlobal('fetch', transport);

    const jobs = await fetchAllRehaklinikHaslibergJobs();

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ datePosted: past, postingDateSource: 'reported' });
    expect(transport).toHaveBeenCalledTimes(3);
    expect(transport.mock.calls[1][0]).toBe('https://my.jobalino.ch/job/abc123/pflege');
    expect(transport.mock.calls[2][0]).toBe('https://my.jobalino.ch/job/abc123/pflege');
  });

  it('fails closed on a genuine 404 without trying the recovery endpoint', async () => {
    const transport = vi.fn(async () => new Response('Not Found', { status: 404 }));
    vi.stubGlobal('fetch', transport);

    await expect(fetchAllRehaklinikHaslibergJobs()).rejects.toThrow(/HTTP 404/);
    expect(transport).toHaveBeenCalledOnce();
  });
});
