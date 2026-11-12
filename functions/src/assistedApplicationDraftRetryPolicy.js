/** Shared bounded recovery policy for a draft run that failed before review. */
export const DRAFT_AUTO_RETRY_DELAY_MS = 5 * 60 * 1000;
export const DRAFT_AUTO_RETRY_MAX_ATTEMPTS = 1;
export const DRAFT_CANDIDATE_EMAIL_RECOVERY_VERSION = 'draft-recovery-candidate-email-v1';
export const DRAFT_CANDIDATE_EMAIL_MISSING_CODE = 'assisted_application_candidate_email_missing';

/** Parse the persisted draft retry counter without coercing malformed values. */
export function draftAutoRetryCountValue(flow) {
  const raw = flow?.draftAutoRetryCount;
  if (raw === undefined) return 0;
  if (typeof raw === 'number') return Number.isSafeInteger(raw) && raw >= 0 ? raw : null;
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!/^\d+$/.test(text)) return null;
  const attempts = Number(text);
  return Number.isSafeInteger(attempts) ? attempts : null;
}

export function draftAutoRetryAttemptsRemaining(flow) {
  const attempts = draftAutoRetryCountValue(flow);
  return attempts !== null && attempts < DRAFT_AUTO_RETRY_MAX_ATTEMPTS;
}

/** Next clock moment for the one safe re-generation of a missing draft. */
export function draftRetryDueAt(flow) {
  const retryAt = Number(flow?.draftAutoRetryAt) || 0;
  const failedDraft = Array.isArray(flow?.heldBy)
    && flow.heldBy.length === 1 && flow.heldBy[0] === 'draft_failed';
  return flow?.state === 'owner_takeover' && failedDraft && draftAutoRetryAttemptsRemaining(flow)
    && Number.isFinite(retryAt) && retryAt > 0 ? retryAt : null;
}
