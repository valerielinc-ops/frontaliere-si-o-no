/**
 * Runtime-safe constants shared by the Cloud Functions and the owner queue
 * client. Keeping the lifecycle vocabulary in one module prevents the API and
 * its UI from silently drifting apart.
 */

export const ASSISTED_APPLICATIONS_COLLECTION = 'assisted_applications';
/** Portal accounts the runner creates on an order's alias: `{order}/automation/accounts` (scripts/assisted-application/lib/portal/account.mjs). */
export const PORTAL_ACCOUNTS_DOC_ID = 'accounts';
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
  'cv_uploaded_by_owner',
]);
