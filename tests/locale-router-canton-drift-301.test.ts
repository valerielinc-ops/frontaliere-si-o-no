/**
 * Canton-drift 404 recovery in the Cloudflare locale-router Worker.
 *
 * A job slug is globally unique, but the canton (URL section) drifted between
 * crawls, orphaning the previously-indexed URL → 404. public/404.html recovers
 * these with a soft-404 + JS `location.replace`; the Worker upgrades the en/de/fr
 * shard traffic it already sees to a REAL HTTP 301 (full link-equity transfer)
 * when the slug is in the marker-selected /job-canon/releases/<build-id>/ map.
 * Unknown slugs keep the soft 404.
 *
 * The Worker fetches the shard origin (404 here) and then the map JSON from the
 * public apex; the mock dispatches on URL so each gets the right response.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — plain JS Worker module, no type declarations.
import worker, { jobCanonTarget, jobCanonV2ShardKey } from '../infra/cloudflare-worker/locale-router.js';
import { jobSlugShardKey } from '../services/jobSlugShards';

const APEX = 'https://frontaliereticino.ch';
const pendingCacheWrites: Promise<unknown>[] = [];
const cacheEntries = new Map<string, Response>();
let cacheMatchCount = 0;
let cachePutCount = 0;
const ctx = {
  waitUntil: (promise: Promise<unknown>) => pendingCacheWrites.push(promise),
} as unknown as ExecutionContext;

function cacheKey(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
}

function fetchUrl(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}

function loadBrowserJobCanonMapFetcher(): (slug: string, fetcher: typeof fetch) => Promise<unknown> {
  const source = readFileSync(resolve(process.cwd(), 'public/404.html'), 'utf8');
  const start = source.indexOf('function jobCanonV1ShardKey(');
  const end = source.indexOf('// Request locale', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const declaration = source.slice(start, end);
  return new Function(
    'JOB_CANON_CDN',
    `${declaration}\nreturn fetchJobCanonMap;`,
  )('https://cdn.frontaliereticino.ch') as (slug: string, fetcher: typeof fetch) => Promise<unknown>;
}

function seedJobAliasCache(source: string, value: Record<string, string>, ttl: number): void {
  const url = new URL(source);
  const normalizedPath = `${url.pathname.replace(/\/+$/, '')}/`;
  const locale = url.pathname.match(/^\/(en|de|fr)(?:\/|$)/)?.[1] ?? 'it';
  const key = new URL(url.origin);
  key.pathname = `/__worker-cache/job-alias/${locale}${normalizedPath}`;
  key.searchParams.set('build_id', '1001');
  cacheEntries.set(key.toString(), new Response(JSON.stringify(value), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${ttl}, s-maxage=${ttl}`,
    },
  }));
}

async function flushCacheWrites(): Promise<void> {
  await Promise.all(pendingCacheWrites.splice(0));
}

beforeEach(() => {
  cacheEntries.clear();
  pendingCacheWrites.length = 0;
  cacheMatchCount = 0;
  cachePutCount = 0;
  const cache = {
    match: vi.fn(async (input: RequestInfo | URL) => {
      cacheMatchCount += 1;
      return cacheEntries.get(cacheKey(input))?.clone();
    }),
    put: vi.fn(async (input: RequestInfo | URL, response: Response) => {
      cachePutCount += 1;
      cacheEntries.set(cacheKey(input), response.clone());
    }),
  };
  vi.stubGlobal('caches', { default: cache });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/**
 * Mock fetch: the shard origin (origin-{loc}.…) returns `originStatus`; a
 * /job-canon/releases/<build-id>/<sk>.json request returns `map` (or 404 when
 * map is null). The map
 * value is the real per-locale object the plugin emits ({ it, en, de, fr }).
 */
function mockFetch(
  originStatus: number,
  map: Record<string, Record<string, string>> | null,
): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const u = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (new URL(u).pathname === '/cdn-build-id.txt') return new Response('1001');
    if (u.includes('/job-canon/')) {
      return map
        ? new Response(JSON.stringify(map), { status: 200, headers: { 'Content-Type': 'application/json' } })
        : new Response('not found', { status: 404 });
    }
    return new Response(originStatus === 404 ? 'gh-pages-404' : 'ok', { status: originStatus });
  });
}

function mockVersionedFetch(options: {
  v2Status?: number;
  v2Map?: Record<string, Record<string, string>> | null;
  v1Status?: number;
  v1Map?: Record<string, Record<string, string>> | null;
  marker?: string;
  markerStatus?: number;
  originStatus?: number;
} = {}): string[] {
  const {
    v2Status = 200,
    v2Map = null,
    v1Status = 404,
    v1Map = null,
    marker = '1001',
    markerStatus = 200,
    originStatus = 404,
  } = options;
  const canonRequests: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const u = fetchUrl(input);
    if (new URL(u).pathname === '/cdn-build-id.txt') return new Response(marker, { status: markerStatus });
    if (u.includes('/job-canon/')) {
      canonRequests.push(u);
      const isV2 = new URL(u).pathname.includes('/v2/');
      const status = isV2 ? v2Status : v1Status;
      const map = isV2 ? v2Map : v1Map;
      return new Response(map === null ? 'not found' : JSON.stringify(map), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(originStatus === 404 ? 'gh-pages-404' : 'ok', { status: originStatus });
  });
  return canonRequests;
}

