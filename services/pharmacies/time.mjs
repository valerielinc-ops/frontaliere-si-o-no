/**
 * Time helpers shared by the Ticino pharmacy importer and the browser.
 * The source publishes local Europe/Zurich date/time pairs, never UTC.
 */

export const PHARMACY_TIME_ZONE = 'Europe/Zurich';

const HOUR_MS = 60 * 60 * 1000;

const PARTS_FORMATTER = new Intl.DateTimeFormat('en-GB', {
  timeZone: PHARMACY_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

function partsFor(date) {
  return Object.fromEntries(
    PARTS_FORMATTER.formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  );
}

function timeZoneOffsetMs(date) {
  const parts = partsFor(date);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - date.getTime();
}

/**
 * Converts a wall-clock value in Europe/Zurich to an ISO instant.
 * Iterating the offset avoids the machine's local timezone and keeps DST
 * transitions explicit. A non-existent spring-forward value is mapped to the
 * next valid instant; malformed calendar values are still rejected.
 */
export function localDateTimeToIso(dateText, timeText) {
  const dateMatch = String(dateText || '').match(/^(\d{2})[./](\d{2})[./](\d{4})$/);
  const timeMatch = String(timeText || '').match(/^(\d{2}):(\d{2})$/);
  if (!dateMatch || !timeMatch) throw new Error(`Invalid Zurich local datetime: ${dateText} ${timeText}`);

  const [, day, month, year] = dateMatch;
  const [, hour, minute] = timeMatch;
  const yearNumber = Number(year);
  const monthNumber = Number(month);
  const dayNumber = Number(day);
  const hourNumber = Number(hour);
  const minuteNumber = Number(minute);
  const calendarProbe = new Date(Date.UTC(yearNumber, monthNumber - 1, dayNumber));
  if (hourNumber > 23 || minuteNumber > 59
    || calendarProbe.getUTCFullYear() !== yearNumber
    || calendarProbe.getUTCMonth() !== monthNumber - 1
    || calendarProbe.getUTCDate() !== dayNumber) {
    throw new Error(`Invalid Zurich local datetime: ${dateText} ${timeText}`);
  }
  const localAsUtc = Date.UTC(yearNumber, monthNumber - 1, dayNumber, hourNumber, minuteNumber);

  const expected = {
    year: yearNumber,
    month: monthNumber,
    day: dayNumber,
    hour: hourNumber,
    minute: minuteNumber,
    second: 0,
  };
  const matchesExpected = (parts) => Object.entries(expected)
    .every(([key, value]) => parts[key] === value);

  // During the autumn transition the same wall-clock value has two valid
  // instants. Do not let the fixed-point iteration silently choose one: the
  // source has no disambiguating offset, so choosing would invent a boundary.
  const offsets = new Set([-48, -24, 0, 24, 48]
    .map((deltaHours) => timeZoneOffsetMs(new Date(localAsUtc + deltaHours * HOUR_MS))));
  const exactCandidates = [...offsets]
    .map((offsetMs) => new Date(localAsUtc - offsetMs))
    .filter((date) => matchesExpected(partsFor(date)));
  if (exactCandidates.length > 1) {
    throw new Error(`Ambiguous Zurich local datetime: ${dateText} ${timeText}`);
  }
  if (exactCandidates.length === 1) return exactCandidates[0].toISOString();

  let candidate = localAsUtc;
  for (let i = 0; i < 4; i += 1) {
    candidate = localAsUtc - timeZoneOffsetMs(new Date(candidate));
  }

  const resolved = partsFor(new Date(candidate));
  if (!matchesExpected(resolved)) {
    const resolvedLocalAsUtc = Date.UTC(
      resolved.year,
      resolved.month - 1,
      resolved.day,
      resolved.hour,
      resolved.minute,
      resolved.second,
    );
    const springGapMs = resolvedLocalAsUtc - localAsUtc;
    if (springGapMs > 0 && springGapMs <= 2 * HOUR_MS) {
      return new Date(candidate).toISOString();
    }
    throw new Error(`Non-existent or ambiguous Zurich local datetime: ${dateText} ${timeText}`);
  }
  return new Date(candidate).toISOString();
}
