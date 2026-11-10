/**
 * Data-dated hero kicker for the static listing pages of a job section.
 *
 * Those pages used to open with "Pagina generata · <build day>"
 * (`formatPageGenerationDate`). The label was honest — PR 11273 had renamed
 * a false "Aggiornato" — but its value was the build clock: it rewrote the
 * bytes of every city, sector and editorial listing page at every daily build
 * even when not one offer had changed, and the per-section shard push paid
 * for each of them (the zurigo push ran into its 3600 s timeout).
 *
 * The kicker now states a fact of the DATA the page lists: the calendar day
 * of its most recent employer-reported publication date, e.g. "Offerta più
 * recente pubblicata il 6 novembre 2026". It changes only when a newer offer
 * joins the list — and then the list itself changes anyway — so it adds no
 * bytes of its own between builds. Only source-reported dates count
 * (`resolveReportedPostingDate`, the same source the sector "Nuove · 7gg"
 * tile trusts): a crawler observation or a first-seen fallback is not a
 * publication date. A page with no such date prints no kicker at all, never
 * a substitute date.
 */
import { resolveReportedPostingDate } from '../../scripts/lib/job-posting-date.mjs';
import type { LandingLocale } from './humanDate';
import { escHtml } from './htmlEscape';
import { formatPostingDay, postingCalendarDay } from './jobPostedDate';

/** Most recent calendar day (YYYY-MM-DD) among the jobs' reported publication dates, or null. */
export function latestReportedPostingDay(jobs: Iterable<unknown>): string | null {
  let latest: string | null = null;
  for (const job of jobs) {
    const day = postingCalendarDay(resolveReportedPostingDate(job as Parameters<typeof resolveReportedPostingDate>[0]));
    if (day && (latest === null || day > latest)) latest = day;
  }
  return latest;
}

/**
 * "Offerta più recente pubblicata il 6 novembre 2026" / "Most recent offer
 * published on 6 November 2026" / "Neuestes Angebot veröffentlicht am
 * 6. November 2026" / "Offre la plus récente publiée le 6 novembre 2026".
 * Italian elides the article before l'1, l'8, l'11.
 */
export function formatLatestPostingSentence(day: string, locale: LandingLocale): string {
  const date = formatPostingDay(day, locale);
  switch (locale) {
    case 'it':
      return `Offerta più recente pubblicata ${[1, 8, 11].includes(Number(day.slice(8, 10))) ? "l'" : 'il '}${date}`;
    case 'en':
      return `Most recent offer published on ${date}`;
    case 'de':
      return `Neuestes Angebot veröffentlicht am ${date}`;
    case 'fr':
      return `Offre la plus récente publiée le ${date}`;
  }
}

/** `<time datetime="YYYY-MM-DD">…</time>` for the most recent reported publication, or ''. */
export function renderLatestPostingTime(jobs: Iterable<unknown>, locale: LandingLocale): string {
  const day = latestReportedPostingDay(jobs);
  if (!day) return '';
  return `<time datetime="${day}">${escHtml(formatLatestPostingSentence(day, locale))}</time>`;
}

/**
 * The whole kicker paragraph (`<p ${attrs}>…</p>`), or '' when no listed job
 * has a reported publication date — an empty kicker is omitted, not padded.
 */
export function renderLatestPostingKicker(jobs: Iterable<unknown>, locale: LandingLocale, attrs: string): string {
  const time = renderLatestPostingTime(jobs, locale);
  return time ? `<p ${attrs}>${time}</p>` : '';
}
