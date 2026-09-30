import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryFirestore } from './helpers/memoryFirestore';

const rc = vi.hoisted(() => ({ values: {} as Record<string, string> }));
vi.mock('../functions/src/remoteConfigSecrets.js', () => ({
  getRemoteConfigValue: vi.fn(async (key: string) => rc.values[key] || ''),
  bridgeEmailCascadeCredentialsToEnv: vi.fn(async () => {}),
}));

const {
  RUN_WATCHDOG_MS,
  applyAutomationEvent,
  computeDueAt,
  handleRunnerEvent,
  maybeStartAutomation,
  runAutomationSweep,
  startAutomation,
} = await import('../functions/src/assistedApplicationAutomation.js');
const { OWNER_REVIEW_MS, CANDIDATE_REVIEW_MS } = await import('../functions/src/assistedApplicationFlow.js');
const { automationEmailKey, runAutomationEffect } = await import('../functions/src/assistedApplicationAutomationEffects.js');

const T0 = Date.UTC(2026, 8, 30, 8, 0, 0);
const ORDER = 'order_ABC123';
const ORDER_PATH = `assisted_applications/${ORDER}`;
const CV_KEY = `assisted-application-uploads/${ORDER}/1-cv.pdf`;

function paidOrder(extra: Record<string, any> = {}) {
  return {
    orderId: ORDER,
    paymentStatus: 'paid',
    submissionStatus: 'ready_for_manual_submission',
    jobTitle: 'Infermiere',
    companyName: 'Ospedale',
    locale: 'it',
    cvStorageKey: CV_KEY,
    cvFileCheck: { key: CV_KEY, verdict: 'ok', detectedType: 'pdf' },
    ...extra,
  };
}

const readyDraft = (round = 1) => ({
  status: 'ready',
  round,
  verdict: 'good',
  job: { source: 'job_detail', title: 'Infermiere' },
  channel: { type: 'lever', label: 'Lever' },
  factCheck: { ok: true, unsupported: [] },
  questions: [],
});

let store: ReturnType<typeof createMemoryFirestore>;
let effects: any[];
const runEffect = vi.fn(async (context: any) => {
  effects.push(context.effect);
  return { ok: true };
});

beforeEach(() => {
  store = createMemoryFirestore({ [ORDER_PATH]: paidOrder() });
  effects = [];
  runEffect.mockClear();
  rc.values = {};
});

describe('starting the flow', () => {
  it('starts only when the flag is on and a CV has just been verified', async () => {
    const before = paidOrder({ cvFileCheck: null });
    const after = paidOrder();
    rc.values.ASSISTED_APPLICATION_AUTOMATION = 'false';
    expect(await maybeStartAutomation(before, after, ORDER, { db: store.db, runEffect, nowMs: T0 })).toMatchObject({ skipped: 'automation_disabled' });
    expect(store.read(`${ORDER_PATH}/automation/flow`)).toBeUndefined();

    rc.values.ASSISTED_APPLICATION_AUTOMATION = 'true';
    expect(await maybeStartAutomation(after, after, ORDER, { db: store.db, runEffect, nowMs: T0 })).toMatchObject({ skipped: 'no_new_cv' });
    expect(await maybeStartAutomation(before, after, ORDER, { db: store.db, runEffect, nowMs: T0 })).toMatchObject({ started: true });
    expect(store.read(`${ORDER_PATH}/automation/flow`)).toMatchObject({ state: 'drafting', round: 1, dispatch: { mode: 'draft', attempts: 1 } });
    expect(store.read(ORDER_PATH)).toMatchObject({ automationState: 'drafting', automationDueAt: T0 + RUN_WATCHDOG_MS });
    expect(effects).toEqual([{ type: 'dispatch', mode: 'draft', reason: 'cv_verified' }]);

    // A second verified CV write never restarts a live flow.
    expect(await startAutomation({ db: store.db, orderId: ORDER, runEffect, nowMs: T0 + 1 })).toMatchObject({ skipped: 'already_started_or_ineligible' });
  });

  it('refuses unpaid, closed or unverified orders', async () => {
    store = createMemoryFirestore({ [ORDER_PATH]: paidOrder({ submissionStatus: 'submitted' }) });
    rc.values.ASSISTED_APPLICATION_AUTOMATION = 'true';
    expect(await maybeStartAutomation(null, paidOrder({ submissionStatus: 'submitted' }), ORDER, { db: store.db, runEffect, nowMs: T0 })).toMatchObject({ skipped: 'order_closed' });
    expect(await maybeStartAutomation(null, paidOrder({ paymentStatus: 'pending' }), ORDER, { db: store.db, runEffect, nowMs: T0 })).toMatchObject({ skipped: 'not_paid' });
  });
});

