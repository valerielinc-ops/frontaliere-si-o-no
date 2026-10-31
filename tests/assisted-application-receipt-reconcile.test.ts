import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reconcileCanonicalSubmissionReceipt } from '../functions/src/assistedApplicationReceiptReconcile.js';
import { submissionGuard } from '../functions/src/assistedApplicationSubmissionGuard.js';
import { createMemoryFirestore } from './helpers/memoryFirestore';
import { transportSourceGuard } from './helpers/submissionSourceGuard';

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__server_timestamp__' },
}));

const orderId = 'receipt-reconcile-fixture';
const base = `assisted_applications/${orderId}`;
const flowPath = `${base}/automation/flow`;
const draftPath = `${base}/ai_drafts/current`;
const submissionPath = `${base}/automation/submission`;
const executionPath = `${base}/automation/execution`;
const now = 1000;
const retentionMs = 90 * 86400000;

beforeEach(() => { vi.spyOn(Date, 'now').mockReturnValue(now); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function sentBeforeCrash(channel: 'email' | 'portal' | 'owner_extension' = 'email') {
  const order = {
    jobId: 'fixture-job', jobUrl: 'https://example.test/jobs/fixture/',
    parentServiceId: 'fixture-service', parentProposalId: 'fixture-proposal',
    cvUploadedAt: now - 100, submissionStatus: 'in_progress',
  };
  const store = createMemoryFirestore({
    [base]: order,
    [flowPath]: { state: channel === 'owner_extension' ? 'owner_takeover' : 'submitting', round: 1,
      heldBy: channel === 'owner_extension' ? ['portal_needs_candidate'] : [], dispatch: { mode: 'submit', round: 1 } },
    [executionPath]: { state: 'expired', leaseUntil: now - 1, executionId: 'old-execution' },
  });
  const guard = submissionGuard(store.db, orderId, 1, { answerSourceGuard: transportSourceGuard() });
  expect((await guard.claim(channel, now)).status).toBe('claimed');
  const material = { at: now, channel, files: [{ kind: 'cv', key: 'synthetic/cv.pdf' }] };
  store.docs.set(draftPath, {
    round: 1, status: 'ready', job: { id: 'fixture-job', title: 'Synthetic role' },
    sentAttempt: { ...material, submissionAttempt: guard.attemptBinding() },
  });
  if (channel === 'email') await guard.markEmailSending(now); else await guard.markClicked(now, channel === 'owner_extension' ? { ownerIntent: Object.fromEntries(
    ['idHash', 'nativeDigest', 'materialDigest', 'submitterDigest', 'assessmentHash'].map(key => [key, 'a'.repeat(64)])) } : {});
  await guard.markSent({ channel, sent: material }, now);
  const [framePath] = store.list(`${base}/submission_receipts/`);
  const frame = store.read(framePath);
  // Server receipt-writer boundary: the durable handoff comes from the real
  // guard; its synthetic acknowledgement is persisted before a simulated crash.
  store.docs.set(framePath, { ...frame, minimalReceipt: {
    status: 'sent', attempt: frame.attemptHash, round: 1, at: now,
    hash: createHash('sha256').update(JSON.stringify(material)).digest('hex'),
  } });
  const writes = vi.fn();
  const transact = store.db.runTransaction;
  store.db.runTransaction = callback => transact(tx => callback({
    ...tx,
    set: (...args) => { writes(args[0].path); return tx.set(...args); },
    delete: ref => { writes(ref.path); return tx.delete(ref); },
  }));
  return { store, guard, framePath, writes, material, input: { db: store.db, orderId, round: 1, nowMs: now } };
}

type Fixture = Awaited<ReturnType<typeof sentBeforeCrash>>;
const snapshot = (fixture: Fixture) => structuredClone([...fixture.store.docs]);

async function expectNoMutation(fixture: Fixture, reason: string) {
  const before = snapshot(fixture);
  expect(await reconcileCanonicalSubmissionReceipt(fixture.input)).toEqual({ handled: true, reason, round: 1 });
  expect(fixture.writes).not.toHaveBeenCalled();
  expect(snapshot(fixture)).toEqual(before);
  expect((await fixture.guard.inspect()).status).toBe('already_sent');
}

describe('canonical SENT receipt reconciliation without another send', () => {
  it.each(['email', 'portal'] as const)('heals the %s crash window despite a stale execution and audits only once', async channel => {
    const fixture = await sentBeforeCrash(channel);
    const { store, input, framePath, writes, material } = fixture;
    const durable = structuredClone(store.read(submissionPath));
    const proof = structuredClone(store.read(framePath));
    const execution = structuredClone(store.read(executionPath));
    const fetch = vi.fn(() => { throw new Error('unexpected outbound request'); });
    vi.stubGlobal('fetch', fetch);

    expect(await reconcileCanonicalSubmissionReceipt(input)).toEqual({ handled: true, reason: 'reconciled', round: 1 });
    expect(store.read(base)).toMatchObject({ submissionStatus: 'submitted', submittedAt: '__server_timestamp__', automationState: 'submitted', automationDueAt: null });
    expect(store.read(flowPath)).toMatchObject({ state: 'submitted', round: 1, submittedVia: channel });
    expect(store.read(draftPath)).toMatchObject({ sent: material, sentAttempt: null });
    expect(store.read(submissionPath)).toEqual(durable);
    expect(store.read(framePath)).toEqual(proof);
    expect(store.read(executionPath)).toEqual(execution);
    const eventPaths = store.list(`${base}/events/`);
    expect(eventPaths).toEqual([
      `${base}/events/receipt-completed-${proof.attemptHash}`,
      `${base}/events/receipt-transition-${proof.attemptHash}`,
    ]);
    expect(store.read(eventPaths[0])).toMatchObject({ eventType: 'manual_submission_completed', toStatus: 'submitted' });
    expect(store.read(eventPaths[1])).toMatchObject({ eventType: 'automation_transition', actor: 'durable_receipt', fromState: 'submitting', toState: 'submitted' });
    expect(new Set(writes.mock.calls.map(([path]) => path))).toEqual(new Set([base, flowPath, draftPath, ...eventPaths]));

    const completed = snapshot(fixture);
    writes.mockClear();
    expect(await reconcileCanonicalSubmissionReceipt(input)).toEqual({ handled: true, reason: 'already_reconciled', round: 1 });
    expect(writes).not.toHaveBeenCalled();
    expect(snapshot(fixture)).toEqual(completed);
    expect(fetch).not.toHaveBeenCalled();
    expect((await submissionGuard(store.db, orderId, 1).claim(channel, now)).status).toBe('already_sent');
    expect(snapshot(fixture)).toEqual(completed);
  });

  it('settles an ambiguous owner hold using the proven send without retrying it', async () => {
    const fixture = await sentBeforeCrash('portal');
    fixture.store.docs.set(flowPath, { state: 'owner_takeover', round: 1, heldBy: ['portal_ambiguous'] });
    expect((await reconcileCanonicalSubmissionReceipt(fixture.input)).reason).toBe('reconciled');
    expect(fixture.store.read(flowPath)).toMatchObject({ state: 'submitted', heldBy: [] });
  });

  it.each(['jobId', 'jobUrl', 'parentServiceId', 'parentProposalId'] as const)('does not apply an old receipt to a changed %s slot', async field => {
    const fixture = await sentBeforeCrash();
    fixture.store.docs.set(base, { ...fixture.store.read(base), [field]: 'different-slot' });
    await expectNoMutation(fixture, 'slot_changed');
  });

  it.each(['flow', 'draft'] as const)('leaves a newer %s round and its material untouched', async changed => {
    const fixture = await sentBeforeCrash();
    const path = changed === 'flow' ? flowPath : draftPath;
    fixture.store.docs.set(path, { ...fixture.store.read(path), round: 2 });
    await expectNoMutation(fixture, 'stale_round');
  });

  it.each(['attempt id', 'attempt round', 'sent material', 'unbound sent material'] as const)('preserves conflicting immutable %s', async changed => {
    const fixture = await sentBeforeCrash();
    const draft = structuredClone(fixture.store.read(draftPath));
    if (changed === 'attempt id') draft.sentAttempt.submissionAttempt.id = 'different-attempt';
    if (changed === 'attempt round') draft.sentAttempt.submissionAttempt.round = 2;
    if (changed === 'sent material') draft.sent = { ...fixture.material, files: [{ kind: 'cv', key: 'different/cv.pdf' }] };
    if (changed === 'unbound sent material') {
      draft.sent = { ...fixture.material, submissionAttempt: { id: 'different-attempt', round: 1 } };
      const ledger = structuredClone(fixture.store.read(submissionPath));
      delete ledger.r1.sent;
      fixture.store.docs.set(submissionPath, ledger);
    }
    fixture.store.docs.set(draftPath, draft);
    await expectNoMutation(fixture, 'material_conflict');
  });

  it.each(['draft job', 'attempt payload'] as const)('does not attribute a receipt to changed %s with the same order and attempt binding', async changed => {
    const fixture = await sentBeforeCrash();
    const order = structuredClone(fixture.store.read(base));
    const draft = structuredClone(fixture.store.read(draftPath));
    const binding = structuredClone(draft.sentAttempt.submissionAttempt);
    if (changed === 'draft job') draft.job = { id: 'different-job', title: 'Different synthetic role' };
    else draft.sentAttempt.files = [{ kind: 'cv', key: 'different/cv.pdf' }];
    fixture.store.docs.set(draftPath, draft);
    expect(fixture.store.read(base)).toEqual(order);
    expect(fixture.store.read(draftPath).sentAttempt.submissionAttempt).toEqual(binding);
    await expectNoMutation(fixture, 'material_conflict');
  });

  it.each(['missing frame', 'attempt hash', 'frame round', 'source fingerprint', 'receipt absent', 'receipt state', 'receipt attempt', 'receipt round', 'receipt hash', 'receipt time'] as const)('rejects %s without adding retained data', async changed => {
    const fixture = await sentBeforeCrash();
    const frame = structuredClone(fixture.store.read(fixture.framePath));
    switch (changed) {
      case 'missing frame': fixture.store.docs.delete(fixture.framePath); break;
      case 'attempt hash': frame.attemptHash = 'a'.repeat(64); break;
      case 'frame round': frame.round = 2; break;
      case 'source fingerprint': frame.sourceFingerprint = 'unverified'; break;
      case 'receipt absent': frame.minimalReceipt = null; break;
      case 'receipt state': frame.minimalReceipt.status = 'sending'; break;
      case 'receipt attempt': frame.minimalReceipt.attempt = 'a'.repeat(64); break;
      case 'receipt round': frame.minimalReceipt.round = 2; break;
      case 'receipt hash': frame.minimalReceipt.hash = 'not-a-digest'; break;
      case 'receipt time': frame.minimalReceipt.at = 0; break;
    }
    if (changed !== 'missing frame') fixture.store.docs.set(fixture.framePath, frame);
    await expectNoMutation(fixture, 'receipt_unbound');
  });

  it('blocks a legacy SENT fact without inventing an attempt binding', async () => {
    const fixture = await sentBeforeCrash();
    const ledger = structuredClone(fixture.store.read(submissionPath));
    delete ledger.r1.attemptId;
    fixture.store.docs.set(submissionPath, ledger);
    await expectNoMutation(fixture, 'legacy_unbound');
  });

  it.each(['order', 'flow'] as const)('does not resurrect a withdrawn %s', async withdrawn => {
    const fixture = await sentBeforeCrash();
    if (withdrawn === 'order') fixture.store.docs.set(base, { ...fixture.store.read(base), withdrawnAt: now });
    else fixture.store.docs.set(flowPath, { ...fixture.store.read(flowPath), state: 'withdrawn' });
    await expectNoMutation(fixture, 'closed_slot');
  });

  it('does not override a non-ambiguous manual hold', async () => {
    const fixture = await sentBeforeCrash();
    fixture.store.docs.set(flowPath, { state: 'owner_takeover', round: 1, heldBy: ['manual_review'] });
    await expectNoMutation(fixture, 'flow_not_compatible');
  });

  it.each(['order deleted', 'flow deleted', 'purging', 'purged', 'expired'] as const)('preserves only the existing send fact after %s', async state => {
    const fixture = await sentBeforeCrash();
    if (state === 'order deleted') fixture.store.docs.delete(base);
    if (state === 'flow deleted') fixture.store.docs.delete(flowPath);
    if (state === 'purging') fixture.store.docs.set(base, { ...fixture.store.read(base), retentionPurgingAt: now });
    if (state === 'purged') fixture.store.docs.set(base, { ...fixture.store.read(base), retentionPurgedAt: now });
    if (state === 'expired') fixture.store.docs.set(base, { ...fixture.store.read(base), cvUploadedAt: now - retentionMs });
    fixture.store.docs.delete(draftPath);
    await expectNoMutation(fixture, 'receipt_only');
    expect(fixture.store.read(draftPath)).toBeUndefined();
    expect(fixture.store.list(`${base}/events/`)).toEqual([]);
  });

  it('rechecks retention after an awaited receipt read and writes nothing at expiry', async () => {
    const fixture = await sentBeforeCrash();
    const dueAt = fixture.store.read(base).cvUploadedAt + retentionMs;
    let entered!: () => void;
    let resume!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const release = new Promise<void>(resolve => { resume = resolve; });
    const transact = fixture.store.db.runTransaction;
    fixture.store.db.runTransaction = callback => transact(tx => callback({ ...tx, get: async ref => {
      const doc = await tx.get(ref);
      if (ref.path === fixture.framePath) { entered(); await release; }
      return doc;
    } }));
    const before = snapshot(fixture);
    const pending = reconcileCanonicalSubmissionReceipt({ ...fixture.input, nowMs: dueAt - 5 });
    await ready;
    vi.mocked(Date.now).mockReturnValue(now + 5);
    resume();
    expect(await pending).toEqual({ handled: true, reason: 'receipt_only', round: 1 });
    expect(fixture.writes).not.toHaveBeenCalled();
    expect(snapshot(fixture)).toEqual(before);
  });

  it.each(['missing', 'sending', 'failed'] as const)('does not manufacture a receipt from a %s send ledger', async state => {
    const fixture = await sentBeforeCrash();
    if (state === 'missing') fixture.store.docs.delete(submissionPath);
    else fixture.store.docs.set(submissionPath, { r1: { ...fixture.store.read(submissionPath).r1, state } });
    const before = snapshot(fixture);
    expect(await reconcileCanonicalSubmissionReceipt(fixture.input)).toEqual({ handled: false, reason: 'not_sent', round: 1 });
    expect(fixture.writes).not.toHaveBeenCalled();
    expect(snapshot(fixture)).toEqual(before);
  });
});


it('reconciles a proven extension send from a nonambiguous owner takeover without another click', async () => {
  const fixture = await sentBeforeCrash('owner_extension');
  expect(await reconcileCanonicalSubmissionReceipt(fixture.input)).toMatchObject({ handled: true, reason: 'reconciled' });
  expect(fixture.store.read(flowPath).state).toBe('submitted');
  const transition = fixture.store.list(`${base}/events/`).map(path => fixture.store.read(path))
    .find(event => event.eventType === 'automation_transition');
  expect(transition.transitionEventType).toBe('owner_submitted');
  expect((await fixture.guard.claim('owner_extension', now + 1)).status).toBe('sent');
});
