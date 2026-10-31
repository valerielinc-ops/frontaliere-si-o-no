/** Pure canonical retention predicates; the purge job re-exports this contract. */
export const ASSISTED_APPLICATION_RETENTION_DAYS = 90;

export function timestampMillis(value) {
  if (value && typeof value.toMillis === 'function') {
    const result = value.toMillis();
    return Number.isFinite(result) ? result : null;
  }
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  return null;
}

export function retentionAnchor(order) {
  if (order?.refundedAt != null) return order.refundedAt;
  if (order?.submissionStatus === 'ready_for_manual_submission' && order.submittedAt != null) {
    return order.submittedAt;
  }
  return order?.cvUploadedAt ?? null;
}

/**
 * The order is kept for the talent pool: the consent is given and the purge has not run. The «inviata»
 * link of such an order lasts while this holds (owner decision 2026-10-05, «Fino a fine consenso»).
 * As of 2026-10-05 no code writes `talentPoolConsent`: the consent, its withdrawal and its duration are
 * not modelled yet (one boolean, no end date). Withdrawn = no longer true; the order then falls back to
 * the retention below.
 */
export function talentPoolConsentActive(order) {
  return order?.talentPoolConsent === true && order.retentionPurgedAt == null;
}

/**
 * When the purge below is due to delete the order's files and data (its anchor plus the retention days),
 * or null when it never is (no anchor, the talent pool). The «inviata» e-mail's link to the candidate's
 * documents lasts until then (owner decision 2026-10-03); for the talent pool, as long as the consent
 * (talentPoolConsentActive, owner decision 2026-10-05).
 * @returns {number|null} epoch ms
 */
export function retentionPurgeDueAt(order, retentionDays = ASSISTED_APPLICATION_RETENTION_DAYS) {
  if (order?.talentPoolConsent === true) return null;
  const anchorMillis = timestampMillis(retentionAnchor(order));
  return anchorMillis === null ? null : anchorMillis + retentionDays * 86400000;
}


export function assistedApplicationRetained(order, nowMs = Date.now()) {
  const dueAt = retentionPurgeDueAt(order);
  return Number.isFinite(nowMs) && order?.retentionPurgedAt == null && order?.retentionPurgingAt == null
    && order?.retentionPayloadPurgedAt == null
    && (talentPoolConsentActive(order) || (Number.isFinite(dueAt) && dueAt > nowMs));
}
