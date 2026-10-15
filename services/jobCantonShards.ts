// jobCantonShards.ts
//
// Single source of truth for the PER-CANTON job shards — the canton-scoped
// projection of `jobs-<locale>-index.json` that lets a canton SERP
// (`/cerca-lavoro-ticino/`, `/cerca-lavoro-zurigo/`, …) load only the records
// it actually renders instead of the whole locale corpus.
//
// Measured on the live IT index (21 068 records, 2026-08-07): the TI page
// renders 1 212 of them — 5.7%. The other 94.3% were downloaded, parsed and
// registered into the router slug map on every canton landing.
//
// Used by BOTH:
//   1. build-plugins/localeJobsSplitPlugin — emits
//      dist/data/jobs-by-canton/<KEY>-<locale>.json inside the same per-locale
//      loop that writes the index, straight off the same `slimJobs` array;
//   2. services/jobsService.ts — resolves a canton code to its shard URL.
//
// Deriving both from this module means the emitted shard and the fetched shard
// agree BY CONSTRUCTION (AGENTS.md §6: a construct duplicated across ≥2 files
// → one shared module).
//
// THE INVARIANT THAT MATTERS, and the reason this file is thin:
//
//     buildCantonShards(index)[KEY]  ≡  scopeJobsToCanton(index, KEY)
//
// The shard is *defined* as the slice the SPA already computes client-side
// today. Sharding therefore cannot change which jobs a canton page renders —
// it only moves the filter from the browser to the build. Proven for all 24
// keys over a real index snapshot in tests/job-canton-shards.test.ts.
//
// Both sides bucket through `expandCantonGroup` — the same primitive
// `scopeJobsToCanton` uses — so the half-canton merge (AI+AR → APPENZELLO,
// BL+BS → BASILEA) cannot drift between them.
//
// This module must stay light: it is imported (relative, no `@/` alias) from
// the vite.config plugin graph, where alias VALUE imports fail at config load.

import CANTON_URL_SLUGS_RAW from '../data/canton-url-slugs.json';
import { expandCantonGroup, resolveCantonGroup } from './cantonList';

interface CantonUrlSlugsShape {
  cantons: Record<string, unknown>;
}

const RAW = CANTON_URL_SLUGS_RAW as unknown as CantonUrlSlugsShape;

/** Directory (under dist/) holding the shard files. This is the path the
 * runtime fetch layer has pointed at since 2026-05-20; it used to be a private
 * `SHARD_BASE_PATH` constant inside `services/jobsService.ts`, which now builds
 * its URLs through this module instead so emitter and consumer share one
 * definition. */
export const JOB_CANTON_SHARD_DIR = '/data/jobs-by-canton';

/** The locales the index — and therefore the shards — are emitted for. */
export const JOB_CANTON_SHARD_LOCALES = ['it', 'en', 'de', 'fr'] as const;

/**
 * Every canton shard key: the 24 URL canton keys from
 * `data/canton-url-slugs.json` (26 BFS codes with AI+AR collapsed onto
 * `APPENZELLO` and BL+BS onto `BASILEA`, matching the URL layer).
 *
 * Sorted for a stable emit order — the shard bytes must be byte-stable across
 * builds for unchanged data, because `jobsService` revalidates them with
 * `If-None-Match` and a churning ETag would defeat the IDB cache.
 */
export const CANTON_SHARD_KEYS: ReadonlyArray<string> = Object.freeze(
  Object.keys(RAW.cantons).map((k) => k.toUpperCase()).sort(),
);

/**
 * Normalise any canton code to the key its shard file is named after.
 *
 * Load-bearing: callers pass canton codes from two different layers.
 *   - The listing path passes the URL group key (`initialFilterCanton`, e.g.
 *     `'BASILEA'`) — already a shard key, round-trips unchanged.
 *   - The BRIDGE path passes the RAW BFS code (`getJobMetaForSlug(slug).canton`,
 *     e.g. `'BS'`) — must collapse onto `'BASILEA'` or the fetch 404s and an
 *     indexed job URL falls through to JobOrphanView.
 *
 * Unknown codes (and the `_AGGREGATE_` sentinel) round-trip unchanged; the
 * caller's 404 handling covers them.
 *
 * Delegates to `cantonList.resolveCantonGroup` — the single home for the
 * member→group inversion, shared with `services/router.ts`'s URL-emission
 * boundary. A shard key and a URL canton key are the same thing by
 * construction, which is the property that keeps a bridge URL and the shard it
 * fetches in agreement. Named separately because this is the shard layer's
 * concept and its call sites read better for it.
 */
