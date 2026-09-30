/**
 * Reasons why a fresh source body must not be treated as an ordinary thin
 * source.  A PDF parser/fetch failure is an operational error: it may keep a
 * previously saved source body, but it must never be classified as
 * `thin-source-quarantine`.
 */
export const SOURCE_BODY_FAILURE_REASON = 'pdf-extraction-failed';

export function hasSourceBodyFailure(job = {}) {
  return job?.sourceBodyFailureReason === SOURCE_BODY_FAILURE_REASON;
}

export function sourceBodyFailureRecord(job = {}) {
  if (!hasSourceBodyFailure(job)) return null;
  return {
    title: String(job?.title || ''),
    url: String(job?.url || ''),
    reason: SOURCE_BODY_FAILURE_REASON,
    message: String(job?.sourceBodyFailureMessage || ''),
  };
}
