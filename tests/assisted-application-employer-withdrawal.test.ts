// Owner decision 2026-11-11: «Comunichiamo che le posizioni sono state ritirate e che l'application è stata
// ritirata. quindi va in archiviati, nessun rimborso emesso era nelle regole del terms and condition.»
// When the posting's own word proves the employer withdrew or closed it while the round waited for the
// candidate (Terms 6.5), the application is withdrawn and archived, the candidate is told once, nothing is
// refunded. Every order, name, posting and address here is invented.
import { describe, expect, it, vi } from 'vitest';
import { createMemoryFirestore } from './helpers/memoryFirestore';
import { CANDIDATE_REVIEW_MS, HELD_REMINDERS_AFTER_MS, employerWithdrawalPending, transition as flowTransition } from '../functions/src/assistedApplicationFlow.js';
import { applyAutomationEvent as applyEvent, runAutomationSweep as sweep } from '../functions/src/assistedApplicationAutomation.js';
import { automationEmailKey, runAutomationEffect } from '../functions/src/assistedApplicationAutomationEffects.js';
import { buildCandidateAutomationEmail } from '../functions/src/assistedApplicationAutomationEmails.js';
import { classifyLiveness } from '../functions/src/assistedApplicationLiveness.js';
import {
  EMPLOYER_WITHDRAWAL_REASON,
  closureCodeOf,
  nativeClosureOf,
  sendMayHaveLeft,
} from '../functions/src/assistedApplicationEmployerWithdrawal.js';
import { postingWithdrawnByMail } from '../functions/src/assistedApplicationInbound.js';
import { candidateStatusForAssistedApplication } from '../functions/src/assistedApplicationCandidateStatusCore.js';
import { nextStepFor } from '../services/assistedApplicationNextStep';
import {
  nativeClosureFromRunnerEvents,
  postingWithdrawalBlocker as blocker,
  reconcilePostingWithdrawals as reconcile,
} from '../scripts/assisted-application/reconcile-posting-withdrawals.mjs';

// The modules are JavaScript with JSDoc defaults narrower than their contracts: called loosely here.
const transition: (...args: any[]) => any = flowTransition as any;
const applyAutomationEvent: (...args: any[]) => Promise<any> = applyEvent as any;
const runAutomationSweep: (...args: any[]) => Promise<any> = sweep as any;
const postingWithdrawalBlocker: (...args: any[]) => string = blocker as any;
const reconcilePostingWithdrawals: (...args: any[]) => Promise<any> = reconcile as any;

const T0 = Date.UTC(2026, 10, 1, 8, 0, 0);
const HOUR = 60 * 60 * 1000;
const ORDER = 'assisted_applications/o1';
const FLOW = `${ORDER}/automation/flow`;
const SUBMISSION = `${ORDER}/automation/submission`;
const draft = { status: 'ready', round: 1, job: { source: 'job_detail', title: 'Sachbearbeiterin' }, channel: { type: 'portal' }, factCheck: { ok: true, unsupported: [] }, questions: [{ id: 'q1', required: true }] };
// The round waited for the candidate's answer, which came; the runner was then sent to submit.
const waited = { state: 'submitting', round: 1, shownRounds: [1], heldBy: [], lastWait: { round: 1, since: T0, until: T0 + 10 * HOUR }, dispatch: { mode: 'submit', round: 1, requestedAt: T0 + 10 * HOUR } };
// The candidate is still awaited (a question only they can answer).
const waiting = { state: 'candidate_review', round: 1, shownRounds: [1], heldBy: ['question:q1'], heldSince: T0, heldNudges: 0, reminderAt: T0 + HELD_REMINDERS_AFTER_MS[0], deadlineAt: null };
const paidOrder = { paymentStatus: 'paid', submissionStatus: 'awaiting_upload', automationState: 'submitting', jobId: 'esempio-1', jobUrl: 'https://jobs.example.com/posting/1', companyName: 'Esempio AG', jobTitle: 'Sachbearbeiterin' };

