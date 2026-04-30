/**
 * Shared rule for building <title> + " | Frontaliere Ticino" brand suffix.
 *
 * Universal policy across blog, jobs, soft-landings, static pages, expired
 * pages, and the SPA shell:
 *
 *   1. The final <title> is hard-capped at {@link TITLE_MAX_CHARS} (default 70).
 *      This is Google's SERP-display budget on most queries; titles past it
 *      get rewritten or truncated by the SERP, costing keyword visibility.
 *
 *   2. The brand suffix " | Frontaliere Ticino" is appended only when the
 *      total stays within the cap. When the headline alone already fills
 *      (or exceeds) the cap, the brand is dropped to preserve keyword
 *      content in the headline.
 *
 *   3. When the headline itself exceeds the cap, it is truncated word-aware
 *      with a trailing "…". Callers that need to preserve a specific tail
 *      token (e.g. the trailing city in a job-detail title) MUST truncate
 *      upstream before calling this helper — see
 *      {@link build-plugins/jobsSeoPagesPlugin.truncateJobCorePreservingCity}.
 */

export const TITLE_BRAND_SUFFIX = ' | Frontaliere Ticino';
/**
 * Hard cap on the final <title> length. 90 matches the deploy-blocking
 * `audit:title-length` threshold (scripts/audit-dist-multi.mjs:49) — staying
 * inside the audit gate while leaving room for full headlines + brand suffix.
 *
 * Previously 70 (Google's SERP-display budget). That was tighter than the
 * audit gate and caused word-aware truncation with `…` to fire on headlines
 * 49-68 chars long, which then read as broken in the SERP and collapsed CTR
 * (e.g. `/calcola-stipendio/` 4.8% → 0.99% over the 87a807975 → 2026-04-30
 * window). 90 keeps the audit gate green while preserving the full keyword
 * tail for indexing; Google will visually truncate at SERP-render time but
 * without the broken `…` artifact mid-headline.
 */
export const TITLE_MAX_CHARS = 90;

/**
 * Word-aware truncation: cut on the last whitespace boundary inside `max`,
 * append "…". Falls back to a hard cut when no usable boundary exists
 * (single very long token, no spaces in the first half of the budget).
 */
export function truncateHeadline(headline: string, max: number): string {
  const safe = String(headline || '');
  if (safe.length <= max) return safe;
  // Reserve 1 char for the trailing ellipsis.
  const sliced = safe.slice(0, max - 1);
  const lastSpace = sliced.lastIndexOf(' ');
  // Only use the word boundary if it sits past the halfway mark — otherwise
  // we'd amputate too much content and the truncation looks worse than a hard cut.
  if (lastSpace > Math.floor(max / 2)) {
    return sliced.slice(0, lastSpace).trimEnd() + '…';
  }
  return sliced.trimEnd() + '…';
}

/**
 * Build the final <title> string per the universal policy.
 *
 * The brand suffix is ALWAYS appended. When headline + brand exceeds the
 * cap, the headline is truncated word-aware to make room for the brand,
 * never the other way around. Always-on brand guarantees that <title> is
 * structurally different from <h1> (which is brand-less), preventing the
 * title===h1 duplication that the audit:h1-title-duplicates gate flags.
 *
 * @param headline    The page headline. Truncated word-aware when needed
 *                    so the final string fits inside `maxChars`.
 * @param brand       Brand suffix appended unconditionally. Default
 *                    {@link TITLE_BRAND_SUFFIX}.
 * @param maxChars    Hard cap on the returned <title> length. Default
 *                    {@link TITLE_MAX_CHARS}.
 */
export function buildTitleWithBrand(
  headline: string,
  brand: string = TITLE_BRAND_SUFFIX,
  maxChars: number = TITLE_MAX_CHARS,
): string {
  const safeHeadline = String(headline || '').trim();
  if (!safeHeadline) return safeHeadline;
  // Headline budget = total cap minus the (always-appended) brand suffix.
  // If this drops to zero or below (e.g. brand alone overflows the cap),
  // fall back to the headline truncated to the raw cap with no brand —
  // there is literally no room for both.
  const headlineBudget = maxChars - brand.length;
  if (headlineBudget <= 0) {
    return safeHeadline.length <= maxChars
      ? safeHeadline
      : truncateHeadline(safeHeadline, maxChars);
  }
  const cappedHeadline = safeHeadline.length <= headlineBudget
    ? safeHeadline
    : truncateHeadline(safeHeadline, headlineBudget);
  return cappedHeadline + brand;
}
