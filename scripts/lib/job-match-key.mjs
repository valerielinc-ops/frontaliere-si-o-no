/**
 * Extract a stable job identifier from a job's source URL.
 *
 * Crawler diff logic (mergeJobs, mergePreserveLocaleData) keys jobs by the
 * source URL. When a vendor renames the slug-portion of the URL but keeps the
 * underlying job ID, the URL key changes and the old job is silently dropped
 * — losing its previousSlugs, locale translations, and SEO equity. The old
 * slug then becomes an expired soft-landing while the new slug emits as a
 * "new" job with no link continuity.
 *
 * This helper extracts the most stable token in the URL so renames don't
 * fragment the match key:
 *   1. UUID (canonical form like PwC's `0441e237-ebd9-4263-9fe5-e21facbd03ba`)
 *   2. Long numeric ID (≥6 digits — Workday, Greenhouse, etc.)
 *   3. Long alphanumeric token (≥10 chars, likely a content hash)
 *   4. Full normalized URL (legacy fallback — no regression for crawlers that
 *      embed only the slug in the URL).
 *
 * The result is always lowercase. Empty input returns an empty string so
 * callers can fall back to slug-keyed matching.
 *
 * @param {string} url - source URL of the job
 * @returns {string} stable identifier
 */
import { mergeUrlKey } from './job-url-key.mjs';

/** Numeric `0` is a real crawler id; only nullish/empty values are absent. */
export function hasUsableJobId(job) {
  return job?.id != null && job.id !== '';
}

export function extractStableJobId(url) {
  // Delegates to the canonical crawl-time merge-key variant. The logic now
  // lives in scripts/lib/job-url-key.mjs so all three URL-key normalizations
  // (merge / assemble / identity) share one home; behavior is unchanged and
  // pinned byte-for-byte by tests/job-url-key.test.ts.
  return mergeUrlKey(url);
}

/**
 * Resolve a diff-stable key for a job record, for building `Map`s keyed by
 * job identity in audit tooling that reads raw per-crawler slice files
 * (scripts/scan-prev-slug-losses.mjs, scripts/backfill-prev-slugs-from-loss-events.mjs).
 *
 * `.id` is only stamped at data/jobs.json assembly time
 * (assemble-jobs-dataset.mjs → buildStableId) and is never written back onto
 * the committed per-crawler slice on disk. Several dedicated crawlers
 * (ferrovia-retica, julius-baer, mikron, relewant, swiss-medical-network,
 * casale — see #3411) therefore commit slices where every job's `.id` is
 * `undefined`. A `Map` keyed on bare `job.id` collapses ALL such jobs in a
 * slice onto the single `undefined` key, so lookups silently return an
 * arbitrary sibling job instead of missing — corrupting the diff instead of
 * just skipping it.
 *
 * Falls back, in order: real `.id` > `extractStableJobId(url)` > `slug`.
 * Returns null only when a job has none of id/url/slug (should not happen
 * for a real crawled record) so callers can skip it instead of colliding.
 *
 * @param {{id?: string, url?: string, slug?: string}} [job]
 * @returns {string|null}
 */
export function resolveJobDiffKey(job = {}) {
  if (hasUsableJobId(job)) return String(job.id);
  // extractStableJobId already namespaces its own return value
  // (uuid:/num:/hex:/url:), so it's used as-is — no double prefix.
  const urlKey = extractStableJobId(job?.url);
  if (urlKey) return urlKey;
  const slug = String(job?.slug || '').trim().toLowerCase();
  return slug ? `slug:${slug}` : null;
}
