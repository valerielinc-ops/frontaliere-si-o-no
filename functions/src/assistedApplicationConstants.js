/**
 * Runtime-safe constants shared by the Cloud Functions and the owner queue
 * client. Keeping the lifecycle vocabulary in one module prevents the API and
 * its UI from silently drifting apart.
 */

import { APPLICATION_CONCIERGE_CONSENT_VERSIONS } from './applicationConciergeConstants.js';

export const ASSISTED_APPLICATIONS_COLLECTION = 'assisted_applications';
export const ASSISTED_APPLICATION_ORDER_ID_RE = /^[A-Za-z0-9_-]{6,128}$/;
/** Keep runner question/document arrays within the backend's candidate-review contract. */
export const ASSISTED_APPLICATION_RUNNER_EVENT_ARRAY_LIMIT = 20;
/** Server-only state and engagement records for pending-payment recovery digests. */
export const ASSISTED_APPLICATION_PAYMENT_RECOVERY_COLLECTION = 'assisted_application_payment_recovery';
/** Portal accounts the runner creates on an order's alias: `{order}/automation/accounts` (scripts/assisted-application/lib/portal/account.mjs). */
export const PORTAL_ACCOUNTS_DOC_ID = 'accounts';
/** Admin-only lifecycle audit: `{order}/events/{eventId}`. */
export const ASSISTED_APPLICATION_AUDIT_SUBCOLLECTION = 'events';

// The kinds of documents a posting may require besides the CV and the cover
// letter (assistedApplicationExtraDocuments.js, the requirements schema).
export const DOCUMENT_KINDS = Object.freeze([
  'school_report', 'aptitude_test', 'diploma', 'certificate', 'reference', 'work_permit', 'identity', 'portfolio', 'photo', 'other',
]);
/** Bounded recovery for a required portrait when the original CV may contain one. */
export const CV_PORTRAIT_RECOVERY_VERSION = 1;
export const CV_PORTRAIT_RECOVERY_MAX_ATTEMPTS = 3;
export const CV_PORTRAIT_RECOVERY_BACKOFF_MS = Object.freeze([5 * 60 * 1000, 30 * 60 * 1000]);
/** Follow-ups of an application sent by e-mail: `{order}/automation/followup` (assistedApplicationFollowup.js). */
export const FOLLOWUP_DOC_ID = 'followup';

/** One-off price in EUR cents, shared by checkout validation and analytics. */
export const ASSISTED_APPLICATION_PRICE_EUR_CENTS = 199;

// `awaiting_upload` is a paid order whose materials have not arrived yet: it
// must stay visible, because the email-first concierge (see
// assistedApplicationNotifications.js) lets the customer send the CV by
// replying to Valerie instead of using the upload page.
export const ASSISTED_APPLICATION_ADMIN_STATUSES = Object.freeze([
  'awaiting_upload',
  'ready_for_manual_submission',
  'in_progress',
  'submitted',
  'blocked',
  'refunded',
]);

export const ASSISTED_APPLICATION_ADMIN_STATUS_SET = new Set(
  ASSISTED_APPLICATION_ADMIN_STATUSES,
);

export const ASSISTED_APPLICATION_EVENT_TYPES = Object.freeze([
  'manual_submission_queued',
  'materials_received_by_email',
  'manual_submission_completed',
  'manual_submission_blocked',
  'refund_issued',
  // Automated flow (assistedApplicationAutomation.js): one entry per transition,
  // plus the owner's edits of the AI draft and a CV she uploads for the customer.
  'automation_transition',
  'automation_dispatch_recovery_scheduled',
  'automation_draft_edited',
  'automation_candidate_edited',
  'automation_reopened_after_withdrawal',
  // The candidate's line-by-line choices on the tailored CV (review page).
  'automation_candidate_cv_reviewed',
  'cv_uploaded_by_owner',
  // Facts the candidate stated in their reply to valerie@, applied to the order (assistedApplicationCandidateReply.js).
  'candidate_reply_applied',
  // A portal's reminder of an application started there and not sent (assistedApplicationInbound.js): kept
  // from the candidate, recorded with its time and the portal host only.
  'portal_application_reminder',
]);

// The mandate texts candidates agreed to, oldest first; the last is the one
// shown now. v2 (2026-09-30) names the employer's terms accepted on the
// candidate's behalf. v3 (2026-11-11) adds the candidate's express request
// that the service start at once, and their acknowledgement that once the
// process started nothing is refunded (Terms 6.5). firestore.rules and
// storage.rules accept exactly these.
export const ASSISTED_APPLICATION_CONSENT_VERSIONS = Object.freeze(['assisted-application-v1', 'assisted-application-v2', 'assisted-application-v3']);

/** The first mandate under which the Terms 6.5 of 2026-11-11 hold: no refund once the process started. */
export const NO_REFUND_AFTER_START_CONSENT_VERSION = 'assisted-application-v3';

/** The candidate already gave the mandate, in a version still honoured: never asked (nor rewritten) again. */
export function hasAssistedApplicationConsent(order) {
  return ASSISTED_APPLICATION_CONSENT_VERSIONS.includes(String(order?.consentVersion || '')) && order?.consentedAt != null;
}

/**
 * Owner decision 2026-11-11 («il rimborso non è mai consentito una volta che il processo è stato avviato»),
 * Terms 6.5: once the process started, the order is never refunded by itself, whatever closes it (the ad closed
 * or withdrawn by the employer, the candidate's own withdrawal, no answer from the employer). The process starts
 * when the automated flow is created (assistedApplicationAutomation.js startAutomation: `flow.startedAt`, the
 * first draft's dispatch, `order.automationState`), after the payment and the verified CV.
 *
 * It holds for the orders whose candidate gave the mandate that says so (v3 or later: the express request to
 * start at once and the acknowledgement), and for every application of the automated search (a concierge
 * child: its payment is the parent service's, never refunded per application, assistedApplicationAdminCore.js
 * `parent_service_refund_required`). An order with an older mandate, or none (a CV sent by e-mail), keeps the
 * refund its Terms promised: the candidate never accepted the new rule. The owner's manual refund is unchanged.
 */
export function refundEndsAtStart(order) {
  if (order?.billingMode === 'application_concierge') return true;
  const version = ASSISTED_APPLICATION_CONSENT_VERSIONS.indexOf(String(order?.consentVersion || ''));
  return version >= ASSISTED_APPLICATION_CONSENT_VERSIONS.indexOf(NO_REFUND_AFTER_START_CONSENT_VERSION)
    && order?.consentedAt != null;
}

/** Whether the consent recorded for this application says no refund once preparation starts. */
export function hasNoRefundAfterStartConsent(order) {
  if (order?.billingMode === 'application_concierge') {
    const conciergeVersion = APPLICATION_CONCIERGE_CONSENT_VERSIONS.indexOf(
      String(order?.parentServiceConsentVersion || ''),
    );
    const noRefundVersion = APPLICATION_CONCIERGE_CONSENT_VERSIONS.indexOf('application-concierge-v3');
    return noRefundVersion >= 0 && conciergeVersion >= noRefundVersion && order?.consentedAt != null;
  }
  const assistedVersion = ASSISTED_APPLICATION_CONSENT_VERSIONS.indexOf(String(order?.consentVersion || ''));
  const noRefundVersion = ASSISTED_APPLICATION_CONSENT_VERSIONS.indexOf(NO_REFUND_AFTER_START_CONSENT_VERSION);
  return noRefundVersion >= 0 && assistedVersion >= noRefundVersion && order?.consentedAt != null;
}
