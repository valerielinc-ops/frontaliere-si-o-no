import test from 'node:test';
import assert from 'node:assert/strict';
import { handleAssistedApplicationEmailCv } from '../functions/src/assistedApplicationEmailCv.js';
import {
  INITIAL_CV_BASE as BASE, INITIAL_CV_ORDER as ORDER, INITIAL_CV_SECRET as SECRET,
  initialCvBucket, initialCvDatabase, initialCvEmailRequest, initialCvMessage,
} from './helpers/initialCvCallersFixture.mjs';

function setup(order = {}) {
  const database = initialCvDatabase(order);
  const bucket = initialCvBucket();
  return { database, bucket, deps: { db: database.db, bucket, secret: SECRET } };
}

function assertNoPublication(database) {
  const order = database.read(BASE);
  assert.equal(order.cvStorageKey, undefined);
  assert.equal(order.cvUploadedAt, undefined);
  assert.equal(database.read(`${BASE}/automation/intake`), undefined);
  assert.equal(database.list(`${BASE}/events/`).length, 0);
}

test('authenticated first CV succeeds without consentV2 or a pre-existing retention anchor', async () => {
  const { database, bucket, deps } = setup();
  let clock = Date.now();
  const startedAt = clock;
  bucket.beforeSave = async () => { clock += 5000; };
  const result = await handleAssistedApplicationEmailCv(initialCvEmailRequest(), { ...deps, now: () => clock });
  assert.deepEqual(result, { status: 200, body: { ok: true, matched: true } });
  const order = database.read(BASE);
  assert.equal(order.submissionStatus, 'in_progress');
  assert.equal(order.cvUploadedBy, 'email_reply');
  assert.ok(order.cvUploadedAt.toMillis() >= startedAt + 5000);
  assert.ok(bucket.files.has(order.cvStorageKey));
  assert.equal(database.read(`${BASE}/automation/intake`).emailNotes, 'Private candidate notes.');
  assert.equal(database.list(`${BASE}/events/`).length, 1);
  assert.equal(order.consentVersion, undefined);
});

test('an authenticated applicant address can provide the CV for its own order', async () => {
  const { database, bucket, deps } = setup({ customerEmail: 'payer@example.test', applicantEmail: 'candidate@example.test' });
  const result = await handleAssistedApplicationEmailCv(initialCvEmailRequest(), deps);
  assert.equal(result.body.matched, true);
  assert.ok(bucket.files.has(database.read(BASE).cvStorageKey));
});

test('a cold receipt with an existing SENT fact does not write an approval, flow transition or runner event', async () => {
  const { database, bucket, deps } = setup({ submissionStatus: 'in_progress' });
  const orderRef = database.db.collection('assisted_applications').doc(ORDER);
  await orderRef.collection('automation').doc('submission').set({ r1: { state: 'sent', channel: 'lever' } });
  await orderRef.collection('automation').doc('flow').set({ state: 'owner_takeover', round: 1, heldBy: ['owner'] });
  const result = await handleAssistedApplicationEmailCv(initialCvEmailRequest(), deps);
  assert.equal(result.body.matched, true);
  assert.ok(bucket.files.has(database.read(BASE).cvStorageKey));
  assert.deepEqual(database.read(`${BASE}/automation/submission`), { r1: { state: 'sent', channel: 'lever' } });
  assert.deepEqual(database.read(`${BASE}/automation/flow`), { state: 'owner_takeover', round: 1, heldBy: ['owner'] });
  assert.equal(database.list(`${BASE}/automation_events/`).length, 0);
  assert.equal(database.list(`${BASE}/ai_drafts/`).length, 0);
  assert.equal(database.read(BASE).submissionStatus, 'in_progress');
});

test('the private exact-order dependency never falls back to a different waiting order', async () => {
  const { database, bucket, deps } = setup();
  const unrelated = 'order_UNRELATED';
  await database.db.collection('assisted_applications').doc(unrelated).set({
    paymentStatus: 'paid', submissionStatus: 'awaiting_upload', customerEmail: 'different@example.test',
  });
  for (const expectedOrderId of [unrelated, 'order_MISSING', '', null]) {
    const result = await handleAssistedApplicationEmailCv(initialCvEmailRequest(), { ...deps, expectedOrderId });
    assert.equal(result.body.reason, 'no_waiting_order');
    assertNoPublication(database);
    assert.equal(bucket.files.size, 0);
  }
});

