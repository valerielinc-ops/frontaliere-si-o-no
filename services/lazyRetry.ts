import React, { lazy } from 'react';

/**
 * Retry wrapper for React.lazy dynamic imports.
 * When a chunk fails to load (e.g., deploy replaced hashed chunks while user
 * had old entry module cached), this utility:
 * 1. Clears all Service Worker caches
 * 2. Retries the import twice (immediate + 2s delay)
 * 3. If retries fail, reloads the page ONCE to fetch the new entry module
 *    (which references new chunk hashes that exist on the server)
 * 4. If reload already happened this session, throws to ErrorBoundary
 *
 * The reload is the key fix: retrying the same dead URL can't work after a
 * deploy because the old chunk hash no longer exists. Only a full page reload
 * gets the new index.html → new App-*.js → new chunk references.
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
 // Already retried + reloaded this session — let ErrorBoundary handle it
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
 .catch(() => {
 // All retries failed — the old chunk hash is gone.
 // Reload the page to get the new entry module with new chunk refs.
 trackRetry('failure', err?.message || 'unknown');
 import('@/services/analytics').then(m => m.Analytics.trackForceReload({
 source: 'lazyRetry',
 reason: 'chunk_retries_exhausted',
 pagePath: window.location.pathname + window.location.search,
 blocked: false,
 })).catch(() => {});
 window.location.reload();
 // Reject to satisfy the type, though reload will prevent this from running
 reject(err);
 });
 }, 2000);
 })
 );
 })
 );
}
