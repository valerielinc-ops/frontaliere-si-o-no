import { describe, expect, it, vi } from 'vitest';

vi.mock('../functions/src/remoteConfigSecrets.js', () => ({ getRemoteConfigValue: vi.fn(async () => '') }));

const {
  CANDIDATE_REMINDER_BEFORE_MS,
  CANDIDATE_REVIEW_MS,
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
    expect(evaluateRedFlags(cleanDraft)).toEqual({ owner: [], candidate: [] });
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
    expect(flags).toEqual({ owner: ['fact_check', 'knock_out', 'channel_unknown'], candidate: ['permit'] });
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
    expect(transition(step.flow, { type: 'tick' }, { draft: withQuestion, nowMs: T0 + 2 * CANDIDATE_REVIEW_MS }).ignored).toBe('nothing_due');

    const answeredAt = T0 + 3 * 60 * 60_000;
    step = transition(step.flow, { type: 'candidate_answers' }, { draft: withQuestion, answers: { permit: 'Permesso G' }, nowMs: answeredAt });
    expect(step.flow).toMatchObject({ state: 'candidate_review', deadlineAt: answeredAt + CANDIDATE_REVIEW_MS, heldBy: [] });
    expect(step.effects).toEqual([]);
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
  it('hands a portal over to the candidate and counts it sent only on their confirmation', () => {
    let step = transition({ state: 'submitting', round: 1 }, { type: 'submit_handoff', reason: 'captcha' }, { draft: cleanDraft, nowMs: T0 });
    expect(step.flow).toMatchObject({ state: 'candidate_handoff', heldBy: ['captcha'], reminderAt: T0 + 24 * 60 * 60_000 });
    expect(step.effects).toEqual([{ type: 'email', kind: 'candidate_handoff', reason: 'captcha' }]);
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
      const step = transition({ state, round: 2 }, { type: 'owner_regenerate' }, { draft: cleanDraft, nowMs: T0 });
      expect(step.flow).toMatchObject({ state: 'regenerating', round: 3 });
      expect(step.effects).toEqual([{ type: 'dispatch', mode: 'draft', reason: 'owner_regenerate' }]);
    }
    expect(transition({ state: 'submitted' }, { type: 'owner_regenerate' }, { nowMs: T0 }).ignored).toBe('not_regenerable');
  });
});
