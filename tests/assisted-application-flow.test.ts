import { describe, expect, it, vi } from 'vitest';

vi.mock('../functions/src/remoteConfigSecrets.js', () => ({ getRemoteConfigValue: vi.fn(async () => '') }));

const {
  CANDIDATE_REMINDER_BEFORE_MS,
  CANDIDATE_REVIEW_MS,
  HELD_OWNER_NOTICE_AFTER_MS,
  HELD_REMINDERS_AFTER_MS,
  MAX_RUN_ATTEMPTS,
  MAX_REVIEW_ROUNDS,
  OWNER_REVIEW_MS,
  evaluateRedFlags,
  isTransientRunError,
  transition,
} = await import('../functions/src/assistedApplicationFlow.js');
const { mintReviewToken, verifyReviewToken } = await import('../functions/src/assistedApplicationReviewToken.js');

const T0 = Date.UTC(2026, 8, 30, 8, 0, 0);
const cleanDraft = {
  verdict: 'good',
  job: { source: 'job_detail' },
  channel: { type: 'lever' },
  factCheck: { ok: true, unsupported: [] },
  questions: [],
};

describe('draft failures', () => {
  // Trial run 2026-09-30: round 2 went to the owner on "codex auth broker rejected the request; codex timed out".
  const brokerError = 'codex auth broker rejected the request_ codex timed out after <number>ms';

  it('retries a transient failure, and hands over after the last attempt or on a real error', () => {
    const regenerating = { state: 'regenerating', round: 2, dispatch: { mode: 'draft', round: 2, attempts: 1 } };
    const retry = transition(regenerating, { type: 'draft_failed', error: brokerError }, { draft: cleanDraft, nowMs: T0 });
    expect(retry.flow.state).toBe('regenerating');
    expect(retry.effects).toEqual([{ type: 'dispatch', mode: 'draft', reason: 'transient_retry', attempts: 2 }]);

    const last = transition({ ...regenerating, dispatch: { ...regenerating.dispatch, attempts: MAX_RUN_ATTEMPTS } }, { type: 'draft_failed', error: brokerError }, { draft: cleanDraft, nowMs: T0 });
    expect(last.flow).toMatchObject({ state: 'owner_takeover', heldBy: ['draft_failed'] });
    expect(last.effects).toEqual([{ type: 'email', kind: 'owner_takeover', reason: brokerError, stage: 'draft', attempts: MAX_RUN_ATTEMPTS }]);

    const real = transition(regenerating, { type: 'draft_failed', error: 'cv_unavailable:not_found' }, { draft: cleanDraft, nowMs: T0 });
    expect(real.flow.state).toBe('owner_takeover');
  });

  it('knows which errors another run can fix', () => {
    for (const error of [brokerError, 'codex_http_503', 'codex_http_429', 'rate_limit', 'ETIMEDOUT', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'EAI_AGAIN', 'model overloaded']) {
      expect(isTransientRunError(error)).toBe(true);
    }
    // runner_timeout: the watchdog already re-dispatched the silent run.
    for (const error of ['cv_unavailable:not_found', 'posting_unreadable', 'invalid_profile', 'runner_timeout', 'codex_http_400', '']) {
      expect(isTransientRunError(error)).toBe(false);
    }
  });

  it('runs a submission again after a transient failure, never after an ambiguous one', () => {
    const submitting = { state: 'submitting', round: 1, dispatch: { mode: 'submit', round: 1, attempts: 1 } };
    const retry = transition(submitting, { type: 'submit_failed', error: brokerError }, { draft: cleanDraft, nowMs: T0 });
    expect(retry.flow.state).toBe('submitting');
    expect(retry.effects).toEqual([{ type: 'dispatch', mode: 'submit', reason: 'transient_retry', attempts: 2 }]);

    const last = transition({ ...submitting, dispatch: { ...submitting.dispatch, attempts: MAX_RUN_ATTEMPTS } }, { type: 'submit_failed', error: 'Timeout 30000ms exceeded' }, { draft: cleanDraft, nowMs: T0 });
    expect(last.flow.state).toBe('owner_takeover');
    expect(last.effects).toEqual([{ type: 'email', kind: 'owner_takeover', reason: 'Timeout 30000ms exceeded', stage: 'submit', attempts: MAX_RUN_ATTEMPTS }]);

    // The application may have reached the employer: the owner checks first.
    for (const error of ['email_ambiguous', 'portal_ambiguous', 'email_failed', 'portal_validation', 'runner_timeout']) {
      const step = transition(submitting, { type: 'submit_failed', error }, { draft: cleanDraft, nowMs: T0 });
      expect(step.flow).toMatchObject({ state: 'owner_takeover', heldBy: [error] });
    }
  });
});

