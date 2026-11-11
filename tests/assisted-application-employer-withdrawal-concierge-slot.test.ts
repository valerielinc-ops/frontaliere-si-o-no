// Owner decision 2026-11-11, «si per il concierge lo libera»: when the employer withdraws the posting of a
// concierge child, the position it held on the service is given back (acceptedPositionsCount - 1), once, never
// below zero, never when the application may have left, and the matcher is asked for another posting, as a
// candidate's own withdrawal does. Every order, service, name and posting here is invented.
import { describe, expect, it, vi } from 'vitest';
import { createMemoryFirestore } from './helpers/memoryFirestore';
import { applyAutomationEvent as applyEvent, runAutomationSweep as sweep } from '../functions/src/assistedApplicationAutomation.js';
import { EMPLOYER_WITHDRAWAL_REASON, employerWithdrawalSlotBlocker } from '../functions/src/assistedApplicationEmployerWithdrawal.js';
import { isFreshConciergeProposalRefreshRequest } from '../functions/src/applicationConciergeLifecycle.js';
import { reconcileConciergeSlots as reconcileSlots, reconcilePostingWithdrawals as reconcile } from '../scripts/assisted-application/reconcile-posting-withdrawals.mjs';

// The modules are JavaScript with JSDoc defaults narrower than their contracts: called loosely here.
const applyAutomationEvent: (...args: any[]) => Promise<any> = applyEvent as any;
const runAutomationSweep: (...args: any[]) => Promise<any> = sweep as any;
const reconcileConciergeSlots: (...args: any[]) => Promise<any> = reconcileSlots as any;
const reconcilePostingWithdrawals: (...args: any[]) => Promise<any> = reconcile as any;

const T0 = Date.UTC(2026, 10, 1, 8, 0, 0);
const HOUR = 60 * 60 * 1000;
const ORDER = 'assisted_applications/o1';
const FLOW = `${ORDER}/automation/flow`;
const SERVICE = 'application_concierge_services/svc1';
const PROPOSAL = `${SERVICE}/proposals/p1`;
const draft = { status: 'ready', round: 1, job: { source: 'job_detail', title: 'Sachbearbeiterin' }, channel: { type: 'portal' }, factCheck: { ok: true, unsupported: [] }, questions: [{ id: 'q1', required: true }] };
// The round waited for the candidate's answer, which came; the runner was then sent to submit.
const waited = { state: 'submitting', round: 1, shownRounds: [1], heldBy: [], lastWait: { round: 1, since: T0, until: T0 + 10 * HOUR }, dispatch: { mode: 'submit', round: 1, requestedAt: T0 + 10 * HOUR } };
const child = {
  paymentStatus: 'paid', submissionStatus: 'awaiting_upload', automationState: 'submitting', billingMode: 'application_concierge',
  userId: 'candidate_test', parentServiceId: 'svc1', parentProposalId: 'p1', jobId: 'esempio-1', jobUrl: 'https://jobs.example.com/posting/1',
};
const expiresAt = new Date(T0 + 20 * 24 * HOUR);
const activeService = { userId: 'candidate_test', paymentStatus: 'paid', serviceStatus: 'active', acceptedPositionsCount: 4, expiresAt };
const acceptedProposal = { status: 'accepted', childApplicationId: 'o1', jobUrl: 'https://jobs.example.com/posting/1' };
// An order the employer's withdrawal closed before the slot was given back with it (the deploy of this rule).
const withdrawnFlow = { ...waited, state: 'withdrawn', withdrawnAt: T0 + 11 * HOUR, withdrawnReason: EMPLOYER_WITHDRAWAL_REASON, withdrawalEvidence: { kind: 'http_gone', source: 'posting_page', at: T0 + 11 * HOUR }, dispatch: null };
const withdrawnChild = { ...child, submissionStatus: 'withdrawn', automationState: 'withdrawn', automationDueAt: null, withdrawnAt: T0 + 11 * HOUR, withdrawalReason: EMPLOYER_WITHDRAWAL_REASON };

function seed({ order = child as any, flow = waited as any, service = activeService as any, proposal = acceptedProposal as any, submission = null as any } = {}) {
  return createMemoryFirestore({
    [ORDER]: order,
    [FLOW]: flow,
    [`${ORDER}/ai_drafts/current`]: draft,
    [SERVICE]: service,
    [PROPOSAL]: proposal,
    ...(submission ? { [`${ORDER}/automation/submission`]: submission } : {}),
  });
}

