/**
 * Single source of truth for the per-sitemap URL cap and shard-index padding.
 *
 * sitemaps.org caps each sitemap at 50,000 URLs. We shard at 39,000 to leave a
 * safety margin for incidental growth between builds. The
 * `sitemap-search-clusters.xml` cohort topped 81,537 URLs as of 2026-05-18,
 * silently failing GSC ingestion above the cap.
 *
 * 39,000 is kept strictly BELOW the weekly monitor's WARNING_THRESHOLD (42,000,
 * `scripts/check-sitemap-shard-size.mjs` / `check-dist-sitemap-shard-size.mjs`),
 * not just Google's hard cap. At the previous 45,000 cap, every full-by-design
 * shard sat right at 45,000 — ABOVE the 42,000 warning floor — so the monitor
 * guaranteed a weekly WARNING for the same non-actionable, by-design condition
 * (issue #5066, sibling of the CRITICAL-vs-cap decoupling done in #4395).
 *
 * WHY THIS MODULE EXISTS: the value used to be written out three times — as
 * `SITEMAP_SHARD_CAP` in `build-plugins/relatedSearchClustersPlugin.ts` and as
 * `DEFAULT_CAP_PER_SHARD` in `scripts/lib/sitemap-shard.mjs`, whose comment
 * openly cross-referenced the other as a "sibling constant" that had to be kept
 * in lockstep by hand. A third consumer (the locale-variant backfill,
 * `build-plugins/shared/localeVariantSitemap.ts`, issue #5110) made the drift
 * risk concrete, so the literal now lives here and the consumers import it —
 * drift is impossible by construction (AGENTS.md Non-Negotiable #6).
 *
 * `.mjs` on purpose: both TypeScript build plugins and plain-Node scripts
 * import it (the established `build-plugins/*.ts` → `scripts/lib/*.mjs` path).
 */

/** Max `<url>` entries per emitted sitemap file. */
export const SITEMAP_SHARD_CAP = 39_000;

/**
 * Zero-pad a 1-based shard index to the 3-digit filename form
 * (`1` → `"001"`, `42` → `"042"`, `1000` → `"1000"`).
 *
 * @param {number} index 1-based shard index
 * @returns {string}
 */
export function padShardIndex(index) {
  return index >= 1000 ? String(index) : String(index).padStart(3, '0');
}
