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

      const clearCaches = async () => {
        if ('caches' in window) {
          const names = await caches.keys();
          await Promise.all(names.map(n => caches.delete(n)));
        }
      };

      const trackRetry = (outcome: 'success' | 'failure', msg: string) => {
        import('@/services/analytics').then(m => m.Analytics.trackChunkRetry({
          outcome,
          errorMessage: msg,
          pagePath: window.location.pathname + window.location.search,
        })).catch(() => {});
      };

      // Retry 1: clear caches and retry immediately
      return clearCaches()
        .then(() => factory())
        .then(result => { trackRetry('success', err?.message || ''); return result; })
        .catch(() =>
          // Retry 2: wait 2s for CDN propagation, then retry
          new Promise<{ default: T }>((resolve, reject) => {
            setTimeout(() => {
              factory()
                .then(result => { trackRetry('success', err?.message || ''); resolve(result); })
                .catch(() => { trackRetry('failure', err?.message || 'unknown'); reject(err); });
            }, 2000);
          })
        );
    })
  );
}