describe('applying events', () => {
  beforeEach(async () => {
    await startAutomation({ db: store.db, orderId: ORDER, runEffect, nowMs: T0 });
    effects = [];
    await store.db.collection('assisted_applications').doc(ORDER).collection('ai_drafts').doc('current').set(readyDraft());
  });

  it('moves the flow, mirrors the clock on the order and runs the effects', async () => {
    const result = await applyAutomationEvent({ db: store.db, orderId: ORDER, event: { type: 'draft_ready', round: 1 }, actor: 'runner', runEffect, nowMs: T0 + 1000 });
    expect(result).toMatchObject({ ok: true, fromState: 'drafting' });
    expect(store.read(`${ORDER_PATH}/automation/flow`)).toMatchObject({ state: 'owner_review', deadlineAt: T0 + 1000 + OWNER_REVIEW_MS });
    expect(store.read(ORDER_PATH)).toMatchObject({ automationState: 'owner_review', automationDueAt: T0 + 1000 + OWNER_REVIEW_MS });
    expect(effects).toEqual([{ type: 'email', kind: 'owner_review', held: false, flags: [] }]);
    const audit = store.list(`${ORDER_PATH}/events/`).map((path) => store.read(path));
    expect(audit.some((entry) => entry?.eventType === 'draft_ready' && entry?.toState === 'owner_review')).toBe(true);
  });

  it('ignores a runner event of a superseded round', async () => {
    const result = await applyAutomationEvent({ db: store.db, orderId: ORDER, event: { type: 'draft_ready', round: 2 }, runEffect, nowMs: T0 });
    expect(result).toMatchObject({ ok: false, ignored: 'stale_round' });
    expect(store.read(`${ORDER_PATH}/automation/flow`)?.state).toBe('drafting');
  });

  it('applies a runner event document exactly once', async () => {
    const events = store.db.collection('assisted_applications').doc(ORDER).collection('automation_events');
    const ref = await events.add({ type: 'draft_ready', round: 1 });
    const data = store.read(ref.path);
    expect(await handleRunnerEvent({ db: store.db, orderId: ORDER, eventRef: ref, data, runEffect, nowMs: T0 })).toMatchObject({ ok: true });
    expect(await handleRunnerEvent({ db: store.db, orderId: ORDER, eventRef: ref, data, runEffect, nowMs: T0 })).toMatchObject({ ignored: 'already_applied' });
    expect(store.read(ref.path)).toMatchObject({ result: 'applied' });
    expect(effects.filter((effect) => effect.kind === 'owner_review')).toHaveLength(1);
  });

  it('never leaves an event marked applied when its transition failed: the redelivery applies it', async () => {
    const events = store.db.collection('assisted_applications').doc(ORDER).collection('automation_events');
    const ref = await events.add({ type: 'draft_ready', round: 1 });
    const data = store.read(ref.path);
    let failures = 1;
    const flaky = {
      ...store.db,
      runTransaction: async (callback: any) => {
        if (failures-- > 0) throw new Error('transaction aborted');
        return store.db.runTransaction(callback);
      },
    };
    await expect(handleRunnerEvent({ db: flaky, orderId: ORDER, eventRef: ref, data, runEffect, nowMs: T0 })).rejects.toThrow('transaction aborted');
    expect(store.read(ref.path)?.appliedAt).toBeUndefined();
    expect(store.read(`${ORDER_PATH}/automation/flow`)?.state).toBe('drafting');
    expect(await handleRunnerEvent({ db: flaky, orderId: ORDER, eventRef: ref, data, runEffect, nowMs: T0 })).toMatchObject({ ok: true });
    expect(store.read(ref.path)).toMatchObject({ appliedAt: T0, result: 'applied' });
    expect(store.read(`${ORDER_PATH}/automation/flow`)?.state).toBe('owner_review');
  });
});

