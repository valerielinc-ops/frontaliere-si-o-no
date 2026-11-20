import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  extractCaritasDetailLocation,
  fetchAllCaritasSchweizJobs,
} from '../scripts/lib/caritas-schweiz-job-parser.mjs';

const DETAIL_URL = 'https://apply.refline.ch/126757/2397/pub/1/index.html';
const LISTING_URL = 'https://apply.refline.ch/126757/positions_grouped.html';
const TITLE = 'Fachperson Sozialberatung 80%';
const DESCRIPTION = 'Wir suchen eine engagierte Fachperson für die Beratung und Begleitung von Menschen in unterschiedlichen Lebenslagen. Sie arbeiten selbstständig, dokumentieren die Fälle sorgfältig und stimmen sich zuverlässig mit dem interdisziplinären Team ab. Eine anerkannte Ausbildung, gute Kommunikationsfähigkeit und Erfahrung in der sozialen Arbeit runden Ihr Profil ab. Wir bieten eine strukturierte Einführung, fachliche Weiterbildung und ein wertschätzendes Umfeld.';

const LISTING_HTML = `<div class="searchBox"><div class="title">Caritas Schweiz</div><table><tr><td class="position"><a href="${DETAIL_URL}">${TITLE}</a></td><td class="workplace">Luzern</td><td class="workload">80-100%</td></tr></table></div></form>`;

const DETAIL_HTML = `<html><head>
  <script type="application/ld+json">${JSON.stringify({
    '@type': 'JobPosting',
    title: 'Altra vacancy',
    url: 'https://apply.refline.ch/126757/9999/pub/1/index.html',
    jobLocation: { address: { addressLocality: 'Bern', addressRegion: 'BE', addressCountry: 'CH' } },
  })}</script>
  <script type="application/ld+json">${JSON.stringify({
    '@type': 'JobPosting',
    title: TITLE,
    url: DETAIL_URL,
    datePosted: '2026-11-01',
    jobLocation: {
      address: {
        addressLocality: 'Solothurn',
        addressRegion: 'SO',
        postalCode: '4500',
        addressCountry: 'CH',
      },
    },
  })}</script>
</head><body><h1>${TITLE}</h1><p>${DESCRIPTION}</p></body></html>`;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Caritas detail workplace precedence', () => {
  it('accepts a concrete Swiss JobPosting address and rejects a canton-only label', () => {
    expect(extractCaritasDetailLocation({
      jobLocation: { address: { addressLocality: 'Solothurn', addressRegion: 'SO', postalCode: '4500' } },
    })).toEqual({
      city: 'Solothurn',
      canton: 'SO',
      postal: '4500',
      addressRegion: 'SO',
      streetAddress: '',
    });
    expect(extractCaritasDetailLocation({
      jobLocation: { address: { addressLocality: 'Kanton Solothurn', addressRegion: 'SO' } },
    })).toBeNull();
  });

  it('uses the identity-matching detail workplace instead of the stale listing office', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      return new Response(url === DETAIL_URL ? DETAIL_HTML : LISTING_HTML, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=UTF-8' },
      });
    }));

    const jobs = await fetchAllCaritasSchweizJobs();

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      title: TITLE,
      location: 'Solothurn',
      addressLocality: 'Solothurn',
      addressRegion: 'SO',
      canton: 'SO',
      postalCode: '4500',
      datePosted: '2026-11-01',
    });
  });
});
