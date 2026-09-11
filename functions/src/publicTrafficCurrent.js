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
  'lastUpdate',
  'hour',
  'dayOfWeek',
]);

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

/** Read the latest public snapshot with Admin SDK and no client credential. */
export async function getPublicTrafficCurrent() {
  const { getAdminDb } = await import('./newsletterResendWebhookCore.js');
  const snapshot = await getAdminDb()
    .collection('trafficCurrent')
    .limit(200)
    .get();

  return {
    documents: snapshot.docs.map(buildPublicTrafficDocument),
  };
}
