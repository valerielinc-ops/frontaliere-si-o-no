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
});
