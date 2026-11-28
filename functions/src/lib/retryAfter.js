/**
 * An HTTP `Retry-After` header (delay in seconds, or an HTTP date) as milliseconds from `nowMs`.
 * Returns 0 for a missing or unreadable value, and never more than `maxMs`: a site that asks for days is
 * served by the bounded ladder, not by a wait nobody can see. No I/O.
 */
export const RETRY_AFTER_MAX_MS = 24 * 60 * 60 * 1000;

const DAY = '(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)';
const LONG_DAY = '(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)';
const MONTH = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)';
const TIME = '(?:[01]\\d|2[0-3]):[0-5]\\d:(?:[0-5]\\d|60)';
// RFC 9110 HTTP-date: IMF-fixdate (`Sun, 06 Nov 1994 08:49:37 GMT`) and the two obsolete forms servers still send.
const HTTP_DATE_RES = [
  new RegExp(`^${DAY}, \\d{2} ${MONTH} \\d{4} ${TIME} GMT$`),
  new RegExp(`^${LONG_DAY}, \\d{2}-${MONTH}-\\d{2} ${TIME} GMT$`),
  new RegExp(`^${DAY} ${MONTH} [ \\d]\\d ${TIME} \\d{4}$`),
];

/**
 * The one grammar of `Retry-After` (RFC 9110 10.2.3) every consumer shares: delay-seconds (`^\d+$`, `0` included)
 * or an HTTP-date. Anything else (an ISO date, free text) is not a `Retry-After`. `at` is the instant it names
 * for a date, `null` for seconds.
 */
export function parseRetryAfter(value) {
  const text = String(value ?? '').trim();
  if (/^\d+$/.test(text)) return { valid: true, seconds: Number(text), at: null };
  if (HTTP_DATE_RES.some((re) => re.test(text))) {
    const at = Date.parse(/ GMT$/.test(text) ? text : `${text} GMT`);
    if (Number.isFinite(at)) return { valid: true, seconds: null, at };
  }
  return { valid: false, seconds: null, at: null };
}

export function parseRetryAfterMs(value, nowMs = Date.now(), maxMs = RETRY_AFTER_MAX_MS) {
  const parsed = parseRetryAfter(value);
  if (!parsed.valid) return 0;
  const ms = parsed.at === null ? parsed.seconds * 1000 : parsed.at - nowMs;
  return Number.isFinite(ms) && ms > 0 ? Math.min(Math.round(ms), maxMs) : 0;
}

/** The header carries a valid `Retry-After` (see `parseRetryAfter`), whatever its delay: `0` or a past date count. */
export function hasRetryAfter(value) {
  return parseRetryAfter(value).valid;
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
