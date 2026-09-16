/**
 * Runtime-safe constants shared by the Cloud Functions and the owner queue
 * client. Keeping the lifecycle vocabulary in one module prevents the API and
 * its UI from silently drifting apart.
 */

export const ASSISTED_APPLICATIONS_COLLECTION = 'assisted_applications';

export const ASSISTED_APPLICATION_ADMIN_STATUSES = Object.freeze([
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
  'manual_submission_completed',
  'manual_submission_blocked',
  'refund_issued',
]);
