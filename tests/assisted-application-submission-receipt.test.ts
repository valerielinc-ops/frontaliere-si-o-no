import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryFirestore } from './helpers/memoryFirestore';

vi.mock('../functions/src/remoteConfigSecrets.js', () => ({
  getRemoteConfigValue: vi.fn(async () => ''),
  bridgeEmailCascadeCredentialsToEnv: vi.fn(async () => {}),
}));

const { runAutomationSweep, handleRunnerEvent, applyAutomationEvent } = await import('../functions/src/assistedApplicationAutomation.js');
const { reconcileSubmissionReceipt } = await import('../functions/src/assistedApplicationReceiptReconcile.js');
const { SUBMISSION_RECEIPT_RETRY_LIMIT } = await import('../functions/src/assistedApplicationReceiptReconcile.js');
const { runAutomationEffect } = await import('../functions/src/assistedApplicationAutomationEffects.js');
const { submissionGuard } = await import('../functions/src/assistedApplicationSubmissionGuard.js');
const { createSubmissionReceipt, verifySubmissionReceipt } = await import('../functions/src/lib/submissionReceiptContract.js');

const ORDER = 'order_receipt_test';
const ROOT = `assisted_applications/${ORDER}`;
const T0 = Date.UTC(2026, 9, 20, 12);
const sent = {
  at: T0, channel: 'portal', packaging: 'separate', files: [{ kind: 'cv', name: 'Candidate_CV.pdf', key: `assisted-application-uploads/${ORDER}/cv.pdf` }],
};
let store: ReturnType<typeof createMemoryFirestore>;
let effects: any[];

function flow(state = 'submitting', round = 1) {
  return { state, round, heldBy: [], submittedVia: null, dispatch: { mode: 'submit', round, attempts: 1, requestedAt: T0 }, answers: {} };
}

async function seedReceipt() {
  const guard = submissionGuard(store.db, ORDER, 1);
  const claim = await guard.claim('portal', T0);
  await guard.markClicked(T0, { formBinding: 'a'.repeat(64) });
  const receipt = await guard.markSent({ channel: 'portal', finalUrl: 'https://ats.example/application/confirmation', sent }, T0, {
    kind: 'portal_success_page', attemptId: claim.attemptId, observedAt: T0,
    evidence: { finalUrl: 'https://ats.example/application/confirmation' },
  });
  return { guard, receipt };
}

beforeEach(() => {
  store = createMemoryFirestore({
    [ROOT]: { paymentStatus: 'paid', submissionStatus: 'in_progress', automationDueAt: T0 + 60_000 },
    [`${ROOT}/automation/flow`]: flow(),
    [`${ROOT}/ai_drafts/current`]: { round: 1, status: 'ready', questions: [] },
  });
  effects = [];
});

