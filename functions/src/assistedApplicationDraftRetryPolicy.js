/** Shared bounded recovery policy for a draft run that failed before review. */
export const DRAFT_AUTO_RETRY_DELAY_MS = 5 * 60 * 1000;
export const DRAFT_AUTO_RETRY_MAX_ATTEMPTS = 1;
export const CODEX_USAGE_LIMIT_RETRY_DELAYS_MS = Object.freeze([2 * 60 * 60 * 1000, 6 * 60 * 60 * 1000, 24 * 60 * 60 * 1000]);
export const DRAFT_CANDIDATE_EMAIL_RECOVERY_VERSION = 'draft-recovery-candidate-email-v1';
export const DRAFT_CANDIDATE_EMAIL_MISSING_CODE = 'assisted_application_candidate_email_missing';

/** True when a run failed because Codex/OpenAI CLI quota/usage limit was exhausted. */
export function isCodexUsageLimitError(error) {
  const text = String(error || '');
  return /\b(?:you['’_]?ve hit your usage limit|usage limit reached|insufficient_quota|codex_http_429)\b/i.test(text)
    || /\bcodex\b[^\n]{0,120}\busage[ _-]?limit\b/i.test(text);
}

/** Maximum delayed auto-retries for the current draft failure kind. */
export function draftRetryMaxAttempts(flow) {
  return flow?.draftFailureKind === 'codex_usage_limit'
    ? CODEX_USAGE_LIMIT_RETRY_DELAYS_MS.length
    : DRAFT_AUTO_RETRY_MAX_ATTEMPTS;
}

/** Delay before the next automatic draft retry for the given attempt count. */
export function draftRetryDelayMs(flow, attempts = draftAutoRetryCountValue(flow)) {
  if (flow?.draftFailureKind !== 'codex_usage_limit') return DRAFT_AUTO_RETRY_DELAY_MS;
  const index = Math.min(Math.max(0, Number(attempts) || 0), CODEX_USAGE_LIMIT_RETRY_DELAYS_MS.length - 1);
  return CODEX_USAGE_LIMIT_RETRY_DELAYS_MS[index];
}

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
  return attempts !== null && attempts < draftRetryMaxAttempts(flow);
}

/** Next clock moment for the one safe re-generation of a missing draft. */
export function draftRetryDueAt(flow) {
  const retryAt = Number(flow?.draftAutoRetryAt) || 0;
  const failedDraft = Array.isArray(flow?.heldBy)
    && flow.heldBy.length === 1 && flow.heldBy[0] === 'draft_failed';
  return flow?.state === 'owner_takeover' && failedDraft && draftAutoRetryAttemptsRemaining(flow)
    && Number.isFinite(retryAt) && retryAt > 0 ? retryAt : null;
}