function seed({ order = paidOrder as any, flow = waited as any, submission = null as any, events = {} as Record<string, any> } = {}) {
  return createMemoryFirestore({
    [ORDER]: order,
    [FLOW]: flow,
    [`${ORDER}/ai_drafts/current`]: draft,
    ...(submission ? { [SUBMISSION]: submission } : {}),
    ...Object.fromEntries(Object.entries(events).map(([id, data]) => [`${ORDER}/automation_events/${id}`, data])),
  });
}

function recorder() {
  const effects: any[] = [];
  return { effects, runEffect: async (context: any) => { effects.push(context.effect); return { ok: true }; } };
}

describe('the proof of closure is the posting\'s own word', () => {
  it('counts the posting page, the portal page and the ATS, never a reading of ours', () => {
    for (const code of ['http_gone', 'expired_url', 'expired_body']) expect(nativeClosureOf({ reason: code }, T0)).toEqual({ code, source: 'posting_page', at: T0 });
    for (const code of ['ats_api_gone', 'ats_api_closed']) expect(nativeClosureOf({ reason: code }, T0)?.source).toBe('ats_api');
    expect(nativeClosureOf({ reason: 'employer_mail', closedAt: T0 - HOUR }, T0)).toEqual({ code: 'employer_mail', source: 'employer_mail', at: T0 - HOUR });
    // The draft run reports the code in its error: «posting_closed:<code>».
    expect(closureCodeOf({ error: 'posting_closed:expired_body' })).toBe('expired_body');
    expect(nativeClosureOf({ error: 'posting_closed:http_gone' }, T0)?.code).toBe('http_gone');
    // Our dataset, a page that looks empty or lists jobs, a blocked or failed fetch: no proof.
    for (const code of ['dataset', 'posting_closed:dataset', 'expired_body_soft', 'listing_page', 'insufficient_content', 'no_apply_control', 'bot_challenge', 'access_blocked', 'server_error', 'fetch_failed', 'not_public', 'not_checked', 'redirected_off_posting', '']) {
      expect(nativeClosureOf({ reason: code }, T0), code).toBeNull();
    }
  });

  it('reads a timeout, a server error or an anti-bot page as uncertain, which proves nothing', () => {
    for (const page of [
      { status: 503, bodyText: 'Service Unavailable' },
      { status: 500, bodyText: 'Internal error' },
      { status: 200, bodyText: 'Just a moment... Performing security verification' },
    ]) {
      const liveness = classifyLiveness(page);
      expect(liveness.result).toBe('uncertain');
      expect(nativeClosureOf({ reason: liveness.code }, T0)).toBeNull();
    }
    // The portal's own statement (Stadt Zürich's SuccessFactors notice, 2026-11-10) is proof.
    const portal = classifyLiveness({ status: 200, bodyText: 'Diese Stelle kann zurzeit nicht angezeigt werden. Sie wurde entweder gelöscht, oder man kann sich nicht länger darauf bewerben.' });
    expect(nativeClosureOf({ reason: portal.code }, T0)?.source).toBe('posting_page');
  });
});

