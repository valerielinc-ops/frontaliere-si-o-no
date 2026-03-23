import React, { lazy } from 'react';

/**
 * Retry wrapper for React.lazy dynamic imports.
 * When a chunk fails to load (e.g., stale SW cache serving old HTML with wrong
 * hash, or network blip), this utility:
 *   1. Clears all Service Worker caches
 *   2. Retries the import once from the network
 *   3. If retry also fails, throws to let ErrorBoundary show error UI
 *
 * IMPORTANT: This function NEVER calls window.location.reload().
 * Reload responsibility belongs solely to ErrorBoundary (max 1 per session).
 */
export function lazyRetry<T extends React.ComponentType<any>>(
  factory: () => Promise<{ default: T }>,
): React.LazyExoticComponent<T> {
  return lazy(() =>
    factory().catch((err: Error) => {
      const isChunkError =
        err?.message?.includes('Failed to fetch dynamically imported module') ||
        err?.message?.includes('Importing a module script failed') ||
        err?.message?.includes('Loading chunk') ||
        err?.message?.includes('Loading CSS chunk') ||
        err?.message?.includes('error loading dynamically imported module') ||
        err?.name === 'ChunkLoadError';

      if (!isChunkError) throw err;

      const retryKey = '_chunkRetry';
      if (sessionStorage.getItem(retryKey)) {
        import('@/services/analytics').then(m => m.Analytics.trackChunkRetry({
          outcome: 'failure',
          errorMessage: `Guard blocked: ${err?.message || 'unknown'}`,
          pagePath: window.location.pathname + window.location.search,
        })).catch(() => {});
        throw err;
      }

      sessionStorage.setItem(retryKey, '1');

      const clearAndRetry = async (): Promise<{ default: T }> => {
        if ('caches' in window) {
          const names = await caches.keys();
          await Promise.all(names.map(n => caches.delete(n)));
        }
        const result = await factory();
        import('@/services/analytics').then(m => m.Analytics.trackChunkRetry({
          outcome: 'success',
          errorMessage: err?.message || '',
          pagePath: window.location.pathname + window.location.search,
        })).catch(() => {});
        return result;
      };

      return clearAndRetry().catch(() => {
        import('@/services/analytics').then(m => m.Analytics.trackChunkRetry({
          outcome: 'failure',
          errorMessage: err?.message || 'unknown',
          pagePath: window.location.pathname + window.location.search,
        })).catch(() => {});
        throw err;
      });
    })
  );
}
