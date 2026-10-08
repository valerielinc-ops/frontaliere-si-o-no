// Owner decisions of 2026-10-08 on the automated assisted application:
//   - the candidate's three rounds are the drafts they were shown, never one regenerated before it reached them;
//   - an ad that closed while the candidate is awaited gets no reminder: Valerie hears of it, once;
//   - Terms 6.5: an ad that closes while the application waits for the candidate's documents or answers is not
//     refunded, for the orders placed from 12 October 2026 on.
// Every order, name and posting here is invented.
import { describe, expect, it, vi } from 'vitest';
import { createMemoryFirestore } from './helpers/memoryFirestore';
import {
  CANDIDATE_REVIEW_MS,
  CANDIDATE_REMINDER_BEFORE_MS,
  HANDOFF_REMINDER_MS,
  HELD_REMINDERS_AFTER_MS,
  MAX_REVIEW_ROUNDS,
  roundsShown,
  transition,
} from '../functions/src/assistedApplicationFlow.js';
import { applyAutomationEvent, postingClosedForOrder, runAutomationSweep, startAutomation } from '../functions/src/assistedApplicationAutomation.js';
import { automationEmailKey } from '../functions/src/assistedApplicationAutomationEffects.js';
import { buildCandidateAutomationEmail, buildOwnerAutomationEmail, describeTakeover } from '../functions/src/assistedApplicationAutomationEmails.js';
import { ASSISTED_APPLICATION_WAIT_TERMS_FROM_MS, waitTermsApply } from '../functions/src/assistedApplicationConstants.js';
import { fetchWorkdayPosting } from '../functions/src/assistedApplicationAiJob.js';
import { checkPostingLiveness, postingAddressOf, postingSaysClosed } from '../functions/src/assistedApplicationLiveness.js';
import { buildCustomerEmail } from '../functions/src/assistedApplicationNotifications.js';
import { getTermsLegalDocument } from '../services/legal/terms';

const T0 = Date.UTC(2026, 9, 20, 8, 0, 0);
const HOUR = 60 * 60 * 1000;
const clean = { status: 'ready', round: 1, job: { source: 'job_detail', title: 'Infermiera' }, channel: { type: 'email', email: 'hr@example.com' }, factCheck: { ok: true, unsupported: [] }, questions: [] as any[] };
const asking = { ...clean, questions: [{ id: 'q1', required: true }] };
const newTerms = { terms: { noRefundAfterWait: true } };

