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

/** Employer publication date only. Preserve the original string, including microseconds and offset. */
export function resolveReportedPostingDate(input, now = new Date()) {
  if (input?.postingDateSource !== 'reported' || !Number.isFinite(now.getTime())) return null;
  for (const value of [input.datePosted, input.postedDate]) {
    if (typeof value !== 'string') continue;
    const raw = value.trim();
    const match = /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2}))?$/.exec(raw);
    if (!match) continue;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const calendar = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00.000Z`);
    if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() + 1 !== month || calendar.getUTCDate() !== day) continue;
    const time = /T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(raw);
    if (time && (Number(time[1]) > 23 || Number(time[2]) > 59 || Number(time[3] || 0) > 59)) continue;
    const timestamp = Date.parse(raw);
    if (!Number.isFinite(timestamp) || compareValidatedPostingDates(raw, now.toISOString()) > 0) continue;
    return raw;
  }
  return null;
}
