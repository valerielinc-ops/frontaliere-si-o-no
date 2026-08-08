/**
 * Lazy runtime loader for a repo-relative `data/*.json` file.
 *
 * WHY THIS EXISTS — never `import data from '.../data/<file>.json'` from any
 * module reachable by `vite.config.ts`. When Vite loads the config, esbuild
 * bundles the config file *plus its entire static-import graph* into a single
 * in-memory string. A static JSON import inlines the whole file as an escaped
 * string literal inside that bundle; once the combined bundle crosses V8's hard
 * 512 MB max-string-length the config can no longer be loaded:
 *
 *   Error: Cannot create a string longer than 0x1fffffe8 characters
 *     at TextDecoder.decode (node:internal/encoding)
 *     at bundleConfigFile (vite/dist/node/chunks/...)
 *
 * `data/jobs.json` (~150 MB) crossed that limit first and broke the monolith
 * `build` job + the "AdSense Pre-Review Checklist" workflow (issue #2532).
 * `data/slug-registry.json` (~12 MB and growing with every slug ever minted) is
 * the same anti-pattern at smaller scale — a future time-bomb on the same line.
 *
 * Reading a data file lazily at plugin-runtime (inside `closeBundle`/`build`)
 * keeps it OUT of esbuild's config bundle entirely, so the config stays small
 * and bounded as the datasets keep growing. Defining the read path ONCE here
 * makes the static-import anti-pattern impossible to reintroduce by copy-paste.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cache = new Map<string, unknown>();

/**
 * Resolve a repo-root-relative data path to an absolute path, robustly (#2594).
 *
 * Tries, in order, and returns the FIRST candidate where the file exists:
 *   1. an explicit `rootDir` (passed by plugins that already have one, e.g.
 *      `legacyRedirectsPlugin`);
 *   2. `process.cwd()` — the project root for every real Vite build;
 *   3. a module-relative anchor (`../..` from this file).
 *
 * Trying multiple anchors hardens two failure modes a single default can't
 * cover at once:
 *   - a non-repo-root `cwd` would ENOENT a bare `process.cwd()` default
 *     (callers like `slugCantonIndex` pass no `rootDir`);
 *   - a module-relative-ONLY default would mis-resolve when Vite bundles
 *     `vite.config.ts`'s import graph (this file included) into a temp location
 *     via esbuild, where `import.meta.url` points at the temp bundle, not here.
 *
 * If none exist, returns the rootDir/cwd candidate so `readFileSync` throws a
 * clear ENOENT at the expected path rather than a confusing module-relative one.
 */
function resolveDataPath(relPath: string, rootDir?: string): string {
  const roots: string[] = [];
  if (rootDir) roots.push(rootDir);
  roots.push(process.cwd());
  try {
    roots.push(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'));
  } catch {
    // import.meta.url not a file URL (bundled/browser context) — skip anchor 3.
  }
  for (const root of roots) {
    const abs = path.resolve(root, relPath);
    if (fs.existsSync(abs)) return abs;
  }
  return path.resolve(rootDir ?? process.cwd(), relPath);
}

/**
 * Read and parse a repo-relative JSON data file. Cached per resolved absolute
 * path so repeated calls within a single build don't re-read/re-parse the file.
 *
 * @param relPath Repo-root-relative path, e.g. `data/jobs.json`.
 * @param rootDir Optional repo root to resolve `relPath` against; see
 *   {@link resolveDataPath} for the full resolution order. Plugins that already
 *   receive a `rootDir` should pass it.
 */
export function loadDataJson<T = unknown>(relPath: string, rootDir?: string): T {
  const abs = resolveDataPath(relPath, rootDir);
  const hit = cache.get(abs);
  if (hit !== undefined) return hit as T;
  const data = JSON.parse(fs.readFileSync(abs, 'utf-8')) as T;
  cache.set(abs, data);
  return data;
}

/**
 * Drop one cached file so its parsed object graph becomes collectable (#5330
 * follow-up).
 *
 * WHY A CACHE NEEDS AN EVICTION DOOR. The cache above is module-level and has
 * no upper bound: whatever a plugin loads stays live for the REST of the build,
 * long after that plugin's `closeBundle` returned and every local reference to
 * it went out of scope. That is the right default — the point of the cache is
 * that ~6 plugins share one parse of `data/jobs.json` (329 MB on disk, ~545 MB
 * as a V8 object graph) instead of paying for six.
 *
 * It stops being the right default when the next plugin to run is the build's
 * memory peak and does NOT read the cached file. That is exactly the shape
 * `employerProfilePagesPlugin` acquired when it moved ahead of
 * `jobsSeoPagesPlugin` in vite.config.ts (it had to: under SEQUENTIAL_PROFILE=1
 * a signal only travels forward through the plugin array, and registered after
 * its consumer it deadlocked the build — #5330). `jobsSeoPagesPlugin` parses
 * `data/jobs.json` with its OWN `readFileSync` and never consults this cache,
 * so the two copies are now simultaneously live: measured as a flat +545 MB on
 * every `[mem]` line of the peak plugin (`[profile-mem]` heapUsed went
 * 3822 MB after og-pages → 4367 MB after employer-profile-pages, post-forced-GC,
 * run 31219771845), on a build whose RSS was already 11.6 GB of the runner's 16.
 *
 * Evicting here does NOT lose the parse for the plugins that run later
 * (`healthFacilitiesPlugin`, `legacyRedirectsPlugin`, `jobOrphanBridgePlugin`):
 * the first of them re-reads the file once and repopulates the cache for the
 * rest, ~5 s, at a point in the build where the peak is already behind us.
 *
 * @returns `true` when an entry was actually evicted, `false` when the path was
 *   not cached (never loaded, or already released) — so a caller or a test can
 *   tell a real release from a silent no-op.
 */
export function releaseDataJson(relPath: string, rootDir?: string): boolean {
  return cache.delete(resolveDataPath(relPath, rootDir));
}
