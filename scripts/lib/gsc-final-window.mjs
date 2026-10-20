import { utcDaysBefore } from './analytics-settled-window.mjs';

const DAY_MS = 86_400_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const GSC_FINAL_WINDOW_DAYS = 7;
export const GSC_FINAL_WINDOW_LOOKBACK_DAYS = 21;

function validDate(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * Google APIs serialize protobuf JSON fields in lower camelCase. Accept the
 * documented snake_case spelling too, but fail closed if a response includes
 * conflicting copies or a malformed value.
 */
export function normalizeGscFirstIncompleteDate(metadata) {
  const values = ['firstIncompleteDate', 'first_incomplete_date']
    .filter((key) => metadata && Object.hasOwn(metadata, key))
    .map((key) => metadata[key])
    .filter((value) => value !== null && value !== undefined && value !== '');
  if (!values.length) return { firstIncompleteDate: null, error: null };
  if (values.some((value) => typeof value !== 'string')) {
    return { firstIncompleteDate: null, error: 'GSC returned a malformed metadata.firstIncompleteDate' };
  }
  if (new Set(values).size > 1) {
    return { firstIncompleteDate: null, error: 'GSC returned conflicting metadata.firstIncompleteDate values' };
  }
  return { firstIncompleteDate: values[0], error: null };
}

/** GSC Search Analytics dates use the property's Pacific calendar. */
export function gscCalendarDay(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** Shift an ISO calendar date without reading the runner's local timezone. */
export function shiftGscDay(day, delta) {
  if (!validDate(day) || !Number.isInteger(delta)) throw new Error('Expected a valid YYYY-MM-DD date and integer delta');
  const shifted = utcDaysBefore(new Date(`${day}T12:00:00.000Z`), -delta);
  return shifted.toISOString().slice(0, 10);
}

export function gscWindowDates(window) {
  if (!window || !validDate(window.start) || !validDate(window.end) || window.start > window.end) return [];
  const days = Math.round((Date.parse(`${window.end}T00:00:00Z`) - Date.parse(`${window.start}T00:00:00Z`)) / DAY_MS) + 1;
  return Array.from({ length: days }, (_, index) => shiftGscDay(window.start, index));
}

/**
 * Validate that every date in an explicit window is returned by the final
 * date dimension and precedes Search Console's first incomplete date from the
 * all/date metadata probe. Missing date rows are unknown, never zero traffic.
 */
export function assessGscFinalWindow(window, { availableDates = [], firstIncompleteDate = null, metadataError = null } = {}) {
  const expectedDates = gscWindowDates(window);
  const available = new Set(availableDates.filter(validDate));
  const missingDates = expectedDates.filter((date) => !available.has(date));
  const metadataPresent = firstIncompleteDate !== null && firstIncompleteDate !== undefined && firstIncompleteDate !== '';
  const metadataValid = !metadataPresent || validDate(firstIncompleteDate);
  // Search Analytics only returns firstIncompleteDate when the requested
  // all/date range includes unfinished data. Final-date rows remain the
  // authoritative coverage evidence; absent metadata alone proves nothing.
  const metadataComplete = !metadataPresent || firstIncompleteDate > window?.end;
  let reason = null;
  if (!expectedDates.length) reason = 'invalid GSC date window';
  else if (metadataError) reason = metadataError;
  else if (!metadataValid) reason = 'GSC returned an invalid metadata.first_incomplete_date';
  else if (!metadataComplete) reason = `window end ${window.end} is not before first incomplete date ${firstIncompleteDate}`;
  else if (missingDates.length) reason = `GSC date dimension omitted ${missingDates.length} date(s): ${missingDates.join(', ')}`;
  return {
    window: window && { start: window.start, end: window.end },
    status: reason ? 'unmeasurable' : 'measurable',
    complete: !reason,
    firstIncompleteDate: metadataPresent && metadataValid ? firstIncompleteDate : null,
    expectedDates,
    availableDates: expectedDates.filter((date) => available.has(date)),
    missingDates,
    reason,
    probe: 'site dates, dataState=final; metadata from a separate dataState=all probe; missing dates are unknown, not zero',
  };
}

/**
 * Select the latest consecutive seven-day window that is both before GSC's
 * first incomplete date and fully represented by date-dimension rows.
 */
export function selectLatestGscFinalWindow({
  today,
  days = GSC_FINAL_WINDOW_DAYS,
  lookbackDays = GSC_FINAL_WINDOW_LOOKBACK_DAYS,
  availableDates = [],
  firstIncompleteDate = null,
  metadataError = null,
}) {
  if (!validDate(today)) return { status: 'unmeasurable', complete: false, reason: 'invalid GSC probe end date', window: null };
  if (!Number.isInteger(days) || days < 1 || !Number.isInteger(lookbackDays) || lookbackDays < days) {
    return { status: 'unmeasurable', complete: false, reason: 'invalid final-window lookback configuration', window: null };
  }
  if (metadataError) {
    return { status: 'unmeasurable', complete: false, reason: metadataError, window: null, firstIncompleteDate: null };
  }
  const metadataPresent = firstIncompleteDate !== null && firstIncompleteDate !== undefined && firstIncompleteDate !== '';
  if (metadataPresent && !validDate(firstIncompleteDate)) {
    return { status: 'unmeasurable', complete: false, reason: 'GSC returned an invalid metadata.first_incomplete_date', window: null, firstIncompleteDate: null };
  }
  const lookbackStart = shiftGscDay(today, -(lookbackDays - 1));
  const lastFinalDate = metadataPresent ? shiftGscDay(firstIncompleteDate, -1) : today;
  const finalThrough = lastFinalDate > today ? today : lastFinalDate;
  const finalDates = [...new Set(availableDates.filter((date) => validDate(date) && date >= lookbackStart && date <= finalThrough))].sort();
  const end = finalDates[finalDates.length - 1];
  if (!end) {
    return {
      status: 'unmeasurable',
      complete: false,
      reason: 'GSC date probe returned no available final dates in its lookback',
      window: null,
      firstIncompleteDate: metadataPresent ? firstIncompleteDate : null,
      lookback: { start: lookbackStart, end: today },
    };
  }
  const start = shiftGscDay(end, -(days - 1));
  if (start < lookbackStart) {
    return { status: 'unmeasurable', complete: false, reason: `fewer than ${days} final dates found in ${lookbackDays}-day probe`, window: null, firstIncompleteDate: metadataPresent ? firstIncompleteDate : null, lookback: { start: lookbackStart, end: today } };
  }
  const window = { start, end };
  const current = {
    ...assessGscFinalWindow(window, { availableDates, firstIncompleteDate, metadataError }),
    lookback: { start: lookbackStart, end: today },
  };
  const previousWindow = { start: shiftGscDay(start, -days), end: shiftGscDay(start, -1) };
  const previous = assessGscFinalWindow(previousWindow, { availableDates, firstIncompleteDate });
  return { ...current, previousWindow, previous };
}