describe('closed ad refund', () => {
  it('sends the "refunded" e-mail only after the refund went through, retrying a failed one', async () => {
    const sent: string[] = [];
    const sendNotification = vi.fn(async (args: any) => {
      sent.push(args.key);
      return { ok: true, key: args.key };
    });
    let refundOk = false;
    const issueRefund = vi.fn(async () => {
      if (!refundOk) throw Object.assign(new Error('stripe_unavailable'), { code: 'stripe_unavailable' });
      return { status: 200, body: { ok: true } };
    });
    const effect = { type: 'refund', reason: 'posting_closed', notify: 'candidate_posting_closed' };
    const failed: any = await runAutomationEffect({ db: store.db, orderId: ORDER, effect, flow: { round: 1 }, nowMs: T0 }, { issueRefund, sendNotification });
    expect(failed).toMatchObject({ ok: false, attempts: 1 });
    expect(sent).toEqual([]);
    expect(store.read(ORDER_PATH)).toMatchObject({ automationRefundDueAt: T0 + 15 * 60_000, automationRefund: { status: 'retrying', attempts: 1, notify: 'candidate_posting_closed' } });

    // The sweep retries it; this time the refund goes through: one e-mail.
    refundOk = true;
    await runAutomationSweep({ db: store.db, runEffect: (context: any) => runAutomationEffect(context, { issueRefund, sendNotification }), nowMs: T0 + 16 * 60_000 });
    expect(sent).toEqual(['auto_candidate_posting_closed']);
    expect(store.read(ORDER_PATH)).toMatchObject({ automationRefundDueAt: null, automationRefund: { status: 'refunded' } });
  });

  it('alerts the owner at once when the refund is refused for good', async () => {
    const sent: string[] = [];
    const sendNotification = vi.fn(async (args: any) => { sent.push(args.key); return { ok: true }; });
    const issueRefund = vi.fn(async () => { throw Object.assign(new Error('already_submitted'), { code: 'already_submitted' }); });
    await runAutomationEffect({ db: store.db, orderId: ORDER, effect: { type: 'refund', reason: 'posting_closed', notify: 'candidate_posting_closed' }, flow: { round: 1 }, nowMs: T0 }, { issueRefund, sendNotification });
    expect(sent).toEqual(['auto_owner_takeover_refund_failed_r1']);
    expect(store.read(ORDER_PATH)).toMatchObject({ automationRefundDueAt: null, automationRefund: { status: 'failed' } });
  });
});

