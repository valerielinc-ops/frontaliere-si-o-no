/**
 * Publication guard for assembled event dates.
 *
 * This is intentionally local to the site's dataset assembler: the corpus
 * consumes the published JSON and has no assembler of its own. Keeping the
 * guard here gives the crawler pipeline and its CI test one source of truth
 * without widening the adapted events-utils mirror.
 */

const ISO_EVENT_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Keep source errors such as year 2926 out of the published event surface. */
export const MAX_EVENT_FUTURE_DAYS = 3660;

/** Return true only for a real, date-only ISO calendar day. */
export function isValidEventIsoDate(value) {
  const match = ISO_EVENT_DATE_RE.exec(String(value ?? '').trim());
  if (!match) return false;
  const date = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === `${match[1]}-${match[2]}-${match[3]}`;
}

/**
 * Explain why an event cannot be published. The future horizon is deliberately
 * generous for annual events, while still rejecting crawler corruption such as
 * `2926-01-22` before it becomes an indexable URL.
 */
export function eventDateIssues(event, now = new Date()) {
  const issues = [];
  const startDate = String(event?.startDate ?? '').trim();
  const endDate = String(event?.endDate ?? '').trim();
  const startValid = isValidEventIsoDate(startDate);
  const endValid = !endDate || isValidEventIsoDate(endDate);

  if (!startValid) issues.push('invalid_start_date');
  if (endDate && !endValid) issues.push('invalid_end_date');
  if (startValid && endDate && endValid && endDate < startDate) issues.push('end_before_start');

  const horizon = new Date(now);
  if (!Number.isFinite(horizon.getTime())) return issues;
  horizon.setUTCDate(horizon.getUTCDate() + MAX_EVENT_FUTURE_DAYS);
  const latestAllowed = horizon.toISOString().slice(0, 10);
  if (startValid && startDate > latestAllowed) issues.push('start_date_too_far_future');
  if (endDate && endValid && endDate > latestAllowed) issues.push('end_date_too_far_future');
  return issues;
}
