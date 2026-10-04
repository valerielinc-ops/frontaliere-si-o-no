import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAllCsdEngineersJobs } from '../scripts/lib/csd-engineers-job-parser.mjs';
const url = 'https://jobs.csd.ch/jobs/123-engineer';
const date = '2025-09-29T23:45:12+02:00';
const rssDate = 'Mon, 29 Sep 2025 22:30:00 +0200';
const text = 'Engineering teams design safe reliable infrastructure and collaborate with colleagues and clients throughout each project. Responsibilities include planning testing documentation and careful technical analysis to maintain quality and satisfy customer requirements. '.repeat(4);
const posting = (raw: unknown, sourceUrl = url) => ({ '@type': 'JobPosting', url: sourceUrl, title: 'Civil Engineer', description: text, datePosted: raw, jobLocation: { address: { addressLocality: 'Lugano', addressCountry: 'CH', postalCode: '6900' } } });
const item = (sourceUrl: string, rawRss = '') => `<item><title>Civil Engineer</title><link>${sourceUrl}</link><pubDate>${rawRss}</pubDate><tt:locations><tt:city>Lugano</tt:city><tt:country>Switzerland</tt:country></tt:locations></item>`;
function stub(records: { url: string; posting: unknown; rss?: string }[]) {
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    if (String(input) === 'https://jobs.csd.ch/jobs.rss') return new Response(`<rss><channel><pubDate>Mon, 29 Sep 2025 22:30:00 +0200</pubDate><lastBuildDate>Tue, 30 Sep 2025 22:30:00 +0200</lastBuildDate>${records.map(r => item(r.url, r.rss)).join('')}</channel></rss>`);
    const record = records.find(r => r.url === String(input));
    if (!record) throw new Error(`Unexpected request ${input}`);
    return new Response(`<script type="application/ld+json">${JSON.stringify(record.posting)}</script>`);
  }));
}
afterEach(() => vi.unstubAllGlobals());
async function expectDate(expected = '') {
  const jobs = await fetchAllCsdEngineersJobs();
  expect(jobs).toHaveLength(1);
  expect(jobs[0]).toMatchObject({ url, canton: 'TI', datePosted: expected, postedDate: expected, postingDateSource: expected ? 'reported' : 'unknown' });
  expect(jobs[0].description.split(/\s+/).length).toBeGreaterThan(50);
}
describe('CSD publication evidence from real RSS/detail producer', () => {
  for (const [label, raw] of [['timestamp', date], ['missing', undefined], ['invalid', '2025-02-30T12:00:00Z'], ['future', '2999-01-01T12:00:00Z']]) {
    it(`${label}: preserves only complete strict detail date`, async () => {
      stub([{ url, posting: posting(raw) }]);
      await expectDate(label === 'timestamp' ? date : '');
    });
  }
  it('valid RSS remains available when detail date is invalid', async () => {
    stub([{ url, posting: posting('2025-02-30'), rss: rssDate }]);
    await expectDate('2025-09-29T22:30:00+02:00');
  });
  it('does not normalize invalid RSS calendar overflow', async () => {
    stub([{ url, posting: posting(undefined), rss: 'Sun, 30 Feb 2025 12:00:00 GMT' }]);
    await expectDate();
  });
  it('rejects a future RSS publication', async () => {
    stub([{ url, posting: posting(undefined), rss: 'Tue, 01 Jan 2999 12:00:00 GMT' }]);
    await expectDate();
  });
  it('does not attest a foreign singleton JSON-LD vacancy', async () => {
    stub([{ url, posting: posting(date, 'https://jobs.csd.ch/jobs/456-other') }]);
    await expectDate();
  });
  it('rejects conflicting structured identities', async () => {
    stub([{ url, posting: { ...posting(date), sameAs: 'https://jobs.csd.ch/jobs/456-other' } }]);
    await expectDate();
  });
  it('keeps publication evidence scoped to each RSS item and detail', async () => {
    const other = 'https://jobs.csd.ch/jobs/456-other';
    stub([{ url, posting: posting(date) }, { url: other, posting: posting(undefined, other) }]);
    const jobs = await fetchAllCsdEngineersJobs();
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({ url, datePosted: date, postedDate: date, postingDateSource: 'reported' });
    expect(jobs[1]).toMatchObject({ url: other, datePosted: '', postedDate: '', postingDateSource: 'unknown' });
  });
});
