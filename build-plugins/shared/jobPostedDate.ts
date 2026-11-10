/**
 * Absolute, build-clock-independent publication date for static job HTML.
 *
 * The static job-detail page and the SSG job cards used to print a RELATIVE
 * age ("Pubblicato 10 giorni fa", "vor 3 Tagen"). That text has two defects:
 * it becomes false the day after the build — and crawlers read it exactly as
 * emitted — and it rewrites the bytes of every job page at every daily build,
 * which inflates the per-section shard pushes. The value is now derived only
 * from the posting date itself: same input, same bytes, whatever the clock.
 *
 * The hydrated SPA keeps its own relative label (`daysSincePosted` in
 * components/community/JobBoard.tsx): index.tsx mounts with createRoot() and
 * crossfades over the static markup, so the two texts never have to match.
 */
import { formatUpdatedDate, type LandingLocale } from './humanDate';
import { escHtml } from './htmlEscape';

/**
 * Calendar day (YYYY-MM-DD) named by a posting date string. An ISO string
 * keeps its own date part — the same day the "Pubblicata il" detail row and
 * the JSON-LD already show — so the result never depends on the build host's
 * time zone. Other parseable strings fall back to their UTC day.
 */
export function postingCalendarDay(dateStr: string | null | undefined): string | null {
  const raw = String(dateStr ?? '').trim();
  if (!raw) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(raw);
  if (iso) {
    const day = `${iso[1]}-${iso[2]}-${iso[3]}`;
    const check = new Date(`${day}T00:00:00.000Z`);
    if (Number.isNaN(check.getTime()) || check.toISOString().slice(0, 10) !== day) return null;
    return day;
  }
  const time = Date.parse(raw);
  return Number.isFinite(time) ? new Date(time).toISOString().slice(0, 10) : null;
}

/** Long localized date only, e.g. "29 ottobre 2026" / "29. Oktober 2026". */
export function formatPostingDay(day: string, locale: LandingLocale): string {
  return formatUpdatedDate(day, locale);
}

/**
 * Full sentence, e.g. "Pubblicato il 29 ottobre 2026", "Published on
 * 29 October 2026", "Veröffentlicht am 29. Oktober 2026", "Publié le
 * 29 octobre 2026". Italian elides the article before l'1, l'8, l'11.
 */
export function formatPostedOnSentence(day: string, locale: LandingLocale): string {
  const date = formatPostingDay(day, locale);
  switch (locale) {
    case 'it':
      return `Pubblicato ${[1, 8, 11].includes(Number(day.slice(8, 10))) ? "l'" : 'il '}${date}`;
    case 'en':
      return `Published on ${date}`;
    case 'de':
      return `Veröffentlicht am ${date}`;
    case 'fr':
      return `Publié le ${date}`;
  }
}

/**
 * `<time datetime="YYYY-MM-DD">…</time>` for a posting date, or '' when the
 * date is missing or unparseable. `sentence` selects the full "Pubblicato il
 * …" wording (cards, where no label precedes it) over the bare date (the
 * mobile tile, whose `<dt>` already says "Pubblicato").
 */
export function renderPostedDateTime(
  dateStr: string | null | undefined,
  locale: LandingLocale,
  { sentence }: { sentence: boolean },
): string {
  const day = postingCalendarDay(dateStr);
  if (!day) return '';
  const text = sentence ? formatPostedOnSentence(day, locale) : formatPostingDay(day, locale);
  return `<time datetime="${day}">${escHtml(text)}</time>`;
}