const runEffect = async () => ({ ok: true });
const closed = (store: any, nowMs = T0 + 11 * HOUR) => applyAutomationEvent({
  db: store.db, orderId: 'o1', event: { type: 'posting_closed', reason: 'http_gone', round: 1 }, actor: 'runner', runEffect, nowMs,
});

describe('the employer\'s withdrawal gives the concierge position back', () => {
  it('releases one position once, closes the proposal and asks the matcher for another posting', async () => {
    const store = seed();
    const before = structuredClone(store.read(SERVICE));
    const first = await closed(store);
    expect(first).toMatchObject({ ok: true, conciergeSlotReleased: true });
    expect(store.read(FLOW)).toMatchObject({ state: 'withdrawn', withdrawnReason: EMPLOYER_WITHDRAWAL_REASON });
    const after = store.read(SERVICE);
    expect(after).toMatchObject({
      acceptedPositionsCount: 3, expiresAt,
      proposalRefreshRequestId: 'employer-withdraw-o1', proposalRefreshRequestedBy: 'employer_withdrawal',
    });
    // The worker that replenishes a candidate's withdrawal takes this request too.
    expect(isFreshConciergeProposalRefreshRequest(before, after)).toBe(true);
    expect(store.read(PROPOSAL)).toMatchObject({ status: 'declined', declineReason: EMPLOYER_WITHDRAWAL_REASON, withdrawnAt: T0 + 11 * HOUR, childApplicationId: 'o1' });
    expect(store.read(ORDER)).toMatchObject({ conciergeSlotReleasedAt: T0 + 11 * HOUR, withdrawalReason: EMPLOYER_WITHDRAWAL_REASON });

    // A second closure, the sweep and the reconcile script: nothing more is given back.
    expect(await closed(store, T0 + 12 * HOUR)).toMatchObject({ ok: false });
    await runAutomationSweep({ db: store.db, nowMs: T0 + 13 * HOUR, runEffect });
    expect(await reconcileConciergeSlots({ db: store.db, apply: true, nowMs: T0 + 14 * HOUR })).toMatchObject({ scanned: 0, released: 0 });
    expect(store.read(SERVICE)?.acceptedPositionsCount).toBe(3);
  });

  it('never goes below zero, and an expired service queues no matching', async () => {
    const store = seed({ service: { ...activeService, acceptedPositionsCount: 0, serviceStatus: 'expired', expiresAt: new Date(T0 - HOUR) } });
    expect(await closed(store)).toMatchObject({ ok: true, conciergeSlotReleased: true });
    expect(store.read(SERVICE)?.acceptedPositionsCount).toBe(0);
    expect(store.read(SERVICE)?.proposalRefreshRequestId).toBeUndefined();
    expect(store.read(ORDER)?.conciergeSlotReleasedAt).toBe(T0 + 11 * HOUR);
  });

  it('keeps the position when the application may have reached the employer', async () => {
    const store = seed({ submission: { r1: { state: 'sending', channel: 'portal', clickedAt: T0 + 10 * HOUR, confirmedNotSent: false } } });
    await closed(store);
    expect(store.read(FLOW)?.state).toBe('owner_takeover');
    expect(store.read(SERVICE)?.acceptedPositionsCount).toBe(4);
    expect(store.read(PROPOSAL)?.status).toBe('accepted');
    expect(store.read(ORDER)?.conciergeSlotReleasedAt).toBeUndefined();
    // Read on its own, for an order already withdrawn: a send on record or an unproven click keeps the slot.
    const slot = { service: activeService, proposal: acceptedProposal };
    expect(employerWithdrawalSlotBlocker({ orderId: 'o1', order: withdrawnChild, flow: withdrawnFlow, draft: { sent: { at: T0 } }, slot })).toBe('send_may_have_left');
    expect(employerWithdrawalSlotBlocker({ orderId: 'o1', order: withdrawnChild, flow: withdrawnFlow, submission: { r1: { state: 'sent' } }, slot })).toBe('send_may_have_left');
    expect(employerWithdrawalSlotBlocker({ orderId: 'o1', order: withdrawnChild, flow: withdrawnFlow, slot })).toBe('');
  });

  it('gives back only the position this very child holds on the candidate\'s own service', () => {
    const slot = { service: activeService, proposal: acceptedProposal };
    const args = { orderId: 'o1', order: withdrawnChild, flow: withdrawnFlow, slot };
    expect(employerWithdrawalSlotBlocker({ ...args, order: { ...withdrawnChild, conciergeSlotReleasedAt: T0 } })).toBe('already_released');
    expect(employerWithdrawalSlotBlocker({ ...args, order: { ...withdrawnChild, billingMode: 'standalone' } })).toBe('not_concierge_child');
    expect(employerWithdrawalSlotBlocker({ ...args, order: { ...withdrawnChild, withdrawalReason: 'La posizione non mi interessa' } })).toBe('not_withdrawn_by_employer');
    expect(employerWithdrawalSlotBlocker({ ...args, flow: { ...withdrawnFlow, withdrawnReason: null } })).toBe('not_withdrawn_by_employer');
    expect(employerWithdrawalSlotBlocker({ ...args, slot: { ...slot, service: { ...activeService, userId: 'someone_else' } } })).toBe('service_not_owned');
    expect(employerWithdrawalSlotBlocker({ ...args, slot: { ...slot, proposal: { ...acceptedProposal, status: 'declined', withdrawnAt: T0 } } })).toBe('slot_not_held');
    expect(employerWithdrawalSlotBlocker({ ...args, slot: { ...slot, proposal: { ...acceptedProposal, childApplicationId: 'o2' } } })).toBe('slot_not_held');
  });

  it('releases on the sweep\'s recorded closure of an order held before the rule', async () => {
    const held = { state: 'owner_takeover', round: 1, shownRounds: [1], heldBy: ['posting_closed'], lastWait: { round: 1, since: T0, until: T0 + 10 * HOUR }, postingClosure: { code: 'expired_body', source: 'posting_page', at: T0 + 10 * HOUR } };
    const store = seed({ order: { ...child, automationState: 'owner_takeover', automationDueAt: T0 + 20 * HOUR }, flow: held });
    const summary = await runAutomationSweep({ db: store.db, nowMs: T0 + 21 * HOUR, runEffect });
    expect(summary.employerWithdrawals).toBe(1);
    expect(store.read(SERVICE)).toMatchObject({ acceptedPositionsCount: 3, proposalRefreshRequestedBy: 'employer_withdrawal' });
    expect(store.read(ORDER)?.conciergeSlotReleasedAt).toBe(T0 + 21 * HOUR);
  });
});

