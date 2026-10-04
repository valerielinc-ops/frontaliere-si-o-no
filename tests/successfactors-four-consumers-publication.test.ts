import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAllBelimoJobs } from '../scripts/lib/belimo-job-parser.mjs';
import { fetchAllRolexJobs } from '../scripts/lib/rolex-job-parser.mjs';
import { fetchAllSonovaJobs } from '../scripts/lib/sonova-job-parser.mjs';
import { createBreezyHrParser } from '../scripts/lib/breezy-hr-common.mjs';

const body = 'You assemble and test products, document your work carefully, coordinate activities with engineering colleagues and support production improvements. Relevant technical experience, excellent communication skills and a structured approach are required. We offer flexible working hours, professional training, modern equipment, an international team and opportunities to develop your career within our manufacturing operation.';
const past = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10) + 'T00:15:00+02:00';
const future = new Date(Date.now() + 7 * 86400000).toISOString();
afterEach(() => vi.unstubAllGlobals());

const providers = [
  { name: 'Belimo', run: fetchAllBelimoJobs, listing: '<urlset><url><loc>https://jobsredirect.belimo.com/job/Hinwil-Engineer-8340/9999999/</loc></url></urlset>', listingMatch: '/sitemap.xml' },
  { name: 'Rolex', run: fetchAllRolexJobs, listing: '<table><tr class="data-row"><td><a href="/Rolex/job/Geneve-Engineer/1180001/" class="jobTitle-link">Technical Engineer</a><span class="jobFacility">Genève</span></td></tr></table>', listingMatch: '/go/Toutes-nos-offres-Rolex/' },
  { name: 'Sonova', run: fetchAllSonovaJobs, listing: '<div data-url="/job/Staefa-Engineer/1180001/"><a class="jobTitle-link">Technical Engineer</a><div id="job-location-value">Staefa, Switzerland</div></div>', listingMatch: '/tile-search-results/' },
];

for (const provider of providers) {
  describe(`${provider.name} publication provenance through the real producer`, () => {
    it.each([['reported', past], ['missing', ''], ['invalid', '2026-02-30'], ['future', future]])('%s source keeps an atomic validated tuple', async (kind, raw) => {
      const detail = `<html><h1 itemprop="title">Technical Engineer</h1><meta itemprop="addressCountry" content="CH"><meta itemprop="addressLocality" content="Hinwil"><meta itemprop="postalCode" content="8340"><meta itemprop="datePosted" content="${raw}"><div itemprop="description">${body}</div><span class="jobdescription">${body}</span></html>`;
      vi.stubGlobal('fetch', vi.fn(async (url: unknown) => new Response(String(url).includes(provider.listingMatch) ? provider.listing : detail, { status: 200 })));
      const jobs = await provider.run();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject(kind === 'reported'
        ? { postingDateSource: 'reported', postedDate: past, datePosted: past }
        : { postingDateSource: 'unknown', postedDate: '', datePosted: '' });
      expect(Number.isFinite(Date.parse(jobs[0].crawledAt))).toBe(true);
    });
  });
}

describe('Breezy detail and genuine listing publication fallback', () => {
  it.each([
    ['detail', past, '', past],
    ['invalid detail with valid listing', '2026-02-30', past, past],
    ['invalid listing', '', 'not-a-date', ''],
    ['future sources', future, future, ''],
    ['missing sources', '', '', ''],
  ])('%s', async (_label, detailDate, listingDate, expected) => {
    const listing = [{ id: '1', friendly_id: 'engineer', name: 'Technical Engineer', published_date: listingDate }];
    const detail = `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title: 'Technical Engineer', description: body, datePosted: detailDate })}</script>`;
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => new Response(String(url).endsWith('/json') ? JSON.stringify(listing) : detail, { status: 200 })));
    const parser = createBreezyHrParser({ companyKey: 'fixture', companyName: 'Fixture', breezyTenant: 'fixture', companyDomain: 'fixture.test', defaultCity: 'Fribourg', defaultCanton: 'FR' });
    const jobs = await parser.fetchAllJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ postingDateSource: expected ? 'reported' : 'unknown', postedDate: expected, datePosted: expected });
    expect(Number.isFinite(Date.parse(jobs[0].crawledAt))).toBe(true);
  });
});