describe('a native closure while the round waited for the candidate', () => {
  it('withdraws and archives the application, tells the candidate once, refunds nothing', () => {
    for (const [flow, code] of [[waited, 'http_gone'], [waiting, 'expired_body'], [waited, 'ats_api_gone']] as const) {
      const step = transition(flow, { type: 'posting_closed', reason: code }, { draft, nowMs: T0 + 11 * HOUR });
      expect(step.flow).toMatchObject({
        state: 'withdrawn', withdrawnAt: T0 + 11 * HOUR, withdrawnReason: EMPLOYER_WITHDRAWAL_REASON,
        withdrawalEvidence: { kind: code, at: T0 + 11 * HOUR }, heldBy: [], deadlineAt: null, reminderAt: null, portalAutoRetryAt: null,
      });
      expect(step.effects).toEqual([{ type: 'email', kind: 'candidate_posting_withdrawn' }]);
      expect(step.effects.some((effect: any) => effect.type === 'refund' || effect.type === 'dispatch')).toBe(false);
      // A withdrawn flow takes no further event: no retry, no recovery, no second message.
      for (const event of [{ type: 'posting_closed', reason: code }, { type: 'portal_auto_retry' }, { type: 'tick' }, { type: 'owner_retry_submit' }]) {
        expect(transition(step.flow, event, { draft, nowMs: T0 + 12 * HOUR }).ignored).toBe('withdrawn');
      }
    }
  });

  it('keeps today\'s path for a reading of ours: Valerie decides, nothing withdrawn, nothing refunded', () => {
    for (const event of [{ type: 'posting_closed' }, { type: 'posting_closed', reason: 'dataset' }, { type: 'posting_closed', reason: 'listing_page' }]) {
      const step = transition(waited, event, { draft, nowMs: T0 + 11 * HOUR });
      expect(step.flow).toMatchObject({ state: 'owner_takeover', heldBy: ['posting_closed'] });
      expect(step.effects).toEqual([{ type: 'email', kind: 'owner_takeover', reason: 'posting_closed_waited' }]);
    }
  });

  // Owner decision 2026-11-11 (later the same day: «il rimborso non è mai consentito una volta che il processo è
  // stato avviato»): this automatic refund is left only to an order under the older Terms (a mandate v2 here).
  // The new Terms are in assisted-application-no-refund-after-start.test.ts.
  it('still refunds by itself, under the older Terms, an ad that closed with nobody waiting for the candidate', () => {
    const notWaited = { state: 'submitting', round: 1, shownRounds: [1], heldBy: [] };
    const olderTerms = { consentVersion: 'assisted-application-v2', consentedAt: T0 };
    const step = transition(notWaited, { type: 'posting_closed', reason: 'http_gone' }, { order: olderTerms, draft, nowMs: T0 });
    expect(step.flow).toMatchObject({ state: 'owner_takeover', heldBy: ['posting_closed'], postingClosure: { code: 'http_gone' } });
    expect(step.effects[0]).toMatchObject({ type: 'refund', notify: 'candidate_posting_closed' });
    // That proof on record never turns it into a withdrawal later.
    expect(employerWithdrawalPending(step.flow)).toBe(false);
    expect(employerWithdrawalPending(step.flow, olderTerms)).toBe(false);
  });

  it('writes the withdrawal with its proof and closes the submission fence, without a refund', async () => {
    const store = seed();
    const { effects, runEffect } = recorder();
    const result = await applyAutomationEvent({ db: store.db, orderId: 'o1', event: { type: 'posting_closed', reason: 'expired_body', round: 1 }, actor: 'runner', runEffect, nowMs: T0 + 11 * HOUR });
    expect(result).toMatchObject({ ok: true });
    expect(effects).toEqual([{ type: 'email', kind: 'candidate_posting_withdrawn' }]);
    expect(store.read(FLOW)).toMatchObject({ state: 'withdrawn', withdrawnReason: EMPLOYER_WITHDRAWAL_REASON, withdrawalEvidence: { kind: 'expired_body', source: 'posting_page' } });
    const order = store.read(ORDER)!;
    expect(order).toMatchObject({ submissionStatus: 'withdrawn', automationState: 'withdrawn', automationDueAt: null, withdrawnAt: T0 + 11 * HOUR, withdrawalReason: EMPLOYER_WITHDRAWAL_REASON, withdrawalEvidence: { kind: 'expired_body', source: 'posting_page', at: T0 + 11 * HOUR } });
    expect(order.automationRefund).toBeUndefined();
    expect(order.refundStatus).toBeUndefined();
    expect(store.read(SUBMISSION)).toMatchObject({ withdrawnAt: T0 + 11 * HOUR });
    // The candidate's dashboard shows it among the withdrawn applications.
    expect(candidateStatusForAssistedApplication(order)).toBe('withdrawn');
    // The owner queue lists it as done.
    expect(nextStepFor({ submissionStatus: order.submissionStatus, hasCv: true, automation: { flow: store.read(FLOW) as any } })).toMatchObject({ group: 'done', code: 'posting_withdrawn' });
  });

  it('sends one message on a double pass, keyed once per order', async () => {
    const store = seed();
    const sent: string[] = [];
    const runEffect = (context: any) => runAutomationEffect(context, {
      sendNotification: async ({ key }: any) => { sent.push(key); return { ok: true, key }; },
      issueRefund: vi.fn(async () => { throw new Error('no refund expected'); }),
    });
    const first = await applyAutomationEvent({ db: store.db, orderId: 'o1', event: { type: 'posting_closed', reason: 'http_gone', round: 1 }, actor: 'runner', runEffect, nowMs: T0 + 11 * HOUR });
    const second = await applyAutomationEvent({ db: store.db, orderId: 'o1', event: { type: 'posting_closed', reason: 'http_gone', round: 1 }, actor: 'runner', runEffect, nowMs: T0 + 12 * HOUR });
    expect(first.ok).toBe(true);
    expect(second).toMatchObject({ ok: false, ignored: 'withdrawn' });
    expect(sent).toEqual(['auto_candidate_posting_withdrawn']);
    expect(automationEmailKey({ kind: 'candidate_posting_withdrawn' }, { round: 3 })).toBe('auto_candidate_posting_withdrawn');
    expect(store.read(ORDER)?.withdrawnAt).toBe(T0 + 11 * HOUR);
  });
});

