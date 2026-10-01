/**
 * Approval flow of the automated assisted application (owner decision
 * 2026-09-30):
 *
 *   draft ready ──► owner_review ──(Valerie approves, or 1 h passes)──► candidate_review
 *   candidate_review ──(candidate approves, or 12 h pass)──► submitting ──► submitted
 *   candidate_review ──(candidate rejects with feedback)──► regenerating ──► owner_review …
 *   after the 3rd rejection ──► owner_takeover (Valerie gets every feedback)
 *
 * Red flags stop the clocks, they never skip a step:
 *   - owner flags (invented facts in the texts, a knock-out requirement the
 *     CV lacks, no posting text, unknown channel) hold `owner_review` until
 *     Valerie acts;
 *   - candidate flags (a required answer only the candidate can give: work
 *     permit, salary expectation, availability, a portal screening question)
 *     hold `candidate_review` until the candidate answers.
 *
 * This module is pure: `transition(flow, event, context)` returns the next
 * flow and the side effects (e-mails, workflow dispatches) the caller runs.
 * Keeping it free of I/O is what makes every edge of the diagram testable.
 */

export const OWNER_REVIEW_MS = 60 * 60 * 1000;
export const CANDIDATE_REVIEW_MS = 12 * 60 * 60 * 1000;
export const CANDIDATE_REMINDER_BEFORE_MS = 3 * 60 * 60 * 1000;
export const HANDOFF_REMINDER_MS = 24 * 60 * 60 * 1000;
export const MAX_REVIEW_ROUNDS = 3;
// A draft or submit run that failed on a transient error is dispatched again
// up to this many runs in all; the owner hears about it only after the last.
export const MAX_RUN_ATTEMPTS = 3;
const TRANSIENT_RUN_ERROR_RE = /broker|timed[ _]?out|timeout|rate[ _]?limit|(?:^|[^0-9])(?:429|5\d\d)(?![0-9])|econnreset|econnrefused|etimedout|enetunreach|ehostunreach|eai_again|socket|(?:service|temporarily)[ _]?unavailable|overloaded/i;

/** Codex broker refusals, timeouts, rate limits, 5xx: worth another run. */
// runner_timeout is the watchdog's own verdict after its re-dispatches: not retried again.
export function isTransientRunError(error) {
  const text = String(error || '');
  return text !== 'runner_timeout' && TRANSIENT_RUN_ERROR_RE.test(text);
}

/** Another run for a transient failure, or null once the attempts are used up. */
function transientRetry(flow, event, mode) {
  const attempts = Number(flow?.dispatch?.attempts) || 1;
  if (!isTransientRunError(event.error) || attempts >= MAX_RUN_ATTEMPTS) return null;
  return [{ type: 'dispatch', mode, reason: 'transient_retry', attempts: attempts + 1 }];
}

/** The owner's e-mail says which step stopped and after how many runs. */
function takeoverEmail(flow, event, stage) {
  return {
    type: 'email',
    kind: 'owner_takeover',
    reason: event.error || `${stage}_failed`,
    stage,
    attempts: Number(flow?.dispatch?.attempts) || 1,
  };
}

/*
 * `candidate_handoff` is career-ops' "browser handoff": when a portal needs a
 * human (CAPTCHA, a verification the automation must not bypass, a form the
 * runner cannot complete), the candidate gets the direct link, the numbered
 * answers and the documents, submits from their own browser and confirms.
 * Like career-ops, the order counts as submitted only on that confirmation.
 */
export const FLOW_STATES = Object.freeze([
  'drafting',
  'owner_review',
  'candidate_review',
  'regenerating',
  'submitting',
  'needs_candidate_action',
  'candidate_handoff',
  'submitted',
  'owner_takeover',
  'failed',
]);

export const TERMINAL_STATES = new Set(['submitted', 'owner_takeover', 'failed']);
// What Valerie can do on an order that stopped (each event still checks the state it accepts).
const OWNER_EXITS = new Set(['owner_resume', 'owner_regenerate', 'owner_retry_submit', 'owner_handoff']);

/**
 * @param {object} draft the AI draft (ai_drafts/current)
 * @param {Record<string,string>} answers candidate answers by question id
 */
