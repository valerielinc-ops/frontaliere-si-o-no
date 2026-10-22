// Deployment-local copy of scripts/lib/job-posting-date.mjs; parity is enforced by tests.
/** Compare validated ISO publication dates with up to six fractional digits; only the sign is meaningful. */
export function compareValidatedPostingDates(first, second) {
  const milliseconds = Date.parse(first) - Date.parse(second);
  if (milliseconds !== 0) return milliseconds;
  const microsecondRemainder = (value) => {
    const fraction = /\.(\d{1,6})(?:Z|[+-]\d{2}:\d{2})$/.exec(value)?.[1] || '';
    return Number(fraction.padEnd(6, '0').slice(3));
  };
  return microsecondRemainder(first) - microsecondRemainder(second);
}

/** Validate an ISO date while preserving the original string and precision. */
function resolveValidatedPostingDate(value, now) {
  if (typeof value !== 'string' || !Number.isFinite(now?.getTime())) return null;
  const raw = value.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2}))?$/.exec(raw);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const calendar = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00.000Z`);
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() + 1 !== month || calendar.getUTCDate() !== day) return null;
  const time = /T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(raw);
  if (time && (Number(time[1]) > 23 || Number(time[2]) > 59 || Number(time[3] || 0) > 59)) return null;
  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp) || compareValidatedPostingDates(raw, now.toISOString()) > 0) return null;
  return raw;
}

/** Employer publication date only. Preserve the original string, including microseconds and offset. */
export function resolveReportedPostingDate(input, now = new Date()) {
  if (input?.postingDateSource !== 'reported') return null;
  for (const value of [input.datePosted, input.postedDate]) {
    const resolved = resolveValidatedPostingDate(value, now);
    if (resolved) return resolved;
  }
  return null;
}

/** First observation timestamp, used only as an explicit synthetic fallback. */
export function resolveFirstSeenPostingDate(input, now = new Date()) {
  return resolveValidatedPostingDate(input?.firstSeenAt, now);
}

/**
 * Stable sentinel used only for the mandatory JobPosting.datePosted field.
 *
 * It is deliberately independent from crawl and build clocks. Consumers must
 * keep the returned provenance alongside the value, especially when a
 * first-seen fallback is used for an unknown employer publication date.
 */
export const JOB_POSTING_DATE_SAFE_DEFAULT = '1970-01-01';

/**
 * Resolve a value emitted at the JSON-LD boundary without changing source
 * provenance. Callers must explicitly opt into the safe default only after
 * checking the exact URL scope that permits it. Visible recency UI must
 * continue to use resolveReportedPostingDate().
 */
export function resolveSchemaPostingDate(input, now = new Date(), allowSafeDefault = false) {
  const reported = resolveReportedPostingDate(input, now);
  if (reported) return { value: reported, provenance: 'reported' };
  return allowSafeDefault
    ? { value: JOB_POSTING_DATE_SAFE_DEFAULT, provenance: 'safe-default' }
    : null;
}