describe('a timeout or a network error changes nothing', () => {
  it('keeps the wait and its reminder when the look fails, times out, or reads no native closure', async () => {
    const due = waiting.reminderAt;
    const run = async (look: any, postingLookMs = 500) => {
      const store = createMemoryFirestore({
        [ORDER]: { ...paidOrder, automationState: 'candidate_review', automationDueAt: due },
        [FLOW]: waiting,
        [`${ORDER}/ai_drafts/current`]: draft,
      });
      const { effects, runEffect } = recorder();
      await runAutomationSweep({ db: store.db, nowMs: due, postingClosed: look, postingLookMs, runEffect });
      return { effects, flow: store.read(FLOW) };
    };
    const reminder = [{ type: 'email', kind: 'candidate_questions_reminder', nudge: 1, since: T0 }];
    expect((await run(vi.fn(async () => { throw new Error('ECONNRESET'); }))).effects).toEqual(reminder);
    expect((await run(vi.fn(() => new Promise((resolve) => { setTimeout(() => resolve({ closed: true, closure: { code: 'http_gone', source: 'posting_page', at: T0 } }), 300); })), 20)).effects).toEqual(reminder);
    expect((await run(vi.fn(async () => false))).effects).toEqual(reminder);
    // Closed by a reading of ours (the dataset): the silent wait of today, Valerie told, nothing withdrawn.
    const ours = await run(vi.fn(async () => ({ closed: true, closure: null })));
    expect(ours.effects).toEqual([{ type: 'email', kind: 'owner_posting_expired', since: T0 }]);
    expect(ours.flow).toMatchObject({ state: 'candidate_review', heldBy: ['question:q1'] });
    // The posting's own word: withdrawn, the candidate told, nothing else.
    const native = await run(vi.fn(async () => ({ closed: true, closure: { code: 'http_gone', source: 'posting_page', at: due } })));
    expect(native.effects).toEqual([{ type: 'email', kind: 'candidate_posting_withdrawn' }]);
    expect(native.flow).toMatchObject({ state: 'withdrawn', withdrawnReason: EMPLOYER_WITHDRAWAL_REASON });
  });

  it('leaves a runner failure on its retry path', () => {
    const submitting = { state: 'submitting', round: 1, shownRounds: [1], heldBy: [], dispatch: { mode: 'submit', round: 1, attempts: 1 } };
    for (const error of ['timeout', 'ECONNRESET', 'runner_infrastructure_unavailable']) {
      const step = transition(submitting, { type: 'submit_failed', error }, { draft, nowMs: T0 });
      expect(step.flow.state).toBe('submitting');
      expect(step.effects).toEqual([{ type: 'dispatch', mode: 'submit', reason: 'transient_retry', attempts: 2 }]);
    }
  });
});

