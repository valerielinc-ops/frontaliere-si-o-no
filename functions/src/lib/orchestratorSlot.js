/**
 * Normalizes the Cloud Scheduler timestamp to the nominal UTC minute owned by
 * the orchestrator claim and run marker.
 */
export function normalizeOrchestratorSlot(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError('scheduledAt must be a valid date');
  date.setUTCSeconds(0, 0);
  return date;
}
