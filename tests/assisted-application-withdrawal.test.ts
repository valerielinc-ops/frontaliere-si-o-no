import { describe, expect, it } from 'vitest';
import { createMemoryFirestore } from './helpers/memoryFirestore';
import { canWithdrawApplication, withdrawAssistedApplication } from '../functions/src/assistedApplicationWithdrawal.js';
import { submissionGuard } from '../functions/src/assistedApplicationSubmissionGuard.js';
import { transition } from '../functions/src/assistedApplicationFlow.js';

const now = Date.now();
const orderId = 'order_withdraw_test';
const path = `assisted_applications/${orderId}`;
const parent = 'application_concierge_services/service_withdraw_test';
function fixture() {
  return createMemoryFirestore({
    [path]: { billingMode: 'application_concierge', paymentStatus: 'paid', userId: 'candidate_test', parentServiceId: 'service_withdraw_test', parentProposalId: 'proposal_test', submissionStatus: 'in_progress' },
    [`${path}/automation/flow`]: { state: 'submitting', round: 1, dispatch: { mode: 'submit', round: 1 } },
    [`${path}/ai_drafts/current`]: { status: 'ready', round: 1 },
    [parent]: { userId: 'candidate_test', paymentStatus: 'paid', serviceStatus: 'active', acceptedPositionsCount: 4, expiresAt: new Date(now + 86400000) },
    [`${parent}/proposals/proposal_test`]: { status: 'accepted', childApplicationId: orderId },
  });
}

describe('candidate withdrawal and slot release', () => {
  it('releases one slot exactly once, keeps expiry and schedules replenishment', async () => {
    const store = fixture();
    const expiresAt = store.read(parent).expiresAt;
    const withdraw = () => withdrawAssistedApplication({ db: store.db, orderId, round: 1, nowMs: now });
    expect(await withdraw()).toMatchObject({ state: 'withdrawn', slotReleased: true });
    expect(await withdraw()).toMatchObject({ state: 'withdrawn', slotReleased: true });
    expect(store.read(parent)).toMatchObject({ acceptedPositionsCount: 3, expiresAt, proposalRefreshRequestedBy: 'candidate_withdrawal' });
    expect(store.read(`${parent}/proposals/proposal_test`).status).toBe('declined');
    expect(store.read(path)).toMatchObject({ automationState: 'withdrawn', submissionStatus: 'withdrawn', automationDueAt: null });
    expect(store.list(`${path}/events/`)).toHaveLength(1);
    for (const type of ['tick', 'owner_resume', 'owner_retry_submit', 'submit_failed', 'submit_succeeded']) {
      expect(transition(store.read(`${path}/automation/flow`), { type }).ignored).toBe('withdrawn');
    }
  });

  it('fences a portal already filling fields before its final click', async () => {
    const store = fixture();
    const guard = submissionGuard(store.db, orderId, 1);
    expect((await guard.claim('portal', now)).status).toBe('claimed');
    await withdrawAssistedApplication({ db: store.db, orderId, round: 1, nowMs: now + 1 });
    await expect(guard.markClicked(now + 2)).rejects.toThrow('application_withdrawn');
    expect((await guard.claim('portal', now + 3, { resumable: true })).status).toBe('withdrawn');
    expect((await guard.claim('email', now + 3)).status).toBe('withdrawn');
  });

  it.each(['email_started', 'portal_clicked', 'prior_round_sent', 'draft_sent', 'foreign_parent', 'stale_round'])('refuses %s without releasing a slot', async kind => {
    const store = fixture();
    if (kind === 'email_started' || kind === 'portal_clicked') {
      const guard = submissionGuard(store.db, orderId, 1);
      await guard.claim(kind === 'email_started' ? 'email' : 'portal', now);
      if (kind === 'portal_clicked') await guard.markClicked(now);
    }
    if (kind === 'prior_round_sent') store.docs.set(`${path}/automation/submission`, { r2: { state: 'sent' } });
    if (kind === 'draft_sent') store.docs.set(`${path}/ai_drafts/current`, { sent: { at: now } });
    if (kind === 'foreign_parent') store.docs.set(parent, { ...store.read(parent), userId: 'different_candidate' });
    await expect(withdrawAssistedApplication({ db: store.db, orderId, round: kind === 'stale_round' ? 2 : 1, nowMs: now })).rejects.toThrow();
    expect(store.read(parent).acceptedPositionsCount).toBe(4);
    expect(store.read(path).withdrawnAt).toBeUndefined();
  });

  it('never offers concierge slot release on a standalone application', () => {
    expect(canWithdrawApplication({ order: { billingMode: 'standalone', paymentStatus: 'paid' }, flow: { state: 'candidate_review' } })).toBe(false);
  });
});
