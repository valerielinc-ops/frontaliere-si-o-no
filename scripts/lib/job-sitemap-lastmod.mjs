/**
 * Day a job-detail URL was last substantively changed, as a sitemap
 * `<lastmod>` states it. Single source of truth for two consumers:
 *
 *   - build-plugins/shared/jobSitemapLastmod.ts, which renders the job sitemap
 *     `<lastmod>` during the build;
 *   - scripts/lib/indexing-jobs-dataset.mjs, which derives the same day for the
 *     job URLs the Indexing API submitter reads from the published dataset
 *     instead of the sitemaps. Both must agree on the day of a URL that is in
 *     both sources, or the planner would classify it `updated` on a date
 *     Google was never told about.
 *
 * The value is the MOST RECENT of the dates that change only when the listing
 * does: the employer-reported publication date (`datePosted`/`postedDate`,
 * only with `postingDateSource === 'reported'` — see job-posting-date.mjs) and
 * `firstSeenAt`. Crawl heartbeats, assembler stamps and the build clock are
 * excluded; a job with no qualifying date has no lastmod.
 */
import {
  compareValidatedPostingDates,
  resolveFirstSeenPostingDate,
  resolveReportedPostingDate,
} from './job-posting-date.mjs';

/** Most recent qualifying ISO date string for a job, or null when none exists. */
export function jobSitemapLastmodSource(job, now = new Date()) {
  if (!job) return null;
  let latest = null;
  for (const candidate of [resolveReportedPostingDate(job, now), resolveFirstSeenPostingDate(job, now)]) {
    if (!candidate) continue;
    if (latest === null || compareValidatedPostingDates(candidate, latest) > 0) latest = candidate;
  }
  return latest;
}

/** `YYYY-MM-DD` (UTC day) of {@link jobSitemapLastmodSource}, or undefined. */
export function jobSitemapLastmodDay(job, now = new Date()) {
  const source = jobSitemapLastmodSource(job, now);
  if (!source) return undefined;
  const ms = Date.parse(source);
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : undefined;
}
