// Slim job index — previousSlugs* de-duplication (issue 5001, PageSpeed/INP).
//
// `jobs-<locale>-index.json` used to carry `previousSlugs` +
// `previousSlugsByLocale` on every record. That data ALREADY lives in the
// sharded slug map (/data/jobs-slug-map/{00..ff}.json), which the SPA fetches
// one ~16 KB shard at a time. Measured on production 2026-08-07:
//
//   jobs-it-index.json .................. 27.957.668 B raw / 3.692.814 B gzip
//   previousSlugs + previousSlugsByLocale  11.676.354 B raw  (41,8% of the file)
//   without them ........................ 16.281.314 B raw / 2.683.239 B gzip
//   JSON.parse + registerJobSlugMap ..... 104,6 ms → 42,2 ms (median, 21.164 rec)
//   registerJobSlugMap Map entries ...... 77.710 → 21.164
//
// THE RISK THIS FILE GUARDS: `previousSlugs` is how an already-indexed legacy
// job URL keeps resolving. On a site living on organic traffic, breaking an
// indexed URL is worse than a slow page. So the guardrail is NOT "the field is
// gone" — it is "the field is gone from the LISTING payload AND a historic slug
// still resolves to its current job through the shard path the router uses".

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  SLIM_INDEX_FIELDS,
  buildLocaleJobSlim,
  buildSlimSeed,
} from '../build-plugins/shared/slimJobIndex';
import {
  buildJobSlugShards,
  jobSlugShardKey,
  jobSlugShardPath,
  type SlugMapJobEntry,
} from '@/services/jobSlugShards';

const root = path.resolve(__dirname, '..');

// Shapes mirrored from real production records (jobs-it-index.json, 2026-08-07):
// a renamed job carries BOTH the flat alias list and the locale-aware one, and
// the IT alias list repeats the flat one.
const renamedJob = {
  id: 'vaudoise-7b88edb95d04',
  canton: 'VD',
  slug: 'business-analista-atlassian-h-f-x-80-100-vaudoise-assurances-lausanne',
  slugByLocale: {
    it: 'business-analista-atlassian-h-f-x-80-100-vaudoise-assurances-lausanne',
    en: 'business-analyst-atlassian-h-f-x-80-100-vaudoise-ch',
    de: 'business-analyst-atlassian-h-f-x-80-100-vaudoise-ch',
    fr: 'business-analyst-atlassian-h-f-x-80-100-vaudoise-ch',
  },
  previousSlugs: [
    'business-analyst-atlassian-h-f-x-80-100-vaudoise-ch',
    'business-analista-h-f-x-80-100-vaudoise-assurances-lausanne',
  ],
  previousSlugsByLocale: {
    it: [
      'business-analyst-atlassian-h-f-x-80-100-vaudoise-ch',
      'business-analista-h-f-x-80-100-vaudoise-assurances-lausanne',
    ],
  },
  title: 'Business Analista Atlassian',
  company: 'Vaudoise Assurances',
  location: 'Lausanne',
  category: 'tech',
  description: 'detail-only prose that must never reach the listing payload',
};

/** The ONLY alias of `renamedJob` that is not also one of its current slugs —
 * i.e. a genuinely historic, already-indexed URL. */
const HISTORIC_SLUG =
  'business-analista-h-f-x-80-100-vaudoise-assurances-lausanne';
const CURRENT_SLUG = renamedJob.slug;