describe('an application already sent is never touched', () => {
  it('ignores a closure on a submitted flow', () => {
    expect(transition({ state: 'submitted', round: 1 }, { type: 'posting_closed', reason: 'http_gone' }, { draft, nowMs: T0 }).ignored).toBe('terminal');
    expect(transition({ state: 'candidate_handoff', round: 1 }, { type: 'posting_closed', reason: 'http_gone' }, { draft, nowMs: T0 }).ignored).toBe('not_open');
  });

  it('does not withdraw when a send is on record or a final click was never proved failed', async () => {
    expect(sendMayHaveLeft({ draft: { sent: { at: T0 } } })).toBe(true);
    expect(sendMayHaveLeft({ submission: { r1: { state: 'sent', channel: 'portal' } } })).toBe(true);
    expect(sendMayHaveLeft({ submission: { r1: { state: 'sending', channel: 'portal', clickedAt: T0, confirmedNotSent: false } } })).toBe(true);
    // Released for certain, and the legacy shape the submission guard reads as released.
    expect(sendMayHaveLeft({ submission: { r1: { state: 'failed', channel: 'portal', clickedAt: T0, confirmedNotSent: true } } })).toBe(false);
    expect(sendMayHaveLeft({ submission: { r1: { state: 'failed', channel: 'portal', clickedAt: T0, reason: 'portal_validation' } } })).toBe(false);
    expect(sendMayHaveLeft({ submission: { portalCodeRecovery: { kind: 'x' } } })).toBe(false);

    const store = seed({ submission: { r1: { state: 'sending', channel: 'portal', clickedAt: T0 + 10 * HOUR, confirmedNotSent: false } } });
    const { effects, runEffect } = recorder();
    await applyAutomationEvent({ db: store.db, orderId: 'o1', event: { type: 'posting_closed', reason: 'http_gone', round: 1 }, actor: 'runner', runEffect, nowMs: T0 + 11 * HOUR });
    expect(store.read(FLOW)).toMatchObject({ state: 'owner_takeover', heldBy: ['posting_closed'] });
    expect(store.read(ORDER)?.submissionStatus).toBe('awaiting_upload');
    expect(store.read(ORDER)?.withdrawnAt).toBeUndefined();
    expect(effects.map((effect) => effect.kind || effect.type)).toEqual(['owner_takeover']);
  });
});

describe('the employer\'s own e-mail', () => {
  it('reads a withdrawn or cancelled posting, never a filled post, a hypothesis or the application', () => {
    for (const text of [
      'Leider müssen wir Ihnen mitteilen, dass die Stelle zurückgezogen wurde.',
      'Die Ausschreibung wurde leider zurückgezogen.',
      'We regret to inform you that the position has been withdrawn.',
      'The requisition was cancelled by the hiring team.',
      'La posizione è stata ritirata dall’azienda.',
      'Le poste a été annulé.',
    ]) expect(postingWithdrawnByMail({ subject: 'Ihre Bewerbung', text }), text).toBe(true);
    for (const text of [
      'Your application has been withdrawn.',
      'If the position is withdrawn, we will let you know.',
      'The position has been filled.',
      'Die Stelle wurde bereits besetzt.',
      'The position has not been withdrawn.',
      'Thank you for your application for the position. We have received it.',
      // On hold may reopen: never a withdrawal (review of #18084).
      'The position has been put on hold.',
      'Die Stelle wurde vorübergehend sistiert.',
      'La selezione è stata sospesa.',
    ]) expect(postingWithdrawnByMail({ subject: 'Update', text }), text).toBe(false);
  });

  it('withdraws only a round that waited for the candidate; otherwise the runner reads the posting itself', () => {
    expect(transition(waiting, { type: 'posting_closed', reason: 'employer_mail', closedAt: T0 + HOUR }, { draft, nowMs: T0 + 2 * HOUR }).flow)
      .toMatchObject({ state: 'withdrawn', withdrawalEvidence: { kind: 'employer_mail', source: 'employer_mail', at: T0 + HOUR } });
    const notWaited = { state: 'candidate_review', round: 1, shownRounds: [1], heldBy: [], deadlineAt: T0 + CANDIDATE_REVIEW_MS };
    expect(transition(notWaited, { type: 'posting_closed', reason: 'employer_mail' }, { draft, nowMs: T0 }).ignored).toBe('mail_closure_not_waited');
  });
});

