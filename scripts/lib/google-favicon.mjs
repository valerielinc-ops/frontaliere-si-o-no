/**
 * Shared constants for probes against Google's favicon endpoint
 * (`https://www.google.com/s2/favicons?domain=...&sz=128`).
 *
 * Extracted because `GREY_GLOBE_SIZE` was independently re-declared, with the
 * exact same value and comment, in three call sites
 * (`scripts/download-missing-company-logos.mjs`,
 * `scripts/crawl-provider-logos.mjs`, `scripts/lib/prospector/logo-probe.mjs`)
 * — a literal duplicate is a single source of drift risk if Google ever
 * changes the byte size of its fallback icon.
 */

/** Bytes — Google's generic "no favicon found" globe PNG at sz=128. */
export const GREY_GLOBE_SIZE = 726;

/** User-Agent sent with logo-acquisition requests. */
export const LOGO_BOT_USER_AGENT = 'Mozilla/5.0 (compatible; FrontaliereTicinoLogoBot/1.0)';
