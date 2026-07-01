/**
 * Resilient dynamic import for lazily-loaded service chunks.
 *
 * Chunk filenames are STABLE (non-hashed) on this site (see vite.config rollup
 * output). After a deploy, two distinct stale-deploy failure modes can hit a
 * client still running the previous build:
 *
 *  1. import() REJECTS with "Failed to fetch dynamically imported module" —
 *     the chunk URL 404s because the CDN replaced/purged the old file.
 *
 *  2. import() RESOLVES but the returned module's named exports are undefined —
 *     the CDN/Cloudflare SPA fallback served index.html (HTTP 200) for the
 *     missing .js, so import() parses an HTML document as an (empty) module.
 *     Downstream code then throws on a MINIFIED name, e.g.
 *     "n.getApp is not a function", "n is not a function",
 *     "Ze is not a constructor", "[clarity.init] e is not a function".
 *
 * Both are the same root cause (stale build vs. current CDN assets). This helper
 * clears caches, retries once, and finally reloads the page to fetch fresh HTML
 * that references the current chunk URLs. A single sessionStorage key guards
 * against reload loops across every caller.
 */

export function isChunkLoadError(err: unknown): boolean {
  const msg = (err as Error)?.message || '';
  return (
    msg.includes('Importing a module script failed') ||
    msg.includes('Failed to fetch dynamically imported module') ||
    msg.includes('error loading dynamically imported module') ||
    (err as Error)?.name === 'ChunkLoadError'
  );
}

/**
 * A LINK-TIME ES-module mismatch SyntaxError — the cross-browser wordings the
 * browser throws when an importer chunk requests an export the (already loaded,
 * HTTP 200) dependency chunk does not provide. Used by isVersionSkewError below
 * and mirrored as an inline regex in index.html's runtime-error / rejection
 * handlers (which cannot import this module — keep the two in sync).
 *
 * Wordings observed across engines (the binding name in quotes is app-specific):
 *   - V8 / Chrome / Edge: "...does not provide an export named 'House'"
 *   - Firefox:            "import not found: House" / "ambiguous indirect export: House"
 *   - WebKit / Safari:    "Importing binding name 'House' is not found."
 */
export function isModuleLinkSkewMessage(msg: string): boolean {
  return (
    /does not provide an export named/.test(msg) ||
    /import not found/.test(msg) ||
    /indirect export/.test(msg) ||
    /Importing binding name/.test(msg)
  );
}

/**
 * Detect a CROSS-CHUNK VERSION-SKEW error — a stale-deploy failure mode the
 * fetch-based detectors above do not cover. Two distinct shapes, ONE root cause
 * (stable filenames + per-asset cache lifetimes → a client ends up with a
 * MISMATCHED set of stable-named chunks), ONE recovery (clear caches + reload).
 *
 * (a) CALL-TIME (TypeError): Rollup minifies internal cross-chunk export names
 *     to single letters (`export { lt as m }`) that are REASSIGNED every build
 *     from pure minifier ordering. A client holding a previously-cached importer
 *     chunk binds the OLD letter (`import { m as ls }`) to whatever the FRESH
 *     dependency chunk now exports under `m`. Both chunks load fine (HTTP 200) —
 *     the mismatch only surfaces at CALL time as a TypeError: the bound symbol
 *     is the wrong kind of value. (`minifyInternalExports:false` in vite.config
 *     attacks the cause; this is the runtime safety net.)
 *       - "ls(...).then is not a function" / "n is not a function"
 *       - "Ze is not a constructor" / "e is not iterable"
 *
 * (b) LINK-TIME (SyntaxError, issue #3097): the dependency chunk's EXPORT SET
 *     changes between deploys (e.g. lucide-react tree-shaking adds/removes icons
 *     in `vendor-icons.js`), so a cached importer (`BlogArticles.js` importing
 *     `House`) links against a stale/old `vendor-icons.js` that does not export
 *     that name. The ES module linker throws a SyntaxError at instantiation
 *     ("...does not provide an export named 'House'"), surfaced through
 *     React.lazy → ErrorBoundary. Same skew, same clear-caches + one-reload fix.
 *
 * Neither is throwable at import() time as a chunk-load error: (a) fires deep in
 * render/effects, (b) rejects the lazy import() with a SyntaxError that the
 * fetch-failure predicates (isChunkLoadError) do not match. Both reach the React
 * ErrorBoundary (in-render) or the global window handlers (outside React), which
 * route here → recoverFromStaleChunk().
 *
 * The predicate is signature-based. A genuine app bug producing the same message
 * costs at most MAX_RELOADS extra reloads before the per-session guard blocks
 * further reloads and the error UI is shown — identical to the existing
 * chunk-recovery tradeoff, and far better than a permanent white screen on a
 * real skew.
 */
