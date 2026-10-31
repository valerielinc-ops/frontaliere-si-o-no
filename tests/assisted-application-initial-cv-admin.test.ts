import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import {
  INITIAL_CV_BASE as BASE, INITIAL_CV_ORDER as ORDER, INITIAL_CV_PDF as PDF,
  initialCvBucket, initialCvDatabase,
} from './helpers/initialCvCallersFixture.mjs';

const runtime = vi.hoisted(() => ({ db: null as any, bucket: null as any, verifyIdToken: vi.fn(), audit: vi.fn(async () => {}) }));
vi.mock('firebase-admin/auth', () => ({ getAuth: () => ({ verifyIdToken: runtime.verifyIdToken }) }));
vi.mock('firebase-admin/storage', () => ({ getStorage: () => ({ bucket: () => runtime.bucket }) }));
vi.mock('../functions/src/newsletterResendWebhookCore.js', () => ({ getAdminDb: () => runtime.db, ensureAdminApp: () => {} }));
vi.mock('../functions/src/adminAudit.js', () => ({ writeAdminAuditLog: runtime.audit }));
vi.mock('../functions/src/publisherApplicationsCore.js', () => ({ resolveCvLink: async () => null }));
vi.mock('../functions/src/stripePublisherCore.js', () => ({
  db: () => runtime.db, verifyCaller: async () => null, getStripe: () => { throw new Error('unexpected_payment'); },
}));
vi.mock('../functions/src/githubProxy.js', () => ({
  GITHUB_API: 'https://example.invalid/', getRepoConfig: async () => { throw new Error('unexpected_github'); },
}));

const { SITE_ADMIN_EMAILS, SITE_ADMIN_UIDS } = await import('../functions/src/adminAuth.js');
const { handleAssistedApplicationAdmin } = await import('../functions/src/assistedApplicationAdminCore.js');

const request = (extra: Record<string, any> = {}) => ({ method: 'POST',
  get: (name: string) => name === 'Authorization' ? 'Bearer fixture-id-token' : undefined,
  body: { action: 'uploadCv', orderId: ORDER, fileName: 'cv.pdf', contentBase64: PDF.toString('base64') }, ...extra,
});

function setup(order: Record<string, any> = {}) {
  const database = initialCvDatabase(order);
  const bucket = initialCvBucket();
  runtime.db = database.db;
  runtime.bucket = bucket;
  return { database, bucket };
}

beforeEach(() => {
  runtime.verifyIdToken.mockReset();
  runtime.verifyIdToken.mockResolvedValue({ uid: SITE_ADMIN_UIDS[0], email: SITE_ADMIN_EMAILS[0], email_verified: true });
  runtime.audit.mockClear();
});
afterEach(() => { vi.useRealTimers(); });

