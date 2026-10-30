import { describe, expect, it } from 'vitest';
import { createMemoryFirestore } from './helpers/memoryFirestore';
import { transition } from '../functions/src/assistedApplicationFlow.js';
import { computeDueAt } from '../functions/src/assistedApplicationAutomation.js';
import { TRANSPORT_AUTO_RETRY_DELAYS_MS } from '../functions/src/assistedApplicationPortalRetryPolicy.js';
import { emailInfrastructureFailure, legacyTransportHoldReason, navigationInfrastructureFailure } from '../functions/src/assistedApplicationTransportRetryPolicy.js';
import { reconcileTransportHolds } from '../scripts/reconcile-assisted-application-transport-holds.mjs';
import { buildOwnerAutomationEmail } from '../functions/src/assistedApplicationAutomationEmails.js';

const now = Date.now();
const draft = { status: 'ready', round: 1, questions: [], job: { source: 'job_detail' }, channel: { type: 'email' } };
const approved = { state: 'submitting', round: 1, dispatch: { mode: 'submit', round: 1 } };

describe('infrastructure failures use the scheduler without a manual retry', () => {
  it.each(['navigation_unavailable', 'email_provider_unavailable', 'captcha_provider_unavailable'])('backs off %s, notifies operations once and continues without manual intervention', reason => {
    let flow: any = approved;
    let at = now;
    const fail = reason === 'email_provider_unavailable' ? { type: 'submit_failed', error: reason } : { type: 'submit_handoff', reason };
    for (const delay of TRANSPORT_AUTO_RETRY_DELAYS_MS) {
      const held = transition(flow, fail, { draft, nowMs: at });
      // The persistence adapter preserves dispatch metadata across pure FSM transitions.
      const waiting = { ...held.flow, dispatch: flow.dispatch };
      expect(held.effects).toEqual([]);
      expect(computeDueAt(held.flow)).toBe(at + delay);
      expect(transition(waiting, { type: 'portal_auto_retry' }, { draft, nowMs: at + delay - 1 }).ignored).toBe('portal_retry_not_due');
      const retried = transition(waiting, { type: 'portal_auto_retry' }, { draft, nowMs: at + delay });
      expect(retried.effects).toEqual([{ type: 'dispatch', mode: 'submit', reason: 'portal_auto_retry' }]);
      flow = { ...retried.flow, dispatch: approved.dispatch };
      at += delay;
    }
    const persistent = transition(flow, fail, { draft, nowMs: at });
    const nextAt = at + TRANSPORT_AUTO_RETRY_DELAYS_MS.at(-1)!;
    expect(computeDueAt(persistent.flow)).toBe(nextAt);
    expect(persistent.effects).toEqual([expect.objectContaining({ type: 'email', kind: 'owner_takeover' })]);
    const email = buildOwnerAutomationEmail('owner_takeover', { reason: persistent.flow.heldBy[0], portalAutoRetryAt: nextAt, job: 'Test role', company: 'Test employer' });
    expect(email.subject).toContain('Nuovo tentativo automatico');
    expect(email.text).toContain('Non serve intervenire sulla singola candidatura');
    expect(email.text).not.toContain('Controlla dalla coda');
    const again = transition({ ...persistent.flow, dispatch: flow.dispatch }, { type: 'portal_auto_retry' }, { draft, nowMs: nextAt });
    const nextFailure = transition({ ...again.flow, dispatch: flow.dispatch }, fail, { draft, nowMs: nextAt });
    expect(computeDueAt(nextFailure.flow)).toBe(nextAt + TRANSPORT_AUTO_RETRY_DELAYS_MS.at(-1)!);
    expect(nextFailure.effects).toEqual([]);
    expect(nextFailure.flow.portalAutoRetryCount).toBe(0);
  });

  it('does not call invalid addresses, ambiguous delivery or a post-click result an infrastructure retry', () => {
    expect(emailInfrastructureFailure({ error: 'All providers failed: Maileroo 503 | Resend 401' })).toBe(true);
    expect(emailInfrastructureFailure({ error: 'All providers failed: quota exhausted' })).toBe(true);
    expect(emailInfrastructureFailure({ error: 'Maileroo 400: invalid recipient' })).toBe(false);
    expect(emailInfrastructureFailure({ error: 'Maileroo 503', ambiguousDelivery: true })).toBe(false);
    expect(emailInfrastructureFailure({ error: 'Maileroo 400: invalid payload' })).toBe(false);
    expect(navigationInfrastructureFailure('page.goto: net::ERR_NAME_NOT_RESOLVED')).toBe(true);
    expect(navigationInfrastructureFailure('portal_validation')).toBe(false);
    for (const error of ['email_ambiguous', 'portal_ambiguous', 'portal_antibot_ambiguous']) {
      const result = transition(approved, { type: 'submit_failed', error }, { draft, nowMs: now });
      expect(computeDueAt(result.flow)).toBeNull();
    }
  });
});