export function isVersionSkewError(err: unknown): boolean {
  const e = err as { name?: string; message?: string } | null | undefined;
  if (!e) return false;
  const msg = e.message || '';
  if (e.name === 'TypeError') {
    return (
      /\bis not a function\b/.test(msg) ||
      /\bis not a constructor\b/.test(msg) ||
      /\bis not iterable\b/.test(msg)
    );
  }
  if (e.name === 'SyntaxError') {
    return isModuleLinkSkewMessage(msg);
  }
  return false;
}

// Session-wide reload ceiling shared across ALL three recovery surfaces:
// resilientImport's chunk-load path (below), recoverFromStaleChunk (called by
// ErrorBoundary + global window-error handler), and index.html bootstrap handlers.
// Raised from 1 to 2 (issue: single sessions observed hitting TWO independently
// stale chunks, e.g. vendor-icons.js then i18n.js — bustAssetHttpCache() only
// refetches chunks already loaded on the current page, so a second, not-yet-loaded
// stale chunk can still surface after the first reload and needs its own retry).
const BOOTSTRAP_RELOAD_KEY = '_swReloadCount';
export const MAX_RELOADS = 2;

// Upper bound on how long the HTTP-cache bust may run before we reload anyway.
// Asset chunks are small and refetched in parallel; this is only a backstop so a
// hung/blocked refetch can never strand the user on the error page.
const BUST_TIMEOUT_MS = 4000;

/**
 * Overwrite the STALE entries the skewed chunks occupy in the browser's HTTP
 * disk cache, so the subsequent reload loads a consistent, current chunk set.
 *
 * Why this is necessary on top of `caches.delete()` (issue #3097, recurrence of
 * the #3071/#3131 self-heal): the version-skewed chunks are cross-origin module
 * scripts served from `cdn.frontaliereticino.ch/assets/*` with
 * `Cache-Control: max-age=600, must-revalidate`. CacheStorage (`caches.*`) is
 * EMPTY on this site — no service worker caches `/assets` — so `caches.delete()`
 * is a no-op, and a plain `location.reload()` re-serves the SAME stale bytes from
 * the HTTP cache within the 600 s window. The one allowed reload is then wasted
 * and the error page persists (works in incognito only because there is no
 * persistent HTTP cache). `fetch(url, { cache: 'reload' })` bypasses the HTTP
 * cache AND replaces the stored entry with current bytes, breaking the skew.
 *
 * Best-effort and time-boxed: every refetch swallows its own error and the whole
 * batch races a {@link BUST_TIMEOUT_MS} timer, so recovery never hangs. Resolves
 * once the cache has been refreshed (or the timer fires); the caller then reloads.
 */
export async function bustAssetHttpCache(): Promise<void> {
  if (typeof window === 'undefined' || typeof fetch !== 'function') return;

  let urls: string[] = [];
  try {
    const entries =
      typeof performance !== 'undefined' && typeof performance.getEntriesByType === 'function'
        ? performance.getEntriesByType('resource')
        : [];
    urls = entries
      .map((e) => (e as PerformanceResourceTiming).name)
      .filter((u) => /\/assets\/.+\.(?:js|css)(?:\?|$)/.test(u));
  } catch {
    /* Resource Timing unavailable — fall back to a DOM scan below. */
  }
  if (urls.length === 0 && typeof document !== 'undefined') {
    try {
      document
        .querySelectorAll<HTMLScriptElement | HTMLLinkElement>(
          'script[src*="/assets/"], link[href*="/assets/"]',
        )
        .forEach((el) => {
          const u = (el as HTMLScriptElement).src || (el as HTMLLinkElement).href;
          if (u) urls.push(u);
        });
    } catch {
      /* DOM unavailable */
    }
  }

  const unique = Array.from(new Set(urls));
  if (unique.length === 0) return;

  // `cache: 'reload'` forces a network refetch that overwrites the cache entry.
  // `mode: 'cors'` + `credentials: 'omit'` match how the <script crossorigin>
  // module fetches partition the cache, so the reload reuses these fresh bytes.
  const refetch = Promise.all(
    unique.map((u) =>
      fetch(u, { cache: 'reload', mode: 'cors', credentials: 'omit' }).catch(() => {
        /* one failed refetch must not block the others or the reload */
      }),
    ),
  );
  await Promise.race([
    refetch,
    new Promise<void>((resolve) => setTimeout(resolve, BUST_TIMEOUT_MS)),
  ]);
}