describe('red flags', () => {
  it('separates what only Valerie can clear from what only the candidate can answer', () => {
    expect(evaluateRedFlags(cleanDraft)).toEqual({ owner: [], candidate: [], documents: [] });
    const flags = evaluateRedFlags({
      ...cleanDraft,
      verdict: 'poor',
      factCheck: { ok: false, unsupported: [{ kind: 'number', token: '7' }] },
      channel: { type: 'unknown' },
      questions: [
        { id: 'permit', required: true },
        { id: 'salary', required: true },
        { id: 'hobby', required: false },
      ],
    }, { salary: 'CHF 80k' });
    expect(flags).toEqual({ owner: ['fact_check', 'knock_out', 'channel_unknown'], candidate: ['permit'], documents: [] });
  });

  it('an acknowledged warning no longer holds the flow', () => {
    expect(evaluateRedFlags({
      ...cleanDraft,
      verdict: 'poor',
      knockOutAcknowledgedAt: T0,
      factCheck: { unsupported: [{ kind: 'number' }] },
      factCheckAcknowledgedAt: T0,
    }).owner).toEqual([]);
  });
});

describe('approval flow', () => {
  it('runs the happy path on the two clocks: 1 h owner, 12 h candidate', () => {
    let step = transition({ state: 'drafting', round: 1 }, { type: 'draft_ready' }, { draft: cleanDraft, nowMs: T0 });
    expect(step.flow).toMatchObject({ state: 'owner_review', deadlineAt: T0 + OWNER_REVIEW_MS });
    expect(step.effects).toEqual([{ type: 'email', kind: 'owner_review', held: false, flags: [] }]);

    expect(transition(step.flow, { type: 'tick' }, { draft: cleanDraft, nowMs: T0 + OWNER_REVIEW_MS - 1 }).ignored).toBe('nothing_due');
    step = transition(step.flow, { type: 'tick' }, { draft: cleanDraft, nowMs: T0 + OWNER_REVIEW_MS });
    const candidateStart = T0 + OWNER_REVIEW_MS;
    expect(step.flow).toMatchObject({
      state: 'candidate_review',
      deadlineAt: candidateStart + CANDIDATE_REVIEW_MS,
      reminderAt: candidateStart + CANDIDATE_REVIEW_MS - CANDIDATE_REMINDER_BEFORE_MS,
    });
    expect(step.effects).toEqual([{ type: 'email', kind: 'candidate_review', held: false, round: 1 }]);

    step = transition(step.flow, { type: 'tick' }, { draft: cleanDraft, nowMs: candidateStart + CANDIDATE_REVIEW_MS - CANDIDATE_REMINDER_BEFORE_MS });
    expect(step.effects).toEqual([{ type: 'email', kind: 'candidate_reminder', deadlineAt: candidateStart + CANDIDATE_REVIEW_MS }]);
    expect(step.flow.deadlineAt).toBe(candidateStart + CANDIDATE_REVIEW_MS);
    expect(transition(step.flow, { type: 'tick' }, { draft: cleanDraft, nowMs: candidateStart + CANDIDATE_REVIEW_MS - 1 }).ignored).toBe('nothing_due');

    step = transition(step.flow, { type: 'tick' }, { draft: cleanDraft, nowMs: candidateStart + CANDIDATE_REVIEW_MS });
    expect(step.flow.state).toBe('submitting');
    expect(step.effects).toEqual([{ type: 'dispatch', mode: 'submit', reason: 'auto_approved_12h' }]);

    step = transition(step.flow, { type: 'submit_succeeded' }, { draft: cleanDraft, nowMs: candidateStart + CANDIDATE_REVIEW_MS + 60_000 });
    expect(step.flow.state).toBe('submitted');
    expect(step.effects).toEqual([{ type: 'mark_submitted' }]);
  });

  it('lets Valerie and the candidate approve before the clocks run out', () => {
    let step = transition({ state: 'drafting' }, { type: 'draft_ready' }, { draft: cleanDraft, nowMs: T0 });
    step = transition(step.flow, { type: 'owner_approve' }, { draft: cleanDraft, nowMs: T0 + 5 * 60_000 });
    expect(step.flow.state).toBe('candidate_review');
    step = transition(step.flow, { type: 'candidate_approve' }, { draft: cleanDraft, nowMs: T0 + 10 * 60_000 });
    expect(step.effects).toEqual([{ type: 'dispatch', mode: 'submit', reason: 'candidate_approved' }]);
  });

  it('holds on owner red flags until Valerie acts, even after the hour', () => {
    const flagged = { ...cleanDraft, factCheck: { unsupported: [{ kind: 'number', token: '30' }] } };
    let step = transition({ state: 'drafting' }, { type: 'draft_ready' }, { draft: flagged, nowMs: T0 });
    expect(step.flow).toMatchObject({ state: 'owner_review', deadlineAt: null, heldBy: ['fact_check'] });
    expect(step.effects[0]).toMatchObject({ kind: 'owner_review', held: true });
    expect(transition(step.flow, { type: 'tick' }, { draft: flagged, nowMs: T0 + 10 * OWNER_REVIEW_MS }).ignored).toBe('nothing_due');
    // Approving without acknowledging the flag is refused: the flow stays in owner review.
    const refused = transition(step.flow, { type: 'owner_approve' }, { draft: flagged, nowMs: T0 + 2 * OWNER_REVIEW_MS });
    expect(refused.ignored).toBe('owner_flags_open');
    expect(refused.flow.state).toBe('owner_review');
    step = transition(step.flow, { type: 'owner_approve' }, { draft: { ...flagged, factCheckAcknowledgedAt: T0 }, nowMs: T0 + 2 * OWNER_REVIEW_MS });
    expect(step.flow.state).toBe('candidate_review');
  });

  it('needs an acknowledgement for every owner flag, the ones without a dedicated field by name', () => {
    const noPosting = { ...cleanDraft, job: { source: 'none' }, channel: { type: 'unknown' } };
    const review = { state: 'owner_review', round: 1 };
    expect(transition(review, { type: 'owner_approve' }, { draft: noPosting, nowMs: T0 }).ignored).toBe('owner_flags_open');
    expect(transition(review, { type: 'owner_approve' }, { draft: { ...noPosting, acknowledgedFlags: { no_posting: T0 } }, nowMs: T0 }).ignored).toBe('owner_flags_open');
    const approved = transition(review, { type: 'owner_approve' }, { draft: { ...noPosting, acknowledgedFlags: { no_posting: T0, channel_unknown: T0 } }, nowMs: T0 });
    expect(approved.flow.state).toBe('candidate_review');
    expect(evaluateRedFlags({ ...noPosting, acknowledgedFlags: { no_posting: T0, channel_unknown: T0 } }).owner).toEqual([]);
  });

  it('holds on open candidate questions: no 12 h auto-approval until they are answered', () => {
    const withQuestion = { ...cleanDraft, questions: [{ id: 'permit', required: true }] };
    let step = transition({ state: 'owner_review', deadlineAt: T0 }, { type: 'tick' }, { draft: withQuestion, nowMs: T0 });
    expect(step.flow).toMatchObject({ state: 'candidate_review', deadlineAt: null, heldBy: ['question:permit'] });
    expect(step.effects).toEqual([{ type: 'email', kind: 'candidate_review', held: true, round: 1 }]);
    expect(transition(step.flow, { type: 'candidate_approve' }, { draft: withQuestion, nowMs: T0 + 1 }).ignored).toBe('questions_open');
    expect(transition(step.flow, { type: 'tick' }, { draft: withQuestion, nowMs: T0 + CANDIDATE_REVIEW_MS }).ignored).toBe('nothing_due');
    // A day later only a reminder goes out: nothing leaves without the answers.
    const nudged = transition(step.flow, { type: 'tick' }, { draft: withQuestion, nowMs: T0 + 2 * CANDIDATE_REVIEW_MS });
    expect(nudged.flow).toMatchObject({ state: 'candidate_review', deadlineAt: null, heldBy: ['question:permit'] });
    expect(nudged.effects).toEqual([{ type: 'email', kind: 'candidate_questions_reminder', nudge: 1, since: T0 }]);

    const answeredAt = T0 + 3 * 60 * 60_000;
    step = transition(step.flow, { type: 'candidate_answers' }, { draft: withQuestion, answers: { permit: 'Permesso G' }, nowMs: answeredAt });
    expect(step.flow).toMatchObject({ state: 'candidate_review', deadlineAt: answeredAt + CANDIDATE_REVIEW_MS, heldBy: [] });
    expect(step.effects).toEqual([]);
  });

  // Owner question 2026-10-01: «cosa succede dopo le 12 ore che l'utente non risponde alle domande?»
  it('reminds a candidate who does not answer at 24 h and 72 h, then tells Valerie after 5 days', () => {
    const questions = [{ id: 'permit', required: true }, { id: 'rate', required: true }];
    const draft = { ...cleanDraft, questions };
    let step = transition({ state: 'owner_review', deadlineAt: T0 + OWNER_REVIEW_MS }, { type: 'owner_approve' }, { draft, nowMs: T0 });
    expect(step.flow).toMatchObject({ state: 'candidate_review', heldSince: T0, heldNudges: 0, reminderAt: T0 + HELD_REMINDERS_AFTER_MS[0] });
    expect(step.effects).toEqual([{ type: 'email', kind: 'candidate_review', held: true, round: 1 }]);

    // One answer of two: still waiting, on the same schedule.
    step = transition(step.flow, { type: 'candidate_answers' }, { draft, answers: { permit: 'Permesso G' }, nowMs: T0 + 60_000 });
    expect(step.flow).toMatchObject({ heldBy: ['question:rate'], heldSince: T0, reminderAt: T0 + HELD_REMINDERS_AFTER_MS[0] });
    expect(step.effects).toEqual([]);
    const answers = { permit: 'Permesso G' };

    step = transition(step.flow, { type: 'tick' }, { draft, answers, nowMs: T0 + HELD_REMINDERS_AFTER_MS[0] });
    expect(step.effects).toEqual([{ type: 'email', kind: 'candidate_questions_reminder', nudge: 1, since: T0 }]);
    expect(step.flow).toMatchObject({ state: 'candidate_review', heldNudges: 1, reminderAt: T0 + HELD_REMINDERS_AFTER_MS[1], deadlineAt: null });
    expect(transition(step.flow, { type: 'tick' }, { draft, answers, nowMs: T0 + HELD_REMINDERS_AFTER_MS[0] + 1 }).ignored).toBe('nothing_due');

    step = transition(step.flow, { type: 'tick' }, { draft, answers, nowMs: T0 + HELD_REMINDERS_AFTER_MS[1] });
    expect(step.effects).toEqual([{ type: 'email', kind: 'candidate_questions_reminder', nudge: 2, since: T0 }]);
    expect(step.flow).toMatchObject({ heldNudges: 2, reminderAt: T0 + HELD_OWNER_NOTICE_AFTER_MS });

    step = transition(step.flow, { type: 'tick' }, { draft, answers, nowMs: T0 + HELD_OWNER_NOTICE_AFTER_MS });
    expect(step.effects).toEqual([{ type: 'email', kind: 'owner_candidate_silent', since: T0, days: 5, nudges: 2 }]);
    // The order keeps waiting for the answers, with no clock left: Valerie decides.
    expect(step.flow).toMatchObject({ state: 'candidate_review', heldBy: ['question:rate'], heldNudges: 3, reminderAt: null, deadlineAt: null });
    expect(transition(step.flow, { type: 'tick' }, { draft, answers, nowMs: T0 + 30 * 24 * 60 * 60_000 }).ignored).toBe('nothing_due');

    // The last answer ends the wait and starts the 12 h clock, with its own reminder.
    const answeredAt = T0 + 6 * 24 * 60 * 60_000;
    step = transition(step.flow, { type: 'candidate_answers' }, { draft, answers: { ...answers, rate: '80 CHF' }, nowMs: answeredAt });
    expect(step.flow).toMatchObject({
      state: 'candidate_review', heldBy: [], heldSince: null, heldNudges: 0,
      deadlineAt: answeredAt + CANDIDATE_REVIEW_MS, reminderAt: answeredAt + CANDIDATE_REVIEW_MS - CANDIDATE_REMINDER_BEFORE_MS,
    });
  });

  it('gives the 12 h clock after a wait its own reminder, even when an earlier clock sent one (review of #10803)', () => {
    const draft = { ...cleanDraft, questions: [{ id: 'permit', required: true }] };
    // The earlier 12 h clock already reminded the candidate; at its end a question is open.
    let step = transition({ state: 'candidate_review', deadlineAt: T0, reminderSentAt: T0 - CANDIDATE_REMINDER_BEFORE_MS, heldBy: [] }, { type: 'tick' }, { draft, nowMs: T0 });
    expect(step.flow).toMatchObject({ state: 'candidate_review', heldBy: ['question:permit'], heldSince: T0, reminderSentAt: null });
    const answeredAt = T0 + 60 * 60_000;
    step = transition(step.flow, { type: 'candidate_answers' }, { draft, answers: { permit: 'Permesso G' }, nowMs: answeredAt });
    expect(step.flow.heldBy).toEqual([]);
    expect(step.flow.reminderAt).toBe(answeredAt + CANDIDATE_REVIEW_MS - CANDIDATE_REMINDER_BEFORE_MS);
  });

  it('reminds the candidate of the portal\'s questions too, each wait with its own reminders', () => {
    const questions = [{ id: 'screening_1', required: true }];
    let step = transition({ state: 'submitting' }, { type: 'submit_needs_candidate', questions }, { draft: cleanDraft, nowMs: T0 });
    expect(step.flow).toMatchObject({ state: 'needs_candidate_action', heldSince: T0, reminderAt: T0 + HELD_REMINDERS_AFTER_MS[0] });
    const draft = { ...cleanDraft, questions };
    step = transition(step.flow, { type: 'tick' }, { draft, nowMs: T0 + HELD_REMINDERS_AFTER_MS[0] });
    expect(step.effects).toEqual([{ type: 'email', kind: 'candidate_questions_reminder', nudge: 1, since: T0 }]);

    // Answered: the submit runs again and the wait is over.
    step = transition(step.flow, { type: 'candidate_answers' }, { draft, answers: { screening_1: 'Sì' }, nowMs: T0 + 2 * HELD_REMINDERS_AFTER_MS[0] });
    expect(step.flow).toMatchObject({ state: 'submitting', heldSince: null, heldNudges: 0, reminderAt: null });
    // The portal asks again: a new wait, with reminders of its own.
    const again = T0 + 3 * HELD_REMINDERS_AFTER_MS[0];
    step = transition(step.flow, { type: 'submit_needs_candidate', questions: [{ id: 'screening_2', required: true }] }, { draft, nowMs: again });
    expect(step.flow).toMatchObject({ heldSince: again, heldNudges: 0, reminderAt: again + HELD_REMINDERS_AFTER_MS[0] });
  });

  // Rolex 2026-10-02: school reports and the EVA test results go with the application.
  it('holds the send until each required document is uploaded or the candidate chooses to send without it', () => {
    const draft = { ...cleanDraft, requiredDocuments: [
      { id: 'reports', label: 'Bulletins scolaires', kind: 'school_report', required: true },
      { id: 'eva', label: 'Test EVA', kind: 'aptitude_test', required: true },
      { id: 'photo_portfolio', label: 'Portfolio', kind: 'portfolio', required: false },
    ] };
    let step = transition({ state: 'owner_review', deadlineAt: T0 + OWNER_REVIEW_MS }, { type: 'owner_approve' }, { draft, nowMs: T0 });
    // An optional document never holds.
    expect(step.flow).toMatchObject({ state: 'candidate_review', heldBy: ['document:reports', 'document:eva'], deadlineAt: null, heldSince: T0 });
    expect(step.effects).toEqual([{ type: 'email', kind: 'candidate_review', held: true, round: 1 }]);
    expect(transition(step.flow, { type: 'candidate_approve' }, { draft, nowMs: T0 + 1 }).ignored).toBe('questions_open');
    // The same reminders as an open question.
    const nudged = transition(step.flow, { type: 'tick' }, { draft, nowMs: T0 + HELD_REMINDERS_AFTER_MS[0] });
    expect(nudged.effects).toEqual([{ type: 'email', kind: 'candidate_questions_reminder', nudge: 1, since: T0 }]);

    // Reports uploaded, the EVA waived (their call, after the warning): the 12 h clock starts.
    const documents = { reports: { files: [{ key: 'k', detectedType: 'pdf' }] }, eva: { files: [], waivedAt: T0 + 5 } };
    step = transition(step.flow, { type: 'candidate_answers' }, { draft, documents, nowMs: T0 + 10 });
    expect(step.flow).toMatchObject({ state: 'candidate_review', heldBy: [], heldSince: null, deadlineAt: T0 + 10 + CANDIDATE_REVIEW_MS });
    expect(transition(step.flow, { type: 'candidate_approve' }, { draft, documents, nowMs: T0 + 20 }).effects)
      .toEqual([{ type: 'dispatch', mode: 'submit', reason: 'candidate_approved' }]);
  });

  it('holds a portal send that reached a document only the candidate can give', () => {
    const step = transition({ state: 'submitting' }, { type: 'submit_needs_candidate', questions: [{ id: 'q1' }], documents: ['reports'] }, { draft: cleanDraft, nowMs: T0 });
    expect(step.flow).toMatchObject({ state: 'needs_candidate_action', heldBy: ['question:q1', 'document:reports'], heldSince: T0 });
  });

  it('regenerates on rejection and hands over to Valerie after the third one', () => {
    let flow: any = { state: 'candidate_review', round: 1, deadlineAt: T0 + CANDIDATE_REVIEW_MS };
    for (let round = 1; round < MAX_REVIEW_ROUNDS; round += 1) {
      const step = transition(flow, { type: 'candidate_reject', feedback: `troppo formale ${round}` }, { draft: cleanDraft, nowMs: T0 });
      expect(step.flow).toMatchObject({ state: 'regenerating', round: round + 1, deadlineAt: null });
      expect(step.effects).toEqual([{ type: 'dispatch', mode: 'draft', reason: 'candidate_feedback' }]);
      flow = transition(step.flow, { type: 'draft_ready' }, { draft: cleanDraft, nowMs: T0 }).flow;
      flow = transition(flow, { type: 'owner_approve' }, { draft: cleanDraft, nowMs: T0 }).flow;
    }
    const last = transition(flow, { type: 'candidate_reject', feedback: 'no' }, { draft: cleanDraft, nowMs: T0 });
    expect(last.flow).toMatchObject({ state: 'owner_takeover', heldBy: ['max_rounds'] });
    expect(last.flow.feedback.map((item: any) => item.round)).toEqual([1, 2, 3]);
    expect(last.effects).toEqual([{ type: 'email', kind: 'owner_takeover', reason: 'max_rounds' }]);
  });

  it('pauses a submission that needs the candidate and resumes after the answers', () => {
    const questions = [{ id: 'screening_1', required: true }];
    let step = transition({ state: 'submitting' }, { type: 'submit_needs_candidate', questions }, { draft: cleanDraft, nowMs: T0 });
    expect(step.flow.state).toBe('needs_candidate_action');
    const draft = { ...cleanDraft, questions };
    expect(transition(step.flow, { type: 'candidate_answers' }, { draft, answers: {}, nowMs: T0 }).ignored).toBe('questions_open');
    step = transition(step.flow, { type: 'candidate_answers' }, { draft, answers: { screening_1: 'Sì' }, nowMs: T0 });
    expect(step.effects).toEqual([{ type: 'dispatch', mode: 'submit', reason: 'candidate_answered' }]);
  });

  it('ignores events that do not belong to the current state', () => {
    expect(transition({ state: 'submitted' }, { type: 'candidate_approve' }, { nowMs: T0 }).ignored).toBe('terminal');
    expect(transition({ state: 'owner_review' }, { type: 'candidate_approve' }, { nowMs: T0 }).ignored).toBe('not_candidate_review');
    const kept = transition({ state: 'candidate_review', deadlineAt: T0 + 5, reminderAt: T0 + 1 }, { type: 'owner_approve' }, { nowMs: T0 });
    expect(kept.flow).toMatchObject({ deadlineAt: T0 + 5, reminderAt: T0 + 1 });
  });
});

