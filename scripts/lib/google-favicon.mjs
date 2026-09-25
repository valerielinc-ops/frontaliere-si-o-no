/**
 * Shared constants for probes against Google's favicon endpoint
 * (`https://www.google.com/s2/favicons?domain=...&sz=128`).
 *
 * Extracted because `GREY_GLOBE_SIZE` was independently re-declared, with the
 * exact same value and comment, in four call sites
 * (`scripts/download-missing-company-logos.mjs`,
 * `scripts/crawl-provider-logos.mjs`, `scripts/download-company-logos.mjs`,
 * `scripts/lib/prospector/logo-probe.mjs`) — a literal duplicate is a single
 * source of drift risk if Google ever changes the byte size of its fallback
 * icon.
 *
 * #6493 (follow-up of #6478): byte-size alone is a collision risk — any real
 * favicon that happens to also be exactly 726 bytes would misread as the
 * grey globe. Verified empirically (two distinct nonexistent domains against
 * the live endpoint) that Google's fallback icon is not just same-size but
 * byte-for-byte IDENTICAL across domains, so a content hash fully
 * disambiguates a same-size-but-different real favicon from the genuine
 * fallback. `isGreyGlobe()` checks the hash (size is just a cheap first
 * filter to skip hashing on an obvious non-match), replacing the
 * size-only comparison everywhere it's used.
 */
import { createHash } from 'node:crypto';

/** Bytes — Google's generic "no favicon found" globe PNG at sz=128. */
export const GREY_GLOBE_SIZE = 726;

/** SHA-256 of the grey-globe PNG bytes — the authoritative check. */
export const GREY_GLOBE_SHA256 = '59bfe9bc385ad69f50793ce4a53397316d7a875a7148a63c16df9b674c6cda64';

/** User-Agent sent with logo-acquisition requests. */
export const LOGO_BOT_USER_AGENT = 'Mozilla/5.0 (compatible; FrontaliereTicinoLogoBot/1.0)';

/**
 * @param {Buffer} buf response body from the favicon endpoint
 * @returns {boolean} true only if `buf` is byte-identical to Google's known
 *   grey-globe fallback icon (size is a cheap pre-filter, hash is the proof).
 */
export function isGreyGlobe(buf) {
  if (!buf || buf.length !== GREY_GLOBE_SIZE) return false;
  return createHash('sha256').update(buf).digest('hex') === GREY_GLOBE_SHA256;
}
