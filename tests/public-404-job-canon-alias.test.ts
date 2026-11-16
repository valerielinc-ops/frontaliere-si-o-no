import { beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { jobCanonV2ShardKey as sharedV2ShardKey } from '../services/jobSlugShards';

type AliasResolver = (aliasPath: unknown, requestedLocale: string) => string | null;
type JobCanonLookup =
  | { kind: 'unavailable'; reason: string }
  | { kind: 'missing' }
  | { kind: 'map'; value: Record<string, unknown> };
type JobCanonMarker =
  | { kind: 'unavailable'; reason: string }
  | { kind: 'available'; buildId: string };

describe('public/404.html job-canon alias locale validation', () => {
  let resolveAlias!: AliasResolver;
  let resolveFallback!: (
    lookup: JobCanonLookup,
    slug: string,
    companyTarget: () => string | null,
    clusterTarget: () => string | null,
    defaultTarget: string,
  ) => string | null;
  let source = '';
  let canonHelpers!: {
    v1ShardKey: (slug: string) => string;
    v2ShardKey: (slug: string) => string;
    mapUrl: (path: string, buildId: string) => string | null;
    fetchBuildId: (fetcher: typeof fetch) => Promise<JobCanonMarker>;
    fetchMap: (slug: string, fetcher: typeof fetch) => Promise<JobCanonLookup>;
  };

  beforeAll(() => {
    source = fs.readFileSync(path.resolve(process.cwd(), 'public/404.html'), 'utf8');
    const start = source.indexOf('function jobCanonAliasTarget(');
    const end = source.indexOf('\n            var aliasTarget', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const declaration = source.slice(start, end);
    resolveAlias = new Function(`${declaration}\nreturn jobCanonAliasTarget;`)() as AliasResolver;

    const fallbackStart = source.indexOf('function jobCanonFallbackTarget(');
    const fallbackEnd = source.indexOf('\n        var done = false;', fallbackStart);
    expect(fallbackStart).toBeGreaterThanOrEqual(0);
    expect(fallbackEnd).toBeGreaterThan(fallbackStart);
    resolveFallback = new Function(
      `${source.slice(fallbackStart, fallbackEnd)}\nreturn jobCanonFallbackTarget;`,
    )() as typeof resolveFallback;

    const canonStart = source.indexOf('function jobCanonV1ShardKey(');
    const canonEnd = source.indexOf('// Request locale', canonStart);
    expect(canonStart).toBeGreaterThanOrEqual(0);
    expect(canonEnd).toBeGreaterThan(canonStart);
    const canonDeclarations = source.slice(canonStart, canonEnd);
    canonHelpers = new Function(
      'JOB_CANON_CDN',
      `${canonDeclarations}\nreturn { v1ShardKey: jobCanonV1ShardKey, v2ShardKey: jobCanonV2ShardKey, mapUrl: jobCanonMapUrl, fetchBuildId: fetchJobCanonBuildId, fetchMap: fetchJobCanonMap };`,
    )('https://cdn.example.test') as typeof canonHelpers;
  });

  async function runBrowser404(pathname: string, fetcher: typeof fetch, expireMarker = false) {
    const markerComment = source.indexOf('<!-- Canton-drift recovery');
    const scriptOpen = source.indexOf('<script>', markerComment);
    const scriptClose = source.indexOf('</script>', scriptOpen);
    expect(scriptOpen).toBeGreaterThan(markerComment);
    expect(scriptClose).toBeGreaterThan(scriptOpen);
    const replacements: string[] = [];
    const timers = new Map<number, () => void>();
    let timerId = 0;
    const url = new URL(pathname, 'https://frontaliereticino.ch');
    runInNewContext(source.slice(scriptOpen + '<script>'.length, scriptClose), {
      URL,
      AbortController,
      location: {
        hostname: url.hostname,
        pathname: url.pathname,
        search: url.search,
        hash: url.hash,
        href: url.href,
        replace: (target: string) => replacements.push(target),
      },
      window: {},
      sessionStorage: {},
      fetch: fetcher,
      setTimeout: (callback: () => void) => {
        const id = ++timerId;
        timers.set(id, callback);
        return id;
      },
      clearTimeout: (id: number) => timers.delete(id),
    });
    await Promise.resolve();
    if (expireMarker) for (const callback of [...timers.values()]) callback();
    for (let index = 0; index < 12; index += 1) await Promise.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    return replacements;
  }

  it('accepts aliases only inside the requested locale for all four languages', () => {
    expect(resolveAlias('/cerca-lavoro-zurigo/offerta-corrente', 'it'))
      .toBe('/cerca-lavoro-zurigo/offerta-corrente/');
    expect(resolveAlias('/en/find-jobs-zurich/current-job', 'en'))
      .toBe('/en/find-jobs-zurich/current-job/');
    expect(resolveAlias('/de/jobs-in-zurich/aktueller-job', 'de'))
      .toBe('/de/jobs-in-zurich/aktueller-job/');
    expect(resolveAlias('/fr/trouver-emploi-zurich/offre-actuelle', 'fr'))
      .toBe('/fr/trouver-emploi-zurich/offre-actuelle/');
  });

  it('rejects cross-locale and unsafe alias targets', () => {
    expect(resolveAlias('/en/find-jobs-zurich/current-job', 'it')).toBeNull();
    expect(resolveAlias('/fr/trouver-emploi-zurich/offre-actuelle', 'en')).toBeNull();
    expect(resolveAlias('//evil.example/job', 'it')).toBeNull();
    expect(resolveAlias('/en/job?next=x', 'en')).toBeNull();
    expect(resolveAlias('/en/job#fragment', 'en')).toBeNull();
    expect(resolveAlias(null, 'it')).toBeNull();
  });

  it('matches the shared djb2-xor v2 shard key', () => {
    for (const slug of [
      'servizio-clienti-transport-specialista-cippa-trasporti-sa-chiasso',
      'verkaufer-in-kassen-services-coop-genossenschaft-sins',
      'legacy-en-v1',
    ]) {
      expect(canonHelpers.v2ShardKey(slug)).toBe(sharedV2ShardKey(slug));
      expect(canonHelpers.v2ShardKey(slug)).toMatch(/^[0-9a-f]{3}$/);
    }
  });

  it('reads v2 first and falls back to v1 only on 404 or 410', async () => {
    const calls: string[] = [];
    const fallbackFetch = async (url: string) => {
      calls.push(url);
      if (url.endsWith('/cdn-build-id.txt')) return new Response('1234567890123', { status: 200 });
      return calls.filter((call) => call.includes('/job-canon/')).length === 1
        ? new Response('missing', { status: 404 })
        : Response.json({ v1: true });
    };
    await expect(canonHelpers.fetchMap('legacy-en-v1', fallbackFetch as typeof fetch))
      .resolves.toEqual({ kind: 'map', value: { v1: true } });
    expect(calls).toEqual([
      'https://cdn.example.test/cdn-build-id.txt',
      `https://cdn.example.test/job-canon/releases/1234567890123/v2/${sharedV2ShardKey('legacy-en-v1')}.json`,
      `https://cdn.example.test/job-canon/releases/1234567890123/${canonHelpers.v1ShardKey('legacy-en-v1')}.json`,
    ]);

    for (const status of [404, 410]) {
      const retryCalls: string[] = [];
      await canonHelpers.fetchMap('old-slug', (async (url: string) => {
        retryCalls.push(url);
        if (url.endsWith('/cdn-build-id.txt')) return new Response('1234567890123');
        return retryCalls.filter((call) => call.includes('/job-canon/')).length === 1
          ? new Response('missing', { status })
          : Response.json({ v1: true });
      }) as typeof fetch);
      expect(retryCalls).toHaveLength(3);
      expect(new URL(retryCalls[1]).pathname).toContain('/job-canon/releases/1234567890123/v2/');
      expect(new URL(retryCalls[2]).pathname).toContain('/job-canon/releases/1234567890123/');
    }

    const errorCalls: string[] = [];
    await expect(canonHelpers.fetchMap('old-slug', (async (url: string) => {
      errorCalls.push(url);
      return url.endsWith('/cdn-build-id.txt')
        ? new Response('1234567890123')
        : new Response('upstream unavailable', { status: 500 });
    }) as typeof fetch)).resolves.toMatchObject({ kind: 'unavailable', reason: 'http-status' });
    expect(errorCalls).toHaveLength(2);
    expect(new URL(errorCalls[1]).pathname).toContain('/job-canon/releases/1234567890123/v2/');
  });

  it('does not request v1 when v2 contains the shard', async () => {
    const calls: string[] = [];
    const result = await canonHelpers.fetchMap('current-slug', (async (url: string) => {
      calls.push(url);
      return url.endsWith('/cdn-build-id.txt')
        ? new Response('7654321')
        : Response.json({ v2: true });
    }) as typeof fetch);
    expect(result).toEqual({ kind: 'map', value: { v2: true } });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('/cdn-build-id.txt');
    expect(new URL(calls[1]).pathname).toContain('/job-canon/releases/7654321/v2/');
  });

  it('uses a new map URL for each release, including a rollback release', async () => {
    const markers = ['1001', '1002', '1003'];
    const mapCache = new Map<string, unknown>();
    const mapUrls: string[] = [];
    const fetcher = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/cdn-build-id.txt')) {
        return new Response(markers.shift() ?? '', { status: 200 });
      }
      mapUrls.push(url);
      const mapPath = new URL(url).pathname;
      const cached = mapCache.get(mapPath);
      if (cached) return Response.json(cached);
      const buildId = mapPath.match(/\/job-canon\/releases\/([0-9]{1,20})\//)?.[1] ?? null;
      const body = { release: buildId };
      mapCache.set(mapPath, body);
      return Response.json(body);
    }) as typeof fetch;

    await expect(canonHelpers.fetchMap('rollback-job', fetcher)).resolves.toEqual({ kind: 'map', value: { release: '1001' } });
    await expect(canonHelpers.fetchMap('rollback-job', fetcher)).resolves.toEqual({ kind: 'map', value: { release: '1002' } });
    await expect(canonHelpers.fetchMap('rollback-job', fetcher)).resolves.toEqual({ kind: 'map', value: { release: '1003' } });
    expect(mapUrls).toHaveLength(3);
    expect(mapUrls.map((url) => new URL(url).pathname.match(/\/releases\/([0-9]{1,20})\//)?.[1]))
      .toEqual(['1001', '1002', '1003']);
    expect(new Set(mapUrls).size).toBe(3);
  });

  it.each([
    { status: 404, body: '1001', reason: 'http-status' },
    { status: 500, body: '1001', reason: 'http-status' },
    { status: 200, body: '', reason: 'empty' },
    { status: 200, body: 'not-a-build-id', reason: 'invalid' },
    { status: 200, body: '1'.repeat(21), reason: 'invalid' },
  ])('keeps an unavailable marker distinct from a confirmed map miss %#', async ({ status, body, reason }) => {
    const calls: string[] = [];
    const result = await canonHelpers.fetchMap('stale-map-job', (async (input: string) => {
      calls.push(input);
      return new Response(body, { status });
    }) as typeof fetch);
    expect(result).toEqual({ kind: 'unavailable', reason });
    expect(calls).toEqual(['https://cdn.example.test/cdn-build-id.txt']);
  });

  it('reports marker network errors and timeouts as unavailable', async () => {
    await expect(canonHelpers.fetchBuildId((async () => { throw new TypeError('offline'); }) as typeof fetch))
      .resolves.toEqual({ kind: 'unavailable', reason: 'network' });

    vi.useFakeTimers();
    const pending = canonHelpers.fetchBuildId((async (_input: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    })) as typeof fetch);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toEqual({ kind: 'unavailable', reason: 'timeout' });
    vi.useRealTimers();
  });

  it('confirms missing only after v2 and v1 both return 404 or 410', async () => {
    const calls: string[] = [];
    const missing = await canonHelpers.fetchMap('never-published-job', (async (input: string | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/cdn-build-id.txt')) return new Response('1001');
      return new Response('missing', { status: calls.length === 2 ? 404 : 410 });
    }) as typeof fetch);
    expect(missing).toEqual({ kind: 'missing' });
    expect(calls.map((url) => new URL(url).pathname)).toEqual([
      '/cdn-build-id.txt',
      expect.stringMatching(/^\/job-canon\/releases\/1001\/v2\/[0-9a-f]{3}\.json$/),
      '/job-canon/releases/1001/ne.json',
    ]);

    const v1Failure = await canonHelpers.fetchMap('uncertain-job', (async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith('/cdn-build-id.txt')) return new Response('1001');
      return new Response('upstream', { status: new URL(url).pathname.includes('/v2/') ? 404 : 500 });
    }) as typeof fetch);
    expect(v1Failure).toEqual({ kind: 'unavailable', reason: 'http-status' });
  });

  it('does not invoke company or cluster heuristics for unavailable lookups or map-owned slugs', () => {
    const company = vi.fn(() => '/company-target/');
    const cluster = vi.fn(() => '/board-target/');
    expect(resolveFallback({ kind: 'unavailable', reason: 'network' }, 'company-real-job', company, cluster, '/section/'))
      .toBeNull();
    expect(resolveFallback({ kind: 'map', value: { 'company-real-job': {} } }, 'company-real-job', company, cluster, '/section/'))
      .toBeNull();
    expect(company).not.toHaveBeenCalled();
    expect(cluster).not.toHaveBeenCalled();

    expect(resolveFallback({ kind: 'missing' }, 'company-real-job', company, cluster, '/section/'))
      .toBe('/company-target/');
    expect(company).toHaveBeenCalledTimes(1);
  });

  it.each([
    { pathname: '/fr/trouver-emploi-tessin/company-real-job/', marker: new Response('error', { status: 500 }) },
    { pathname: '/fr/trouver-emploi-tessin/ricerca-real-role/', marker: new Response(''), timeout: true },
  ])('leaves an unverified browser job URL on its 404 during marker outage', async ({ pathname, marker, timeout }) => {
    const replacements: string[] = [];
    const fetcher = (async (_input: string | URL | Request, init?: RequestInit) => {
      if (timeout) return new Promise<Response>((_resolve, reject) => {
        if (init?.signal?.aborted) reject(new DOMException('Aborted', 'AbortError'));
        else init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
      return marker;
    }) as typeof fetch;
    // Timeout is driven by the script's own abort signal; no redirect timer exists.
    replacements.push(...await runBrowser404(pathname, fetcher, Boolean(timeout)));
    expect(replacements).toEqual([]);
  });

  it.each([
    { pathname: '/en/jobs-in-zurich/azienda-acme/', expected: '/en/jobs-in-zurich/company-acme/' },
    { pathname: '/en/jobs-in-zurich/search-role-city/', expected: '/en/find-jobs-switzerland/' },
  ])('runs heuristics only after v2/v1 confirm a miss for $pathname', async ({ pathname, expected }) => {
    const calls: string[] = [];
    const fetcher = (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/cdn-build-id.txt')) return new Response('1001');
      return new Response('missing', { status: calls.filter((call) => call.includes('/job-canon/')).length === 1 ? 404 : 410 });
    }) as typeof fetch;
    expect(await runBrowser404(pathname, fetcher)).toEqual([expected]);
    expect(calls).toHaveLength(3);
  });

  it('keeps the canonical browser redirect for a valid map entry', async () => {
    const slug = 'canonical-job';
    const replacements = await runBrowser404(`/en/jobs-in-zurich/${slug}/`, (async (input: string | URL | Request) => {
      return String(input).endsWith('/cdn-build-id.txt')
        ? new Response('1001')
        : Response.json({ [slug]: { en: '/en/find-jobs-zurich' } });
    }) as typeof fetch);
    expect(replacements).toEqual([`/en/find-jobs-zurich/${slug}/`]);
  });

  it('explicitly bypasses marker cache and keeps shard cache keys release-versioned', async () => {
    const options: RequestInit[] = [];
    await canonHelpers.fetchMap('marker-options', (async (input: string, init?: RequestInit) => {
      options.push(init ?? {});
      return String(input).endsWith('/cdn-build-id.txt')
        ? new Response('8123')
        : Response.json({});
    }) as typeof fetch);
    expect(options[0]).toMatchObject({ cache: 'no-store', mode: 'cors', credentials: 'omit' });
    expect(options[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(options[1]).toMatchObject({ cache: 'force-cache', mode: 'cors', credentials: 'omit' });
    expect(canonHelpers.mapUrl('/job-canon/v2/abc.json', '8123'))
      .toBe('https://cdn.example.test/job-canon/releases/8123/v2/abc.json');
    expect(canonHelpers.mapUrl('/job-canon/v2/abc.json', 'invalid')).toBeNull();
  });
});
