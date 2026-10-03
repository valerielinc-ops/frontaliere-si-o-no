import { resolveReportedPostingDate } from '../../shared/jobPostingDate.mjs';

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