describe('review link token', () => {
  const secret = 'x'.repeat(40);

  it('round-trips and binds order, round and expiry', () => {
    const token = mintReviewToken({ secret, orderId: 'order_ABC123', round: 2, nowMs: T0 });
    expect(token).toMatch(/^ar1\.order_ABC123\.2\.[0-9a-z]+\.[0-9a-f]{32}$/);
    expect(verifyReviewToken({ secret, token, nowMs: T0 + 1000 })).toMatchObject({ ok: true, orderId: 'order_ABC123', round: 2 });
    expect(verifyReviewToken({ secret, token: token.replace('.2.', '.3.'), nowMs: T0 })).toEqual({ ok: false, error: 'bad_signature' });
    expect(verifyReviewToken({ secret, token: token.replace('order_ABC123', 'order_XYZ999'), nowMs: T0 })).toEqual({ ok: false, error: 'bad_signature' });
    expect(verifyReviewToken({ secret: 'y'.repeat(40), token, nowMs: T0 })).toEqual({ ok: false, error: 'bad_signature' });
    expect(verifyReviewToken({ secret, token, nowMs: T0 + 31 * 24 * 60 * 60_000 })).toEqual({ ok: false, error: 'expired' });
    expect(verifyReviewToken({ secret, token: 'garbage', nowMs: T0 })).toEqual({ ok: false, error: 'malformed' });
  });

  it('refuses to mint without a real secret', () => {
    expect(() => mintReviewToken({ secret: 'short', orderId: 'order_ABC123', round: 1 })).toThrow('review_secret_missing');
  });
});

