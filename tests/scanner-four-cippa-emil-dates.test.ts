import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { CIPPATRASPORTI_CAREER_URL, fetchAllCippatrasportiJobs } from '../scripts/lib/cippatrasporti-job-parser.mjs';
import { fetchAllEmilFreyJobs } from '../scripts/lib/emil-frey-job-parser.mjs';
const UNKNOWN = { postedDate: '', datePosted: '', postingDateSource: 'unknown' };
const reported = (value: string) => ({ postedDate: value, datePosted: value, postingDateSource: 'reported' });
const DAY = '2020-06-15';
const FULL = `${DAY}T23:40:12.123+02:00`;
const fixtures = new URL('./fixtures/cippatrasporti/', import.meta.url);
const rawListing = readFileSync(new URL('listing.html', fixtures), 'utf8');
const rawCustomer = readFileSync(new URL('customer-detail.html', fixtures), 'utf8');
const rawOcean = readFileSync(new URL('ocean-detail.html', fixtures), 'utf8');
afterEach(() => vi.unstubAllGlobals());
async function fetchCippa(raw: unknown, listingDate = '15/06/2020') {
  const listing = rawListing.replace('{{CUSTOMER_POSTED_DATE}}', listingDate).replace('{{OCEAN_POSTED_DATE}}', '15/06/2020');
  const customer = rawCustomer.replace('"{{CUSTOMER_POSTED_DATE}}"', JSON.stringify(raw));
  const ocean = rawOcean.replace('{{OCEAN_POSTED_DATE}}', DAY);
  return fetchAllCippatrasportiJobs({
    fetchPage: vi.fn(async (url: string, options: { validateRedirectUrl?: (url: string) => unknown }) => {
      options.validateRedirectUrl?.(url);
      if (url === CIPPATRASPORTI_CAREER_URL) return listing;
      return url.includes('Customer-Service') ? customer : ocean;
    }),
    sleep: async () => {},
  });
}
it.each([DAY, FULL])('Cippa preserves explicit source publication %s through fetch→builder', async (raw) => {
  const jobs = await fetchCippa(raw);
  expect(jobs).toHaveLength(2);
  expect(jobs[0]).toMatchObject({ ...reported(raw), title: 'Customer Service Transport Specialist', location: 'Chiasso', canton: 'TI' });
  expect(jobs[0].description).toContain('Monitora le spedizioni');
});
it.each(['', null])('Cippa falls back to explicitly labelled listing when detail date is %s', async (raw) => {
  const jobs = await fetchCippa(raw);
  expect(jobs[0]).toMatchObject(reported(DAY));
});
it.each(['2020-02-31', '2020-06-15suffix', '2020-06-15T25:00:00Z', '2999-06-15', '2020-06-16', 1592179200000])('Cippa rejects invalid or contradictory detail date %s', async (raw) => {
  await expect(fetchCippa(raw)).rejects.toThrow(/date disagrees/);
});
it.each(['', '31/02/2020', '15/06/2999'])('Cippa retains strict listing gate for %s', async (raw) => {
  await expect(fetchCippa(DAY, raw)).rejects.toThrow(/malformed listing row/);
});

const EMIL_URL = 'https://jobs.emilfrey.ch/Automobil-Mechatroniker-de-j123.html';
const TITLE = 'Automobil Mechatroniker';
const BODY = 'Sie führen Reparaturen und Wartungsarbeiten an Fahrzeugen durch und betreuen unsere Kunden mit grosser Sorgfalt.';
const emilListing = `<article class="joboffer_container"><a href="${EMIL_URL}">${TITLE}</a><span class="job_standort">Zürich</span></article>`;
async function fetchEmil(raw: unknown, extra: Record<string, unknown> = {}, duplicate = false) {
  const posting = { '@type': 'JobPosting', title: TITLE, datePosted: raw, description: BODY, url: EMIL_URL, jobLocation: { address: { addressLocality: 'Zürich', addressCountry: 'CH' } }, ...extra };
  const detail = `<script type="application/ld+json">${JSON.stringify(duplicate ? [posting, posting] : posting)}</script>`;
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => new Response(String(input) === EMIL_URL ? detail : emilListing)));
  return fetchAllEmilFreyJobs();
}
it.each([DAY, FULL])('Emil Frey preserves identified source publication %s', async (raw) => {
  const jobs = await fetchEmil(raw);
  expect(jobs).toHaveLength(1);
  expect(jobs[0]).toMatchObject({ ...reported(raw), title: TITLE, description: BODY, location: 'Zürich', canton: 'ZH', url: EMIL_URL });
});
it.each([undefined, '', '2020-02-31', '2020-06-15suffix', '2020-06-15T25:00:00Z', '2999-06-15'])('Emil Frey emits unknown for missing/invalid/future date %s', async (raw) => {
  const jobs = await fetchEmil(raw);
  expect(jobs).toHaveLength(1);
  expect(jobs[0]).toMatchObject({ ...UNKNOWN, description: BODY, url: EMIL_URL });
});
it.each([{ title: 'Foreign vacancy' }, { url: 'https://jobs.emilfrey.ch/Other-de-j999.html' }, { sameAs: 'https://foreign.example/job/' }])('Emil Frey rejects publication from mismatched identity %j', async (extra) => {
  const jobs = await fetchEmil(DAY, extra);
  expect(jobs[0]).toMatchObject(UNKNOWN);
});
it('Emil Frey rejects ambiguous postings without changing body extraction', async () => {
  const jobs = await fetchEmil(DAY, {}, true);
  expect(jobs[0]).toMatchObject({ ...UNKNOWN, description: BODY });
});
it('Emil Frey accepts a singleton without URL when the independent listing title matches', async () => {
  const jobs = await fetchEmil(FULL, { url: undefined });
  expect(jobs[0]).toMatchObject(reported(FULL));
});
