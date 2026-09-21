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
