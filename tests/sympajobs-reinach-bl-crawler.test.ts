import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearPoliteFetchStateForTests } from '../scripts/lib/prospector/polite-fetch.mjs';
import { loadSpec, runSpecInProduction, templateToRegex } from '../scripts/lib/prospector/spec-crawler.mjs';
import {
  extractSympajobsDetailFields,
  fetchAllSympajobsReinachBlJobs,
  isSympajobsReinachBlJob,
  isTrustedDomain,
  SYMPAJOBS_REINACH_BL_KEY,
} from '../scripts/lib/sympajobs-reinach-bl-job-parser.mjs';

const DETAIL_URL = 'https://sympajobs.ch/job/reinigungsmitarbeiter-in-20-100/';
const BASEL_DETAIL_URL = 'https://sympajobs.ch/job/dachdecker-basel/';
const LISTING_URL = 'https://sympajobs.ch/jobs/';
const LISTING_ENDPOINT_URL = 'https://sympajobs.ch/jm-ajax/get_listings/';

const DESCRIPTION = `Sympajobs AG sucht eine zuverlässige Reinigungskraft für Einsätze in Reinach und der Region Basel. Sie reinigen Büros, Wohnungen und gewerbliche Räume sorgfältig und selbstständig. Erfahrung in der Reinigung ist von Vorteil, gute Deutschkenntnisse werden erwartet. Wir bieten eine gründliche Einführung, faire Arbeitsbedingungen, persönliche Betreuung und langfristige Einsatzmöglichkeiten in einem engagierten Team.`;

const DETAIL_HTML = `<html lang="de"><body><main><article class="single_job_listing">
  <h1>Reinigungsmitarbeiter/-in 20-100%</h1>
  <ul class="job_listing-meta">
    <li class="location">Hauptstrasse 32, 4153 Reinach BL</li>
    <li class="date-posted"><time datetime="2026-08-11">11.08.2026</time></li>
    <li class="job-type">Teilzeit</li>
  </ul>
  <div class="job_description"><p>${DESCRIPTION}</p></div>
</article></main></body></html>`;

const REGION_DETAIL_HTML = DETAIL_HTML.replace(
  'Hauptstrasse 32, 4153 Reinach BL',
  'Baselland, CH',
);
const BASEL_DETAIL_HTML = DETAIL_HTML
  .replace('Reinigungsmitarbeiter/-in 20-100%', 'Dachdecker Basel')
  .replace('Hauptstrasse 32, 4153 Reinach BL', 'Basel');

function htmlResponse(url: string, body: string) {
  return {
    ok: true,
    status: 200,
    url,
    headers: { get: () => null },
    body: { cancel: vi.fn() },
    text: async () => body,
  } as any;
}

