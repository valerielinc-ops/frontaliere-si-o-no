/** Normalize a source date without manufacturing a date for missing or invalid data. */
export function sourceDateIso(value?: string | null, now = new Date()): string | undefined {
  if (!value || !/^\d{4}-\d{2}(?:-\d{2}(?:T.*)?)?$/.test(value)) return undefined;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.getTime() > now.getTime()) return undefined;
  // Date.parse silently rolls impossible dates (e.g. February 30) into March.
  const calendarPart = value.slice(0, 10);
  const calendar = new Date(calendarPart);
  if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, calendarPart.length) !== calendarPart) return undefined;
  return date.toISOString();
}

export function formatSourceDate(value: string | null | undefined, locale: string, now = new Date()): string | undefined {
  const iso = sourceDateIso(value, now);
  if (!iso) return undefined;
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric', month: 'long',
    ...(value!.length > 7 ? { day: 'numeric' as const } : {}),
    ...(value!.includes('T') ? { hour: '2-digit' as const, minute: '2-digit' as const, timeZoneName: 'short' as const } : {}),
    timeZone: value!.includes('T') ? 'Europe/Zurich' : 'UTC',
  }).format(new Date(iso));
}

export const BORDER_READING_MAX_AGE_MS = 2 * 60 * 60 * 1000;

export function borderReadingState(value?: string | null, now = new Date()): 'live' | 'stale' | 'unavailable' {
  const iso = sourceDateIso(value, now);
  if (!iso) return 'unavailable';
  return now.getTime() - Date.parse(iso) > BORDER_READING_MAX_AGE_MS ? 'stale' : 'live';
}
