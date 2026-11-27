// Owner decision 2026-11-27 («Scadenza con chiusura»): a wait for documents or answers only the candidate can
// give is reminded weekly after Valerie's notice, and closes at 30 days: withdrawn, one e-mail, a refund only
// where the accepted Terms promise it (mandate v1/v2), never an e-mail to the employer. Every order, name and
// posting here is invented.
import { describe, expect, it, vi } from 'vitest';
import { createMemoryFirestore } from './helpers/memoryFirestore';
import { HELD_OWNER_NOTICE_AFTER_MS, HELD_REMINDERS_AFTER_MS, transition as flowTransition } from '../functions/src/assistedApplicationFlow.js';
import { applyAutomationEvent as applyEvent, runAutomationSweep as sweep, sweepStaleCandidateOrders as staleSweep } from '../functions/src/assistedApplicationAutomation.js';
import { runAutomationEffect } from '../functions/src/assistedApplicationAutomationEffects.js';
import { buildCandidateAutomationEmail } from '../functions/src/assistedApplicationAutomationEmails.js';
import { CANDIDATE_WAIT_EXPIRY_AFTER_MS, CANDIDATE_REQUIREMENTS_EXPIRED_REASON, HELD_WEEKLY_REMINDER_MS } from '../functions/src/assistedApplicationCandidateWaitExpiry.js';

const transition: (...args: any[]) => any = flowTransition as any;
const applyAutomationEvent: (...args: any[]) => Promise<any> = applyEvent as any;
const runAutomationSweep: (...args: any[]) => Promise<any> = sweep as any;
const sweepStaleCandidateOrders: (...args: any[]) => Promise<any> = staleSweep as any;

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 10, 27, 8, 0, 0);
const draft = { status: 'ready', round: 1, job: { source: 'job_detail', title: 'Sachbearbeiterin' }, channel: { type: 'portal' }, factCheck: { ok: true, unsupported: [] }, questions: [] as any[], requiredDocuments: [{ id: 'referenze', label: 'Referenze', required: true }] };
const v2 = { consentVersion: 'assisted-application-v2', consentedAt: T0 - 60 * DAY };
const v3 = { consentVersion: 'assisted-application-v3', consentedAt: T0 - 60 * DAY };
const concierge = { billingMode: 'application_concierge', consentVersion: 'assisted-application-v2', consentedAt: T0 - 60 * DAY };
const waitingSince = (since: number, extra: Record<string, any> = {}) => ({
  state: 'candidate_review', round: 1, shownRounds: [1], heldBy: ['document:referenze'], heldSince: since, heldNudges: 3, reminderAt: null, deadlineAt: null,
  history: [{ at: since, event: 'draft_ready', state: 'candidate_review' }], ...extra,
});

function setup(order: Record<string, any>, flow: Record<string, any>, id = 'o1') {
  const store = createMemoryFirestore({
    [`assisted_applications/${id}`]: {
      orderId: id, paymentStatus: 'paid', submissionStatus: 'in_progress', automationState: flow.state, jobTitle: 'Sachbearbeiterin',
      companyName: 'Esempio AG', locale: 'it', applicantEmail: 'candidate@example.test', ...order,
    },
    [`assisted_applications/${id}/automation/flow`]: flow,
    [`assisted_applications/${id}/ai_drafts/current`]: draft,
  });
  const sent: Array<{ key: string; to?: string }> = [];
  const issueRefund = vi.fn(async () => ({ status: 200, body: { ok: true } }));
  const runEffect = (context: any) => runAutomationEffect(context, {
    issueRefund,
    sendNotification: async ({ key, audience }: any) => { sent.push({ key, to: audience }); return { ok: true, key }; },
  });
  return { store, sent, issueRefund, runEffect };
}

