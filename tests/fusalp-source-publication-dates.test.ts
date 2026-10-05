import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAllFusalpJobs } from '../scripts/lib/fusalp-job-parser.mjs';

const origin = 'https://fusalp.welcomekit.co';
const url = `${origin}/jobs/sales-crans-montana`;
const date = '2025-09-29T23:45:12+02:00';
const description = 'Notre équipe accompagne les clients avec attention et propose des produits de qualité. Le poste demande de la collaboration et une bonne connaissance des besoins des clients. '.repeat(4);
const posting = (raw: unknown) => ({ '@type': 'JobPosting', url, title: 'Conseiller de vente', datePosted: raw, description, jobLocation: { address: { addressLocality: 'Crans-Montana', addressCountry: 'CH', postalCode: '3963' } } });
const listing = `<li class='jobs-list-item'><a href="/jobs/sales-crans-montana"><h3>Conseiller de vente</h3></a></li>`;
function stubDetail(value: unknown, before = '') {
  const detail = `${before}<script type="application/ld+json">${JSON.stringify(value)}</script>`;
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    if (String(input) === origin) return new Response(listing);
    if (String(input) === url) return new Response(detail);
    throw new Error(`Unexpected request: ${input}`);
  }));
}
afterEach(() => vi.unstubAllGlobals());
async function expectPublication(expected = '') {
  const jobs = await fetchAllFusalpJobs();
  expect(jobs).toHaveLength(1);
  expect(jobs[0]).toMatchObject({ url, companyKey: 'fusalp', canton: 'VS', datePosted: expected, postedDate: expected ? expected.slice(0, 10) : '', postingDateSource: expected ? 'reported' : 'unknown' });
  expect(jobs[0].description.split(/\s+/).length).toBeGreaterThan(50);
}
describe('Fusalp publication evidence through the real fetch and builder', () => {
  for (const [label, raw] of [['timestamp', date], ['missing', undefined], ['invalid', '2025-02-30T12:00:00Z'], ['future', '2999-01-01T12:00:00Z']]) {
    it(`${label}: never substitutes crawl time`, async () => {
      stubDetail(posting(raw));
      await expectPublication(label === 'timestamp' ? date : '');
    });
  }
  it('does not attest a URL-less posting', async () => {
    stubDetail({ ...posting(date), url: undefined });
    await expectPublication();
  });
  it('does not borrow a date from a different vacancy URL', async () => {
    stubDetail({ ...posting(date), url: `${origin}/jobs/another-vacancy` });
    await expectPublication();
  });
  it('rejects conflicting sameAs even when url matches', async () => {
    stubDetail({ ...posting(date), sameAs: `${origin}/jobs/another-vacancy` });
    await expectPublication();
  });
  it('uses matching sameAs when url is absent and ignores Organization dates', async () => {
    stubDetail({ ...posting(date), url: undefined, sameAs: url }, '<script type="application/ld+json">{"@type":"Organization","datePosted":"2020-01-01"}</script>');
    await expectPublication(date);
  });
  it('rejects a non-string date without losing the vacancy', async () => {
    stubDetail(posting({ value: date }));
    await expectPublication();
  });
});
