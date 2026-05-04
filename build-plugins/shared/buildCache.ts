/**
 * Build-plugin cache — content-addressable, automatic invalidation.
 *
 * Lets expensive plugins (salary-hub, health-premiums) skip their heavy work
 * when none of their inputs have changed since the last run. Cache key is
 * derived 100 % automatically from file contents — there is **no manual
 * version constant** to bump.
 *
 * Invalidation triggers (all automatic):
 *   1. Any TS/JS file in the plugin's import graph changes.
 *      Detected by bundling the plugin entry with esbuild and hashing the
 *      bundle output. esbuild traces every transitive import, so adding a
 *      new helper, modifying a constant in a shared util, or even editing
 *      a deeply-nested type definition all ripple into the bundle hash.
 *
 *   2. A runtime data file changes.
 *      Plugins that load data via `fs.readFileSync` (rather than `import`)
 *      pass a `runtimeFiles` callback returning absolute paths. Each file's
 *      raw bytes are hashed and folded into the key.
 *
 *   3. An explicit `extraKey` changes.
 *      Used to invalidate on environmental factors that aren't files —
 *      e.g. `healthPremiumsLandingPlugin` keys on the current UTC year so
 *      the Dec-31 cache doesn't survive into Jan-1 with stale year refs.
 *
 * Drift safety: a CI workflow (`.github/workflows/verify-build-cache.yml`)
 * runs nightly, builds twice (fresh, then cached), and diffs `dist/`
 * byte-by-byte. If a transitive dep slips past the bundle hash for any
 * reason, the workflow fails loud. Drift detection is automatic — no
 * human gate.
 *
 * Storage layout:
 *
 *   .cache/build-plugins/<pluginName>/<key>/
 *     manifest.json                # { distDir, paths: [...] }
 *     files/<rel-path-from-dist>   # snapshot of each recorded file
 *
 * The manifest's `paths` list mirrors what the plugin wrote (relative to
 * `distDir`). On hit, every path is restored from `files/`. The `distDir`
 * field is informational only — restore uses the live `distDir` passed at
 * runtime, so cache directories are portable across machines/CI runners.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
// esbuild is a transitive dep of Vite (always present in node_modules).
// We import it dynamically inside `computeCacheKey` so this module loads
// cheaply when only `runCached`'s cache-restore path is exercised in tests.
type EsbuildModule = typeof import('esbuild');
let esbuildPromise: Promise<EsbuildModule> | null = null;
async function loadEsbuild(): Promise<EsbuildModule> {
  if (!esbuildPromise) {
    esbuildPromise = import('esbuild');
  }
  return esbuildPromise;
}

// ── Types ───────────────────────────────────────────────────────

export interface ComputeCacheKeyOptions {
  /** Project root, used to anchor relative paths in error messages. */
  rootDir: string;
  /**
   * Absolute path to a TS/JS file. esbuild bundles this entry (in-memory,
   * no write) and hashes the result so every transitive import contributes
   * to the key automatically.
   */
  bundleEntry: string;
  /**
   * Returns absolute paths of runtime-loaded files (e.g. data/*.json read
   * via `fs.readFileSync`). Each file's raw bytes are hashed. Order does
   * NOT matter — the helper sorts by absolute path before hashing for
   * determinism. Missing files are tolerated (treated as empty content
   * with a sentinel marker so going from "missing" → "present" still
   * invalidates).
   */
  runtimeFiles?: () => string[];
  /**
   * Optional environmental discriminator. Concatenated into the key.
   * Use for non-file factors like the current UTC year.
   */
  extraKey?: string;
}

export interface RunCachedOptions extends ComputeCacheKeyOptions {
  /** Plugin name — used for cache directory naming and log messages. */
  pluginName: string;
  /** Build output dir (where files are written and snapshotted from). */
  distDir: string;
  /**
   * Cache root. Defaults to `<rootDir>/.cache/build-plugins`. Tests pass
   * an explicit path to keep state per-tmp-dir.
   */
  cacheDir?: string;
  /**
   * The heavy work. Receives a `recordWrite` callback — every file the
   * plugin emits MUST be passed to it so the cache can snapshot the
   * exact set of outputs. Files the callback never sees are not cached
   * and not restored on hit.
   */
  work: (ctx: { recordWrite: (filePath: string) => void }) => Promise<void>;
}

