// Owner decisions of 2026-10-08 on the automated assisted application:
//   - the candidate's three rounds are the drafts they were shown, never one regenerated before it reached them;
//   - an ad that closed while the candidate is awaited gets no reminder: Valerie hears of it, once;
//   - Terms 6.5: an ad that closes while the application waits for the candidate's documents or answers is not
//     refunded. For every order: the Terms name no day from which it holds (the owner's second word that day).
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
import { POSTING_LOOKS_AT_ONCE, applyAutomationEvent, postingClosedForOrder, runAutomationSweep, startAutomation } from '../functions/src/assistedApplicationAutomation.js';
import { automationEmailKey } from '../functions/src/assistedApplicationAutomationEffects.js';
import { buildCandidateAutomationEmail, buildOwnerAutomationEmail, describeTakeover } from '../functions/src/assistedApplicationAutomationEmails.js';
import { fetchWorkdayPosting } from '../functions/src/assistedApplicationAiJob.js';
import { checkPostingLiveness, postingAddressOf, postingSaysClosed } from '../functions/src/assistedApplicationLiveness.js';
import { buildCustomerEmail } from '../functions/src/assistedApplicationNotifications.js';
import { getTermsLegalDocument } from '../services/legal/terms';

const T0 = Date.UTC(2026, 9, 20, 8, 0, 0);
const HOUR = 60 * 60 * 1000;
const clean = { status: 'ready', round: 1, job: { source: 'job_detail', title: 'Infermiera' }, channel: { type: 'email', email: 'hr@example.com' }, factCheck: { ok: true, unsupported: [] }, questions: [] as any[] };
const asking = { ...clean, questions: [{ id: 'q1', required: true }] };

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

  it('stops the 12 hours with their reminder, and the reminder of a portal step handed to the candidate, and tells the owner once', () => {
    const clock = { state: 'candidate_review', round: 1, shownRounds: [1], heldBy: [], deadlineAt: T0 + CANDIDATE_REVIEW_MS, reminderAt: T0 + CANDIDATE_REVIEW_MS - CANDIDATE_REMINDER_BEFORE_MS };
    const skipped = transition(clock, { type: 'tick', postingExpired: true }, { draft: clean, nowMs: clock.reminderAt });
    expect(skipped.effects).toEqual([{ type: 'email', kind: 'owner_posting_expired', since: clock.reminderAt }]);
    // Review of #12366: the clock stops too. The notice says the order waits: nothing is sent by itself to an
    // ad known closed, at the deadline or after it.
    expect(skipped.flow).toMatchObject({ state: 'candidate_review', reminderAt: null, deadlineAt: null, postingExpiredAt: clock.reminderAt });
    for (const later of [clock.deadlineAt, clock.deadlineAt + 100 * HOUR]) {
      const tick = transition(skipped.flow, { type: 'tick' }, { draft: clean, nowMs: later });
      expect(tick.ignored).toBe('nothing_due');
      expect(tick.effects).toEqual([]);
      expect(tick.flow.state).toBe('candidate_review');
    }
    // The reminder and the deadline due in the same tick: still no send.
    const both = transition(clock, { type: 'tick', postingExpired: true }, { draft: clean, nowMs: clock.deadlineAt });
    expect(both.flow).toMatchObject({ state: 'candidate_review', reminderAt: null, deadlineAt: null });
    expect(both.effects).toEqual([{ type: 'email', kind: 'owner_posting_expired', since: clock.deadlineAt }]);
    // The candidate's own approval still sends it: the runner looks at the ad itself before it submits.
    expect(transition(skipped.flow, { type: 'candidate_approve' }, { draft: clean, nowMs: clock.deadlineAt }).effects).toEqual([{ type: 'dispatch', mode: 'submit', reason: 'candidate_approved' }]);

    // Review of #12366: a portal waiting for the candidate is their side too, whatever holds it.
    const portal = { state: 'needs_candidate_action', round: 1, shownRounds: [1], heldBy: ['portal:captcha'], reminderAt: T0 + HOUR, deadlineAt: null };
    const held = transition(portal, { type: 'tick', postingExpired: true }, { draft: clean, nowMs: T0 + HOUR });
    expect(held.effects).toEqual([{ type: 'email', kind: 'owner_posting_expired', since: T0 + HOUR }]);
    expect(held.flow).toMatchObject({ state: 'needs_candidate_action', reminderAt: null, postingExpiredAt: T0 + HOUR });
    expect(held.effects.some((effect: any) => String(effect.kind).startsWith('candidate_'))).toBe(false);

    const handoff = { state: 'candidate_handoff', round: 1, heldBy: ['owner_handoff'], reminderAt: T0 + HANDOFF_REMINDER_MS, postingExpiredAt: T0 };
    const quiet = transition(handoff, { type: 'tick', postingExpired: true }, { draft: clean, nowMs: T0 + HANDOFF_REMINDER_MS });
    // Already told of this ad: no second notice.
    expect(quiet.effects).toEqual([]);
    expect(quiet.flow).toMatchObject({ state: 'candidate_handoff', reminderAt: null });
  });

  it('is looked at by the sweep only when a reminder to the candidate is due', async () => {
    const seed = (flow: any) => createMemoryFirestore({
      'assisted_applications/o1': { jobId: 'acme-1', jobUrl: 'https://example.com/jobs/1', automationState: flow.state, automationDueAt: flow.reminderAt || flow.deadlineAt },
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

    // Review of #12366: a whole batch of reminders due together is looked at several at once, so that the sweep
    // ends within its run. Fifty looks of 60 ms each: one at a time 3 s, ten at a time 0.3 s.
    const many = Object.fromEntries(Array.from({ length: 50 }, (_, index) => [`o${index}`, index]).flatMap(([id]) => [
      [`assisted_applications/${id}`, { jobId: `acme-${id}`, automationState: 'candidate_review', automationDueAt: due }],
      [`assisted_applications/${id}/automation/flow`, waiting],
      [`assisted_applications/${id}/ai_drafts/current`, asking],
    ]));
    const crowd = createMemoryFirestore(many);
    let running = 0;
    let most = 0;
    const look = vi.fn(async () => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((resolve) => { setTimeout(resolve, 60); });
      running -= 1;
      return true;
    });
    const started = Date.now();
    const kinds: string[] = [];
    const summary = await runAutomationSweep({ db: crowd.db, nowMs: due, postingClosed: look, postingLookMs: 500, runEffect: async (context: any) => { kinds.push(context.effect.kind); return { ok: true }; } });
    expect(summary).toMatchObject({ ticks: 50, failed: 0 });
    expect(look).toHaveBeenCalledTimes(50);
    expect(most).toBe(POSTING_LOOKS_AT_ONCE);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(kinds).toEqual(Array.from({ length: 50 }, () => 'owner_posting_expired'));

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
  const refundBlock = (locale: string) => {
    const section = getTermsLegalDocument(locale as any).sections.find((item) => item.id === 'candidatura-assistita');
    return (section?.blocks || []).map((block: any) => String(block.html || '')).find((html) => html.includes('6.5')) || '';
  };

  it('says the exception in the four languages, and names no day from which it holds', () => {
    const words = {
      it: 'in attesa di documenti o risposte che ti abbiamo chiesto e che solo tu puoi fornire',
      en: 'waiting for documents or answers that we have asked you for and that only you can provide',
      de: 'auf Unterlagen oder Antworten wartet, die wir bei Ihnen angefordert haben und die nur Sie liefern können',
      fr: 'attend des documents ou des réponses que nous vous avons demandés et que vous seul pouvez fournir',
    };
    const notRefunded = { it: 'l&apos;importo non è rimborsato', en: 'the amount is not refunded', de: 'der Betrag wird nicht erstattet', fr: 'le montant n’est pas remboursé' };
    for (const [locale, sentence] of Object.entries(words)) {
      const block = refundBlock(locale);
      expect(block, locale).toContain(sentence);
      expect(block, locale).toContain((notRefunded as any)[locale]);
      // Owner, 2026-10-08: «aggiorniamo senza riferimento alla data». No year, no month: the rule holds for every order.
      expect(block, locale).not.toMatch(/20\d\d|ottobre|October|Oktober|octobre/);
    }
    // The refund the service still promises stands next to it.
    expect(refundBlock('it')).toContain('ti rimborsiamo automaticamente l&apos;intero importo');
  });

  it('refunds nothing by itself when the round waited for the candidate, whenever the order was placed', () => {
    const waiting = { state: 'candidate_review', round: 1, shownRounds: [1], heldBy: ['question:q1'], heldSince: T0, reminderAt: T0 + HELD_REMINDERS_AFTER_MS[0] };
    // The candidate answers ten days later: the wait ends and leaves its mark.
    const answered = transition(waiting, { type: 'candidate_answers' }, { draft: asking, answers: { q1: 'sì' }, nowMs: T0 + 240 * HOUR }).flow;
    expect(answered).toMatchObject({ state: 'candidate_review', heldBy: [], heldSince: null, lastWait: { round: 1, since: T0, until: T0 + 240 * HOUR } });
    const submitting = transition(answered, { type: 'candidate_approve' }, { draft: asking, answers: { q1: 'sì' }, nowMs: T0 + 241 * HOUR }).flow;
    expect(submitting).toMatchObject({ state: 'submitting', lastWait: { round: 1 } });

    // The runner finds the ad closed: Valerie decides, nothing is refunded by the robot.
    const kept = transition(submitting, { type: 'posting_closed' }, { draft: asking, nowMs: T0 + 242 * HOUR });
    expect(kept.flow).toMatchObject({ state: 'owner_takeover', heldBy: ['posting_closed'] });
    expect(kept.effects).toEqual([{ type: 'email', kind: 'owner_takeover', reason: 'posting_closed_waited' }]);
    // The same while the candidate is still awaited.
    expect(transition(waiting, { type: 'posting_closed' }, { draft: asking, nowMs: T0 + HOUR }).effects).toEqual([{ type: 'email', kind: 'owner_takeover', reason: 'posting_closed_waited' }]);
  });

  it('still refunds by itself an ad that closed with nobody waiting for the candidate', () => {
    const refund = [{ type: 'refund', reason: 'posting_closed', notify: 'candidate_posting_closed' }, { type: 'email', kind: 'owner_takeover', reason: 'posting_closed' }];
    // Closed before the first draft, or after an approval that never waited for an answer.
    expect(transition({ state: 'drafting', round: 1, shownRounds: [] }, { type: 'posting_closed' }, { draft: null, nowMs: T0 }).effects).toEqual(refund);
    expect(transition({ state: 'submitting', round: 1, shownRounds: [1] }, { type: 'posting_closed' }, { draft: clean, nowMs: T0 }).effects).toEqual(refund);
    expect(transition({ state: 'candidate_review', round: 1, shownRounds: [1], heldBy: [], deadlineAt: T0 + CANDIDATE_REVIEW_MS }, { type: 'posting_closed' }, { draft: clean, nowMs: T0 }).effects).toEqual(refund);
    // The candidate was awaited in an earlier round, not in this one: its draft was being written by us.
    const later = { state: 'regenerating', round: 2, shownRounds: [1], lastWait: { round: 1, since: T0, until: T0 + HOUR } };
    expect(transition(later, { type: 'posting_closed' }, { draft: clean, nowMs: T0 + 2 * HOUR }).effects).toEqual(refund);
  });

  it('treats every order alike, whenever it was paid: no day divides them', async () => {
    const waited = { state: 'submitting', round: 1, shownRounds: [1], heldBy: [], lastWait: { round: 1, since: T0, until: T0 + HOUR }, dispatch: { mode: 'submit', round: 1 } };
    const close = async (order: any, flow: any) => {
      const store = createMemoryFirestore({ 'assisted_applications/o1': order, 'assisted_applications/o1/automation/flow': flow, 'assisted_applications/o1/ai_drafts/current': clean });
      const effects: any[] = [];
      await applyAutomationEvent({ db: store.db, orderId: 'o1', event: { type: 'posting_closed' }, actor: 'runner', nowMs: T0 + 2 * HOUR, runEffect: async (context: any) => { effects.push(context.effect); return { ok: true }; } });
      return effects.map((effect) => effect.type === 'refund' ? 'refund' : effect.reason);
    };
    // An order of last month and one of next year: the same.
    for (const paidAt of [Date.UTC(2026, 8, 1), Date.UTC(2027, 0, 1)]) {
      expect(await close({ paidAt }, waited)).toEqual(['posting_closed_waited']);
      expect(await close({ paidAt }, { ...waited, lastWait: null })).toEqual(['refund', 'posting_closed']);
    }
  });

  it('tells the owner what was found and what the Terms say, and the candidate what the wait may cost', () => {
    const vars = { job: 'Infermiera', company: 'Ospedale Esempio', orderId: 'o1', candidateEmail: 'maria.rossi@example.com' };
    const notice = buildOwnerAutomationEmail('owner_posting_expired', vars);
    expect(notice.subject).toBe('[Candidatura] Annuncio chiuso durante l’attesa del candidato: Infermiera — Ospedale Esempio');
    expect(notice.text).toContain('Il sollecito NON è partito');
    expect(notice.text).toContain('anche l’approvazione automatica dopo 12 ore è sospesa');
    expect(notice.text).toContain('non è stato rimborsato nulla');
    expect(notice.text).toContain('un annuncio ritirato mentre aspettiamo documenti o risposte del candidato non è rimborsato');
    expect(notice.text).toContain('rimborsa dalla coda');
    expect(notice.html).toContain('mailto:maria.rossi@example.com');
    expect(describeTakeover({ reason: 'posting_closed_waited' }).reason).toContain('NESSUN rimborso automatico');
    expect(automationEmailKey({ kind: 'owner_posting_expired', since: 1000 }, { round: 2 })).toBe('auto_owner_posting_expired_1000');

    const base = { name: 'Maria Rossi', job: 'Infermiera', company: 'Ospedale Esempio', jobUrl: 'https://example.com/jobs/1', reviewUrl: 'https://example.com/review', orderId: 'o1', openQuestions: 2 };
    const sentence = { it: 'l’importo non è rimborsato (Termini, punto 6.5)', de: 'wird nicht erstattet (Nutzungsbedingungen, Ziffer 6.5)', fr: 'n’est pas remboursé (Conditions, point 6.5)', en: 'is not refunded (Terms, section 6.5)' };
    for (const [locale, words] of Object.entries(sentence)) {
      // Said while they are awaited: the review held by questions or documents, its reminders, the portal's question.
      expect(buildCandidateAutomationEmail('candidate_review', { ...base, locale, held: true }).text, locale).toContain(words);
      expect(buildCandidateAutomationEmail('candidate_questions_reminder', { ...base, locale }).html, locale).toContain(words);
      expect(buildCandidateAutomationEmail('candidate_action_needed', { ...base, locale }).text, locale).toContain(words);
      // Not when nothing is asked of them: the review with its 12 hours, and the reminder of those.
      expect(buildCandidateAutomationEmail('candidate_review', { ...base, locale, held: false, deadlineAt: T0 }).text, locale).not.toContain(words);
      expect(buildCandidateAutomationEmail('candidate_reminder', { ...base, locale, deadlineAt: T0 }).text, locale).not.toContain(words);
    }
  });

  it('writes the exception next to the promise of a refund in every welcome e-mail', () => {
    const order = (locale: string) => ({ jobTitle: 'Infermiera', companyName: 'Ospedale Esempio', applicantName: 'Maria Rossi', applicantEmail: 'maria.rossi@example.com', locale, amountTotal: 99, currency: 'eur', paidAt: T0 });
    const exception = { it: 'in quel caso l\'importo non è rimborsato (Termini, punto 6.5)', fr: 'le montant n\'est pas remboursé (Conditions, point 6.5)', de: 'wird der Betrag nicht erstattet (Nutzungsbedingungen, Ziffer 6.5)', en: 'the amount is not refunded (Terms, section 6.5)' };
    const promise = { it: 'rimbors', fr: 'rembours', de: 'erstatte', en: 'refund' };
    for (const [locale, words] of Object.entries(exception)) {
      for (const automation of [true, false]) {
        const text = buildCustomerEmail('intro', order(locale), 'o1', { nowMs: T0, automation }).text;
        expect(text, `${locale} ${automation}`).toContain(words);
        // After the promise it qualifies, never instead of it.
        expect(text.indexOf((promise as any)[locale]), `${locale} ${automation}`).toBeGreaterThan(-1);
        expect(text.indexOf((promise as any)[locale]), `${locale} ${automation}`).toBeLessThan(text.indexOf(words));
      }
    }
  });
});