test('the exact-order delegation keeps the automation flag for that same order', async () => {
  const { database, bucket, deps } = setup();
  const seen = [];
  const result = await handleAssistedApplicationEmailCv(initialCvEmailRequest(), { ...deps, expectedOrderId: ORDER,
    isEnabled: async orderId => { seen.push(orderId); return false; },
  });
  assert.equal(result.body.reason, 'automation_off');
  assert.deepEqual(seen, [ORDER]);
  assertNoPublication(database);
  assert.equal(bucket.files.size, 0);
});

test('the exact-order delegation attaches only to that authorized order', async () => {
  const { database, bucket, deps } = setup();
  const other = 'order_OTHER-CV';
  await database.db.collection('assisted_applications').doc(other).set({ paymentStatus: 'paid',
    submissionStatus: 'awaiting_upload', customerEmail: 'candidate@example.test', paidAt: new Date(Date.now() + 1000),
  });
  const result = await handleAssistedApplicationEmailCv(initialCvEmailRequest(), { ...deps, expectedOrderId: ORDER });
  assert.equal(result.body.matched, true);
  assert.ok(bucket.files.has(database.read(BASE).cvStorageKey));
  assert.equal(database.read(`assisted_applications/${other}`).cvStorageKey, undefined);
});

for (const [name, raw, secret, order] of [
  ['worker secret missing', initialCvMessage(), 'wrong-secret', {}],
  ['unaligned DKIM', initialCvMessage({ auth: 'mx.cloudflare.net; dkim=pass header.d=other.test; spf=fail' }), SECRET, {}],
  ['forged lower authentication header', initialCvMessage({ auth: 'mx.cloudflare.net; dkim=fail; spf=fail', extraAuth: 'mx.cloudflare.net; dkim=pass header.d=example.test' }), SECRET, {}],
  ['authenticated different sender', initialCvMessage({ from: 'other@example.test' }), SECRET, {}],
  ['unpaid order', initialCvMessage(), SECRET, { paymentStatus: 'pending' }],
  ['closed order', initialCvMessage(), SECRET, { submissionStatus: 'cancelled' }],
  ['refund pending', initialCvMessage(), SECRET, { refundStatus: 'pending' }],
  ['purging tombstone', initialCvMessage(), SECRET, { retentionPurgingAt: Date.now() }],
  ['purged tombstone', initialCvMessage(), SECRET, { retentionPurgedAt: Date.now() }],
  ['payload purged tombstone', initialCvMessage(), SECRET, { retentionPayloadPurgedAt: Date.now() }],
]) {
  test(`initial email refuses ${name} without attaching data`, async () => {
    const { database, bucket, deps } = setup(order);
    const result = await handleAssistedApplicationEmailCv(initialCvEmailRequest(raw, secret), deps);
    assert.notEqual(result.body.matched, true);
    assertNoPublication(database);
    assert.equal(bucket.files.size, 0);
  });
}

for (const field of ['cvUploadedAt', 'submittedAt', 'refundedAt']) {
  test(`initial ingress does not restart a raw existing ${field} anchor`, async () => {
    const anchor = Date.now() - 1000;
    const { database, bucket, deps } = setup({ [field]: anchor });
    const result = await handleAssistedApplicationEmailCv(initialCvEmailRequest(), deps);
    assert.equal(result.body.matched, false);
    assert.equal(database.read(BASE)[field], anchor);
    assert.equal(database.read(BASE).cvStorageKey, undefined);
    assert.equal(bucket.files.size, 0);
  });
}

for (const anchor of [0, {}, Number.NaN]) {
  test(`an unknown non-null anchor (${String(anchor)}) cannot become a cold-start grant`, async () => {
    const { database, bucket, deps } = setup({ cvUploadedAt: anchor });
    const result = await handleAssistedApplicationEmailCv(initialCvEmailRequest(), deps);
    assert.equal(result.body.matched, false);
    assert.equal(database.read(BASE).cvStorageKey, undefined);
    assert.equal(bucket.files.size, 0);
  });
}