describe('weekly reminder after the owner notice', () => {
  it('reminds the candidate every 7 days after the notice, and stops before the 30th day', () => {
    const answers = {};
    let step = transition(waitingSince(T0, { heldNudges: 2, reminderAt: T0 + HELD_OWNER_NOTICE_AFTER_MS }), { type: 'tick' }, { draft, answers, nowMs: T0 + HELD_OWNER_NOTICE_AFTER_MS });
    expect(step.effects).toEqual([{ type: 'email', kind: 'owner_candidate_silent', since: T0, days: 5, nudges: HELD_REMINDERS_AFTER_MS.length }]);
    let at = T0 + HELD_OWNER_NOTICE_AFTER_MS + HELD_WEEKLY_REMINDER_MS;
    expect(step.flow.reminderAt).toBe(at);
    const nudges: number[] = [];
    for (let guard = 0; step.flow.reminderAt && guard < 10; guard += 1) {
      at = step.flow.reminderAt;
      step = transition(step.flow, { type: 'tick' }, { draft, answers, nowMs: at });
      expect(step.effects).toEqual([{ type: 'email', kind: 'candidate_questions_reminder', nudge: step.flow.heldNudges, since: T0 }]);
      nudges.push(step.flow.heldNudges);
    }
    // 5 d notice, then days 12, 19, 26: the next one (33) would be past the 30 days.
    expect(nudges).toEqual([4, 5, 6]);
    expect(step.flow.reminderAt).toBeNull();
    expect(at).toBeLessThan(T0 + CANDIDATE_WAIT_EXPIRY_AFTER_MS);
  });

  it('never sends the same weekly reminder twice (the due tick moves the clock)', () => {
    const due = T0 + 12 * DAY;
    const first = transition(waitingSince(T0, { reminderAt: due }), { type: 'tick' }, { draft, nowMs: due });
    expect(first.effects).toHaveLength(1);
    expect(transition(first.flow, { type: 'tick' }, { draft, nowMs: due }).ignored).toBe('nothing_due');
  });
});

