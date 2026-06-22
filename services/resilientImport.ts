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

// Shared across all callers so a stale deploy triggers at most one reload per
// session, no matter which service chunk was the first to fail.
const RELOAD_KEY = '_serviceChunkReload';

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
          if (!sessionStorage.getItem(RELOAD_KEY)) {
            sessionStorage.setItem(RELOAD_KEY, '1');
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
