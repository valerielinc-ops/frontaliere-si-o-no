import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryFirestore } from './helpers/memoryFirestore';

const mocks = vi.hoisted(() => ({ getAdminDb: vi.fn(), verifyIdToken: vi.fn() }));

vi.mock('../functions/src/remoteConfigSecrets.js', () => ({
  getRemoteConfigValue: vi.fn(async () => ''),
  bridgeEmailCascadeCredentialsToEnv: vi.fn(async () => {}),
}));
vi.mock('firebase-admin/auth', () => ({ getAuth: () => ({ verifyIdToken: mocks.verifyIdToken }) }));
vi.mock('../functions/src/newsletterResendWebhookCore.js', () => ({ getAdminDb: () => mocks.getAdminDb() }));
vi.mock('../functions/src/adminAudit.js', () => ({ writeAdminAuditLog: vi.fn(async () => {}) }));

const { applyAutomationEvent, runAutomationSweep, startAutomation } = await import('../functions/src/assistedApplicationAutomation.js');
const { handleAssistedApplicationAdmin } = await import('../functions/src/assistedApplicationAdminCore.js');
const { autoRetryDelaysForFlow } = await import('../functions/src/assistedApplicationPortalRetryPolicy.js');
const { submissionGuard } = await import('../functions/src/assistedApplicationSubmissionGuard.js');
const { transition } = await import('../functions/src/assistedApplicationFlow.js');
const { reconcileOwnerSubmittedFlows } = await import('../scripts/assisted-application/reconcile-owner-submitted-flows.mjs');

const T0 = Date.UTC(2026, 10, 17, 18, 0, 0);
const ORDER = 'order_SYNTH01';
const PATH = `assisted_applications/${ORDER}`;
const CV_KEY = `assisted-application-uploads/${ORDER}/1-cv.pdf`;
const ADMIN_EMAIL = 'valerielinc@gmail.com';

const paidOrder = () => ({
  orderId: ORDER, paymentStatus: 'paid', submissionStatus: 'in_progress', jobTitle: 'Infermiere', companyName: 'Ospedale',
  locale: 'it', applicantEmail: 'candidate@example.test', cvStorageKey: CV_KEY,
  cvFileCheck: { key: CV_KEY, verdict: 'ok', detectedType: 'pdf' },
});
const readyDraft = () => ({
  status: 'ready', round: 1, verdict: 'good', job: { source: 'job_detail', title: 'Infermiere' },
  channel: { type: 'lever', label: 'Lever' }, factCheck: { ok: true, unsupported: [] }, questions: [],
});

let store: ReturnType<typeof createMemoryFirestore>;
let effects: any[];
const runEffect = vi.fn(async (context: any) => { effects.push(context.effect); return { ok: true }; });
const markSentFromQueue = () => handleAssistedApplicationAdmin({
  method: 'POST',
  get: (header: string) => (header === 'Authorization' ? 'Bearer valid-token' : undefined),
  body: { action: 'transition', orderId: ORDER, submissionStatus: 'submitted' },
});

async function robotStopsOnPortal() {
  await startAutomation({ db: store.db, orderId: ORDER, runEffect, nowMs: T0 });
  await store.db.collection('assisted_applications').doc(ORDER).collection('ai_drafts').doc('current').set(readyDraft());
  await applyAutomationEvent({ db: store.db, orderId: ORDER, event: { type: 'draft_ready', round: 1 }, runEffect, nowMs: T0 });
  await applyAutomationEvent({ db: store.db, orderId: ORDER, event: { type: 'candidate_approve' }, actor: 'candidate', runEffect, nowMs: T0 + 1_000 });
  await applyAutomationEvent({ db: store.db, orderId: ORDER, event: { type: 'submit_handoff', reason: 'portal_needs_candidate' }, actor: 'runner', runEffect, nowMs: T0 + 2_000 });
  return T0 + 2_000 + autoRetryDelaysForFlow({ heldBy: ['portal:portal_needs_candidate'] })[0];
}

// The robot stops on a portal, the sweep relaunches it, and the owner sends by hand while that run is out.
async function robotRelaunchedAfterHandoff() {
  const retryAt = await robotStopsOnPortal();
  await runAutomationSweep({ db: store.db, runEffect, nowMs: retryAt });
  expect(store.read(`${PATH}/automation/flow`)?.state).toBe('submitting');
  return retryAt;
}

beforeEach(() => {
  store = createMemoryFirestore({ [PATH]: paidOrder() });
  effects = [];
  runEffect.mockClear();
  mocks.getAdminDb.mockReturnValue(store.db);
  mocks.verifyIdToken.mockResolvedValue({ uid: 'aAqGpXr2mUQNQlio3gCxut4bBzH3', email: ADMIN_EMAIL, email_verified: true });
});