export function evaluateRedFlags(draft, answers = {}) {
  const owner = [];
  // A flag the owner explicitly acknowledged in the queue no longer holds.
  const acknowledged = (flag) => Boolean(draft?.acknowledgedFlags?.[flag]);
  const unsupported = draft?.factCheck?.unsupported || [];
  if (unsupported.length > 0 && !draft?.factCheckAcknowledgedAt && !acknowledged('fact_check')) owner.push('fact_check');
  if (draft?.verdict === 'poor' && !draft?.knockOutAcknowledgedAt && !acknowledged('knock_out')) owner.push('knock_out');
  if (draft?.job?.source === 'none' && !acknowledged('no_posting')) owner.push('no_posting');
  if ((!draft?.channel || draft.channel.type === 'unknown') && !acknowledged('channel_unknown')) owner.push('channel_unknown');
  // career-ops Block G "Suspicious": the owner looks at the posting first.
  if (draft?.legitimacy?.tier === 'suspicious' && !acknowledged('legitimacy')) owner.push('legitimacy');
  const candidate = (draft?.questions || [])
    .filter((question) => question.required && !String(answers?.[question.id] ?? '').trim())
    .map((question) => question.id);
  return { owner, candidate };
}

/** Current flow with every field present; transitions overwrite only what changes. */
function base(flow) {
  return {
    state: flow?.state || 'drafting',
    round: Number(flow?.round) || 1,
    deadlineAt: Number(flow?.deadlineAt) || null,
    reminderAt: Number(flow?.reminderAt) || null,
    reminderSentAt: Number(flow?.reminderSentAt) || null,
    heldBy: Array.isArray(flow?.heldBy) ? flow.heldBy : [],
    feedback: Array.isArray(flow?.feedback) ? flow.feedback : [],
    history: Array.isArray(flow?.history) ? flow.history.slice(-40) : [],
  };
}

function withHistory(next, event, nowMs) {
  next.history = [...next.history, { at: nowMs, event, state: next.state }].slice(-40);
  return next;
}

/**
 * The round's draft never came out (its run failed, timed out, or Valerie
 * took over while it was being written): the runner stores a draft only when
 * it succeeds, so the stored one belongs to an earlier round, or there is none.
 * The candidate has seen nothing of this round.
 */
function roundDraftMissing(current, draft) {
  return Number(draft?.round) !== Number(current.round);
}

/** The round's draft is written again, in the same round. */
function redraftSameRound(next, reason) {
  next.state = 'regenerating';
  next.deadlineAt = null;
  next.reminderAt = null;
  next.heldBy = [];
  return [{ type: 'dispatch', mode: 'draft', reason }];
}

function enterOwnerReview(next, flags, nowMs) {
  next.state = 'owner_review';
  next.heldBy = flags.owner;
  next.deadlineAt = flags.owner.length ? null : nowMs + OWNER_REVIEW_MS;
  next.reminderAt = null;
  next.reminderSentAt = null;
  return [{ type: 'email', kind: 'owner_review', held: flags.owner.length > 0, flags: flags.owner }];
}

function enterCandidateReview(next, flags, nowMs, { resend = true, keepDeadline = null } = {}) {
  next.state = 'candidate_review';
  next.heldBy = flags.candidate.map((id) => `question:${id}`);
  if (flags.candidate.length) {
    next.deadlineAt = null;
    next.reminderAt = null;
  } else {
    // Answering the last open question starts the 12 h clock (or keeps the
    // one already running), it never shortens it.
    next.deadlineAt = keepDeadline && keepDeadline > nowMs ? keepDeadline : nowMs + CANDIDATE_REVIEW_MS;
    next.reminderAt = next.reminderSentAt ? null : next.deadlineAt - CANDIDATE_REMINDER_BEFORE_MS;
  }
  return resend ? [{ type: 'email', kind: 'candidate_review', held: flags.candidate.length > 0, round: next.round }] : [];
}

function enterSubmitting(next, reason) {
  next.state = 'submitting';
  next.deadlineAt = null;
  next.reminderAt = null;
  next.heldBy = [];
  return [{ type: 'dispatch', mode: 'submit', reason }];
}

/**
 * @param {object|null} flow current flow (order.automation)
 * @param {{type:string, feedback?:string, questions?:Array, error?:string}} event
 * @param {{draft?:object, answers?:object, nowMs?:number}} context
 * @returns {{flow:object, effects:Array<object>, ignored?:string}}
 */
