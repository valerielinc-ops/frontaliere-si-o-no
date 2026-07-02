import React, { lazy } from 'react';
import { bustAssetHttpCache, consumeReloadBudget } from '@/services/resilientImport';

/**
 * Retry wrapper for React.lazy dynamic imports.
 * When a chunk fails to load (e.g., deploy replaced hashed chunks while user
 * had old entry module cached), this utility:
 * 1. Clears all Service Worker caches
 * 2. Retries the import twice (immediate + 2s delay)
 * 3. If retries fail, reloads the page to fetch the new entry module
 *    (which references new chunk hashes that exist on the server)
 * 4. Draws from the SAME shared per-signature reload budget as
 *    resilientImport.ts/recoverFromStaleChunk (consumeReloadBudget, keyed on the
 *    failing chunk's error message) — previously this used its own standalone
 *    `_chunkRetry` one-shot flag, which meant the FIRST chunk-load failure in a
 *    session permanently blocked recovery for every OTHER, unrelated chunk that
 *    went stale later (same exhaustion bug as the flat `_swReloadCount` counter
 *    this shares a fix with — see resilientImport.ts).
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
 // FETCH-failure signature only (chunk 404 / SPA-fallback HTML / parse).
 // A LINK-TIME version-skew SyntaxError ("does not provide an export
 // named ...", issue #3097) is a DIFFERENT class: the chunk fetched fine
 // but a cached importer links a missing export. Not matched here because
 // retrying re-links the same stale cached dependency. It rethrows to the
 // ErrorBoundary, whose isVersionSkewError -> recoverFromStaleChunk does the
 // correct clear-caches + single shared-guard reload.
 const isChunkError =
 err?.message?.includes('Failed to fetch dynamically imported module') ||
 err?.message?.includes('Importing a module script failed') ||
 err?.message?.includes('Loading chunk') ||
 err?.message?.includes('Loading CSS chunk') ||
 err?.message?.includes('error loading dynamically imported module') ||
 err?.name === 'ChunkLoadError';

 if (!isChunkError) throw err;

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
 trackRetry('failure', err?.message || 'unknown');
 // Only spend the shared budget HERE, once retries are exhausted — NOT
 // up front. Spending it before the retry attempt would burn a slot on
 // every chunk-load error even when the retry succeeds (the common
 // case), starving the OTHER recovery surfaces that share this budget
 // (index.html / recoverFromStaleChunk / resilientImport) of attempts
 // for unrelated, still-recoverable chunks (recurrence of #3097).
 const blocked = !consumeReloadBudget(err?.message || 'chunk_load');
 import('@/services/analytics').then(m => m.Analytics.trackForceReload({
 source: 'lazyRetry',
 reason: 'chunk_retries_exhausted',
 pagePath: window.location.pathname + window.location.search,
 blocked,
 })).catch(() => {});
 if (blocked) {
 // This signature already spent its budget (or the session hit the
 // total reload ceiling) — let ErrorBoundary handle it instead.
 reject(err);
 return;
 }
 // Bust the HTTP cache (not just CacheStorage) before reloading: a stale-but-200
 // chunk (SPA-fallback HTML for a .js, or a cached module the retries kept
 // re-linking) would otherwise be re-served from the disk cache and this one
 // reload wasted (#3097).
 void bustAssetHttpCache().finally(() => window.location.reload());
 // Reject to satisfy the type, though reload will prevent this from running
 reject(err);
 });
 }, 2000);
 })
 );
 })
 );
}
