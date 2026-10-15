// Sharded job slug map (issue #3526).
//
// The 12+ MB /data/jobs-slug-map.json monolith used to be fetched on
// effectively every page view. It is now sharded into
// /data/jobs-slug-map/{00..ff}.json files fetched per-slug on demand
// (router.ensureJobSlugEntriesLoaded), with a zero-loss fallback to the
// monolith when shards are unavailable.
//
// GUARDRAIL under test: every slug that resolved through the monolith MUST
// resolve identically through its shard — including previousSlugs /
// previousSlugsByLocale aliases and cross-job alias collisions.

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  JOB_SLUG_SHARD_COUNT,
  buildJobSlugRecord,
  buildJobSlugShards,
  jobSlugShardKey,
  jobSlugShardPath,
  type SlugMapJobEntry,
} from '@/services/jobSlugShards';

const LOCALES = ['it', 'en', 'de', 'fr'] as const;

// Fixture exercising every record/key shape:
// - jobA: it slug === default (locale-dedup path), other locales differ,
//   plain + locale-aware aliases;
// - jobB: alias colliding with jobA's alias (first job wins) AND alias
//   colliding with jobA's primary slug (primary always wins);
// - jobC: slim shape (no slugByLocale) — contributes id/canton meta;
// - jobD: slugByLocale without a default slug.
const jobA: SlugMapJobEntry = {
  id: 'acme-0001',
  canton: 'ti',
  slug: 'operaio-acme-lugano',
  slugByLocale: {
    it: 'operaio-acme-lugano',
    en: 'worker-acme-lugano',
    de: 'arbeiter-acme-lugano',
    fr: 'ouvrier-acme-lugano',
  },
  previousSlugs: ['vecchio-operaio-acme', 'alias-conteso'],
  previousSlugsByLocale: { en: ['old-worker-acme'], de: [] },
};
const jobB: SlugMapJobEntry = {
  id: 'beta-0002',
  canton: 'AI',
  slug: 'infermiere-beta-appenzello',
  slugByLocale: { it: 'infermiere-beta-appenzello', en: 'nurse-beta-appenzell' },
  // 'alias-conteso' already taken by jobA (alias fills gaps only, first wins);
  // 'operaio-acme-lugano' is jobA's primary (primary always wins over alias).
  previousSlugs: ['alias-conteso', 'operaio-acme-lugano', 'vecchio-infermiere-beta'],
};
const jobC: SlugMapJobEntry = {
  id: 'gamma-0003',
  canton: 'GR',
  slug: 'cuoco-gamma-coira',
  previousSlugs: ['vecchio-cuoco-gamma'],
};
const jobD: SlugMapJobEntry = {
  id: 'delta-0004',
  canton: 'VD',
  slugByLocale: { fr: 'plombier-delta-lausanne' },
};
const FIXTURE: SlugMapJobEntry[] = [jobA, jobB, jobC, jobD];

function lookupKeysOf(job: SlugMapJobEntry): string[] {
  const keys = new Set<string>();
  if (job.slug) keys.add(job.slug);
  for (const s of Object.values(job.slugByLocale ?? {})) if (s) keys.add(s);
  for (const s of job.previousSlugs ?? []) if (s) keys.add(s);
  for (const arr of Object.values(job.previousSlugsByLocale ?? {})) {
    for (const s of arr ?? []) if (s) keys.add(s);
  }
  return [...keys];
}
const ALL_KEYS = [...new Set(FIXTURE.flatMap(lookupKeysOf))];

type FetchLike = (url: string) => Promise<{ ok: boolean; status?: number; json: () => Promise<unknown> }>;

/** Fresh router module instance (module-level slug-map state reset). */
async function freshRouter() {
  vi.resetModules();
  return import('@/services/router');
}

