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

// Tokens that never identify the ROLE of an ETA posting: locale connectives,
// the company/location tail the slug builder appends, and "vor Ort"/"on site"
// boilerplate. Host-gated to req:eta.ch: keys — other crawlers keep the
// URL-only merge key.
const ETA_ROLE_NOISE = new Set([
  'di', 'e', 'o', 'il', 'la', 'lo', 'un', 'una', 'dei', 'del', 'delle',
  'a', 'in', 'per', 'con', 'da', 'su', 'tra', 'fra', 'al', 'dal', 'nel', 'sul',
  'of', 'the', 'and', 'or', 'for', 'to', 'at', 'on', 'an',
  'als', 'und', 'oder', 'fur', 'bei', 'mit', 'an', 'im', 'vor', 'ort',
  'et', 'ou', 'de', 'le', 'les', 'en', 'au', 'aux', 'sur',
  'eta', 'swatch', 'group', 'grenchen', 'manufacture', 'horlogere', 'suisse',
  'phone', 'sito', 'produzione', 'ticino', 'place', 'site', 'onsite',
]);

function lightSlug(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function etaRoleTokens(job = {}) {
  const slug = String(
    job?.slug || job?.slugByLocale?.it || job?.slugByLocale?.de || '',
  ).trim().toLowerCase();
  const titleHead = String(job?.title || '').split('|')[0];
  const raw = slug || lightSlug(titleHead);
  if (!raw) return [];
  return raw.split(/[^a-z0-9]+/).filter((t) => {
    if (t.length < 4) return false;
    if (ETA_ROLE_NOISE.has(t)) return false;
    if (/^\d+$/.test(t)) return false;
    // Trailing slug-disambiguator (`49gsdw`, `6oyznl`) — not a role word.
    if (/^[a-z]{0,4}\d+[a-z0-9]*$/.test(t)) return false;
    return true;
  });
}

/**
 * Coarse role signature from slug (preferred) or title. First three
 * significant tokens after stripping company/location noise — enough to
 * split a recycled ETA requisition (polymechaniker vs qualitaetssicherung)
 * and stable across disambiguator suffixes (`-phone-49gsdw`).
 * @param {{slug?: string, slugByLocale?: Record<string, string>, title?: string}} [job]
 * @returns {string}
 */
export function etaRoleStemFromJob(job = {}) {
  return etaRoleTokens(job).slice(0, 3).join('-');
}

/**
 * Full ETA role discriminator for collision handling only.
 *
 * Unlike etaRoleStemFromJob(), this keeps every meaningful role token. It is
 * deliberately NOT part of the stable requisition identity: title/slug
 * rewrites must keep continuity unless a merge sees genuinely distinct roles
 * under the same recycled requisition.
 */
export function etaRoleDiscriminatorFromJob(job = {}) {
  return etaRoleTokens(job).join('-');
}

/**
 * Stable crawl-time identity of a job RECORD.
 *
 * `extractStableJobId` is URL-only: eta.ch Rule L keys `/vacancies/detail/3770`
 * as `req:eta.ch:3770` so an ancestor `index.php/` rename does not fragment
 * the match. ETA can recycle that four-digit requisition for a different role
 * (issue 8624), but the role discriminator belongs to the collision-aware
 * merge context, not this stable key: ordinary title/slug rewrites must not
 * lose previousSlugs or locale continuity.
 *
 * Non-ETA keys are byte-for-byte `extractStableJobId(url)`. Empty slug/title
 * on an ETA URL also falls back to the URL-only key (no silent re-key of
 * callers that only pass a URL).
 *
 * @param {{url?: string, slug?: string, slugByLocale?: Record<string, string>, title?: string}} [job]
 * @returns {string}
 */
export function mergeJobIdentity(job = {}) {
  const urlKey = extractStableJobId(job?.url);
  if (!urlKey) {
    const slug = String(job?.slug || '').trim().toLowerCase();
    return slug ? `slug:${slug}` : '';
  }
  return urlKey;
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
