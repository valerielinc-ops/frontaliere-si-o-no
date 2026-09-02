import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ politeFetch: vi.fn() }));

vi.mock('../scripts/lib/prospector/polite-fetch.mjs', async (importOriginal) => ({
  ...await importOriginal<typeof import('../scripts/lib/prospector/polite-fetch.mjs')>(),
  politeFetch: mocks.politeFetch,
}));

import { traceCareers } from '../scripts/lib/prospector/careers-trail.mjs';

const response = (url: string, body: string) => ({ ok: true, status: 200, url, body, host: url ? new URL(url).hostname : '' });
const filler = '<p>Informazioni autorevoli sulla struttura alberghiera, i servizi e il territorio.</p>'.repeat(6);

describe('prospector careers ownership trail', () => {
  beforeEach(() => mocks.politeFetch.mockReset());

  it('does not promote a homepage fallback or its partner-logo footer', async () => {
    const homepage = `<html><title>Villa Garni Gardenia</title><body><main>Benvenuti a Caslano${filler}</main><footer><a href="https://www.hotelleriesuisse.ch/it/"><img alt="Partner"></a></footer></body></html>`;
    mocks.politeFetch.mockImplementation(async (url: string) => response(url, homepage));

    const result = await traceCareers('albergo-gardenia.ch');

    expect(result.careersUrls).toEqual([]);
    expect(result.externalHosts).toEqual([]);
    expect(result.selfHosted).toBe(false);
    expect(result.via).not.toContain('path-probe');
  });

  it('retains a page-specific external ATS after vacancy verification', async () => {
    const homeUrl = 'https://hotel.example/';
    const careerUrl = 'https://hotel.example/jobs';
    const atsUrl = 'https://tenant.real-ats.example/openings';
    const homepage = `<html><title>Hotel</title><body><a href="/jobs">Jobs</a><main>${filler}</main><footer><a href="https://partner.example/">Partner</a></footer></body></html>`;
    const careers = `<html><title>Hotel careers</title><body><h1>Join us</h1><main>${filler}</main><a href="https://partner.example/">Partner</a><a href="${atsUrl}">Apply</a></body></html>`;
    const ats = `<html><title>Hotel jobs</title><body><script type="application/ld+json">${JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'JobPosting',
      title: 'Receptionist',
      description: 'Join our hotel reception team and handle guest arrivals, bookings and service requests.',
      url: `${atsUrl}/receptionist`,
      hiringOrganization: { '@type': 'Organization', name: 'Hotel' },
      jobLocation: { '@type': 'Place', address: { '@type': 'PostalAddress', addressLocality: 'Lugano', addressCountry: 'CH' } },
    })}</script><a href="${atsUrl}/receptionist">Receptionist — apply now</a></body></html>`;

    mocks.politeFetch.mockImplementation(async (url: string) => {
      if (url === homeUrl) return response(url, homepage);
      if (url === careerUrl) return response(url, careers);
      if (url === atsUrl) return response(url, ats);
      return { ok: false, status: 404, url, body: '', host: url ? new URL(url).hostname : '' };
    });

    const result = await traceCareers('hotel.example');

    expect(result.careersUrls).toEqual([careerUrl]);
    expect(result.externalHosts).toHaveLength(1);
    expect(result.externalHosts[0]).toMatchObject({ host: 'tenant.real-ats.example', verified: true });
    expect(result.externalHosts.some(({ host }) => host === 'partner.example')).toBe(false);
  });

  it('keeps the ownership check aligned with a cross-origin homepage redirect', async () => {
    const requestedDomain = 'acme.ch';
    const redirectedHomeUrl = 'https://acme-official.example/';
    const careersUrl = 'https://acme-official.example/lavora-con-noi';
    const atsUrl = 'https://tenant.real-ats.example/openings';
    const homepage = `<html><title>Acme</title><body><a href="/lavora-con-noi">Lavora con noi</a><main>Benvenuti in Acme${filler}</main></body></html>`;
    const careers = `<html><title>Acme carriere</title><body><h1>Lavora con noi</h1><main>${filler}</main><a href="${atsUrl}">Posizioni aperte</a></body></html>`;
    const ats = `<html><title>Acme jobs</title><body><script type="application/ld+json">${JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'JobPosting',
      title: 'Contabile',
      description: 'Gestione della contabilità generale e supporto al team finance per un cliente storico.',
      url: `${atsUrl}/contabile`,
      hiringOrganization: { '@type': 'Organization', name: 'Acme' },
      jobLocation: { '@type': 'Place', address: { '@type': 'PostalAddress', addressLocality: 'Lugano', addressCountry: 'CH' } },
    })}</script><a href="${atsUrl}/contabile">Contabile — candidati ora</a></body></html>`;

    mocks.politeFetch.mockImplementation(async (url: string) => {
      // The homepage request is answered from a different registrable domain
      // than the one requested — a cross-origin redirect captured in `home.url`.
      if (url === `https://${requestedDomain}/`) return response(redirectedHomeUrl, homepage);
      if (url === careersUrl) return response(careersUrl, careers);
      if (url === atsUrl) return response(atsUrl, ats);
      return { ok: false, status: 404, url, body: '', host: url ? new URL(url).hostname : '' };
    });

    const result = await traceCareers(requestedDomain);

    // A stale ownership check keyed on the pre-redirect `requestedDomain`
    // would read the homepage's own relative careers link as pointing to an
    // unrelated third party (its resolved host never matches `acme.ch`),
    // dropping it as a candidate and never reaching the careers page at all.
    expect(result.via).toContain('homepage-link');
    expect(result.careersUrls).toEqual([careersUrl]);
    expect(result.externalHosts).toHaveLength(1);
    expect(result.externalHosts[0]).toMatchObject({ host: 'tenant.real-ats.example', verified: true });
  });

  it('keeps the homepage document stable across multiple candidate-loop iterations', async () => {
    // `home` is a single `let` binding captured once per `traceCareers()` call
    // and only ever READ inside the candidate loop — never reassigned or
    // mutated in place. This is what makes it safe to reuse across
    // iterations. Prove it behaviourally: two distinct career-page candidates
    // whose bodies are IDENTICAL to each other but different from the
    // homepage. If `home` were corrupted to reflect the first candidate's
    // page after processing it, the second candidate (same body as the
    // first) would then read as textually identical to the "homepage" and
    // get wrongly dropped by the `pageText === homeText` guard in
    // `isDistinctCareerSurface()`. Both must survive for `home` to be proven
    // unmutated.
    const homeUrl = 'https://acme.example/';
    const jobsAUrl = 'https://acme.example/jobs-a';
    const jobsBUrl = 'https://acme.example/jobs-b';
    const homepage = `<html><title>Acme</title><body><a href="/jobs-a">Jobs A</a><a href="/jobs-b">Jobs B</a><main>Benvenuti in Acme${filler}</main></body></html>`;
    const jobsPage = `<html><title>Acme jobs</title><body><h1>Jobs</h1><main>${filler}</main></body></html>`;

    const homeResponse = response(homeUrl, homepage);
    mocks.politeFetch.mockImplementation(async (url: string) => {
      if (url === homeUrl) return homeResponse;
      if (url === jobsAUrl) return response(jobsAUrl, jobsPage);
      if (url === jobsBUrl) return response(jobsBUrl, jobsPage);
      return { ok: false, status: 404, url, body: '', host: url ? new URL(url).hostname : '' };
    });

    const result = await traceCareers('acme.example');

    expect(result.careersUrls).toEqual([jobsAUrl, jobsBUrl]);
    // Defence in depth: the object the mock handed back for the homepage
    // request was never touched in place either.
    expect(homeResponse.body).toBe(homepage);
    expect(homeResponse.url).toBe(homeUrl);
  });
});
