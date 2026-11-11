/**
 * The employer withdrew the posting while the application waited for the candidate (owner decision
 * 2026-11-11: «Comunichiamo che le posizioni sono state ritirate e che l'application è stata ritirata.
 * quindi va in archiviati, nessun rimborso emesso era nelle regole del terms and condition.»).
 *
 * Terms 6.5: an ad closed or withdrawn while the application waits for documents or answers only the
 * candidate can give is not refunded. Such an order is no longer held for Valerie: it is withdrawn
 * (`withdrawn`, the state the candidate's dashboard shows as «Ritirata» next to the other closed
 * applications), the candidate is told once why, and nothing is refunded. An ad that closed with nobody
 * waiting for the candidate keeps the automatic refund the same clause promises (assistedApplicationFlow.js).
 *
 * Only the posting's own word is proof: its page (HTTP 404/410, the posting's or the portal's closure
 * statement), its ATS's own answer (Workday), or the employer's authenticated e-mail on the order's alias.
 * Our dataset no longer listing the job, a page that looks empty, a timeout, a network error, a missing
 * selector or an anti-bot page are never proof: those keep the retries they have today.
 *
 * Pure, no I/O: the flow, the sweep, the inbound mail and the reconcile script share it.
 */

import { isUnconfirmedSubmission } from './assistedApplicationSubmissionGuard.js';

export const EMPLOYER_WITHDRAWAL_REASON = 'posting_withdrawn_by_employer';
/** The candidate's e-mail kind (assistedApplicationAutomationEmails.js), sent once per order. */
export const EMPLOYER_WITHDRAWAL_EMAIL_KIND = 'candidate_posting_withdrawn';

// The liveness codes that are the posting's own statement (assistedApplicationLiveness.js), with where it was
// read. `expired_body_soft`, `listing_page`, `insufficient_content`, `no_apply_control` and the dataset alone
// are readings of ours: never enough to close an application without a refund.
const NATIVE_CLOSURE_SOURCES = Object.freeze({
  http_gone: 'posting_page',
  expired_url: 'posting_page',
  expired_body: 'posting_page',
  ats_api_gone: 'ats_api',
  ats_api_closed: 'ats_api',
  employer_mail: 'employer_mail',
});

/** The closure code a runner event carries: `reason` (submit, portal) or `error` (draft: «posting_closed:<code>»). */
export function closureCodeOf(event) {
  const raw = String(event?.reason || event?.error || event?.code || '').trim();
  return raw.replace(/^posting_closed:/, '').slice(0, 40);
}

/**
 * The native proof the posting is closed, `{ code, source, at }`, or null when the code is not the posting's
 * own word. `at`: when it was read (the event's own time when it has one).
 */
export function nativeClosureOf(event, nowMs = Date.now()) {
  const code = closureCodeOf(event);
  const source = Object.hasOwn(NATIVE_CLOSURE_SOURCES, code) ? NATIVE_CLOSURE_SOURCES[code] : null;
  if (!source) return null;
  const at = Number(event?.closedAt ?? event?.at);
  return { code, source, at: Number.isFinite(at) && at > 0 ? at : nowMs };
}

/** A closure record kept on the flow is still native proof (a flow written by hand or by an old version is not). */
export function recordedNativeClosure(flow) {
  const recorded = flow?.postingClosure;
  if (!recorded || typeof recorded !== 'object') return null;
  const closure = nativeClosureOf({ reason: recorded.code, closedAt: recorded.at });
  return closure && closure.source === recorded.source ? closure : null;
}

/**
 * The application may have reached the employer: a send on record, or a final click nothing proved failed.
 * A portal record released before `confirmedNotSent` existed (failed, with a click and no such field) reads
 * as released, as the submission guard reads it before a retry.
 */
export function sendMayHaveLeft({ draft = null, submission = {} } = {}) {
  if (draft?.sent || draft?.sentAttempt) return true;
  return Object.entries(submission || {}).some(([key, record]) => {
    if (!/^r\d+$/.test(key) || !record || typeof record !== 'object') return false;
    if (record.state === 'sent') return true;
    const legacyReleasedPortal = record.state === 'failed' && record.channel === 'portal'
      && Number(record.clickedAt) > 0 && !Object.hasOwn(record, 'confirmedNotSent');
    return isUnconfirmedSubmission(legacyReleasedPortal ? { ...record, confirmedNotSent: true } : record);
  });
}

/** The order's fields once the employer's withdrawal closed it (assistedApplicationAutomation.js writes them). */
export function employerWithdrawalOrderPatch(flow, nowMs) {
  return {
    submissionStatus: 'withdrawn',
    withdrawnAt: Number(flow?.withdrawnAt) || nowMs,
    withdrawalReason: EMPLOYER_WITHDRAWAL_REASON,
    withdrawalEvidence: { ...flow.withdrawalEvidence },
    automationRefundDueAt: null,
    updatedAt: nowMs,
  };
}

/** The flow was just closed by the employer's withdrawal (and not before). */
export function closedByEmployerWithdrawal(before, after) {
  return before?.state !== 'withdrawn' && after?.state === 'withdrawn' && after?.withdrawnReason === EMPLOYER_WITHDRAWAL_REASON;
}
