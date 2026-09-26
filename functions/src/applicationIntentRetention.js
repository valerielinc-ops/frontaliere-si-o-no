/**
 * GDPR retention for server-owned application-intent records.
 *
 * New records use `expiresAt`, calculated by the server at write time. The
 * legacy `retentionUntil` query keeps records written by the first producer
 * implementation covered without using an inferred creation timestamp.
 * Documents without a demonstrable expiry are never deleted by this job.
 */

import admin from 'firebase-admin';

export const APPLICATION_INTENTS_COLLECTION = 'application_intents';
export const APPLICATION_INTENT_RETENTION_DAYS = 90;
export const APPLICATION_INTENT_RETENTION_PAGE_SIZE = 450;
export const APPLICATION_INTENT_RETENTION_MAX_PAGES = 20;

const DAY_MS = 86400000;
const EXPIRY_FIELDS = Object.freeze(['expiresAt', 'retentionUntil']);

function timestampMillis(value) {
  if (value && typeof value.toMillis === 'function') {
    const millis = value.toMillis();
    return Number.isFinite(millis) ? millis : null;
  }
  if (value && typeof value.seconds === 'number') {
    const nanos = typeof value.nanoseconds === 'number' ? value.nanoseconds : 0;
    const millis = value.seconds * 1000 + Math.floor(nanos / 1e6);
    return Number.isFinite(millis) ? millis : null;
  }
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  return null;
}

function documentData(snapshot) {
  const value = snapshot?.data;
  return typeof value === 'function' ? value() || {} : value || {};
}

function documentKey(snapshot) {
  return String(snapshot?.ref?.path || snapshot?.id || '');
}

/**
 * Resolve the expiry selected by the query. A malformed canonical expiry
 * blocks the legacy fallback so a partial/mutated document cannot be erased
 * from an inferred field.
 */
function demonstrableExpiry(data, field) {
  if (field === 'retentionUntil' && Object.prototype.hasOwnProperty.call(data, 'expiresAt')) {
    return timestampMillis(data.expiresAt);
  }
  return timestampMillis(data?.[field]);
}

function validateRetentionInput(retentionDays, nowMs) {
  if (!Number.isFinite(retentionDays) || retentionDays < 0) {
    throw new Error('invalid_application_intent_retention_days');
  }
  if (!Number.isFinite(nowMs)) {
    throw new Error('invalid_application_intent_retention_now');
  }
}

async function purgeExpiryField({ collection, db, field, cutoff, cutoffMs }) {
  let cursor = null;
  let pages = 0;
  let purged = 0;
  let skipped = 0;
  let scanned = 0;
  let hasMore = false;

  while (pages < APPLICATION_INTENT_RETENTION_MAX_PAGES) {
    let query = collection
      .where(field, '<=', cutoff)
      .orderBy(field)
      .limit(APPLICATION_INTENT_RETENTION_PAGE_SIZE);
    if (cursor) query = query.startAfter(cursor);

    const snapshot = await query.get();
    const docs = Array.isArray(snapshot?.docs) ? snapshot.docs : [];
    if (docs.length === 0) {
      hasMore = false;
      break;
    }

    pages += 1;
    scanned += docs.length;
    const batch = db.batch();
    let pagePurged = 0;
    for (const doc of docs) {
      const expiryMs = demonstrableExpiry(documentData(doc), field);
      if (expiryMs === null || expiryMs > cutoffMs) {
        skipped += 1;
        continue;
      }
      batch.delete(doc.ref);
      pagePurged += 1;
    }
    if (pagePurged > 0) {
      await batch.commit();
      purged += pagePurged;
    }

    if (docs.length < APPLICATION_INTENT_RETENTION_PAGE_SIZE) {
      hasMore = false;
      break;
    }

    const nextCursor = docs[docs.length - 1];
    const nextKey = documentKey(nextCursor);
    if (!nextKey || nextKey === documentKey(cursor)) {
      hasMore = false;
      break;
    }
    cursor = nextCursor;
    hasMore = true;
  }

  return { purged, skipped, scanned, pages, hasMore };
}

/**
 * Delete expired application-intent records in bounded, retry-safe batches.
 * Missing or malformed expiry fields are left untouched so a partial legacy
 * document cannot be deleted on the strength of an inferred timestamp.
 *
 * @param {number} [retentionDays]
 * @param {number} [nowMs]
 * @param {import('firebase-admin/firestore').Firestore} [injectedDb]
 * @returns {Promise<{purged:number, skipped:number, scanned:number, pages:number, hasMore:boolean}>}
 */
export async function purgeExpiredApplicationIntents(
  retentionDays = APPLICATION_INTENT_RETENTION_DAYS,
  nowMs = Date.now(),
  injectedDb,
) {
  validateRetentionInput(retentionDays, nowMs);
  const cutoffMs = nowMs - retentionDays * DAY_MS;
  const cutoff = admin.firestore.Timestamp.fromMillis(cutoffMs);
  const db = injectedDb || admin.firestore();
  const collection = db.collection(APPLICATION_INTENTS_COLLECTION);

  const totals = { purged: 0, skipped: 0, scanned: 0, pages: 0, hasMore: false };
  for (const field of EXPIRY_FIELDS) {
    const result = await purgeExpiryField({ collection, db, field, cutoff, cutoffMs });
    totals.purged += result.purged;
    totals.skipped += result.skipped;
    totals.scanned += result.scanned;
    totals.pages += result.pages;
    totals.hasMore ||= result.hasMore;
  }

  return totals;
}
