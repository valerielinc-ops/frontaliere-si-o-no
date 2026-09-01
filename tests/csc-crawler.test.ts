import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  buildCscAdapterConfig,
  canonicalCscDetailUrl,
  fetchCscJobUrls,
  parseCscCareersPage,
  verifyCscDetailUrls,
} from '../scripts/update-csc-costruzioni-jobs.mjs';
import { __testables as sharedCrawlerTestables } from '../scripts/lib/shared-jobs-crawler.mjs';

type DetailFixture = { url: string; html: string };
type CscFixture = {
  listingWithJobs: string;
  authoritativeEmpty: string;
  degradedListing: string;
  details: DetailFixture[];
};

const fixture = JSON.parse(
  fs.readFileSync(path.resolve(import.meta.dirname, 'fixtures', 'csc-careers-pages.json'), 'utf8'),
) as CscFixture;
const careersUrl = 'https://csc-sa.ch/lavoro-carriera-edilizia';

function htmlResponse(url: string, html: string, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: { get: (name: string) => name.toLowerCase() === 'content-type' ? 'text/html; charset=UTF-8' : null },
    text: async () => html,
  };
}

function fixtureFetch(overrides: Record<string, ReturnType<typeof htmlResponse>> = {}) {
  const responses = new Map<string, ReturnType<typeof htmlResponse>>([
    [careersUrl, htmlResponse(careersUrl, fixture.listingWithJobs)],
    ...fixture.details.map((detail) => [detail.url, htmlResponse(detail.url, detail.html)] as const),
    ...Object.entries(overrides),
  ]);
  return vi.fn(async (url: string | URL) => {
    const response = responses.get(String(url));
    if (!response) throw new Error(`Unexpected URL ${url}`);
    return response;
  });
}

describe('CSC authoritative Drupal discovery', () => {
  it('recognises only the three CSC detail route families', () => {
    for (const detail of fixture.details) expect(canonicalCscDetailUrl(detail.url)).toBe(detail.url);
    expect(canonicalCscDetailUrl(careersUrl)).toBeNull();
    expect(canonicalCscDetailUrl('https://csc-sa.ch/node/24')).toBeNull();
    expect(canonicalCscDetailUrl('https://csc-sa.ch/node/321?preview=1')).toBeNull();
    expect(canonicalCscDetailUrl('https://other.example/node/321')).toBeNull();
    expect(canonicalCscDetailUrl('http://csc-sa.ch/node/321')).toBeNull();
  });

  it('verifies exact listing/detail parity before returning explicit seeds', async () => {
    const fetchImpl = fixtureFetch();
    const discovery = await fetchCscJobUrls({ fetchImpl, timeoutMs: 1000 });

    expect(discovery).toEqual({
      urls: fixture.details.map((detail) => detail.url),
      authoritativeEmpty: false,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1 + fixture.details.length);
    expect(new Set(discovery.urls).size).toBe(discovery.urls.length);
  });

  it('accepts the live-shaped explicit empty state without probing details', async () => {
    const fetchImpl = fixtureFetch({
      [careersUrl]: htmlResponse(careersUrl, fixture.authoritativeEmpty),
    });
    await expect(fetchCscJobUrls({ fetchImpl, timeoutMs: 1000 })).resolves.toEqual({
      urls: [],
      authoritativeEmpty: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('fails closed on truncated listings and partial detail responses', async () => {
    expect(() => parseCscCareersPage(fixture.degradedListing)).toThrow(/discovery degraded/);

    const failedUrl = fixture.details[1].url;
    const fetchImpl = fixtureFetch({ [failedUrl]: htmlResponse(failedUrl, '<html>upstream error</html>', 503) });
    await expect(fetchCscJobUrls({ fetchImpl, timeoutMs: 1000 })).rejects.toThrow(/HTTP 503/);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('rejects detail collisions and non-job response shells', async () => {
    const collisionFetch = vi.fn(async (url: string | URL) => {
      const detail = fixture.details[0];
      return htmlResponse(detail.url, detail.html);
    });
    await expect(verifyCscDetailUrls(
      fixture.details.slice(0, 2).map((detail) => detail.url),
      { fetchImpl: collisionFetch, timeoutMs: 1000 },
    )).rejects.toThrow(/collapsed to 1 canonical URLs/);

    const shellUrl = fixture.details[0].url;
    await expect(verifyCscDetailUrls([shellUrl], {
      fetchImpl: vi.fn(async () => htmlResponse(shellUrl, '<!doctype html><html><body>career shell</body></html>')),
      timeoutMs: 1000,
    })).rejects.toThrow(/did not return a canonical work-position page/);
  });

  it('builds an idempotent adapter with no generic listing seeds', () => {
    const seedDetailUrls = fixture.details.map((detail) => detail.url);
    const updatedAt = 'fixed-for-test';
    const adapter = buildCscAdapterConfig(
      { companyKey: 'csc-costruzioni', seedUrls: [careersUrl], notes: 'preserved' },
      seedDetailUrls,
      updatedAt,
    );
    expect(adapter).toMatchObject({ companyKey: 'csc-costruzioni', seedDetailUrls, notes: 'preserved', updatedAt });
    expect(adapter.seedUrls).toBeUndefined();
    expect(buildCscAdapterConfig(adapter, seedDetailUrls, updatedAt)).toEqual(adapter);

    const emptyAdapter = buildCscAdapterConfig(adapter, [], updatedAt);
    expect(emptyAdapter.seedUrls).toBeUndefined();
    expect(emptyAdapter.seedDetailUrls).toEqual([]);
  });

  it('routes all representative details through explicit trust with stable canonical URLs', () => {
    const parsedUrls = fixture.details.map((detail) => {
      const json = detail.html.match(/<script type=\"application\/ld\+json\">([\s\S]*?)<\/script>/)?.[1];
      expect(json).toBeTruthy();
      const parsed = sharedCrawlerTestables.toJobFromJsonLd(
        JSON.parse(String(json)),
        'CSC Costruzioni SA',
        detail.url,
        { isSeedDetail: true, seedMeta: { canton: 'TI', location: 'Lugano' } },
      );
      expect(parsed).toMatchObject({ reason: null, job: { url: detail.url, company: 'CSC Costruzioni SA', canton: 'TI' } });
      return parsed.job.url;
    });
    expect(parsedUrls).toEqual(fixture.details.map((detail) => detail.url));
    expect(new Set(parsedUrls).size).toBe(fixture.details.length);
  });
});
