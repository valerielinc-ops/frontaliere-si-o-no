/**
 * Time helpers shared by the Ticino pharmacy importer and the browser.
 * The source publishes local Europe/Zurich date/time pairs, never UTC.
 */

export const PHARMACY_TIME_ZONE = 'Europe/Zurich';

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
 * transitions explicit. Ambiguous/non-existent wall-clock values are rejected
 * instead of silently inventing an instant.
 */
export function localDateTimeToIso(dateText, timeText) {
  const dateMatch = String(dateText || '').match(/^(\d{2})[./](\d{2})[./](\d{4})$/);
  const timeMatch = String(timeText || '').match(/^(\d{2}):(\d{2})$/);
  if (!dateMatch || !timeMatch) throw new Error(`Invalid Zurich local datetime: ${dateText} ${timeText}`);

  const [, day, month, year] = dateMatch;
  const [, hour, minute] = timeMatch;
  const localAsUtc = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute));
  let candidate = localAsUtc;
  for (let i = 0; i < 4; i += 1) {
    candidate = localAsUtc - timeZoneOffsetMs(new Date(candidate));
  }

  const resolved = partsFor(new Date(candidate));
  const expected = {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: Number(hour),
    minute: Number(minute),
    second: 0,
  };
  if (Object.entries(expected).some(([key, value]) => resolved[key] !== value)) {
    throw new Error(`Non-existent or ambiguous Zurich local datetime: ${dateText} ${timeText}`);
  }
  return new Date(candidate).toISOString();
}
