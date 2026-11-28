/**
 * An HTTP `Retry-After` header (delay in seconds, or an HTTP date) as milliseconds from `nowMs`.
 * Returns 0 for a missing or unreadable value, and never more than `maxMs`: a site that asks for days is
 * served by the bounded ladder, not by a wait nobody can see. No I/O.
 */
export const RETRY_AFTER_MAX_MS = 24 * 60 * 60 * 1000;

export function parseRetryAfterMs(value, nowMs = Date.now(), maxMs = RETRY_AFTER_MAX_MS) {
  const text = String(value ?? '').trim();
  if (!text) return 0;
  let ms = 0;
  if (/^\d{1,9}$/.test(text)) ms = Number(text) * 1000;
  else {
    const at = Date.parse(text);
    ms = Number.isFinite(at) ? at - nowMs : 0;
  }
  return Number.isFinite(ms) && ms > 0 ? Math.min(Math.round(ms), maxMs) : 0;
}

/** The header carries a valid `Retry-After` (seconds, possibly 0, or an HTTP date, possibly past), whatever its delay. */
export function hasRetryAfter(value) {
  const text = String(value ?? '').trim();
  return /^\d{1,9}$/.test(text) || (text.length > 0 && Number.isFinite(Date.parse(text)));
}

/**
 * A 429, or a 503 that carries a valid `Retry-After` header (even `0` or a past date: the site still says it is
 * limiting us), is the site limiting us for a while: a transient block. `retryAfter` is the header's presence
 * (boolean) or its raw value.
 */
export function isRateLimitStatus(status, retryAfter = false) {
  const code = Number(status);
  const signal = typeof retryAfter === 'string' ? hasRetryAfter(retryAfter) : Boolean(retryAfter);
  return code === 429 || (code === 503 && signal);
}

/** A retry delay already in milliseconds (from a runner event), bounded the same way; 0 when unusable. */
export function clampRetryAfterMs(value, maxMs = RETRY_AFTER_MAX_MS) {
  const ms = Number(value);
  return Number.isFinite(ms) && ms > 0 ? Math.min(Math.round(ms), maxMs) : 0;
}