export function transition(flow, event, { draft = null, answers = {}, nowMs = Date.now() } = {}) {
  const current = base(flow);
  const state = current.state;
  const next = { ...current };
  const flags = evaluateRedFlags(draft, answers);
  const ignore = (why) => ({ flow: current, effects: [], ignored: why });
  if (TERMINAL_STATES.has(state) && !OWNER_EXITS.has(event.type)) return ignore('terminal');

  let effects = [];
  switch (event.type) {
    case 'draft_ready':
      if (state !== 'drafting' && state !== 'regenerating') return ignore('not_drafting');
      effects = enterOwnerReview(next, flags, nowMs);
      break;
    case 'draft_failed': {
      if (state !== 'drafting' && state !== 'regenerating') return ignore('not_drafting');
      // A transient failure gets another run first; the owner takes over only
      // after the last attempt, or for an error another run will not fix.
      const retry = transientRetry(flow, event, 'draft');
      if (retry) {
        effects = retry;
        break;
      }
      next.state = 'owner_takeover';
      next.heldBy = ['draft_failed'];
      effects = [takeoverEmail(flow, event, 'draft')];
      break;
    }
    case 'owner_approve':
      if (state !== 'owner_review') return ignore('not_owner_review');
      // Every owner flag needs its explicit acknowledgement (written to the
      // draft by the queue before this event): approving is not enough.
      if (flags.owner.length) return ignore('owner_flags_open');
      effects = enterCandidateReview(next, flags, nowMs);
      break;
    case 'owner_takeover':
      next.state = 'owner_takeover';
      next.deadlineAt = null;
      next.reminderAt = null;
      next.heldBy = ['owner'];
      effects = [];
      break;
    case 'owner_regenerate':
      // Valerie asks for a new draft (e.g. after editing the answers): a new
      // round, so links of the previous round can no longer approve. A round
      // whose draft never came out is written again as the same round: a
      // failure on our side never costs the candidate one of their rounds.
      if (!['owner_review', 'owner_takeover', 'candidate_review'].includes(state)) return ignore('not_regenerable');
      if (state !== 'owner_takeover' || !roundDraftMissing(current, draft)) next.round = current.round + 1;
      effects = redraftSameRound(next, 'owner_regenerate');
      break;
    case 'owner_resume':
      if (state !== 'owner_takeover' && state !== 'failed') return ignore('not_taken_over');
      // Nothing to review when the round's draft never came out: it is
      // written again. A closed ad stays stopped: resuming it is Valerie's call
      // on the draft she has.
      if (roundDraftMissing(current, draft) && !current.heldBy.includes('posting_closed')) {
        effects = redraftSameRound(next, 'owner_resume');
        break;
      }
      effects = enterOwnerReview(next, { owner: [], candidate: flags.candidate }, nowMs);
      break;
    case 'tick': {
      const deadline = current.deadlineAt || 0;
      const reminder = current.reminderAt || 0;
      if (state === 'owner_review' && deadline && nowMs >= deadline) {
        // A flag can appear after the clock started (e.g. an edit that
        // reintroduced an unverified number): hold instead of passing it on.
        if (flags.owner.length) {
          next.heldBy = flags.owner;
          next.deadlineAt = null;
          effects = [{ type: 'email', kind: 'owner_review', held: true, flags: flags.owner }];
          break;
        }
        effects = enterCandidateReview(next, flags, nowMs);
        break;
      }
      if (state === 'candidate_review' && deadline && nowMs >= deadline) {
        if (flags.candidate.length) {
          next.heldBy = flags.candidate.map((id) => `question:${id}`);
          next.deadlineAt = null;
          next.reminderAt = null;
          effects = [];
          break;
        }
        effects = enterSubmitting(next, 'auto_approved_12h');
        break;
      }
      if (state === 'candidate_review' && reminder && nowMs >= reminder && !current.reminderSentAt) {
        next.reminderAt = null;
        next.reminderSentAt = nowMs;
        effects = [{ type: 'email', kind: 'candidate_reminder', deadlineAt: current.deadlineAt }];
        break;
      }
      if (state === 'candidate_handoff' && reminder && nowMs >= reminder && !current.reminderSentAt) {
        next.reminderAt = null;
        next.reminderSentAt = nowMs;
        effects = [{ type: 'email', kind: 'candidate_handoff_reminder' }];
        break;
      }
      return ignore('nothing_due');
    }
    case 'submit_handoff':
      // Owner decision 2026-10-01: the candidate paid not to apply by hand. A
      // portal step the robot did not finish (a CAPTCHA, an account, a page it
      // could not fill) goes to Valerie, who completes it, retries it, or by
      // her own choice hands it to the candidate (owner_handoff).
      if (state !== 'submitting') return ignore('not_submitting');
      next.state = 'owner_takeover';
      next.deadlineAt = null;
      next.reminderAt = null;
      next.heldBy = [`portal:${String(event.reason || 'portal_needs_candidate').slice(0, 60)}`];
      effects = [{ type: 'email', kind: 'owner_takeover', reason: `portal:${event.reason || 'portal_needs_candidate'}`, stage: 'submit', attempts: Number(flow?.dispatch?.attempts) || 1 }];
      break;
    case 'owner_retry_submit':
      // The approved application is sent again by the robot (after a runner
      // fix, or a portal that was briefly unavailable): only for the round's
      // own draft, which the candidate approved.
      if (!['owner_takeover', 'candidate_handoff'].includes(state)) return ignore('not_retryable');
      if (roundDraftMissing(current, draft)) return ignore('no_approved_draft');
      effects = enterSubmitting(next, 'owner_retry');
      break;
    case 'owner_handoff':
      // Valerie's choice, for a step only the candidate can do (an SMS to their phone).
      if (state !== 'owner_takeover') return ignore('not_taken_over');
      if (roundDraftMissing(current, draft)) return ignore('no_approved_draft');
      next.state = 'candidate_handoff';
      next.deadlineAt = null;
      next.reminderAt = nowMs + HANDOFF_REMINDER_MS;
      next.reminderSentAt = null;
      next.heldBy = ['owner_handoff'];
      effects = [{ type: 'email', kind: 'candidate_handoff', reason: event.reason || null }];
      break;
    case 'candidate_confirmed_submitted':
      if (state !== 'candidate_handoff') return ignore('not_handoff');
      next.state = 'submitted';
      next.reminderAt = null;
      next.heldBy = [];
      effects = [{ type: 'mark_submitted', by: 'candidate' }];
      break;
    case 'posting_closed':
      if (!['drafting', 'regenerating', 'owner_review', 'candidate_review', 'submitting'].includes(state)) {
        return ignore('not_open');
      }
      next.state = 'owner_takeover';
      next.deadlineAt = null;
      next.reminderAt = null;
      next.heldBy = ['posting_closed'];
      // Owner decision 2026-09-30: the only refund the welcome e-mail promises
      // is "the ad closed before we could send it" — so it is automatic.
      // The candidate's "we refunded you" e-mail is sent by the refund effect
      // itself, only once the refund went through (retried if it fails).
      effects = [
        { type: 'refund', reason: 'posting_closed', notify: 'candidate_posting_closed' },
        { type: 'email', kind: 'owner_takeover', reason: 'posting_closed' },
      ];
      break;
    case 'candidate_approve':
      if (state !== 'candidate_review') return ignore('not_candidate_review');
      if (flags.candidate.length) return { flow: current, effects: [], ignored: 'questions_open' };
      effects = enterSubmitting(next, 'candidate_approved');
      break;
    case 'candidate_answers':
      if (state !== 'candidate_review' && state !== 'needs_candidate_action') return ignore('not_waiting_for_candidate');
      if (state === 'needs_candidate_action') {
        if (flags.candidate.length) return { flow: { ...current }, effects: [], ignored: 'questions_open' };
        effects = enterSubmitting(next, 'candidate_answered');
        break;
      }
      effects = enterCandidateReview(next, flags, nowMs, { resend: false, keepDeadline: Number(flow?.deadlineAt) || null });
      break;
    case 'candidate_reject': {
      if (state !== 'candidate_review') return ignore('not_candidate_review');
      const feedback = String(event.feedback || '').trim().slice(0, 2000);
      next.feedback = [...current.feedback, { round: current.round, at: nowMs, text: feedback }];
      if (current.round >= MAX_REVIEW_ROUNDS) {
        next.state = 'owner_takeover';
        next.heldBy = ['max_rounds'];
        effects = [{ type: 'email', kind: 'owner_takeover', reason: 'max_rounds' }];
        break;
      }
      next.state = 'regenerating';
      next.round = current.round + 1;
      next.deadlineAt = null;
      next.reminderAt = null;
      next.heldBy = [];
      effects = [{ type: 'dispatch', mode: 'draft', reason: 'candidate_feedback' }];
      break;
    }
    case 'submit_succeeded':
      if (state !== 'submitting') return ignore('not_submitting');
      next.state = 'submitted';
      effects = [{ type: 'mark_submitted' }];
      break;
    case 'submit_needs_candidate':
      if (state !== 'submitting') return ignore('not_submitting');
      next.state = 'needs_candidate_action';
      next.heldBy = (event.questions || []).map((question) => `question:${question.id}`);
      effects = [{ type: 'email', kind: 'candidate_action_needed' }];
      break;
    case 'submit_failed': {
      if (state !== 'submitting') return ignore('not_submitting');
      // Safe to run again: the submission guard (scripts/assisted-application/
      // lib/submit.mjs) replays an application already sent, and one that may
      // have left (after the final click, or an e-mail of unknown outcome)
      // comes back as *_ambiguous, which is never retried.
      const retry = transientRetry(flow, event, 'submit');
      if (retry) {
        effects = retry;
        break;
      }
      next.state = 'owner_takeover';
      next.heldBy = [String(event.error || 'submit_failed').slice(0, 80)];
      effects = [takeoverEmail(flow, event, 'submit')];
      break;
    }
    default:
      return ignore('unknown_event');
  }
  return { flow: withHistory(next, event.type, nowMs), effects };
}
