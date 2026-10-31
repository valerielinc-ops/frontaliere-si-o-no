import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { createMemoryFirestore } from './helpers/memoryFirestore';
import { initialCvArtifactStore, cleanupExpiredInitialCvArtifacts } from '../functions/src/lib/assistedApplicationInitialCvIngress.js';
import { retainedArtifactStore } from '../functions/src/lib/assistedApplicationArtifactRetention.js';

const ID = 'initial_cv_fixture';
const ROOT = `assisted_applications/${ID}`;
const KEY = `assisted-application-uploads/${ID}/new-cv.pdf`;
const NOW = 100_000;

function fixture(extra: Record<string, unknown> = {}, beforeSave: () => Promise<void> = async () => {}) {
  let clock = NOW;
  let generation = 0;
  const store = createMemoryFirestore({ [ROOT]: { paymentStatus: 'paid', submissionStatus: 'awaiting_upload', ...extra } });
  const objects = new Map<string, any>();
  const deleted: string[] = [];
  const bucket = { file: (key: string) => ({
    async save(bytes: unknown, options: any) {
      await beforeSave();
      if (objects.has(key)) throw Object.assign(new Error('exists'), { code: 412 });
      assert.equal(options.preconditionOpts.ifGenerationMatch, 0);
      objects.set(key, { bytes, generation: String(++generation), metadata: options.metadata.metadata });
    },
    async getMetadata() {
      const object = objects.get(key);
      if (!object) throw Object.assign(new Error('missing'), { code: 404 });
      return [{ generation: object.generation, metadata: object.metadata }];
    },
    async delete(options: any) {
      const object = objects.get(key);
      if (object && object.generation !== options.ifGenerationMatch) throw Object.assign(new Error('foreign generation'), { code: 412 });
      objects.delete(key);
      deleted.push(key);
    },
  }) };
  const orderRef = store.db.collection('assisted_applications').doc(ID);
  const actor = initialCvArtifactStore({ db: store.db, bucket, orderId: ID, key: KEY,
    uploaderAllows: (order: any) => order.submissionStatus === 'awaiting_upload', operationStartedAt: NOW, now: () => clock });
  return { store, objects, deleted, bucket, orderRef, actor,
    get clock() { return clock; }, set clock(value: number) { clock = value; },
    marker: () => store.list(`${ROOT}/pending_artifacts/`)[0],
  };
}

type Fixture = ReturnType<typeof fixture>;
const publisher = (data: Fixture) => (tx: any, context: any) => {
  // A number survives the memory Firestore's structuredClone; production callers
  // use Timestamp.fromMillis(context.nowMs), accepted by the same canonical parser.
  tx.set(data.orderRef, { cvStorageKey: context.key, cvUploadedAt: context.nowMs,
    cvUploadedBy: 'verified-upload', submissionStatus: 'in_progress' }, { merge: true });
  tx.set(data.orderRef.collection('events').doc('publication'), { type: 'materials_received' });
};
const cleanup = (data: Fixture) => cleanupExpiredInitialCvArtifacts({
  db: data.store.db, bucket: data.bucket, orderRef: data.orderRef, nowMs: data.clock,
});

