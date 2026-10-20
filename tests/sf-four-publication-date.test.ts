import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchAllNordAngliaJobs } from '../scripts/lib/nord-anglia-job-parser.mjs';
import { fetchAllSohJobs } from '../scripts/lib/soh-solothurner-spitaeler-job-parser.mjs';
import { fetchAllStadlerRailJobs } from '../scripts/lib/stadler-rail-job-parser.mjs';
import { __internals as ubs } from '../scripts/lib/ubs-job-parser.mjs';

const source = new Date(Date.now() - 10 * 86400000).toISOString();
const future = new Date(Date.now() + 10 * 86400000).toISOString();
const body = Array.from({ length: 80 }, () => 'professional').join(' ');
const unknown = { datePosted: '', postedDate: '', postingDateSource: 'unknown' };
let raw: unknown = '';
let nordRss = false;

beforeEach(() => {
  raw = ''; nordRss = false;
  vi.stubEnv('JOBS_CRAWLER_RETRIES', '0');
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void) => {
    callback(); return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout);
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const url = String(input);
    let html = '';
    if (url.includes('nordanglia')) {
      if (url.includes('/services/rss/')) {
        if (!nordRss) return new Response('Unavailable', { status: 403 });
        html = `<rss><channel><item><title>Teacher (Aubonne, CH)</title><link>https://careers.nordanglia.com/job/Aubonne-Teacher/1234567890/</link><description>${body}</description><pubDate>${raw}</pubDate></item></channel></rss>`;
      } else if (url.includes('/search/')) html = '<a href="/job/Aubonne-Teacher/1234567890/">Teacher</a>';
      else html = `<html lang="en"><span data-careersite-propertyid="title">Teacher</span><div data-careersite-propertyid="description">${body}</div><meta itemprop="datePosted" content="${raw}"></html>`;
    } else if (url.includes('stadlerrail')) {
      html = url.includes('/search/')
        ? '<a class="jobTitle-link" href="/job/Altenrhein-Engineer-SG-S-9423/1234567890/">Engineer</a>'
        : `<h1>Engineer</h1><meta itemprop="addressCountry" content="CH"><meta itemprop="addressLocality" content="Altenrhein"><meta itemprop="datePosted" content="${raw}"><span itemprop="description">${body}</span>`;
    } else if (url.includes('solothurnerspitaeler.ch')) {
      html = '<a href="https://jobs.so-h.ch/offene-stellen/engineer/job-123">Engineer</a>';
    } else if (url.includes('jobs.so-h.ch')) {
      html = `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title: 'Engineer', datePosted: raw, description: body, jobLocation: { address: { addressLocality: 'Solothurn', addressCountry: 'CH' } } })}</script>`;
    } else throw new Error(`Unexpected request: ${url}`);
    const response = new Response(html, { headers: { 'content-type': nordRss ? 'application/rss+xml' : 'text/html' } });
    Object.defineProperty(response, 'url', { value: url });
    return response;
  }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

for (const [name, fetchAll] of [['Nord Anglia', fetchAllNordAngliaJobs], ['SOH', fetchAllSohJobs], ['Stadler', fetchAllStadlerRailJobs]] as const) {
  describe(`${name} full producer publication provenance`, () => {
    it.each(['', 'not-a-date', '2025-02-30', future, `junk ${source}`])('does not attest invalid source %s', async (value) => {
      raw = value;
      const jobs = await fetchAll();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject(unknown);
    });
    it('preserves a genuine timestamp without day truncation', async () => {
      raw = source;
      const jobs = await fetchAll();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({ datePosted: source, postedDate: source, postingDateSource: 'reported' });
    });
  });
}
it('Nord Anglia retains an explicit RSS publication including its timezone', async () => {
  nordRss = true;
  raw = new Date(source).toUTCString();
  const expected = source.replace(/\.\d{3}Z$/, 'Z');
  const jobs = await fetchAllNordAngliaJobs();
  expect(jobs).toHaveLength(1);
  expect(jobs[0]).toMatchObject({ datePosted: expected, postedDate: expected, postingDateSource: 'reported' });
});
it.each(['', source, future, 'not-a-date'])('UBS never treats lastupdated %s as publication', (updated) => {
  const q = (QuestionName: string, Value: string) => ({ QuestionName, Value });
  const job = ubs.buildJobFromTaleo({ Questions: [
    q('reqid', '123456'), q('jobtitle', 'Credit Specialist'), q('jobdescription', body),
    q('formtext23', 'Suisse - Suisse romande'), q('formtext2', 'Lausanne'), q('jobreqlanguage', '34'), q('lastupdated', updated),
  ] }, '5012');
  expect(job).not.toBeNull();
  expect(job).toMatchObject(unknown);
});
it('Stadler retains explicit Java microdata publication with UTC time', async () => {
  const date = new Date(source);
  const parts = date.toUTCString().split(' ');
  raw = `${parts[0].replace(',', '')} ${parts[2]} ${parts[1]} ${parts[4]} UTC ${parts[3]}`;
  const expected = source.replace(/\.\d{3}Z$/, 'Z');
  const jobs = await fetchAllStadlerRailJobs();
  expect(jobs).toHaveLength(1);
  expect(jobs[0]).toMatchObject({ datePosted: expected, postedDate: expected, postingDateSource: 'reported' });
});