describe('locale-router canton-drift 301', () => {
  it('reads v2 first and does not fetch v1 when the v2 shard exists', async () => {
    const slug = 'some-job-xyz';
    const canonRequests = mockVersionedFetch({
      v2Map: { [slug]: { en: '/en/find-jobs-zurich' } },
    });

    const res = await worker.fetch(new Request(`${APEX}/en/jobs-in-zurich/${slug}/`), {}, ctx);

    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe(`/en/find-jobs-zurich/${slug}/`);
    expect(res.headers.get('x-frontaliere-canon-cache')).toBe('miss');
    expect(canonRequests).toHaveLength(1);
    expect(canonRequests[0]).toContain(`/job-canon/releases/1001/v2/${jobCanonV2ShardKey(slug)}.json`);
  });

  it('does not fall back to v1 when a successful v2 shard lacks the slug', async () => {
    const slug = 'some-job-xyz';
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const canonRequests = mockVersionedFetch({
      v2Map: {},
      v1Status: 200,
      v1Map: { [slug]: { en: '/en/find-jobs-zurich' } },
    });

    const res = await worker.fetch(new Request(`${APEX}/en/jobs-in-zurich/${slug}/`), {}, ctx);

    expect(res.status).toBe(404);
    expect(canonRequests.length).toBeGreaterThan(0);
    expect(canonRequests.every((request) => request.includes('/job-canon/releases/1001/v2/'))).toBe(true);
    expect(log).not.toHaveBeenCalled();
  });

  it.each([404, 410])(
    'falls back to v1 only when v2 returns %i and logs the fallback event',
    async (v2Status) => {
      const slug = 'some-job-xyz';
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const canonRequests = mockVersionedFetch({
        v2Status,
        v1Status: 200,
        v1Map: { [slug]: { en: '/en/find-jobs-zurich' } },
      });

      const res = await worker.fetch(new Request(`${APEX}/en/jobs-in-zurich/${slug}/`), {}, ctx);

      expect(res.status).toBe(301);
      expect(res.headers.get('Location')).toBe(`/en/find-jobs-zurich/${slug}/`);
      expect(canonRequests).toHaveLength(2);
      expect(canonRequests[0]).toContain(`/job-canon/releases/1001/v2/${jobCanonV2ShardKey(slug)}.json`);
      expect(canonRequests[1]).toContain('/job-canon/releases/1001/so.json');
      expect(log).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith({ event: 'job_canon_v1_fallback' });
    },
  );

  it('fails closed on a v2 error other than 404/410 without trying v1', async () => {
    const slug = 'some-job-xyz';
    const canonRequests = mockVersionedFetch({
      v2Status: 503,
      v2Map: { [slug]: { en: '/en/find-jobs-zurich' } },
      v1Map: { [slug]: { en: '/en/find-jobs-zurich' } },
    });

    const res = await worker.fetch(new Request(`${APEX}/en/jobs-in-zurich/${slug}/`), {}, ctx);

    expect(res.status).toBe(503);
    expect(res.headers.get('x-frontaliere-canon-cache')).toBeNull();
    expect(canonRequests).toHaveLength(1);
    expect(canonRequests[0]).toContain('/job-canon/releases/1001/v2/');
  });

  it('uses the release pathname as the map identity when the origin ignores query parameters', async () => {
    const slug = 'release-versioned-job';
    const mapsByRelease: Record<string, Record<string, unknown>> = {
      '1001': { [slug]: { alias: { en: '/en/find-jobs-zurich/old-target' } } },
      '1002': { [slug]: { alias: { en: '/en/find-jobs-zurich/new-target' } } },
      '1003': { [slug]: { alias: { en: '/en/find-jobs-zurich/old-target' } } },
    };
    const edgeMapCache = new Map<string, Record<string, unknown>>();
    const mapRequests: string[] = [];
    let marker = '1001';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = new URL(fetchUrl(input));
      if (url.pathname === '/cdn-build-id.txt') return new Response(marker);
      if (url.pathname.includes('/job-canon/')) {
        mapRequests.push(url.toString());
        const releaseId = url.pathname.match(/^\/job-canon\/releases\/([0-9]{1,20})\//)?.[1];
        const cached = edgeMapCache.get(url.pathname);
        if (cached) return Response.json(cached);
        // Deliberately select origin bytes only from the immutable pathname.
        const releaseMap = releaseId ? mapsByRelease[releaseId] : undefined;
        if (!releaseMap) return new Response('missing release', { status: 404 });
        edgeMapCache.set(url.pathname, releaseMap);
        return Response.json(releaseMap);
      }
      if (url.hostname.startsWith('origin-')) {
        return url.pathname.includes('/old-target/') || url.pathname.includes('/new-target/')
          ? new Response('target live', { status: 200 })
          : new Response('origin missing', { status: 404 });
      }
      return new Response('origin missing', { status: 404 });
    });

    for (const [release, target] of [
      ['1001', '/en/find-jobs-zurich/old-target'],
      ['1002', '/en/find-jobs-zurich/new-target'],
      ['1003', '/en/find-jobs-zurich/old-target'],
    ]) {
      marker = release;
      const response = await worker.fetch(new Request(`${APEX}/en/jobs-in-zurich/${slug}/`), {}, ctx);
      expect(response.status).toBe(301);
      expect(response.headers.get('Location')).toBe(`${target}/`);
      await flushCacheWrites();
    }

    expect(mapRequests).toHaveLength(3);
    expect(mapRequests.map((request) => new URL(request).pathname.match(/\/releases\/([0-9]{1,20})\//)?.[1]))
      .toEqual(['1001', '1002', '1003']);
    expect(mapRequests.every((request) => new URL(request).search === '')).toBe(true);
    expect(new Set(mapRequests).size).toBe(3);
    expect([...cacheEntries.keys()].map((key) => new URL(key).searchParams.get('build_id')))
      .toEqual(['1001', '1002', '1003']);
  });

  it.each([
    { marker: '1001', status: 404, reason: 'http-status', loggedStatus: 404 },
    { marker: 'error', status: 500, reason: 'http-status', loggedStatus: 500 },
    { marker: '', status: 200, reason: 'empty' },
    { marker: 'not-a-build-id', status: 200, reason: 'invalid' },
    { marker: '1'.repeat(21), status: 200, reason: 'invalid' },
  ])('returns localized no-store 404 and ignores stale alias cache when marker is unavailable (%#)', async ({ marker, status, reason, loggedStatus }) => {
    const slug = 'some-job-xyz';
    const source = `${APEX}/en/jobs-in-zurich/${slug}/`;
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    seedJobAliasCache(source, { kind: 'redirect', target: `/en/find-jobs-stale/${slug}/` }, 86400);
    const mapRequests: string[] = [];
    const markerOptions: RequestInit[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(fetchUrl(input));
      if (url.pathname === '/cdn-build-id.txt') {
        markerOptions.push(init ?? {});
        return new Response(marker, { status });
      }
      if (url.pathname.includes('/job-canon/')) {
        mapRequests.push(url.toString());
        return Response.json({ [slug]: { en: '/en/find-jobs-stale' } });
      }
      return new Response('origin missing', { status: 404 });
    });

    const response = await worker.fetch(new Request(source), {}, ctx);

    expect(response.status).toBe(404);
    expect(response.headers.get('Location')).toBeNull();
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Retry-After')).toBeNull();
    expect(response.headers.get('Content-Language')).toBe('en');
    expect(await response.text()).toContain('<html lang="en">');
    expect(response.headers.get('x-frontaliere-job-canon-marker-unavailable')).toBeNull();
    expect(response.headers.get('x-frontaliere-canon-cache')).toBeNull();
    expect(cacheMatchCount).toBe(0);
    expect(cachePutCount).toBe(0);
    expect(mapRequests).toEqual([]);
    expect(log).toHaveBeenCalledWith({
      event: 'job_canon_marker_unavailable',
      reason,
      ...(loggedStatus === undefined ? {} : { status: loggedStatus }),
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain(slug);
    expect(markerOptions).toHaveLength(1);
    expect(markerOptions[0]).toMatchObject({
      cf: { cacheEverything: false, cacheTtl: 0 },
      headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
    });
    expect(markerOptions[0]).not.toHaveProperty('cache');
    expect(markerOptions[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('returns a localized no-store 404 on marker network failure without alias cache access', async () => {
    const slug = 'network-unavailable-job';
    const source = `${APEX}/fr/trouver-emploi-zurich/${slug}/`;
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    seedJobAliasCache(source, { kind: 'redirect', target: `/fr/trouver-emploi-jura/${slug}/` }, 86400);
    const mapRequests: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = new URL(fetchUrl(input));
      if (url.pathname === '/cdn-build-id.txt') throw new TypeError('private network detail');
      if (url.pathname.includes('/job-canon/')) mapRequests.push(url.toString());
      return new Response('origin missing', { status: 404 });
    });

    const response = await worker.fetch(new Request(source), {}, ctx);

    expect(response.status).toBe(404);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Retry-After')).toBeNull();
    expect(response.headers.get('Content-Language')).toBe('fr');
    expect(await response.text()).toContain('<html lang="fr">');
    expect(cacheMatchCount).toBe(0);
    expect(cachePutCount).toBe(0);
    expect(mapRequests).toEqual([]);
    expect(log).toHaveBeenCalledWith({
      event: 'job_canon_marker_unavailable',
      reason: 'network',
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain(slug);
  });

  it('uses the Italian localized 404 on marker failure for an Italian job URL', async () => {
    const slug = 'marker-temporarily-unavailable';
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = new URL(fetchUrl(input));
      if (url.pathname === '/cdn-build-id.txt') return new Response('unavailable', { status: 500 });
      return new Response('origin missing', { status: 404 });
    });

    const response = await worker.fetch(
      new Request(`${APEX}/cerca-lavoro-zurigo/${slug}/`),
      {},
      ctx,
    );

    expect(response.status).toBe(404);
    expect(response.headers.get('Content-Language')).toBe('it');
    expect(await response.text()).toContain('<html lang="it">');
    expect(response.headers.get('Retry-After')).toBeNull();
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('returns a localized no-store 404 after the marker request times out', async () => {
    vi.useFakeTimers();
    const slug = 'timed-out-marker-job';
    const source = `${APEX}/de/jobs-in-zurich/${slug}/`;
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    let markStarted!: () => void;
    const markerStarted = new Promise<void>((resolve) => { markStarted = resolve; });
    const mapRequests: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(fetchUrl(input));
      if (url.pathname === '/cdn-build-id.txt') {
        markStarted();
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        });
      }
      if (url.pathname.includes('/job-canon/')) mapRequests.push(url.toString());
      return new Response('origin missing', { status: 404 });
    });

    const pending = worker.fetch(new Request(source), {}, ctx);
    await markerStarted;
    await vi.advanceTimersByTimeAsync(2000);
    const response = await pending;

    expect(response.status).toBe(404);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Retry-After')).toBeNull();
    expect(response.headers.get('Content-Language')).toBe('de');
    expect(await response.text()).toContain('<html lang="de">');
    expect(cacheMatchCount).toBe(0);
    expect(cachePutCount).toBe(0);
    expect(mapRequests).toEqual([]);
    expect(log).toHaveBeenCalledWith({
      event: 'job_canon_marker_unavailable',
      reason: 'timeout',
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain(slug);
  });

  it('recovers on the next request when an unavailable marker becomes valid', async () => {
    const slug = 'marker-recovery-job';
    const source = `${APEX}/en/jobs-in-zurich/${slug}/`;
    let markerStatus = 500;
    let marker = 'unavailable';
    const mapRequests: string[] = [];
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = new URL(fetchUrl(input));
      if (url.pathname === '/cdn-build-id.txt') return new Response(marker, { status: markerStatus });
      if (url.pathname.includes('/job-canon/')) {
        mapRequests.push(url.toString());
        return Response.json({ [slug]: { en: '/en/find-jobs-bern' } });
      }
      if (url.hostname.startsWith('origin-') && url.pathname.includes('/find-jobs-bern/')) {
        return new Response('live target', { status: 200 });
      }
      return new Response('origin missing', { status: 404 });
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});

    const unavailable = await worker.fetch(new Request(source), {}, ctx);
    expect(unavailable.status).toBe(404);
    expect(cacheMatchCount).toBe(0);
    expect(cachePutCount).toBe(0);
    expect(mapRequests).toEqual([]);

    markerStatus = 200;
    marker = '1002';
    const recovered = await worker.fetch(new Request(source), {}, ctx);

    expect(recovered.status).toBe(301);
    expect(recovered.headers.get('Location')).toBe(`/en/find-jobs-bern/${slug}/`);
    expect(mapRequests).toHaveLength(1);
    expect(new URL(mapRequests[0]).pathname).toContain('/job-canon/releases/1002/');
    expect(cacheMatchCount).toBe(1);
    expect(log).toHaveBeenCalledWith({
      event: 'job_canon_marker_unavailable',
      reason: 'http-status',
      status: 500,
    });
    expect(fetchMock).toHaveBeenCalled();
  });

  it('does not classify an ambiguous company-looking job URL while the marker is unavailable', async () => {
    const source = `${APEX}/fr/trouver-emploi-tessin/azienda-denner-sa/`;
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const mapRequests: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = new URL(fetchUrl(input));
      if (url.pathname === '/cdn-build-id.txt') return new Response('unavailable', { status: 500 });
      if (url.pathname.includes('/job-canon/')) mapRequests.push(url.toString());
      return new Response('origin missing', { status: 404 });
    });

    const response = await worker.fetch(new Request(source), {}, ctx);

    expect(response.status).toBe(404);
    expect(response.headers.get('Location')).toBeNull();
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Retry-After')).toBeNull();
    expect(response.headers.get('Content-Language')).toBe('fr');
    expect(mapRequests).toEqual([]);
    expect(cacheMatchCount).toBe(0);
    expect(cachePutCount).toBe(0);
    expect(log).toHaveBeenCalledWith({
      event: 'job_canon_marker_unavailable',
      reason: 'http-status',
      status: 500,
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain('azienda-denner-sa');
  });

  it.each(['GET', 'HEAD'])('keeps unknown, expired, company- and search-shaped URLs on localized no-store 404s (%s)', async (method) => {
    const cases = [
      { locale: 'en', path: '/en/jobs-in-zurich/typo-never-seen/', slug: 'typo-never-seen' },
      { locale: 'de', path: '/de/jobs-in-zurich/expired-old-job/', slug: 'expired-old-job' },
      { locale: 'fr', path: '/fr/trouver-emploi-tessin/company-real-job/', slug: 'company-real-job' },
      { locale: 'en', path: '/en/jobs-in-zurich/search-real-role/', slug: 'search-real-role' },
    ];
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const mapRequests: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = new URL(fetchUrl(input));
      if (url.pathname === '/cdn-build-id.txt') return new Response('temporarily unavailable', { status: 500 });
      if (url.pathname.includes('/job-canon/')) mapRequests.push(url.toString());
      return new Response('origin missing', { status: 404 });
    });

    for (const { locale, path, slug } of cases) {
      const response = await worker.fetch(new Request(`${APEX}${path}`, { method }), {}, ctx);
      expect(response.status, path).toBe(404);
      expect(response.headers.get('Content-Language'), path).toBe(locale);
      expect(response.headers.get('Cache-Control'), path).toBe('no-store');
      expect(response.headers.get('Location'), path).toBeNull();
      expect(response.headers.get('Retry-After'), path).toBeNull();
      expect(response.headers.get('x-frontaliere-canon-cache'), path).toBeNull();
      expect(response.headers.get('x-frontaliere-job-canon-marker-unavailable'), path).toBeNull();
      const body = await response.text();
      if (method === 'GET') expect(body, path).toContain(`<html lang="${locale}">`);
      else expect(body, path).toBe('');
      expect(JSON.stringify(log.mock.calls), path).not.toContain(slug);
    }

    expect(mapRequests).toEqual([]);
    expect(cacheMatchCount).toBe(0);
    expect(cachePutCount).toBe(0);
    expect(log).toHaveBeenCalledTimes(cases.length);
  });

  it('builds the same versioned v2 then v1 shard URLs as public/404.html', async () => {
    const slug = 'legacy-en-v1';
    const workerRequests = mockVersionedFetch({
      v2Status: 404,
      v1Status: 200,
      v1Map: { [slug]: { en: '/en/find-jobs-zurich' } },
    });
    const workerResponse = await worker.fetch(new Request(`${APEX}/en/jobs-in-zurich/${slug}/`), {}, ctx);
    expect(workerResponse.status).toBe(301);

    const browserRequests: string[] = [];
    const browserFetchJobCanonMap = loadBrowserJobCanonMapFetcher();
    await expect(browserFetchJobCanonMap(slug, (async (input: string | URL | Request) => {
      const url = fetchUrl(input);
      if (new URL(url).pathname === '/cdn-build-id.txt') return new Response('1001');
      browserRequests.push(url);
      return browserRequests.length === 1
        ? new Response('v2 missing', { status: 404 })
        : Response.json({ [slug]: { en: '/en/find-jobs-zurich' } });
    }) as typeof fetch)).resolves.toEqual({ kind: 'map', value: { [slug]: { en: '/en/find-jobs-zurich' } } });

    expect(browserRequests.map((request) => {
      const url = new URL(request);
      return url.pathname;
    })).toEqual(workerRequests.map((request) => {
      const url = new URL(request);
      return url.pathname;
    }));
    expect(browserRequests.map((request) => new URL(request).pathname.match(/\/releases\/([0-9]{1,20})\//)?.[1]))
      .toEqual(['1001', '1001']);
  });

  it('301s a known orphan slug to its current canonical page', async () => {
    mockFetch(404, { 'some-job-xyz': { en: '/en/find-jobs-zurich' } });

    const res = await worker.fetch(new Request(`${APEX}/en/jobs-in-zurich/some-job-xyz/`), {}, ctx);

    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe('/en/find-jobs-zurich/some-job-xyz/');
    expect(res.headers.get('x-frontaliere-canon-cache')).toBe('miss');
  });

  it.each([
    { locale: 'it', prefix: '', legacy: '/cerca-lavoro-ticino', native: '/cerca-lavoro-zurigo' },
    { locale: 'en', prefix: '/en', legacy: '/en/find-jobs-ticino', native: '/en/find-jobs-zurich' },
    { locale: 'de', prefix: '/de', legacy: '/de/jobs-im-tessin', native: '/de/jobs-in-zurich' },
    { locale: 'fr', prefix: '/fr', legacy: '/fr/trouver-emploi-tessin', native: '/fr/trouver-emploi-zurich' },
  ] as const)('redirects previous, legacy-TI mirror, and cross-locale aliases in $locale without a chain', async ({ locale, legacy, native }) => {
    const oldSlug = `previous-route-${locale}`;
    const foreignSlug = `foreign-route-${locale}`;
    const currentSlug = `current-route-${locale}`;
    const canonical = `${native}/${currentSlug}/`;
    const map = {
      [oldSlug]: { alias: { [locale]: canonical.replace(/\/$/, '') } },
      [foreignSlug]: { alias: { [locale]: canonical.replace(/\/$/, '') } },
    };
    const sourcePaths = [
      `${native}/${oldSlug}/`,
      `${legacy}/${oldSlug}/`,
      `${legacy}/${foreignSlug}/`,
    ];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = new URL(fetchUrl(input));
      if (url.pathname.includes('/job-canon/')) {
        return new Response(JSON.stringify(map), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.pathname === '/cdn-build-id.txt') return new Response('1001');
      return new Response(url.pathname === canonical ? 'canonical' : 'origin-404', {
        status: url.pathname === canonical ? 200 : 404,
      });
    });

    for (const sourcePath of sourcePaths) {
      const response = await worker.fetch(new Request(`${APEX}${sourcePath}`), {}, ctx);
      expect(response.status, sourcePath).toBe(301);
      expect(response.headers.get('Location'), sourcePath).toBe(canonical);
      if (locale !== 'it') expect(response.headers.get('Location')).toMatch(new RegExp(`^/${locale}/`));

      const destination = await worker.fetch(new Request(`${APEX}${response.headers.get('Location')}`), {}, ctx);
      expect(destination.status, sourcePath).toBe(200);
      expect(destination.headers.get('Location'), sourcePath).toBeNull();
    }
    await flushCacheWrites();
  });

  it('301s within the request locale, never cross-locale to the IT page', async () => {
    // The slug exists under every locale (identical slug segment, localized
    // prefix). A /de orphan must 301 to the DE page, NOT the it prefix — the
    // cross-locale collapse this PR fixes.
    mockFetch(404, {
      'some-job-xyz': {
        it: '/cerca-lavoro-zurigo',
        en: '/en/find-jobs-zurich',
        de: '/de/jobs-in-zurich',
        fr: '/fr/trouver-emploi-zurich',
      },
    });

    const res = await worker.fetch(new Request(`${APEX}/de/jobs-im-zuerich/some-job-xyz/`), {}, ctx);

    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe('/de/jobs-in-zurich/some-job-xyz/');
  });

  it('falls through to the soft 404 when no prefix exists for the request locale', async () => {
    // Slug tracked only under it → a /en orphan must NOT 301 to the IT page; it
    // keeps the soft-404 path rather than emitting a permanent cross-locale 301.
    mockFetch(404, { 'some-job-xyz': { it: '/cerca-lavoro-zurigo' } });

    const res = await worker.fetch(new Request(`${APEX}/en/jobs-in-zurich/some-job-xyz/`), {}, ctx);

    expect(res.status).toBe(404);
    expect(res.headers.get('x-frontaliere-canon-cache')).toBe('miss');
  });

  it('falls through to the soft 404 for a legacy string map value (stale deploy)', async () => {
    // A not-yet-rebuilt map may still hold the old flat string value; the Worker
    // must NOT 301 on it (would be cross-locale), it falls through to the 404.
    mockFetch(404, { 'some-job-xyz': '/en/find-jobs-zurich' as unknown as Record<string, string> });

    const res = await worker.fetch(new Request(`${APEX}/en/jobs-in-zurich/some-job-xyz/`), {}, ctx);

    expect(res.status).toBe(404);
    expect(res.headers.get('x-frontaliere-canon-cache')).toBe('miss');
    expect(cacheMatchCount).toBe(1);
  });

  it('preserves query + hash on the 301 Location', async () => {
    mockFetch(404, { 'some-job-xyz': { en: '/en/find-jobs-zurich' } });

    const res = await worker.fetch(
      new Request(`${APEX}/en/jobs-in-zurich/some-job-xyz/?utm=x#frag`),
      {},
      ctx,
    );

    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe('/en/find-jobs-zurich/some-job-xyz/?utm=x#frag');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300, s-maxage=7200');
    expect(res.headers.get('x-frontaliere-canon-cache')).toBe('miss');
  });

  it('falls through to the soft 404 for an unknown slug', async () => {
    mockFetch(404, { 'other-slug': { en: '/en/find-jobs-zurich' } });

    const res = await worker.fetch(new Request(`${APEX}/en/jobs-in-zurich/some-job-xyz/`), {}, ctx);

    expect(res.status).toBe(404);
    expect(res.headers.get('x-frontaliere-canon-cache')).toBe('miss');
    expect(cacheMatchCount).toBe(1);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300, s-maxage=7200');
  });

  it('does not label an unrelated company redirect after a job-alias cache miss', async () => {
    mockFetch(404, {});

    const res = await worker.fetch(
      new Request(`${APEX}/fr/trouver-emploi-tessin/azienda-test/?from=legacy#jobs`),
      {},
      ctx,
    );

    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe('/fr/trouver-emploi-tessin/entreprise-test/?from=legacy#jobs');
    expect(res.headers.get('x-frontaliere-canon-cache')).toBeNull();
    expect(cacheMatchCount).toBe(1);
  });

  it('falls through to the soft 404 when the map shard is missing', async () => {
    mockFetch(404, null);

    const res = await worker.fetch(new Request(`${APEX}/de/jobs-im-zuerich/ein-job/`), {}, ctx);

    expect(res.status).toBe(404);
  });

  it('does not redirect a non-job 404 path (no map lookup)', async () => {
    mockFetch(404, { 'some-job-xyz': { en: '/en/find-jobs-zurich' } });

    const res = await worker.fetch(new Request(`${APEX}/en/guida-frontaliere/`), {}, ctx);

    expect(res.status).toBe(404);
    // No /job-canon/ subrequest should have been attempted for a non-job path.
    const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.some((c) => String(c[0]).includes('/job-canon/'))).toBe(false);
  });

  it('does not 301 to the path already requested (no redirect loop)', async () => {
    // Map points the slug back at the same section it was requested under.
    mockFetch(404, { 'some-job-xyz': { en: '/en/jobs-in-zurich' } });

    const res = await worker.fetch(new Request(`${APEX}/en/jobs-in-zurich/some-job-xyz/`), {}, ctx);

    expect(res.status).toBe(404);
    expect(res.headers.get('x-frontaliere-canon-cache')).toBeNull();
    expect(cacheMatchCount).toBe(1);
    expect(cachePutCount).toBe(0);
  });

  it('leaves a healthy 200 untouched (no map lookup)', async () => {
    mockFetch(200, { 'some-job-xyz': { en: '/en/find-jobs-zurich' } });

    const res = await worker.fetch(new Request(`${APEX}/en/jobs-in-zurich/some-job-xyz/`), {}, ctx);

    expect(res.status).toBe(200);
    const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.some((c) => String(c[0]).includes('/job-canon/'))).toBe(false);
  });
});

// The build no longer writes a 200 copy of an expired (or active) non-TI job
// under the legacy TI section of en/de/fr (jobsSeoPagesPlugin: the 911k
// canonicalMismatch advisories of the full-corpus replay came from those
// copies). The shard origin therefore answers 404 for them, and THIS is what
// keeps them alive: a 301 to the job's canton page, inside the same locale.
describe('locale-router: legacy TI URL of a non-TI job (origin 404) → 301 to its canton', () => {
  const slug = 'zweigstelle-80-100-valiant-bank-ag-moutier';
  const registryEntry = {
    it: '/cerca-lavoro-giura',
    en: '/en/find-jobs-jura',
    de: '/de/jobs-im-jura',
    fr: '/fr/trouver-emploi-jura',
  };

  it.each([
    ['en', '/en/find-jobs-ticino', '/en/find-jobs-jura'],
    ['de', '/de/jobs-im-tessin', '/de/jobs-im-jura'],
    ['fr', '/fr/trouver-emploi-tessin', '/fr/trouver-emploi-jura'],
  ])('%s: %s/<slug>/ → %s/<slug>/', async (_loc, legacyRoot, cantonRoot) => {
    mockFetch(404, { [slug]: registryEntry });

    const res = await worker.fetch(new Request(`${APEX}${legacyRoot}/${slug}/`), {}, ctx);

    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe(`${cantonRoot}/${slug}/`);
  });

  it('answers HEAD with the same 301 as GET', async () => {
    mockFetch(404, { [slug]: registryEntry });

    const res = await worker.fetch(
      new Request(`${APEX}/fr/trouver-emploi-tessin/${slug}/`, { method: 'HEAD' }),
      {},
      ctx,
    );

    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe(`/fr/trouver-emploi-jura/${slug}/`);
  });
});

// When the job's page in this locale has a DIFFERENT slug, `${prefix}/${slug}/`
// would not exist: jobCanonRedirectMapPlugin records the localized path as
// `alias` and the Worker 301s there, after seeing the target live.
describe('locale-router: registry alias for a localized slug', () => {
  const itSlug = 'acquirente-strategico-yellowshark-ag-weinfelden';
  const frTarget = '/fr/trouver-emploi-thurgovie/acheteur-strategique-yellowshark-ag-weinfelden';

  function mockAliasFetch(map: Record<string, unknown>, live: (url: URL) => number) {
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname === '/cdn-build-id.txt') return new Response('1001');
      if (url.pathname.includes('/job-canon/')) return Response.json(map);
      return new Response('x', { status: live(url) });
    });
  }

  it('fr legacy TI URL with the Italian slug → 301 to the French page in its canton', async () => {
    const fetchMock = mockAliasFetch(
      { [itSlug]: { it: '/cerca-lavoro-turgovia', alias: { fr: frTarget } } },
      (url) => (url.pathname === `${frTarget}/` && url.hostname === 'origin-turgovia-fr.frontaliereticino.ch' ? 200 : 404),
    );

    const res = await worker.fetch(new Request(`${APEX}/fr/trouver-emploi-tessin/${itSlug}/?utm=x`), {}, ctx);

    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe(`${frTarget}/?utm=x`);
    // The alias target was verified on its own shard before the permanent 301.
    expect(
      fetchMock.mock.calls.some(([input]) => String(input instanceof Request ? input.url : input).includes(frTarget)),
    ).toBe(true);
  });

  it('TI alias (same canton, localized slug) → 301 to the localized TI page through the physical fan-out', async () => {
    const enTarget = '/en/find-jobs-ticino/buyer-food-bell-schweiz-ag';
    mockAliasFetch(
      { 'acquirente-food-bell-schweiz-ag': { it: '/cerca-lavoro-ticino', alias: { en: enTarget } } },
      (url) => (
        url.hostname === 'origin-ticino-en.frontaliereticino.ch' && url.pathname.endsWith('/buyer-food-bell-schweiz-ag/')
          ? 200
          : 404
      ),
    );

    const res = await worker.fetch(new Request(`${APEX}/en/find-jobs-ticino/acquirente-food-bell-schweiz-ag/`), {}, ctx);

    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe(`${enTarget}/`);
  });

  it('IT legacy-TI mirror slug → 301 to the active job in its actual canton', async () => {
    const oldSlug = 'legacy-client-service-v1';
    const itTarget = '/cerca-lavoro-zurigo/customer-service-transport-specialist';
    mockAliasFetch(
      { [oldSlug]: { alias: { it: itTarget } } },
      (url) => url.hostname === 'origin-zurigo-it.frontaliereticino.ch'
        && url.pathname === `${itTarget}/` ? 200 : 404,
    );

    const res = await worker.fetch(new Request(`${APEX}/cerca-lavoro-ticino/${oldSlug}/`), {}, ctx);

    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe(`${itTarget}/`);
  });

  it('EN previous slug → 301 only after the English canonical is live', async () => {
    const oldSlug = 'legacy-transport-specialist-v1';
    const enTarget = '/en/find-jobs-zurich/customer-service-transport-specialist';
    mockAliasFetch(
      { [oldSlug]: { alias: { en: enTarget } } },
      (url) => url.hostname === 'origin-zurigo-en.frontaliereticino.ch'
        && url.pathname === `${enTarget}/` ? 200 : 404,
    );

    const res = await worker.fetch(new Request(`${APEX}/en/find-jobs-ticino/${oldSlug}/`), {}, ctx);

    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe(`${enTarget}/`);
  });

  it('does not 301 an IT alias when the destination is not live', async () => {
    const oldSlug = 'legacy-it-unavailable-v1';
    mockAliasFetch(
      { [oldSlug]: { alias: { it: '/cerca-lavoro-zurigo/unavailable-job' } } },
      () => 404,
    );

    const res = await worker.fetch(new Request(`${APEX}/cerca-lavoro-ticino/${oldSlug}/`), {}, ctx);

    expect(res.status).toBe(404);
    expect(res.headers.get('Location')).toBeNull();
  });

  it('does not 301 to an alias whose target is not live', async () => {
    mockAliasFetch({ [itSlug]: { alias: { fr: frTarget } } }, () => 404);

    const res = await worker.fetch(new Request(`${APEX}/fr/trouver-emploi-tessin/${itSlug}/`), {}, ctx);

    expect(res.status).toBe(404);
    expect(res.headers.get('Location')).toBeNull();
  });

  it('answers 503, not a permanent verdict, when the alias target cannot be verified', async () => {
    mockAliasFetch({ [itSlug]: { alias: { fr: frTarget } } }, (url) => (url.pathname === `${frTarget}/` ? 503 : 404));

    const res = await worker.fetch(new Request(`${APEX}/fr/trouver-emploi-tessin/${itSlug}/`), {}, ctx);

    expect(res.status).toBe(503);
    expect(res.headers.get('Location')).toBeNull();
  });

  it('never follows an alias into another locale', async () => {
    mockAliasFetch({ [itSlug]: { alias: { fr: '/en/find-jobs-thurgau/strategic-buyer' } } }, () => 200);

    const res = await worker.fetch(new Request(`${APEX}/fr/trouver-emploi-tessin/${itSlug}/`), {}, ctx);

    expect(res.status).not.toBe(301);
  });

  it('rejects an IT alias that points into EN', async () => {
    const oldSlug = 'legacy-it-cross-locale-v1';
    mockAliasFetch({ [oldSlug]: { alias: { it: '/en/find-jobs-zurich/foreign-target' } } }, () => 200);

    const res = await worker.fetch(new Request(`${APEX}/cerca-lavoro-ticino/${oldSlug}/`), {}, ctx);

    expect(res.status).not.toBe(301);
    expect(res.headers.get('Location')).toBeNull();
  });

  it('lets an exact prefix win over an alias (the slug really exists in this locale)', async () => {
    mockAliasFetch({ [itSlug]: { fr: '/fr/trouver-emploi-thurgovie', alias: { fr: frTarget } } }, () => 404);

    const res = await worker.fetch(new Request(`${APEX}/fr/trouver-emploi-tessin/${itSlug}/`), {}, ctx);

    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe(`/fr/trouver-emploi-thurgovie/${itSlug}/`);
  });
});

