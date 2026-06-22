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

const cache = new Map<string, unknown>();

/**
 * Read and parse a repo-relative JSON data file. Cached per resolved absolute
 * path so repeated calls within a single build don't re-read/re-parse the file.
 *
 * @param relPath Repo-root-relative path, e.g. `data/jobs.json`.
 * @param rootDir Repo root to resolve `relPath` against. Defaults to
 *   `process.cwd()`, which is the project root during a Vite build. Plugins that
 *   already receive a `rootDir` should pass it for robustness.
 */
export function loadDataJson<T = unknown>(relPath: string, rootDir: string = process.cwd()): T {
  const abs = path.resolve(rootDir, relPath);
  const hit = cache.get(abs);
  if (hit !== undefined) return hit as T;
  const data = JSON.parse(fs.readFileSync(abs, 'utf-8')) as T;
  cache.set(abs, data);
  return data;
}
