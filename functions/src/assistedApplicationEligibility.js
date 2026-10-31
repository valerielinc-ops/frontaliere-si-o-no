/** Canonical preconditions shared by normal dispatch and alternative executor admission. */

const STARTABLE_STATUSES = new Set(['awaiting_upload', 'ready_for_manual_submission', 'in_progress']);
const SUPPORTED_CV_TYPES = new Set(['pdf', 'docx', 'doc']);

export function isAssistedApplicationCvKey(orderId, key) {
  const value = String(key || '');
  const prefix = `assisted-application-uploads/${orderId}/`;
  return value.startsWith(prefix) && value.length <= 600 && /^[A-Za-z0-9._-]+$/.test(value.slice(prefix.length));
}

export function isCvReady(order) {
  const check = order?.cvFileCheck;
  return Boolean(order?.cvStorageKey && check && check.key === order.cvStorageKey && check.verdict === 'ok');
}

export function automationEligibility(order, orderId) {
  if (!order || order.paymentStatus !== 'paid') return { eligible: false, reason: 'not_paid' };
  if (!STARTABLE_STATUSES.has(order.submissionStatus)) return { eligible: false, reason: 'order_closed' };
  if (order.refundStatus === 'pending') return { eligible: false, reason: 'refund_in_progress' };
  if (!isAssistedApplicationCvKey(orderId, order.cvStorageKey)) return { eligible: false, reason: 'cv_missing' };
  if (!isCvReady(order)) return { eligible: false, reason: 'cv_not_verified' };
  if (!SUPPORTED_CV_TYPES.has(order.cvFileCheck.detectedType)) return { eligible: false, reason: 'cv_format_unsupported' };
  return { eligible: true, reason: null };
}
