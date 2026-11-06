import {
  aggregateTrafficHistoryDocuments,
  PUBLIC_TRAFFIC_HISTORY_PAGE_SIZE,
  PUBLIC_TRAFFIC_HISTORY_TARGETS,
} from './publicTrafficHistoryData.js';

/** A warm function instance serves this slow-changing aggregate for six hours. */
export const PUBLIC_TRAFFIC_HISTORY_CACHE_MS = 6 * 60 * 60 * 1000;

let cachedSnapshot = null;
let cachedAtMs = 0;
let pendingSnapshot = null;

export function resetPublicTrafficHistoryCache() {
  cachedSnapshot = null;
  cachedAtMs = 0;
  pendingSnapshot = null;
}

/**
 * Read and aggregate the bounded history sample once on a warm instance.
 * Returning the aggregate, rather than the raw 3,000-document sample, keeps
 * the public endpoint small and lets all browser consumers share one cache.
 */
export async function readPublicTrafficHistory(db) {
  const entries = await Promise.all(PUBLIC_TRAFFIC_HISTORY_TARGETS.map(async ({ name, slug }) => {
    try {
      const snapshot = await db.collection('trafficHistory', slug, 'snapshots')
        .orderBy('lastUpdate', 'desc')
        .limit(PUBLIC_TRAFFIC_HISTORY_PAGE_SIZE)
        .get();
      return [name, aggregateTrafficHistoryDocuments(snapshot?.docs || [])];
    } catch (error) {
      console.warn(`[publicTrafficHistory] failed to read ${slug}:`, error instanceof Error ? error.message : String(error));
      return [name, null];
    }
  }));

  return Object.fromEntries(entries.filter(([, value]) => value));
}

/** Read the public aggregate through Admin SDK, with bounded instance cache. */
export async function getPublicTrafficHistory({ db: injectedDb, nowMs = Date.now() } = {}) {
  if (!injectedDb && cachedSnapshot && nowMs >= cachedAtMs && nowMs - cachedAtMs < PUBLIC_TRAFFIC_HISTORY_CACHE_MS) {
    return cachedSnapshot;
  }
  if (!injectedDb && pendingSnapshot) return pendingSnapshot;

  const load = async () => {
    const db = injectedDb || (await import('./newsletterResendWebhookCore.js')).getAdminDb();
    const history = await readPublicTrafficHistory(db);
    const result = { history };
    if (!injectedDb) {
      cachedSnapshot = result;
      cachedAtMs = nowMs;
    }
    return result;
  };

  if (injectedDb) return load();
  pendingSnapshot = load().finally(() => { pendingSnapshot = null; });
  return pendingSnapshot;
}
