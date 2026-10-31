/** Private upload ownership ledger: a purge may finish before an in-flight save.
 * Unknown uploads remain revisitable; absence alone never means completion. */
import { randomUUID } from 'node:crypto';
import { assistedApplicationRetained } from './assistedApplicationRetentionPolicy.js';

export function artifactKeyForOrder(orderId, key) {
  const prefix = `assisted-application-uploads/${orderId}/`;
  return typeof key === 'string' && key.length <= 600 && key.startsWith(prefix) && /^[A-Za-z0-9._-]+$/.test(key.slice(prefix.length));
}

async function settlePendingFlag(db, orderRef, collection) {
  return db.runTransaction(async transaction => {
    const [current, remaining] = await Promise.all([transaction.get(orderRef), transaction.get(collection.limit(1))]);
    if (!current.exists) throw new Error('artifact_cleanup_order_missing');
    const pending = Boolean(remaining.docs?.length);
    const finalizationDue = current.data()?.retentionPayloadPurgedAt != null && current.data()?.retentionPurgedAt == null;
    transaction.set(orderRef, { artifactCleanupPending: pending || finalizationDue }, { merge: true }); return pending;
  });
}

export function retainedArtifactStore({ db, bucket, orderId, round, dispatchAt = null, execution = null, now = Date.now }) {
  const orderRef = db.collection('assisted_applications').doc(orderId);
  const manifests = orderRef.collection('pending_artifacts'); const saved = new Map();
  const allowed = order => assistedApplicationRetained(order, now());
  return {
    async retained() { const snapshot = await orderRef.get(); return snapshot.exists && allowed(snapshot.data()); },
    async mergeOrder(patch) {
      return db.runTransaction(async transaction => {
        const [order, flow] = await Promise.all([transaction.get(orderRef), transaction.get(orderRef.collection('automation').doc('flow'))]);
        if (!order.exists || !allowed(order.data()) || Number(flow.data()?.round) !== Number(round)) return false;
        transaction.set(orderRef, patch, { merge: true }); return true;
      });
    },
    async mergeDraft(ref, patch) {
      return db.runTransaction(async transaction => {
        const [order, draft] = await Promise.all([transaction.get(orderRef), transaction.get(ref)]);
        if (!order.exists || !allowed(order.data()) || !draft.exists || Number(draft.data()?.round) !== Number(round)) return false;
        transaction.set(ref, patch, { merge: true }); return true;
      });
    },
    async writeDraft(ref, draft) {
      return db.runTransaction(async transaction => {
        const [order, flow] = await Promise.all([transaction.get(orderRef), transaction.get(orderRef.collection('automation').doc('flow'))]);
        if (!order.exists || !allowed(order.data()) || Number(flow.data()?.round) !== Number(round)
          || !['drafting', 'regenerating'].includes(flow.data()?.state)
          || (dispatchAt && Number(flow.data()?.dispatch?.requestedAt) !== Number(dispatchAt))) return false;
        transaction.set(ref, draft); return true;
      });
    },
    async save(key, buffer, options = {}) {
      if (!artifactKeyForOrder(orderId, key)) throw new Error('artifact_retention_key_invalid');
      if (saved.has(key)) return await this.retained() ? saved.get(key) : null;
      const marker = manifests.doc(randomUUID());
      const admitted = await db.runTransaction(async transaction => {
        const order = await transaction.get(orderRef);
        if (!order.exists) return false;
        const context = execution ? await execution.assertOutcomeInTransaction(transaction) : null;
        // Any optional execution read can consume time. Evaluate the deadline
        // after the final await and before reserving an upload.
        if (!allowed(order.data())) return false;
        const record = { key, writeId: marker.id, state: 'uploading', createdAt: now(),
          executionId: context?.execution.id || null, generation: context?.execution.generation || null };
        transaction.set(marker, record);
        transaction.set(orderRef, { artifactCleanupPending: true }, { merge: true }); return record;
      });
      if (!admitted) return null;
      const file = bucket.file(key);
      // Even a final 412 can follow a committed write whose ACK was lost:
      // the SDK retries create-only uploads. Every failure keeps its marker.
      await file.save(buffer, { ...options, resumable: false, preconditionOpts: { ifGenerationMatch: 0 },
        metadata: { ...options.metadata, metadata: { ...options.metadata?.metadata, retentionWriteId: marker.id } } });
      await db.runTransaction(async transaction => {
        const order = await transaction.get(orderRef);
        if (!order.exists) throw new Error('artifact_retention_order_missing');
        transaction.set(marker, { ...admitted, state: 'uploaded', completedAt: now() });
        transaction.set(orderRef, { artifactCleanupPending: true }, { merge: true });
      });
      let metadata;
      try { [metadata] = await file.getMetadata(); }
      catch (error) { if (Number(error.code) === 404) { await marker.delete(); await settlePendingFlag(db, orderRef, manifests); return null; } throw error; }
      if (metadata.metadata?.retentionWriteId !== marker.id || !/^\d+$/.test(String(metadata.generation || ''))) throw new Error('artifact_retention_generation_unknown');
      const retained = await this.retained();
      if (!retained) await file.delete({ ifGenerationMatch: metadata.generation, ignoreNotFound: true });
      await marker.delete();
      await settlePendingFlag(db, orderRef, manifests);
      if (!retained) return null;
      saved.set(key, key); return key;
    },
  };
}

/** Only called under an already persisted purge embargo. No payload is read. */
export async function cleanupPendingArtifacts({ db, bucket, orderRef }) {
  if (typeof orderRef.collection !== 'function') return { pending: false };
  const order = (await orderRef.get()).data();
  if (!order?.retentionPurgingAt && !order?.retentionPurgedAt) throw new Error('artifact_cleanup_embargo_missing');
  const collection = orderRef.collection('pending_artifacts'); const snapshot = await collection.get();
  for (const doc of snapshot.docs || []) {
    const record = doc.data();
    if (record.writeId !== doc.id || !artifactKeyForOrder(orderRef.id, record.key)) throw new Error('artifact_cleanup_ownership_unknown');
    const file = bucket.file(record.key); let metadata;
    try { [metadata] = await file.getMetadata(); }
    catch (error) {
      if (Number(error.code) !== 404) throw error;
      if (record.state === 'uploaded') await doc.ref.delete();
      continue; // An unacknowledged upload can still commit after this sweep.
    }
    if (metadata.metadata?.retentionWriteId !== doc.id || !/^\d+$/.test(String(metadata.generation || ''))) continue;
    await file.delete({ ifGenerationMatch: metadata.generation, ignoreNotFound: true });
    if (record.state === 'uploaded') await doc.ref.delete();
    // A transport-unknown writer may still retry its create-only request.
    // Keep its ownership marker even after deleting an observed generation.
  }
  const pending = await settlePendingFlag(db, orderRef, collection);
  return { pending };
}