function stubFetch(impl: FetchLike) {
  const spy = vi.fn(impl);
  vi.stubGlobal('fetch', spy);
  return spy;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('jobSlugShardKey / buildJobSlugShards', () => {
  it('shard key is a stable two-hex-char bucket', () => {
    for (const key of ALL_KEYS) {
      const shard = jobSlugShardKey(key);
      expect(shard).toMatch(/^[0-9a-f]{2}$/);
      expect(jobSlugShardKey(key)).toBe(shard); // deterministic
      expect(parseInt(shard, 16)).toBeLessThan(JOB_SLUG_SHARD_COUNT);
    }
    expect(jobSlugShardPath('ab')).toBe('/data/jobs-slug-map/ab.json');
  });

  it('emits the full stable shard file set and places every key in its hash shard', () => {
    const shards = buildJobSlugShards(FIXTURE);
    expect(Object.keys(shards)).toHaveLength(JOB_SLUG_SHARD_COUNT);
    const seen = new Set<string>();
    for (const [shardKey, shard] of Object.entries(shards)) {
      for (const key of Object.keys(shard)) {
        expect(jobSlugShardKey(key)).toBe(shardKey);
        seen.add(key);
      }
    }
    for (const key of ALL_KEYS) expect(seen).toContain(key);
  });

  it('primary keys win over aliases; earlier alias wins over later alias', () => {
    const shards = buildJobSlugShards(FIXTURE);
    const recordFor = (key: string) => shards[jobSlugShardKey(key)][key];
    // jobB listed jobA's primary slug as alias → jobA (primary) keeps the key.
    expect(recordFor('operaio-acme-lugano')?._id).toBe('acme-0001');
    // Contested alias: jobA processed first → jobA wins.
    expect(recordFor('alias-conteso')?._id).toBe('acme-0001');
    // Locale slug equal to default is omitted from the record (falls back to
    // _default at lookup time).
    const recA = recordFor('worker-acme-lugano');
    expect(recA?._default).toBe('operaio-acme-lugano');
    expect(recA?.it).toBeUndefined();
    expect(recA?.en).toBe('worker-acme-lugano');
  });

  it('buildJobSlugRecord returns null for jobs with no slugs at all', () => {
    expect(buildJobSlugRecord({ id: 'x', canton: 'TI' })).toBeNull();
  });
});

describe('shard/monolith parity (zero-loss guardrail)', () => {
  it('every lookup key resolves identically via shards and via the monolith', async () => {
    // Oracle: monolith path (registerJobSlugMap over the full fixture).
    const monolith = await freshRouter();
    monolith.registerJobSlugMap(FIXTURE as Parameters<typeof monolith.registerJobSlugMap>[0]);
    const expected = new Map<string, { meta: unknown; translations: Record<string, string | undefined> }>();
    for (const key of ALL_KEYS) {
      const translations: Record<string, string | undefined> = {};
      for (const loc of LOCALES) translations[loc] = monolith.getLocalizedJobSlug(key, loc);
      expected.set(key, { meta: monolith.getJobMetaForSlug(key), translations });
    }

    // Candidate: shard path — serve buildJobSlugShards output over fetch and
    // ensure each key individually.
    const shards = buildJobSlugShards(FIXTURE);
    const fetchSpy = stubFetch(async (url: string) => {
      const match = /\/data\/jobs-slug-map\/([0-9a-f]{2})\.json$/.exec(url);
      if (!match) throw new Error(`unexpected fetch: ${url}`);
      return { ok: true, json: async () => shards[match[1]] };
    });
    const sharded = await freshRouter();
    for (const key of ALL_KEYS) {
      await sharded.ensureJobSlugEntriesLoaded([key]);
      expect(sharded.isJobSlugReady(key)).toBe(true);
      const want = expected.get(key)!;
      expect(sharded.getJobMetaForSlug(key)).toEqual(want.meta);
      for (const loc of LOCALES) {
        expect(sharded.getLocalizedJobSlug(key, loc)).toBe(want.translations[loc]);
      }
    }
    // Monolith never requested on the shard path.
    for (const call of fetchSpy.mock.calls) {
      expect(String(call[0])).not.toBe('/data/jobs-slug-map.json');
    }
  });

  it('dedupes shard fetches: same-shard slugs and repeat calls fetch once', async () => {
    const shards = buildJobSlugShards(FIXTURE);
    const fetchSpy = stubFetch(async (url: string) => {
      const match = /\/data\/jobs-slug-map\/([0-9a-f]{2})\.json$/.exec(url);
      if (!match) throw new Error(`unexpected fetch: ${url}`);
      return { ok: true, json: async () => shards[match[1]] };
    });
    const router = await freshRouter();
    const key = 'operaio-acme-lugano';
    await Promise.all([
      router.ensureJobSlugEntriesLoaded([key]),
      router.ensureJobSlugEntriesLoaded([key, key]),
    ]);
    await router.ensureJobSlugEntriesLoaded([key]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('unknown slug in a 200 shard is a confirmed miss: ready, no monolith fallback', async () => {
    const shards = buildJobSlugShards(FIXTURE);
    const fetchSpy = stubFetch(async (url: string) => {
      const match = /\/data\/jobs-slug-map\/([0-9a-f]{2})\.json$/.exec(url);
      if (!match) throw new Error(`unexpected fetch: ${url}`);
      return { ok: true, json: async () => shards[match[1]] };
    });
    const router = await freshRouter();
    const ghost = 'slug-che-non-esiste-affatto';
    await router.ensureJobSlugEntriesLoaded([ghost]);
    expect(router.isJobSlugReady(ghost)).toBe(true);
    expect(router.getJobMetaForSlug(ghost)).toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('falls back to the full monolith when a shard fetch fails (zero-loss)', async () => {
    const fetched: string[] = [];
    stubFetch(async (url: string) => {
      fetched.push(String(url));
      if (String(url) === '/data/jobs-slug-map.json') {
        return { ok: true, json: async () => FIXTURE };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });
    const router = await freshRouter();
    await router.ensureJobSlugEntriesLoaded(['vecchio-cuoco-gamma']);
    expect(fetched).toContain('/data/jobs-slug-map.json');
    // Alias resolved through the monolith exactly as before the sharding.
    expect(router.getJobMetaForSlug('vecchio-cuoco-gamma')).toMatchObject({ id: 'gamma-0003', canton: 'GR' });
    // Full map loaded → everything is ready, later ensures are no-ops.
    expect(router.isJobSlugReady('worker-acme-lugano')).toBe(true);
    const before = fetched.length;
    await router.ensureJobSlugEntriesLoaded(['worker-acme-lugano']);
    expect(fetched.length).toBe(before);
  });
});

describe('registerJobSlugMap merge semantics', () => {
  it('slim (no slugByLocale) jobs contribute id + canton instead of being skipped', async () => {
    const router = await freshRouter();
    router.registerJobSlugMap([{ id: 'slim-1', canton: 'sz', slug: 'pulizie-spital-schwyz', previousSlugs: ['vecchie-pulizie-schwyz'] }]);
    expect(router.getJobMetaForSlug('pulizie-spital-schwyz')).toMatchObject({ id: 'slim-1', canton: 'SZ' });
    expect(router.getJobMetaForSlug('vecchie-pulizie-schwyz')).toMatchObject({ id: 'slim-1', canton: 'SZ' });
  });

  it('later partial registrations merge instead of wiping earlier entries', async () => {
    const router = await freshRouter();
    router.registerJobSlugMap(FIXTURE as Parameters<typeof router.registerJobSlugMap>[0]);
    // Slim re-registration of ONE job (the JobBoard finalize path) must not
    // drop the other jobs from the map.
    router.registerJobSlugMap([{ id: 'acme-0001', canton: 'TI', slug: 'operaio-acme-lugano' }]);
    expect(router.getJobMetaForSlug('nurse-beta-appenzell')).toMatchObject({ id: 'beta-0002', canton: 'AI' });
    expect(router.getLocalizedJobSlug('worker-acme-lugano', 'de')).toBe('arbeiter-acme-lugano');
  });
});
