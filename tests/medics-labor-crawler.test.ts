import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  extractReflineJobPostingLocation,
} from '../scripts/lib/refline-common.mjs';
import { fetchAllMedicsLaborJobs } from '../scripts/lib/medics-labor-job-parser.mjs';

function htmlResponse(body: string) {
  return {
    ok: true,
    status: 200,
    text: async () => body,
  } as unknown as Response;
}

const DETAIL_URL = 'https://app.reflinejobs.io/1474/0135/pub/101/index.html';

const DETAIL_HTML = `<!doctype html>
<html><body>
  <h1 class="posTitle">Mitarbeiter:in Probenannahme</h1>
  <p>${'In dieser vielseitigen Funktion bearbeitest du Proben sorgfältig, koordinierst Abläufe und arbeitest eng mit dem Laborteam zusammen. '.repeat(8)}</p>
  <script type="application/ld+json">${JSON.stringify({
    '@type': 'JobPosting',
    title: 'Mitarbeiter:in Probenannahme',
    jobLocation: {
      '@type': 'Place',
      address: {
        '@type': 'PostalAddress',
        streetAddress: 'Zeughausstrasse 10',
        addressLocality: 'Mels',
        addressRegion: 'SG',
        postalCode: '8887',
        addressCountry: 'CH',
      },
    },
  })}</script>
</body></html>`;

const DETAIL_HTML_WITHOUT_POSTAL = DETAIL_HTML.replace(/,"postalCode":"8887"/, '');

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Refline structured job location fallback', () => {
  it('extracts a Swiss locality, canton and postal code from JobPosting JSON-LD', () => {
    expect(extractReflineJobPostingLocation(DETAIL_HTML)).toEqual({
      city: 'Mels',
      canton: 'SG',
      postal: '8887',
    });
  });

  it('uses the detail location when an anchor listing has no workplace', async () => {
    const listingHtml = `<a href="${DETAIL_URL}">Mitarbeiter:in Probenannahme</a>`;
    const fetchMock = vi.fn(async (url: string) => (
      String(url).startsWith('https://app.reflinejobs.io/1474/positions.html?lang=de')
        ? htmlResponse(listingHtml)
        : htmlResponse(DETAIL_HTML)
    ));
    vi.stubGlobal('fetch', fetchMock);

    const jobs = await fetchAllMedicsLaborJobs();

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      location: 'Mels',
      canton: 'SG',
      addressLocality: 'Mels',
      addressRegion: 'SG',
      postalCode: '8887',
    });
  });

  it('uses the configured safe postal fallback when structured location omits postalCode', async () => {
    const listingHtml = `<a href="${DETAIL_URL}">Mitarbeiter:in Probenannahme</a>`;
    const fetchMock = vi.fn(async (url: string) => (
      String(url).startsWith('https://app.reflinejobs.io/1474/positions.html?lang=de')
        ? htmlResponse(listingHtml)
        : htmlResponse(DETAIL_HTML_WITHOUT_POSTAL)
    ));
    vi.stubGlobal('fetch', fetchMock);

    const jobs = await fetchAllMedicsLaborJobs();

    expect(jobs[0]).toMatchObject({
      location: 'Mels',
      canton: 'SG',
      postalCode: '3001',
    });
  });

  it('keeps an explicit listing workplace instead of overriding it with JSON-LD', async () => {
    const listingHtml = `<div class="item workName">Bern</div><a href="${DETAIL_URL}">Mitarbeiter:in Probenannahme</a>`;
    const fetchMock = vi.fn(async (url: string) => (
      String(url).startsWith('https://app.reflinejobs.io/1474/positions.html?lang=de')
        ? htmlResponse(listingHtml)
        : htmlResponse(DETAIL_HTML)
    ));
    vi.stubGlobal('fetch', fetchMock);

    const jobs = await fetchAllMedicsLaborJobs();

    expect(jobs[0]).toMatchObject({
      location: 'Bern',
      canton: 'BE',
      postalCode: '3001',
    });
  });
});

// Only the posting's own text is published (issue 5253): the shared Refline
// factory used to publish a detail without a body (or under 40 words) as
// "{title} bei {company} in {workplace}." plus three benefits the ad never
// listed ("Faire Anstellungsbedingungen" …).
describe('Refline factory — posting without vacancy text', () => {
  it('publishes the posting with a body and skips the one without, never inventing text', async () => {
    const shortUrl = 'https://app.reflinejobs.io/1474/0136/pub/101/index.html';
    const listingHtml = `<a href="${DETAIL_URL}">Mitarbeiter:in Probenannahme</a><a href="${shortUrl}">Laborant:in EFZ</a>`;
    const shortDetail = `<!doctype html><html><body><h1 class="posTitle">Laborant:in EFZ</h1><p>Wir freuen uns auf deine Bewerbung.</p></body></html>`;
    const fetchMock = vi.fn(async (url: string) => {
      const href = String(url);
      if (href.startsWith('https://app.reflinejobs.io/1474/positions.html?lang=de')) return htmlResponse(listingHtml);
      return htmlResponse(href === shortUrl ? shortDetail : DETAIL_HTML);
    });
    vi.stubGlobal('fetch', fetchMock);

    const jobs = await fetchAllMedicsLaborJobs();

    expect(jobs.map((job: { title: string }) => job.title)).toEqual(['Mitarbeiter:in Probenannahme']);
    expect(jobs[0].description).toMatch(/^In dieser vielseitigen Funktion/);
    expect(jobs[0].description).not.toMatch(/Faire Anstellungsbedingungen/);
  });
});
