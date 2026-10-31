/**
 * GDPR retention for assisted-application CVs (#6406).
 *
 * The public policy already uses a 90-day application window. This job only
 * removes files belonging to this flow, never follows an arbitrary path from
 * Firestore, and preserves an order explicitly opted into a future,
 * separately-consented talent pool.
 */

import { FieldValue, getFirestore, Timestamp } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { ASSISTED_APPLICATIONS_COLLECTION, FOLLOWUP_DOC_ID, PORTAL_ACCOUNTS_DOC_ID } from './assistedApplicationConstants.js';
import { ASSISTED_APPLICATION_STORAGE_BUCKET } from './assistedApplicationCvCheck.js';
import { SUBMISSION_DOC_ID } from './assistedApplicationSubmissionGuard.js';
import { artifactKeyForOrder, cleanupPendingArtifacts } from './lib/assistedApplicationArtifactRetention.js';
import { cleanupExpiredInitialCvArtifacts } from './lib/assistedApplicationInitialCvIngress.js';

import { ASSISTED_APPLICATION_RETENTION_DAYS, timestampMillis, retentionAnchor } from './lib/assistedApplicationRetentionPolicy.js';
export { ASSISTED_APPLICATION_RETENTION_DAYS, retentionPurgeDueAt, talentPoolConsentActive } from './lib/assistedApplicationRetentionPolicy.js';

const ASSISTED_STORAGE_PREFIX = 'assisted-application-uploads/';
const RETENTION_PAGE_SIZE = 500;
const STORAGE_BUCKET = ASSISTED_APPLICATION_STORAGE_BUCKET;

function storageKeyForOrder(orderId, value) {
  const key = String(value || '');
  const prefix = `${ASSISTED_STORAGE_PREFIX}${orderId}/`;
  if (!key.startsWith(prefix) || key.length > 600) return null;
  const fileName = key.slice(prefix.length);
  return /^[A-Za-z0-9._-]+$/.test(fileName) ? key : null;
}

async function candidateDocs(collection, field, cutoff) {
  const candidates = [];
  let cursor = null;

  while (true) {
    let query = collection.where(field, '<', cutoff).orderBy(field);
    if (cursor) query = query.startAfter(cursor);
    const snapshot = await query.limit(RETENTION_PAGE_SIZE).get();
    const docs = snapshot.docs || [];
    candidates.push(...docs.filter((doc) => doc.data()?.retentionPurgedAt == null));
    if (docs.length < RETENTION_PAGE_SIZE) break;

    const nextCursor = docs[docs.length - 1];
    if (!nextCursor || nextCursor.id === cursor?.id) break;
    cursor = nextCursor;
  }

  return candidates;
}

async function pendingArtifactOrders(collection) {
  const out = []; let cursor = null;
  while (true) {
    let query = collection.where('artifactCleanupPending', '==', true).orderBy('__name__').limit(RETENTION_PAGE_SIZE);
    if (cursor) query = query.startAfter(cursor);
    const page = await query.get(); const docs = page.docs || []; out.push(...docs);
    if (docs.length < RETENTION_PAGE_SIZE) return out;
    const next = docs[docs.length - 1];
    if (!next || next.id === cursor?.id) throw new Error('artifact_cleanup_cursor_stalled');
    cursor = next;
  }
}

/**
 * The automated flow (assistedApplicationAutomation.js) adds more personal
 * data next to the CV: generated cover letters and encrypted run evidence in
 * the order's Storage folder, the AI draft (profile, CV text) and the flow
 * (answers, feedback) in private subcollections, and the opens and clicks of
 * the candidate's e-mails (assistedApplicationEmailEvents.js). They share the
 * CV's retention: the whole order folder and those documents go with it.
 */
