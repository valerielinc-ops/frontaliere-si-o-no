/**
 * Public read model for the current border-crossing traffic snapshot.
 *
 * Firestore rules intentionally allow public reads for this collection, but
 * the browser must not use the Firestore REST API with a key embedded in the
 * generated hydration asset. This endpoint reads with Admin SDK and returns a
 * deliberately small, REST-shaped allowlist of fields.
 */

export const PUBLIC_TRAFFIC_FIELDS = Object.freeze([
  'crossingName',
  'waitTimeMinutes',
  'approachMinutes',
  'totalCrossingMinutes',
  'status',
  'source',
  'officialSources',
  'officialLastUpdate',
  'officialQueueKm',
  'dataQuality',
  'lastUpdate',
  'hour',
  'dayOfWeek',
]);

// Keep the response bounded while still covering the whole current snapshot.
// A larger collection is an integrity failure, not a reason to return a
// partial snapshot: the caller will turn the error into a 503 and preserve
// the pre-rendered values.
export const PUBLIC_TRAFFIC_PAGE_SIZE = 200;
export const PUBLIC_TRAFFIC_MAX_DOCUMENTS = 2000;
export const PUBLIC_TRAFFIC_CURRENT_CACHE_MS = 60 * 1000;

let cachedSnapshot = null;
let cachedAtMs = 0;
let pendingSnapshot = null;

export function resetPublicTrafficCurrentCache() {
  cachedSnapshot = null;
  cachedAtMs = 0;
  pendingSnapshot = null;
}

/** Convert one allowlisted Firestore value to the REST response shape. */
export function encodeFirestoreValue(value) {
  if (value === null) return { nullValue: null };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Number.isInteger(value)
      ? { integerValue: String(value) }
      : { doubleValue: value };
  }

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return { timestampValue: value.toISOString() };
  }

  if (value && typeof value.toDate === 'function') {
    const date = value.toDate();
    if (date instanceof Date && !Number.isNaN(date.getTime())) {
      return { timestampValue: date.toISOString() };
    }
  }

  return null;
}

/** Build the intentionally narrow public representation of one document. */
export function buildPublicTrafficDocument(document) {
  const data = typeof document?.data === 'function' ? document.data() : {};
  const fields = {};

  for (const field of PUBLIC_TRAFFIC_FIELDS) {
    const encoded = encodeFirestoreValue(data?.[field]);
    if (encoded) fields[field] = encoded;
  }

  return {
    // The hydration client only needs the stable crossing slug.
    name: String(document?.id || ''),
    fields,
  };
}

/**
 * Read every current traffic document in stable, bounded pages.
 *
 * Firestore's document-id ordering makes `startAfter(lastDoc)` deterministic
 * across pages. If the defensive cap is exceeded, throw instead of returning
 * an incomplete snapshot that the hydration client could treat as current.
 */
export async function readPublicTrafficDocuments(collectionRef) {
  const documents = [];
  let query = collectionRef.orderBy('__name__').limit(PUBLIC_TRAFFIC_PAGE_SIZE);

  while (true) {
    const snapshot = await query.get();
    const pageDocuments = Array.isArray(snapshot?.docs) ? snapshot.docs : [];
    if (pageDocuments.length === 0) break;

    if (documents.length + pageDocuments.length > PUBLIC_TRAFFIC_MAX_DOCUMENTS) {
      throw new Error('trafficCurrent pagination limit');
    }

    documents.push(...pageDocuments);
    if (pageDocuments.length < PUBLIC_TRAFFIC_PAGE_SIZE) break;

    const lastDocument = pageDocuments[pageDocuments.length - 1];
    query = collectionRef
      .orderBy('__name__')
      .startAfter(lastDocument)
      .limit(PUBLIC_TRAFFIC_PAGE_SIZE);
  }

  return documents;
}

/** Read the latest public snapshot with Admin SDK and no client credential. */
export async function getPublicTrafficCurrent({ db: injectedDb, nowMs = Date.now() } = {}) {
  if (!injectedDb && cachedSnapshot && nowMs >= cachedAtMs && nowMs - cachedAtMs < PUBLIC_TRAFFIC_CURRENT_CACHE_MS) {
    return cachedSnapshot;
  }
  if (!injectedDb && pendingSnapshot) return pendingSnapshot;

  const load = async () => {
    const db = injectedDb || (await import('./newsletterResendWebhookCore.js')).getAdminDb();
    const documents = await readPublicTrafficDocuments(db.collection('trafficCurrent'));
    const result = { documents: documents.map(buildPublicTrafficDocument) };
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
