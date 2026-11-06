/**
 * `<lastmod>` for job-detail sitemap entries.
 *
 * Google reads `<lastmod>` only when it is consistently accurate, so the value
 * must describe the listing, never the pipeline that observed it. The value is
 * the MOST RECENT of the dates that change only when the listing does:
 *
 *  - the employer-reported publication date (`datePosted` / `postedDate`, and
 *    only when `postingDateSource === 'reported'` — an unprovenanced value may
 *    be a crawler-manufactured stand-in, see scripts/lib/job-posting-date.mjs);
 *  - `firstSeenAt`, the first observation of the listing by any crawler.
 *
 * A re-publication by the employer moves the reported date past `firstSeenAt`
 * (measured on 2026-10-23: reported 2026-10-21, first seen 2026-09-30), which
 * is exactly the content change Google should be told about.
 *
 * Deliberately excluded: `crawledAt`/`scrapedAt` (a liveness heartbeat that
 * moves on every crawl of an unchanged listing), `updatedAt` (stamped by the
 * dataset assembler at build time) and the build clock itself. A job without
 * any qualifying date gets NO `<lastmod>` rather than an invented one.
 */
import {
  compareValidatedPostingDates,
  resolveFirstSeenPostingDate,
  resolveReportedPostingDate,
  type PostingDateInput,
} from '../../scripts/lib/job-posting-date.mjs';
import { renderSitemapLastmod } from './sitemapLastmod';

/** Most recent qualifying ISO date string for a job, or null when none exists. */
export function jobSitemapLastmodSource(job: PostingDateInput | null | undefined, now: Date = new Date()): string | null {
  if (!job) return null;
  let latest: string | null = null;
  for (const candidate of [resolveReportedPostingDate(job, now), resolveFirstSeenPostingDate(job, now)]) {
    if (!candidate) continue;
    if (latest === null || compareValidatedPostingDates(candidate, latest) > 0) latest = candidate;
  }
  return latest;
}

/** `YYYY-MM-DD` form of {@link jobSitemapLastmodSource}, or undefined. */
export function jobSitemapLastmodDay(job: PostingDateInput | null | undefined, now: Date = new Date()): string | undefined {
  const tag = renderSitemapLastmod(jobSitemapLastmodSource(job, now));
  const match = /<lastmod>(\d{4}-\d{2}-\d{2})<\/lastmod>/.exec(tag);
  return match ? match[1] : undefined;
}

/** Rendered `<lastmod>` element for a job-detail `<url>` block ('' when none). */
export function renderJobSitemapLastmod(job: PostingDateInput | null | undefined, now: Date = new Date()): string {
  return renderSitemapLastmod(jobSitemapLastmodSource(job, now));
}
