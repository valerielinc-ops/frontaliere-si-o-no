import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { createMemoryFirestore } from './helpers/memoryFirestore.ts';
import { handleAssistedApplicationInbound, processAssistedApplicationInbound } from '../functions/src/assistedApplicationInbound.js';
import { submissionSlotHash } from '../functions/src/lib/submissionReceiptContract.js';

// Real handlers and canonical retention/upload engine; only Firestore, GCS,
// the model callback and the mail transport are explicit in-memory adapters.
const ORDER = 'inbound-retention-fixture';
const PATH = `assisted_applications/${ORDER}`;
const ALIAS = 'c-abcdefghjk';
const SECRET = 'inbound-fixture-secret';
const RUN_KEY = Buffer.alloc(32, 8).toString('base64');
const NOW = 1_000;
const DUE = 90 * 86400000 + 1;
const raw = Buffer.from('From: Recruiter <hr@employer.example>\r\nSubject: Application update\r\nContent-Type: text/plain\r\n\r\nPlease contact us.');
const request = { method: 'POST', rawBody: raw, get: key => ({ 'x-stop-secret': SECRET, 'x-envelope-to': `${ALIAS}@candidature.frontaliereticino.ch` })[key] };
const category = { category: 'question', summaryIt: '', summaryCandidate: '', interviewWhen: '', requestedDocuments: [], verificationCode: '', verificationUrl: '', needsReply: true };

function setup(orderPatch = {}) {
  let clock = NOW;
  const store = createMemoryFirestore({
    [PATH]: { cvUploadedAt: 1, cvStorageKey: `assisted-application-uploads/${ORDER}/cv.pdf`, paymentStatus: 'paid', customerEmail: 'candidate@example.test', ...orderPatch },
    [`assisted_application_aliases/${ALIAS}`]: { orderId: ORDER },
  });
  const files = new Map();
  let generation = 0;
  const calls = { saves: 0, deletes: 0, forwards: 0, models: 0 };
  const hooks = {};
  const bucket = { file(key) { return {
    async save(bytes, options) {
      calls.saves++;
      assert.equal(options.preconditionOpts.ifGenerationMatch, 0);
      if (files.has(key)) throw Object.assign(new Error('precondition'), { code: 412 });
      files.set(key, { bytes: Buffer.from(bytes), generation: String(++generation), metadata: options.metadata?.metadata });
      await hooks.saved?.(key);
    },
    async getMetadata() {
      const file = files.get(key);
      if (!file) throw Object.assign(new Error('missing'), { code: 404 });
      return [{ generation: file.generation, metadata: file.metadata }];
    },
    async download() { await hooks.download?.(); return [files.get(key)?.bytes || Buffer.alloc(0)]; },
    async delete(options) {
      calls.deletes++;
      const file = files.get(key);
      if (file && file.generation !== options.ifGenerationMatch) throw Object.assign(new Error('generation'), { code: 412 });
      files.delete(key);
    },
  }; } };
  const deps = { db: store.db, bucket, secret: SECRET, runKey: RUN_KEY, now: () => clock };
  const ingest = (incoming = request) => handleAssistedApplicationInbound(incoming, deps);
  const process = (messageId, overrides = {}) => processAssistedApplicationInbound({
    ...deps, orderId: ORDER, messageId,
    classify: async () => { calls.models++; return category; },
    sendCascade: async () => { calls.forwards++; return { sent: [{ provider: 'fixture' }], failed: [] }; },
    ...overrides,
  });
  return { store, bucket, files, calls, hooks, deps, ingest, process, setClock: value => { clock = value; } };
}

test('retained ingress publishes encrypted raw plus its immutable native identity', async () => {
  const s = setup();
  const result = await s.ingest();
  assert.equal(result.body.matched, true);
  const inbox = s.store.read(`${PATH}/inbox/${result.body.accepted}`);
  assert.equal(inbox.envelopeAlias, ALIAS);
  assert.equal(inbox.rawSha256, createHash('sha256').update(raw).digest('hex'));
  assert.equal(inbox.receivedAt, NOW);
  assert.equal(s.files.get(inbox.rawKey).bytes.includes(Buffer.from('Please contact')), false);
});