describe('the orders stopped before the decision', () => {
  const held = { state: 'owner_takeover', round: 1, shownRounds: [1], heldBy: ['posting_closed'], lastWait: { round: 1, since: T0, until: T0 + 10 * HOUR } };
  const heldOrder = { ...paidOrder, automationState: 'owner_takeover', automationDueAt: null };
  const runnerEvent = (reason: string, at: number, round = 1) => ({ type: 'posting_closed', reason, round, result: 'applied', appliedAt: at });

  it('take the runner\'s last word of the round as proof, and only a native one', () => {
    expect(nativeClosureFromRunnerEvents([runnerEvent('http_gone', T0)], 1)).toEqual({ code: 'http_gone', source: 'posting_page', at: T0 });
    expect(nativeClosureFromRunnerEvents([runnerEvent('expired_body', T0), runnerEvent('dataset', T0 + HOUR)], 1)).toBeNull();
    expect(nativeClosureFromRunnerEvents([runnerEvent('expired_body', T0, 2)], 1)).toBeNull();
    expect(nativeClosureFromRunnerEvents([{ ...runnerEvent('expired_body', T0), result: 'ignored:stale_round' }], 1)).toBeNull();
    const closure = { code: 'http_gone', source: 'posting_page', at: T0 };
    expect(postingWithdrawalBlocker({ order: heldOrder, flow: held, closure })).toBe('');
    expect(postingWithdrawalBlocker({ order: heldOrder, flow: { ...held, lastWait: null }, closure })).toBe('round_did_not_wait');
    expect(postingWithdrawalBlocker({ order: heldOrder, flow: held, closure: null })).toBe('no_native_proof');
    expect(postingWithdrawalBlocker({ order: { ...heldOrder, refundStatus: 'succeeded' }, flow: held, closure })).toBe('refund_on_record');
    expect(postingWithdrawalBlocker({ order: { ...heldOrder, submissionStatus: 'submitted' }, flow: held, closure })).toBe('settled');
    expect(postingWithdrawalBlocker({ order: heldOrder, flow: held, closure, submission: { r1: { state: 'sent' } } })).toBe('send_may_have_left');
    expect(postingWithdrawalBlocker({ order: heldOrder, flow: { ...held, heldBy: ['portal_ambiguous'] }, closure })).toBe('not_stopped_for_closed_posting');
  });

  it('dry-run writes nothing; apply records the proof, and the sweep withdraws once with one message', async () => {
    const store = seed({ order: heldOrder, flow: held, events: { e1: runnerEvent('expired_body', T0 + 10 * HOUR) } });
    const before = JSON.stringify([...store.docs.entries()]);
    const dry = await reconcilePostingWithdrawals({ db: store.db, nowMs: T0 + 20 * HOUR, look: vi.fn() });
    expect(dry).toMatchObject({ stopped: 1, eligible: 1, recorded: 0, apply: false, orders: [{ id: 'o1', outcome: 'eligible', evidence: 'expired_body' }] });
    expect(JSON.stringify([...store.docs.entries()])).toBe(before);

    const applied = await reconcilePostingWithdrawals({ db: store.db, apply: true, nowMs: T0 + 20 * HOUR, look: vi.fn() });
    expect(applied).toMatchObject({ eligible: 1, recorded: 1 });
    expect(store.read(FLOW)).toMatchObject({ state: 'owner_takeover', postingClosure: { code: 'expired_body', source: 'posting_page' } });
    expect(store.read(ORDER)?.automationDueAt).toBe(T0 + 20 * HOUR);

    const sent: string[] = [];
    const refunds = vi.fn();
    const runEffect = (context: any) => runAutomationEffect(context, {
      sendNotification: async ({ key }: any) => { sent.push(key); return { ok: true, key }; }, issueRefund: refunds,
    });
    const summary = await runAutomationSweep({ db: store.db, nowMs: T0 + 21 * HOUR, runEffect });
    expect(summary.employerWithdrawals).toBe(1);
    expect(store.read(FLOW)).toMatchObject({ state: 'withdrawn', withdrawnReason: EMPLOYER_WITHDRAWAL_REASON, withdrawalEvidence: { kind: 'expired_body' } });
    expect(store.read(ORDER)).toMatchObject({ submissionStatus: 'withdrawn', automationDueAt: null, withdrawalReason: EMPLOYER_WITHDRAWAL_REASON });
    // Again: nothing left to do, no second message, never a refund.
    await reconcilePostingWithdrawals({ db: store.db, apply: true, nowMs: T0 + 22 * HOUR, look: vi.fn() });
    await runAutomationSweep({ db: store.db, nowMs: T0 + 23 * HOUR, runEffect });
    expect(sent).toEqual(['auto_candidate_posting_withdrawn']);
    expect(refunds).not.toHaveBeenCalled();
  });

  it('looks again at a silent order, and a failed look proves nothing', async () => {
    const silent = { state: 'candidate_review', round: 1, shownRounds: [1], heldBy: [], postingExpiredAt: T0 + 30 * HOUR, deadlineAt: null, reminderAt: null, lastWait: { round: 1, since: T0, until: T0 + 20 * HOUR } };
    const silentOrder = { ...paidOrder, automationState: 'candidate_review', automationDueAt: null };
    const failed = seed({ order: silentOrder, flow: silent });
    expect(await reconcilePostingWithdrawals({ db: failed.db, apply: true, nowMs: T0 + 40 * HOUR, look: vi.fn(async () => { throw new Error('timeout'); }) }))
      .toMatchObject({ stopped: 1, eligible: 0, skipped: { no_native_proof: 1 } });
    expect(failed.read(FLOW)?.postingClosure).toBeUndefined();

    const store = seed({ order: silentOrder, flow: silent });
    const look = vi.fn(async () => ({ closed: true, closure: { code: 'ats_api_gone', source: 'ats_api', at: T0 + 40 * HOUR } }));
    expect(await reconcilePostingWithdrawals({ db: store.db, apply: true, nowMs: T0 + 40 * HOUR, look })).toMatchObject({ recorded: 1 });
    const { effects, runEffect } = recorder();
    await runAutomationSweep({ db: store.db, nowMs: T0 + 41 * HOUR, runEffect });
    expect(effects).toEqual([{ type: 'email', kind: 'candidate_posting_withdrawn' }]);
    expect(store.read(FLOW)).toMatchObject({ state: 'withdrawn', withdrawalEvidence: { kind: 'ats_api_gone', source: 'ats_api' } });
  });
});