/**
 * Clear all CacheStorage entries and reload the page ONCE per session so the
 * browser refetches a CONSISTENT set of stable-named chunks (post-propagation,
 * the skew is gone). Called by the ErrorBoundary version-skew recovery; shares
 * the `_swReloadCount` ceiling with the index.html bootstrap recovery so the two
 * skew surfaces (React-caught + global window error) reload at most MAX_RELOADS
 * times total. No-op outside the browser. Returns true if a reload was
 * scheduled, false if the per-session guard blocked it.
 */
export async function recoverFromStaleChunk(reason: string): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  // Dev (Vite HMR) produces transient skew that resolves itself — never reload.
  if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    return false;
  }
  let reloadCount = 0;
  try {
    reloadCount = parseInt(sessionStorage.getItem(BOOTSTRAP_RELOAD_KEY) || '0', 10) || 0;
  } catch {
    /* private mode — proceed without the guard */
  }
  if (reloadCount >= MAX_RELOADS) return false;
  try {
    sessionStorage.setItem(BOOTSTRAP_RELOAD_KEY, String(reloadCount + 1));
  } catch {
    /* private mode — guard unavailable, still attempt the reload below */
  }
  // Best-effort breadcrumb for Analytics.initGlobalErrorTracking() post-reload.
  try {
    sessionStorage.setItem(
      '_forceReloadInfo',
      JSON.stringify({
        source: 'resilient_import',
        reason,
        pagePath: window.location.pathname + window.location.search,
        timestamp: new Date().toISOString(),
      }),
    );
  } catch {
    /* storage unavailable */
  }
  if ('caches' in window) {
    try {
      const names = await caches.keys();
      await Promise.all(names.map((n) => caches.delete(n)));
    } catch {
      /* cache eviction is best-effort */
    }
  }
  // The skew lives in the HTTP cache, which `caches.delete()` does not touch —
  // bust it so the reload loads current bytes rather than the same stale set.
  await bustAssetHttpCache();
  window.location.reload();
  return true;
}

/**
 * Load a dynamically-imported module, recovering from stale-deploy failures.
 *
 * @param factory  the `() => import(...)` thunk.
 * @param validate optional guard run against the resolved module. Return
 *                 `false` when an expected export is missing (mode 2 above):
 *                 the module is then treated as a stale chunk and retried with
 *                 the same cache-clear → reload path as an outright fetch error.
 */
export async function resilientImport<T>(
  factory: () => Promise<T>,
  validate?: (mod: T) => boolean,
): Promise<T> {
  const attempt = async (): Promise<T> => {
    const mod = await factory();
    if (validate && !validate(mod)) {
      // Resolved, but missing expected exports — SPA-fallback HTML served for a
      // purged chunk. Surface it as a chunk-load error so the recovery path runs.
      const stale = new Error(
        'Failed to fetch dynamically imported module (stale chunk: expected exports missing)',
      );
      stale.name = 'ChunkLoadError';
      throw stale;
    }
    return mod;
  };

  try {
    return await attempt();
  } catch (err) {
    if (!isChunkLoadError(err)) throw err;
    // Clear all caches so the browser refetches fresh chunks.
    if (typeof window !== 'undefined' && 'caches' in window) {
      try {
        const names = await caches.keys();
        await Promise.all(names.map((n) => caches.delete(n)));
      } catch {
        /* cache eviction is best-effort */
      }
    }
    // Retry once after cache clear.
    try {
      return await attempt();
    } catch (err2) {
      // Chunk truly gone — reload to get fresh HTML with current chunk URLs.
      if (typeof window !== 'undefined') {
        let shouldReload = false;
        try {
          const rc = parseInt(sessionStorage.getItem(BOOTSTRAP_RELOAD_KEY) || '0', 10) || 0;
          if (rc < MAX_RELOADS) {
            sessionStorage.setItem(BOOTSTRAP_RELOAD_KEY, String(rc + 1));
            shouldReload = true;
          }
        } catch {
          /* sessionStorage unavailable (private mode) — skip reload guard */
        }
        if (shouldReload) {
          // Bust the HTTP cache before reloading: a stale-but-200 chunk (HTML
          // served for a purged name, or a skewed dependency) would otherwise be
          // re-served from the disk cache and the reload wasted.
          await bustAssetHttpCache();
          window.location.reload();
        }
      }
      throw err2;
    }
  }
}
