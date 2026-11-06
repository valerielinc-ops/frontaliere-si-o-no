import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import { conciergeMaterialCopy, cleanupConciergeMaterialCopies } from '../functions/src/applicationConciergeMaterialCopy.js';
import { materialCopyFixture } from './helpers/conciergeMaterialCopyFixture.mjs';

const ROOT = 'application_concierge_services/service';
function operation(f: ReturnType<typeof materialCopyFixture>, extra = {}) {
  return conciergeMaterialCopy({ db: f.db, bucket: f.bucket, serviceId: 'service', proposalId: 'proposal',
    targetId: 'child', uid: 'candidate', source: f.service, proposal: f.proposal, purpose: 'proposal', now: () => f.clock, ...extra });
}
function publisher(f: ReturnType<typeof materialCopyFixture>) {
  return (tx: any, { key, targetId, writeId }: any) => {
    tx.set(f.ref(`${ROOT}/proposals/proposal`), { status: 'accepted', childApplicationId: targetId }, { merge: true });
    tx.set(f.ref(`assisted_applications/${targetId}`), { userId: 'candidate', parentServiceId: 'service', parentProposalId: 'proposal',
      cvStorageKey: key, cvMaterialCopyWriteId: writeId });
  };
}

describe('concierge material copies keep source-bound reservations through publication', () => {
  it('pins the source generation and publishes one create-only CV without a fabricated child order', async () => {
    const f = materialCopyFixture(), copy = operation(f);
    assert.equal(f.documents.has('assisted_applications/child'), false);
    const saved = await copy.save();
    assert.ok(saved);
    assert.equal(f.records().length, 1);
    assert.equal(f.documents.has('assisted_applications/child'), false);
    assert.equal(await copy.publish(publisher(f)), true);
    assert.equal(f.records().length, 0);
    assert.equal(f.documents.get('assisted_applications/child')!.cvStorageKey, saved.key);
    assert.equal(f.objects.has(f.sourceKey), true);
  });

  it('recognizes a committed publication after its ACK is lost and never deletes the linked CV', async () => {
    const f = materialCopyFixture(), copy = operation(f); const saved = await copy.save();
    let lost = false;
    f.hooks.afterCommit = async () => {
      if (!lost && f.documents.has('assisted_applications/child')) { lost = true; throw new Error('commit_ack_lost'); }
    };
    assert.equal(await copy.publish(publisher(f)), true);
    await copy.abandon();
    assert.equal(f.objects.has(saved!.key), true);
    assert.deepEqual(f.deleted, []);
  });

  it('recovers a save ACK loss only from the same write-id and source-byte digest', async () => {
    const f = materialCopyFixture(), copy = operation(f);
    f.hooks.afterSave = async () => { throw Object.assign(new Error('save_ack_lost'), { code: 412 }); };
    const saved = await copy.save();
    assert.ok(saved);
    assert.equal(await copy.publish(publisher(f)), true);
    assert.equal(f.objects.has(saved.key), true);
  });

  it('normalizes real Firestore Timestamps before source snapshots without rejecting unchanged data', async () => {
    const f = materialCopyFixture();
    f.service.cvUploadedAt = Timestamp.fromMillis(f.now - 1000) as any;
    f.service.consentedAt = Timestamp.fromMillis(f.now - 1000) as any;
    f.documents.set(ROOT, f.clone(f.service));
    const copy = operation(f);
    assert.ok(await copy.save());
    assert.equal(await copy.publish(publisher(f)), true);
  });

  it.each(['missing', 'purging', 'purged', 'payload_purged', 'refunded', 'expired', 'new_cv', 'declined', 'retarget', 'cap'])('does not publish when admission changes during save: %s', async change => {
    const f = materialCopyFixture(), copy = operation(f);
    f.hooks.afterSave = async () => {
      const current = f.documents.get(ROOT)!;
      if (change === 'missing') f.documents.delete(ROOT);
      if (change === 'purging') current.retentionPurgingAt = f.now;
      if (change === 'purged') current.retentionPurgedAt = f.now;
      if (change === 'payload_purged') current.retentionPayloadPurgedAt = f.now;
      if (change === 'refunded') current.paymentStatus = 'refunded';
      if (change === 'expired') current.expiresAt = new Date(f.now);
      if (change === 'new_cv') current.cvUploadedAt = Timestamp.fromMillis(f.now + 1);
      if (change === 'cap') current.acceptedPositionsCount = 10;
      if (change === 'declined') f.documents.get(`${ROOT}/proposals/proposal`)!.status = 'declined';
      if (change === 'retarget') f.documents.get(`${ROOT}/proposals/proposal`)!.jobId = 'other-job';
    };
    const saved = await copy.save(); assert.ok(saved);
    assert.equal(await copy.publish(publisher(f)), false);
    await copy.abandon();
    assert.equal(f.documents.has('assisted_applications/child'), false);
    assert.equal(f.objects.has(saved.key), false);
    assert.deepEqual(f.deleted, [saved.key]);
  });

  it('a second delivery never starts another uploader for an active reservation', async () => {
    const f = materialCopyFixture(), first = operation(f);
    let entered!: () => void, resume!: () => void;
    const blocked = new Promise<void>(resolve => { resume = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    f.hooks.beforeDownload = async () => { entered(); await blocked; };
    const saving = first.save(); await started;
    await assert.rejects(operation(f).save(), (error: any) => error.code === 'material_copy_in_progress');
    resume(); const saved = await saving;
    assert.equal(await first.publish(publisher(f)), true);
    assert.equal(f.writes.length, 1);
    assert.equal(f.objects.has(saved!.key), true);
  });

  it('an SDK failure does not poison a later delivery after the unknown operation lease expires', async () => {
    const f = materialCopyFixture(); let failed = false;
    f.hooks.beforeSave = async () => { if (!failed) { failed = true; throw Object.assign(new Error('invalid request'), { code: 400 }); } };
    await assert.rejects(operation(f).save(), (error: any) => error.code === 400);
    await assert.rejects(operation(f).save(), (error: any) => error.code === 'material_copy_in_progress');
    f.clock = f.now + 61_000;
    const retry = operation(f), saved = await retry.save();
    assert.ok(saved);
    assert.equal(await retry.publish(publisher(f)), true);
    assert.equal(f.writes.length, 1);
  });

  it('observes a rejected thenable returned by a synchronous publisher and rolls back writes', async () => {
    const f = materialCopyFixture(), copy = operation(f), saved = await copy.save();
    const unhandled: unknown[] = [], onUnhandled = (error: unknown) => unhandled.push(error);
    process.on('unhandledRejection', onUnhandled);
    try {
      await assert.rejects(copy.publish((tx: any) => {
        tx.set(f.ref('assisted_applications/child'), { cvStorageKey: saved!.key });
        return Promise.reject(new Error('publisher_rejected'));
      }), (error: any) => error.code === 'material_copy_publication_async');
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(unhandled, []);
      assert.equal(f.documents.has('assisted_applications/child'), false);
    } finally { process.off('unhandledRejection', onUnhandled); }
  });

  it('retains an owned ACK-lost marker after deleting its generation and cleans a late create', async () => {
    const f = materialCopyFixture(), copy = operation(f);
    f.hooks.afterSave = async () => { throw Object.assign(new Error('save_ack_lost'), { code: 412 }); };
    const saved = await copy.save(); assert.ok(saved);
    f.documents.get(ROOT)!.paymentStatus = 'refunded';
    assert.equal(await copy.publish(publisher(f)), false);
    await copy.abandon();
    assert.equal(f.objects.has(saved.key), false);
    assert.equal(f.records().length, 1);
    assert.equal(f.records()[0][1].sourceKey, undefined);
    f.objects.set(saved.key, { bytes: Buffer.from('late'), generation: '999', contentType: 'application/pdf', metadata: { retentionWriteId: saved.writeId } });
    await cleanupConciergeMaterialCopies({ db: f.db, bucket: f.bucket, nowMs: f.now + 61_000 });
    assert.equal(f.objects.has(saved.key), false);
    assert.equal(f.records().length, 1);
  });

  it('keeps an ACK-lost marker beyond publication without deleting the linked CV', async () => {
    const f = materialCopyFixture(), copy = operation(f);
    f.hooks.afterSave = async () => { throw new Error('save_ack_lost'); };
    const saved = await copy.save(); assert.ok(saved);
    assert.equal(await copy.publish(publisher(f)), true);
    await cleanupConciergeMaterialCopies({ db: f.db, bucket: f.bucket, nowMs: f.now + 61_000 });
    assert.equal(f.objects.has(saved.key), true);
    assert.equal(f.records().length, 1);
    assert.equal(f.records()[0][1].sourceKey, undefined);
    f.documents.delete('assisted_applications/child');
    await cleanupConciergeMaterialCopies({ db: f.db, bucket: f.bucket, nowMs: f.now + 122_000 });
    assert.equal(f.objects.has(saved.key), false);
    assert.equal(f.records().length, 1);
  });

  it('an expired reservation is replaced by a fresh operation without renewing its old lease', async () => {
    const f = materialCopyFixture(), original = operation(f), first = await original.save();
    const oldExpiry = f.records()[0][1].expiresAt;
    f.clock = f.now + 61_000;
    await cleanupConciergeMaterialCopies({ db: f.db, bucket: f.bucket, nowMs: f.clock });
    const retry = operation(f), next = await retry.save();
    assert.ok(next);
    assert.notEqual(next.writeId, first!.writeId);
    assert.notEqual(next.key, first!.key);
    assert.ok(f.records()[0][1].expiresAt > oldExpiry);
    assert.equal(await retry.publish(publisher(f)), true);
  });

  it('keeps the unknown uploader single-shot even if the same instance is called again', async () => {
    const f = materialCopyFixture(), copy = operation(f);
    f.hooks.afterSave = async ({ key, objects }: any) => { objects.delete(key); throw new Error('transport_unknown'); };
    await assert.rejects(copy.save());
    await assert.rejects(copy.save(), (error: any) => error.code === 'material_copy_save_repeated');
    await assert.rejects(operation(f).save(), (error: any) => error.code === 'material_copy_in_progress');
    assert.equal(f.writes.length, 1);
  });
  it('changing the source revision cannot start a second SDK while the old transport is unknown', async () => {
    const f = materialCopyFixture();
    f.hooks.afterSave = async ({ key, objects }: any) => { objects.delete(key); throw new Error('transport_unknown'); };
    await assert.rejects(operation(f).save());
    f.service.cvUploadedAt = new Date(f.now + 1);
    f.documents.set(ROOT, f.clone(f.service));
    await assert.rejects(operation(f).save(), (error: any) => error.code === 'material_copy_in_progress');
    assert.equal(f.writes.length, 1);
  });
  it('a new attempt revokes its expired predecessor without keeping the source path', async () => {
    const f = materialCopyFixture(), original = operation(f);
    f.hooks.afterSave = async ({ key, objects }: any) => { objects.delete(key); throw new Error('transport_unknown'); };
    await assert.rejects(original.save());
    const [path, old] = f.records()[0];
    f.clock = f.now + 61_000; f.hooks.afterSave = null;
    const retry = operation(f), saved = await retry.save();
    assert.ok(saved); assert.notEqual(saved.writeId, old.writeId);
    assert.equal(f.documents.get(path)!.sourceKey, undefined);
    assert.equal(f.documents.get(path)!.minimal, true);
    assert.equal(await retry.publish(publisher(f)), true);
  });

  it('keeps a transport-unknown upload revocable and cleans its late commit without source-path PII', async () => {
    const f = materialCopyFixture(), copy = operation(f);
    f.hooks.afterSave = async ({ key, objects }: any) => { objects.delete(key); throw new Error('transport_unknown'); };
    await assert.rejects(copy.save());
    const [path, record] = f.records()[0];
    f.clock = f.now + 61_000;
    await cleanupConciergeMaterialCopies({ db: f.db, bucket: f.bucket, nowMs: f.clock });
    const minimum = f.documents.get(path)!;
    assert.equal(minimum.sourceKey, undefined);
    assert.equal(minimum.minimal, true);
    f.objects.set(record.key, { bytes: Buffer.from('late'), generation: '999', contentType: 'application/pdf', metadata: { retentionWriteId: record.writeId } });
    await cleanupConciergeMaterialCopies({ db: f.db, bucket: f.bucket, nowMs: f.clock + 60_001 });
    assert.equal(f.objects.has(record.key), false);
    assert.equal(f.documents.has(path), true); // Unknown transports remain revisitable.
  });

  it('rotates bounded cleanup pages so unknown markers at the front cannot starve later services', async () => {
    const f = materialCopyFixture(), copy = operation(f);
    f.hooks.afterSave = async ({ key, objects }: any) => { objects.delete(key); throw new Error('transport_unknown'); };
    await assert.rejects(copy.save());
    const [original, record] = f.records()[0]; f.documents.delete(original);
    for (let i = 0; i < 55; i++) {
      const id = `marker-${String(i).padStart(3, '0')}`;
      f.documents.set(`${ROOT}/pending_material_copies/${id}`, { ...record, writeId: id,
        key: `assisted-application-uploads/child/copy-${id}.pdf` });
    }
    f.documents.get(ROOT)!.paymentStatus = 'refunded';
    const first = await cleanupConciergeMaterialCopies({ db: f.db, bucket: f.bucket, nowMs: f.now + 61_000 });
    const second = await cleanupConciergeMaterialCopies({ db: f.db, bucket: f.bucket, nowMs: f.now + 121_001 });
    assert.equal(first.scanned, 50); assert.equal(second.scanned, 5);
    assert.equal(f.records().every(([, value]) => value.minimal), true);
  });
});