describe('the candidate\'s message', () => {
  it('says the employer withdrew the position and the application was withdrawn, and promises no refund', () => {
    const expected = {
      it: ['ritirato la posizione', 'è stata quindi ritirata', 'l’importo non è rimborsato', 'punto 6.5'],
      de: ['die Stelle Sachbearbeiterin zurückgezogen', 'wurde deshalb zurückgezogen', 'nicht erstattet', 'Ziffer 6.5'],
      fr: ['a retiré le poste', 'a donc été retirée', 'n’est pas remboursé', 'point 6.5'],
      en: ['withdrew the Sachbearbeiterin position', 'has therefore been withdrawn', 'is not refunded', 'section 6.5'],
    };
    for (const [locale, phrases] of Object.entries(expected)) {
      const email = buildCandidateAutomationEmail('candidate_posting_withdrawn', { locale, name: 'Anna Beispiel', job: 'Sachbearbeiterin', company: 'Esempio AG', jobUrl: 'https://jobs.example.com/posting/1', reviewUrl: '', orderId: 'o1' });
      for (const phrase of phrases) expect(email.text, `${locale}: ${phrase}`).toContain(phrase);
      // No refund promised, no link to a posting that is gone or to an application that can no longer leave.
      expect(email.text).not.toMatch(/rimborsato \{price\}|ti abbiamo rimborsato|zurückerstattet|vous avons remboursé|we refunded/i);
      expect(email.html).not.toContain('https://jobs.example.com/posting/1');
    }
  });
});