for (const [label, patch, clock] of [
  ['purging', { retentionPurgingAt: 3 }, NOW],
  ['purged', { retentionPurgedAt: 3 }, NOW],
  ['cleared talent-pool payload', { retentionPayloadPurgedAt: 3, talentPoolConsent: true }, NOW],
  ['expired', {}, DUE],
  ['missing anchor', { cvUploadedAt: null }, NOW],
]) test(`${label} ingress never creates a raw object or inbox`, async () => {
  const s = setup(patch); s.setClock(clock);
  assert.equal((await s.ingest()).body.matched, false);
  assert.equal(s.calls.saves, 0);
  assert.deepEqual(s.store.list(`${PATH}/inbox/`), []);
});

test('expiry during upload deletes only this upload generation and publishes nothing', async () => {
  const s = setup();
  s.hooks.saved = () => s.setClock(DUE);
  assert.equal((await s.ingest()).body.matched, false);
  assert.equal(s.files.size, 0);
  assert.equal(s.calls.deletes, 1);
  assert.deepEqual(s.store.list(`${PATH}/inbox/`), []);
});

test('final publication rechecks time after its last alias read', async () => {
  const s = setup();
  const run = s.store.db.runTransaction.bind(s.store.db);
  s.store.db.runTransaction = fn => run(tx => fn({ ...tx, get: async ref => {
    const value = await tx.get(ref);
    if (ref.path === `assisted_application_aliases/${ALIAS}`) s.setClock(DUE);
    return value;
  } }));
  assert.equal((await s.ingest()).body.matched, false);
  assert.equal(s.files.size, 0);
  assert.deepEqual(s.store.list(`${PATH}/inbox/`), []);
});

test('alias retargeting while uploading cannot publish an inbox for its old order', async () => {
  const s = setup();
  s.hooks.saved = () => s.store.docs.set(`assisted_application_aliases/${ALIAS}`, { orderId: 'different-order' });
  assert.equal((await s.ingest()).body.matched, false);
  assert.equal(s.files.size, 0);
  assert.deepEqual(s.store.list(`${PATH}/inbox/`), []);
});

test('an unacknowledged committed upload keeps its canonical cleanup reservation', async () => {
  const s = setup();
  s.hooks.saved = () => { throw Object.assign(new Error('transport acknowledgement lost'), { code: 412 }); };
  await assert.rejects(s.ingest(), /acknowledgement lost/);
  assert.equal(s.files.size, 1);
  assert.equal(s.store.list(`${PATH}/pending_artifacts/`).length, 1);
  assert.deepEqual(s.store.list(`${PATH}/inbox/`), []);
});

test('expiry during classification stops forward and publication', async () => {
  const s = setup(); const accepted = await s.ingest();
  const result = await s.process(accepted.body.accepted, { classify: async () => { s.setClock(DUE); return category; } });
  assert.equal(result.reason, 'retention_closed');
  assert.equal(s.calls.forwards, 0);
  assert.equal(s.store.read(`${PATH}/inbox/${accepted.body.accepted}`).processedAt, undefined);
  assert.equal(s.store.read(PATH).employerResponse, undefined);
});

test('a purged inbox is not recreated when the mail provider finishes', async () => {
  const s = setup(); const accepted = await s.ingest(); const messagePath = `${PATH}/inbox/${accepted.body.accepted}`;
  const result = await s.process(accepted.body.accepted, { sendCascade: async () => {
    s.store.docs.set(PATH, { retentionPurgedAt: NOW }); s.store.docs.delete(messagePath);
    return { sent: [{}], failed: [] };
  } });
  assert.equal(result.reason, 'retention_closed');
  assert.equal(s.store.read(messagePath), undefined);
  assert.deepEqual(s.store.read(PATH), { retentionPurgedAt: NOW });
});