describe('owner queue', () => {
  it('cannot start the flow while the Remote Config flag is off', async () => {
    const { handleAutomationAdminAction } = await import('../functions/src/assistedApplicationAutomationAdmin.js');
    const dispatch = vi.fn();
    await expect(handleAutomationAdminAction(store.db, { action: 'automationStart', orderId: ORDER }, 'owner@example.com', {
      runEffect: dispatch, isEnabled: async () => false, nowMs: T0,
    })).rejects.toMatchObject({ code: 'automation_disabled', status: 409 });
    expect(store.read(`${ORDER_PATH}/automation/flow`)).toBeUndefined();
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe('sweep', () => {
  it('fires the owner clock, then the candidate clock', async () => {
    await startAutomation({ db: store.db, orderId: ORDER, runEffect, nowMs: T0 });
    await store.db.collection('assisted_applications').doc(ORDER).collection('ai_drafts').doc('current').set(readyDraft());
    await applyAutomationEvent({ db: store.db, orderId: ORDER, event: { type: 'draft_ready', round: 1 }, runEffect, nowMs: T0 });
    effects = [];

    expect(await runAutomationSweep({ db: store.db, runEffect, nowMs: T0 + OWNER_REVIEW_MS - 1 })).toMatchObject({ ticks: 0 });
    expect(await runAutomationSweep({ db: store.db, runEffect, nowMs: T0 + OWNER_REVIEW_MS })).toMatchObject({ ticks: 1 });
    expect(store.read(`${ORDER_PATH}/automation/flow`)?.state).toBe('candidate_review');
    expect(effects).toEqual([{ type: 'email', kind: 'candidate_review', held: false, round: 1 }]);

    const candidateDeadline = T0 + OWNER_REVIEW_MS + CANDIDATE_REVIEW_MS;
    await runAutomationSweep({ db: store.db, runEffect, nowMs: candidateDeadline });
    expect(store.read(`${ORDER_PATH}/automation/flow`)?.state).toBe('submitting');
    expect(effects.at(-1)).toEqual({ type: 'dispatch', mode: 'submit', reason: 'auto_approved_12h' });
  });

  it('re-dispatches a silent run once, then hands the order to Valerie', async () => {
    await startAutomation({ db: store.db, orderId: ORDER, runEffect, nowMs: T0 });
    effects = [];
    expect(await runAutomationSweep({ db: store.db, runEffect, nowMs: T0 + RUN_WATCHDOG_MS })).toMatchObject({ redispatched: 1 });
    expect(effects).toEqual([{ type: 'dispatch', mode: 'draft', reason: 'watchdog' }]);
    expect(store.read(`${ORDER_PATH}/automation/flow`)?.dispatch).toMatchObject({ attempts: 2 });
    expect(await runAutomationSweep({ db: store.db, runEffect, nowMs: T0 + 2 * RUN_WATCHDOG_MS })).toMatchObject({ timedOut: 1 });
    expect(store.read(`${ORDER_PATH}/automation/flow`)).toMatchObject({ state: 'owner_takeover', heldBy: ['draft_failed'] });
    expect(effects.at(-1)).toMatchObject({ type: 'email', kind: 'owner_takeover', reason: 'runner_timeout' });
  });

  it('computes no due time for terminal flows', () => {
    expect(computeDueAt({ state: 'submitted', deadlineAt: 5 })).toBeNull();
    expect(computeDueAt({ state: 'candidate_review', deadlineAt: 10, reminderAt: 7 })).toBe(7);
  });
});

describe('effects', () => {
  it('keys one e-mail per kind and round', () => {
    expect(automationEmailKey({ kind: 'owner_review', held: true }, { round: 2 })).toBe('auto_owner_review_r2_held');
    expect(automationEmailKey({ kind: 'candidate_review' }, { round: 1 })).toBe('auto_candidate_review_r1');
    expect(automationEmailKey({ kind: 'owner_takeover', reason: 'max_rounds' }, { round: 3 })).toBe('auto_owner_takeover_max_rounds_r3');
    expect(automationEmailKey({ kind: 'candidate_handoff' }, { round: 2 })).toBe('auto_candidate_handoff');
  });

  it('dispatches the current round, marks the order submitted and refunds a closed ad', async () => {
    const dispatch = vi.fn(async () => ({ ok: true }));
    await runAutomationEffect({ db: store.db, orderId: ORDER, effect: { type: 'dispatch', mode: 'submit' }, flow: { round: 2 }, nowMs: T0 }, { dispatch });
    expect(dispatch).toHaveBeenCalledWith({ orderId: ORDER, mode: 'submit', round: 2 });

    await runAutomationEffect({ db: store.db, orderId: ORDER, effect: { type: 'mark_submitted' }, flow: { round: 1, submittedVia: 'email' }, nowMs: T0 });
    expect(store.read(ORDER_PATH)).toMatchObject({ submissionStatus: 'submitted', submissionNotes: 'Candidatura inviata da automazione (email).' });

    const issueRefund = vi.fn(async () => ({ status: 200 }));
    await runAutomationEffect({ db: store.db, orderId: ORDER, effect: { type: 'refund', reason: 'posting_closed' }, flow: { round: 1 }, nowMs: T0 }, { issueRefund });
    expect(issueRefund).toHaveBeenCalledWith(store.db, expect.objectContaining({ orderId: ORDER }), 'automation');
  });

  it('builds the candidate e-mail with the signed review link', async () => {
    await store.db.collection('assisted_applications').doc(ORDER).collection('ai_drafts').doc('current').set(readyDraft());
    const sendNotification = vi.fn(async (args: any) => {
      const message = args.build(paidOrder());
      return { ok: true, message, key: args.key, audience: args.audience };
    });
    const result: any = await runAutomationEffect(
      { db: store.db, orderId: ORDER, effect: { type: 'email', kind: 'candidate_review', held: false }, flow: { round: 1, deadlineAt: T0 + CANDIDATE_REVIEW_MS, answers: {} }, nowMs: T0 },
      { sendNotification, getSecret: async () => 's'.repeat(40) },
    );
    expect(result).toMatchObject({ key: 'auto_candidate_review_r1', audience: 'customer' });
    expect(result.message.text).toMatch(/assisted_application_review=ar1\.order_ABC123\.1\./);
    expect(result.message.text).toContain('la candidatura partirà automaticamente così com’è');
  });
});
