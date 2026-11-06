import { sourceDateIso } from '../packages/articles/engine/shared/sourceDates';
export { sourceDateIso } from '../packages/articles/engine/shared/sourceDates';

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
