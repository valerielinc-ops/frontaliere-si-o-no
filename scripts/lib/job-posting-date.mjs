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
 * Earliest collection timestamp of the record itself (crawler observations).
 * It is weaker evidence than firstSeenAt: a crawler heartbeat says the listing
 * was open at that instant, so it is an honest upper bound of the publication
 * date, never a claim about the employer's own date.
 */
export function resolveObservedPostingDate(input, now = new Date()) {
  let earliest = null;
  for (const value of [input?.crawledAt, input?.scrapedAt, input?.updatedAt]) {
    const resolved = resolveValidatedPostingDate(value, now);
    if (resolved && (!earliest || compareValidatedPostingDates(resolved, earliest) < 0)) earliest = resolved;
  }
  return earliest;
}

/**
 * Resolve the mandatory JobPosting.datePosted at the JSON-LD boundary.
 *
 * Owner decision (2026-10-24): an active job ALWAYS emits JobPosting, so this
 * resolver never returns null. The chain is ordered by strength of evidence
 * and the provenance travels with the value:
 *   1. `reported`    — the employer/source publication date (validated);
 *   2. `first-seen`  — when the listing first appeared in our inventory;
 *   3. `observed`    — the record's earliest crawler observation;
 *   4. `build-clock` — the build date, only for a record with no usable
 *                      timestamp at all (the job is in the active inventory
 *                      that this build publishes, so it is open today).
 * Visible recency UI and alerts keep using resolveReportedPostingDate() /
 * firstSeenAt directly: this value feeds only structured data.
 */
export function resolveSchemaPostingDate(input, now = new Date()) {
  const clock = Number.isFinite(now?.getTime()) ? now : new Date();
  const reported = resolveReportedPostingDate(input, clock);
  if (reported) return { value: reported, provenance: 'reported' };
  const firstSeen = resolveFirstSeenPostingDate(input, clock);
  if (firstSeen) return { value: firstSeen, provenance: 'first-seen' };
  const observed = resolveObservedPostingDate(input, clock);
  if (observed) return { value: observed, provenance: 'observed' };
  return { value: clock.toISOString().slice(0, 10), provenance: 'build-clock' };
}