describe('Sympajobs Reinach BL source-backed crawler', () => {
  beforeEach(() => clearPoliteFetchStateForTests());

  it('extracts the official WP Job Manager detail fields', () => {
    const detail = extractSympajobsDetailFields(DETAIL_HTML, DETAIL_URL);

    expect(detail).toMatchObject({
      title: 'Reinigungsmitarbeiter/-in 20-100%',
      company: 'Sympajobs AG',
      location: 'Hauptstrasse 32, 4153 Reinach BL',
      canton: 'BL',
      addressLocality: 'Reinach',
      addressRegion: 'BL',
      postalCode: '4153',
      streetAddress: 'Hauptstrasse 32',
      datePosted: '2026-08-11',
      postingDateSource: 'reported',
      employmentType: 'PART_TIME',
    });
    expect(detail.description).toBe(DESCRIPTION);
    expect(detail.locationCandidates).toEqual([expect.objectContaining({
      location: 'Hauptstrasse 32, 4153 Reinach BL',
      addressLocality: 'Reinach',
      streetAddress: 'Hauptstrasse 32',
      canton: 'BL',
    })]);
  });

  it('fails closed when the detail names no source-backed BL workplace', () => {
    const detail = extractSympajobsDetailFields(
      DETAIL_HTML.replace('4153 Reinach BL', 'Nordwestschweiz'),
      DETAIL_URL,
    );

    expect(detail.title).toBe('Reinigungsmitarbeiter/-in 20-100%');
    expect(detail.location).toBe('');
    expect(detail.locationCandidates).toEqual([]);
  });

  it('distinguishes the source canton label Baselland from Basel-Stadt', () => {
    const baselland = extractSympajobsDetailFields(REGION_DETAIL_HTML, DETAIL_URL);
    const basel = extractSympajobsDetailFields(BASEL_DETAIL_HTML, BASEL_DETAIL_URL);

    expect(baselland).toMatchObject({
      location: 'Baselland, CH',
      canton: 'BL',
      addressLocality: '',
      addressRegion: 'BL',
      addressCountry: 'CH',
    });
    expect(basel).toMatchObject({
      location: 'Basel',
      canton: 'BS',
      addressLocality: 'Basel',
      addressRegion: 'BS',
    });
  });

  it('uses the learned official detail template and rejects unrelated domains', () => {
    const spec = loadSpec(SYMPAJOBS_REINACH_BL_KEY);
    expect(spec.candidateKey).toBe('sympajobs@reinach-bl');
    expect(spec.listingEndpoint).toMatchObject({
      url: LISTING_ENDPOINT_URL,
      method: 'GET',
      params: expect.objectContaining({ per_page: '100' }),
    });
    expect(templateToRegex(spec.detailTemplate).test(new URL(DETAIL_URL).pathname)).toBe(true);
    expect(isTrustedDomain(DETAIL_URL)).toBe(true);
    expect(isTrustedDomain('https://www.jobup.ch/fr/')).toBe(false);
    expect(isSympajobsReinachBlJob({ companyKey: SYMPAJOBS_REINACH_BL_KEY })).toBe(true);
    expect(isSympajobsReinachBlJob({ companyKey: 'other-company', url: 'https://other.ch/job/test/' })).toBe(false);
  });

  it('publishes only the source-backed BL detail with a canonical URL', async () => {
    const listingHtml = `
      <li class="job_listing"><a href="/job/reinigungsmitarbeiter-in-20-100/"><h3>Reinigungsmitarbeiter/-in 20-100%</h3></a></li>
      <li class="job_listing"><a href="/job/dachdecker-basel/"><h3>Dachdecker Basel</h3></a></li>`;
    const requests: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      requests.push(url);
      if (url.endsWith('/robots.txt')) return htmlResponse(url, 'User-agent: *\nAllow: /');
      if (url.startsWith(LISTING_ENDPOINT_URL)) {
        return htmlResponse(url, JSON.stringify({
          found_jobs: 2,
          max_num_pages: 1,
          html: listingHtml,
        }));
      }
      expect(url).not.toBe(LISTING_URL);
      return htmlResponse(url, url === BASEL_DETAIL_URL ? BASEL_DETAIL_HTML : REGION_DETAIL_HTML);
    });
    const runtime = {
      fetchImpl,
      lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
      sleepImpl: async () => {},
      retries: 0,
      headers: { 'Accept-Encoding': 'identity' },
    };

    const rows = await runSpecInProduction({ ...loadSpec(SYMPAJOBS_REINACH_BL_KEY) } as any, {
      ...runtime,
      detailExtractor: extractSympajobsDetailFields,
    });
    const jobs = await fetchAllSympajobsReinachBlJobs(runtime);

    expect(rows).toHaveLength(2);
    expect(rows).toEqual(expect.arrayContaining([expect.objectContaining({
      url: DETAIL_URL,
      location: 'Baselland, CH',
      canton: 'BL',
      postingDateSource: 'reported',
    }), expect.objectContaining({
      url: BASEL_DETAIL_URL,
      location: 'Basel',
      canton: 'BS',
    })]));
    expect(jobs).toEqual([expect.objectContaining({
      url: DETAIL_URL,
      applyUrl: DETAIL_URL,
      companyKey: SYMPAJOBS_REINACH_BL_KEY,
      title: 'Reinigungsmitarbeiter/-in 20-100%',
      canton: 'BL',
      location: 'Baselland, CH',
      addressLocality: '',
      description: DESCRIPTION,
      datePosted: '2026-08-11',
    })]);
    const endpointRequest = requests.find((url) => url.startsWith(LISTING_ENDPOINT_URL));
    expect(endpointRequest).toBeTruthy();
    const endpointQuery = new URL(endpointRequest!).searchParams;
    expect(endpointQuery.get('page')).toBe('1');
    expect(endpointQuery.get('per_page')).toBe('100');
  });
});