describe('the candidate\'s three rounds are the drafts they were shown', () => {
  it('reads the record, and counts every round of a flow written before it', () => {
    expect(roundsShown({ round: 3, shownRounds: [3] })).toEqual([3]);
    expect(roundsShown({ round: 5, shownRounds: [4, 2, 2, 0, 'x'] })).toEqual([2, 4]);
    expect(roundsShown({ round: 1, shownRounds: [] })).toEqual([]);
    expect(roundsShown({ round: 3 })).toEqual([1, 2, 3]);
    expect(roundsShown(null)).toEqual([1]);
  });

  it('does not charge the candidate for a draft the owner had written again before it reached them', () => {
    // As startAutomation writes it: nothing shown yet.
    let flow: any = { state: 'drafting', round: 1, shownRounds: [] };
    const step = (event: any, draft: any, at: number) => { flow = transition(flow, event, { draft, nowMs: at }).flow; return flow; };
    step({ type: 'draft_ready' }, clean, T0);
    // Twice the owner asks for a new draft from her own review: the number grows, so that older links die.
    step({ type: 'owner_regenerate' }, clean, T0 + 1);
    step({ type: 'draft_ready' }, { ...clean, round: 2 }, T0 + 2);
    step({ type: 'owner_regenerate' }, { ...clean, round: 2 }, T0 + 3);
    expect(flow).toMatchObject({ state: 'regenerating', round: 3, shownRounds: [] });
    step({ type: 'draft_ready' }, { ...clean, round: 3 }, T0 + 4);
    step({ type: 'owner_approve' }, { ...clean, round: 3 }, T0 + 5);
    // «Round 3» is the first draft the candidate sees.
    expect(flow).toMatchObject({ state: 'candidate_review', round: 3, shownRounds: [3] });

    // Their first rejection asks for a new version: before, the round number sent it to the owner as the third.
    let rejected = transition(flow, { type: 'candidate_reject', feedback: 'più breve' }, { draft: { ...clean, round: 3 }, nowMs: T0 + 6 });
    expect(rejected.flow).toMatchObject({ state: 'regenerating', round: 4 });
    expect(rejected.effects).toEqual([{ type: 'dispatch', mode: 'draft', reason: 'candidate_feedback' }]);
    flow = rejected.flow;
    for (const round of [4, 5]) {
      step({ type: 'draft_ready' }, { ...clean, round }, T0 + 10 * round);
      step({ type: 'owner_approve' }, { ...clean, round }, T0 + 10 * round + 1);
      rejected = transition(flow, { type: 'candidate_reject', feedback: 'ancora' }, { draft: { ...clean, round }, nowMs: T0 + 10 * round + 2 });
      if (round === 4) flow = rejected.flow;
    }
    // The third draft they were shown is the last: the owner takes over.
    expect(flow.shownRounds).toEqual([3, 4, 5]);
    expect(flow.shownRounds).toHaveLength(MAX_REVIEW_ROUNDS);
    expect(rejected.flow).toMatchObject({ state: 'owner_takeover', heldBy: ['max_rounds'] });
    expect(rejected.effects).toEqual([{ type: 'email', kind: 'owner_takeover', reason: 'max_rounds' }]);
  });

  it('shows a round once: answering its questions, or coming back to it, never counts it twice', () => {
    let flow = transition({ state: 'owner_review', round: 1, shownRounds: [] }, { type: 'owner_approve' }, { draft: asking, nowMs: T0 }).flow;
    expect(flow).toMatchObject({ state: 'candidate_review', shownRounds: [1], heldBy: ['question:q1'] });
    flow = transition(flow, { type: 'candidate_answers' }, { draft: asking, answers: { q1: 'sì' }, nowMs: T0 + 1 }).flow;
    expect(flow).toMatchObject({ state: 'candidate_review', shownRounds: [1], heldBy: [] });
  });

  it('keeps the count of a flow written before the record: its third round is still the last', () => {
    const legacy = { state: 'candidate_review', round: 3, deadlineAt: T0 + CANDIDATE_REVIEW_MS };
    expect(transition(legacy, { type: 'candidate_reject', feedback: 'no' }, { draft: { ...clean, round: 3 }, nowMs: T0 }).flow).toMatchObject({ state: 'owner_takeover', heldBy: ['max_rounds'] });
    const second = { state: 'candidate_review', round: 2, deadlineAt: T0 + CANDIDATE_REVIEW_MS };
    expect(transition(second, { type: 'candidate_reject', feedback: 'no' }, { draft: { ...clean, round: 2 }, nowMs: T0 }).flow).toMatchObject({ state: 'regenerating', round: 3, shownRounds: [1, 2] });
  });

  it('starts a flow with no round shown', async () => {
    const store = createMemoryFirestore({
      'assisted_applications/o1': { paymentStatus: 'paid', submissionStatus: 'ready_for_manual_submission', cvStorageKey: 'assisted-application-uploads/o1/1-cv.pdf', cvFileCheck: { key: 'assisted-application-uploads/o1/1-cv.pdf', verdict: 'ok', detectedType: 'pdf' } },
    });
    expect(await startAutomation({ db: store.db, orderId: 'o1', runEffect: async () => ({ ok: true }), nowMs: T0 })).toMatchObject({ started: true });
    expect(store.read('assisted_applications/o1/automation/flow')).toMatchObject({ state: 'drafting', round: 1, shownRounds: [] });
  });
});

