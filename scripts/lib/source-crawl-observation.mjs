/**
 * Convert only an explicit Date captured after a successful source response
 * into crawl provenance. Do not parse strings here: publication dates and
 * other nearby fields are not evidence of when a crawl observed a vacancy.
 */
export function crawledAtFromObservation(observedAt) {
  if (!(observedAt instanceof Date) || !Number.isFinite(observedAt.getTime())) return null;
  return observedAt.toISOString();
}

/** Accept only the canonical ISO timestamp emitted by crawledAtFromObservation. */
export function isCrawlObservationTimestamp(value) {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}
