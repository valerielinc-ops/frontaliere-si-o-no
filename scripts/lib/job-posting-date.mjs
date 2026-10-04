/** Employer publication date only; crawl/collection clocks never establish publication. */
export function resolveReportedPostingDate(input, now = new Date()) {
  if (input?.postingDateSource !== 'reported' || !Number.isFinite(now.getTime())) return null;
  for (const value of [input.datePosted, input.postedDate]) {
    if (typeof value !== 'string') continue;
    const raw = value.trim();
    const match = /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/.exec(raw);
    if (!match) continue;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const calendar = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00.000Z`);
    if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() + 1 !== month || calendar.getUTCDate() !== day) continue;
    const time = /T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(raw);
    if (time && (Number(time[1]) > 23 || Number(time[2]) > 59 || Number(time[3] || 0) > 59)) continue;
    const timestamp = Date.parse(raw);
    if (!Number.isFinite(timestamp) || timestamp > now.getTime()) continue;
    return raw;
  }
  return null;
}

/**
 * Resolve the date used by required JobPosting JSON-LD fields.
 *
 * A source date marked `unknown` is not employer evidence and must remain
 * unknown to freshness/provenance logic. Structured data still requires a
 * non-empty, valid `datePosted`, so use the first stable collection clock
 * (or the supplied build clock) only at this emission boundary.
 */
export function resolveSchemaPostingDate(input, now = new Date()) {
  const reported = resolveReportedPostingDate(input, now);
  if (reported) return reported;
  if (input?.postingDateSource !== 'unknown' || !Number.isFinite(now.getTime())) return null;

  const nowMs = now.getTime();
  for (const value of [input?.firstSeenAt, input?.crawledAt, input?.scrapedAt]) {
    if (typeof value !== 'string' || !value.trim()) continue;
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp) || timestamp > nowMs) continue;
    return new Date(timestamp).toISOString();
  }

  return now.toISOString();
}
