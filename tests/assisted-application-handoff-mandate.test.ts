import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { submissionGuard } from '../functions/src/assistedApplicationSubmissionGuard.js';
import { submissionSlotHash } from '../functions/src/lib/submissionReceiptContract.js';
import { createMemoryFirestore } from './helpers/memoryFirestore';
const now = 1_800_000_000_000;
const orderId = 'mandate_fixture'; const base = `assisted_applications/${orderId}`;
beforeEach(() => { vi.spyOn(Date, 'now').mockReturnValue(now); });
afterEach(() => { vi.restoreAllMocks(); });
async function fixture(channel: string, patch = {}, sourceMutation?: (store: any) => void) {
  const order = { paymentStatus: 'paid', consentVersion: 'assisted-application-v2', consentedAt: now - 1000, cvUploadedAt: now - 1000, ...patch };
  const store = createMemoryFirestore({ [base]: order, [`${base}/automation/flow`]: { round: 1, state: channel === 'owner_extension' ? 'owner_takeover' : 'submitting',
    dispatch: { mode: 'submit', round: 1 } }, [`${base}/ai_drafts/current`]: { round: 1, status: 'ready' } });
  const source = { fingerprint: 'a'.repeat(64), async assertInTransaction(tx: any) {
    await tx.get(store.db.collection('assisted_applications').doc(orderId)); sourceMutation?.(store);
  } };
  const guard = submissionGuard(store.db, orderId, 1, { answerSourceGuard: source, receiptClock: () => now + 10 });
  await guard.claim(channel, now);
  const emailHandoff = { messageId: '<aa-mandate@example.test>', recipient: 'hr@example.test', slotHash: submissionSlotHash({ orderId, order }) };
  const ownerIntent = Object.fromEntries(['idHash', 'nativeDigest', 'materialDigest', 'submitterDigest', 'assessmentHash'].map(key => [key, 'b'.repeat(64)]));
  const mark = () => channel === 'email' ? guard.markEmailSending(now + 1, { emailHandoff }) : guard.markClicked(now + 1, { ownerIntent });
  return { store, guard, mark };
}

describe('every new handoff requires the current paid mandate', () => {
  it.each(['email', 'portal', 'owner_extension'])('accepts paid supported v1/v2 for %s with no qualification/policy claim shortcut', async channel => {
    for (const consentVersion of ['assisted-application-v1', 'assisted-application-v2']) {
      const f = await fixture(channel, { consentVersion }); await f.mark();
      expect(f.store.list(`${base}/submission_receipts/`)).toHaveLength(1);
    }
  });
  it.each([
    { paymentStatus: 'pending' }, { consentVersion: null }, { consentVersion: 'unknown-version' }, { consentedAt: null },
    { consentedAt: 0 }, { consentedAt: NaN }, { consentedAt: now + 60_000 },
    ...['pending', 'completed', 'succeeded', 'refunded'].map(refundStatus => ({ refundStatus })),
  ])('vetoes invalid current authority %j for all channels', async patch => {
    for (const channel of ['email', 'portal', 'owner_extension']) {
      const f = await fixture(channel, patch);
      await expect(f.mark()).rejects.toMatchObject({ code: 'evidence_source_changed' });
      expect(f.store.list(`${base}/submission_receipts/`)).toHaveLength(0);
      expect(f.store.read(`${base}/automation/submission`).r1.clickedAt).toBeNull();
      expect(f.store.read(`${base}/automation/submission`).r1.emailHandoff).toBeUndefined();
    }
  });
  it.each(['email', 'portal', 'owner_extension'])('rechecks a refund changed during the final source await for %s', async channel => {
    const f = await fixture(channel, {}, store => { store.read(base).refundStatus = 'pending'; });
    await expect(f.mark()).rejects.toMatchObject({ code: 'evidence_source_changed' });
    expect(f.store.list(`${base}/submission_receipts/`)).toHaveLength(0);
  });
  it('records actual delivery truth after authority changes and preserves SENT priority', async () => {
    const f = await fixture('portal'); await f.mark();
    Object.assign(f.store.read(base), { paymentStatus: 'refunded', consentVersion: null, withdrawnAt: now + 2 });
    await f.guard.markSent({ channel: 'portal', confirmed: 'synthetic_actual_receipt' }, now + 3);
    expect(f.store.read(`${base}/automation/submission`).r1.state).toBe('sent');
    await expect(f.guard.markClicked(now + 4)).rejects.toMatchObject({ code: 'submission_already_sent' });
  });
});