describe('durable submission receipts', () => {
  it('stores a content-free receipt bound to round, attempt and sent material', () => {
    const sentRecord = { fileName: 'Candidate_Rossi_CV.pdf', to: 'candidate@example.test', optional: undefined };
    const receipt = createSubmissionReceipt({
      orderId: ORDER, round: 1, attemptId: 'attempt_1', channel: 'email', proofKind: 'email_provider_accepted',
      observedAt: T0, evidence: { provider: 'mailer', messageId: 'private-message-id' },
      sentRecord,
    });
    expect(receipt).not.toBeNull();
    expect(JSON.stringify(receipt)).not.toContain('candidate@example.test');
    expect(JSON.stringify(receipt)).not.toContain('Candidate_Rossi_CV.pdf');
    expect(JSON.stringify(receipt)).not.toContain('private-message-id');
    expect(verifySubmissionReceipt(receipt, { orderId: ORDER, round: 1, attemptId: 'attempt_1' })).toBe(true);
    expect(verifySubmissionReceipt(receipt, { sentRecord: JSON.parse(JSON.stringify(sentRecord)) })).toBe(true);
    expect(verifySubmissionReceipt(receipt, { orderId: ORDER, round: 2 })).toBe(false);
    expect(verifySubmissionReceipt({ ...receipt!, extra: 'untrusted' })).toBe(false);
  });

  it('reconciles a lost runner acknowledgement from the durable proof and never redispatches', async () => {
    const { guard, receipt } = await seedReceipt();
    expect(receipt?.receiptId).toMatch(/^[a-f0-9]{40}$/);
    expect(await guard.read()).toMatchObject({ state: 'sent', receipt: { receiptId: receipt?.receiptId } });
    const runEffect = async (context: any) => {
      effects.push(context.effect);
      return runAutomationEffect(context);
    };

    const summary = await runAutomationSweep({ db: store.db, nowMs: T0 + 1, runEffect });

    expect(summary).toMatchObject({ receiptsReconciled: 1, redispatched: 0 });
    expect(store.read(`${ROOT}/automation/flow`)).toMatchObject({ state: 'submitted', submittedVia: 'portal' });
    expect(store.read(ROOT)).toMatchObject({ submissionStatus: 'submitted', submissionReceiptDueAt: null });
    expect(effects).toEqual([{ type: 'mark_submitted' }]);

    const again = await runAutomationSweep({ db: store.db, nowMs: T0 + 60_000, runEffect });
    expect(again).toMatchObject({ receiptsReconciled: 0, redispatched: 0 });
    expect(effects).toHaveLength(1);
  });

  it('rejects a runner success without a matching durable receipt', async () => {
    const eventRef = await store.db.collection('assisted_applications').doc(ORDER).collection('automation_events').add({
      type: 'submit_succeeded', channel: 'portal', round: 1,
    });
    const result = await handleRunnerEvent({ db: store.db, orderId: ORDER, eventRef, data: store.read(eventRef.path), nowMs: T0 });
    expect(result).toMatchObject({ ok: false, ignored: 'submission_receipt_missing' });
    expect(store.read(`${ROOT}/automation/flow`)?.state).toBe('submitting');
    expect(store.read(ROOT)?.submissionStatus).toBe('in_progress');
  });

  it('accepts a runner success only when it names the persisted receipt', async () => {
    const { receipt } = await seedReceipt();
    const eventRef = await store.db.collection('assisted_applications').doc(ORDER).collection('automation_events').add({
      type: 'submit_succeeded', round: 1, channel: 'portal', receiptId: receipt?.receiptId,
    });
    const runEffect = async (context: any) => runAutomationEffect(context);
    const result = await handleRunnerEvent({ db: store.db, orderId: ORDER, eventRef, data: store.read(eventRef.path), runEffect, nowMs: T0 + 1 });
    expect(result).toMatchObject({ ok: true, flow: { state: 'submitted' } });
    expect(store.read(ROOT)?.submissionStatus).toBe('submitted');
  });

  it('keeps a defaulted round-1 runner receipt from submitting round 2', async () => {
    const { receipt } = await seedReceipt();
    await store.db.collection('assisted_applications').doc(ORDER).collection('automation').doc('flow').set(flow('submitting', 2));
    const eventRef = await store.db.collection('assisted_applications').doc(ORDER).collection('automation_events').add({
      type: 'submit_succeeded', channel: 'portal', receiptId: receipt?.receiptId,
    });

    const result = await handleRunnerEvent({
      db: store.db, orderId: ORDER, eventRef, data: store.read(eventRef.path),
      runEffect: async context => { effects.push(context.effect); return { ok: true }; },
      nowMs: T0 + 1,
    });

    expect(result).toMatchObject({ ok: false, ignored: 'stale_round', state: 'submitting' });
    expect(store.read(`${ROOT}/automation/flow`)).toMatchObject({ state: 'submitting', round: 2 });
    expect(store.read(eventRef.path)).toMatchObject({ result: 'ignored:stale_round' });
    expect(store.read(ROOT)?.submissionStatus).toBe('in_progress');
    expect(effects).toEqual([]);
  });

  it('keeps a handoff receipt immutable and durably records a later candidate confirmation', async () => {
    const guard = submissionGuard(store.db, ORDER, 1);
    const claim = await guard.claim('whatsapp', T0);
    const handoff = await guard.markSent({ channel: 'whatsapp', sent }, T0, {
      kind: 'candidate_handoff_link', attemptId: claim.attemptId, observedAt: T0,
      evidence: { url: 'https://wa.me/41790000000' },
    });
    store.docs.set(`${ROOT}/automation/flow`, flow('candidate_handoff'));

    const confirmation = await submissionGuard(store.db, ORDER, 1).markSent({
      channel: 'candidate', confirmedBy: 'candidate', confirmedAt: T0 + 1, sent,
    }, T0 + 1, {
      kind: 'candidate_confirmation', attemptId: 'candidate_confirm_1', observedAt: T0 + 1,
      submissionAttemptId: claim.attemptId,
      evidence: { actor: 'candidate-id', confirmedAt: T0 + 1 },
    });
    const persisted = store.read(`${ROOT}/automation/submission`)?.r1;

    expect(persisted?.receipt).toMatchObject({ receiptId: handoff?.receiptId, proofKind: 'candidate_handoff_link' });
    expect(persisted?.confirmationReceipts?.candidate).toMatchObject({
      receiptId: confirmation?.receiptId, proofKind: 'candidate_confirmation', attemptId: 'candidate_confirm_1',
    });
    const runEffect = async (context: any) => runAutomationEffect(context);
    const result = await runAutomationSweep({ db: store.db, nowMs: T0 + 2, runEffect });
    expect(result).toMatchObject({ receiptsReconciled: 1, redispatched: 0 });
    expect(store.read(`${ROOT}/automation/flow`)?.state).toBe('submitted');
    expect(store.read(ROOT)).toMatchObject({ submissionStatus: 'submitted', submissionReceiptDueAt: null });
  });

  it('reconciles a candidate confirmation after the flow commits but its submitted projection fails', async () => {
    const guard = submissionGuard(store.db, ORDER, 1);
    const claim = await guard.claim('whatsapp', T0);
    const handoff = await guard.markSent({ channel: 'whatsapp', sent }, T0, {
      kind: 'candidate_handoff_link', attemptId: claim.attemptId, observedAt: T0,
      evidence: { url: 'https://wa.me/41790000000' },
    });
    store.docs.set(`${ROOT}/automation/flow`, flow('candidate_handoff'));
    const record = await guard.read();
    const candidateProof = {
      kind: 'candidate_confirmation', attemptId: 'candidate_confirm_reconcile',
      submissionAttemptId: record?.attemptId, observedAt: T0 + 1,
      evidence: { actor: 'candidate-id', confirmedAt: T0 + 1 },
    };
    const committed = await applyAutomationEvent({
      db: store.db, orderId: ORDER, event: { type: 'candidate_confirmed_submitted' },
      actor: 'candidate', nowMs: T0 + 1, expectedRound: 1,
      writeSubmissionReceipt: ({ transaction }: any) => guard.markSent({
        channel: 'candidate', confirmedBy: 'candidate', confirmedAt: T0 + 1, sent,
      }, T0 + 1, candidateProof, { transaction }),
      runEffect: async () => ({ ok: false, error: 'projection_not_applied' }),
    });
    expect(committed).toMatchObject({ ok: true, flow: { state: 'submitted' } });
    expect(store.read(`${ROOT}/automation/submission`)?.r1).toMatchObject({
      attemptId: claim.attemptId,
      receipt: { receiptId: handoff?.receiptId, proofKind: 'candidate_handoff_link' },
      confirmationReceipts: { candidate: { attemptId: 'candidate_confirm_reconcile' } },
    });

    const summary = await runAutomationSweep({ db: store.db, nowMs: T0 + 2, runEffect: async context => {
      effects.push(context.effect);
      return runAutomationEffect(context);
    } });

    expect(summary).toMatchObject({ receiptsReconciled: 1, redispatched: 0 });
    expect(effects).toEqual([{ type: 'mark_submitted' }]);
    expect(store.read(ROOT)).toMatchObject({ submissionStatus: 'submitted', submissionReceiptDueAt: null });
  });

  it('rejects a candidate confirmation if its live submission attempt was superseded after the precheck', async () => {
    const guard = submissionGuard(store.db, ORDER, 1);
    const claim = await guard.claim('whatsapp', T0);
    const handoff = await guard.markSent({ channel: 'whatsapp', sent }, T0, {
      kind: 'candidate_handoff_link', attemptId: claim.attemptId, observedAt: T0,
      evidence: { url: 'https://wa.me/41790000000' },
    });
    const submissionPath = `${ROOT}/automation/submission`;
    const originalTransaction = store.db.runTransaction.bind(store.db);
    const transaction = vi.spyOn(store.db, 'runTransaction').mockImplementation(async (callback: any) => {
      const submission = store.read(submissionPath);
      store.docs.set(submissionPath, { ...submission, r1: { ...submission.r1, attemptId: 'attempt-new' } });
      return originalTransaction(callback);
    });

    try {
      await expect(submissionGuard(store.db, ORDER, 1).markSent({
        channel: 'candidate', confirmedBy: 'candidate', confirmedAt: T0 + 1, sent,
      }, T0 + 1, {
        kind: 'candidate_confirmation', attemptId: 'candidate_confirm_2',
        submissionAttemptId: claim.attemptId,
        observedAt: T0 + 1, evidence: { actor: 'candidate-id', confirmedAt: T0 + 1 },
      })).rejects.toThrow('submission_attempt_superseded');
      expect(store.read(submissionPath)?.r1).toMatchObject({
        state: 'sent', attemptId: 'attempt-new', receipt: { receiptId: handoff?.receiptId },
      });
      expect(store.read(submissionPath)?.r1?.confirmationReceipts?.candidate).toBeUndefined();
    } finally {
      transaction.mockRestore();
    }
  });

  it('does not replay a candidate confirmation against a different live attempt', async () => {
    const guard = submissionGuard(store.db, ORDER, 1);
    const claim = await guard.claim('whatsapp', T0);
    await guard.markSent({ channel: 'whatsapp', sent }, T0, {
      kind: 'candidate_handoff_link', attemptId: claim.attemptId, observedAt: T0,
      evidence: { url: 'https://wa.me/41790000000' },
    });
    const confirmationRecord = { channel: 'candidate', confirmedBy: 'candidate', confirmedAt: T0 + 1, sent };
    const confirmationProof = {
      kind: 'candidate_confirmation', attemptId: 'candidate_confirm_replay',
      submissionAttemptId: claim.attemptId, observedAt: T0 + 1,
      evidence: { actor: 'candidate-id', confirmedAt: T0 + 1 },
    };
    await submissionGuard(store.db, ORDER, 1).markSent(confirmationRecord, T0 + 1, confirmationProof);
    const submissionPath = `${ROOT}/automation/submission`;
    const submission = store.read(submissionPath);
    store.docs.set(submissionPath, { ...submission, r1: { ...submission.r1, attemptId: 'attempt-new' } });

    await expect(submissionGuard(store.db, ORDER, 1).markSent(confirmationRecord, T0 + 2, {
      ...confirmationProof, submissionAttemptId: 'attempt-new', observedAt: T0 + 2,
    })).rejects.toThrow('submission_attempt_superseded');
    expect(store.read(submissionPath)?.r1?.confirmationReceipts?.candidate?.attemptId).toBe('candidate_confirm_replay');
  });

  it('does not replay a primary candidate receipt after its live attempt changes', async () => {
    const proof = {
      kind: 'candidate_confirmation', attemptId: 'candidate_confirm_primary',
      submissionAttemptId: null, observedAt: T0 + 1,
      evidence: { actor: 'candidate-id', confirmedAt: T0 + 1 },
    };
    await submissionGuard(store.db, ORDER, 1).markSent({
      channel: 'candidate', confirmedBy: 'candidate', confirmedAt: T0 + 1, sent,
    }, T0 + 1, proof);
    const submissionPath = `${ROOT}/automation/submission`;
    const submission = store.read(submissionPath);
    store.docs.set(submissionPath, { ...submission, r1: { ...submission.r1, attemptId: 'attempt-new' } });

    await expect(submissionGuard(store.db, ORDER, 1).markSent({
      channel: 'candidate', confirmedBy: 'candidate', confirmedAt: T0 + 2, sent,
    }, T0 + 2, { ...proof, submissionAttemptId: 'attempt-new', observedAt: T0 + 2 }))
      .rejects.toThrow('submission_attempt_superseded');
    expect(store.read(submissionPath)?.r1?.receipt?.attemptId).toBe('candidate_confirm_primary');
  });

  it('keeps a candidate confirmation separate when a legacy handoff has no primary receipt', async () => {
    store.docs.set(`${ROOT}/automation/submission`, { r1: {
      state: 'sending', channel: 'portal', attemptId: 'legacy-handoff', clickedAt: T0, confirmedNotSent: false, sent,
    } });
    store.docs.set(`${ROOT}/automation/flow`, flow('candidate_handoff'));

    const confirmation = await submissionGuard(store.db, ORDER, 1).markSent({
      channel: 'candidate', confirmedBy: 'candidate', confirmedAt: T0 + 1, sent,
    }, T0 + 1, {
      kind: 'candidate_confirmation', attemptId: 'candidate_confirm_legacy',
      submissionAttemptId: 'legacy-handoff',
      observedAt: T0 + 1, evidence: { actor: 'candidate-id', confirmedAt: T0 + 1 },
    });
    const persisted = store.read(`${ROOT}/automation/submission`)?.r1;

    expect(persisted).toMatchObject({ state: 'sending', channel: 'portal', attemptId: 'legacy-handoff', confirmedNotSent: false });
    expect(persisted?.receipt).toBeUndefined();
    expect(persisted?.confirmationReceipts?.candidate).toMatchObject({
      receiptId: confirmation?.receiptId, proofKind: 'candidate_confirmation', attemptId: 'candidate_confirm_legacy',
    });
    expect(verifySubmissionReceipt(persisted?.confirmationReceipts?.candidate, {
      orderId: ORDER, round: 1, attemptId: 'candidate_confirm_legacy', channel: 'candidate', sentRecord: sent,
    })).toBe(true);

    const summary = await runAutomationSweep({ db: store.db, nowMs: T0 + 2, runEffect: async context => {
      effects.push(context.effect);
      return runAutomationEffect(context);
    } });
    expect(summary).toMatchObject({ receiptsReconciled: 1, redispatched: 0 });
    expect(effects).toEqual([{ type: 'mark_submitted', by: 'candidate' }]);
    expect(store.read(`${ROOT}/automation/submission`)?.r1?.state).toBe('sending');
    expect(store.read(ROOT)).toMatchObject({ submissionStatus: 'submitted', submissionReceiptDueAt: null });
  });

  it('refuses the final click if the flow moved to owner takeover after claim', async () => {
    const guard = submissionGuard(store.db, ORDER, 1);
    await guard.claim('portal', T0);
    store.docs.set(`${ROOT}/automation/flow`, flow('owner_takeover'));
    await expect(guard.markClicked(T0 + 1, { formBinding: 'a'.repeat(64) })).rejects.toThrow('submission_superseded');
    expect((await guard.read())?.clickedAt).toBeFalsy();
  });

  it('keeps retrying a due receipt with bounded backoff when its flow record is missing', async () => {
    await seedReceipt();
    store.docs.delete(`${ROOT}/automation/flow`);
    const summary = await runAutomationSweep({ db: store.db, nowMs: T0 + 1,
      runEffect: async () => { throw new Error('missing flow cannot dispatch'); } });
    expect(summary.redispatched).toBe(0);
    expect(store.read(ROOT)).toMatchObject({
      automationDueAt: null,
      submissionReceiptDueAt: T0 + 60_001,
      submissionReceiptAttempts: 1,
      submissionReceiptStatus: 'pending',
      submissionReceiptIssue: 'flow_not_reconcilable',
    });
  });

  it('does not reconcile a material hash that changed after the receipt was written', async () => {
    await seedReceipt();
    const submissionRef = store.db.collection('assisted_applications').doc(ORDER).collection('automation').doc('submission');
    await submissionRef.set({ r1: { sent: { ...sent, files: [] } } }, { merge: true });
    const result = await reconcileSubmissionReceipt({
      db: store.db, orderId: ORDER, nowMs: T0 + 1,
      applyEvent: async () => { throw new Error('must not apply without the original material hash'); },
    });
    expect(result).toMatchObject({ reconciled: false, reason: 'receipt_missing_or_invalid' });
    expect(store.read(`${ROOT}/automation/flow`)?.state).toBe('submitting');
    expect(store.read(ROOT)?.submissionStatus).toBe('in_progress');
  });

  it('retries the same attempt idempotently after a repeated markSent call', async () => {
    const guard = submissionGuard(store.db, ORDER, 1);
    const claim = await guard.claim('email', T0);
    const record = { channel: 'email', provider: 'mailer', messageId: 'message-2', sent };
    const proof = { kind: 'email_provider_accepted', attemptId: claim.attemptId, observedAt: T0, evidence: { provider: 'mailer', messageId: 'message-2' } };
    const first = await guard.markSent(record, T0, proof);
    const retry = await guard.markSent(record, T0 + 10, proof);
    expect(retry?.receiptId).toBe(first?.receiptId);
    expect(await guard.read()).toMatchObject({ state: 'sent', receipt: { receiptId: first?.receiptId } });
  });

  it('stops receipt reconciliation after the bounded retry limit and records a content-free review state', async () => {
    await seedReceipt();
    store.docs.set(ROOT, { ...store.read(ROOT), submissionReceiptDueAt: T0, submissionReceiptAttempts: SUBMISSION_RECEIPT_RETRY_LIMIT - 1 });
    store.docs.set(`${ROOT}/automation/flow`, flow('candidate_questions'));
    const result = await reconcileSubmissionReceipt({ db: store.db, orderId: ORDER, nowMs: T0 + 1,
      applyEvent: async () => { throw new Error('must not apply from a non-submission state'); } });
    expect(result).toMatchObject({ reconciled: false, pending: true, reason: 'flow_not_reconcilable' });
    expect(store.read(ROOT)).toMatchObject({ submissionReceiptDueAt: null, submissionReceiptStatus: 'needs_review',
      submissionReceiptIssue: 'flow_not_reconcilable', submissionReceiptAttempts: SUBMISSION_RECEIPT_RETRY_LIMIT });
  });

  it('stops retrying an invalid receipt without ever marking the order submitted', async () => {
    await seedReceipt();
    const submissionPath = `${ROOT}/automation/submission`;
    store.docs.set(submissionPath, { r1: { ...store.read(submissionPath).r1, receipt: null } });
    store.docs.set(ROOT, { ...store.read(ROOT), submissionReceiptDueAt: T0, submissionReceiptAttempts: SUBMISSION_RECEIPT_RETRY_LIMIT - 1 });
    const result = await reconcileSubmissionReceipt({ db: store.db, orderId: ORDER, nowMs: T0 + 1,
      applyEvent: async () => { throw new Error('must not apply without a valid receipt'); } });
    expect(result).toMatchObject({ reconciled: false, reason: 'receipt_missing_or_invalid' });
    expect(store.read(ROOT)).toMatchObject({ submissionReceiptDueAt: null, submissionReceiptStatus: 'needs_review',
      submissionReceiptIssue: 'receipt_missing_or_invalid', submissionReceiptAttempts: SUBMISSION_RECEIPT_RETRY_LIMIT,
      submissionStatus: 'in_progress' });
    const retryEffects: any[] = [];
    const retrySummary = await runAutomationSweep({ db: store.db, nowMs: T0 + 60_000,
      runEffect: async (context: any) => { retryEffects.push(context.effect); return runAutomationEffect(context); } });
    expect(retrySummary.redispatched).toBe(0);
    expect(retryEffects).toEqual([]);
    expect(store.read(ROOT)).toMatchObject({ submissionReceiptAttempts: SUBMISSION_RECEIPT_RETRY_LIMIT,
      submissionReceiptStatus: 'needs_review', submissionReceiptDueAt: null });
  });

  it('upgrades a genuine pre-attempt legacy send from its existing provider proof', async () => {
    store.docs.set(`${ROOT}/automation/submission`, { r1: {
      state: 'sent', channel: 'email', provider: 'mailer', messageId: 'legacy-message', sentAt: T0, sent,
    } });
    const result = await reconcileSubmissionReceipt({
      db: store.db, orderId: ORDER, nowMs: T0 + 1,
      applyEvent: async () => ({ ok: true }),
    });
    expect(result).toMatchObject({ receiptVerified: true, receiptId: expect.any(String) });
    expect(store.read(`${ROOT}/automation/submission`)?.r1).toMatchObject({
      state: 'sent', attemptId: expect.stringMatching(/^legacy-/), receipt: { proofKind: 'email_provider_accepted' },
    });
  });
});