describe('first-CV upload reservations', () => {
  it('accepts existing authenticated upload authority before employer consent and publishes exactly once', async () => {
    const data = fixture();
    assert.equal(await data.actor.save(Buffer.from('synthetic CV')), KEY);
    assert.equal(data.store.read(ROOT)!.cvUploadedAt, undefined);
    assert.equal(data.store.read(data.marker())!.state, 'uploaded');
    assert.equal(data.store.read(ROOT)!.artifactCleanupPending, true);
    assert.equal(await data.actor.publish(publisher(data)), true);
    assert.equal(data.store.read(ROOT)!.cvStorageKey, KEY);
    assert.equal(data.store.list(`${ROOT}/pending_artifacts/`).length, 0);
    assert.equal(data.store.read(ROOT)!.artifactCleanupPending, false);
    assert.equal(await data.actor.publish(() => { throw new Error('duplicate publication'); }), true);
    assert.equal(data.store.list(`${ROOT}/events/`).length, 1);
  });

  it('cleans an acknowledged but unpublished CV after a crash without an order retention anchor', async () => {
    const data = fixture();
    await data.actor.save(Buffer.from('synthetic'));
    data.clock = NOW + 60_001;
    await cleanup(data);
    assert.equal(data.objects.size, 0);
    assert.equal(data.store.list(`${ROOT}/pending_artifacts/`).length, 0);
    assert.equal(data.store.read(ROOT)!.retentionPurgingAt, undefined);
    assert.equal(await data.actor.publish(publisher(data)), false);
  });

  it('does not publish or start the CV clock when the operation expires during the upload', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const data = fixture({}, () => gate);
    const saving = data.actor.save(Buffer.from('synthetic'));
    await new Promise(resolve => setTimeout(resolve, 0));
    data.clock = NOW + 60_001;
    release();
    assert.equal(await saving, null);
    assert.equal(data.objects.size, 0);
    assert.equal(data.store.read(ROOT)!.cvUploadedAt, undefined);
    assert.equal(data.store.read(ROOT)!.retentionPurgingAt, undefined);
  });

  it('rejects existing raw anchors, a CV, refunds and every purge tombstone before creating a reservation', async () => {
    for (const patch of [{ cvUploadedAt: 0 }, { submittedAt: 0 }, { refundedAt: 0 }, { refundStatus: 'pending' },
      { refundStatus: 'completed' }, { cvStorageKey: 'existing' }, { retentionPurgingAt: 1 }, { retentionPurgedAt: 1 },
      { retentionPayloadPurgedAt: 1, talentPoolConsent: true }, { paymentStatus: 'refunded' }]) {
      const data = fixture(patch);
      assert.equal(await data.actor.save(Buffer.from('synthetic')), null);
      assert.equal(data.objects.size, 0);
      assert.equal(data.store.list(`${ROOT}/pending_artifacts/`).length, 0);
    }
  });

  it('does not treat an asynchronous uploader predicate as verified authority', async () => {
    const data = fixture();
    const actor = initialCvArtifactStore({ db: data.store.db, bucket: data.bucket, orderId: ID, key: KEY,
      uploaderAllows: () => Promise.resolve(true), operationStartedAt: NOW, now: () => NOW });
    assert.equal(await actor.save(Buffer.from('synthetic')), null);
    assert.equal(data.objects.size, 0);
  });

  it('consumes rejected asynchronous callback results while refusing their authority', async () => {
    const data = fixture();
    const actor = initialCvArtifactStore({ db: data.store.db, bucket: data.bucket, orderId: ID, key: KEY,
      uploaderAllows: () => Promise.reject(new Error('not synchronous')), operationStartedAt: NOW, now: () => NOW });
    assert.equal(await actor.save(Buffer.from('synthetic')), null);
    await data.actor.save(Buffer.from('synthetic'));
    await assert.rejects(data.actor.publish(() => Promise.reject(new Error('not synchronous'))), /initial_cv_publication_invalid/);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(data.store.read(ROOT)!.cvUploadedAt, undefined);
  });

  it('forces an atomic order merge even if a callback supplies overwrite or a field mask', async () => {
    for (const options of [undefined, { merge: false }, { mergeFields: ['cvStorageKey'] }]) {
      const data = fixture({ userId: 'private-owner', consent: { employerHandoff: false } });
      await data.actor.save(Buffer.from('synthetic'));
      assert.equal(await data.actor.publish((tx: any, context: any) => {
        tx.set(data.orderRef, { cvStorageKey: context.key, cvUploadedAt: context.nowMs }, options);
      }), true);
      assert.equal(data.store.read(ROOT)!.cvStorageKey, KEY);
      assert.equal(typeof data.store.read(ROOT)!.cvUploadedAt, 'number');
      assert.equal(data.store.read(ROOT)!.paymentStatus, 'paid');
      assert.equal(data.store.read(ROOT)!.userId, 'private-owner');
      assert.deepEqual(data.store.read(ROOT)!.consent, { employerHandoff: false });
    }
  });

  it('snapshots a validated publication before the callback mutates its original patch', async () => {
    const data = fixture({ userId: 'private-owner' });
    await data.actor.save(Buffer.from('synthetic'));
    assert.equal(await data.actor.publish((tx: any, context: any) => {
      const patch: any = { cvStorageKey: context.key, cvUploadedAt: context.nowMs };
      tx.set(data.orderRef, patch);
      patch.cvStorageKey = 'foreign-key';
      patch.cvUploadedAt = 0;
      patch.userId = 'foreign-owner';
    }), true);
    assert.equal(data.store.read(ROOT)!.cvStorageKey, KEY);
    assert.notEqual(data.store.read(ROOT)!.cvUploadedAt, 0);
    assert.equal(data.store.read(ROOT)!.userId, 'private-owner');
  });

  it('respects an embargo between storage and publication and deletes only its generation', async () => {
    const data = fixture();
    await data.actor.save(Buffer.from('synthetic'));
    data.store.read(ROOT)!.retentionPurgingAt = NOW + 1;
    assert.equal(await data.actor.publish(publisher(data)), false);
    await data.actor.abandon();
    assert.equal(data.objects.size, 0);
    assert.equal(data.store.read(ROOT)!.cvUploadedAt, undefined);
  });

  it('preserves a competing CV publication', async () => {
    const data = fixture();
    await data.actor.save(Buffer.from('synthetic'));
    data.store.read(ROOT)!.cvStorageKey = 'other-CV';
    assert.equal(await data.actor.publish(publisher(data)), false);
    await data.actor.abandon();
    assert.equal(data.store.read(ROOT)!.cvStorageKey, 'other-CV');
    assert.equal(data.objects.size, 0);
  });

  it('exposes no draft publication or asynchronous write capability', async () => {
    const data = fixture();
    await data.actor.save(Buffer.from('synthetic'));
    await assert.rejects(data.actor.publish((tx: any) => {
      tx.set(data.orderRef.collection('ai_drafts').doc('current'), { private: 'forbidden' });
    }), /initial_cv_publication_invalid/);
    assert.equal(data.store.read(`${ROOT}/ai_drafts/current`), undefined);
    assert.equal(data.store.read(ROOT)!.cvUploadedAt, undefined);
    await assert.rejects(data.actor.publish(async () => {}), /initial_cv_publication_invalid/);
  });

  it('keeps an unknown manifest when an upload commits and its SDK retry fails with 412', async () => {
    const data = fixture();
    const fileFor = data.bucket.file.bind(data.bucket);
    data.bucket.file = key => {
      const file = fileFor(key);
      return { ...file, async save(bytes: unknown, options: any) {
        await file.save(bytes, options);
        throw Object.assign(new Error('ACK lost then retry412'), { code: 412 });
      } };
    };
    await assert.rejects(data.actor.save(Buffer.from('synthetic')), /ACK lost/);
    assert.equal(data.store.read(data.marker())!.state, 'uploading');
    data.clock = NOW + 60_001;
    await cleanup(data);
    assert.equal(data.objects.size, 0);
    assert.equal(data.store.list(`${ROOT}/pending_artifacts/`).length, 1);
    assert.equal(data.store.read(ROOT)!.artifactCleanupPending, true);
    // A request with an unknown outcome can commit again after the sweep.
    const marker = data.store.read(data.marker())!;
    data.objects.set(KEY, { generation: '99', metadata: { retentionWriteId: marker.writeId } });
    await cleanup(data);
    assert.equal(data.objects.size, 0);
    assert.equal(data.store.list(`${ROOT}/pending_artifacts/`).length, 1);
  });

  it('keeps a foreign object and an unresolved reservation instead of deleting another writer', async () => {
    const data = fixture();
    await data.actor.save(Buffer.from('synthetic'));
    data.objects.get(KEY).metadata.retentionWriteId = 'foreign-write';
    data.clock = NOW + 60_001;
    await cleanup(data);
    assert.equal(data.objects.size, 1);
    assert.equal(data.deleted.length, 0);
    assert.equal(data.store.read(ROOT)!.artifactCleanupPending, true);
  });

  it('checks the operation deadline after the last publication read', async () => {
    const data = fixture();
    await data.actor.save(Buffer.from('synthetic'));
    const run = data.store.db.runTransaction.bind(data.store.db);
    data.store.db.runTransaction = fn => run(tx => fn({ ...tx, async get(ref: any) {
      const snapshot = await tx.get(ref);
      if (ref.path === data.marker()) data.clock = NOW + 60_001;
      return snapshot;
    } }));
    assert.equal(await data.actor.publish(publisher(data)), false);
    assert.equal(data.store.read(ROOT)!.cvUploadedAt, undefined);
  });

  it('does not commit buffered publication writes if synchronous bookkeeping crosses the operation deadline', async () => {
    const data = fixture();
    await data.actor.save(Buffer.from('synthetic'));
    assert.equal(await data.actor.publish((tx: any, context: any) => {
      publisher(data)(tx, context);
      data.clock = NOW + 60_001;
    }), false);
    assert.equal(data.store.read(ROOT)!.cvUploadedAt, undefined);
    assert.equal(data.store.list(`${ROOT}/events/`).length, 0);
  });

  it('does not delete a published CV if the publication transaction commits but its ACK is lost', async () => {
    const data = fixture();
    await data.actor.save(Buffer.from('synthetic'));
    const run = data.store.db.runTransaction.bind(data.store.db);
    let dropped = false;
    data.store.db.runTransaction = async fn => {
      const result = await run(fn);
      if (!dropped && data.store.read(ROOT)!.cvStorageKey === KEY) {
        dropped = true;
        throw new Error('publication ACK unknown');
      }
      return result;
    };
    await assert.rejects(data.actor.publish(publisher(data)), /publication ACK unknown/);
    await data.actor.abandon();
    assert.equal(data.objects.size, 1);
    assert.equal(data.deleted.length, 0);
    assert.equal(data.store.read(ROOT)!.cvStorageKey, KEY);
    assert.equal(data.store.list(`${ROOT}/events/`).length, 1);
  });

  it('preserves retained save API and exposes only its own immutable generation witness', async () => {
    const data = fixture({ cvUploadedAt: NOW - 10, submissionStatus: 'in_progress' });
    const retained = retainedArtifactStore({ db: data.store.db, bucket: data.bucket, orderId: ID, round: 1, now: () => data.clock });
    assert.equal(retained.savedArtifact(KEY), null);
    assert.equal(await retained.save(KEY, Buffer.from('synthetic')), KEY);
    const owned = retained.savedArtifact(KEY);
    assert(owned && Object.isFrozen(owned));
    assert.equal(owned.generation, data.objects.get(KEY).generation);
    assert.equal(owned.writeId, data.objects.get(KEY).metadata.retentionWriteId);
    assert.equal(await retained.save(KEY, Buffer.from('cached')), KEY);
    assert.equal(data.objects.size, 1);
  });
});
