import { describe, expect, it, vi } from 'vitest';
import { createMemoryFirestore } from './helpers/memoryFirestore';
import { transition } from '../functions/src/assistedApplicationFlow.js';
// This suite exercises retry scheduling, not the separately tested PDF packet renderer.
vi.mock('../functions/src/assistedApplicationPostalPacket.js', () => ({ postalPacketReadiness: vi.fn(() => ({ ready: true })) }));
// The event classifier under test does not create document packages.
vi.mock('../scripts/assisted-application/lib/dossier.mjs', () => ({
  adPackaging: vi.fn(), dossierMode: vi.fn(), draftCandidateType: vi.fn(), packageAttachments: vi.fn(),
}));
import { computeDueAt } from '../functions/src/assistedApplicationAutomation.js';
import { TRANSPORT_AUTO_RETRY_DELAYS_MS } from '../functions/src/assistedApplicationPortalRetryPolicy.js';
import { emailInfrastructureFailure, legacyTransportHoldReason, navigationInfrastructureFailure } from '../functions/src/assistedApplicationTransportRetryPolicy.js';
import { reconcileTransportHolds } from '../scripts/reconcile-assisted-application-transport-holds.mjs';
import { buildOwnerAutomationEmail } from '../functions/src/assistedApplicationAutomationEmails.js';
import { navigationHandoffFor, portalNetworkFailureMetadata } from '../scripts/assisted-application/lib/submit.mjs';

const now = Date.now();
const draft = { status: 'ready', round: 1, questions: [], job: { source: 'job_detail' }, channel: { type: 'email' } };
const approved = { state: 'submitting', round: 1, dispatch: { mode: 'submit', round: 1 } };

describe('infrastructure failures use the scheduler without a manual retry', () => {
  it.each(['navigation_unavailable', 'email_provider_unavailable', 'question_localization_unavailable', 'application_region_unsupported'])('backs off %s, notifies operations once and continues without manual intervention', reason => {
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
    for (const error of [
      'page.goto: net::ERR_NAME_NOT_RESOLVED',
      'page.goto: net::ERR_ADDRESS_UNREACHABLE',
      'page.goto: net::ERR_CONNECTION_TIMED_OUT',
      'page.goto: net::ERR_CONNECTION_ABORTED',
      'page.goto: net::ERR_NETWORK_ACCESS_DENIED',
      'chrome-error://chromewebdata/',
      'getaddrinfo EAI_AGAIN portal.example.test',
      'connect ENETUNREACH 203.0.113.10:443',
      'connect EHOSTUNREACH 203.0.113.10:443',
    ]) expect(navigationInfrastructureFailure(error)).toBe(true);
    expect(navigationInfrastructureFailure('https://portal.example/chrome-error/form/')).toBe(false);
    expect(navigationInfrastructureFailure('https://portal.example/apply/?next=chrome-error://form/')).toBe(false);
    expect(navigationInfrastructureFailure(Object.assign(new Error('connect failed'), { code: 'ENETUNREACH' }))).toBe(true);
    expect(navigationInfrastructureFailure(Object.assign(new Error('fetch failed'), { cause: { code: 'EHOSTUNREACH' } }))).toBe(true);
    expect(navigationInfrastructureFailure('portal_validation')).toBe(false);
    expect(navigationHandoffFor(new Error('page.goto: net::ERR_ADDRESS_UNREACHABLE'))).toEqual({ type: 'submit_handoff', reason: 'navigation_unavailable' });
    expect(navigationHandoffFor(new Error('page.goto: net::ERR_ADDRESS_UNREACHABLE'), { clicked: true })).toBeNull();
    expect(navigationHandoffFor(new Error('page.goto: net::ERR_ADDRESS_UNREACHABLE'), { succeeded: true })).toBeNull();
    expect(navigationHandoffFor(new Error('chrome-error://chromewebdata/'))).toEqual({ type: 'submit_handoff', reason: 'navigation_unavailable' });
    for (const error of ['email_ambiguous', 'portal_ambiguous', 'portal_antibot_ambiguous', 'submission_receipt_invalid']) {
      const result = transition(approved, { type: 'submit_failed', error }, { draft, nowMs: now });
      expect(computeDueAt(result.flow)).toBeNull();
    }
  });
});

