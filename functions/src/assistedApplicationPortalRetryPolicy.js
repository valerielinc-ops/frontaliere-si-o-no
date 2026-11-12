/** Shared by the state machine, scheduler and owner queue. No I/O. */
export const PORTAL_AUTO_RETRY_DELAYS_MS = Object.freeze([6 * 60 * 60 * 1000, 24 * 60 * 60 * 1000]);
export const PORTAL_FINAL_REVIEW_AMBIGUOUS_RECOVERY_VERSION = 'portal-final-review-ambiguous-v1';
export const TRANSPORT_AUTO_RETRY_DELAYS_MS = Object.freeze([5 * 60 * 1000, 30 * 60 * 1000, 2 * 60 * 60 * 1000]);
// SHA-256 of "assisted-application:swiss-egress-network-recovery:v1". Bump the suffix when this one-shot repair changes.
export const SWISS_EGRESS_NETWORK_RECOVERY_VERSION = '0c6b24bcb58d7e92fed5d94f37f8f918449a57a1428ea10eb342bb0fca47cbf1';
// Stops caused by where and how the runner connects, not by the portal form
// or the candidate. `application_region_unsupported` belongs here: the
// employer geolocates the visitor's IP, i.e. the GitHub runner's, not the
// candidate's (Yellowshark, order 1EpmkrDu: 13 of 19 runs got the regional
// notice, the other 6 reached the form; from a Swiss connection the same
// posting serves its form). Another run usually gets another address.
const TRANSPORT_HOLDS = new Set([
  'portal:navigation_unavailable',
  'transport:email_provider_unavailable',
  'portal:question_localization_unavailable',
  'portal:application_region_unsupported',
  // The order needs the Swiss runner and none was alive to take the run
  // (assistedApplicationSwissRunner.js): each retry queues it there again.
  'portal:swiss_runner_offline',
]);

/** CAPTCHA holds belong to the owner and never enter automatic retry or candidate handoff. */
export function isCaptchaHandoffReason(reason) {
  // Legacy JOIN outcome explicitly names its invisible reCAPTCHA, but predates
  // the typed CAPTCHA stop and must keep the same owner-only recovery path.
  return /^(?:portal:)?(?:(?:captcha|recaptcha|hcaptcha|turnstile)(?:_|$)|portal_antibot_ambiguous$)/i.test(String(reason || ''));
}

export function isCaptchaPortalHold(flow) {
  return Array.isArray(flow?.heldBy) && flow.heldBy.some(isCaptchaHandoffReason);
}

export function isInfrastructureRetryHold(flow) {
  return (flow?.heldBy || []).some(reason => TRANSPORT_HOLDS.has(reason));
}

export function autoRetryDelaysForFlow(flow) {
  return isInfrastructureRetryHold(flow)
    ? TRANSPORT_AUTO_RETRY_DELAYS_MS : PORTAL_AUTO_RETRY_DELAYS_MS;
}

export function isAutoRetryablePortalHold(flow) {
  const swissNetworkHold = flow?.egress?.required === 'ch'
    && flow.egress.source === 'repeated_network_failure'
    && (flow?.heldBy || []).some(reason => reason === 'portal:posting_mismatch' || reason === 'portal:access_blocked');
  return swissNetworkHold || (flow?.heldBy || []).some(reason => TRANSPORT_HOLDS.has(reason)
    || reason === 'portal:portal_needs_candidate') || portalFinalReviewAmbiguousRecoveryPending(flow);
}

/** Parse the persisted portal retry counter without coercing malformed values. */
export function portalAutoRetryCountValue(flow) {
  const raw = flow?.portalAutoRetryCount;
  if (raw === undefined) return 0;
  if (typeof raw === 'number') return Number.isSafeInteger(raw) && raw >= 0 ? raw : null;
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!/^\d+$/.test(text)) return null;
  const attempts = Number(text);
  return Number.isSafeInteger(attempts) ? attempts : null;
}

/**
 * The unsupported-portal recovery lane has a finite budget.  Keep this
 * check in the shared policy so the scheduler and the source-version
 * reconciler cannot disagree about whether another automatic submit exists.
 * Legacy flows without the field start at zero; malformed or negative values
 * fail closed instead of receiving a fresh retry budget.
 */
export function portalAutoRetryAttemptsRemaining(flow) {
  const attempts = portalAutoRetryCountValue(flow);
  return attempts !== null && attempts < PORTAL_AUTO_RETRY_DELAYS_MS.length;
}

/** Exactly one delayed retry after encrypted evidence proved an ambiguous click stayed at final review. */
export function portalFinalReviewAmbiguousRecoveryPending(flow) {
  return flow?.heldBy?.length === 1 && flow.heldBy[0] === 'portal_ambiguous'
    && flow?.portalFinalReviewAmbiguousRecoveryVersion === PORTAL_FINAL_REVIEW_AMBIGUOUS_RECOVERY_VERSION
    && portalAutoRetryCountValue(flow) === PORTAL_AUTO_RETRY_DELAYS_MS.length
    && Number(flow?.portalAutoRetryAt) > 0;
}

/**
 * A source-version repair may spend one bounded extra attempt after the
 * ordinary two-attempt ladder. Accept the exhausted counter or one legacy
 * count that included the original submit, but only after the exact version
 * is recorded and queued with a due time. The marker remains after dispatch,
 * so a later deployment cannot mint another repair for the application.
 */
export function portalExhaustedRecoveryPending(flow) {
  const attempts = portalAutoRetryCountValue(flow);
  const version = String(flow?.portalExhaustedRecoveryVersion || '');
  return attempts >= PORTAL_AUTO_RETRY_DELAYS_MS.length
    && attempts <= PORTAL_AUTO_RETRY_DELAYS_MS.length + 1
    && /^[a-f0-9]{64}$/.test(version)
    && version === String(flow?.portalRecoveryVersion || '')
    && Number(flow?.portalAutoRetryAt) > 0;
}

export function portalRetryDueAt(flow) {
  const retryAt = Number(flow?.portalAutoRetryAt) || 0;
  const budgetAvailable = isInfrastructureRetryHold(flow)
    || portalAutoRetryAttemptsRemaining(flow) || portalExhaustedRecoveryPending(flow)
    || portalFinalReviewAmbiguousRecoveryPending(flow);
  return flow?.state === 'owner_takeover' && isAutoRetryablePortalHold(flow) && budgetAvailable
    && Number.isFinite(retryAt) && retryAt > 0 ? retryAt : null;
}
