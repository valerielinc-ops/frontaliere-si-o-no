import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { createMemoryFirestore } from './helpers/memoryFirestore.ts';
import { employerReceiptAuthority } from '../functions/src/assistedApplicationInbound.js';
import { parseMimeMessage } from '../functions/src/lib/mimeMessage.js';
import { qualificationCounterContextHash } from '../functions/src/lib/qualificationCounterContext.js';
import { submissionAttemptHash, submissionSlotHash } from '../functions/src/lib/submissionReceiptContract.js';

const ORDER = 'employer-receipt-fixture';
const PATH = `assisted_applications/${ORDER}`;
const ALIAS = 'c-abcdefghjk';
const MESSAGE = '1000-1234abcd';
const OUTBOUND = '<aa-original-application@candidature.frontaliereticino.ch>';
const NOW = 1000;

function setup({ headers = [], text = 'We have received your application.', authenticated = true, orderPatch = {} } = {}) {
  const order = { cvUploadedAt: 1, jobId: 'job-original', jobUrl: 'https://employer.example/job-original', ...orderPatch };
  const bytes = Buffer.from([
    ...(authenticated ? ['Authentication-Results: mx.cloudflare.net; dkim=pass header.d=employer.example'] : []),
    'From: Recruitment <hr@employer.example>',
    `In-Reply-To: ${OUTBOUND}`,
    ...headers,
    'Subject: Your application', 'Content-Type: text/plain', '', text,
  ].join('\r\n'));
  const claimed = { receivedAt: NOW, rawSha256: createHash('sha256').update(bytes).digest('hex'), envelopeAlias: ALIAS, rawKey: `assisted-application-uploads/${ORDER}/inbox-original.eml.json.enc` };
  const store = createMemoryFirestore({
    [PATH]: order,
    [`${PATH}/inbox/${MESSAGE}`]: claimed,
    [`assisted_application_aliases/${ALIAS}`]: { orderId: ORDER },
  });
  const record = { state: 'sending', channel: 'email', startedAt: 500, clickedAt: null,
    emailHandoff: { messageId: OUTBOUND, recipient: 'jobs@employer.example', slotHash: submissionSlotHash({ orderId: ORDER, order }) } };
  const create = () => employerReceiptAuthority({ db: store.db, orderId: ORDER, messageId: MESSAGE,
    claimed, message: parseMimeMessage(bytes), rawBytes: bytes, now: () => NOW });
  const authorize = async () => { const factory = create(); return factory ? factory({ record, round: 1 }) : null; };
  const assertCurrent = authority => store.db.runTransaction(tx => authority.assertInTransaction(tx));
  return { store, order, record, claimed, bytes, create, authorize, assertCurrent };
}

test('actual authenticated thread and historical slot create only the agreed minimal private authority', async () => {
  const s = setup(); const authority = await s.authorize();
  assert.equal(authority.kind, 'legacy_employer_ack');
  assert.deepEqual(authority.proof, { orderId: ORDER, round: 1, channel: 'email', leftAt: 500,
    recordHash: qualificationCounterContextHash(s.record), messageId: MESSAGE, providerReceivedAt: NOW,
    slotHash: submissionSlotHash({ orderId: ORDER, order: s.order }) });
  assert.deepEqual(await s.assertCurrent(authority), authority.proof);
  assert.deepEqual(await s.assertCurrent(authority), authority.proof);
  assert.equal(Object.isFrozen(authority.proof), true);
  assert.equal(s.store.list(`${PATH}/submission_receipts/`).length, 0);
});

test('source references are captured before awaits and cannot be replaced by the caller', async () => {
  const s = setup(); const factory = s.create();
  const originalRecord = structuredClone(s.record);
  const preparing = factory({ record: s.record, round: 1 });
  s.record.channel = 'portal'; s.record.startedAt = 777;
  const authority = await preparing;
  assert.ok(authority);
  assert.equal(authority.proof.channel, 'email');
  assert.equal(authority.proof.leftAt, 500);
  assert.equal(authority.proof.recordHash, qualificationCounterContextHash(originalRecord));
  s.claimed.receivedAt = 777; s.claimed.rawKey = 'different';
  assert.deepEqual(await s.assertCurrent(authority), authority.proof);
  s.store.docs.set(`${PATH}/inbox/${MESSAGE}`, { ...s.claimed });
  assert.equal(await s.assertCurrent(authority), null);
});

test('alias plus category and legacy sending clocks without historical outbound identity never grant', async () => {
  const s = setup(); delete s.record.emailHandoff;
  assert.equal(await s.authorize(), null);
});

test('recorded thread without an original historical slot cannot invent one from today’s order', async () => {
  const s = setup(); delete s.record.emailHandoff.slotHash;
  assert.equal(await s.authorize(), null);
});

// These are source-constructor fixtures, not an irreversible handoff. The
// canonical writer separately verifies every ARM/material hash and claim.
function addFrame(s) {
  s.record.attemptId = '00000000-0000-4000-8000-000000000001';
  const path = `${PATH}/submission_receipts/${submissionAttemptHash(s.record.attemptId)}`;
  const frame = { round: 1, emailHandoffHash: qualificationCounterContextHash(s.record.emailHandoff) };
  s.store.docs.set(path, frame);
  return { path, frame };
}

test('a modern lineage selects employer_ack and never claims a legacy authority', async () => {
  const s = setup(); addFrame(s);
  const authority = await s.authorize();
  assert.equal(authority.kind, 'employer_ack');
  assert.equal(authority.attemptId, s.record.attemptId);
  assert.equal(authority.leftAt, 500);
  assert.deepEqual(await s.assertCurrent(authority), authority.proof);
});