test('a throwing provider cannot reset a removed inbox after purge', async () => {
  const s = setup(); const accepted = await s.ingest(); const messagePath = `${PATH}/inbox/${accepted.body.accepted}`;
  await assert.rejects(s.process(accepted.body.accepted, { sendCascade: async () => {
    s.store.docs.set(PATH, { retentionPurgingAt: NOW }); s.store.docs.delete(messagePath);
    throw new Error('provider unavailable');
  } }), /provider unavailable/);
  assert.equal(s.store.read(messagePath), undefined);
  assert.deepEqual(s.store.read(PATH), { retentionPurgingAt: NOW });
});

test('normal forwarding processes once and a redelivered trigger stays read-only', async () => {
  const s = setup(); const accepted = await s.ingest();
  assert.equal((await s.process(accepted.body.accepted)).forwarded, 'sent');
  assert.equal(s.store.read(`${PATH}/inbox/${accepted.body.accepted}`).status, 'processed');
  assert.deepEqual(await s.process(accepted.body.accepted), { ok: true, skipped: true });
  assert.equal(s.calls.models, 1); assert.equal(s.calls.forwards, 1);
});

function initialCvRequest(sender = 'candidate@example.test', authenticated = true) {
  const bytes = Buffer.from([
    ...(authenticated ? ['Authentication-Results: mx.cloudflare.net; dkim=pass header.d=example.test'] : []),
    `From: Candidate <${sender}>`, 'Subject: CV', 'Content-Type: multipart/mixed; boundary="cv"', '',
    '--cv', 'Content-Type: application/pdf; name="cv.pdf"', 'Content-Disposition: attachment; filename="cv.pdf"',
    'Content-Transfer-Encoding: base64', '', Buffer.from('%PDF-1.4 synthetic CV').toString('base64'), '--cv--', '',
  ].join('\r\n'));
  return { ...request, rawBody: bytes };
}

test('alias first CV delegates to the actual authenticated receiver for this exact order', async () => {
  const s = setup({ cvUploadedAt: null, cvStorageKey: null, submissionStatus: 'awaiting_upload' });
  const called = [];
  s.deps.isEnabled = async id => { called.push(id); return true; };
  const result = await handleAssistedApplicationInbound(initialCvRequest(), s.deps);
  assert.equal(result.body.matched, true);
  assert.deepEqual(called, [ORDER]);
  assert.ok(s.store.read(PATH).cvStorageKey);
  assert.equal(s.store.read(PATH).cvUploadedBy, 'email_reply');
  assert.equal(s.store.read(PATH).cvUploadedAt.toMillis(), NOW);
  assert.equal(s.files.size, 1);
  assert.deepEqual(s.store.list(`${PATH}/inbox/`), []);
  assert.equal(s.store.read(`${PATH}/automation/flow`), undefined);
});

test('alias first CV preserves the flag and authenticated sender instead of storing an employer inbox', async () => {
  for (const [enabled, authenticated] of [[false, true], [true, false]]) {
    const s = setup({ cvUploadedAt: null, cvStorageKey: null, submissionStatus: 'awaiting_upload' });
    s.deps.isEnabled = async () => enabled;
    assert.equal((await handleAssistedApplicationInbound(initialCvRequest('candidate@example.test', authenticated), s.deps)).body.matched, false);
    assert.equal(s.files.size, 0);
    assert.deepEqual(s.store.list(`${PATH}/inbox/`), []);
  }
});

