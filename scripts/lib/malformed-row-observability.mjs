/**
 * Shared severity contract for parsers that keep valid rows while dropping
 * malformed siblings. Every drop is observable; losing at least half of the
 * candidate rows is structural drift and must fail closed (or enter the
 * caller's existing error channel) rather than publish a misleading partial
 * snapshot.
 */
export const MALFORMED_ROW_ERROR_RATIO = 0.5;

export function classifyMalformedRowDrift(
  parsed,
  skipped,
  { errorRatio = MALFORMED_ROW_ERROR_RATIO } = {},
) {
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new TypeError(`parsed must be a non-negative safe integer, got ${parsed}`);
  }
  if (!Number.isSafeInteger(skipped) || skipped < 0) {
    throw new TypeError(`skipped must be a non-negative safe integer, got ${skipped}`);
  }
  if (!(errorRatio > 0 && errorRatio <= 1)) {
    throw new TypeError(`errorRatio must be in (0, 1], got ${errorRatio}`);
  }

  const total = parsed + skipped;
  const ratio = total > 0 ? skipped / total : 0;
  const severity = skipped === 0
    ? 'none'
    : ratio >= errorRatio
      ? 'error'
      : 'warning';

  return { parsed, skipped, total, ratio, severity };
}
