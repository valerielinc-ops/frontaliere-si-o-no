/** Bounded recovery for a dispatch that failed before GitHub received a request. */
export const DISPATCH_RECOVERY_DELAY_MS = 5 * 60 * 1000;
export const DISPATCH_RECOVERY_MAX_ATTEMPTS = 1;
export const REMOTE_CONFIG_FETCH_TIMEOUT_CODE = 'REMOTE_CONFIG_FETCH_TIMEOUT';

const DISPATCH_STATES = new Set(['drafting', 'regenerating', 'submitting']);

export function dispatchRecoveryCountValue(flow) {
  const raw = flow?.dispatchRecoveryCount;
  if (raw === undefined) return 0;
  if (typeof raw === 'number') return Number.isSafeInteger(raw) && raw >= 0 ? raw : null;
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!/^\d+$/.test(text)) return null;
  const attempts = Number(text);
  return Number.isSafeInteger(attempts) ? attempts : null;
}

export function dispatchRecoveryAttemptsRemaining(flow) {
  const attempts = dispatchRecoveryCountValue(flow);
  return attempts !== null && attempts < DISPATCH_RECOVERY_MAX_ATTEMPTS;
}

export function dispatchRecoveryDueAt(flow) {
  const retryAt = Number(flow?.dispatchRecoveryAt) || 0;
  const attempts = dispatchRecoveryCountValue(flow);
  return DISPATCH_STATES.has(flow?.state)
    && attempts !== null && attempts > 0 && attempts <= DISPATCH_RECOVERY_MAX_ATTEMPTS
    && Number.isFinite(retryAt) && retryAt > 0
    ? retryAt
    : null;
}

/** Only a failure before the GitHub POST is safe to retry automatically. */
export function isPreDispatchFailure(error) {
  const code = String(error?.code || error?.errorCode || '').trim();
  if (code === REMOTE_CONFIG_FETCH_TIMEOUT_CODE) return true;
  return String(error?.message || error?.error || '').includes('Remote Config template fetch timed out');
}

export function preDispatchFailureCode(error) {
  // A matching timeout message is authoritative even when a lower layer
  // attaches a transport-specific code. Always return the canonical code so
  // the transaction guard in scheduleDispatchRecovery accepts the recovery.
  return isPreDispatchFailure(error) ? REMOTE_CONFIG_FETCH_TIMEOUT_CODE : null;
}
