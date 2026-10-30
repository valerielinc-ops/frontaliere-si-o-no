/** Shared by the state machine, scheduler and owner queue. No I/O. */
export const PORTAL_AUTO_RETRY_DELAYS_MS = Object.freeze([6 * 60 * 60 * 1000, 24 * 60 * 60 * 1000]);
export const TRANSPORT_AUTO_RETRY_DELAYS_MS = Object.freeze([5 * 60 * 1000, 30 * 60 * 1000, 2 * 60 * 60 * 1000]);
const TRANSPORT_HOLDS = new Set(['portal:navigation_unavailable', 'transport:email_provider_unavailable', 'portal:captcha_provider_unavailable']);

export function isInfrastructureRetryHold(flow) {
  return (flow?.heldBy || []).some(reason => TRANSPORT_HOLDS.has(reason));
}

export function autoRetryDelaysForFlow(flow) {
  return isInfrastructureRetryHold(flow)
    ? TRANSPORT_AUTO_RETRY_DELAYS_MS : PORTAL_AUTO_RETRY_DELAYS_MS;
}

export function isAutoRetryablePortalHold(flow) {
  return (flow?.heldBy || []).some(reason => TRANSPORT_HOLDS.has(reason)
    || reason === 'portal:portal_needs_candidate');
}

export function portalRetryDueAt(flow) {
  const retryAt = Number(flow?.portalAutoRetryAt) || 0;
  return flow?.state === 'owner_takeover' && isAutoRetryablePortalHold(flow) && Number.isFinite(retryAt) && retryAt > 0 ? retryAt : null;
}
