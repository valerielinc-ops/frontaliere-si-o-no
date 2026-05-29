/**
 * Canonical URL-key normalization for job identity — single source of truth.
 *
 * Historically the same job URL was normalized THREE different ways at three
 * call sites, and the subtle divergences silently dropped/mismatched jobs:
 *
 *   1. mergeUrlKey      — crawl-time MERGE key (was extractStableJobId,
 *                         scripts/lib/job-match-key.mjs). Decodes &amp; and
 *                         extracts the most stable token so vendor slug
 *                         renames don't fragment the match.
 *   2. assembleUrlKey   — assemble-time DEDUP key (was the inline URL branch
 *                         of assemblerIdentity in assemble-jobs-dataset.mjs).
 *                         Preserves the FULL raw URL including hash fragments.
 *   3. identityUrlKey   — stats/diff/firstSeenAt identity (was
 *                         normalizeIdentityUrl in scripts/lib/job-identity.mjs).
 *                         Parses the URL and STRIPS the hash + default ports.
 *
 * The three diverge ON PURPOSE in places — most notably hash handling:
 *   • assembleUrlKey PRESERVES `#job.id=NNN` (Galenica encodes distinct
 *     positions in the fragment — stripping it would collapse them into one).
 *   • identityUrlKey STRIPS the hash (stats/diff treat the canonical page,
 *     not the fragment, as the identity).
 *   • mergeUrlKey extracts a stable token (UUID / long numeric / long hex)
 *     and only falls back to the full URL, so it ignores hash differences
 *     whenever a stable token exists.
 *
 * Centralizing all three here makes those divergences visible in ONE place
 * and turns a future convergence (a single written identity) into a localized,
 * test-gated change rather than a hunt across the codebase. See
 * docs/CRAWLER-OUTPUT-NORMALIZATION.md for the convergence study.
 *
 * ⚠️  These are PERSISTED dedup/merge keys. Do NOT change the observable
 * output of any exported variant without a gated re-key migration — a silent
 * change re-keys every existing job and can cause mass slug churn. Every
 * variant's output is pinned byte-for-byte by tests/job-url-key.test.ts.
 */

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const NUM_ID_RE = /\b\d{6,}\b/;
const HEX_TOKEN_RE = /\b[0-9a-f]{10,}\b/i;

/**
 * Shared low-level normalizer: trim → strip trailing slashes → lowercase.
 * Slash-strip and lowercase commute, so callers may compose in either order.
 * @param {string} url
 * @returns {string}
 */
export function lowerStripTrailingSlash(url) {
  return String(url || '').trim().replace(/\/+$/, '').toLowerCase();
}

/**
 * Variant 1 — crawl-time MERGE key.
 *
 * Decodes `&amp;`, strips trailing slashes, lowercases, then extracts the most
 * stable token so a vendor slug rename doesn't change the key:
 *   UUID → long numeric (≥6 digits) → long hex (≥10 chars) → full URL.
 * Empty input returns '' so callers can fall back to slug-keyed matching.
 *
 * @param {string} url
 * @returns {string}
 */
export function mergeUrlKey(url) {
  if (!url) return '';
  const u = String(url).trim().replace(/&amp;/g, '&').replace(/\/+$/, '').toLowerCase();
  if (!u) return '';

  const uuid = u.match(UUID_RE);
  if (uuid) return `uuid:${uuid[0]}`;

  const num = u.match(NUM_ID_RE);
  if (num) return `num:${num[0]}`;

  const hex = u.match(HEX_TOKEN_RE);
  if (hex) return `hex:${hex[0]}`;

  return `url:${u}`;
}

/**
 * Variant 2 — assemble-time DEDUP key (URL portion only, no `url:` prefix).
 *
 * Preserves the full raw URL INCLUDING hash fragments (Galenica uses
 * `/it/jobs/#job.id=12345` to distinguish individual positions). Returns the
 * normalized URL string, or '' when there is no URL.
 *
 * @param {string} url
 * @returns {string}
 */
export function assembleUrlKey(url) {
  return lowerStripTrailingSlash(url);
}

/**
 * Variant 3 — stats/diff/firstSeenAt identity (URL portion only).
 *
 * Parses the URL, STRIPS the hash and default ports (:443/:80), normalizes a
 * trailing-slash-only pathname to '/', and lowercases. Falls back to a plain
 * trailing-slash-strip + lowercase when the URL is unparseable. Returns '' for
 * empty input.
 *
 * @param {string} url
 * @returns {string}
 */
export function identityUrlKey(url) {
  const raw = String(url || '').replace(/\s+/g, ' ').trim();
  if (!raw) return '';

  try {
    const parsed = new URL(raw);
    parsed.hash = '';
    if ((parsed.protocol === 'https:' && parsed.port === '443') || (parsed.protocol === 'http:' && parsed.port === '80')) {
      parsed.port = '';
    }
    parsed.pathname = parsed.pathname.replace(/\/+$/g, '') || '/';
    return parsed.toString().toLowerCase();
  } catch {
    return raw.replace(/\/+$/g, '').toLowerCase();
  }
}