describe('owner marks an order sent while the robot run is out', () => {
  it('closes the order and the flow together, and fences the run before its final click', async () => {
    const retryAt = await robotRelaunchedAfterHandoff();
    const guard = submissionGuard(store.db, ORDER, 1);
    expect(await guard.claim('portal', retryAt + 1, { resumable: true })).toMatchObject({ status: 'claimed' });

    expect(await markSentFromQueue()).toMatchObject({ status: 200, body: { submissionStatus: 'submitted' } });

    expect(store.read(PATH)).toMatchObject({ submissionStatus: 'submitted', automationState: 'submitted' });
    expect(store.read(`${PATH}/automation/flow`)).toMatchObject({ state: 'submitted', submittedVia: 'owner', heldBy: [] });
    expect(store.read(`${PATH}/automation/submission`)).toMatchObject({ r1: { state: 'sent', channel: 'owner' } });
    // The run that was out can no longer press the final button, nor start again.
    await expect(guard.markClicked(retryAt + 2, { formBinding: 'a'.repeat(64) })).rejects.toThrow('submission_superseded');
    expect(await submissionGuard(store.db, ORDER, 1).claim('portal', retryAt + 3, { resumable: true })).toMatchObject({ status: 'superseded' });
  });

  it('ignores the late runner outcome instead of reopening the flow for the owner', async () => {
    await robotRelaunchedAfterHandoff();
    await markSentFromQueue();
    for (const event of [
      { type: 'submit_handoff', reason: 'portal_needs_candidate', round: 1 },
      { type: 'submit_failed', error: 'portal_refused', round: 1 },
      { type: 'submit_needs_candidate', questions: ['q1'], round: 1 },
    ]) {
      const result = await applyAutomationEvent({ db: store.db, orderId: ORDER, event, actor: 'runner', runEffect, nowMs: T0 + 3_600_000 });
      expect(result).toMatchObject({ ok: false });
    }
    expect(store.read(`${PATH}/automation/flow`)?.state).toBe('submitted');
    expect(store.read(PATH)).toMatchObject({ submissionStatus: 'submitted', automationState: 'submitted' });
  });

  it('ignores a runner outcome on an order already sent even when its flow is still open', async () => {
    await robotRelaunchedAfterHandoff();
    // The divergent state of production: the order is sent, the flow still waits on the robot.
    await store.db.collection('assisted_applications').doc(ORDER).set({ submissionStatus: 'submitted' }, { merge: true });
    const result = await applyAutomationEvent({ db: store.db, orderId: ORDER, event: { type: 'submit_handoff', reason: 'portal_needs_candidate', round: 1 }, actor: 'runner', runEffect, nowMs: T0 + 3_600_000 });
    expect(result).toMatchObject({ ok: false, ignored: 'order_closed' });
    expect(store.read(`${PATH}/automation/flow`)?.state).toBe('submitting');
  });
});

describe('no automatic recovery on a closed order', () => {
  it.each(['submitted', 'withdrawn', 'refunded'])('never relaunches an order with submissionStatus %s', async (status) => {
    const retryAt = await robotStopsOnPortal();
    await store.db.collection('assisted_applications').doc(ORDER).set({ submissionStatus: status }, { merge: true });
    effects = [];

    expect(await runAutomationSweep({ db: store.db, runEffect, nowMs: retryAt })).toMatchObject({ portalRetries: 0, ignored: 1 });
    expect(await applyAutomationEvent({ db: store.db, orderId: ORDER, event: { type: 'owner_retry_submit' }, actor: 'owner', runEffect, nowMs: retryAt })).toMatchObject({ ok: false, ignored: 'order_closed' });
    expect(store.read(`${PATH}/automation/flow`)?.state).toBe('owner_takeover');
    expect(effects).toEqual([]);
  });
});

describe('owner_submitted in the flow', () => {
  const draft = { round: 1 };
  it('closes a flow held by the robot or the owner, not one waiting for the candidate', () => {
    for (const state of ['submitting', 'owner_review', 'operator_expedited_review', 'owner_takeover', 'candidate_handoff', 'failed']) {
      const step = transition({ state, round: 1, heldBy: ['x'] }, { type: 'owner_submitted' }, { draft, nowMs: T0 });
      expect(step.flow).toMatchObject({ state: 'submitted', heldBy: [] });
    }
    for (const state of ['candidate_review', 'needs_candidate_action', 'submitted', 'withdrawn']) {
      expect(transition({ state, round: 1 }, { type: 'owner_submitted' }, { draft, nowMs: T0 }).ignored).toBeTruthy();
    }
  });
});

describe('reconcile-owner-submitted-flows', () => {
  const seedDivergent = async (id: string, flow: Record<string, any>) => {
    const ref = store.db.collection('assisted_applications').doc(id);
    await ref.set({ ...paidOrder(), orderId: id, submissionStatus: 'submitted', automationState: flow.state });
    await ref.collection('ai_drafts').doc('current').set(readyDraft());
    await ref.collection('automation').doc('flow').set(flow);
  };

  it('is a dry run by default, closes only with --apply, and a second run changes nothing', async () => {
    await seedDivergent('order_SYNTH_A', { state: 'owner_takeover', round: 1, heldBy: ['portal:portal_needs_candidate'] });
    await seedDivergent('order_SYNTH_B', { state: 'submitting', round: 1 });
    await seedDivergent('order_SYNTH_C', { state: 'candidate_review', round: 1 });
    await seedDivergent('order_SYNTH_D', { state: 'submitted', round: 1 });

    const dry = await reconcileOwnerSubmittedFlows({ db: store.db, nowMs: T0, runEffect });
    expect(dry).toMatchObject({ apply: false, open: 3, eligible: 2, closed: 0, skipped: { waiting_for_candidate: 1 } });
    expect(store.read('assisted_applications/order_SYNTH_A/automation/flow')?.state).toBe('owner_takeover');

    const applied = await reconcileOwnerSubmittedFlows({ db: store.db, apply: true, nowMs: T0, runEffect });
    expect(applied).toMatchObject({ eligible: 2, closed: 2 });
    for (const id of ['order_SYNTH_A', 'order_SYNTH_B']) {
      expect(store.read(`assisted_applications/${id}/automation/flow`)).toMatchObject({ state: 'submitted', submittedVia: 'owner' });
      expect(store.read(`assisted_applications/${id}/automation/submission`)).toMatchObject({ r1: { state: 'sent' } });
    }
    expect(store.read('assisted_applications/order_SYNTH_C/automation/flow')?.state).toBe('candidate_review');

    const again = await reconcileOwnerSubmittedFlows({ db: store.db, apply: true, nowMs: T0 + 1, runEffect });
    expect(again).toMatchObject({ eligible: 0, closed: 0 });
  });
});
