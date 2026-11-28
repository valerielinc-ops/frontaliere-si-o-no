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

/** A 429, or a 503 that says when to come back, is the site limiting us for a while: a transient block. */
export function isRateLimitStatus(status, retryAfterMs = 0) {
  const code = Number(status);
  return code === 429 || (code === 503 && Number(retryAfterMs) > 0);
}

/** A retry delay already in milliseconds (from a runner event), bounded the same way; 0 when unusable. */
export function clampRetryAfterMs(value, maxMs = RETRY_AFTER_MAX_MS) {
  const ms = Number(value);
  return Number.isFinite(ms) && ms > 0 ? Math.min(Math.round(ms), maxMs) : 0;
}
