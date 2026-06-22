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
import { loadDataJson } from './loadDataJson';

/**
 * Read `data/jobs.json` from disk and parse it. Cached per resolved path so
 * repeated calls within a single build don't re-read/re-parse ~150 MB.
 *
 * Thin wrapper over the shared {@link loadDataJson} read-path so the lazy-load
 * anti-pattern guard (see that module's header) lives in exactly one place.
 *
 * @param rootDir Repo root to resolve `data/jobs.json` against. Defaults to
 *   `process.cwd()`, which is the project root during a Vite build. Plugins
 *   that already receive a `rootDir` should pass it for robustness.
 */
export function loadJobsJson<T = unknown>(rootDir: string = process.cwd()): T[] {
  return loadDataJson<T[]>('data/jobs.json', rootDir);
}