describe('network evidence passed to the shared flow', () => {
  const verifiedDraft = {
    status: 'ready', round: 1,
    portalContract: {
      postingMatch: 'match',
      applyUrl: { origin: 'https://jobs.example.test', path: '/role/' },
      currentUrl: { origin: 'https://forms.example.test', path: '/application/' },
      form: { observed: true },
    },
  };

  it('emits only the verified form host and a closed failure kind', () => {
    expect(portalNetworkFailureMetadata({
      event: { type: 'submit_handoff', reason: 'navigation_unavailable' }, draft: verifiedDraft,
    })).toEqual({ host: 'forms.example.test', kind: 'navigation_unavailable' });
    expect(portalNetworkFailureMetadata({
      event: { type: 'submit_handoff', reason: 'posting_mismatch' },
      evidence: { stopReport: { errors: ['chrome-error://chromewebdata net::ERR_CONNECTION_REFUSED'] } },
      draft: verifiedDraft,
    })).toEqual({ host: 'forms.example.test', kind: 'chrome_error' });
    expect(portalNetworkFailureMetadata({
      event: { type: 'submit_handoff' },
      evidence: { finalUrl: 'chrome-error://chromewebdata/' },
      draft: verifiedDraft,
    })).toEqual({ host: 'forms.example.test', kind: 'chrome_error' });
    expect(portalNetworkFailureMetadata({
      event: { type: 'submit_handoff', reason: 'portal_needs_candidate' },
      liveness: { page: { code: 'access_blocked' } },
      postingUrl: 'https://forms.example.test/job/', draft: verifiedDraft,
    })).toEqual({ host: 'forms.example.test', kind: 'access_blocked' });
    expect(portalNetworkFailureMetadata({
      event: { type: 'submit_handoff', reason: 'access_blocked' },
      liveness: { page: { code: 'access_blocked' } },
      postingUrl: 'https://jobs.example.test/role/', draft: verifiedDraft,
    })).toEqual({ host: 'forms.example.test', kind: 'access_blocked' });

    expect(portalNetworkFailureMetadata({
      event: { type: 'submit_handoff', reason: 'navigation_unavailable' },
      draft: { ...verifiedDraft, portalContract: {
        ...verifiedDraft.portalContract,
        applyUrl: { origin: 'https://forms.example.test', path: '/apply/' },
        currentUrl: { origin: 'https://jobs.example.test', path: '/role/' },
        form: { observed: false },
      } },
    })).toEqual({ host: 'forms.example.test', kind: 'navigation_unavailable' });
  });

  it('keeps unknown postings and a blocked different host out of Swiss routing evidence', () => {
    expect(portalNetworkFailureMetadata({
      event: { type: 'submit_handoff', reason: 'navigation_unavailable' },
      draft: { ...verifiedDraft, portalContract: { ...verifiedDraft.portalContract, postingMatch: 'unknown' } },
    })).toBeNull();
    expect(portalNetworkFailureMetadata({
      event: { type: 'submit_handoff', reason: 'portal_needs_candidate' },
      liveness: { page: { code: 'access_blocked' } },
      postingUrl: 'https://postings.example.test/job/', draft: verifiedDraft,
    })).toBeNull();
    expect(portalNetworkFailureMetadata({
      event: { type: 'submit_handoff', reason: 'portal_needs_candidate' },
      liveness: { page: { code: 'access_blocked' } }, draft: verifiedDraft,
    })).toBeNull();
    expect(portalNetworkFailureMetadata({
      event: { type: 'submit_succeeded', reason: 'navigation_unavailable' }, draft: verifiedDraft,
    })).toBeNull();
    expect(portalNetworkFailureMetadata({
      event: { type: 'submit_handoff' },
      evidence: { finalUrl: 'https://portal.example/apply/?next=chrome-error://form/' },
      postingUrl: 'https://portal.example/apply/',
      draft: { portalContract: { postingMatch: 'match', applyUrl: 'https://portal.example/apply/' } },
    })).toBeNull();
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

  it('requeues a regional-notice hold only when its pre-form claim was released as not sent', () => {
    const flow = { state: 'owner_takeover', round: 1, heldBy: ['portal:application_region_unsupported'] };
    const record = { state: 'failed', channel: 'portal', reason: 'application_region_unsupported', releasedAt: now - 1000, clickedAt: null, confirmedNotSent: true };
    expect(legacyTransportHoldReason({ flow, submission: { r1: record }, draft })).toBe('application_region_unsupported');
    expect(legacyTransportHoldReason({ flow, submission: { r1: { ...record, clickedAt: now - 2000 } }, draft })).toBeNull();
    expect(legacyTransportHoldReason({ flow, submission: { r1: { ...record, confirmedNotSent: false } }, draft })).toBeNull();
    expect(legacyTransportHoldReason({ flow, submission: { r1: { ...record, state: 'sending' } }, draft })).toBeNull();
    expect(legacyTransportHoldReason({ flow: { ...flow, technicalRecoveryVersion: 'transport-recovery-v1' }, submission: { r1: record }, draft })).toBeNull();
  });
});
