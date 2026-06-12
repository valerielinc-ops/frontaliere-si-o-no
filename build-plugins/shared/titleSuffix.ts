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
  const cut = lastSpace > Math.floor(max / 2)
    ? sliced.slice(0, lastSpace)
    : sliced;
  // Never leave a dangling delimiter before the ellipsis: a cut that lands
  // right after a separator token produces "Role —…" in the SERP (live
  // offender: "…Produzione PPS —… · rif. zell"), which reads as broken
  // markup and tanks CTR. Strip trailing separators/punctuation first.
  return cut.replace(/[\s—–\-·|,;:&(]+$/u, '').trimEnd() + '…';
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

/** Options for {@link composeSerpJobTitle}. */
export interface SerpJobTitleOptions {
  /**
   * Human-readable uniqueness token (e.g. "80%", "CHF 60-75k", "apr 2027",
   * "rif. a1b2c3d4"). Rendered as ` · ${token}` and ALWAYS kept inside the
   * cap — the headline shrinks around it, never the other way round.
   */
  disambiguator?: string;
  brand?: string;
  maxChars?: number;
}

/**
 * Compose a job-page SERP <title> with a CTR-first token-priority cascade.
 *
 * SERP real estate is ~60 chars; every token must earn its place. Priority
 * (validated against Indeed / LinkedIn / Jobagent SERP patterns, which
 * front-load role + location and treat the company as expendable):
 *
 *   role > city > company > brand
 *
 * Candidate cascade — the FIRST one that fits the budget wins:
 *   1. "{role} — {company} {conn} {city}"   (everything fits)
 *   2. "{role} {conn} {city}"               (drop company, keep location)
 *   3. "{role} — {company}"                 (no city available)
 *   4. "{role}"                             (only the role fits)
 *   5. word-truncated role + " {conn} {city}" (city tail preserved)
 *   6. word-truncated role                  (no city to preserve)
 *
 * The city is NEVER dropped while it fits: it carries the local search
 * intent ("<role> <città>" queries) AND it is the disambiguator that keeps
 * multi-sede roles (same title × N cities) from collapsing into duplicate
 * titles (audit:title-uniqueness is a hard deploy gate). The company is the
 * first token sacrificed: it already appears in the H1, meta description
 * and JSON-LD `hiringOrganization`.
 *
 * The brand suffix is appended only when the final headline still fits
 * (buildTitleWithBrand policy). The optional disambiguator is budgeted
 * BEFORE the cascade so it always lands inside the cap.
 *
 * Pure string logic (no Node deps) shared by the SSG plugin path and the
 * SPA runtime. Callers must apply their own multi-location guard before
 * passing `city` (the blob "ganz Schweiz" etc. must not become a city token).
 */
export function composeSerpJobTitle(
  jobTitle: string,
  company: string,
  city: string,
  locale: string,
  options: SerpJobTitleOptions = {},
): string {
  const brand = options.brand ?? TITLE_BRAND_SUFFIX;
  const maxChars = options.maxChars ?? TITLE_MAX_CHARS;
  const role = String(jobTitle || '').trim().replace(/\s+/g, ' ');
  const cleanCompany = String(company || '').trim();
  const cleanCity = String(city || '').trim();
  const connector = JOB_TITLE_CITY_CONNECTOR[locale] || JOB_TITLE_CITY_CONNECTOR.it;
  const disambToken = String(options.disambiguator || '').trim().replace(/\s+/g, ' ');
  const disamb = disambToken ? ` · ${disambToken}` : '';
  const budget = Math.max(1, maxChars - disamb.length);

  const candidates = [
    cleanCompany && cleanCity ? `${role} — ${cleanCompany} ${connector} ${cleanCity}` : '',
    cleanCity ? `${role} ${connector} ${cleanCity}` : '',
    cleanCompany ? `${role} — ${cleanCompany}` : '',
    role,
  ].filter(Boolean);
  let headline = candidates.find((c) => c.length <= budget);
  if (!headline) {
    const cityTail = cleanCity ? ` ${connector} ${cleanCity}` : '';
    const roleBudget = budget - cityTail.length;
    // Preserve the city tail while a meaningful role fragment (≥12 chars)
    // still fits; a malformed/oversized `city` (crawler body-text leak)
    // falls through to role-only truncation so the cap always holds.
    headline = cityTail && roleBudget >= 12
      ? truncateHeadline(role, roleBudget) + cityTail
      : truncateHeadline(role, budget);
  }
  return buildTitleWithBrand(headline + disamb, brand, maxChars);
}

/**
 * Build a job-detail <title> headline that PREFERS the offer location over the
 * brand suffix. Thin wrapper over {@link composeSerpJobTitle} (no
 * disambiguator) kept for the SPA call sites (services/seoService.ts,
 * components/community/JobBoard.tsx) — the SSG composer additionally appends
 * a collision disambiguator, so SPA and static titles match for all
 * non-colliding jobs and diverge only by the ` · token` suffix on colliding
 * ones. Callers must apply their own multi-location guard before passing
 * `city` (the blob "ganz Schweiz" etc. must not become a city token).
 */
export function buildJobTitleWithLocation(
  jobTitle: string,
  company: string,
  city: string,
  locale: string,
  brand: string = TITLE_BRAND_SUFFIX,
  maxChars: number = TITLE_MAX_CHARS,
): string {
  return composeSerpJobTitle(jobTitle, company, city, locale, { brand, maxChars });
}