async function purgeAutomationData(bucket, orderRef, orderId) {
  if (typeof bucket.deleteFiles === 'function') {
    await bucket.deleteFiles({ prefix: `${ASSISTED_STORAGE_PREFIX}${orderId}/` });
  }
  if (typeof orderRef?.collection !== 'function') return;
  const execution = orderRef.collection('automation').doc('execution');
  if ((await execution.get()).exists) await execution.set({ artifacts: null }, { merge: true });
  for (const [collection, id] of [['ai_drafts', 'current'], ['automation', 'flow'], ['automation', SUBMISSION_DOC_ID], ['automation', 'intake'], ['automation', PORTAL_ACCOUNTS_DOC_ID], ['automation', FOLLOWUP_DOC_ID]]) {
    await orderRef.collection(collection).doc(id).delete();
  }
  for (const name of ['automation_events', 'inbox', 'email_events']) {
    const docs = await orderRef.collection(name).get();
    for (const doc of docs.docs || []) await doc.ref.delete();
  }
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
  const firestore = getFirestore();
  const cutoffMillis = nowMs - retentionDays * 86400000;
  const cutoff = Timestamp.fromMillis(cutoffMillis);
  const collection = firestore.collection(ASSISTED_APPLICATIONS_COLLECTION);
  const [submittedDocs, refundedDocs, uploadedDocs, pendingDocs] = await Promise.all([
    candidateDocs(collection, 'submittedAt', cutoff),
    candidateDocs(collection, 'refundedAt', cutoff),
    candidateDocs(collection, 'cvUploadedAt', cutoff),
    pendingArtifactOrders(collection),
  ]);

  const candidates = new Map();
  for (const snapshot of [
    ...submittedDocs,
    ...refundedDocs,
    ...uploadedDocs,
    ...pendingDocs,
  ]) {
    candidates.set(snapshot.id, snapshot);
  }

  const bucket = getStorage().bucket(STORAGE_BUCKET);
  let purged = 0;
  let skipped = 0;
  let failed = 0;

  for (const snapshot of candidates.values()) {
    let order = snapshot.data() || {};
    // First-upload operations have no CV anchor yet. Revisit their technical
    // reservations before the normal 90-day eligibility test, without an order embargo.
    if (order.artifactCleanupPending) {
      try {
        await cleanupExpiredInitialCvArtifacts({ db: firestore, bucket, orderRef: snapshot.ref, nowMs });
        order = (await snapshot.ref.get()).data() || {};
      } catch { failed += 1; continue; }
    }
    if (order.retentionPurgedAt || order.retentionPayloadPurgedAt) {
      if (order.artifactCleanupPending) {
        try {
          const cleanup = await cleanupPendingArtifacts({ db: firestore, bucket, orderRef: snapshot.ref });
          if (!cleanup.pending && !order.retentionPurgedAt) await snapshot.ref.set({ retentionPurgedAt: FieldValue.serverTimestamp(), artifactCleanupPending: false }, { merge: true });
        }
        catch { failed += 1; }
      }
      continue;
    }
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
      const admitted = await firestore.runTransaction(async transaction => {
        const fresh = await transaction.get(snapshot.ref); const current = fresh.data() || {};
        const anchor = timestampMillis(retentionAnchor(current));
        if (!fresh.exists || current.retentionPurgedAt || current.talentPoolConsent === true || anchor === null || anchor >= cutoffMillis) return null;
        const currentKeys = [current.cvStorageKey, current.coverLetterStorageKey].map(value => String(value || '').trim()).filter(Boolean);
        if (!currentKeys.every(key => artifactKeyForOrder(snapshot.id, key))) throw new Error('artifact_retention_key_invalid');
        transaction.set(snapshot.ref, { retentionPurgingAt: FieldValue.serverTimestamp(), automationDueAt: null, followupDueAt: null }, { merge: true });
        return { order: current, keys: currentKeys };
      });
      if (!admitted) { skipped += 1; continue; }
      order = admitted.order;
      for (const key of admitted.keys) {
        await bucket.file(key).delete({ ignoreNotFound: true });
      }
      await purgeAutomationData(bucket, snapshot.ref, snapshot.id);
      const cleanup = await cleanupPendingArtifacts({ db: firestore, bucket, orderRef: snapshot.ref });
      if (order.candidateAlias?.address) {
        const { removeOrderAlias } = await import('./assistedApplicationAlias.js');
        await removeOrderAlias({ db: firestore, order });
      }
      await snapshot.ref.set({
        cvStorageKey: null,
        cvUploadedAt: null,
        coverLetterStorageKey: null,
        automationDueAt: null,
        followupDueAt: null,
        interviewPrep: null,
        candidateAlias: null,
        emailEngagement: null,
        employerResponse: null,
        employerReplies: 0,
        lastEmployerReplyAt: null,
        lastEmployerReplyCategory: null,
        retentionPayloadPurgedAt: FieldValue.serverTimestamp(),
        retentionPurgedAt: cleanup.pending ? null : FieldValue.serverTimestamp(),
        artifactCleanupPending: cleanup.pending,
        updatedAt: FieldValue.serverTimestamp(),
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
