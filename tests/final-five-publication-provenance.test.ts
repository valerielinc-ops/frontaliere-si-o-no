import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAllAnyboticsJobs } from '../scripts/lib/anybotics-job-parser.mjs';
import { fetchAllSonarsourceJobs } from '../scripts/lib/sonarsource-job-parser.mjs';
import { fetchAllGholJobs } from '../scripts/lib/ghol-job-parser.mjs';
import { fetchAllSchindlerJobs, parseDate, parseSearchResults } from '../scripts/lib/schindler-job-parser.mjs';
import { fetchAllTertianumJobs } from '../scripts/lib/tertianum-job-parser.mjs';
const body = 'The employer describes responsibilities, qualifications and working conditions for this engineering position in Switzerland. '.repeat(8);
const unknown = { datePosted: '', postedDate: '', postingDateSource: 'unknown' };
const past = () => new Date(Date.now() - 4 * 86400000).toISOString();
afterEach(() => vi.unstubAllGlobals());

for (const [name, producer, city] of [['ANYbotics', fetchAllAnyboticsJobs, 'Zurich'], ['SonarSource', fetchAllSonarsourceJobs, 'Geneva']] as const) {
  it(`${name}: never promotes the real Lever client creation/update compatibility alias`, async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([{ id: 'fixture', text: 'Software Engineer', categories: { location: city }, hostedUrl: 'https://jobs.lever.co/fixture/1', applyUrl: 'https://jobs.lever.co/fixture/1/apply', createdAt: Date.now() - 86400000, updatedAt: Date.now(), description: body }]), { status: 200 })));
    const jobs = await producer();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ ...unknown, title: 'Software Engineer' });
    expect(jobs[0].crawledAt).toBeTruthy();
  });
}
it('GHOL: collection and unverified campaign dates cannot become publication', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ campaigns: [{ _id: 'fixture', title: { '1': 'Infirmier spécialisé' }, description: { '1': body }, language: 1, inviteKey: 'fixture', location: { city: 'Nyon', state: 'VD', country: 'CH', zip: '1260' }, createdAt: past(), updatedAt: past() }] }), { status: 200 })));
  const jobs = await fetchAllGholJobs();
  expect(jobs).toHaveLength(1);
  expect(jobs[0]).toMatchObject(unknown);
  expect(jobs[0].crawledAt).toBeTruthy();
});
for (const kind of ['valid', 'missing', 'invalid-calendar', 'future'] as const) {
  const value = () => kind === 'valid' ? past() : kind === 'missing' ? '' : kind === 'invalid-calendar' ? `${new Date().getUTCFullYear()}-02-30T12:00:00Z` : new Date(Date.now() + 3600000).toISOString();
  describe(`${kind} SuccessFactors source publication`, () => {
    it('Schindler carries the real detail microdata through its producer', async () => {
      const raw = value();
      vi.stubGlobal('fetch', vi.fn(async (input) => new Response(String(input).includes('/search/')
        ? '<tr><td><a class="jobTitle-link" href="/Schindler/job/Ebikon-Engineer-LU/1234567/">Engineer</a></td><td><span class="jobLocation">Ebikon, LU, CH</span></td></tr>'
        : `<h1>Engineer</h1><meta itemprop="datePosted" content="${raw}"><span class="jobdescription">${body}</span></div>`, { status: 200 })));
      const jobs = await fetchAllSchindlerJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject(kind === 'valid' ? { datePosted: raw, postedDate: raw, postingDateSource: 'reported' } : unknown);
    });
    it('Tertianum keeps the complete explicit timestamp and rejects invalid source', async () => {
      const raw = value();
      vi.stubGlobal('fetch', vi.fn(async (input) => new Response(String(input).endsWith('sitemap.xml')
        ? '<urlset><url><loc>https://jobs.tertianum.ch/job/Zurich-Engineer-ZH-8000/1234567/</loc></url></urlset>'
        : `<html lang="de"><meta property="og:title" content="Engineer"><meta itemprop="datePosted" content="${raw}"><div class="joblayouttoken displayDTM">${body}</div></div></div></div></html>`, { status: 200 })));
      const jobs = await fetchAllTertianumJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject(kind === 'valid' ? { datePosted: raw, postedDate: raw, postingDateSource: 'reported' } : unknown);
    });
  });
}
it('Schindler validates localized listing days and preserves Java/ISO time precision', () => {
  const year = new Date().getUTCFullYear() - 1;
  expect(parseDate(`Feb 30, ${year}`)).toBe('');
  expect(parseDate(`31.02.${year}`)).toBe('');
  expect(parseDate(`Mai 12, ${year}`)).toBe(`${year}-05-12`);
  expect(parseDate(`Fri Oct 02 02:00:00 UTC ${year}`)).toBe(`${year}-10-02T02:00:00Z`);
  expect(parseDate(`${year}-10-02T10:00:00+02:00`)).toBe(`${year}-10-02T10:00:00+02:00`);
});

for (const hasDetailDate of [false, true]) {
  it(`Schindler isolates adjacent listing rows when the first detail date is ${hasDetailDate ? 'reported' : 'absent'}`, async () => {
    const year = new Date().getUTCFullYear() - 1;
    const detailDate = `${year}-06-15T10:00:00+02:00`;
    const listing = `<table><tr><td><a class="jobTitle-link" href="/Schindler/job/Ebikon-Engineer-LU/1234567/">First Engineer</a></td></tr>
      <tr><td><a class="jobTitle-link" href="/Schindler/job/Zurich-Engineer-ZH/7654321/">Second Engineer</a></td>
      <td><span class="jobLocation">Zurich, ZH, CH</span></td><td><span class="jobDate">May 12, ${year}</span></td></tr></table>`;
    const parsed = parseSearchResults(listing);
    expect(parsed[0]).toMatchObject({ ...unknown, location: '' });
    expect(parsed[1]).toMatchObject({ postedDate: `${year}-05-12`, postingDateSource: 'reported', location: 'Zurich, ZH, CH' });
    vi.stubGlobal('fetch', vi.fn(async (input) => {
      const url = String(input);
      const date = hasDetailDate && url.includes('/1234567/') ? `<meta itemprop="datePosted" content="${detailDate}">` : '';
      return new Response(url.includes('/search/') ? listing : `<h1>Engineer</h1>${date}<span class="jobdescription">${body}</span></div>`, { status: 200 });
    }));
    const jobs = await fetchAllSchindlerJobs();
    expect(jobs).toHaveLength(2);
    const first = jobs.find((job) => job.url.includes('/1234567/'));
    expect(first).toMatchObject(hasDetailDate ? { datePosted: detailDate, postedDate: detailDate, postingDateSource: 'reported' } : unknown);
  });
}
