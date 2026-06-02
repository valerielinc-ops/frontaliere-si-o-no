/**
 * Shared rule for building <title> + " | Frontaliere Ticino" brand suffix.
 *
 * Universal policy across blog, jobs, soft-landings, static pages, expired
 * pages, and the SPA shell:
 *
 *   1. The final <title> targets {@link TITLE_TARGET_CHARS} (60 — Google's
 *      SERP-display budget on most queries) with a 10 % tolerance, hard-cap
 *      at {@link TITLE_MAX_CHARS} (66). Past this, Google rewrites or
 *      truncates the title at SERP-render time.
 *
 *   2. The brand suffix " | Frontaliere Ticino" is appended only when the
 *      total stays within the cap. When the headline alone already fills
 *      (or exceeds) the cap, the brand is DROPPED to preserve the keyword
 *      content of the headline. The brand is a "nice-to-have", not a
 *      ranking signal.
 *
 *   3. When the headline itself exceeds the cap, it is RETURNED VERBATIM
 *      (no `…` truncation). Word-aware truncation with `…` mid-headline
 *      reads as broken in the SERP and collapses CTR (`/calcola-stipendio/`
 *      4.8 % → 0.99 % over the 87a807975 → 2026-04-30 window when the cap
 *      was 70 and `…` fired on 49-68 char headlines). Callers that
 *      genuinely need a hard truncation (e.g. job-detail with a tail city
 *      to preserve) must call {@link truncateHeadline} explicitly.
 */

export const TITLE_BRAND_SUFFIX = ' | Frontaliere Ticino';
/**
 * Target SERP-display length. 60 char ≈ ~600 px on desktop SERP, the budget
 * past which Google starts rewriting / truncating titles. Soft target —
 * generators should aim here but the hard cap is {@link TITLE_MAX_CHARS}.
 */
export const TITLE_TARGET_CHARS = 60;
/**
 * Hard cap on the final <title> length: 60 (target) + 10 % tolerance = 66.
 * The tolerance exists so generators don't have to amputate the last word
 * of a headline that lands at 61-66 char — the 10 % slack absorbs natural
 * sentence variance without mid-word cuts.
 *
 * The deploy-blocking `audit:title-length` ratchet uses this same cap. Past
 * this threshold the audit fails (subject to baseline ratchet during
 * migration). Headlines that exceed 66 char on their own (no brand to drop)
 * are flagged but emitted verbatim — fix at source by editing the headline,
 * never with mid-headline `…` truncation.
 */
export const TITLE_MAX_CHARS = 66;

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
 * Order of preference:
 *   1. headline + brand fits within `maxChars` → append brand
 *   2. headline alone fits within `maxChars` → DROP the brand
 *   3. headline alone exceeds `maxChars` → return VERBATIM (no truncation,
 *      no `…`). This is a data-quality signal that the headline must be
 *      shortened at source. The `audit:title-length` gate will catch it.
 *
 * Why never truncate here: mid-headline `…` reads as broken in the SERP
 * and collapsed CTR (`/calcola-stipendio/` 4.8 % → 0.99 % during the
 * cap=70 era when `…` fired on 49-68 char headlines).
 *
 * Brand drop is safe because <title> ≠ <h1> uniqueness is enforced
 * separately (`audit:h1-title-duplicates`) and the target headlines are
 * already keyword-rich.
 *
 * @param headline    The page headline. Returned verbatim — never
 *                    truncated by this helper.
 * @param brand       Brand suffix appended only when there is room.
 *                    Default {@link TITLE_BRAND_SUFFIX}.
 * @param maxChars    Hard cap. Default {@link TITLE_MAX_CHARS} (66).
 */
export function buildTitleWithBrand(
  headline: string,
  brand: string = TITLE_BRAND_SUFFIX,
  maxChars: number = TITLE_MAX_CHARS,
): string {
  const safeHeadline = String(headline || '').trim();
  if (!safeHeadline) return safeHeadline;
  if (safeHeadline.length + brand.length <= maxChars) {
    return safeHeadline + brand;
  }
  return safeHeadline;
}

/**
 * Connector that places the offer's city in the SERP <title> tail, per locale.
 * Mirrors `CITY_CONNECTOR` in build-plugins/jobsSeoPagesPlugin.ts so the static
 * SSG job pages and the SPA runtime emit the SAME city-bearing title.
 */
export const JOB_TITLE_CITY_CONNECTOR: Record<string, string> = {
  it: 'a',
  en: 'in',
  de: 'in',
  fr: 'à',
};

/**
 * Build a job-detail <title> headline that PREFERS the offer location over the
 * brand suffix. The city rides inside the headline ("{role} — {company} a
 * {city}") and {@link buildTitleWithBrand} keeps the headline verbatim while
 * dropping " | Frontaliere Ticino" first when the title exceeds the cap — so a
 * concrete place always beats the generic brand in the SERP. Falls back to
 * role+company (or role alone) when the city/company is missing.
 *
 * Pure string logic (no Node deps) so it is shared by the SSG plugin path and
 * the SPA runtime (services/seoService.ts, components/community/JobBoard.tsx).
 *
 * NOTE — partial parity with the SSG `composeJobPageTitle`: this helper caps
 * the headline verbatim at `maxChars` (default 66), whereas the SSG composer
 * budgets the core against JOB_TITLE_MAX=70 with city-preserving truncation
 * AND appends a collision disambiguator. The SPA title therefore matches the
 * static <title> only for short, non-colliding jobs; for long/multi-sede
 * titles they diverge. Acceptable because the indexed authority is the static
 * <title> (which keeps the disambiguator); the SPA value is a JS-render
 * convenience. Callers must apply their own multi-location guard before
 * passing `city` (the blob "ganz Schweiz" etc. must not become a city token).
 */
export function buildJobTitleWithLocation(
  jobTitle: string,
  company: string,
  city: string,
  locale: string,
  brand: string = TITLE_BRAND_SUFFIX,
  maxChars: number = TITLE_MAX_CHARS,
): string {
  const cleanTitle = String(jobTitle || '').trim();
  const cleanCompany = String(company || '').trim();
  const cleanCity = String(city || '').trim();
  const connector = JOB_TITLE_CITY_CONNECTOR[locale] || JOB_TITLE_CITY_CONNECTOR.it;
  let headline = cleanTitle;
  if (cleanCompany && cleanCity) headline = `${cleanTitle} — ${cleanCompany} ${connector} ${cleanCity}`;
  else if (cleanCompany) headline = `${cleanTitle} — ${cleanCompany}`;
  else if (cleanCity) headline = `${cleanTitle} ${connector} ${cleanCity}`;
  return buildTitleWithBrand(headline, brand, maxChars);
}
