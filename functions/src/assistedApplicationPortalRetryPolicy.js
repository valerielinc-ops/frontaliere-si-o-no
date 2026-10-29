/** Shared by the state machine, scheduler and owner queue. No I/O. */
export function isAutoRetryablePortalHold(flow) {
  return (flow?.heldBy || []).some(reason => ['portal:portal_needs_candidate', 'portal:captcha_provider_unavailable'].includes(reason));
}

export function portalRetryDueAt(flow) {
  const retryAt = Number(flow?.portalAutoRetryAt) || 0;
  return flow?.state === 'owner_takeover' && isAutoRetryablePortalHold(flow) && Number.isFinite(retryAt) && retryAt > 0 ? retryAt : null;
}