describe('first CV owner ingress uses existing role checks', () => {
  it('receives the first CV without consentV2 or a fabricated retention anchor', async () => {
    const { database, bucket } = setup();
    const result = await handleAssistedApplicationAdmin(request());
    assert.equal(result.status, 200);
    const order = database.read(BASE);
    assert.ok(bucket.files.has(order.cvStorageKey));
    assert.equal(order.cvUploadedBy, 'owner');
    assert.equal(order.submissionStatus, 'in_progress');
    assert.ok(order.cvUploadedAt.toMillis() > 0);
    assert.equal(order.consentVersion, undefined);
    assert.equal(database.list(`${BASE}/events/`).length, 2);
    assert.equal(runtime.audit.mock.calls.length, 1);
  });

  for (const [name, claims] of [
    ['non-owner email', { uid: SITE_ADMIN_UIDS[0], email: 'different@example.test', email_verified: true }],
    ['non-owner UID', { uid: 'not-owner', email: SITE_ADMIN_EMAILS[0], email_verified: true }],
    ['unverified owner email', { uid: SITE_ADMIN_UIDS[0], email: SITE_ADMIN_EMAILS[0], email_verified: false }],
  ]) {
    it(`denies ${name} before receiving or storing a CV`, async () => {
      const { database, bucket } = setup();
      runtime.verifyIdToken.mockResolvedValue(claims);
      const result = await handleAssistedApplicationAdmin(request());
      assert.equal(result.status, 403);
      assert.equal(database.read(BASE).cvStorageKey, undefined);
      assert.equal(bucket.files.size, 0);
      assert.equal(database.list(`${BASE}/pending_artifacts/`).length, 0);
      assert.equal(runtime.audit.mock.calls.length, 0);
    });
  }

  it('denies a missing bearer token without accepting a body-supplied ingress mode', async () => {
    const { database, bucket } = setup();
    const result = await handleAssistedApplicationAdmin(request({ get: () => undefined,
      body: { ...request().body, initialCv: true, mode: 'initial_cv', owner: true } }));
    assert.equal(result.status, 401);
    assert.equal(runtime.verifyIdToken.mock.calls.length, 0);
    assert.equal(database.read(BASE).cvStorageKey, undefined);
    assert.equal(bucket.files.size, 0);
  });

  for (const order of [
    { paymentStatus: 'pending' }, { submissionStatus: 'cancelled' }, { refundStatus: 'pending' },
    { cvUploadedAt: Date.now() - 1000 }, { submittedAt: Date.now() - 1000 },
    { retentionPurgingAt: Date.now() }, { retentionPurgedAt: Date.now() }, { retentionPayloadPurgedAt: Date.now() },
  ]) {
    it(`does not grant initial receipt for ${Object.keys(order)[0]} on the fresh order`, async () => {
      const { database, bucket } = setup(order);
      const result = await handleAssistedApplicationAdmin(request());
      assert.equal(result.status, 409);
      assert.equal(database.read(BASE).cvStorageKey, undefined);
      assert.equal(bucket.files.size, 0);
      assert.equal(database.list(`${BASE}/events/`).length, 0);
    });
  }

  for (const patch of [
    { paymentStatus: 'refunded' }, { refundStatus: 'pending' }, { submissionStatus: 'cancelled' },
    { retentionPurgingAt: Date.now() }, { retentionPurgedAt: Date.now() }, { retentionPayloadPurgedAt: Date.now() },
  ]) {
    it(`refuses publication after ${Object.keys(patch)[0]} changes during save`, async () => {
      const { database, bucket } = setup();
      bucket.beforeSave = async () => {
        await database.db.collection('assisted_applications').doc(ORDER).set(patch, { merge: true });
        bucket.files.clear();
      };
      const result = await handleAssistedApplicationAdmin(request());
      assert.equal(result.status, 409);
      assert.equal(database.read(BASE).cvStorageKey, undefined);
      assert.equal(database.read(BASE).cvUploadedAt, undefined);
      assert.equal(bucket.files.size, 0);
      assert.equal(database.list(`${BASE}/events/`).length, 0);
    });
  }

  it('counts authentication time in the 60-second operation lease', async () => {
    const { database, bucket } = setup();
    const startedAt = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(startedAt);
    runtime.verifyIdToken.mockImplementation(async () => {
      vi.setSystemTime(startedAt + 60_001);
      return { uid: SITE_ADMIN_UIDS[0], email: SITE_ADMIN_EMAILS[0], email_verified: true };
    });
    const result = await handleAssistedApplicationAdmin(request());
    assert.equal(result.status, 409);
    assert.equal(database.read(BASE).cvStorageKey, undefined);
    assert.equal(database.read(BASE).cvUploadedAt, undefined);
    assert.equal(bucket.files.size, 0);
  });

  it('anchors the successful first upload after Storage returns', async () => {
    const { database, bucket } = setup();
    const startedAt = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(startedAt);
    bucket.beforeSave = async () => { vi.setSystemTime(startedAt + 5000); };
    const result = await handleAssistedApplicationAdmin(request());
    assert.equal(result.status, 200);
    assert.equal(database.read(BASE).cvUploadedAt.toMillis(), startedAt + 5000);
  });
});

