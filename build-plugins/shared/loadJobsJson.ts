/**
 * Lazy runtime loader for `data/jobs.json`.
 *
 * WHY THIS EXISTS — never `import jobsFile from '.../data/jobs.json'` from any
 * module reachable by `vite.config.ts`. When Vite loads the config, esbuild
 * bundles the config file *plus its entire static-import graph* into a single
 * in-memory string. A static JSON import inlines `data/jobs.json` (now ~150 MB,
 * 12.6k+ jobs) as an escaped string literal inside that bundle; once it crosses
 * V8's hard 512 MB max-string-length the config can no longer be loaded:
 *
 *   Error: Cannot create a string longer than 0x1fffffe8 characters
 *     at TextDecoder.decode (node:internal/encoding)
 *     at bundleConfigFile (vite/dist/node/chunks/...)
 *
 * That broke the monolith `build` job and the "AdSense Pre-Review Checklist"
 * workflow (issue #2532) before the build could even start.
 *
 * Reading the file lazily at plugin-runtime (inside `closeBundle`/`build`)
 * keeps `data/jobs.json` OUT of esbuild's config bundle entirely, so the config
 * stays small and bounded as the dataset keeps growing. The single ~150 MB
 * string returned here is well under the 512 MB limit (no bundle-escaping
 * overhead). Defining the read path ONCE here makes the static-import
 * anti-pattern impossible to reintroduce by copy-paste.
 */
import { loadDataJson, releaseDataJson } from './loadDataJson';

/** Single definition of the corpus path — used by both accessors below so the
 * load key and the release key can never drift apart. */
const JOBS_JSON = 'data/jobs.json';

/**
 * Read `data/jobs.json` from disk and parse it. Cached per resolved path so
 * repeated calls within a single build don't re-read/re-parse ~150 MB.
 *
 * Thin wrapper over the shared {@link loadDataJson} read-path so the lazy-load
 * anti-pattern guard (see that module's header) lives in exactly one place.
 *
 * @param rootDir Optional repo root to resolve `data/jobs.json` against; see
 *   {@link loadDataJson}'s resolution order (#2594). Plugins that already
 *   receive a `rootDir` should pass it.
 */
export function loadJobsJson<T = unknown>(rootDir?: string): T[] {
  return loadDataJson<T[]>(JOBS_JSON, rootDir);
}

/**
 * Drop the cached `data/jobs.json` parse so its ~545 MB object graph can be
 * collected. Thin wrapper over {@link releaseDataJson} for the same reason
 * {@link loadJobsJson} wraps `loadDataJson`: the corpus path is spelled once.
 *
 * CALL THIS only from a plugin that (a) is done with the corpus and (b) is
 * followed by heavy work that does not read it — see the block comment on
 * {@link releaseDataJson} for why `employerProfilePagesPlugin` is that case and
 * why the plugins further down the array re-reading the file is the cheap side
 * of the trade. Calling it from a plugin that merely *finished* iterating is a
 * pessimization: the next reader pays a 329 MB read + parse for nothing.
 *
 * @returns `true` when the corpus was cached and is now released.
 */
export function releaseJobsJson(rootDir?: string): boolean {
  return releaseDataJson(JOBS_JSON, rootDir);
}