for (const patch of [
  { retentionPurgingAt: Date.now() }, { retentionPurgedAt: Date.now() }, { retentionPayloadPurgedAt: Date.now() },
  { paymentStatus: 'refunded' }, { refundStatus: 'pending' }, { customerEmail: 'changed@example.test' },
  { submissionStatus: 'cancelled' },
]) {
  test(`fresh publication refuses a change during save: ${Object.keys(patch)[0]}`, async () => {
    const { database, bucket, deps } = setup();
    bucket.beforeSave = async () => {
      await database.db.collection('assisted_applications').doc(ORDER).set(patch, { merge: true });
      bucket.files.clear(); // A prefix purge can finish before the delayed Storage commit.
    };
    const result = await handleAssistedApplicationEmailCv(initialCvEmailRequest(), deps);
    assert.equal(result.body.matched, false);
    assertNoPublication(database);
    assert.equal(bucket.files.size, 0);
  });
}

test('the operation lease can expire during save without becoming a new retention clock', async () => {
  const { database, bucket, deps } = setup();
  let clock = Date.now();
  bucket.beforeSave = async () => { clock += 60_001; };
  const result = await handleAssistedApplicationEmailCv(initialCvEmailRequest(), { ...deps, now: () => clock });
  assert.equal(result.body.matched, false);
  assertNoPublication(database);
  assert.equal(bucket.files.size, 0);
});

test('delegation preserves the original entry lease and ignores a body-supplied replacement clock', async () => {
  const { database, bucket, deps } = setup();
  const clock = Date.now();
  const req = { ...initialCvEmailRequest(), body: { operationStartedAt: clock, mode: 'initial_cv' } };
  const result = await handleAssistedApplicationEmailCv(req, { ...deps, now: () => clock, expectedOrderId: ORDER,
    operationStartedAt: clock - 60_001 });
  assert.equal(result.body.matched, false);
  assertNoPublication(database);
  assert.equal(bucket.files.size, 0);
});

test('a concurrent successful CV upload wins without deletion or replacement', async () => {
  const { database, bucket, deps } = setup();
  const previous = `assisted-application-uploads/${ORDER}/concurrent.pdf`;
  bucket.beforeSave = async () => {
    await bucket.file(previous).save(Buffer.from('%PDF-1.4\nexisting'));
    await database.db.collection('assisted_applications').doc(ORDER).set({ cvStorageKey: previous }, { merge: true });
  };
  // Avoid recursively invoking the same upload hook for the competing writer.
  const duringSave = bucket.beforeSave;
  bucket.beforeSave = async (...args) => { bucket.beforeSave = null; await duringSave(...args); };
  const result = await handleAssistedApplicationEmailCv(initialCvEmailRequest(), deps);
  assert.equal(result.body.reason, 'cv_already_present');
  assert.equal(database.read(BASE).cvStorageKey, previous);
  assert.ok(bucket.files.has(previous));
  assert.equal(bucket.files.size, 1);
  assert.ok(bucket.deleted.every(file => file.key !== previous));
});

test('an upload ACK loss leaves a revisitable private marker and never publishes candidate data', async () => {
  const { database, bucket, deps } = setup();
  bucket.afterSave = async () => { throw Object.assign(new Error('upload_ack_unknown'), { code: 412 }); };
  await assert.rejects(handleAssistedApplicationEmailCv(initialCvEmailRequest(), deps), /upload_ack_unknown/);
  assertNoPublication(database);
  assert.ok(database.list(`${BASE}/pending_artifacts/`).length > 0);
});

test('a publication ACK loss preserves the committed CV, notes and events', async () => {
  const { database, bucket, deps } = setup();
  const transact = database.db.runTransaction.bind(database.db);
  let ackLost = false;
  database.db.runTransaction = async callback => {
    const value = await transact(callback);
    if (!ackLost && database.read(BASE).cvStorageKey) {
      ackLost = true;
      throw new Error('publication_ack_unknown');
    }
    return value;
  };
  await assert.rejects(handleAssistedApplicationEmailCv(initialCvEmailRequest(), deps), /publication_ack_unknown/);
  const published = database.read(BASE);
  assert.ok(bucket.files.has(published.cvStorageKey));
  assert.equal(database.read(`${BASE}/automation/intake`).emailNotes, 'Private candidate notes.');
  assert.equal(database.list(`${BASE}/events/`).length, 1);
  const replay = await handleAssistedApplicationEmailCv(initialCvEmailRequest(), deps);
  assert.equal(replay.body.matched, false);
  assert.equal(database.read(BASE).cvStorageKey, published.cvStorageKey);
  assert.equal(database.list(`${BASE}/events/`).length, 1);
});