export function resolveCantonShardKey(cantonCode: string): string {
  return resolveCantonGroup(cantonCode);
}

/** File name of one shard. Locale is part of the name because the slim index
 * is locale-flattened: the same job carries a different `slug` and `title` per
 * locale (measured: 92% of slugs and 93% of titles differ between IT and DE),
 * so a locale-agnostic shard would serve Italian URLs to a German page. */
export function cantonShardFileName(cantonKey: string, locale: string): string {
  return `${cantonKey}-${locale}.json`;
}

/** Path (same-origin, pre-`cdnDataUrl`) of one shard file. */
export function jobCantonShardPath(cantonKey: string, locale: string): string {
  return `${JOB_CANTON_SHARD_DIR}/${cantonShardFileName(cantonKey, locale)}`;
}

/** Path of the shard manifest. */
export const JOB_CANTON_MANIFEST_PATH = `${JOB_CANTON_SHARD_DIR}/manifest.json`;

/**
 * Shard-set manifest (measured 332 B raw / 221 B br at 24 canton keys).
 * Counts are locale-invariant — the four locales
 * hold the same job set, only its strings differ — so one file serves all of
 * them.
 *
 * `total` exists so a consumer that needs only the corpus SIZE (the job-board
 * `<title>` count label) can stop downloading a multi-megabyte index to call
 * `.size` on it. `byCanton` lets a caller reject a truncated shard set before
 * trusting it, and gives the post-deploy gate one cheap URL whose 200 proves
 * the whole directory published.
 */
export interface CantonShardManifest {
  readonly generatedAt: string;
  readonly total: number;
  readonly locales: ReadonlyArray<string>;
  readonly byCanton: Readonly<Record<string, number>>;
}

/**
 * Bucket a locale index into its per-canton shards.
 *
 * EVERY key in {@link CANTON_SHARD_KEYS} is present in the result, empty ones
 * as `[]`. That is deliberate and mirrors the slug-map shard emitter: a canton
 * with no current openings must answer 200 + `[]` ("confirmed empty"), never
 * 404 — `fetchShardDirect` reads 404 as "shard not built" and the SPA then
 * falls back to the full locale index, which would silently undo the saving
 * for exactly the small cantons that need it most.
 *
 * Jobs whose `canton` is absent/null belong to no shard, exactly as
 * `scopeJobsToCanton` excludes them from every canton SERP today. They stay
 * reachable through the full locale index (the deferred unscoped pool).
 */
export function buildCantonShards<T extends { canton?: string | null }>(
  jobs: ReadonlyArray<T>,
): Record<string, T[]> {
  const shards: Record<string, T[]> = {};
  const keyByMember = new Map<string, string>();
  for (const key of CANTON_SHARD_KEYS) {
    shards[key] = [];
    for (const member of expandCantonGroup(key)) keyByMember.set(member, key);
  }
  for (const job of jobs) {
    // Matched CASE-SENSITIVELY, deliberately. `scopeJobsToCanton` — the filter
    // this replaces — compares `j.canton === member` against the uppercase BFS
    // code, so a record carrying `'ti'` is invisible on the Ticino SERP today.
    // Normalising the case here would quietly ADD such records to a canton
    // page, which is a data-quality fix wearing a performance PR's clothes: it
    // belongs in the assembler that writes `canton`, not in the projection that
    // is supposed to be behaviour-preserving. The equivalence test in
    // tests/job-canton-shards.test.ts pins the two together.
    const canton = typeof job.canton === 'string' ? job.canton : '';
    if (!canton) continue;
    const key = keyByMember.get(canton);
    if (key !== undefined) shards[key].push(job);
  }
  return shards;
}
