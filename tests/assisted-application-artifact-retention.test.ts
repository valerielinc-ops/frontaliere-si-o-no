import { describe, expect, it } from 'vitest';
import { createMemoryFirestore } from './helpers/memoryFirestore';
import { retainedArtifactStore, cleanupPendingArtifacts } from '../functions/src/lib/assistedApplicationArtifactRetention.js';
import { storeEvidence } from '../scripts/assisted-application/lib/secure-run.mjs';

const ID = 'artifact_retention_fixture'; const ROOT = `assisted_applications/${ID}`;
const KEY = `assisted-application-uploads/${ID}/sent.pdf`;
function fixture(beforeSave: () => Promise<void> = async () => {}) {
  const store = createMemoryFirestore({ [ROOT]: { cvUploadedAt: 10 }, [`${ROOT}/ai_drafts/current`]: { round: 1 } });
  const objects = new Map<string, any>(); const deleted: string[] = []; let generation = 0;
  const bucket = { file: (key: string) => ({
    async save(_buffer: unknown, options: any) {
      await beforeSave();
      if (objects.has(key) && options.preconditionOpts.ifGenerationMatch === 0) throw Object.assign(new Error('exists'), { code: 412 });
      objects.set(key, { generation: String(++generation), metadata: options.metadata.metadata });
    },
    async getMetadata() { if (!objects.has(key)) throw Object.assign(new Error('missing'), { code: 404 }); return [objects.get(key)]; },
    async delete(options: any) {
      if (!objects.has(key)) return;
      if (options.ifGenerationMatch !== objects.get(key).generation) throw Object.assign(new Error('changed'), { code: 412 });
      deleted.push(key); objects.delete(key);
    },
  }) };
  const orderRef = store.db.collection('assisted_applications').doc(ID);
  const actor = retainedArtifactStore({ db: store.db, bucket, orderId: ID, round: 1, now: () => 100 });
  return { store, bucket, objects, deleted, orderRef, actor };
}

describe('post-send artifact retention', () => {
  it('rechecks expiry after an awaited execution fence and before reserving an upload', async () => {
    const data = fixture(); const dueAt = 10 + 90 * 24 * 60 * 60_000; let now = dueAt - 1;
    const actor = retainedArtifactStore({ db: data.store.db, bucket: data.bucket, orderId: ID, round: 1,
      now: () => now, execution: { async assertOutcomeInTransaction() { now = dueAt + 1; return { execution: { id: 'fixture', generation: 1 } }; } } });
    await expect(actor.save(KEY, Buffer.from('synthetic'))).resolves.toBeNull();
    expect(data.objects.size).toBe(0); expect(data.store.list(`${ROOT}/pending_artifacts/`)).toEqual([]);
  });
  it('deletes its own uploaded generation if the purge overtakes the upload', async () => {
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const data = fixture(() => gate); const saving = data.actor.save(KEY, Buffer.from('synthetic'));
    await new Promise(resolve => setTimeout(resolve, 0));
    data.store.read(ROOT)!.retentionPurgingAt = 101;
    await expect(cleanupPendingArtifacts({ ...data, db: data.store.db })).resolves.toEqual({ pending: true });
    release(); await expect(saving).resolves.toBeNull();
    expect(data.objects.size).toBe(0); expect(data.deleted).toEqual([KEY]);
    expect(data.store.list(`${ROOT}/pending_artifacts/`)).toEqual([]);
    expect(data.store.read(ROOT)!.artifactCleanupPending).toBe(false);
  });
  it('refuses a new upload and a draft recreation once the purge embargo exists', async () => {
    const data = fixture(); data.store.read(ROOT)!.retentionPurgingAt = 101;
    const draft = data.orderRef.collection('ai_drafts').doc('current'); await draft.delete();
    await expect(data.actor.save(KEY, Buffer.from('synthetic'))).resolves.toBeNull();
    await expect(data.actor.mergeDraft(draft, { sent: { files: ['private'] } })).resolves.toBe(false);
    await expect(data.actor.mergeDraft(draft, { questions: [{ id: 'legacy', question: 'synthetic private question' }] })).resolves.toBe(false);
    expect(data.objects.size).toBe(0); expect(data.store.read(`${ROOT}/ai_drafts/current`)).toBeUndefined();
  });
  it('never calls a transport-unknown upload complete merely because its object is absent', async () => {
    const data = fixture(async () => { throw Object.assign(new Error('connection lost'), { code: 'ECONNRESET' }); });
    await expect(data.actor.save(KEY, Buffer.from('synthetic'))).rejects.toThrow('connection lost');
    data.store.read(ROOT)!.retentionPurgingAt = 101; data.store.read(ROOT)!.retentionPurgedAt = 102;
    await expect(cleanupPendingArtifacts({ ...data, db: data.store.db })).resolves.toEqual({ pending: true });
    expect(data.store.list(`${ROOT}/pending_artifacts/`)).toHaveLength(1);
    expect(data.store.read(ROOT)!.artifactCleanupPending).toBe(true);
  });
  it('keeps the marker when an SDK retry ends with 412 after the first attempt committed', async () => {
    const data = fixture();
    const bucket = { file: (key: string) => {
      const file = data.bucket.file(key);
      return { ...file, async save(bytes: unknown, options: any) { await file.save(bytes, options); throw Object.assign(new Error('retry precondition'), { code: 412 }); } };
    } };
    const actor = retainedArtifactStore({ db: data.store.db, bucket, orderId: ID, round: 1, now: () => 100 });
    await expect(actor.save(KEY, Buffer.from('synthetic'))).rejects.toThrow('retry precondition');
    expect(data.objects.size).toBe(1); expect(data.store.list(`${ROOT}/pending_artifacts/`)).toHaveLength(1);
    data.store.read(ROOT)!.retentionPurgingAt = 101;
    await expect(cleanupPendingArtifacts({ db: data.store.db, bucket, orderRef: data.orderRef })).resolves.toEqual({ pending: true });
    expect(data.objects.size).toBe(0); expect(data.store.read(ROOT)!.artifactCleanupPending).toBe(true);
  });
  it('does not recreate encrypted evidence after the embargo', async () => {
    const data = fixture(); data.store.read(ROOT)!.retentionPurgingAt = 101;
    await expect(storeEvidence({ bucket: data.bucket, orderId: ID, name: 'runner-boot-failed', payload: { private: 'synthetic' },
      key: Buffer.alloc(32, 7), nowMs: 100, artifactStore: data.actor })).resolves.toBeNull();
    expect(data.objects.size).toBe(0); expect(data.store.list(`${ROOT}/pending_artifacts/`)).toEqual([]);
  });
  it('rejects an object outside the order namespace before any upload or manifest', async () => {
    const data = fixture();
    await expect(data.actor.save(`assisted-application-uploads/${ID}/../another.pdf`, Buffer.from('synthetic'))).rejects.toThrow('artifact_retention_key_invalid');
    expect(data.objects.size).toBe(0); expect(data.store.list(`${ROOT}/pending_artifacts/`)).toEqual([]);
  });
});