test('missing or malformed modern frame never falls back to a legacy receipt', async () => {
  for (const id of ['00000000-0000-4000-8000-000000000001', 'malformed', null]) {
    const s = setup(); s.record.attemptId = id;
    assert.equal(await s.authorize(), null);
  }
});

test('modern lineage requires the recorded payload source rather than legacy-shaped fields', async () => {
  const s = setup(); addFrame(s);
  Object.assign(s.record, { messageId: OUTBOUND, to: 'jobs@employer.example', slotHash: s.record.emailHandoff.slotHash });
  delete s.record.emailHandoff;
  assert.equal(await s.authorize(), null);
});

test('changed modern email handoff hash is held both before and inside final transaction', async () => {
  const s = setup(); const { path, frame } = addFrame(s);
  const authority = await s.authorize(); assert.ok(authority);
  s.store.docs.set(path, { ...frame, emailHandoffHash: '0'.repeat(64) });
  assert.equal(await s.assertCurrent(authority), null);
  assert.equal(await s.authorize(), null);
});

test('a modern frame round mismatch or other immutable frame mutation holds', async () => {
  const s = setup(); const { path, frame } = addFrame(s);
  const authority = await s.authorize(); assert.ok(authority);
  s.store.docs.set(path, { ...frame, sourceFingerprint: 'changed' });
  assert.equal(await s.assertCurrent(authority), null);
  s.store.docs.set(path, { ...frame, round: 2 });
  assert.equal(await s.authorize(), null);
});

test('forged lower authentication headers cannot replace a failing receiving-hop result', async () => {
  const s = setup({ authenticated: false, headers: [
    'Authentication-Results: mx.cloudflare.net; dkim=fail header.d=employer.example',
    'Authentication-Results: sender.example; dkim=pass header.d=employer.example',
  ] });
  assert.equal(await s.authorize(), null);
});

test('unauthenticated native mail stays visible data and cannot confirm a submission', async () => {
  assert.equal(await setup({ authenticated: false }).authorize(), null);
});

test('out-of-office mail is never promoted even when it quotes receipt wording', async () => {
  assert.equal(await setup({ headers: ['Auto-Submitted: auto-replied'] }).authorize(), null);
});

test('registration-only or a generic question is never a receipt', async () => {
  for (const text of ['Your account was successfully created.', 'Could you contact us?']) {
    assert.equal(await setup({ text }).authorize(), null);
  }
});

test('thread IDs are exact opaque values, not prefixes or case-insensitive matches', async () => {
  for (const id of [OUTBOUND.slice(1, -1), OUTBOUND.toUpperCase(), `${OUTBOUND}suffix`]) {
    const s = setup(); s.record.emailHandoff.messageId = id;
    assert.equal(await s.authorize(), null);
  }
});

test('different sender domain, stale receipt, another channel and malformed send clock hold', async () => {
  for (const mutate of [
    s => { s.record.emailHandoff.recipient = 'jobs@other.example'; },
    s => { s.record.startedAt = NOW + 1; },
    s => { s.record.startedAt = Number.NaN; },
    s => { s.record.channel = 'portal'; s.record.clickedAt = 500; },
  ]) {
    const s = setup(); mutate(s); assert.equal(await s.authorize(), null);
  }
});

test('a retargeted current order rejects the historical job slot before authority creation', async () => {
  const s = setup(); s.store.docs.set(PATH, { ...s.order, jobId: 'different-job' });
  assert.equal(await s.authorize(), null);
});

for (const [label, mutate] of [
  ['inbox bytes identity', s => s.store.docs.set(`${PATH}/inbox/${MESSAGE}`, { ...s.claimed, rawSha256: '0'.repeat(64) })],
  ['inbox deletion', s => s.store.docs.delete(`${PATH}/inbox/${MESSAGE}`)],
  ['alias retarget', s => s.store.docs.set(`assisted_application_aliases/${ALIAS}`, { orderId: 'another-order' })],
  ['job retarget', s => s.store.docs.set(PATH, { ...s.order, jobUrl: 'https://employer.example/different-job' })],
]) test(`same-transaction ${label} change vetoes an already prepared authority`, async () => {
  const s = setup(); const authority = await s.authorize(); assert.ok(authority);
  mutate(s); assert.equal(await s.assertCurrent(authority), null);
});

test('receipt truth crosses a later retention deadline without authorizing any payload write', async () => {
  const s = setup(); const authority = await s.authorize(); assert.ok(authority);
  // The canonical writer, not this source capability, chooses the content-free
  // minimum after expiry. Source existence and exact identity still bind it.
  s.store.docs.set(PATH, { ...s.order, retentionPurgingAt: NOW });
  const before = structuredClone([...s.store.docs]);
  assert.deepEqual(await s.assertCurrent(authority), authority.proof);
  assert.deepEqual([...s.store.docs], before);
});

test('physical purge of an immutable source holds even when receipt wording was seen earlier', async () => {
  const s = setup(); addFrame(s); const authority = await s.authorize(); assert.ok(authority);
  s.store.docs.delete(`${PATH}/inbox/${MESSAGE}`);
  s.store.docs.set(PATH, { ...s.order, retentionPurgedAt: NOW });
  const before = structuredClone([...s.store.docs]);
  assert.equal(await s.assertCurrent(authority), null);
  assert.deepEqual([...s.store.docs], before);
});
