/**
 * Deterministic SPA bundle resolver shared by every SEO plugin that emits
 * static HTML which must hydrate into the React SPA.
 *
 * The race we close
 * -----------------
 * Five plugins (jobsSeoPagesPlugin, ogPagesPlugin, staticPagesPlugin,
 * jobSectorPagesPlugin, jobRecencyPagesPlugin) each read `dist/index.html`
 * in `closeBundle` to extract the hashed entry filenames
 * (`index-<hash>.js` / `index-<hash>.css`). When the read happens before
 * Vite's writeBundle has flushed `index.html` to disk, the regex returns
 * empty strings, `hasSpaBundle` becomes false, and the plugin silently
 * emits ~30k pages WITHOUT the `<script type="module">` hydration tag.
 *
 * Audit run 25151657070 caught 123,184 such pages; the next run on the
 * SAME codebase produced only 6,850 (run 25152767223). The fluctuation is
 * the smoking gun — see `data/spa-bundle-injection-baseline.json`.
 *
 * The fix
 * -------
 * One module-level cache, populated on first call by polling the on-disk
 * `dist/index.html` until both regexes match (bounded retry). Once the
 * cache is populated, all subsequent callers — across plugins — read the
 * same value. The poll defaults to 3 s (60 attempts × 50 ms), overridable
 * via `SPA_BUNDLE_POLL_TIMEOUT_MS` — the CI deploy workflow sets it to 30 s
 * because the corpus `og-pages`/`jobs-seo-pages`/etc. parse before calling
 * this (e.g. `services/locales/blog-body/*` alone) keeps growing with every
 * auto-generated article, so the original fixed 3 s budget (introduced when
 * the corpus was much smaller) eroded from "rare race, huge head room" to
 * "consistent CI failure" without any plugin-order or timeout code change
 * — see the 2026-07-21 deploy incident. The 3 s default is kept for local
 * dev/tests, where dist/index.html is either already there or genuinely
 * never coming (tests/spa-bundle-resolver.test.ts asserts a fast throw on
 * missing/empty/malformed index.html — a 30 s default would make every one
 * of those a 30 s timeout instead of an assertion).
 *
 * Erosion, again
 * ---------------
 * The 2026-07-21 bump to 30 s (via `SPA_BUNDLE_POLL_TIMEOUT_MS`, set in
 * every full-build CI workflow) re-failed the same way just 3 days later
 * (#4738: "poll exhausted after 598 attempts (30000 ms)" on every locale) —
 * the corpus that eats pre-poll parse time keeps growing daily, so any
 * fixed number erodes eventually. Bumping the 6 workflow-level env vars
 * again only buys a few more days. `CI_POLL_TIMEOUT_FLOOR_MS` below is a
 * floor UNDER whatever `SPA_BUNDLE_POLL_TIMEOUT_MS` is configured to —
 * headroom lives in one place in code instead of N YAML files kept in
 * sync. It only engages when that env var is set at all (tests/local dev
 * never set it, so they keep the fast 3 s default / instant throw).
 *
 * Hard-fail vs silent fallback
 * ----------------------------
 * The previous inline reads failed silently — empty `entryJs` →
 * `hasSpaBundle = false` → ~30k bundle-less pages with only a `console.warn`
 * to flag it. The audit in deploy.yml caught the regression but we only
 * see it after a 15-minute build. The resolver throws on poll exhaustion
 * so the build fails immediately with a clear error message instead.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';
import { SPA_ENTRY_JS_RX, SPA_ENTRY_CSS_RX } from './shared/spaBundleRx';

export interface SpaBundleInfo {
  /** Bare filename, no `/assets/` prefix. e.g. `index-B0v4sJnp.js`. */
  readonly entryJs: string;
  /** Bare filename, no `/assets/` prefix. e.g. `index-BHVvZKod.css`. */
  readonly entryCss: string;
  /** True iff both entryJs and entryCss are non-empty. Always true when this
   *  function returns (we throw otherwise) — kept on the type for callers
   *  that want to defensively gate template fragments on it. */
  readonly hasSpaBundle: true;
}

// Entry-bundle extract regexes live in ./shared/spaBundleRx so this resolver and
// seoPageShell.ts share ONE definition (they used to copy-paste it — drift between
// the copies is the "stesso anti-pattern nel file gemello" class, e.g. PR #1297).
// The `[^"]*` origin tolerance + bare-filename capture are documented there.
const ENTRY_JS_RX = SPA_ENTRY_JS_RX;
const ENTRY_CSS_RX = SPA_ENTRY_CSS_RX;

/**
 * Module-level cache. Keyed by `distDir` so a build that targets multiple
 * outputs (rare; we have one) doesn't conflate hashes. The Map is reset
 * implicitly per Vite invocation because the module is re-imported.
 */
const cache = new Map<string, SpaBundleInfo>();

/**
 * Synchronous poll. Returns immediately when `dist/index.html` exists and
 * matches both regexes; otherwise retries with `intervalMs` sleep up to
 * `timeoutMs`. Sync because every caller is already inside a synchronous
 * template-build path — making it async would propagate `await` through
 * 50+ template helpers in jobsSeoPagesPlugin alone.
 */
