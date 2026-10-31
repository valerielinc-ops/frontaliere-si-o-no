/** First-CV storage authority is distinct from employer consent and the CV retention clock. */
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { assistedApplicationRetained, timestampMillis } from './assistedApplicationRetentionPolicy.js';
import { artifactKeyForOrder, uploadOwnedArtifact, ownedArtifactGeneration,
  deleteOwnedArtifactGeneration, settlePendingArtifactFlag } from './assistedApplicationArtifactRetention.js';

// Both existing HTTP upload handlers have timeoutSeconds: 60. This bounds one
// operation; it neither starts nor extends the 90-day CV retention clock.
export const INITIAL_CV_OPERATION_MS = 60_000;
const PURPOSE = 'initial_cv';
const ORDER_FIELDS = new Set(['cvStorageKey', 'cvFileName', 'cvUploadedAt', 'cvUploadedBy',
  'updatedAt', 'submissionStatus', 'statusChangedAt']);

function isAsyncResult(value) {
  if (!value || typeof value.then !== 'function') return false;
  // A rejected private callback is not authority and must not escape as an
  // unhandled rejection while the synchronous operation is being refused.
  void Promise.resolve(value).catch(() => {});
  return true;
}

function publicationSnapshot(value, seen = new Set()) {
  if (value == null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
  if (value instanceof Timestamp) return new Timestamp(value.seconds, value.nanoseconds);
  if (value instanceof Date) return new Date(value.getTime());
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof FieldValue && value.isEqual(FieldValue.serverTimestamp())) return FieldValue.serverTimestamp();
  if (typeof value !== 'object' || seen.has(value)
    || (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))) throw new Error('initial_cv_publication_invalid');
  seen.add(value);
  const result = Array.isArray(value) ? [] : {};
  for (const [field, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (field === 'length' && Array.isArray(value)) continue;
    if (descriptor.get || descriptor.set) throw new Error('initial_cv_publication_invalid');
    Object.defineProperty(result, field, { enumerable: descriptor.enumerable, configurable: true, writable: true,
      value: publicationSnapshot(descriptor.value, seen) });
  }
  seen.delete(value);
  return result;
}

export function initialCvIngressOrderAllowed(order, uploaderAllows) {
  const eligible = order?.paymentStatus === 'paid' && !order.cvStorageKey
    && order.cvUploadedAt == null && order.submittedAt == null && order.refundedAt == null
    && !['pending', 'succeeded', 'completed', 'refunded'].includes(order.refundStatus)
    && order.retentionPurgingAt == null && order.retentionPurgedAt == null && order.retentionPayloadPurgedAt == null
    && typeof uploaderAllows === 'function';
  if (!eligible) return false;
  const result = uploaderAllows(order);
  return !isAsyncResult(result) && result === true;
}

function samePublishedCv(order, key, nowMs) {
  return order?.cvStorageKey === key && Number.isFinite(timestampMillis(order.cvUploadedAt))
    && assistedApplicationRetained(order, nowMs);
}

function validReservation(record, id, orderId) {
  return record?.purpose === PURPOSE && record.writeId === id && artifactKeyForOrder(orderId, record.key)
    && Number.isFinite(record.createdAt) && Number.isFinite(record.expiresAt)
    && record.expiresAt > record.createdAt && record.expiresAt <= record.createdAt + INITIAL_CV_OPERATION_MS
    && ['uploading', 'uploaded'].includes(record.state);
}

