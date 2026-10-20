import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error — standalone JavaScript Worker.
import worker from '../infra/cloudflare-worker/locale-router.js';

const APEX = 'https://frontaliereticino.ch';
const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;

beforeEach(() => vi.stubGlobal('caches', { default: { match: async () => undefined, put: async () => {} } }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function mockFetch(prefix: string | null, { targetStatus = 200, expectedOrigin = '' } = {}) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname.includes('/job-canon/')) return Response.json(prefix ? { 'known-job': { it: prefix, en: prefix, de: prefix, fr: prefix } } : {});
    if (prefix && url.pathname === `${prefix}/known-job/` && (!expectedOrigin || url.hostname === expectedOrigin)) {
      return new Response('job', { status: targetStatus });
    }
    return new Response('missing', { status: 404 });
  });
}

describe.each(['GET', 'HEAD'])('registry-confirmed vacancy aliases with a source id suffix (%s)', (method) => {
  it.each([
    ['/cerca-lavoro-zurigo', 'it'], ['/en/find-jobs-zurich', 'en'],
    ['/de/jobs-in-zurich', 'de'], ['/fr/trouver-emploi-zurich', 'fr'],
  ])('301s a known alias within its language: %s', async (prefix) => {
    const fetchMock = mockFetch(prefix);
    const response = await worker.fetch(new Request(`${APEX}${prefix}/known-job/5162?utm_source=gsc`, { method }), {}, ctx);
    expect(response.status).toBe(301);
    expect(response.headers.get('Location')).toBe(`${prefix}/known-job/?utm_source=gsc`);
    expect(await response.text()).toBe('');
    const probe = fetchMock.mock.calls.find(([input]) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      return url.pathname === `${prefix}/known-job/`;
    });
    expect(probe).toBeDefined();
    // HEAD must use the same GET evidence as GET, not infer availability from a
    // possibly different origin HEAD/cache response.
    const input = probe![0];
    expect(probe![1]?.method ?? (input instanceof Request ? input.method : 'GET')).toBe('GET');
  });

  it('verifies a canton migration on the destination shard', async () => {
    mockFetch('/cerca-lavoro-appenzello', { expectedOrigin: 'origin-appenzello-it.frontaliereticino.ch' });
    const response = await worker.fetch(new Request(`${APEX}/cerca-lavoro-ticino/known-job/1150`, { method }), {}, ctx);
    expect(response.status).toBe(301);
    expect(response.headers.get('Location')).toBe('/cerca-lavoro-appenzello/known-job/');
  });

  it('also preserves method parity for a registry-confirmed canton migration without a numeric suffix', async () => {
    mockFetch('/de/jobs-im-luzern');
    const response = await worker.fetch(new Request(`${APEX}/de/jobs-in-nidwalden/known-job/?utm_source=gsc`, { method }), {}, ctx);
    expect(response.status).toBe(301);
    expect(response.headers.get('Location')).toBe('/de/jobs-im-luzern/known-job/?utm_source=gsc');
    expect(await response.text()).toBe('');
  });

  it.each([404, 410, 429, 503])('distinguishes a missing vacancy from unavailable target verification (%s)', async (targetStatus) => {
    mockFetch('/cerca-lavoro-zurigo', { targetStatus });
    const response = await worker.fetch(new Request(`${APEX}/cerca-lavoro-zurigo/known-job/5162`, { method }), {}, ctx);
    expect(response.status).toBe(targetStatus === 404 || targetStatus === 410 ? 404 : 503);
    expect(response.headers.get('Location')).toBeNull();
    if (response.status === 503) expect(response.headers.get('Retry-After')).toBe('60');
  });

  it.each(['/known-job/5162', '/known-job/extra/', '/known-job/5162/extra/', '/search-foo/2000', '/ricerca-foo/2000', '/azienda-foo/2000'])('does not guess a target without registry evidence: %s', async (suffix) => {
    mockFetch(null);
    expect((await worker.fetch(new Request(`${APEX}/cerca-lavoro-zurigo${suffix}`, { method }), {}, ctx)).status).toBe(404);
  });

  it('keeps a numeric search-like orphan off the English national board', async () => {
    mockFetch(null);
    const response = await worker.fetch(new Request(`${APEX}/en/find-jobs-zurich/search-foo/2000`, { method }), {}, ctx);
    expect(response.status).toBe(404);
    expect(response.headers.get('Location')).toBeNull();
  });

  it.each(['network', 'bad-json', 'bad-schema', 'server'])('does not report absence after a %s job-canon failure', async (mode) => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname.includes('/job-canon/')) {
        if (mode === 'network') throw new TypeError('Network unavailable');
        if (mode === 'bad-json') return new Response('{');
        if (mode === 'bad-schema') return Response.json([]);
        return new Response('unavailable', { status: 503 });
      }
      return new Response('missing', { status: 404 });
    });
    const response = await worker.fetch(new Request(`${APEX}/cerca-lavoro-zurigo/known-job/5162`, { method }), {}, ctx);
    expect(response.status).toBe(503);
    expect(response.headers.get('Location')).toBeNull();
  });

  it('uses a verified physical fallback even when a different layout is unavailable', async () => {
    let unavailableLayoutProbes = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname.includes('/job-canon/')) return Response.json({ 'known-job': { it: '/cerca-lavoro-ticino' } });
      if (url.pathname.includes('/_tree/') && url.pathname.endsWith('/known-job/')) {
        unavailableLayoutProbes += 1;
        return new Response('unavailable', { status: 503 });
      }
      return new Response('page', { status: url.pathname === '/cerca-lavoro-ticino/known-job/' ? 200 : 404 });
    });
    const response = await worker.fetch(new Request(`${APEX}/cerca-lavoro-ticino/known-job/5162`, { method }), {}, ctx);
    expect(unavailableLayoutProbes).toBeGreaterThan(0);
    expect(response.status).toBe(301);
    expect(response.headers.get('Location')).toBe('/cerca-lavoro-ticino/known-job/');
  });
});

it.each(['POST', 'PUT', 'DELETE'])('does not turn a %s into a permanent vacancy redirect', async (method) => {
  const fetchMock = mockFetch('/cerca-lavoro-zurigo');
  const response = await worker.fetch(new Request(`${APEX}/cerca-lavoro-zurigo/known-job/5162/`, { method }), {}, ctx);
  expect(response.status).toBe(404);
  expect(response.headers.get('Location')).toBeNull();
  expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/job-canon/'))).toBe(false);
});
