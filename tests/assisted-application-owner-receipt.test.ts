import { describe, expect, it, vi } from 'vitest';
import { createMemoryFirestore } from './helpers/memoryFirestore';
import { handleAutomationAdminAction } from '../functions/src/assistedApplicationAutomationAdmin.js';
import { loadRunnerAnswerContext } from '../functions/src/assistedApplicationAnswerEvidence.js';
import { submissionGuard } from '../functions/src/assistedApplicationSubmissionGuard.js';
import { applyAutomationEvent } from '../functions/src/assistedApplicationAutomation.js';
const now = Date.now(); const id = 'synthetic-owner'; const base = `assisted_applications/${id}`;
function fixture() {
  const order = { paymentStatus: 'paid', consentVersion: 'assisted-application-v2', consentedAt: now, cvUploadedAt: now, cvStorageKey: `assisted-application-uploads/${id}/cv.pdf` };
  const flow = { round: 1, state: 'owner_takeover', answers: {}, questionAnswers: {} };
  const draft = { round: 1, status: 'ready', questions: [], cvKey: order.cvStorageKey, sourceCvHash: 'a'.repeat(64) };
  const f = createMemoryFirestore({ [base]: order, [`${base}/automation/flow`]: flow, [`${base}/ai_drafts/current`]: draft });
  const runEffect = vi.fn(async () => ({ ok: true }));
  return { ...f, order, flow, draft, runEffect, call: (extra: any = {}) => handleAutomationAdminAction(f.db,
    { action: 'automationMarkSubmitted', orderId: id, via: 'manual_owner', ...extra }, 'owner@example.test', { nowMs: now, runEffect }) };
}
const intent = { idHash: 'b'.repeat(64), nativeDigest: 'c'.repeat(64), materialDigest: 'd'.repeat(64), submitterDigest: 'e'.repeat(64), assessmentHash: 'f'.repeat(64) };
async function armFixture(f: ReturnType<typeof fixture>) {
  // Construct a private server marker directly: this test covers outcome adoption, not semantic proof admission.
  const context = await loadRunnerAnswerContext({ db: f.db, orderId: id, order: f.order, flow: f.flow, draft: f.draft, nowMs: now });
  const guard = submissionGuard(f.db, id, 1, { answerSourceGuard: context.answerSourceGuard });
  await guard.claim('owner_extension', now, { resumable: true });
  await guard.markClicked(now, { ownerIntent: intent });
}
describe('owner outcome admission uses the immutable captured marker', () => {
  it.each(['submit_acknowledged', 'submit_succeeded'])('keeps an existing minimal truth but writes no projection when %s crosses retention during the transaction', async type => {
    const f = fixture(); f.read(base).cvUploadedAt = now - 90 * 86400000 + 1;
    f.read(`${base}/automation/flow`).state = 'submitting';
    f.docs.set(`${base}/automation/submission`, { r1: { state: 'sent', channel: 'portal' } });
    let wall = now; const clock = vi.spyOn(Date, 'now').mockImplementation(() => wall);
    const original = f.db.runTransaction.bind(f.db);
    f.db.runTransaction = (callback: any) => original((tx: any) => callback({ ...tx, get: async (ref: any) => {
      const snapshot = await tx.get(ref); if (ref.path.endsWith('/automation/submission')) wall = now + 2; return snapshot;
    } }));
    try {
      await expect(applyAutomationEvent({ db: f.db, orderId: id, event: { type, round: 1 }, runEffect: f.runEffect, nowMs: now }))
        .resolves.toMatchObject({ ok: false, ignored: 'retention_expired' });
      expect(f.read(`${base}/automation/flow`).state).toBe('submitting');
      expect(f.read(`${base}/automation/submission`).r1.state).toBe('sent');
      expect(f.runEffect).not.toHaveBeenCalled();
      expect([...f.docs.keys()].filter(path => path.startsWith(`${base}/events/`))).toEqual([]);
    } finally { clock.mockRestore(); }
  });
  it('records an explicit human command as manual assertion without inventing automatic proof', async () => {
    const f = fixture(); await expect(f.call()).resolves.toEqual({ ok: true, state: 'submitted' });
    expect(f.read(`${base}/automation/submission`).r1.provenance).toBe('manual_owner_assertion');
    const frames = [...f.docs].filter(([path]) => path.includes('/submission_receipts/'));
    expect(frames[0][1].sourceFingerprint).toBeUndefined(); expect(f.runEffect).toHaveBeenCalledTimes(1);
  });
  it.each([undefined, 'unknown'])('rejects an absent/unknown command enum before any receipt (via=%s)', async via => {
    const f = fixture(); await expect(f.call({ via })).rejects.toMatchObject({ code: 'submission_command_required', status: 409 });
    expect(f.read(`${base}/automation/submission`)).toBeUndefined(); expect(f.runEffect).not.toHaveBeenCalled();
  });
  it('never treats a missing automatic intent as the explicit human command', async () => {
    const f = fixture(); await expect(f.call({ via: 'extension', round: 1 })).rejects.toMatchObject({ code: 'submission_intent_changed', status: 409 });
    expect(f.read(`${base}/automation/flow`).state).toBe('owner_takeover'); expect(f.runEffect).not.toHaveBeenCalled();
  });
  it.each(['unchanged', 'source_changed_after_click', 'purged_after_click', 'round_advanced'])('adopts %s without rechecking qualification after the click', async mode => {
    const f = fixture(); await armFixture(f);
    if (mode === 'source_changed_after_click') f.read(base).candidateNotes = 'Changed AFTER the marker';
    if (mode === 'purged_after_click') {
      f.read(base).retentionPayloadPurgedAt = now + 1;
      for (const suffix of ['/automation/flow', '/ai_drafts/current', '/automation/submission']) f.docs.delete(base + suffix);
    }
    if (mode === 'round_advanced') { f.read(`${base}/automation/flow`).round = 2; f.read(`${base}/ai_drafts/current`).round = 2; }
    const result: any = await f.call({ via: 'extension', round: 1, ownerIntent: intent }); expect(result.ok).toBe(true);
    if (mode === 'purged_after_click') {
      expect(result.receiptOnly).toBe(true); expect(f.read(`${base}/automation/flow`)).toBeUndefined();
      expect(f.read(`${base}/automation/submission`)).toBeUndefined(); expect(f.runEffect).not.toHaveBeenCalled();
    } else if (mode === 'round_advanced') {
      expect(f.read(`${base}/automation/flow`)).toMatchObject({ round: 2, state: 'owner_takeover' }); expect(f.runEffect).not.toHaveBeenCalled();
    } else {
      expect(f.read(`${base}/automation/submission`).r1.state).toBe('sent');
      expect(f.read(`${base}/automation/flow`).state).toBe('submitted');
    }
  });
  it('does not publish a flow/event if purge begins between receipt and outcome projection', async () => {
    const f = fixture(); await armFixture(f); const transact = f.db.runTransaction.bind(f.db); let changed = false;
    f.db.runTransaction = async (callback: any) => {
      const result = await transact(callback);
      if (!changed && f.read(`${base}/automation/submission`)?.r1?.state === 'sent') { changed = true; f.read(base).retentionPurgingAt = now + 1; }
      return result;
    };
    await expect(f.call({ via: 'extension', round: 1, ownerIntent: intent })).resolves.toMatchObject({ ok: true, receiptRecorded: true });
    expect(f.read(`${base}/automation/flow`).state).toBe('owner_takeover'); expect(f.runEffect).not.toHaveBeenCalled();
    expect([...f.docs.keys()].filter(path => path.startsWith(`${base}/events/`))).toEqual([]);
  });
});
