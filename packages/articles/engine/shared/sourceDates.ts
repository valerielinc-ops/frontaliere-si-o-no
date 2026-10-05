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

/** Preserve a documented calendar date or normalize its complete timestamp. */
export function articleSourceDate(value?: string | null, now = new Date()): string | undefined {
  if (!value || !/^\d{4}-\d{2}-\d{2}(?:T.+)?$/.test(value)) return undefined;
  const iso = sourceDateIso(value, now);
  if (!iso) return undefined;
  return value.length === 10 ? value : iso;
}

/**
 * `date: ''` in the article registry is the corpus stating that the
 * publication date is UNKNOWN (corpus PR 2082): an editorial decision not to
 * invent one. It is distinct from a malformed date, which stays an error.
 */
export function isUnknownArticleDate(value: unknown): boolean {
  return value === '';
}
