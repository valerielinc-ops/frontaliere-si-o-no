import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { jobCanonV2ShardKey as sharedV2ShardKey } from '../services/jobSlugShards';

type AliasResolver = (aliasPath: unknown, requestedLocale: string) => string | null;

describe('public/404.html job-canon alias locale validation', () => {
  let resolveAlias!: AliasResolver;
  let canonHelpers!: {
    v1ShardKey: (slug: string) => string;
    v2ShardKey: (slug: string) => string;
    mapUrl: (path: string, buildId: string) => string | null;
    fetchMap: (slug: string, fetcher: typeof fetch) => Promise<unknown>;
  };

  beforeAll(() => {
    const source = fs.readFileSync(path.resolve(process.cwd(), 'public/404.html'), 'utf8');
    const start = source.indexOf('function jobCanonAliasTarget(');
    const end = source.indexOf('\n            var aliasTarget', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const declaration = source.slice(start, end);
    resolveAlias = new Function(`${declaration}\nreturn jobCanonAliasTarget;`)() as AliasResolver;

    const canonStart = source.indexOf('function jobCanonV1ShardKey(');
    const canonEnd = source.indexOf('// Request locale', canonStart);
    expect(canonStart).toBeGreaterThanOrEqual(0);
    expect(canonEnd).toBeGreaterThan(canonStart);
    const canonDeclarations = source.slice(canonStart, canonEnd);
    canonHelpers = new Function(
      'JOB_CANON_CDN',
      `${canonDeclarations}\nreturn { v1ShardKey: jobCanonV1ShardKey, v2ShardKey: jobCanonV2ShardKey, mapUrl: jobCanonMapUrl, fetchMap: fetchJobCanonMap };`,
    )('https://cdn.example.test') as typeof canonHelpers;
  });

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
      .resolves.toEqual({ v1: true });
    const buildId = '1234567890123';
    expect(calls).toEqual([
      'https://cdn.example.test/cdn-build-id.txt',
      `https://cdn.example.test/job-canon/v2/${sharedV2ShardKey('legacy-en-v1')}.json?build_id=${buildId}`,
      `https://cdn.example.test/job-canon/${canonHelpers.v1ShardKey('legacy-en-v1')}.json?build_id=${buildId}`,
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
      expect(new URL(retryCalls[1]).searchParams.get('build_id')).toBe('1234567890123');
      expect(new URL(retryCalls[2]).searchParams.get('build_id')).toBe('1234567890123');
    }

    const errorCalls: string[] = [];
    await expect(canonHelpers.fetchMap('old-slug', (async (url: string) => {
      errorCalls.push(url);
      return url.endsWith('/cdn-build-id.txt')
        ? new Response('1234567890123')
        : new Response('upstream unavailable', { status: 500 });
    }) as typeof fetch)).resolves.toBeNull();
    expect(errorCalls).toHaveLength(2);
    expect(errorCalls[1]).toContain('/job-canon/v2/');
  });

  it('does not request v1 when v2 contains the shard', async () => {
    const calls: string[] = [];
    const result = await canonHelpers.fetchMap('current-slug', (async (url: string) => {
      calls.push(url);
      return url.endsWith('/cdn-build-id.txt')
        ? new Response('7654321')
        : Response.json({ v2: true });
    }) as typeof fetch);
    expect(result).toEqual({ v2: true });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('/cdn-build-id.txt');
    expect(calls[1]).toContain('/job-canon/v2/');
    expect(new URL(calls[1]).searchParams.get('build_id')).toBe('7654321');
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
      const cached = mapCache.get(url);
      if (cached) return Response.json(cached);
      const buildId = new URL(url).searchParams.get('build_id');
      const body = { release: buildId };
      mapCache.set(url, body);
      return Response.json(body);
    }) as typeof fetch;

    await expect(canonHelpers.fetchMap('rollback-job', fetcher)).resolves.toEqual({ release: '1001' });
    await expect(canonHelpers.fetchMap('rollback-job', fetcher)).resolves.toEqual({ release: '1002' });
    await expect(canonHelpers.fetchMap('rollback-job', fetcher)).resolves.toEqual({ release: '1003' });
    expect(mapUrls).toHaveLength(3);
    expect(mapUrls.map((url) => new URL(url).searchParams.get('build_id'))).toEqual(['1001', '1002', '1003']);
    expect(new Set(mapUrls).size).toBe(3);
  });

  it.each([
    { status: 404, body: '1001' },
    { status: 500, body: '1001' },
    { status: 200, body: '' },
    { status: 200, body: 'not-a-build-id' },
    { status: 200, body: '1'.repeat(21) },
  ])('fails closed on unavailable or invalid marker %#', async ({ status, body }) => {
    const calls: string[] = [];
    const result = await canonHelpers.fetchMap('stale-map-job', (async (input: string) => {
      calls.push(input);
      return new Response(body, { status });
    }) as typeof fetch);
    expect(result).toBeNull();
    expect(calls).toEqual(['https://cdn.example.test/cdn-build-id.txt']);
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
      .toBe('https://cdn.example.test/job-canon/v2/abc.json?build_id=8123');
    expect(canonHelpers.mapUrl('/job-canon/v2/abc.json', 'invalid')).toBeNull();
  });
});