export interface RunCachedResult {
  /** True iff the plugin's heavy work was skipped (cache hit). */
  hit: boolean;
  /** The 64-char hex SHA-256 cache key for this invocation. */
  key: string;
  /** Files actually restored on hit, or snapshotted on miss. */
  fileCount: number;
}

interface CacheManifest {
  /** Plugin's distDir at snapshot time — informational, restore uses live distDir. */
  distDir: string;
  /** Paths relative to distDir. */
  paths: string[];
  /** Plugin name (for sanity check on restore). */
  pluginName: string;
  /** Snapshot timestamp (ISO 8601). */
  snapshottedAt: string;
}

// ── Cache key derivation ────────────────────────────────────────

/**
 * Compute the SHA-256 cache key for a given plugin invocation.
 *
 * Three inputs are folded together:
 *   1. esbuild bundle hash (catches every TS/JS transitive import)
 *   2. Per-runtime-file content hash + length (catches data file edits)
 *   3. extraKey string (catches non-file factors)
 */
export async function computeCacheKey(opts: ComputeCacheKeyOptions): Promise<string> {
  const { bundleEntry, runtimeFiles, extraKey } = opts;

  if (!fs.existsSync(bundleEntry)) {
    throw new Error(`[buildCache] bundleEntry does not exist: ${bundleEntry}`);
  }

  const esbuild = await loadEsbuild();
  const bundleResult = await esbuild.build({
    entryPoints: [bundleEntry],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    target: 'es2022',
    sourcemap: false,
    minify: false,
    metafile: false,
    // Mark every node built-in + external bare module as external so we
    // don't try to bundle, e.g., `vite`, `firebase`, etc. The hash is
    // about OUR source code, not vendored code.
    packages: 'external',
    // Suppress warning logs — we only need the bundled bytes.
    logLevel: 'silent',
  });

  const hasher = crypto.createHash('sha256');

  // Hash each output chunk by name + bytes. esbuild typically emits one
  // entry per entryPoint; we tolerate multiple deterministically by
  // sorting on path.
  const outs = [...bundleResult.outputFiles].sort((a, b) => a.path.localeCompare(b.path));
  for (const out of outs) {
    hasher.update('out:');
    hasher.update(out.path);
    hasher.update('\n');
    hasher.update(out.contents);
  }

  // Hash runtime files in deterministic order.
  const runtime = runtimeFiles?.() ?? [];
  const sortedRuntime = [...runtime].sort();
  for (const filePath of sortedRuntime) {
    hasher.update('rt:');
    hasher.update(filePath);
    hasher.update('\n');
    if (fs.existsSync(filePath)) {
      hasher.update('present:');
      hasher.update(fs.readFileSync(filePath));
    } else {
      // Sentinel so going from missing → present (or vice versa) shifts
      // the key. Plugins should normally not list non-existent paths, but
      // we tolerate it for callers that probe optional files.
      hasher.update('absent\n');
    }
  }

  if (extraKey !== undefined) {
    hasher.update('extra:');
    hasher.update(extraKey);
    hasher.update('\n');
  }

  return hasher.digest('hex');
}

// ── Cache hit / miss orchestration ──────────────────────────────