/** Private caller supplies a synchronous predicate over its already authenticated upload request. */
export function initialCvArtifactStore({ db, bucket, orderId, key, uploaderAllows, now = Date.now,
  operationStartedAt = now() }) {
  if (!artifactKeyForOrder(orderId, key) || typeof uploaderAllows !== 'function'
    || !Number.isFinite(operationStartedAt) || operationStartedAt <= 0) throw new Error('initial_cv_ingress_invalid');
  const monotonicStart = performance.now();
  const clock = () => Math.floor(Math.max(now(), operationStartedAt + Math.max(0, performance.now() - monotonicStart)));
  const orderRef = db.collection('assisted_applications').doc(orderId);
  const manifests = orderRef.collection('pending_artifacts');
  const marker = manifests.doc(randomUUID());
  const expiresAt = operationStartedAt + INITIAL_CV_OPERATION_MS;
  const allowed = (order, time) => Number.isFinite(time) && time < expiresAt
    && initialCvIngressOrderAllowed(order, uploaderAllows);
  let started = false; let generation = null;

  const abandon = async () => {
    await db.runTransaction(async tx => {
      const current = await tx.get(marker); const record = current.data();
      if (!current.exists) return;
      if (!validReservation(record, marker.id, orderId) || record.key !== key) throw new Error('initial_cv_reservation_changed');
      tx.set(marker, { revokedAt: record.revokedAt || clock() }, { merge: true });
    });
    return cleanupExpiredInitialCvArtifacts({ db, bucket, orderRef, nowMs: clock(), writeId: marker.id });
  };

  return {
    async save(buffer, options = {}) {
      if (started) throw new Error('initial_cv_save_repeated');
      started = true;
      const admitted = await db.runTransaction(async tx => {
        const order = await tx.get(orderRef); const time = clock();
        if (!order.exists || !allowed(order.data(), time)) return false;
        const record = { purpose: PURPOSE, key, writeId: marker.id, state: 'uploading',
          createdAt: operationStartedAt, expiresAt };
        tx.set(marker, record); tx.set(orderRef, { artifactCleanupPending: true }, { merge: true });
        return true;
      });
      if (!admitted) return null;
      const upload = await uploadOwnedArtifact({ bucket, key, buffer, options, writeId: marker.id,
        acknowledged: () => db.runTransaction(async tx => {
          const [order, current] = await Promise.all([tx.get(orderRef), tx.get(marker)]);
          if (!order.exists || !validReservation(current.data(), marker.id, orderId)) throw new Error('initial_cv_reservation_changed');
          tx.set(marker, { state: 'uploaded', completedAt: clock() }, { merge: true });
          tx.set(orderRef, { artifactCleanupPending: true }, { merge: true });
        }) });
      if (!upload) { await abandon(); return null; }
      generation = upload.generation;
      const kept = await db.runTransaction(async tx => {
        const [order, current] = await Promise.all([tx.get(orderRef), tx.get(marker)]);
        const record = current.data(); const time = clock();
        if (!order.exists || !validReservation(record, marker.id, orderId) || record.key !== key) throw new Error('initial_cv_reservation_changed');
        if (record.revokedAt || !allowed(order.data(), time)) {
          tx.set(marker, { generation, revokedAt: record.revokedAt || time }, { merge: true }); return false;
        }
        tx.set(marker, { generation }, { merge: true }); return true;
      });
      if (!kept) { await abandon(); return null; }
      return key;
    },

    async publish(write) {
      if (typeof write !== 'function' || write.constructor?.name === 'AsyncFunction') throw new Error('initial_cv_publication_invalid');
      return db.runTransaction(async tx => {
        const [orderDoc, reservationDoc, pending] = await Promise.all([
          tx.get(orderRef), tx.get(marker), tx.get(manifests.limit(2)),
        ]);
        const order = orderDoc.data(); const reservation = reservationDoc.data(); const time = clock();
        if (!orderDoc.exists) return false;
        // An ACK-lost publication retry never repeats events or restarts the clock.
        if (!reservationDoc.exists) return generation !== null && samePublishedCv(order, key, time);
        if (!generation || !validReservation(reservation, marker.id, orderId) || reservation.key !== key
          || reservation.state !== 'uploaded' || reservation.generation !== generation || reservation.revokedAt
          || !allowed(order, time)) return false;
        const operations = []; let publication = false;
        const writes = { set(ref, patch, options) {
          if (operations.length >= 8 || !ref?.path || !patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('initial_cv_publication_invalid');
          const snapshot = publicationSnapshot(patch);
          if (ref.path === orderRef.path) {
            if (publication || Object.keys(snapshot).some(field => !ORDER_FIELDS.has(field)) || snapshot.cvStorageKey !== key
              || timestampMillis(snapshot.cvUploadedAt) !== time
              || (snapshot.submissionStatus != null && snapshot.submissionStatus !== order.submissionStatus
                && !(order.submissionStatus === 'awaiting_upload' && snapshot.submissionStatus === 'in_progress'))) throw new Error('initial_cv_publication_invalid');
            publication = true;
          } else if (!(ref.path === `${orderRef.path}/automation/intake`
            || (ref.path.startsWith(`${orderRef.path}/events/`) && ref.path.slice(`${orderRef.path}/events/`.length).length > 0
              && !ref.path.slice(`${orderRef.path}/events/`.length).includes('/')))) throw new Error('initial_cv_publication_invalid');
          // Both the key and its retention anchor must actually be committed.
          // A callback cannot replace the order or mask out cvUploadedAt.
          operations.push({ ref, patch: snapshot,
            options: ref.path === orderRef.path ? { merge: true } : publicationSnapshot(options) });
        } };
        const result = write(writes, { order: { ...order }, key, generation, writeId: marker.id, nowMs: time });
        if (isAsyncResult(result) || !publication) throw new Error('initial_cv_publication_invalid');
        if (!allowed(order, clock())) return false;
        for (const operation of operations) tx.set(operation.ref, operation.patch, operation.options);
        tx.delete(marker);
        tx.set(orderRef, { artifactCleanupPending: pending.docs.some(doc => doc.id !== marker.id) }, { merge: true });
        return true;
      });
    },
    abandon,
  };
}

/** Revoke only expired/embargoed first-upload operations, even for an order with no CV anchor. */
export async function cleanupExpiredInitialCvArtifacts({ db, bucket, orderRef, nowMs = Date.now(), writeId = null }) {
  if (!Number.isFinite(nowMs)) throw new Error('initial_cv_cleanup_clock_unknown');
  const manifests = orderRef.collection('pending_artifacts');
  const snapshot = writeId ? { docs: [await manifests.doc(writeId).get()] } : await manifests.get();
  for (const doc of snapshot.docs) {
    if (!doc.exists || doc.data()?.purpose !== PURPOSE) continue;
    const revoked = await db.runTransaction(async tx => {
      const [orderDoc, markerDoc] = await Promise.all([tx.get(orderRef), tx.get(doc.ref)]);
      const record = markerDoc.data(); const order = orderDoc.data();
      if (!markerDoc.exists) return null;
      if (!validReservation(record, doc.id, orderRef.id)) throw new Error('initial_cv_reservation_changed');
      const embargo = !orderDoc.exists || order.retentionPurgingAt != null || order.retentionPurgedAt != null || order.retentionPayloadPurgedAt != null;
      if (!embargo && !record.revokedAt && record.expiresAt > nowMs) return null;
      if (!embargo && samePublishedCv(order, record.key, nowMs)) { tx.delete(doc.ref); return null; }
      tx.set(doc.ref, { revokedAt: record.revokedAt || nowMs }, { merge: true }); return record;
    });
    if (!revoked) continue;
    const file = bucket.file(revoked.key); let metadata;
    try { [metadata] = await file.getMetadata(); }
    catch (error) {
      if (Number(error.code) !== 404) throw error;
      if (revoked.state === 'uploaded') await doc.ref.delete();
      continue;
    }
    const ownedGeneration = ownedArtifactGeneration(metadata, doc.id);
    if (!ownedGeneration) continue;
    await deleteOwnedArtifactGeneration(file, ownedGeneration);
    // An unacknowledged SDK retry may still commit: keep that reservation.
    if (revoked.state === 'uploaded') await doc.ref.delete();
  }
  const pending = await settlePendingArtifactFlag(db, orderRef, manifests);
  return { pending };
}
