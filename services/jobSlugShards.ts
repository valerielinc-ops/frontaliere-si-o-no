// jobSlugShards.ts
//
// Single source of truth for the SHARDED job slug map — the per-lookup-key
// projection of `data/jobs.json` that lets the SPA resolve one job slug
// (canton + id + per-locale slugs, including legacy `previousSlugs*` aliases)
// without downloading the full `/data/jobs-slug-map.json` monolith (~12–14 MB
// raw / ~1.5 MB br, issue #3526: it was fetched on effectively every page
// view). Used by BOTH:
//   1. build-plugins/localeJobsSplitPlugin — emits dist/data/jobs-slug-map/
//      {00..ff}.json alongside the legacy monolith (kept for old cached SPA
//      chunks and for corpus-wide consumers like UserProfile / stats pages);
//   2. services/router.ts — hashes a slug to its shard file and merges the
//      shard's prebuilt records into the in-memory slug map on demand.
//
// Keeping the hash + record builder here means the emitter and the runtime
// lookup derive the same shard file and the same record shape BY CONSTRUCTION
// (AGENTS.md §6: a literal-duplicated construct across ≥2 files → one module).
// This module must stay dependency-free: it is imported (relative, no `@/`
// alias) from the vite.config plugin graph.

/** Number of shard files. 256 keeps the median shard ~125 KB raw / ~16 KB br
 * at the current ~83k lookup keys — small enough to be a negligible fetch on
 * job-detail landings, large enough to keep the file count trivial next to
 * the ~16k dist/data/job-detail/*.json files. */
export const JOB_SLUG_SHARD_COUNT = 256;

/** Directory (under dist/) holding the shard files. The legacy monolith stays
 * at /data/jobs-slug-map.json — the directory name intentionally shares the
 * prefix so the two travel together through the CDN offload. */
export const JOB_SLUG_SHARD_DIR = '/data/jobs-slug-map';

/**
 * Per-lookup-key record, shape-identical to the router's in-memory
 * JobSlugMapRecord: locale keys (`it`/`en`/`de`/`fr`) map to that locale's
 * slug, `_default` is the canonical slug, `_id`/`_canton` are bridge metadata.
 * Locale entries equal to `_default` are omitted — translateJobSlug falls back
 * to `_default`, so the returned value is identical while the payload shrinks.
 */
export type JobSlugShardRecord = Record<string, string> & {
  _id?: string;
  _canton?: string;
};

/** The slug-map projection of a job record (subset of data/jobs.json entry). */
export interface SlugMapJobEntry {
  id?: string;
  canton?: string;
  slug?: string;
  slugByLocale?: Partial<Record<string, string>>;
  previousSlugs?: string[];
  previousSlugsByLocale?: Partial<Record<string, string[]>>;
}

/** djb2-xor hash → shard key as two lowercase hex chars ("00".."ff").
 * Deterministic and dependency-free; MUST NOT change without re-emitting all
 * shards (build emit + runtime lookup share it by construction). */
export function jobSlugShardKey(slug: string): string {
  let h = 5381;
  for (let i = 0; i < slug.length; i++) {
    h = ((h * 33) ^ slug.charCodeAt(i)) >>> 0;
  }
  return (h % JOB_SLUG_SHARD_COUNT).toString(16).padStart(2, '0');
}

/** Path (same-origin, pre-cdnDataUrl) of the shard file for a shard key. */
export function jobSlugShardPath(shardKey: string): string {
  return `${JOB_SLUG_SHARD_DIR}/${shardKey}.json`;
}

/**
 * Build the lookup record + key sets for one job.
 * - `primaryKeys`: current slugs (every locale slug + the default slug) —
 *   these always (over)write the map entry, mirroring registerJobSlugMap.
 * - `aliasKeys`: previousSlugs / previousSlugsByLocale values — these only
 *   fill gaps (never overwrite an existing entry), so a legacy alias of one
 *   job can never shadow the live slug of another.
 * Returns null when the job yields no usable record (no slugs at all).
 */
export function buildJobSlugRecord(job: SlugMapJobEntry): {
  record: JobSlugShardRecord;
  primaryKeys: string[];
  aliasKeys: string[];
} | null {
  const record: JobSlugShardRecord = {};
  const defaultSlug = typeof job.slug === 'string' && job.slug ? job.slug : undefined;
  if (job.slugByLocale) {
    for (const [loc, s] of Object.entries(job.slugByLocale)) {
      // Omit locale slugs equal to the default: translateJobSlug falls back to
      // `_default`, so lookups return the same value with a smaller record.
      if (s && s !== defaultSlug) record[loc] = s;
    }
  }
  if (defaultSlug) record['_default'] = defaultSlug;
  if (job.id) record._id = job.id;
  if (job.canton) record._canton = String(job.canton).toUpperCase();

  const primary = new Set<string>();
  if (defaultSlug) primary.add(defaultSlug);
  if (job.slugByLocale) {
    for (const s of Object.values(job.slugByLocale)) {
      if (s) primary.add(s);
    }
  }
  if (primary.size === 0) return null;

  const aliases = new Set<string>();
  if (Array.isArray(job.previousSlugs)) {
    for (const alias of job.previousSlugs) {
      if (alias && !primary.has(alias)) aliases.add(alias);
    }
  }
  if (job.previousSlugsByLocale && typeof job.previousSlugsByLocale === 'object') {
    for (const arr of Object.values(job.previousSlugsByLocale)) {
      if (Array.isArray(arr)) {
        for (const alias of arr) {
          if (alias && !primary.has(alias)) aliases.add(alias);
        }
      }
    }
  }
  return { record, primaryKeys: [...primary], aliasKeys: [...aliases] };
}

/**
 * Build all shard objects for a jobs array. Every shard key in
 * [0, JOB_SLUG_SHARD_COUNT) is present in the result (possibly `{}`), so the
 * emitter writes the full stable file set and an on-demand lookup of an
 * unknown slug gets a 200 + miss (confirmed absent) instead of a 404 (which
 * the runtime treats as "shard unavailable" and falls back to the monolith).
 *
 * Key precedence mirrors registerJobSlugMap exactly: jobs are processed in
 * array order; primary keys overwrite, alias keys only fill gaps. Since a key
 * hashes to exactly one shard, the per-shard `in` check is equivalent to the
 * router's global `map.has(alias)` check.
 */
export function buildJobSlugShards(
  jobs: SlugMapJobEntry[],
): Record<string, Record<string, JobSlugShardRecord>> {
  const shards: Record<string, Record<string, JobSlugShardRecord>> = {};
  for (let i = 0; i < JOB_SLUG_SHARD_COUNT; i++) {
    shards[i.toString(16).padStart(2, '0')] = {};
  }
  for (const job of jobs) {
    const built = buildJobSlugRecord(job);
    if (!built) continue;
    for (const key of built.primaryKeys) {
      shards[jobSlugShardKey(key)][key] = built.record;
    }
    for (const key of built.aliasKeys) {
      const shard = shards[jobSlugShardKey(key)];
      if (!(key in shard)) shard[key] = built.record;
    }
  }
  return shards;
}