describe('career-ops handoff, closed ads and owner regeneration', () => {
  // Owner decision 2026-10-01 (giro di prova su JOIN): the candidate paid not to apply by hand.
  it('sends a portal the robot could not finish to Valerie, who retries it or chooses to hand it over', () => {
    const roundDraft = { ...cleanDraft, round: 1 };
    let step = transition({ state: 'submitting', round: 1, dispatch: { mode: 'submit', attempts: 1 } }, { type: 'submit_handoff', reason: 'captcha' }, { draft: roundDraft, nowMs: T0 });
    expect(step.flow).toMatchObject({ state: 'owner_takeover', heldBy: ['portal:captcha'], reminderAt: null });
    expect(step.effects).toEqual([{ type: 'email', kind: 'owner_takeover', reason: 'portal:captcha', stage: 'submit', attempts: 1 }]);

    const retried = transition(step.flow, { type: 'owner_retry_submit' }, { draft: roundDraft, nowMs: T0 });
    expect(retried.flow.state).toBe('submitting');
    expect(retried.effects).toEqual([{ type: 'dispatch', mode: 'submit', reason: 'owner_retry' }]);
    // Never without the approved draft of the round.
    expect(transition(step.flow, { type: 'owner_retry_submit' }, { draft: { ...cleanDraft, round: 0 }, nowMs: T0 }).ignored).toBe('no_approved_draft');

    step = transition(step.flow, { type: 'owner_handoff' }, { draft: roundDraft, nowMs: T0 });
    expect(step.flow).toMatchObject({ state: 'candidate_handoff', heldBy: ['owner_handoff'], reminderAt: T0 + 24 * 60 * 60_000 });
    expect(step.effects).toEqual([{ type: 'email', kind: 'candidate_handoff', reason: null }]);
    const reminder = transition(step.flow, { type: 'tick' }, { draft: cleanDraft, nowMs: T0 + 24 * 60 * 60_000 });
    expect(reminder.effects).toEqual([{ type: 'email', kind: 'candidate_handoff_reminder' }]);
    expect(transition(reminder.flow, { type: 'tick' }, { draft: cleanDraft, nowMs: T0 + 48 * 60 * 60_000 }).ignored).toBe('nothing_due');
    step = transition(reminder.flow, { type: 'candidate_confirmed_submitted' }, { draft: cleanDraft, nowMs: T0 + 25 * 60 * 60_000 });
    expect(step.flow.state).toBe('submitted');
    expect(step.effects).toEqual([{ type: 'mark_submitted', by: 'candidate' }]);
  });

  it('refunds automatically when the ad closed before sending', () => {
    for (const state of ['drafting', 'owner_review', 'candidate_review', 'submitting']) {
      const step = transition({ state, round: 1 }, { type: 'posting_closed' }, { draft: cleanDraft, nowMs: T0 });
      expect(step.flow).toMatchObject({ state: 'owner_takeover', heldBy: ['posting_closed'] });
      // The candidate's refund e-mail is sent by the refund effect, only after the refund went through.
      expect(step.effects.map((effect: any) => (effect.type === 'email' ? effect.kind : effect.type)))
        .toEqual(['refund', 'owner_takeover']);
      expect(step.effects[0]).toMatchObject({ type: 'refund', notify: 'candidate_posting_closed' });
    }
    expect(transition({ state: 'candidate_handoff' }, { type: 'posting_closed' }, { nowMs: T0 }).ignored).toBe('not_open');
  });

  it('lets Valerie regenerate, even after taking the order over', () => {
    for (const state of ['owner_review', 'owner_takeover', 'candidate_review']) {
      const step = transition({ state, round: 2 }, { type: 'owner_regenerate' }, { draft: { ...cleanDraft, round: 2 }, nowMs: T0 });
      expect(step.flow).toMatchObject({ state: 'regenerating', round: 3 });
      expect(step.effects).toEqual([{ type: 'dispatch', mode: 'draft', reason: 'owner_regenerate' }]);
    }
    expect(transition({ state: 'submitted' }, { type: 'owner_regenerate' }, { nowMs: T0 }).ignored).toBe('not_regenerable');
  });

  // Trial run 2026-09-30: round 2 failed on Codex, and "Rigenera" moved Luigi to his last round.
  it('writes a failed round again as the same round, never costing the candidate a round', () => {
    const failed = { state: 'owner_takeover', round: 2, heldBy: ['draft_failed'] };
    const roundOneDraft = { ...cleanDraft, round: 1 };
    const regenerated = transition(failed, { type: 'owner_regenerate' }, { draft: roundOneDraft, nowMs: T0 });
    expect(regenerated.flow).toMatchObject({ state: 'regenerating', round: 2, heldBy: [] });
    expect(regenerated.effects).toEqual([{ type: 'dispatch', mode: 'draft', reason: 'owner_regenerate' }]);
    // The very first draft failed: still round 1.
    expect(transition({ ...failed, round: 1 }, { type: 'owner_regenerate' }, { draft: null, nowMs: T0 }).flow.round).toBe(1);

    // "Riprendi automazione" has nothing to review either: the draft is written again.
    const resumed = transition(failed, { type: 'owner_resume' }, { draft: roundOneDraft, nowMs: T0 });
    expect(resumed.flow).toMatchObject({ state: 'regenerating', round: 2 });
    expect(resumed.effects).toEqual([{ type: 'dispatch', mode: 'draft', reason: 'owner_resume' }]);
    // With the round's draft in hand, resuming reviews it as before.
    expect(transition({ ...failed, heldBy: ['submit_failed'] }, { type: 'owner_resume' }, { draft: { ...cleanDraft, round: 2 }, nowMs: T0 }).flow.state).toBe('owner_review');
    // A closed ad is not drafted again by a resume.
    expect(transition({ ...failed, heldBy: ['posting_closed'] }, { type: 'owner_resume' }, { draft: roundOneDraft, nowMs: T0 }).flow.state).toBe('owner_review');
  });
});

