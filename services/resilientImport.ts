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
 * Detect a CROSS-CHUNK VERSION-SKEW TypeError — a third stale-deploy failure
 * mode the two above do not cover.
 *
 * Root cause: chunk FILENAMES are stable (non-hashed, see vite.config rollup
 * output) but Rollup minifies internal cross-chunk export names to single
 * letters (`export { lt as m }`) that are REASSIGNED every build from pure
 * minifier ordering. When a deploy re-letters an export, a client still holding
 * a previously-cached importer chunk binds the OLD letter (`import { m as ls }`)
 * to whatever the FRESH dependency chunk now exports under `m`. Both chunks load
 * fine (HTTP 200, real JS) — the mismatch only surfaces at CALL time as a
 * TypeError: the bound symbol is the wrong kind of value.
 *
 * Observed shapes (minified identifiers, so the names are short/opaque):
 *   - "ls(...).then is not a function"  (expected an async fn, got something else)
 *   - "n is not a function" / "x.y is not a function"
 *   - "Ze is not a constructor"
 *   - "e is not iterable"
 *
 * Unlike isChunkLoadError this is NOT throwable at import() time — it fires deep
 * in render / effects / event handlers, so it is caught by the React
 * ErrorBoundary (in-render) or the global window 'error' handler (outside React),
 * NOT by resilientImport's import() wrapper. Both call recoverFromStaleChunk().
 *
 * The predicate is intentionally signature-based (not name-based — minification
 * makes every identifier opaque). A genuine app bug producing the same message
 * costs at most ONE extra reload before the per-session guard blocks further
 * reloads and the error UI is shown — identical to the existing chunk-recovery
 * tradeoff, and far better than a permanent white screen on a real skew.
 */
export function isVersionSkewError(err: unknown): boolean {
  const e = err as { name?: string; message?: string } | null | undefined;
  if (!e || e.name !== 'TypeError') return false;
  const msg = e.message || '';
  return (
    /\bis not a function\b/.test(msg) ||
    /\bis not a constructor\b/.test(msg) ||
    /\bis not iterable\b/.test(msg)
  );
}

// Session-wide reload ceiling shared across ALL three recovery surfaces:
// resilientImport's chunk-load path (below), recoverFromStaleChunk (called by
// ErrorBoundary + global window-error handler), and index.html bootstrap handlers.
// At most one reload per session total; the value `>= 1` blocks further reloads.
const BOOTSTRAP_RELOAD_KEY = '_swReloadCount';

/**
 * Clear all CacheStorage entries and reload the page ONCE per session so the
 * browser refetches a CONSISTENT set of stable-named chunks (post-propagation,
 * the skew is gone). Called by the ErrorBoundary version-skew recovery; shares
 * the `_swReloadCount` ceiling with the index.html bootstrap recovery so the two
 * skew surfaces (React-caught + global window error) reload at most once total.
 * No-op outside the browser. Returns true if a reload was scheduled, false if
 * the per-session guard blocked it.
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
  if (reloadCount >= 1) return false;
  try {
    sessionStorage.setItem(BOOTSTRAP_RELOAD_KEY, String(reloadCount + 1));
  } catch {
    /* private mode — guard unavailable, still attempt one reload below */
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
        try {
          const rc = parseInt(sessionStorage.getItem(BOOTSTRAP_RELOAD_KEY) || '0', 10) || 0;
          if (rc < 1) {
            sessionStorage.setItem(BOOTSTRAP_RELOAD_KEY, String(rc + 1));
            window.location.reload();
          }
        } catch {
          /* sessionStorage unavailable (private mode) — skip reload guard */
        }
      }
      throw err2;
    }
  }
}
