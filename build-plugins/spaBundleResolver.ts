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
 * same value. The poll is bounded at 3 s (60 attempts × 50 ms): plenty of
 * head room for the rare case where closeBundle wins the race against
 * writeBundle, but tight enough to fail loudly when the file is genuinely
 * absent (e.g. someone calls the resolver from a hook earlier than
 * writeBundle).
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

const ENTRY_JS_RX = /src="\/assets\/(index-[A-Za-z0-9_-]+\.js)"/;
const ENTRY_CSS_RX = /href="\/assets\/(index-[A-Za-z0-9_-]+\.css)"/;

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
function pollDistIndexHtml(distDir: string, timeoutMs = 3000, intervalMs = 50): SpaBundleInfo {
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
