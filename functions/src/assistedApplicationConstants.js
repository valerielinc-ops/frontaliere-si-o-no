/**
 * Runtime-safe constants shared by the Cloud Functions and the owner queue
 * client. Keeping the lifecycle vocabulary in one module prevents the API and
 * its UI from silently drifting apart.
 */

export const ASSISTED_APPLICATIONS_COLLECTION = 'assisted_applications';
/** Portal accounts the runner creates on an order's alias: `{order}/automation/accounts` (scripts/assisted-application/lib/portal/account.mjs). */
export const PORTAL_ACCOUNTS_DOC_ID = 'accounts';

// The kinds of documents a posting may require besides the CV and the cover
// letter (assistedApplicationExtraDocuments.js, the requirements schema).
export const DOCUMENT_KINDS = Object.freeze([
  'school_report', 'aptitude_test', 'diploma', 'certificate', 'reference', 'work_permit', 'identity', 'portfolio', 'other',
]);
/** Follow-ups of an application sent by e-mail: `{order}/automation/followup` (assistedApplicationFollowup.js). */
export const FOLLOWUP_DOC_ID = 'followup';

/** One-off price in EUR cents, shared by checkout validation and analytics. */
export const ASSISTED_APPLICATION_PRICE_EUR_CENTS = 99;

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
  'automation_draft_edited',
  'automation_candidate_edited',
  // The candidate's line-by-line choices on the tailored CV (review page).
  'automation_candidate_cv_reviewed',
  'cv_uploaded_by_owner',
]);

// The mandate texts candidates agreed to, oldest first; the last is the one
// shown now. v2 (2026-09-30) names the employer's terms accepted on the
// candidate's behalf. firestore.rules and storage.rules accept exactly these.
export const ASSISTED_APPLICATION_CONSENT_VERSIONS = Object.freeze(['assisted-application-v1', 'assisted-application-v2']);

/** The candidate already gave the mandate, in a version still honoured: never asked (nor rewritten) again. */
export function hasAssistedApplicationConsent(order) {
  return ASSISTED_APPLICATION_CONSENT_VERSIONS.includes(String(order?.consentVersion || '')) && order?.consentedAt != null;
}

/**
 * Terms 6.5 as rewritten on 2026-10-08 (services/legal/terms.ts, the four languages name this same day): an ad
 * that closes or is withdrawn while the application waits for documents or answers only the candidate can
 * give is not refunded. It binds the orders placed from this moment on (12 October 2026, 00:00 in Zurich);
 * an earlier order keeps the promise it was sold with: «the ad closed before we could send it» is refunded.
 */
export const ASSISTED_APPLICATION_WAIT_TERMS_FROM_MS = Date.UTC(2026, 9, 11, 22, 0, 0);

const millisOf = (value) => {
  if (typeof value?.toMillis === 'function') return value.toMillis();
  if (value instanceof Date) return value.getTime();
  const number = typeof value === 'string' ? Date.parse(value) : Number(value);
  return Number.isFinite(number) ? number : 0;
};

/** The order was placed (paid, else created) under the Terms 6.5 of 2026-10. Unknown dates: the older promise. */
export function waitTermsApply(order) {
  const placedAt = millisOf(order?.paidAt) || millisOf(order?.createdAt);
  return placedAt > 0 && placedAt >= ASSISTED_APPLICATION_WAIT_TERMS_FROM_MS;
}