describe('jobCanonTarget', () => {
  it('builds prefix targets, accepts same-locale aliases and refuses the rest', () => {
    expect(jobCanonTarget({ fr: '/fr/trouver-emploi-jura' }, 's', 'fr')).toBe('/fr/trouver-emploi-jura/s/');
    expect(jobCanonTarget({ alias: { fr: '/fr/trouver-emploi-jura/t' } }, 's', 'fr')).toBe('/fr/trouver-emploi-jura/t/');
    expect(jobCanonTarget({ alias: { fr: '/en/find-jobs-jura/t' } }, 's', 'fr')).toBeNull();
    expect(jobCanonTarget({ alias: { it: '/fr/trouver-emploi-jura/t' } }, 's', 'it')).toBeNull();
    expect(jobCanonTarget({ alias: { fr: '/fr/x//t' } }, 's', 'fr')).toBeNull();
    expect(jobCanonTarget({ alias: { fr: '/fr/x/t?q=1' } }, 's', 'fr')).toBeNull();
    expect(jobCanonTarget({ alias: 'nope' }, 's', 'fr')).toBeNull();
    expect(jobCanonTarget('legacy-string', 's', 'fr')).toBeNull();
  });
});

describe('jobCanonV2ShardKey', () => {
  it.each([
    'some-job-xyz',
    'verkäufer-im-aussendienst',
    'français-été-2026',
  ])('mirrors the client slug-map djb2-xor hash for normalized slug %s', (input) => {
    const normalized = input.toLowerCase();
    const v2Key = jobCanonV2ShardKey(normalized);
    const v2Index = Number.parseInt(v2Key, 16);
    const clientKey = jobSlugShardKey(normalized);

    expect(v2Key).toMatch(/^[0-9a-f]{3}$/);
    expect((v2Index % 256).toString(16).padStart(2, '0')).toBe(clientKey);
  });
});