describe('an ad that closed while the candidate is awaited', () => {
  const waiting = { state: 'candidate_review', round: 1, shownRounds: [1], heldBy: ['question:q1'], heldSince: T0, heldNudges: 0, reminderAt: T0 + HELD_REMINDERS_AFTER_MS[0], deadlineAt: null };
  const due = T0 + HELD_REMINDERS_AFTER_MS[0];

  it('gets no reminder: the order keeps waiting, silent, and the owner hears of it once', () => {
    const step = transition(waiting, { type: 'tick', postingExpired: true }, { draft: asking, nowMs: due });
    expect(step.effects).toEqual([{ type: 'email', kind: 'owner_posting_expired', since: T0 }]);
    // Still the candidate's to answer, with no clock and no further reminder; nothing refunded.
    expect(step.flow).toMatchObject({ state: 'candidate_review', heldBy: ['question:q1'], heldSince: T0, reminderAt: null, deadlineAt: null, postingExpiredAt: due });
    expect(step.effects.some((effect: any) => effect.type === 'refund')).toBe(false);
    // Nothing is due any more.
    expect(transition(step.flow, { type: 'tick', postingExpired: true }, { draft: asking, nowMs: due + 100 * HOUR }).ignored).toBe('nothing_due');
  });

  it('is reminded as before while the ad is open, or when nobody looked', () => {
    expect(transition(waiting, { type: 'tick' }, { draft: asking, nowMs: due }).effects).toEqual([{ type: 'email', kind: 'candidate_questions_reminder', nudge: 1, since: T0 }]);
    expect(transition(waiting, { type: 'tick', postingExpired: false }, { draft: asking, nowMs: due }).effects).toEqual([{ type: 'email', kind: 'candidate_questions_reminder', nudge: 1, since: T0 }]);
    // Before any reminder is due the closed ad changes nothing here: the look happens when one is.
    expect(transition(waiting, { type: 'tick', postingExpired: true }, { draft: asking, nowMs: due - 1 }).ignored).toBe('nothing_due');
  });

  it('stops the reminder of the 12 hours and of a portal step handed to the candidate too, and tells the owner once', () => {
    const clock = { state: 'candidate_review', round: 1, shownRounds: [1], heldBy: [], deadlineAt: T0 + CANDIDATE_REVIEW_MS, reminderAt: T0 + CANDIDATE_REVIEW_MS - CANDIDATE_REMINDER_BEFORE_MS };
    const skipped = transition(clock, { type: 'tick', postingExpired: true }, { draft: clean, nowMs: clock.reminderAt });
    expect(skipped.effects).toEqual([{ type: 'email', kind: 'owner_posting_expired', since: clock.reminderAt }]);
    expect(skipped.flow).toMatchObject({ state: 'candidate_review', reminderAt: null, deadlineAt: clock.deadlineAt, postingExpiredAt: clock.reminderAt });
    // The 12 hours still end as they did: the runner looks at the ad itself before it sends.
    expect(transition(skipped.flow, { type: 'tick' }, { draft: clean, nowMs: clock.deadlineAt }).effects).toEqual([{ type: 'dispatch', mode: 'submit', reason: 'auto_approved_12h' }]);

    const handoff = { state: 'candidate_handoff', round: 1, heldBy: ['owner_handoff'], reminderAt: T0 + HANDOFF_REMINDER_MS, postingExpiredAt: T0 };
    const quiet = transition(handoff, { type: 'tick', postingExpired: true }, { draft: clean, nowMs: T0 + HANDOFF_REMINDER_MS });
    // Already told of this ad: no second notice.
    expect(quiet.effects).toEqual([]);
    expect(quiet.flow).toMatchObject({ state: 'candidate_handoff', reminderAt: null });
  });

  it('is looked at by the sweep only when a reminder to the candidate is due', async () => {
    const seed = (flow: any) => createMemoryFirestore({
      'assisted_applications/o1': { jobId: 'acme-1', jobUrl: 'https://example.com/jobs/1', automationDueAt: flow.reminderAt || flow.deadlineAt },
      'assisted_applications/o1/automation/flow': flow,
      'assisted_applications/o1/ai_drafts/current': asking,
    });
    const run = async (store: any, postingClosed: any, nowMs: number) => {
      const effects: any[] = [];
      const summary = await runAutomationSweep({ db: store.db, nowMs, postingClosed, runEffect: async (context: any) => { effects.push(context.effect); return { ok: true }; } });
      return { effects, summary, flow: store.read('assisted_applications/o1/automation/flow'), order: store.read('assisted_applications/o1') };
    };

    const closed = vi.fn(async () => true);
    const stopped = await run(seed(waiting), closed, due);
    expect(closed).toHaveBeenCalledTimes(1);
    expect(closed.mock.calls[0][0]).toMatchObject({ orderId: 'o1', order: { jobId: 'acme-1' } });
    expect(stopped.effects).toEqual([{ type: 'email', kind: 'owner_posting_expired', since: T0 }]);
    expect(stopped.flow).toMatchObject({ state: 'candidate_review', reminderAt: null, postingExpiredAt: due });
    // The sweep stops selecting the order: nothing is due.
    expect(stopped.order.automationDueAt).toBeNull();

    const open = vi.fn(async () => false);
    expect((await run(seed(waiting), open, due)).effects).toEqual([{ type: 'email', kind: 'candidate_questions_reminder', nudge: 1, since: T0 }]);
    // A look that fails says nothing: the reminder goes out.
    const failing = vi.fn(async () => { throw new Error('network'); });
    expect((await run(seed(waiting), failing, due)).effects).toEqual([{ type: 'email', kind: 'candidate_questions_reminder', nudge: 1, since: T0 }]);
    // No look given (as every caller before): reminded as before.
    expect((await run(seed(waiting), null, due)).effects).toEqual([{ type: 'email', kind: 'candidate_questions_reminder', nudge: 1, since: T0 }]);
    // A look that outlasts its time says nothing either: the sweep serves every due order within its run.
    const slowStore = seed(waiting);
    const slowEffects: any[] = [];
    const slow = vi.fn(() => new Promise((resolve) => { setTimeout(() => resolve(true), 400); }));
    await runAutomationSweep({ db: slowStore.db, nowMs: due, postingClosed: slow, postingLookMs: 20, runEffect: async (context: any) => { slowEffects.push(context.effect); return { ok: true }; } });
    expect(slow).toHaveBeenCalledTimes(1);
    expect(slowEffects).toEqual([{ type: 'email', kind: 'candidate_questions_reminder', nudge: 1, since: T0 }]);

    // The owner's own clock is no reminder to a candidate: the ad is not looked at.
    const never = vi.fn(async () => true);
    const ownerClock = await run(seed({ state: 'owner_review', round: 1, shownRounds: [], heldBy: [], deadlineAt: T0 + HOUR, reminderAt: null }), never, T0 + HOUR);
    expect(never).not.toHaveBeenCalled();
    expect(ownerClock.flow.state).toBe('candidate_review');
  });
});