describe('slim index no longer duplicates the slug-rename history', () => {
  it('SLIM_INDEX_FIELDS excludes previousSlugs and previousSlugsByLocale', () => {
    expect(SLIM_INDEX_FIELDS.has('previousSlugs')).toBe(false);
    expect(SLIM_INDEX_FIELDS.has('previousSlugsByLocale')).toBe(false);
  });

  it('a slim index record drops both fields but keeps slug + routing identity', () => {
    const slim = buildLocaleJobSlim(renamedJob as Record<string, unknown>);
    expect(slim).not.toHaveProperty('previousSlugs');
    expect(slim).not.toHaveProperty('previousSlugsByLocale');
    // The fields that make the record routable / listable must survive.
    expect(slim.slug).toBe(CURRENT_SLUG);
    expect(slim.id).toBe(renamedJob.id);
    expect(slim.canton).toBe('VD');
  });

  it('the build-injected window.__JOB_SEED__ drops them too (same field set)', () => {
    const seed = buildSlimSeed(renamedJob, 'it');
    expect(seed).not.toHaveProperty('previousSlugs');
    expect(seed).not.toHaveProperty('previousSlugsByLocale');
    expect(seed.slug).toBe(CURRENT_SLUG);
  });

  it('measurably shrinks the serialized record', () => {
    const slim = buildLocaleJobSlim(renamedJob as Record<string, unknown>);
    const withHistory = {
      ...slim,
      previousSlugs: renamedJob.previousSlugs,
      previousSlugsByLocale: renamedJob.previousSlugsByLocale,
    };
    expect(JSON.stringify(slim).length).toBeLessThan(
      JSON.stringify(withHistory).length,
    );
  });
});