describe('owner replacement keeps the existing retention clock and source', () => {
  const oldKey = `assisted-application-uploads/${ORDER}/old-cv.pdf`;
  const receivedAt = () => Date.now() - 86_400_000;

  it('replaces the CV without extending retention or deleting objects still usable as sent evidence', async () => {
    const anchor = receivedAt();
    const { database, bucket } = setup({ cvStorageKey: oldKey, cvUploadedAt: anchor, submissionStatus: 'in_progress' });
    bucket.files.set(oldKey, { content: PDF, generation: 'old-generation', metadata: {} });
    const result = await handleAssistedApplicationAdmin(request());
    assert.equal(result.status, 200);
    const order = database.read(BASE);
    assert.notEqual(order.cvStorageKey, oldKey);
    assert.equal(order.cvUploadedAt, anchor);
    assert.ok(bucket.files.has(order.cvStorageKey));
    assert.ok(bucket.files.has(oldKey));
    assert.equal(bucket.deleted.length, 0);
  });

  it('does not restore an expired retained CV through the owner replacement route', async () => {
    const anchor = Date.now() - 91 * 86_400_000;
    const { database, bucket } = setup({ cvStorageKey: oldKey, cvUploadedAt: anchor, submissionStatus: 'in_progress' });
    const result = await handleAssistedApplicationAdmin(request());
    assert.equal(result.status, 409);
    assert.equal(database.read(BASE).cvStorageKey, oldKey);
    assert.equal(database.read(BASE).cvUploadedAt, anchor);
    assert.equal(bucket.files.size, 0);
  });

  for (const submission of [
    { r1: { state: 'sent' } }, { r3: { state: 'sent' } },
    { r1: { state: 'sending', channel: 'lever', clickedAt: Date.now() } },
    { r1: { state: 'sending', channel: 'email', clickedAt: null } },
  ]) {
    it(`does not upload a replacement after canonical irreversibility ${JSON.stringify(submission)}`, async () => {
      const anchor = receivedAt();
      const { database, bucket } = setup({ cvStorageKey: oldKey, cvUploadedAt: anchor, submissionStatus: 'in_progress' });
      await database.db.collection('assisted_applications').doc(ORDER).collection('automation').doc('submission').set(submission);
      const result = await handleAssistedApplicationAdmin(request());
      assert.equal(result.status, 409);
      assert.ok(['already_sent', 'submission_unconfirmed'].includes(result.body.error));
      assert.equal(database.read(BASE).cvStorageKey, oldKey);
      assert.equal(database.read(BASE).cvUploadedAt, anchor);
      assert.equal(bucket.files.size, 0);
      assert.equal(database.list(`${BASE}/pending_artifacts/`).length, 0);
      assert.equal(database.list(`${BASE}/events/`).length, 0);
    });
  }

  for (const record of [
    { state: 'sent', channel: 'lever' }, { state: 'sending', channel: 'lever', clickedAt: Date.now() },
    { state: 'sending', channel: 'email', clickedAt: null },
  ]) {
    it(`refuses a replacement when ${record.state}/${record.channel} becomes irreversible during save`, async () => {
      const anchor = receivedAt();
      const { database, bucket } = setup({ cvStorageKey: oldKey, cvUploadedAt: anchor, submissionStatus: 'in_progress' });
      bucket.files.set(oldKey, { content: PDF, generation: '900', metadata: {} });
      bucket.afterSave = async () => {
        await database.db.collection('assisted_applications').doc(ORDER).collection('automation').doc('submission').set({ r1: record });
      };
      const result = await handleAssistedApplicationAdmin(request());
      assert.equal(result.status, 409);
      assert.ok(['already_sent', 'submission_unconfirmed'].includes(result.body.error));
      assert.equal(database.read(BASE).cvStorageKey, oldKey);
      assert.equal(database.read(BASE).cvUploadedAt, anchor);
      assert.equal(database.list(`${BASE}/events/`).length, 0);
      assert.equal(bucket.files.size, 1);
      assert.ok(bucket.files.has(oldKey));
      assert.ok(bucket.deleted.every(file => file.key !== oldKey));
    });
  }

  for (const record of [
    { state: 'failed', channel: 'lever', clickedAt: null },
    { state: 'failed', channel: 'lever', clickedAt: Date.now() - 1000 },
    { state: 'sending', channel: 'lever', clickedAt: null },
  ]) {
    it(`allows a safe replacement for ${record.state} despite legacy queue and preparation fields`, async () => {
      const anchor = receivedAt();
      const { database, bucket } = setup({ cvStorageKey: oldKey, cvUploadedAt: anchor,
        submittedAt: Date.now() - 1000, submissionStatus: 'in_progress' });
      await database.db.collection('assisted_applications').doc(ORDER).collection('automation').doc('submission').set({ r1: record });
      await database.db.collection('assisted_applications').doc(ORDER).collection('automation').doc('flow').set({ state: 'candidate_review', round: 1, sentRounds: [1] });
      await database.db.collection('assisted_applications').doc(ORDER).collection('ai_drafts').doc('current').set({ sentAttempt: { at: Date.now() - 1000 } });
      const result = await handleAssistedApplicationAdmin(request());
      assert.equal(result.status, 200);
      assert.notEqual(database.read(BASE).cvStorageKey, oldKey);
      assert.equal(database.read(BASE).cvUploadedAt, anchor);
      assert.ok(bucket.files.has(database.read(BASE).cvStorageKey));
      assert.equal(database.read(`${BASE}/automation/flow`).state, 'candidate_review');
    });
  }

  for (const patch of [
    { cvStorageKey: `assisted-application-uploads/${ORDER}/concurrent-cv.pdf` },
    { cvUploadedAt: Date.now() - 2 * 86_400_000 },
    { refundStatus: 'pending' }, { retentionPayloadPurgedAt: Date.now() },
  ]) {
    it(`rejects a replacement if ${Object.keys(patch)[0]} changes after upload admission`, async () => {
      const anchor = receivedAt();
      const { database, bucket } = setup({ cvStorageKey: oldKey, cvUploadedAt: anchor, submissionStatus: 'in_progress' });
      bucket.files.set(oldKey, { content: PDF, generation: 'old-generation', metadata: {} });
      bucket.afterSave = async () => {
        await database.db.collection('assisted_applications').doc(ORDER).set(patch, { merge: true });
      };
      const result = await handleAssistedApplicationAdmin(request());
      assert.equal(result.status, 409);
      assert.equal(database.read(BASE).cvStorageKey, patch.cvStorageKey || oldKey);
      assert.equal(database.read(BASE).cvUploadedAt, patch.cvUploadedAt || anchor);
      assert.equal(database.list(`${BASE}/events/`).length, 0);
      assert.equal(bucket.files.size, 1);
      assert.ok(bucket.files.has(oldKey));
      assert.ok(bucket.deleted.every(file => file.key !== oldKey));
    });
  }
});