export async function runCached(opts: RunCachedOptions): Promise<RunCachedResult> {
  const {
    pluginName,
    rootDir,
    distDir,
    bundleEntry,
    runtimeFiles,
    extraKey,
    work,
  } = opts;
  const cacheRoot = opts.cacheDir ?? path.resolve(rootDir, '.cache', 'build-plugins');

  const t0 = Date.now();
  const key = await computeCacheKey({ rootDir, bundleEntry, runtimeFiles, extraKey });
  const keyDir = path.join(cacheRoot, pluginName, key);
  const manifestPath = path.join(keyDir, 'manifest.json');

  // ── HIT path ────────────────────────────────────────────────
  if (fs.existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as CacheManifest;
      const restored = restoreFromCache(keyDir, distDir, manifest);
      const dt = ((Date.now() - t0) / 1000).toFixed(2);
      console.log(
        `[cache] ${pluginName}: HIT (key=${key.slice(0, 12)}..., ${restored} files restored in ${dt}s)`,
      );
      return { hit: true, key, fileCount: restored };
    } catch (err) {
      console.warn(
        `[cache] ${pluginName}: HIT path failed (${(err as Error).message}) — falling through to miss`,
      );
      // Fall through to miss path — clean partial keyDir to avoid loops.
      fs.rmSync(keyDir, { recursive: true, force: true });
    }
  }

  // ── MISS path ───────────────────────────────────────────────
  const missReason = describeMissReason(cacheRoot, pluginName, key);
  console.log(
    `[cache] ${pluginName}: MISS (key=${key.slice(0, 12)}..., reason=${missReason})`,
  );

  const recorded = new Set<string>();
  const recordWrite = (filePath: string) => {
    recorded.add(path.resolve(filePath));
  };

  await work({ recordWrite });

  // Snapshot recorded files into cache.
  const snapshotted = snapshotToCache(keyDir, distDir, pluginName, recorded);
  const dt = ((Date.now() - t0) / 1000).toFixed(2);
  console.log(
    `[cache] ${pluginName}: snapshot wrote ${snapshotted} files to cache in ${dt}s`,
  );

  return { hit: false, key, fileCount: snapshotted };
}

// ── HIT helpers ─────────────────────────────────────────────────

function restoreFromCache(keyDir: string, distDir: string, manifest: CacheManifest): number {
  const filesDir = path.join(keyDir, 'files');
  let restored = 0;
  for (const rel of manifest.paths) {
    const src = path.join(filesDir, rel);
    const dst = path.join(distDir, rel);
    if (!fs.existsSync(src)) {
      throw new Error(`[buildCache] cache file missing: ${src}`);
    }
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    restored++;
  }
  return restored;
}

// ── MISS helpers ────────────────────────────────────────────────

function snapshotToCache(
  keyDir: string,
  distDir: string,
  pluginName: string,
  recorded: Set<string>,
): number {
  // Reset the keyDir to ensure no stale state from a previous failed run
  // contaminates this snapshot.
  fs.rmSync(keyDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(keyDir, 'files'), { recursive: true });

  const distAbs = path.resolve(distDir);
  const paths: string[] = [];

  for (const abs of recorded) {
    if (!abs.startsWith(distAbs + path.sep) && abs !== distAbs) {
      // Recorded path lives outside distDir — refuse silently. Plugins
      // should never record outside their build output. Logging a warn
      // would noise the build; the drift workflow catches real misses.
      continue;
    }
    if (!fs.existsSync(abs)) {
      // Plugin recorded a path it didn't actually write. Skip — drift
      // workflow will catch real bugs.
      continue;
    }
    const rel = path.relative(distAbs, abs);
    const dst = path.join(keyDir, 'files', rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(abs, dst);
    paths.push(rel);
  }

  const manifest: CacheManifest = {
    distDir: distAbs,
    paths: paths.sort(),
    pluginName,
    snapshottedAt: new Date().toISOString(),
  };
  fs.writeFileSync(
    path.join(keyDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2),
    'utf-8',
  );

  return paths.length;
}

/**
 * Describe why the current key didn't match any cached entry. Best-effort:
 * if the plugin's cache dir has no entries at all, it's a cold start.
 * If there are entries but none match, list the most recent prior key so
 * humans can grep `git log` to see what changed.
 */
function describeMissReason(cacheRoot: string, pluginName: string, key: string): string {
  const pluginCacheDir = path.join(cacheRoot, pluginName);
  if (!fs.existsSync(pluginCacheDir)) return 'cold start (no prior cache for this plugin)';
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(pluginCacheDir).filter((d) => d !== key);
  } catch {
    return 'cold start';
  }
  if (entries.length === 0) return 'cold start';
  // Pick the most recently modified prior entry as the "what changed" hint.
  let mostRecent = entries[0];
  let mostRecentMs = 0;
  for (const e of entries) {
    try {
      const stat = fs.statSync(path.join(pluginCacheDir, e));
      if (stat.mtimeMs > mostRecentMs) {
        mostRecentMs = stat.mtimeMs;
        mostRecent = e;
      }
    } catch {
      // ignore
    }
  }
  return `inputs changed since prior key ${mostRecent.slice(0, 12)}...`;
}