test('an alias first CV cannot fall back to the same sender’s other waiting order', async () => {
  const s = setup({ cvUploadedAt: null, cvStorageKey: null, submissionStatus: 'awaiting_upload', customerEmail: 'different@example.test' });
  s.store.docs.set('assisted_applications/other-waiting', { paymentStatus: 'paid', submissionStatus: 'awaiting_upload', customerEmail: 'candidate@example.test' });
  s.deps.isEnabled = async () => true;
  assert.equal((await handleAssistedApplicationInbound(initialCvRequest(), s.deps)).body.matched, false);
  assert.equal(s.files.size, 0);
  assert.equal(s.store.read('assisted_applications/other-waiting').cvStorageKey, undefined);
});

test('the first CV operation lease starts before the alias lookup and is not reset by delegation', async () => {
  const s = setup({ cvUploadedAt: null, cvStorageKey: null, submissionStatus: 'awaiting_upload' });
  s.deps.isEnabled = async () => { s.setClock(NOW + 60_001); return true; };
  assert.equal((await handleAssistedApplicationInbound(initialCvRequest(), s.deps)).body.matched, false);
  assert.equal(s.files.size, 0);
  assert.equal(s.store.read(PATH).cvStorageKey, null);
});

async function strongReceiptFixture() {
  const s = setup({ jobId: 'original-job', jobUrl: 'https://employer.example/original-job' });
  const outbound = '<original-application@candidature.frontaliereticino.ch>';
  const incoming = { ...request, rawBody: Buffer.from([
    'Authentication-Results: mx.cloudflare.net; dkim=pass header.d=employer.example',
    'From: Recruitment <hr@employer.example>', `In-Reply-To: ${outbound}`,
    'Subject: Application received', 'Content-Type: text/plain', '', 'We have received your application.',
  ].join('\r\n')) };
  s.store.docs.set(`${PATH}/automation/flow`, { state: 'owner_takeover', round: 1, heldBy: ['email_ambiguous'] });
  s.store.docs.set(`${PATH}/ai_drafts/current`, { round: 1, sentAttempt: { privateFixtureMaterial: 'not an attested legacy photo' } });
  s.store.docs.set(`${PATH}/automation/submission`, { r1: { state: 'sending', channel: 'email', startedAt: 500,
    emailHandoff: { messageId: outbound, recipient: 'jobs@employer.example', slotHash: submissionSlotHash({ orderId: ORDER, order: s.store.read(PATH) }) } } });
  const accepted = await s.ingest(incoming);
  assert.equal(accepted.body.matched, true);
  const messageId = accepted.body.accepted;
  const paths = [PATH, `${PATH}/automation/flow`, `${PATH}/ai_drafts/current`, `${PATH}/inbox/${messageId}`];
  const snapshotPayload = () => paths.map(path => [path, structuredClone(s.store.read(path))]);
  const assertPayload = snapshot => snapshot.forEach(([path, value]) => assert.deepEqual(s.store.read(path), value));
  const noEffects = async () => { throw new Error('receipt reconciliation must run no application effects'); };
  return { ...s, messageId, snapshotPayload, assertPayload, noEffects };
}

for (const stage of ['classification', 'forward']) test(`actual observed receipt survives expiry during ${stage} as a content-free minimum only`, async () => {
  const s = await strongReceiptFixture(); let beforeExpiry;
  const expire = () => { beforeExpiry = s.snapshotPayload(); s.setClock(DUE); };
  const result = await s.process(s.messageId, {
    runEffect: s.noEffects,
    classify: async () => { if (stage === 'classification') expire(); return category; },
    sendCascade: async () => { s.calls.forwards++; if (stage === 'forward') expire(); return { failed: [], sent: [{}] }; },
  });
  assert.equal(result.reason, 'retention_closed');
  assert.equal(result.submissionConfirmed, true);
  s.assertPayload(beforeExpiry);
  assert.equal(s.calls.forwards, stage === 'forward' ? 1 : 0);
  const receipts = s.store.list(`${PATH}/submission_receipts/`).map(path => s.store.read(path));
  assert.ok(receipts.length > 0);
  assert.equal(JSON.stringify(receipts).includes('jobs@employer.example'), false);
  assert.equal(JSON.stringify(receipts).includes('not an attested legacy photo'), false);
  assert.equal(s.store.read(`${PATH}/automation/followup`), undefined);
});

