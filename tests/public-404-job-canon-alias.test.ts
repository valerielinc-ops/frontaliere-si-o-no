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
      `${canonDeclarations}\nreturn { v1ShardKey: jobCanonV1ShardKey, v2ShardKey: jobCanonV2ShardKey, fetchMap: fetchJobCanonMap };`,
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
    const okResponse = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
    const fallbackFetch = async (url: string) => {
      calls.push(url);
      return calls.length === 1
        ? { ok: false, status: 404, json: async () => null }
        : okResponse({ v1: true });
    };
    await expect(canonHelpers.fetchMap('legacy-en-v1', fallbackFetch as typeof fetch))
      .resolves.toEqual({ v1: true });
    expect(calls).toEqual([
      `https://cdn.example.test/job-canon/v2/${sharedV2ShardKey('legacy-en-v1')}.json`,
      `https://cdn.example.test/job-canon/${canonHelpers.v1ShardKey('legacy-en-v1')}.json`,
    ]);

    for (const status of [404, 410]) {
      const retryCalls: string[] = [];
      await canonHelpers.fetchMap('old-slug', (async (url: string) => {
        retryCalls.push(url);
        return retryCalls.length === 1
          ? { ok: false, status, json: async () => null }
          : okResponse({ v1: true });
      }) as typeof fetch);
      expect(retryCalls).toHaveLength(2);
    }

    const errorCalls: string[] = [];
    await expect(canonHelpers.fetchMap('old-slug', (async (url: string) => {
      errorCalls.push(url);
      return { ok: false, status: 500, json: async () => null };
    }) as typeof fetch)).resolves.toBeNull();
    expect(errorCalls).toHaveLength(1);
  });

  it('does not request v1 when v2 contains the shard', async () => {
    const calls: string[] = [];
    const result = await canonHelpers.fetchMap('current-slug', (async (url: string) => {
      calls.push(url);
      return { ok: true, status: 200, json: async () => ({ v2: true }) };
    }) as typeof fetch);
    expect(result).toEqual({ v2: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('/job-canon/v2/');
  });
});