describe('closure at 30 days', () => {
  const stale = T0 - 31 * DAY;

  it('v2: withdraws, refunds through the existing refund effect and e-mails once, nothing to the employer', async () => {
    const { store, sent, issueRefund, runEffect } = setup(v2, waitingSince(stale));
    const result = await applyAutomationEvent({ db: store.db, orderId: 'o1', event: { type: 'candidate_stale_archive' }, actor: 'sweep', runEffect, nowMs: T0 });
    expect(result.ok).toBe(true);
    expect(store.read('assisted_applications/o1/automation/flow')).toMatchObject({ state: 'withdrawn', withdrawnReason: CANDIDATE_REQUIREMENTS_EXPIRED_REASON, heldBy: [], reminderAt: null });
    expect(store.read('assisted_applications/o1')).toMatchObject({ submissionStatus: 'withdrawn', withdrawalReason: CANDIDATE_REQUIREMENTS_EXPIRED_REASON, automationState: 'withdrawn' });
    expect(issueRefund).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([{ key: 'auto_candidate_requirements_expired_refunded', to: 'customer' }]);
  });

  it('v3: withdraws and e-mails with no refund', async () => {
    const { store, sent, issueRefund, runEffect } = setup(v3, waitingSince(stale));
    await applyAutomationEvent({ db: store.db, orderId: 'o1', event: { type: 'candidate_stale_archive' }, actor: 'sweep', runEffect, nowMs: T0 });
    expect(store.read('assisted_applications/o1/automation/flow')).toMatchObject({ state: 'withdrawn' });
    expect(issueRefund).not.toHaveBeenCalled();
    expect(sent).toEqual([{ key: 'auto_candidate_requirements_expired', to: 'customer' }]);
  });

  it('concierge child: withdraws and e-mails with no refund, whatever the mandate version', async () => {
    const { store, sent, issueRefund, runEffect } = setup(concierge, waitingSince(stale));
    await applyAutomationEvent({ db: store.db, orderId: 'o1', event: { type: 'candidate_stale_archive' }, actor: 'sweep', runEffect, nowMs: T0 });
    expect(store.read('assisted_applications/o1/automation/flow')).toMatchObject({ state: 'withdrawn' });
    expect(issueRefund).not.toHaveBeenCalled();
    expect(sent).toEqual([{ key: 'auto_candidate_requirements_expired', to: 'customer' }]);
  });

  it('does not close before 30 days, nor a review that only waits for its 12 h clock or a handoff', () => {
    expect(transition(waitingSince(T0 - 29 * DAY), { type: 'candidate_stale_archive' }, { order: v2, draft, nowMs: T0 }).ignored).toBe('not_stale');
    const clock = waitingSince(stale, { heldBy: [], deadlineAt: T0 + 3600_000 });
    expect(transition(clock, { type: 'candidate_stale_archive' }, { order: v2, draft, nowMs: T0 }).ignored).toBe('not_waiting_for_candidate');
    const handoff = { ...waitingSince(stale), state: 'candidate_handoff', heldBy: [] };
    expect(transition(handoff, { type: 'candidate_stale_archive' }, { order: v2, draft, nowMs: T0 }).ignored).toBe('not_waiting_for_candidate');
  });

  it('closes an order the old archive-only rule already marked, on the next sweep, once', async () => {
    const { store, sent, issueRefund, runEffect } = setup(v2, waitingSince(stale, { candidateStaleArchivedAt: T0 - DAY }), 'o1');
    await store.db.collection('assisted_applications').doc('o1').set({ candidateStaleArchivedAt: T0 - DAY }, { merge: true });
    const first = await sweepStaleCandidateOrders({ db: store.db, runEffect, nowMs: T0 });
    expect(first.flowArchived).toBe(1);
    expect(store.read('assisted_applications/o1/automation/flow')).toMatchObject({ state: 'withdrawn', candidateStaleArchivedAt: T0 });
    const second = await sweepStaleCandidateOrders({ db: store.db, runEffect, nowMs: T0 + 1000 });
    expect(second.total).toBe(0);
    const full = await runAutomationSweep({ db: store.db, runEffect, nowMs: T0 + 2000 });
    expect(full.staleArchived).toBeUndefined();
    expect(issueRefund).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(1);
  });

  it('a candidate who answers before the 30 days resumes the flow, and the sweep leaves it alone', async () => {
    const { store, runEffect } = setup(v2, waitingSince(T0 - 20 * DAY));
    const swept = await sweepStaleCandidateOrders({ db: store.db, runEffect, nowMs: T0 });
    expect(swept.flowArchived).toBe(0);
    expect(store.read('assisted_applications/o1/automation/flow')?.state).toBe('candidate_review');
    // The candidate replies (a document arrives): the flow leaves the wait instead of closing.
    await store.db.collection('assisted_applications').doc('o1').collection('automation').doc('flow').set({
      documents: { referenze: { files: [{ key: 'assisted-application-uploads/o1/ref.pdf' }] } },
    }, { merge: true });
    const answered = await applyAutomationEvent({ db: store.db, orderId: 'o1', event: { type: 'candidate_answers' }, actor: 'candidate', runEffect, nowMs: T0 });
    expect(answered.ok).toBe(true);
    expect(store.read('assisted_applications/o1/automation/flow')?.state).not.toBe('withdrawn');
    expect(store.read('assisted_applications/o1/automation/flow')?.heldBy).toEqual([]);
  });
});

describe('the e-mail to the candidate', () => {
  const vars = { locale: 'it', name: 'Anna Esempio', job: 'Sachbearbeiterin', company: 'Esempio AG', jobUrl: 'https://example.test/job', reviewUrl: 'https://example.test/r', orderId: 'o1', price: '1,99 €' };
  it('is written in each language, with the refund variant citing the amount and the other the Terms', () => {
    for (const locale of ['it', 'de', 'fr', 'en']) {
      const closed = buildCandidateAutomationEmail('candidate_requirements_expired', { ...vars, locale });
      const refunded = buildCandidateAutomationEmail('candidate_requirements_expired_refunded', { ...vars, locale });
      expect(closed.text, locale).toContain('30');
      expect(closed.text, locale).toContain('6.5');
      expect(closed.text, locale).not.toContain('https://example.test/r');
      expect(refunded.text, locale).toContain('1,99 €');
      expect(refunded.text, locale).not.toContain('https://example.test/r');
    }
  });
});