describe('legacy recovery is general, idempotent and only repairs the query clock', () => {
  function fixture() {
    const path = 'assisted_applications/order_transport_test';
    const flow = { ...approved, state: 'owner_takeover', heldBy: ['email_failed'] };
    const submission = { r1: { state: 'failed', channel: 'email', reason: 'email_failed', releasedAt: now - 1000, clickedAt: null } };
    const store = createMemoryFirestore({
      [path]: { paymentStatus: 'paid', submissionStatus: 'in_progress', automationState: 'owner_takeover', automationDueAt: null },
      [`${path}/automation/flow`]: flow, [`${path}/ai_drafts/current`]: draft,
      [`${path}/automation/submission`]: submission,
    });
    return { store, path, flow, submission };
  }

  it('can preview, queue once and leave the normal state machine to dispatch', async () => {
    const { store, path } = fixture();
    expect(await reconcileTransportHolds({ db: store.db, nowMs: now })).toMatchObject({ eligible: 1, changed: 0 });
    expect(store.read(path).automationDueAt).toBeNull();
    expect(await reconcileTransportHolds({ db: store.db, apply: true, nowMs: now })).toMatchObject({ eligible: 1, changed: 1 });
    const order = store.read(path);
    const flow = store.read(`${path}/automation/flow`);
    expect(order.automationDueAt).toBe(now);
    expect(flow.state).toBe('owner_takeover');
    expect(flow.dispatch).toEqual(approved.dispatch);
    expect(computeDueAt(flow)).toBe(now);
    expect(await reconcileTransportHolds({ db: store.db, apply: true, nowMs: now })).toMatchObject({ eligible: 0, changed: 0 });
  });

  it('never recovers an unapproved, withdrawn, unpaid or possibly sent application', async () => {
    for (const kind of ['not_approved', 'withdrawn', 'unpaid', 'purged', 'sent', 'ambiguous', 'prior_sent', 'missing_draft']) {
      const { store, path, flow, submission } = fixture();
      if (kind === 'not_approved') store.docs.set(`${path}/automation/flow`, { ...flow, dispatch: { mode: 'draft' } });
      if (kind === 'withdrawn') store.docs.set(path, { ...store.read(path), withdrawnAt: now });
      if (kind === 'unpaid') store.docs.set(path, { ...store.read(path), paymentStatus: 'pending' });
      if (kind === 'purged') store.docs.set(path, { ...store.read(path), retentionPurgedAt: now });
      if (kind === 'missing_draft') store.docs.delete(`${path}/ai_drafts/current`);
      if (kind === 'sent' || kind === 'ambiguous') store.docs.set(`${path}/automation/submission`, { r1: { ...submission.r1, state: kind === 'sent' ? 'sent' : 'sending' } });
      if (kind === 'prior_sent') store.docs.set(`${path}/automation/submission`, { ...submission, r2: { state: 'sent' } });
      expect(await reconcileTransportHolds({ db: store.db, apply: true, nowMs: now })).toMatchObject({ eligible: 0, changed: 0 });
    }
  });

  it('recognizes a pre-click navigation failure but preserves a final-click fence', () => {
    const flow = { state: 'owner_takeover', round: 1, heldBy: ['page.goto: net::ERR_NAME_NOT_RESOLVED'] };
    const record = { state: 'failed', channel: 'portal', reason: 'error: page.goto: net::ERR_NAME_NOT_RESOLVED', releasedAt: now - 1000, clickedAt: null };
    expect(legacyTransportHoldReason({ flow, submission: { r1: record }, draft })).toBe('navigation_unavailable');
    expect(legacyTransportHoldReason({ flow, submission: { r1: { ...record, clickedAt: now - 2000 } }, draft })).toBeNull();
  });
});
