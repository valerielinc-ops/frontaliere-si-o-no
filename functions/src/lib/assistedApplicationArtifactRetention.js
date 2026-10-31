/** Private upload ownership ledger: a purge may finish before an in-flight save.
 * Unknown uploads remain revisitable; absence alone never means completion. */
import { randomUUID } from 'node:crypto';
import { assistedApplicationRetained } from './assistedApplicationRetentionPolicy.js';

export function artifactKeyForOrder(orderId, key) {
  const prefix = `assisted-application-uploads/${orderId}/`;
  return typeof key === 'string' && key.length <= 600 && key.startsWith(prefix) && /^[A-Za-z0-9._-]+$/.test(key.slice(prefix.length));
}

export async function settlePendingArtifactFlag(db, orderRef, collection) {
  return db.runTransaction(async transaction => {
    const [current, remaining] = await Promise.all([transaction.get(orderRef), transaction.get(collection.limit(1))]);
    if (!current.exists) throw new Error('artifact_cleanup_order_missing');
    const pending = Boolean(remaining.docs?.length);
    const finalizationDue = current.data()?.retentionPayloadPurgedAt != null && current.data()?.retentionPurgedAt == null;
    transaction.set(orderRef, { artifactCleanupPending: pending || finalizationDue }, { merge: true }); return pending;
  });
}

/** Shared create-only GCS write. An error never discards its caller's reservation. */
export async function uploadOwnedArtifact({ bucket, key, buffer, options = {}, writeId, acknowledged }) {
  const file = bucket.file(key);
  await file.save(buffer, { ...options, resumable: false, preconditionOpts: { ifGenerationMatch: 0 },
    metadata: { ...options.metadata, metadata: { ...options.metadata?.metadata, retentionWriteId: writeId } } });
  await acknowledged();
  let metadata;
  try { [metadata] = await file.getMetadata(); }
  catch (error) { if (Number(error.code) === 404) return null; throw error; }
  const generation = ownedArtifactGeneration(metadata, writeId);
  if (!generation) throw new Error('artifact_retention_generation_unknown');
  return { file, generation };
}

export function ownedArtifactGeneration(metadata, writeId) {
  return metadata?.metadata?.retentionWriteId === writeId && /^\d+$/.test(String(metadata.generation || ''))
    ? String(metadata.generation) : null;
}

export async function deleteOwnedArtifactGeneration(file, generation) {
  if (!/^\d+$/.test(String(generation || ''))) throw new Error('artifact_retention_generation_unknown');
  await file.delete({ ifGenerationMatch: String(generation), ignoreNotFound: true });
}

export function retainedArtifactStore({ db, bucket, orderId, round, dispatchAt = null, execution = null, now = Date.now }) {
  const orderRef = db.collection('assisted_applications').doc(orderId);
  const manifests = orderRef.collection('pending_artifacts'); const saved = new Map();
  const allowed = order => assistedApplicationRetained(order, now());
  return {
    async retained() { const snapshot = await orderRef.get(); return snapshot.exists && allowed(snapshot.data()); },
    savedArtifact(key) { const record = saved.get(key); return record ? Object.freeze({ ...record }) : null; },
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
      if (saved.has(key)) return await this.retained() ? saved.get(key).key : null;
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
      // Even a final 412 can follow a committed write whose ACK was lost.
      const upload = await uploadOwnedArtifact({ bucket, key, buffer, options, writeId: marker.id,
        acknowledged: () => db.runTransaction(async transaction => {
          const order = await transaction.get(orderRef);
          if (!order.exists) throw new Error('artifact_retention_order_missing');
          transaction.set(marker, { ...admitted, state: 'uploaded', completedAt: now() });
          transaction.set(orderRef, { artifactCleanupPending: true }, { merge: true });
        }) });
      if (!upload) { await marker.delete(); await settlePendingArtifactFlag(db, orderRef, manifests); return null; }
      const retained = await this.retained();
      if (!retained) await deleteOwnedArtifactGeneration(upload.file, upload.generation);
      await marker.delete();
      await settlePendingArtifactFlag(db, orderRef, manifests);
      if (!retained) return null;
      saved.set(key, { key, generation: upload.generation, writeId: marker.id }); return key;
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
    const generation = ownedArtifactGeneration(metadata, doc.id);
    if (!generation) continue;
    await deleteOwnedArtifactGeneration(file, generation);
    if (record.state === 'uploaded') await doc.ref.delete();
    // A transport-unknown writer may still retry its create-only request.
    // Keep its ownership marker even after deleting an observed generation.
  }
  const pending = await settlePendingArtifactFlag(db, orderRef, collection);
  return { pending };
}
