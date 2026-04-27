/**
 * Shared rule for building <title> + " | Frontaliere Ticino" brand suffix.
 *
 * Universal policy across blog, jobs, soft-landings, static pages, expired
 * pages, and the SPA shell:
 *
 *   1. The headline is **never** truncated. No "…", no word-boundary cut.
 *      Browser tabs, social shares (when og:title is missing), screenshots
 *      and aggregators all use the full <title>; trimming it makes the
 *      site look low-effort, and the audit:title-uniqueness gate already
 *      forces every canonical URL to ship a unique headline.
 *
 *   2. The brand suffix " | Frontaliere Ticino" is appended only when the
 *      total stays within {@link TITLE_MAX_CHARS} (default 70). When the
 *      headline alone is too long the brand is dropped — Google will
 *      truncate the SERP-displayed title anyway, so the choice is between
 *      losing tail words of the headline or losing the brand. Losing the
 *      brand is the lesser evil because the headline carries the keyword.
 */

export const TITLE_BRAND_SUFFIX = ' | Frontaliere Ticino';
/**
 * Threshold below which the brand suffix is appended. 70 keeps the rendered
 * <title> within Google's ~70-char SERP-display budget on most queries; the
 * suffix is intentionally dropped on longer headlines instead of truncating
 * real keyword content.
 */
export const TITLE_MAX_CHARS = 70;

/**
 * Build the final <title> string per the universal policy.
 *
 * @param headline    The page headline VERBATIM — never modified.
 * @param brand       Brand suffix to attempt appending. Default
 *                    {@link TITLE_BRAND_SUFFIX}.
 * @param maxChars    Threshold below which the brand suffix is appended.
 *                    Default {@link TITLE_MAX_CHARS}.
 */
export function buildTitleWithBrand(
  headline: string,
  brand: string = TITLE_BRAND_SUFFIX,
  maxChars: number = TITLE_MAX_CHARS,
): string {
  const safeHeadline = String(headline || '').trim();
  if (!safeHeadline) return safeHeadline;
  const candidate = safeHeadline + brand;
  return candidate.length <= maxChars ? candidate : safeHeadline;
}