// Floor applied on top of `SPA_BUNDLE_POLL_TIMEOUT_MS` when that env var is
// set at all (i.e. only in CI full-build workflows — see "Erosion, again"
// above). Local dev/tests never set the env var, so this never touches them.
const CI_POLL_TIMEOUT_FLOOR_MS = 120_000;

const envPollTimeoutMs = Number(process.env.SPA_BUNDLE_POLL_TIMEOUT_MS);
const DEFAULT_POLL_TIMEOUT_MS = envPollTimeoutMs > 0
  ? Math.max(envPollTimeoutMs, CI_POLL_TIMEOUT_FLOOR_MS)
  : 3000;

function pollDistIndexHtml(distDir: string, timeoutMs = DEFAULT_POLL_TIMEOUT_MS, intervalMs = 50): SpaBundleInfo {
  const indexPath = path.join(distDir, 'index.html');
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  let lastSize = -1;
  let lastError: string = '';

  while (Date.now() < deadline) {
    attempts += 1;
    try {
      const stat = fs.statSync(indexPath);
      lastSize = stat.size;
      if (stat.size === 0) {
        lastError = 'index.html exists but is empty';
      } else {
        const html = fs.readFileSync(indexPath, 'utf-8');
        const jsMatch = html.match(ENTRY_JS_RX);
        const cssMatch = html.match(ENTRY_CSS_RX);
        if (jsMatch && cssMatch) {
          return {
            entryJs: jsMatch[1],
            entryCss: cssMatch[1],
            hasSpaBundle: true,
          };
        }
        lastError = `regex miss (js=${!!jsMatch} css=${!!cssMatch}, html size=${stat.size})`;
      }
    } catch (err) {
      lastError = (err as NodeJS.ErrnoException).code === 'ENOENT'
        ? 'index.html does not exist yet'
        : `stat/read failed: ${(err as Error).message}`;
    }
    // Synchronous sleep via Atomics.wait on a SharedArrayBuffer view —
    // available in Node ≥16 in worker_threads, and on the main thread via
    // the same primitive. Fallback: busy-wait with setTimeout-equivalent.
    const sab = new SharedArrayBuffer(4);
    const view = new Int32Array(sab);
    Atomics.wait(view, 0, 0, intervalMs);
  }

  throw new Error(
    `[spa-bundle-resolver] poll exhausted after ${attempts} attempts (${timeoutMs} ms). ` +
    `Last state: ${lastError}. ` +
    `Path: ${indexPath} (size=${lastSize}). ` +
    `This usually means a closeBundle plugin ran before Vite's writeBundle ` +
    `finished — verify the plugin doesn't escape closeBundle ordering.`,
  );
}

/**
 * Returns the SPA entry-bundle filenames. First call per `distDir` polls
 * `dist/index.html`; subsequent calls return the cached value instantly.
 *
 * Throws on poll exhaustion (see {@link pollDistIndexHtml}). Callers should
 * NOT catch the throw — failing fast is the point of this refactor.
 */
export function resolveSpaBundle(distDir: string): SpaBundleInfo {
  const cached = cache.get(distDir);
  if (cached) return cached;
  const info = pollDistIndexHtml(distDir);
  cache.set(distDir, info);
  return info;
}

/** Test/diagnostic helper. Clears the cache so the next call repolls. */
export function _resetSpaBundleResolverCacheForTests(): void {
  cache.clear();
}

/**
 * Prewarms the module-level cache by resolving the SPA bundle as the very
 * FIRST `closeBundle` handler to run (`order: 'pre'`, `sequential: true`),
 * before any of the ~30 heavy content-generation plugins get a chance to run
 * their own (synchronous, CPU-bound) work.
 *
 * Why this matters: the five consumer plugins (jobsSeoPagesPlugin,
 * ogPagesPlugin, staticPagesPlugin, jobSectorPagesPlugin,
 * jobRecencyPagesPlugin) each parse a growing corpus (blog articles, job
 * data, ...) BEFORE reaching their own `resolveSpaBundle()` call. As that
 * corpus grows daily, the wall-clock gap between "Vite finished writing
 * dist/index.html" and "some consumer plugin actually polls for it" grows
 * too — eroding any fixed poll timeout (see the module doc above,
 * "Erosion, again": 3s → 30s → 120s, each ceiling re-hit within days, then
 * hours). Registering a near-zero-cost plugin ahead of every content
 * plugin, ordered to run first among `closeBundle` handlers, means the
 * FIRST poll happens immediately after Vite's write phase — when
 * dist/index.html is virtually guaranteed to already be on disk — instead
 * of after however long the growing corpus takes to parse. Once cached,
 * every consumer's own `resolveSpaBundle()` call returns instantly.
 */
export function spaBundleResolverPrewarmPlugin(rootDir: string): Plugin {
  return {
    name: 'spa-bundle-resolver-prewarm',
    apply: 'build',
    enforce: 'post',
    closeBundle: {
      order: 'pre',
      sequential: true,
      handler() {
        resolveSpaBundle(path.resolve(rootDir, 'dist'));
      },
    },
  };
}
