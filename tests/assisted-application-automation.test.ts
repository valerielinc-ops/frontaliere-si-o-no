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
  isAutomationEnabled,
  isAutomationEnabledFor,
  maybeStartAutomation,
  parseAutomationFlag,
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

  it('automates only the orders the flag names during the trial run', async () => {
    expect(parseAutomationFlag(' TRUE ')).toMatchObject({ all: true });
    expect(parseAutomationFlag('false').orders.size + parseAutomationFlag('').orders.size).toBe(0);
    expect([...parseAutomationFlag('order_A, order_B  order_C').orders]).toEqual(['order_A', 'order_B', 'order_C']);

    const before = paidOrder({ cvFileCheck: null });
    const after = paidOrder();
    rc.values.ASSISTED_APPLICATION_AUTOMATION = 'order_OTHER';
    expect(await isAutomationEnabled()).toBe(true);
    expect(await isAutomationEnabledFor(ORDER)).toBe(false);
    expect(await maybeStartAutomation(before, after, ORDER, { db: store.db, runEffect, nowMs: T0 })).toMatchObject({ skipped: 'automation_disabled' });

    rc.values.ASSISTED_APPLICATION_AUTOMATION = `order_OTHER,${ORDER}`;
    expect(await isAutomationEnabledFor(ORDER)).toBe(true);
    expect(await maybeStartAutomation(before, after, ORDER, { db: store.db, runEffect, nowMs: T0 })).toMatchObject({ started: true });

    // A Remote Config error is "off" for everyone.
    expect(await isAutomationEnabled(async () => { throw new Error('rc_down'); })).toBe(false);
    expect(await isAutomationEnabledFor(ORDER, async () => { throw new Error('rc_down'); })).toBe(false);
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

  it('runs the draft again after a transient Codex failure, counting the attempt', async () => {
    const result = await applyAutomationEvent({ db: store.db, orderId: ORDER, event: { type: 'draft_failed', round: 1, error: 'codex auth broker rejected the request' }, actor: 'runner', runEffect, nowMs: T0 + 1000 });
    expect(result.ok).toBe(true);
    expect(store.read(`${ORDER_PATH}/automation/flow`)).toMatchObject({ state: 'drafting', dispatch: { mode: 'draft', attempts: 2, reason: 'transient_retry' } });
    expect(effects).toEqual([{ type: 'dispatch', mode: 'draft', reason: 'transient_retry', attempts: 2 }]);
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
  // The owner's edit is written only on the draft it was built from, as the candidate's own writes are.
  it('refuses an owner edit when the candidate changed the draft meanwhile, and writes it otherwise', async () => {
    const { handleAutomationAdminAction } = await import('../functions/src/assistedApplicationAutomationAdmin.js');
    const draftPath = `${ORDER_PATH}/ai_drafts/current`;
    const draft = {
      ...readyDraft(),
      language: 'it',
      factSources: {},
      coverLetter: { salutation: 'Gentili signore e signori,', paragraphs: ['Mi candido per il posto di infermiere.'], closing: 'Cordiali saluti', subject: '' },
      applicationEmail: { to: 'hr@example.com', subject: 'Candidatura infermiere', body: 'In allegato la mia candidatura.' },
    };
    const draftRef = store.db.collection('assisted_applications').doc(ORDER).collection('ai_drafts').doc('current');
    await draftRef.set(draft);
    const edit = { action: 'automationEditDraft', orderId: ORDER, emailSubject: 'Candidatura per il posto di infermiere' };

    // A candidate edit lands between the owner's read and the owner's write.
    const runTransaction = store.db.runTransaction.bind(store.db);
    const once = vi.spyOn(store.db, 'runTransaction').mockImplementationOnce(async (callback: any) => {
      await draftRef.set({ candidateEditedAt: T0 + 1, applicationEmail: { ...draft.applicationEmail, subject: 'Oggetto del candidato' } }, { merge: true });
      return runTransaction(callback);
    });
    await expect(handleAutomationAdminAction(store.db, edit, 'owner@example.com', { runEffect, nowMs: T0 + 2 }))
      .rejects.toMatchObject({ code: 'changed_meanwhile', status: 409 });
    expect(store.read(draftPath)).toMatchObject({ applicationEmail: { subject: 'Oggetto del candidato' } });
    expect(store.read(draftPath)?.editedAt).toBeUndefined();
    once.mockRestore();

    // Two owner edits of the letter in the same millisecond: one wins, and the file it points to survives.
    const saved = new Map<string, Buffer>();
    const bucket = { file: (key: string) => ({ save: async (data: Buffer) => { saved.set(key, data); }, delete: async () => { saved.delete(key); } }) };
    const letter = (text: string) => ({ action: 'automationEditDraft', orderId: ORDER, coverLetterText: `Gentili signore e signori,\n\n${text}\n\nCordiali saluti` });
    const results = await Promise.allSettled([
      handleAutomationAdminAction(store.db, letter('Mi candido per il posto di infermiere in reparto.'), 'owner@example.com', { runEffect, bucket, nowMs: T0 + 5 }),
      handleAutomationAdminAction(store.db, letter('Mi candido per il posto di infermiere in pronto soccorso.'), 'owner@example.com', { runEffect, bucket, nowMs: T0 + 5 }),
    ]);
    // Whether the two overlap or run one after the other, the file the draft names exists, and each
    // edit that went through left a file of its own (a refused one deletes only its own).
    const fulfilled = results.filter((result) => result.status === 'fulfilled').length;
    expect(fulfilled).toBeGreaterThanOrEqual(1);
    expect(saved.has(store.read(draftPath)?.coverLetterPdfKey)).toBe(true);
    expect(saved.size).toBe(fulfilled);

    // Reloaded on the current draft, the same edit goes through.
    await expect(handleAutomationAdminAction(store.db, edit, 'owner@example.com', { runEffect, nowMs: T0 + 3 }))
      .resolves.toMatchObject({ ok: true });
    expect(store.read(draftPath)).toMatchObject({ applicationEmail: { subject: 'Candidatura per il posto di infermiere' }, editedAt: T0 + 3, editedBy: 'owner@example.com' });
  });

  // #11026 took `knock_out` out of the owner flags: approving no longer records an acknowledgement of
  // it, and the queue no longer shows one. The field an older draft stored stays there, unread.
  it('approves without the old knock-out acknowledgement, leaving the one an older draft stored', async () => {
    const { handleAutomationAdminAction, loadAutomationForAdmin } = await import('../functions/src/assistedApplicationAutomationAdmin.js');
    const order = store.db.collection('assisted_applications').doc(ORDER);
    await order.collection('automation').doc('flow').set({ state: 'owner_review', round: 1, heldBy: ['no_posting'], answers: {} });
    await order.collection('ai_drafts').doc('current').set({ ...readyDraft(), verdict: 'poor', job: { source: 'none', title: 'Infermiere' }, knockOutAcknowledgedAt: T0 - 1 });
    await expect(handleAutomationAdminAction(store.db, {
      action: 'automationApprove', orderId: ORDER, acknowledgeKnockOut: true, acknowledgeFlags: ['knock_out', 'no_posting'],
    }, 'owner@example.com', { runEffect, nowMs: T0 })).resolves.toEqual({ ok: true, state: 'candidate_review' });
    const draft = store.read(`${ORDER_PATH}/ai_drafts/current`);
    expect(draft?.acknowledgedFlags).toEqual({ no_posting: T0 });
    expect(draft?.knockOutAcknowledgedAt).toBe(T0 - 1);
    expect((await loadAutomationForAdmin(store.db, ORDER))?.draft).not.toHaveProperty('knockOutAcknowledgedAt');
  });

  // 2026-10-01: three orders paid before the automation was on are started from the queue.
  it('gives an order the owner starts the same alias the trigger gives', async () => {
    const { handleAutomationAdminAction } = await import('../functions/src/assistedApplicationAutomationAdmin.js');
    await store.db.collection('assisted_applications').doc(ORDER).set(paidOrder());
    const steps: string[] = [];
    const ensureAlias = vi.fn(async () => { steps.push('alias'); return { address: 'c-abcdefghjk@candidature.frontaliereticino.ch', active: true }; });
    const dispatched: any[] = [];
    await expect(handleAutomationAdminAction(store.db, { action: 'automationStart', orderId: ORDER }, 'owner@example.com', {
      runEffect: async ({ effect }: any) => { steps.push('dispatch'); dispatched.push(effect); return { ok: true }; }, isEnabled: async () => true, ensureAlias, nowMs: T0,
    })).resolves.toEqual({ ok: true, state: 'drafting' });
    expect(ensureAlias).toHaveBeenCalledWith({ db: store.db, orderId: ORDER, nowMs: T0 });
    // The alias exists before the draft is dispatched: the runner writes it into the letter and the portal.
    expect(steps).toEqual(['alias', 'dispatch']);
    expect(dispatched).toEqual([{ type: 'dispatch', mode: 'draft', reason: 'owner_request' }]);
  });

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
    // A raw runner error names only its step.
    expect(automationEmailKey({ kind: 'owner_takeover', reason: 'Codex auth broker rejected the request: Codex CLI timed out after 600000ms', stage: 'draft' }, { round: 2 }))
      .toBe('auto_owner_takeover_draft_error_r2');
    expect(automationEmailKey({ kind: 'candidate_handoff' }, { round: 2 })).toBe('auto_candidate_handoff');
    // Each reminder of each wait for the candidate's answers is its own e-mail (never deduplicated away).
    expect(automationEmailKey({ kind: 'candidate_questions_reminder', nudge: 1, since: 1000 }, { round: 1 })).toBe('auto_candidate_questions_reminder_1000_n1');
    expect(automationEmailKey({ kind: 'candidate_questions_reminder', nudge: 2, since: 1000 }, { round: 1 })).toBe('auto_candidate_questions_reminder_1000_n2');
    expect(automationEmailKey({ kind: 'candidate_questions_reminder', nudge: 1, since: 9000 }, { round: 1 })).toBe('auto_candidate_questions_reminder_9000_n1');
    expect(automationEmailKey({ kind: 'owner_candidate_silent', since: 1000 }, { round: 1 })).toBe('auto_owner_candidate_silent_1000');
  });

  it('dispatches the current round, marks the order submitted and refunds a closed ad', async () => {
    const dispatch = vi.fn(async () => ({ ok: true }));
    await runAutomationEffect({ db: store.db, orderId: ORDER, effect: { type: 'dispatch', mode: 'submit' }, flow: { round: 2 }, nowMs: T0 }, { dispatch });
    expect(dispatch).toHaveBeenCalledWith({ orderId: ORDER, mode: 'submit', round: 2 });

    await runAutomationEffect({ db: store.db, orderId: ORDER, effect: { type: 'mark_submitted' }, flow: { round: 1, submittedVia: 'email' }, nowMs: T0 });
    expect(store.read(ORDER_PATH)).toMatchObject({ submissionStatus: 'submitted', submissionNotes: 'Candidatura inviata da automazione (email).' });
    // A WhatsApp application: sent once the candidate has the link and the steps (owner decision 2026-10-03).
    await store.db.collection('assisted_applications').doc(ORDER).set({ submissionStatus: 'in_progress' }, { merge: true });
    await runAutomationEffect({ db: store.db, orderId: ORDER, effect: { type: 'mark_submitted' }, flow: { round: 1, submittedVia: 'whatsapp' }, nowMs: T0 });
    expect(store.read(ORDER_PATH)?.submissionNotes).toBe('Candidatura via WhatsApp: link e istruzioni inviati al candidato, che la completa dal proprio telefono.');

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

  // Close-out of 2026-10-03: the review e-mail words the fit paragraph as the page does.
  it('words the review e-mail\'s fit paragraph from the draft: no list without gaps, no answers without questions', async () => {
    const draftRef = store.db.collection('assisted_applications').doc(ORDER).collection('ai_drafts').doc('current');
    const sendNotification = vi.fn(async (args: any) => ({ ok: true, message: args.build(paidOrder()) }));
    const review = async () => ((await runAutomationEffect(
      { db: store.db, orderId: ORDER, effect: { type: 'email', kind: 'candidate_review', held: false }, flow: { round: 1, deadlineAt: T0 + CANDIDATE_REVIEW_MS, answers: {} }, nowMs: T0 },
      { sendNotification, getSecret: async () => 's'.repeat(40) },
    )) as any).message.text as string;
    // A verdict «poor» with no decisive requirement missing, and no question.
    await draftRef.set({ ...readyDraft(), verdict: 'poor' });
    const far = await review();
    expect(far).toContain('il tuo profilo sembra lontano da quello che chiede l’annuncio');
    expect(far).not.toContain('Nella pagina trovi');
    expect(far).not.toContain('nelle risposte');
    expect(far).toContain('«Chiedi modifiche»');
    // With a question to answer, the same draft points to the answers.
    await draftRef.set({ ...readyDraft(), verdict: 'poor', questions: [{ id: 'work_permit', question: 'Hai un permesso?', type: 'text', required: false }] });
    expect(await review()).toContain('precisalo nelle risposte prima dell’invio');
  });
});