test('an observed receipt cannot recreate a physically purged inbox or its source authority', async () => {
  const s = await strongReceiptFixture();
  const result = await s.process(s.messageId, { runEffect: s.noEffects, sendCascade: async () => {
    s.store.docs.delete(`${PATH}/inbox/${s.messageId}`);
    s.store.docs.set(PATH, { ...s.store.read(PATH), retentionPurgedAt: NOW });
    return { failed: [], sent: [{}] };
  } });
  assert.equal(result.reason, 'retention_closed');
  assert.equal(result.submissionConfirmed, undefined);
  assert.equal(s.store.read(`${PATH}/inbox/${s.messageId}`), undefined);
  assert.deepEqual(s.store.list(`${PATH}/submission_receipts/`), []);
  assert.equal(s.store.read(`${PATH}/automation/submission`).r1.state, 'sending');
});

test('late observed evidence never changes a new round or mints a receipt for it', async () => {
  const s = await strongReceiptFixture();
  const next = { state: 'sending', channel: 'email', startedAt: 900, emailHandoff: {
    messageId: '<new-round@candidature.frontaliereticino.ch>', recipient: 'jobs@employer.example',
    slotHash: submissionSlotHash({ orderId: ORDER, order: s.store.read(PATH) }),
  } };
  const flow = { state: 'owner_takeover', round: 2, heldBy: ['email_ambiguous'] };
  const result = await s.process(s.messageId, { runEffect: s.noEffects, classify: async () => {
    s.store.docs.set(`${PATH}/automation/flow`, flow);
    s.store.docs.set(`${PATH}/automation/submission`, { ...s.store.read(`${PATH}/automation/submission`), r2: next });
    s.setClock(DUE); return category;
  } });
  assert.equal(result.submissionConfirmed, undefined);
  assert.deepEqual(s.store.read(`${PATH}/automation/flow`), flow);
  assert.deepEqual(s.store.read(`${PATH}/automation/submission`).r2, next);
  assert.deepEqual(s.store.list(`${PATH}/submission_receipts/`), []);
});

test('a retained strong legacy receipt heals state and schedules its original thread without grafting a draft photo', async () => {
  const s = await strongReceiptFixture();
  s.store.docs.set(PATH, { ...s.store.read(PATH), submissionStatus: 'ready_for_manual_submission' });
  const draftBefore = structuredClone(s.store.read(`${PATH}/ai_drafts/current`));
  const result = await s.process(s.messageId, { runEffect: s.noEffects,
    classify: async () => ({ ...category, category: 'auto_acknowledgement', needsReply: false }),
  });
  assert.equal(result.submissionConfirmed, true);
  assert.equal(s.store.read(`${PATH}/automation/flow`).state, 'submitted');
  assert.equal(s.store.read(PATH).submissionStatus, 'submitted');
  assert.deepEqual(s.store.read(`${PATH}/ai_drafts/current`), draftBefore);
  assert.equal(s.store.read(`${PATH}/ai_drafts/current`).sent, undefined);
  const followup = s.store.read(`${PATH}/automation/followup`);
  assert.equal(followup.to, 'jobs@employer.example');
  assert.equal(followup.messageId, '<original-application@candidature.frontaliereticino.ch>');
  assert.equal(followup.round, 1);
  const receiptsBefore = structuredClone(s.store.list(`${PATH}/submission_receipts/`).map(path => [path, s.store.read(path)]));
  assert.deepEqual(await s.process(s.messageId, { runEffect: s.noEffects }), { ok: true, skipped: true });
  assert.deepEqual(s.store.list(`${PATH}/submission_receipts/`).map(path => [path, s.store.read(path)]), receiptsBefore);
  assert.deepEqual(s.store.read(`${PATH}/automation/followup`), followup);
});
