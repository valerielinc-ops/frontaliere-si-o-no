import { resolveReportedPostingDate } from './job-posting-date.mjs';

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Normalize only dates actually supplied by an employer; never use crawl time. */
export function sourcePostingDateFields(raw, now = new Date()) {
  let value = typeof raw === 'string' ? raw.trim() : '';
  const human = /^(\d{1,2}) ([A-Za-z]{3}|Sept) (\d{4})$/.exec(value);
  if (human) {
    const month = MONTHS.indexOf(human[2].toLowerCase().slice(0, 3)) + 1;
    value = month ? `${human[3]}-${String(month).padStart(2, '0')}-${human[1].padStart(2, '0')}` : '';
  }
  const date = resolveReportedPostingDate({ postingDateSource: 'reported', datePosted: value }, now);
  return date
    ? { datePosted: date, postedDate: date, postingDateSource: 'reported' }
    : { datePosted: '', postedDate: '', postingDateSource: 'unknown' };
}

/** Select the first valid source publication value, not merely the first non-empty one. */
export function sourcePostingDateCandidatesFields(candidates = [], now = new Date()) {
  for (const candidate of candidates) {
    const fields = sourcePostingDateFields(candidate, now);
    if (fields.postingDateSource === 'reported') return fields;
  }
  return sourcePostingDateFields('', now);
}

/** Dates and their evidence travel together; an unmarked legacy value is not proof. */
export function mergeSourcePostingDates(previous = {}, fresh = {}, now = new Date()) {
  const before = resolveReportedPostingDate(previous, now);
  const after = resolveReportedPostingDate(fresh, now);
  const date = before && after ? (Date.parse(before) < Date.parse(after) ? before : after) : before || after;
  return date
    ? { datePosted: date, postedDate: date, postingDateSource: 'reported' }
    : { datePosted: '', postedDate: '', postingDateSource: 'unknown' };
}

export function hasPostingDateProvenance(job) {
  return job?.postingDateSource === 'reported' || job?.postingDateSource === 'unknown';
}

/** Normalize an explicit RSS publication date without losing its timezone. */
export function sourceRssPostingDateFields(raw = '', now = new Date()) {
  const value = String(raw || '').trim();
  const rss = value.match(/^(?:[A-Za-z]{3},\s*)?(\d{1,2}) ([A-Za-z]{3}) (\d{4}) (\d{2}:\d{2}:\d{2}) (GMT|UTC|UT|Z|[+-]\d{4})$/);
  if (!rss) return sourcePostingDateFields(value, now);
  // Validate the calendar independently; apply the real-clock cutoff only after the offset.
  const calendarReference = new Date(`${rss[3]}-12-31T23:59:59Z`);
  const day = sourcePostingDateFields(`${rss[1]} ${rss[2]} ${rss[3]}`, calendarReference).postedDate;
  const zone = /^[+-]/.test(rss[5]) ? `${rss[5].slice(0, 3)}:${rss[5].slice(3)}` : 'Z';
  return sourcePostingDateFields(day ? `${day}T${rss[4]}${zone}` : '', now);
}