describe('the slug-rename history keeps its ONE home: the slug map', () => {
  it('localeJobsSplitPlugin still writes previousSlugs* into jobs-slug-map.json', () => {
    // This is the source the shards are built from. If this ever stops
    // emitting the aliases, historic URLs break site-wide — the assertions
    // below would still pass on a fixture, so pin the emitter itself.
    const src = fs.readFileSync(
      path.resolve(root, 'build-plugins/localeJobsSplitPlugin.ts'),
      'utf-8',
    );
    expect(src).toMatch(/entry\.previousSlugs = j\.previousSlugs/);
    expect(src).toMatch(/entry\.previousSlugsByLocale = j\.previousSlugsByLocale/);
    expect(src).toMatch(/buildJobSlugShards\(/);
  });

  it('does NOT take the slim field set as the slug-map field set', () => {
    // Guards against a future "tidy-up" that makes the slug map reuse
    // SLIM_INDEX_FIELDS and silently drops the aliases with it.
    const src = fs.readFileSync(
      path.resolve(root, 'build-plugins/localeJobsSplitPlugin.ts'),
      'utf-8',
    );
    const slugMapBlock = src.slice(
      src.indexOf('const slugMap = jobs.map'),
      src.indexOf("path.resolve(dataDir, 'jobs-slug-map.json')"),
    );
    expect(slugMapBlock.length).toBeGreaterThan(0);
    expect(slugMapBlock).not.toMatch(/SLIM_INDEX_FIELDS|buildLocaleJobSlim/);
  });
});

describe('PROOF: a historic slug still resolves without the index carrying it', () => {
  // Replays, step by step, exactly what the runtime does:
  //   router.ensureJobSlugEntriesLoaded([slug])
  //     → jobSlugShardKey(slug) → fetch(jobSlugShardPath(key)) → merge
  //   router.getJobMetaForSlug(slug) → { id, canton, canonicalSlug }
  //   JobBoard selectedJob → jobs.find(j => matchesRouteSlug(j, canonicalSlug))
  const shards = buildJobSlugShards([renamedJob as SlugMapJobEntry]);

  it('the historic slug is absent from the slim listing payload', () => {
    const slim = buildLocaleJobSlim(renamedJob as Record<string, unknown>);
    expect(JSON.stringify(slim)).not.toContain(HISTORIC_SLUG);
  });

  it('the historic slug hashes to a shard that actually contains it', () => {
    const key = jobSlugShardKey(HISTORIC_SLUG);
    expect(jobSlugShardPath(key)).toBe(`/data/jobs-slug-map/${key}.json`);
    expect(shards[key]).toBeDefined();
    expect(shards[key][HISTORIC_SLUG]).toBeDefined();
  });

  it('that shard record yields the CURRENT slug, id and canton', () => {
    const record = shards[jobSlugShardKey(HISTORIC_SLUG)][HISTORIC_SLUG];
    // getJobMetaForSlug reads exactly these three.
    expect(record._default).toBe(CURRENT_SLUG); // → canonicalSlug
    expect(record._id).toBe(renamedJob.id);
    expect(record._canton).toBe('VD');
  });

  it('the canonical slug it returns DOES match the slim record', () => {
    // The final link in the chain: JobBoard looks the job up by the canonical
    // slug in the slim `jobs` array. The slim record has no aliases — but it
    // does have this slug, so the lookup succeeds.
    const record = shards[jobSlugShardKey(HISTORIC_SLUG)][HISTORIC_SLUG];
    const slim = buildLocaleJobSlim(renamedJob as Record<string, unknown>);
    expect(slim.slug).toBe(record._default);
  });

  it('resolves every alias of the job, flat and locale-aware alike', () => {
    const aliases = new Set<string>([
      ...renamedJob.previousSlugs,
      ...Object.values(renamedJob.previousSlugsByLocale).flat(),
    ]);
    expect(aliases.size).toBeGreaterThan(1);
    for (const alias of aliases) {
      const record = shards[jobSlugShardKey(alias)][alias];
      expect(record, `alias "${alias}" must resolve`).toBeDefined();
      expect(record._id).toBe(renamedJob.id);
      // Aliases that are ALSO a current locale slug resolve to that job too;
      // either way the id is right, which is what the bridge fetch needs.
    }
  });

  it('an unknown slug resolves to nothing (no false positive)', () => {
    const unknown = 'questo-slug-non-e-mai-esistito';
    expect(shards[jobSlugShardKey(unknown)][unknown]).toBeUndefined();
  });

  // Reviewer question (#5325): with TWO renames, does an alias resolve to the
  // slug that is really current, or to an intermediate slug that is itself
  // historic by now? Answer: to the current one, BY CONSTRUCTION —
  // buildJobSlugRecord builds ONE record per job whose `_default` is the job's
  // current slug, and points EVERY alias at that same record. It is a flat
  // alias -> job mapping, not a chain of hops, so there is no intermediate to
  // land on and no hop count that can degrade. Production data backs the
  // premise that the crawler accumulates renames rather than overwriting the
  // last one: 19.860 of 21.164 records carry >= 1 alias, 61.064 aliases total
  // (~3 per renamed job), measured 2026-08-07.
  it('a job renamed TWICE resolves BOTH old slugs to the CURRENT one', () => {
    const twiceRenamed = {
      id: 'acme-0007',
      canton: 'TI',
      slug: 'terzo-slug-corrente-acme-lugano',
      slugByLocale: { it: 'terzo-slug-corrente-acme-lugano' },
      // Oldest first, exactly how the crawler appends them.
      previousSlugs: ['primo-slug-originale-acme-lugano', 'secondo-slug-intermedio-acme-lugano'],
    };
    const s = buildJobSlugShards([twiceRenamed as SlugMapJobEntry]);
    for (const oldSlug of twiceRenamed.previousSlugs) {
      const record = s[jobSlugShardKey(oldSlug)][oldSlug];
      expect(record, `"${oldSlug}" must resolve`).toBeDefined();
      // The current slug — never the intermediate one.
      expect(record._default).toBe('terzo-slug-corrente-acme-lugano');
      expect(record._id).toBe('acme-0007');
    }
    // And explicitly: the oldest alias does NOT land on the intermediate slug.
    const oldest = twiceRenamed.previousSlugs[0];
    expect(s[jobSlugShardKey(oldest)][oldest]._default).not.toBe(
      'secondo-slug-intermedio-acme-lugano',
    );
  });
});

describe('JobBoard consumes the shard mapping instead of the index field', () => {
  const src = fs.readFileSync(
    path.resolve(root, 'components/community/JobBoard.tsx'),
    'utf-8',
  );

  it('records the alias → canonical mapping from getJobMetaForSlug', () => {
    expect(src).toMatch(/const canonicalSlug = meta\?\.canonicalSlug/);
    expect(src).toMatch(/setAliasCanonical\(\{ alias: targetSlug, canonical: canonicalSlug \}\)/);
  });

  it('sets it BEFORE the canton/id early-return, so an already-loaded canton still resolves', () => {
    const setIdx = src.indexOf('setAliasCanonical({ alias: targetSlug');
    const guardIdx = src.indexOf('if (!meta?.canton || !meta?.id) return;');
    expect(setIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeGreaterThan(-1);
    expect(setIdx).toBeLessThan(guardIdx);
  });

  it('selectedJob looks the job up by the canonical slug', () => {
    expect(src).toMatch(/aliasCanonical && aliasCanonical\.alias === routeSlug/);
    expect(src).toMatch(/\? aliasCanonical\.canonical/);
  });

  it('pairs the alias with its canonical so a stale value cannot leak across navigations', () => {
    expect(src).toMatch(
      /useState<\{ alias: string; canonical: string \} \| null>\(null\)/,
    );
  });
});

describe('a bridge page is never mis-parsed as a filter landing', () => {
  const src = fs.readFileSync(
    path.resolve(root, 'components/community/JobBoard.tsx'),
    'utf-8',
  );

  it('company, location AND search filters all short-circuit on a bridge page', () => {
    // Measured on prod 2026-08-07: 8 historic slugs start with a company
    // prefix and 13 with a search prefix. parseCompanySlugFilter used to catch
    // the company ones via jobs[].previousSlugs (now gone); parseSearchSlugFilter
    // never had a guard at all. Same class → fixed together (AGENTS.md §6).
    expect(src).toMatch(/const isBridgePage = !!bridgeTargetSlug/);
    expect(src).toMatch(/if \(isBridgePage\) return null;/);
    expect(src).toMatch(/isBridgePage \? null : parseLocationSlugFilter\(initialJobSlug\)/);
    expect(src).toMatch(/isBridgePage \? null : parseSearchSlugFilter\(initialJobSlug\)/);
  });

  it('guards EVERY parseSearchSlugFilter(initialJobSlug) call site', () => {
    // Three call sites read the ROUTE slug: the searchSlugFilter memo, the
    // popstate handler, and the searchQuery useState initializer. An unguarded
    // one lets a bridge page's old slug become the search query, filtering the
    // listing on what is actually a job URL. (The fourth occurrence,
    // `shouldRestoreJobBoardListState`, takes a *navigation history* slug, not
    // the route slug — different construct, deliberately not guarded.)
    const callSites = src.match(/parseSearchSlugFilter\(initialJobSlug\)/g) ?? [];
    expect(callSites.length).toBe(3);
    const guarded =
      (src.match(/isBridgePage \? null : parseSearchSlugFilter\(initialJobSlug\)/g) ?? []).length +
      (src.match(/readBridgeTargetSlug\(\) \? null : parseSearchSlugFilter\(initialJobSlug\)/g) ?? []).length;
    expect(guarded).toBe(callSites.length);
  });

  // Reviewer question (#5325): bridgeTargetSlug was a `useMemo(..., [])`, so on
  // SPA soft-navigation (no remount) it stayed pinned to the page we arrived on.
  // Before this PR that staleness was masked — companySlugFilter took precedence
  // over selectedJob — but once the filters short-circuit on isBridgePage, a
  // stale global nulls the NEW route's filter and re-renders the previous job.
  it('the build-seeded globals are scoped to the pathname that shipped them', () => {
    expect(src).toMatch(/const SEEDED_GLOBALS_PATHNAME: string \| null =/);
    expect(src).toMatch(
      /function onSeededDocument\(\): boolean \{[\s\S]*?window\.location\.pathname === SEEDED_GLOBALS_PATHNAME/,
    );
    // Both readers of a build-injected global go through it.
    expect(src).toMatch(/function readBridgeTargetSlug\(\)[\s\S]{0,200}?if \(!onSeededDocument\(\)\) return undefined;/);
    expect(src).toMatch(/function readSeededJob\(\)[\s\S]{0,900}?if \(!onSeededDocument\(\)\) return null;/);
  });

  it('__JOB_SEED__ does not leak into a later route (stale-seed class)', () => {
    // A stale seed prepends the previous job to the listing via `finalize`, and
    // routes the load effect down the requestIdleCallback branch on a page where
    // the index is the above-the-fold content. Both need the memo to re-run.
    // The key is the PATHNAME, which is what `onSeededDocument` above actually
    // compares. It used to be `initialJobSlug`, a strictly coarser signal: two
    // different pathnames can share one route slug (the `ricerca-` keyword-page
    // and search-cluster families overlap), and on such a navigation the memo
    // would not re-run — leaving the guard unreachable and the stale seed in
    // place, which is the very leak this test is about.
    expect(src).toMatch(/const seededJob = useMemo\(\(\) => readSeededJob\(\), \[seedPathname\]\)/);
    expect(src).toMatch(/const seedPathname = typeof window === 'undefined' \? '' : window\.location\.pathname;/);
    expect(src).not.toMatch(/const seededJob = useMemo\(\(\) => readSeededJob\(\), \[\]\)/);
  });

  it('bridgeTargetSlug re-reads per route instead of pinning at mount', () => {
    // A `[]` dep list would defeat the pathname guard above: the memo would
    // never re-run, so the stale value would survive every soft-navigation.
    expect(src).toMatch(
      /const bridgeTargetSlug = useMemo\(\(\) => readBridgeTargetSlug\(\), \[initialJobSlug\]\)/,
    );
    expect(src).not.toMatch(
      /const bridgeTargetSlug = useMemo\(\(\) => readBridgeTargetSlug\(\), \[\]\)/,
    );
  });

  it('the useState initializer uses the module-level reader (no hook-order trap)', () => {
    // `isBridgePage` is declared far below the initializer, so referencing it
    // there would be a TDZ error. The module-level reader has no such constraint.
    expect(src).toMatch(/function readBridgeTargetSlug\(\): string \| undefined/);
    expect(src).toMatch(
      /useState\(\(\) => \(readBridgeTargetSlug\(\) \? null : parseSearchSlugFilter\(initialJobSlug\)\) \|\| readSearchQueryFromUrl\(\)\)/,
    );
    // Single source of truth: the hook reads the same helper (dep list asserted
    // separately, in the per-route re-read test above).
    expect(src).toMatch(/const bridgeTargetSlug = useMemo\(\(\) => readBridgeTargetSlug\(\)/);
  });

  it('bridgeTargetSlug is declared before the filter memos that read it', () => {
    const bridgeIdx = src.indexOf('const bridgeTargetSlug = useMemo(');
    const companyIdx = src.indexOf('const companySlugFilter = useMemo(');
    const searchIdx = src.indexOf('const searchSlugFilter = useMemo(');
    expect(bridgeIdx).toBeGreaterThan(-1);
    expect(bridgeIdx).toBeLessThan(companyIdx);
    expect(bridgeIdx).toBeLessThan(searchIdx);
  });

  // LOAD-BEARING INVARIANT for the short-circuit above: `__BRIDGE_TARGET_SLUG__`
  // must mean "job bridge page" and nothing else. If a location-hub or
  // search-cluster emitter ever started setting it, `isBridgePage` would null
  // out that page's own filter and blank the listing. Only the job-bridge path
  // (jobsSeoPagesPlugin + its bridgeThinShell) may write it — which is also how
  // ~15 dist validators already identify a bridge page
  // (e.g. scripts/validate-canonical.mjs: `content.includes('__BRIDGE_TARGET_SLUG__')`).
  it.each([
    'build-plugins/locationHubBridgePlugin.ts',
    'build-plugins/relatedSearchClustersPlugin.ts',
    'build-plugins/shared/clusterThinShell.ts',
    'build-plugins/shared/gscKeywordThinShell.ts',
  ])('%s must NOT emit __BRIDGE_TARGET_SLUG__', (rel) => {
    const content = fs.readFileSync(path.resolve(root, rel), 'utf-8');
    // Comments may reference the global; an emit writes `window.__BRIDGE...=`.
    expect(content).not.toMatch(/window\.__BRIDGE_TARGET_SLUG__\s*=/);
  });

  it('only the job-bridge thin shell is imported by the job SEO pages plugin', () => {
    const shell = fs.readFileSync(
      path.resolve(root, 'build-plugins/shared/bridgeThinShell.ts'),
      'utf-8',
    );
    expect(shell).toMatch(/window\.__BRIDGE_TARGET_SLUG__=/);
    const jobsPlugin = fs.readFileSync(
      path.resolve(root, 'build-plugins/jobsSeoPagesPlugin.ts'),
      'utf-8',
    );
    expect(jobsPlugin).toMatch(/from '\.\/shared\/bridgeThinShell'/);
  });
});
