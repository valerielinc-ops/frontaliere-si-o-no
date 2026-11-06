/**
 * Retired Italian fuel-station leaves must recover to their live city daily
 * page at the edge, including URLs that are not already in the compat store.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// @ts-expect-error — plain JS Worker module.
import worker from '../infra/cloudflare-worker/locale-router.js';

const APEX = 'https://frontaliereticino.ch';
const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;

const CASES = [
  [
    '/prezzi-benzina/italia/mandello-del-lario/stazioni/agip-eni-strada-statale-91/',
    '/prezzi-benzina/italia/mandello-del-lario/oggi/',
  ],
  [
    '/en/diesel-price-switzerland/italy/mandello-del-lario/stations/itala-petroli-provinciale-72/',
    '/en/diesel-price-switzerland/italy/mandello-del-lario/today/',
  ],
  [
    '/de/benzinpreis-schweiz/italien/mandello-del-lario/tankstellen/agip-eni-strada-statale-91/',
    '/de/benzinpreis-schweiz/italien/mandello-del-lario/heute/',
  ],
  [
    '/fr/prix-essence-suisse/italie/mandello-del-lario/stations/agip-eni-strada-statale-91/',
    '/fr/prix-essence-suisse/italie/mandello-del-lario/aujourd-hui/',
  ],
] as const;

beforeEach(() => {
  vi.stubGlobal('caches', { default: { match: async () => undefined, put: async () => {} } });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mockOrigins(livePath: string, liveStatus = 200) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw);
    if (url.pathname === livePath) return new Response('city page', { status: liveStatus });
    return new Response('origin 404', { status: 404 });
  });
}

describe('locale-router Italian fuel-station 301', () => {
  it.each(CASES)('redirects %s to its city daily page', async (orphanPath, canonicalPath) => {
    const fetchMock = mockOrigins(canonicalPath);
    const response = await worker.fetch(new Request(`${APEX}${orphanPath}?utm_source=gsc`), {}, ctx);

    expect(response.status).toBe(301);
    expect(response.headers.get('Location')).toBe(`${canonicalPath}?utm_source=gsc`);
    expect(fetchMock.mock.calls.some(([input]) => {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return new URL(raw).pathname === canonicalPath;
    })).toBe(true);
  });

  it.each(CASES)('keeps %s as a 404 when the city target is not live', async (orphanPath) => {
    mockOrigins('/not-the-requested-target/');
    const response = await worker.fetch(new Request(`${APEX}${orphanPath}`), {}, ctx);

    expect(response.status).toBe(404);
    expect(response.headers.get('Location')).toBeNull();
  });
});
