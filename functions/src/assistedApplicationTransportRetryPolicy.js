/** Retry only a definite infrastructure failure, never an uncertain send or a hard rejection. */
import { isUnconfirmedSubmission } from './assistedApplicationSubmissionGuard.js';

const NAVIGATION_FAILURE = /ERR_NAME_NOT_RESOLVED|ERR_CONNECTION_(?:RESET|CLOSED|REFUSED|TIMED_OUT)|ERR_(?:NETWORK_CHANGED|INTERNET_DISCONNECTED|TIMED_OUT)|\b(?:ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT)\b|page\.goto:[\s\S]*?Timeout/i;
const PERMANENT_EMAIL_FAILURE = /invalid.{0,25}(?:recipient|email|address)|(?:recipient|address).{0,25}(?:invalid|suppressed|blocked)|suppression|complaint|hard.bounce/i;
const TRANSIENT_EMAIL_FAILURE = /(?:maileroo|resend)\s+(?:408|425|429|5\d\d)\b|quota exhausted|cooling down|not configured|no (?:email )?providers configured/i;

export function emailInfrastructureFailure(failure) {
  if (failure?.ambiguousDelivery) return false;
  const error = String(failure?.error || 'no providers configured');
  return !PERMANENT_EMAIL_FAILURE.test(error) && TRANSIENT_EMAIL_FAILURE.test(error);
}

export function navigationInfrastructureFailure(error) {
  return NAVIGATION_FAILURE.test(String(error?.message || error || ''));
}

/** Legacy normalization also requires the caller to verify payment and approval. */
export function legacyTransportHoldReason({ flow, submission = {}, draft }) {
  if (flow?.state !== 'owner_takeover' || flow?.technicalRecoveryVersion || draft?.sent || draft?.sentAttempt) return null;
  const records = Object.values(submission || {});
  if (records.some(record => record?.state === 'sent' || isUnconfirmedSubmission(record))) return null;
  const record = submission[`r${Number(flow?.round) || 1}`];
  if (record?.state !== 'failed' || record.clickedAt || !(Number(record.releasedAt) > 0)) return null;
  const holds = flow.heldBy || [];
  if (holds.length !== 1) return null;
  if (holds[0] === 'email_failed' && record.channel === 'email' && record.reason === 'email_failed') return 'email_provider_unavailable';
  if (record.channel === 'portal' && navigationInfrastructureFailure(holds[0]) && navigationInfrastructureFailure(record.reason)) return 'navigation_unavailable';
  return null;
}