describe('employer acknowledgement of a submit of unknown outcome', () => {
  // career-ops apply.md: "sent" on the success page OR the confirmation e-mail.
  it('marks the order submitted from a running submit or one Valerie holds as ambiguous', () => {
    for (const flow of [
      { state: 'submitting', round: 1 },
      { state: 'owner_takeover', round: 1, heldBy: ['portal_ambiguous'] },
      // JOIN 2026-10-01: the same unknown outcome behind an invisible reCAPTCHA.
      { state: 'owner_takeover', round: 1, heldBy: ['portal_antibot_ambiguous'] },
      { state: 'owner_takeover', round: 1, heldBy: ['email_ambiguous'] },
    ]) {
      const step = transition(flow, { type: 'submit_acknowledged' }, { draft: cleanDraft, nowMs: T0 });
      expect(step.flow).toMatchObject({ state: 'submitted', heldBy: [], deadlineAt: null, reminderAt: null });
      expect(step.flow.history.at(-1)).toEqual({ at: T0, event: 'submit_acknowledged', state: 'submitted' });
      expect(step.effects).toEqual([{ type: 'mark_submitted' }]);
    }
  });

  it('never moves a flow that holds anything else, or is past the submit', () => {
    for (const heldBy of [['portal:captcha'], ['owner'], ['runner_timeout'], ['posting_closed'], ['max_rounds']]) {
      expect(transition({ state: 'owner_takeover', heldBy }, { type: 'submit_acknowledged' }, { nowMs: T0 }).ignored).toBe('not_ambiguous_submit');
    }
    for (const state of ['submitted', 'failed', 'candidate_review', 'candidate_handoff', 'drafting']) {
      expect(transition({ state }, { type: 'submit_acknowledged' }, { nowMs: T0 }).ignored).toBe('not_ambiguous_submit');
    }
    // The runner's own success is still accepted only while it submits.
    expect(transition({ state: 'owner_takeover', heldBy: ['portal_ambiguous'] }, { type: 'submit_succeeded' }, { nowMs: T0 }).ignored).toBe('terminal');
  });
});
