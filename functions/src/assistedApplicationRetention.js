/**
 * GDPR retention for assisted-application CVs (#6406).
 *
 * The public policy already uses a 90-day application window. This job only
 * removes files belonging to this flow, never follows an arbitrary path from
 * Firestore, and preserves an order explicitly opted into a future,
 * separately-consented talent pool.
 */

import admin from 'firebase-admin';

export const ASSISTED_APPLICATION_RETENTION_DAYS = 90;

const ASSISTED_APPLICATIONS_COLLECTION = 'assisted_applications';
const ASSISTED_STORAGE_PREFIX = 'assisted-application-uploads/';
const STORAGE_BUCKET =
  process.env.FIREBASE_STORAGE_BUCKET ||
  process.env.STORAGE_BUCKET ||
  'frontaliere-ticino.firebasestorage.app';

function timestampMillis(value) {
  if (value && typeof value.toMillis === 'function') {
    const result = value.toMillis();
    return Number.isFinite(result) ? result : null;
  }
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  return null;
}

function retentionAnchor(order) {
  if (order?.refundedAt != null) return order.refundedAt;
  if (order?.submissionStatus === 'ready_for_manual_submission' && order.submittedAt != null) {
    return order.submittedAt;
  }
  return order?.cvUploadedAt ?? null;
}

function storageKeyForOrder(orderId, value) {
  const key = String(value || '');
  const prefix = `${ASSISTED_STORAGE_PREFIX}${orderId}/`;
  if (!key.startsWith(prefix) || key.length > 600) return null;
  const fileName = key.slice(prefix.length);
  return /^[A-Za-z0-9._-]+$/.test(fileName) ? key : null;
}

function candidateDocs(collection, field, cutoff) {
  return collection
    .where(field, '<', cutoff)
    .limit(500)
    .get();
}

/**
 * Delete expired assisted-application files and clear their references.
 * @param {number} [retentionDays]
 * @param {number} [nowMs]
 * @returns {Promise<{purged:number, skipped:number, failed:number}>}
 */
export async function purgeExpiredAssistedApplicationFiles(
  retentionDays = ASSISTED_APPLICATION_RETENTION_DAYS,
  nowMs = Date.now(),
) {
  if (!Number.isFinite(retentionDays) || retentionDays < 0) {
    throw new Error('invalid_assisted_application_retention_days');
  }
  const firestore = admin.firestore();
  const cutoffMillis = nowMs - retentionDays * 86400000;
  const cutoff = admin.firestore.Timestamp.fromMillis(cutoffMillis);
  const collection = firestore.collection(ASSISTED_APPLICATIONS_COLLECTION);
  const [submittedSnapshot, refundedSnapshot, uploadedSnapshot] = await Promise.all([
    candidateDocs(collection, 'submittedAt', cutoff),
    candidateDocs(collection, 'refundedAt', cutoff),
    candidateDocs(collection, 'cvUploadedAt', cutoff),
  ]);

  const candidates = new Map();
  for (const snapshot of [
    ...(submittedSnapshot.docs || []),
    ...(refundedSnapshot.docs || []),
    ...(uploadedSnapshot.docs || []),
  ]) {
    candidates.set(snapshot.id, snapshot);
  }

  const bucket = admin.storage().bucket(STORAGE_BUCKET);
  let purged = 0;
  let skipped = 0;
  let failed = 0;

  for (const snapshot of candidates.values()) {
    const order = snapshot.data() || {};
    const anchorMillis = timestampMillis(retentionAnchor(order));
    if (order.talentPoolConsent === true || anchorMillis === null || anchorMillis >= cutoffMillis) {
      skipped += 1;
      continue;
    }

    const rawKeys = [order.cvStorageKey, order.coverLetterStorageKey]
      .map((value) => String(value || '').trim())
      .filter(Boolean);
    const keys = rawKeys
      .map((value) => storageKeyForOrder(snapshot.id, value))
      .filter(Boolean);
    // An assisted order should only ever contain references created by this
    // flow. Do not clear a malformed/legacy reference just because it is
    // older than the retention window; preserving it is safer than touching a
    // path that this job cannot prove belongs to the order.
    if (keys.length !== rawKeys.length) {
      skipped += 1;
      console.error('[purgeExpiredAssistedApplicationFiles] invalid storage reference', snapshot.id);
      continue;
    }
    try {
      for (const key of keys) {
        await bucket.file(key).delete({ ignoreNotFound: true });
      }
      await snapshot.ref.set({
        cvStorageKey: null,
        cvUploadedAt: null,
        coverLetterStorageKey: null,
        retentionPurgedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      purged += 1;
    } catch (error) {
      failed += 1;
      console.error(
        '[purgeExpiredAssistedApplicationFiles]',
        snapshot.id,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  return { purged, skipped, failed };
}