describe('the orders the employer\'s withdrawal closed before this rule', () => {
  it('dry-run writes nothing; apply releases once; a position no longer held is left alone', async () => {
    const store = seed({ order: withdrawnChild, flow: withdrawnFlow });
    const before = JSON.stringify([...store.docs.entries()]);
    const dry = await reconcilePostingWithdrawals({ db: store.db, nowMs: T0 + 20 * HOUR, look: vi.fn() });
    expect(dry.slots).toMatchObject({ scanned: 1, eligible: 1, released: 0, orders: [{ id: 'o1', outcome: 'eligible' }] });
    expect(JSON.stringify([...store.docs.entries()])).toBe(before);

    const applied = await reconcilePostingWithdrawals({ db: store.db, apply: true, nowMs: T0 + 20 * HOUR, look: vi.fn() });
    expect(applied.slots).toMatchObject({ eligible: 1, released: 1 });
    expect(store.read(SERVICE)).toMatchObject({ acceptedPositionsCount: 3, proposalRefreshRequestId: 'employer-withdraw-o1', proposalRefreshRequestedBy: 'employer_withdrawal', expiresAt });
    expect(store.read(PROPOSAL)).toMatchObject({ status: 'declined', declineReason: EMPLOYER_WITHDRAWAL_REASON });
    expect(store.read(ORDER)?.conciergeSlotReleasedAt).toBe(T0 + 20 * HOUR);
    expect(store.list(`${ORDER}/events/`).map((path) => store.read(path)?.type)).toEqual(['concierge_slot_released']);

    await reconcilePostingWithdrawals({ db: store.db, apply: true, nowMs: T0 + 21 * HOUR, look: vi.fn() });
    expect(store.read(SERVICE)?.acceptedPositionsCount).toBe(3);

    // The candidate had already withdrawn it (its proposal declined): nothing to give back a second time.
    const gone = seed({ order: withdrawnChild, flow: withdrawnFlow, proposal: { ...acceptedProposal, status: 'declined', withdrawnAt: T0, declineReason: 'candidate_withdrawn' } });
    expect(await reconcileConciergeSlots({ db: gone.db, apply: true, nowMs: T0 + 20 * HOUR })).toMatchObject({ released: 0, skipped: { slot_not_held: 1 } });
    expect(gone.read(SERVICE)?.acceptedPositionsCount).toBe(4);
  });
});
