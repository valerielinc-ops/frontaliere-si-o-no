import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { politeFetch } = vi.hoisted(() => ({ politeFetch: vi.fn() }));

vi.mock('../scripts/lib/prospector/polite-fetch.mjs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../scripts/lib/prospector/polite-fetch.mjs')>()),
  politeFetch,
}));

import { createPersistentGooglePlacesBudget } from '../scripts/lib/google-places-budget.mjs';
import { resolveDomain, verifyOwnership } from '../scripts/lib/prospector/domain-resolve.mjs';

const dnsMissing = () => Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
const lookupAbsent = async () => { throw dnsMissing(); };

function page(url: string, title: string, body = title) {
  return {
    ok: true,
    status: 200,
    url,
    body: `<html><head><title>${title}</title></head><body>${`${body} `.repeat(30)}</body></html>`,
  };
}

function place(domain: string, displayName: string, pathName = '/') {
  return {
    id: `ChIJ-${domain}`,
    displayName: { text: displayName },
    websiteUri: `https://${domain}${pathName}`,
  };
}

describe('Google Places domain resolver', () => {
  let dir = '';

  beforeEach(() => {
    politeFetch.mockReset();
    politeFetch.mockResolvedValue(page('https://cianilugano.ch/', 'Ristorante Ciani Lugano 6900 Lugano Svizzera'));
  });

  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  it('requests only the declared fields, reserves before the call, and keeps websiteUri transient', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prospector-google-places-'));
    const usageFile = path.join(dir, 'usage.json');
    const budget = createPersistentGooglePlacesBudget({
      file: usageFile,
      checkedAt: new Date(Date.now() - 60_000).toISOString(),
      monthlyLimit: 800,
    });
    let request;
    const result = await resolveDomain(
      { name: 'Ristorante Ciani Lugano', city: 'Lugano', zip: '6900' },
      {
        lookupImpl: lookupAbsent as never,
        googlePlaces: {
          apiKey: 'test-key',
          budget,
          fetchJson: async (url: string, init: Record<string, any>) => {
            request = { url, init };
            return { places: [place('cianilugano.ch', 'Ristorante Ciani Lugano')] };
          },
        },
      },
    );

    expect(result).toMatchObject({ domain: 'cianilugano.ch', source: 'google_places', score: expect.any(Number) });
    expect(result).toMatchObject({ placeId: 'ChIJ-cianilugano.ch' });
    expect(result.googlePlaces).toMatchObject({ requests: 1, places: 1, websites: 1, verified: 1, outcome: 'resolved' });
    expect(request.url).toBe('https://places.googleapis.com/v1/places:searchText');
    expect(request.init.headers['X-Goog-FieldMask']).toBe('places.id,places.displayName,places.websiteUri');
    expect(JSON.parse(request.init.body)).toEqual({ textQuery: 'Ristorante Ciani Lugano Lugano', regionCode: 'CH', pageSize: 1 });
    expect(JSON.stringify(result)).not.toContain('websiteUri');
    expect(JSON.parse(fs.readFileSync(usageFile, 'utf8'))).toMatchObject({ googlePlaces: { requests: 1 } });
  });

  it('uses the transient website path and decodes HTML entities before scoring', async () => {
    const budget = createPersistentGooglePlacesBudget({ monthlyLimit: 800 });
    politeFetch.mockImplementation(async (url: string) => String(url) === 'https://s10bistro.ch/about/'
      ? page(url, 'S10 Bistro Caff&egrave; 6830 Chiasso Svizzera')
      : { ok: false, status: 404, url, body: '' });
    const result = await resolveDomain(
      { name: 'S10 Bistro caffè', city: 'Chiasso', zip: '6830' },
      {
        lookupImpl: lookupAbsent as never,
        googlePlaces: {
          apiKey: 'test-key',
          budget,
          fetchJson: async () => ({ places: [place('s10bistro.ch', 'S10 Bistro caffè', '/about/')] }),
        },
      },
    );

    expect(result.domain).toBe('s10bistro.ch');
    expect(politeFetch).toHaveBeenCalledWith('https://s10bistro.ch/about/', expect.anything());
    expect(verifyOwnership(
      '<html><title>S10 Bistro Caff&egrave;</title><body>S10 Bistro Caff&egrave; 6830 Chiasso Svizzera '.repeat(20),
      { name: 'S10 Bistro caffè', city: 'Chiasso', zip: '6830' },
    ).score).toBeGreaterThanOrEqual(3);
  });

  it.each([
    ['Ristorante Aeroporto', 'Gordola', '6596', 'ristoranteaeroporto.ch', '/contatti/', 'Ristorante Aeroporto'],
    ['Egro Suisse', 'Mendrisio', '6850', 'egrosuisse.ch', '/', 'Egro Suisse'],
    ['Ormanni Sagl', 'Biasca', '6710', 'ormanni-falegnameria.ch', '/contatti/', 'Ormanni Falegnameria'],
    ['Spielkiste Schweiz AG', 'Lugano', '6900', 'spielkiste.ch', '/ueber-uns/', 'Spielkiste Schweiz AG'],
  ])('accepts the pilot website for %s when the exact URI path carries the identity', async (name, city, zip, domain, pathName, title) => {
    const budget = createPersistentGooglePlacesBudget({ monthlyLimit: 800 });
    const expectedUrl = `https://${domain}${pathName}`;
    politeFetch.mockImplementation(async (url: string) => String(url) === expectedUrl
      ? page(url, `${title} ${zip} ${city} Svizzera`)
      : { ok: false, status: 404, url, body: '' });
    const result = await resolveDomain(
      { name, city, zip },
      {
        lookupImpl: lookupAbsent as never,
        googlePlaces: {
          apiKey: 'test-key',
          budget,
          fetchJson: async () => ({ places: [place(domain, title, pathName)] }),
        },
      },
    );

    expect(result).toMatchObject({ domain, source: 'google_places', score: expect.any(Number) });
    expect(politeFetch).toHaveBeenCalledWith(expectedUrl, expect.anything());
  });

  it.each([
    ['Spotted', 'Basel', '4001', 'dorfladewasen.ch'],
    ['Experis', 'Lugano', '6900', 'manpower.ch'],
    ['Ufficio federale', 'Berna', '3003', 'admin.ch'],
  ])('rejects a shared or agency domain for %s', async (name, city, zip, domain) => {
    const budget = createPersistentGooglePlacesBudget({ monthlyLimit: 800 });
    politeFetch.mockResolvedValue(page(`https://${domain}/`, `${name} ${zip} ${city} Svizzera`));
    const result = await resolveDomain(
      { name, city, zip },
      {
        lookupImpl: lookupAbsent as never,
        googlePlaces: {
          apiKey: 'test-key',
          budget,
          fetchJson: async () => ({ places: [place(domain, name)] }),
        },
      },
    );
    expect(result.domain).toBeNull();
  });

  it('rejects a domain already owned by another employer', async () => {
    const budget = createPersistentGooglePlacesBudget({ monthlyLimit: 800 });
    const result = await resolveDomain(
      { name: 'Acme Holdings', city: 'Lugano', zip: '6900' },
      {
        lookupImpl: lookupAbsent as never,
        googlePlaces: {
          apiKey: 'test-key',
          budget,
          knownDomainOwners: new Map([['shared-employer.ch', new Set(['Other Employer'])]]),
          fetchJson: async () => ({ places: [place('shared-employer.ch', 'Acme Holdings')] }),
        },
      },
    );
    expect(result.domain).toBeNull();
  });

  it('falls back cleanly after a failed request consumes the persistent monthly slot', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prospector-google-places-'));
    const usageFile = path.join(dir, 'usage.json');
    const budget = createPersistentGooglePlacesBudget({
      file: usageFile,
      checkedAt: new Date(Date.now() - 60_000).toISOString(),
      monthlyLimit: 1,
    });
    let requests = 0;
    const googlePlaces = {
      apiKey: 'test-key',
      budget,
      fetchJson: async () => {
        requests += 1;
        return { places: [] };
      },
    };
    const options = { lookupImpl: lookupAbsent as never, googlePlaces };
    const first = await resolveDomain({ name: 'No Place Company', city: 'Lugano' }, options);
    const second = await resolveDomain({ name: 'Another Company', city: 'Lugano' }, options);

    expect(requests).toBe(1);
    expect(first).toMatchObject({ domain: null, googlePlaces: { requests: 1, outcome: 'no_place' } });
    expect(second).toMatchObject({ domain: null, googlePlaces: { requests: 0, outcome: 'budget_exhausted' } });
    expect(JSON.parse(fs.readFileSync(usageFile, 'utf8'))).toMatchObject({ googlePlaces: { requests: 1 } });
  });

  it.each([401, 403, 429])('stops on HTTP %s and never retries the API request', async (status) => {
    const budget = createPersistentGooglePlacesBudget({ monthlyLimit: 800 });
    let requests = 0;
    const googlePlaces = {
      apiKey: 'test-key',
      budget,
      fetchJson: async () => {
        requests += 1;
        throw Object.assign(new Error(`HTTP ${status}`), { status });
      },
    };
    const first = await resolveDomain({ name: 'No Place Company', city: 'Lugano' }, { lookupImpl: lookupAbsent as never, googlePlaces });
    const second = await resolveDomain({ name: 'Another Company', city: 'Lugano' }, { lookupImpl: lookupAbsent as never, googlePlaces });

    expect(requests).toBe(1);
    expect(first.googlePlaces).toMatchObject({ requests: 1, outcome: 'api_stopped', failureCode: `http_${status}` });
    expect(second.googlePlaces).toMatchObject({ requests: 0, outcome: 'api_stopped', failureCode: `http_${status}` });
  });
});