describe('locale-router job alias edge cache', () => {
  const itSlug = 'acquirente-strategico-yellowshark-ag-weinfelden';
  const frTarget = '/fr/trouver-emploi-thurgovie/acheteur-strategique-yellowshark-ag-weinfelden';
  const source = `${APEX}/fr/trouver-emploi-tessin/${itSlug}/`;

  function mockAliasRoute(targetStatus: () => number = () => 200) {
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname === '/cdn-build-id.txt') return new Response('1001');
      if (url.pathname.includes('/job-canon/')) {
        return Response.json({ [itSlug]: { it: '/cerca-lavoro-turgovia', alias: { fr: frTarget } } });
      }
      if (url.pathname === `${frTarget}/` && url.hostname === 'origin-turgovia-fr.frontaliereticino.ch') {
        return new Response('target', { status: targetStatus() });
      }
      return new Response('missing', { status: 404 });
    });
  }

  function mockOriginStatus(status: number) {
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const method = input instanceof Request ? input.method : 'GET';
      return new Response(method === 'HEAD' ? null : status === 200 ? 'live page' : 'missing', { status });
    });
  }

  it('serves the second verified 301 after origin 404 without a map or target fetch', async () => {
    const fetchMock = mockAliasRoute();

    const first = await worker.fetch(new Request(`${source}?from=first`), {}, ctx);
    expect(first.status).toBe(301);
    expect(first.headers.get('Location')).toBe(`${frTarget}/?from=first`);
    expect(first.headers.get('Cache-Control')).toBe('public, max-age=300, s-maxage=7200');
    expect(first.headers.get('x-frontaliere-canon-cache')).toBe('miss');
    await flushCacheWrites();

    const [stored] = [...cacheEntries.values()];
    expect(stored).toBeDefined();
    expect(stored.headers.get('Cache-Control')).toBe('public, max-age=86400, s-maxage=86400');
    expect(await stored.clone().json()).toEqual({ kind: 'redirect', target: `${frTarget}/` });
    const [storedKey] = [...cacheEntries.keys()];
    expect(new URL(storedKey ?? APEX).pathname).toBe(`/__worker-cache/job-alias/fr/fr/trouver-emploi-tessin/${itSlug}/`);
    expect(new URL(storedKey ?? APEX).searchParams.get('build_id')).toBe('1001');

    fetchMock.mockClear();
    const matchesBeforeSecond = cacheMatchCount;
    const second = await worker.fetch(new Request(`${source.replace(/\/$/, '')}?from=second`), {}, ctx);
    expect(second.status).toBe(301);
    expect(second.headers.get('Location')).toBe(`${frTarget}/?from=second`);
    expect(second.headers.get('Cache-Control')).toBe('public, max-age=300, s-maxage=7200');
    expect(second.headers.get('x-frontaliere-canon-cache')).toBe('hit');
    expect(cacheMatchCount).toBe(matchesBeforeSecond + 1);
    const secondFetches = fetchMock.mock.calls.map(([input]) => fetchUrl(input));
    expect(secondFetches.length).toBeGreaterThan(0);
    expect(secondFetches.every((url) => !url.includes('/job-canon/') && !url.includes(frTarget))).toBe(true);
  });

  it.each(['GET', 'HEAD'])('origin 200 wins over a cached redirect (%s)', async (method) => {
    seedJobAliasCache(source, { kind: 'redirect', target: `${frTarget}/` }, 86400);
    const fetchMock = mockOriginStatus(200);

    const response = await worker.fetch(new Request(source, { method }), {}, ctx);

    expect(response.status).toBe(200);
    expect(response.headers.get('Location')).toBeNull();
    expect(response.headers.get('x-frontaliere-canon-cache')).toBeNull();
    expect(cacheMatchCount).toBe(0);
    expect(fetchMock).toHaveBeenCalled();
    if (method === 'GET') expect(await response.text()).toBe('live page');
    else expect(await response.text()).toBe('');
  });

  it.each(['GET', 'HEAD'])('origin 200 wins over a cached not-found (%s)', async (method) => {
    seedJobAliasCache(source, { kind: 'not-found' }, 600);
    const fetchMock = mockOriginStatus(200);

    const response = await worker.fetch(new Request(source, { method }), {}, ctx);

    expect(response.status).toBe(200);
    expect(response.headers.get('Location')).toBeNull();
    expect(response.headers.get('x-frontaliere-canon-cache')).toBeNull();
    expect(cacheMatchCount).toBe(0);
    expect(fetchMock).toHaveBeenCalled();
    if (method === 'GET') expect(await response.text()).toBe('live page');
    else expect(await response.text()).toBe('');
  });

  it.each(['GET', 'HEAD'])('uses cached redirect only after origin 404 (%s)', async (method) => {
    seedJobAliasCache(source, { kind: 'redirect', target: `${frTarget}/` }, 86400);
    const fetchMock = mockAliasRoute();

    const response = await worker.fetch(new Request(`${source}?from=${method.toLowerCase()}`, { method }), {}, ctx);

    expect(response.status).toBe(301);
    expect(response.headers.get('Location')).toBe(`${frTarget}/?from=${method.toLowerCase()}`);
    expect(response.headers.get('x-frontaliere-canon-cache')).toBe('hit');
    expect(cacheMatchCount).toBe(1);
    expect(fetchMock).toHaveBeenCalled();
    const fetches = fetchMock.mock.calls.map(([input]) => fetchUrl(input));
    expect(fetches.every((url) => !url.includes('/job-canon/') && !url.includes(frTarget))).toBe(true);
    if (method === 'HEAD') expect(await response.text()).toBe('');
  });

  it('does not cache a destination verification failure', async () => {
    let targetStatus = 503;
    const fetchMock = mockAliasRoute(() => targetStatus);

    const unavailable = await worker.fetch(new Request(source), {}, ctx);
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get('x-frontaliere-canon-cache')).toBeNull();
    await flushCacheWrites();
    expect(cacheEntries.size).toBe(0);

    targetStatus = 200;
    fetchMock.mockClear();
    const recovered = await worker.fetch(new Request(source), {}, ctx);
    expect(recovered.status).toBe(301);
    expect(recovered.headers.get('x-frontaliere-canon-cache')).toBe('miss');
    expect(fetchMock).toHaveBeenCalled();
  });

  it('does not negative-cache a mapped alias whose destination is missing', async () => {
    const fetchMock = mockAliasRoute(() => 404);

    const missing = await worker.fetch(new Request(source), {}, ctx);
    expect(missing.status).toBe(404);
    await flushCacheWrites();
    expect(cacheEntries.size).toBe(0);
    expect(fetchMock).toHaveBeenCalled();
  });

  it('caches a canonical-null 404 for 10 minutes', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname === '/cdn-build-id.txt') return new Response('1001');
      if (url.pathname.includes('/job-canon/')) return Response.json({});
      return new Response('missing', { status: 404 });
    });

    const first = await worker.fetch(new Request(source), {}, ctx);
    expect(first.status).toBe(404);
    expect(first.headers.get('x-frontaliere-canon-cache')).toBe('miss');
    expect(first.headers.get('Cache-Control')).toBe('public, max-age=300, s-maxage=7200');
    await flushCacheWrites();
    const [stored] = [...cacheEntries.values()];
    expect(stored).toBeDefined();
    expect(stored.headers.get('Cache-Control')).toBe('public, max-age=600, s-maxage=600');
    expect(await stored.clone().json()).toEqual({ kind: 'not-found' });

    fetchMock.mockClear();
    const matchesBeforeSecond = cacheMatchCount;
    const second = await worker.fetch(new Request(source), {}, ctx);
    expect(second.status).toBe(404);
    expect(second.headers.get('x-frontaliere-canon-cache')).toBe('hit');
    expect(second.headers.get('Cache-Control')).toBe('public, max-age=300, s-maxage=7200');
    expect(cacheMatchCount).toBe(matchesBeforeSecond + 1);
    expect(fetchMock).toHaveBeenCalled();
    expect(fetchMock.mock.calls.map(([input]) => fetchUrl(input))
      .every((url) => !url.includes('/job-canon/'))).toBe(true);
  });
});