describe('the ad\'s own word that it is closed', () => {
  const resolve = async () => [{ address: '93.184.216.34', family: 4 }];
  const posting = 'https://acme.wd3.myworkdayjobs.com/en-US/Careers/job/Lugano/Store-Assistant_JR01234-1';
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const denied = () => json({ errorCode: 'S22', httpStatus: 403, message: 'permission denied' }, 403);
  /** Workday as one tenant answers: the posting's JSON, then its search (POST …/jobs). */
  const workday = (postingAnswer: () => Response, search: (text: string) => Response) => vi.fn(async (url: string, init: any = {}) => {
    if (init.method === 'HEAD') return new Response(null, { status: 200 });
    if (String(url).endsWith('/wday/cxs/acme/Careers/jobs')) return search(JSON.parse(init.body).searchText);
    if (String(url).includes('/wday/cxs/acme/Careers/job/')) return postingAnswer();
    return new Response('<html><body></body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
  });

  it('reads a Workday posting as withdrawn when its JSON is refused and the tenant\'s search lists it no more', async () => {
    const unlisted = workday(denied, () => json({ total: 0, jobPostings: [] }));
    await expect(fetchWorkdayPosting(unlisted, posting, resolve)).resolves.toEqual({ gone: true, info: null });
    // Asked for the address's own token and for the requisition behind a second publication («…-1»).
    expect(unlisted.mock.calls.filter(([url]) => String(url).endsWith('/jobs')).map(([, init]: any) => JSON.parse(init.body).searchText)).toEqual(['jr01234-1', 'jr01234']);

    // Still listed, under this or another address: not withdrawn, and nothing more is known.
    const listed = workday(denied, (text) => json({ total: 1, jobPostings: text === 'jr01234' ? [{ title: 'Store Assistant', externalPath: '/job/Lugano/Store-Assistant_JR01234-2', bulletFields: ['JR01234'] }] : [] }));
    await expect(fetchWorkdayPosting(listed, posting, resolve)).resolves.toBeNull();
    // A search that does not answer this client proves nothing: a tenant may refuse it everything.
    await expect(fetchWorkdayPosting(workday(denied, denied), posting, resolve)).resolves.toBeNull();
    await expect(fetchWorkdayPosting(workday(denied, () => json({ total: 0 })), posting, resolve)).resolves.toBeNull();
    // An address with no requisition to search for.
    await expect(fetchWorkdayPosting(workday(denied, () => json({ total: 0, jobPostings: [] })), 'https://acme.wd3.myworkdayjobs.com/Careers/job/Lugano/Store-Assistant', resolve)).resolves.toBeNull();
  });

  it('stops a reminder on the ad\'s own word, and refunds by itself only when our dataset agrees', async () => {
    const unlisted = workday(denied, () => json({ total: 0, jobPostings: [] }));
    const live = await checkPostingLiveness({ order: { jobId: 'acme-1', jobUrl: posting }, posting: { applyUrl: posting }, fetchImpl: unlisted, resolve });
    expect(live).toMatchObject({ page: { result: 'expired', code: 'ats_api_gone' }, datasetGone: false, closed: false });
    expect(postingSaysClosed(live)).toBe(true);

    const said = (result: string, code: string, closed = false) => postingSaysClosed({ page: { result, code }, closed });
    expect([said('expired', 'http_gone'), said('expired', 'expired_body'), said('expired', 'expired_url'), said('expired', 'ats_api_closed')]).toEqual([true, true, true, true]);
    // A page that looks empty, blocks the fetch or merely redirects says nothing of the ad.
    expect([said('expired', 'insufficient_content'), said('expired', 'listing_page'), said('uncertain', 'access_blocked'), said('active', 'apply_control_visible')]).toEqual([false, false, false, false]);
    // …unless the refund's own gate already closed it (our dataset agrees).
    expect(said('expired', 'listing_page', true)).toBe(true);
    expect(postingSaysClosed(null)).toBe(false);
  });

  it('is read for an order at the address the runner reads before it submits', async () => {
    expect(postingAddressOf({ channel: { postingUrl: 'https://a.example/p', applyUrl: 'https://ats.example/apply' }, job: { applyUrl: 'https://b.example' } })).toBe('https://a.example/p');
    expect(postingAddressOf({ channel: { applyUrl: 'https://ats.example/apply' } })).toBe('https://ats.example/apply');
    expect(postingAddressOf({ job: { applyUrl: 'https://b.example' } })).toBe('https://b.example');
    expect(postingAddressOf(null)).toBe('');

    const store = createMemoryFirestore({ 'assisted_applications/o1/ai_drafts/current': { channel: { type: 'workday', applyUrl: posting } } });
    const order = { jobId: 'acme-1', jobUrl: posting };
    expect(await postingClosedForOrder({ db: store.db, orderId: 'o1', order, fetchImpl: workday(denied, () => json({ total: 0, jobPostings: [] })), resolve })).toBe(true);
    const open = workday(() => json({ jobPostingInfo: { canApply: true, posted: true, jobDescription: 'x' } }), () => json({ total: 0, jobPostings: [] }));
    expect(await postingClosedForOrder({ db: store.db, orderId: 'o1', order, fetchImpl: open, resolve })).toBe(false);
  });
});

describe('Terms 6.5: an ad that closes while the application waits for the candidate', () => {
  const zurich = (locale: string) => new Intl.DateTimeFormat(locale, { timeZone: 'Europe/Zurich', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(ASSISTED_APPLICATION_WAIT_TERMS_FROM_MS));

  it('binds the orders placed from the day the Terms name, in the four languages', () => {
    // The first instant of that day in Zurich, and the last of the day before.
    expect(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Zurich', dateStyle: 'short', timeStyle: 'short' }).format(new Date(ASSISTED_APPLICATION_WAIT_TERMS_FROM_MS))).toBe('12/10/2026, 00:00');
    const days = { it: zurich('it-CH'), en: zurich('en-GB'), de: zurich('de-CH'), fr: zurich('fr-CH') };
    expect(days).toEqual({ it: '12 ottobre 2026', en: '12 October 2026', de: '12. Oktober 2026', fr: '12 octobre 2026' });
    for (const [locale, day] of Object.entries(days)) {
      const section = getTermsLegalDocument(locale as any).sections.find((item) => item.id === 'candidatura-assistita');
      const refund = (section?.blocks || []).map((block: any) => String(block.html || '')).find((html) => html.includes('6.5'));
      expect(refund, locale).toContain(day);
    }
    const it = getTermsLegalDocument('it').sections.find((item) => item.id === 'candidatura-assistita')!.blocks.map((block: any) => block.html).join(' ');
    expect(it).toContain('in attesa di documenti o risposte che ti abbiamo chiesto e che solo tu puoi fornire');
    expect(it).toContain('l&apos;importo non è rimborsato');

    const at = ASSISTED_APPLICATION_WAIT_TERMS_FROM_MS;
    expect(waitTermsApply({ paidAt: at })).toBe(true);
    expect(waitTermsApply({ paidAt: at - 1 })).toBe(false);
    // The payment's moment, else the order's; a Firestore timestamp, a date, a number.
    expect(waitTermsApply({ createdAt: { toMillis: () => at + HOUR } })).toBe(true);
    expect(waitTermsApply({ paidAt: new Date(at - HOUR), createdAt: at + HOUR })).toBe(false);
    expect(waitTermsApply({ createdAt: new Date(at).toISOString() })).toBe(true);
    // No date known: the promise the order was sold with.
    expect([waitTermsApply({}), waitTermsApply(null), waitTermsApply({ paidAt: 'x' })]).toEqual([false, false, false]);
  });

  it('refunds nothing by itself when the round waited for the candidate, under those Terms only', () => {
    const waiting = { state: 'candidate_review', round: 1, shownRounds: [1], heldBy: ['question:q1'], heldSince: T0, reminderAt: T0 + HELD_REMINDERS_AFTER_MS[0] };
    // The candidate answers ten days later: the wait ends and leaves its mark.
    const answered = transition(waiting, { type: 'candidate_answers' }, { draft: asking, answers: { q1: 'sì' }, nowMs: T0 + 240 * HOUR }).flow;
    expect(answered).toMatchObject({ state: 'candidate_review', heldBy: [], heldSince: null, lastWait: { round: 1, since: T0, until: T0 + 240 * HOUR } });
    const submitting = transition(answered, { type: 'candidate_approve' }, { draft: asking, answers: { q1: 'sì' }, nowMs: T0 + 241 * HOUR }).flow;
    expect(submitting).toMatchObject({ state: 'submitting', lastWait: { round: 1 } });

    // The runner finds the ad closed. Orders placed under the new point 6.5: Valerie decides, nothing is refunded.
    const kept = transition(submitting, { type: 'posting_closed' }, { draft: asking, nowMs: T0 + 242 * HOUR, ...newTerms });
    expect(kept.flow).toMatchObject({ state: 'owner_takeover', heldBy: ['posting_closed'] });
    expect(kept.effects).toEqual([{ type: 'email', kind: 'owner_takeover', reason: 'posting_closed_waited' }]);
    // An earlier order keeps the promise it was sold with.
    const promised = transition(submitting, { type: 'posting_closed' }, { draft: asking, nowMs: T0 + 242 * HOUR });
    expect(promised.effects).toEqual([{ type: 'refund', reason: 'posting_closed', notify: 'candidate_posting_closed' }, { type: 'email', kind: 'owner_takeover', reason: 'posting_closed' }]);
  });

  it('still refunds by itself an ad that closed with nobody waiting for the candidate', () => {
    const refund = [{ type: 'refund', reason: 'posting_closed', notify: 'candidate_posting_closed' }, { type: 'email', kind: 'owner_takeover', reason: 'posting_closed' }];
    // Closed before the first draft, or after an approval that never waited for an answer.
    expect(transition({ state: 'drafting', round: 1, shownRounds: [] }, { type: 'posting_closed' }, { draft: null, nowMs: T0, ...newTerms }).effects).toEqual(refund);
    expect(transition({ state: 'submitting', round: 1, shownRounds: [1] }, { type: 'posting_closed' }, { draft: clean, nowMs: T0, ...newTerms }).effects).toEqual(refund);
    // The candidate was awaited in an earlier round, not in this one: its draft was being written by us.
    const later = { state: 'regenerating', round: 2, shownRounds: [1], lastWait: { round: 1, since: T0, until: T0 + HOUR } };
    expect(transition(later, { type: 'posting_closed' }, { draft: clean, nowMs: T0 + 2 * HOUR, ...newTerms }).effects).toEqual(refund);
  });

  it('passes the order\'s own Terms to the flow, by the day it was placed', async () => {
    const flow = { state: 'submitting', round: 1, shownRounds: [1], heldBy: [], lastWait: { round: 1, since: T0, until: T0 + HOUR }, dispatch: { mode: 'submit', round: 1 } };
    const close = async (order: any) => {
      const store = createMemoryFirestore({ 'assisted_applications/o1': order, 'assisted_applications/o1/automation/flow': flow, 'assisted_applications/o1/ai_drafts/current': clean });
      const effects: any[] = [];
      await applyAutomationEvent({ db: store.db, orderId: 'o1', event: { type: 'posting_closed' }, actor: 'runner', nowMs: T0 + 2 * HOUR, runEffect: async (context: any) => { effects.push(context.effect); return { ok: true }; } });
      return effects.map((effect) => effect.type === 'refund' ? 'refund' : effect.reason);
    };
    expect(await close({ paidAt: ASSISTED_APPLICATION_WAIT_TERMS_FROM_MS + HOUR })).toEqual(['posting_closed_waited']);
    expect(await close({ paidAt: ASSISTED_APPLICATION_WAIT_TERMS_FROM_MS - HOUR })).toEqual(['refund', 'posting_closed']);
  });

  it('tells the owner what was found and what the order\'s Terms say, and the candidate what the wait may cost', () => {
    const vars = { job: 'Infermiera', company: 'Ospedale Esempio', orderId: 'o1', candidateEmail: 'maria.rossi@example.com' };
    const underNew = buildOwnerAutomationEmail('owner_posting_expired', { ...vars, waitTerms: true });
    expect(underNew.subject).toBe('[Candidatura] Annuncio chiuso durante l’attesa del candidato: Infermiera — Ospedale Esempio');
    expect(underNew.text).toContain('Il sollecito NON è partito');
    expect(underNew.text).toContain('non è stato rimborsato nulla');
    expect(underNew.text).toContain('un annuncio ritirato mentre aspettiamo documenti o risposte del candidato non è rimborsato');
    expect(underNew.html).toContain('mailto:maria.rossi@example.com');
    const underOld = buildOwnerAutomationEmail('owner_posting_expired', { ...vars, waitTerms: false });
    expect(underOld.text).toContain('vale la promessa con cui è stato venduto');
    expect(underOld.text).not.toContain('non è rimborsato.');
    expect(describeTakeover({ reason: 'posting_closed_waited' }).reason).toContain('NESSUN rimborso automatico');
    expect(automationEmailKey({ kind: 'owner_posting_expired', since: 1000 }, { round: 2 })).toBe('auto_owner_posting_expired_1000');

    const base = { name: 'Maria Rossi', job: 'Infermiera', company: 'Ospedale Esempio', jobUrl: 'https://example.com/jobs/1', reviewUrl: 'https://example.com/review', orderId: 'o1', openQuestions: 2 };
    const sentence = { it: 'l’importo non è rimborsato (Termini, punto 6.5)', de: 'wird nicht erstattet (Nutzungsbedingungen, Ziffer 6.5)', fr: 'n’est pas remboursé (Conditions, point 6.5)', en: 'is not refunded (Terms, section 6.5)' };
    for (const [locale, words] of Object.entries(sentence)) {
      // Said while they are awaited: the review held by questions or documents, its reminders, the portal's question.
      expect(buildCandidateAutomationEmail('candidate_review', { ...base, locale, held: true, waitTerms: true }).text, locale).toContain(words);
      expect(buildCandidateAutomationEmail('candidate_questions_reminder', { ...base, locale, waitTerms: true }).html, locale).toContain(words);
      expect(buildCandidateAutomationEmail('candidate_action_needed', { ...base, locale, waitTerms: true }).text, locale).toContain(words);
      // Not to an order placed before, nor when nothing is asked of them.
      expect(buildCandidateAutomationEmail('candidate_review', { ...base, locale, held: true, waitTerms: false }).text, locale).not.toContain(words);
      expect(buildCandidateAutomationEmail('candidate_review', { ...base, locale, held: false, deadlineAt: T0, waitTerms: true }).text, locale).not.toContain(words);
      expect(buildCandidateAutomationEmail('candidate_reminder', { ...base, locale, deadlineAt: T0, waitTerms: true }).text, locale).not.toContain(words);
    }
  });

  it('writes the exception next to the promise of a refund in the welcome e-mail of an order placed under it', () => {
    const order = (placedAt: number, locale = 'it') => ({ jobTitle: 'Infermiera', companyName: 'Ospedale Esempio', applicantName: 'Maria Rossi', applicantEmail: 'maria.rossi@example.com', locale, amountTotal: 99, currency: 'eur', paidAt: placedAt });
    const after = ASSISTED_APPLICATION_WAIT_TERMS_FROM_MS + HOUR;
    const before = ASSISTED_APPLICATION_WAIT_TERMS_FROM_MS - HOUR;
    const exception = { it: 'in quel caso l\'importo non è rimborsato (Termini, punto 6.5)', fr: 'le montant n\'est pas remboursé (Conditions, point 6.5)', de: 'wird der Betrag nicht erstattet (Nutzungsbedingungen, Ziffer 6.5)', en: 'the amount is not refunded (Terms, section 6.5)' };
    for (const [locale, words] of Object.entries(exception)) {
      for (const automation of [true, false]) {
        expect(buildCustomerEmail('intro', order(after, locale), 'o1', { nowMs: after, automation }).text, `${locale} ${automation}`).toContain(words);
        expect(buildCustomerEmail('intro', order(before, locale), 'o1', { nowMs: before, automation }).text, `${locale} ${automation}`).not.toContain(words);
      }
    }
  });
});
