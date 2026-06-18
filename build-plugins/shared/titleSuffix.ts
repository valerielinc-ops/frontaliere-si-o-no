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

import { truncateCodeUnits } from './safeTruncate';

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
  // Reserve 1 char for the trailing ellipsis. Surrogate-safe so the hard-cut
  // fallback can never leave a lone surrogate (split emoji) in a meta tag.
  const sliced = truncateCodeUnits(safe, max - 1);
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
 * SERP meta-description budget. Google truncates the snippet at ~155-160 char
 * on desktop; past this the tail (often the CTA/long-tail keywords) is dropped
 * from the displayed snippet, costing CTR. Generators should aim under this;
 * the render-layer clamp ({@link clampMetaDescription}) is the safety net.
 */
export const META_DESCRIPTION_MAX_CHARS = 160;

/**
 * Clamp a `<meta name="description">` / `og:description` string to the SERP
 * snippet budget. Collapses internal whitespace, then word-aware truncates
 * with "…" via {@link truncateHeadline}. Applied at BOTH render layers (static
 * SSG emit in `htmlTemplate.ts` and the runtime head update in `seoService.ts`)
 * so a crawler — whether it reads the static HTML or the JS-rendered DOM — sees
 * a complete, non-truncated snippet. Only the META TAGS are clamped: JSON-LD
 * `description` keeps the full text (schema has no length cap).
 *
 * Closes the SearchAtlas audit 141162 `meta_desc_invalid_length` gap (487 SSG
 * pages, e.g. career landings emitting 253-char descriptions).
 */
export function clampMetaDescription(
  description: string,
  max = META_DESCRIPTION_MAX_CHARS,
): string {
  const normalized = String(description || '').replace(/\s+/g, ' ').trim();
  return truncateHeadline(normalized, max);
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
  /**
   * When `true`, the city is treated as DROPPABLE: it is included only when the
   * full "{role} — {company} {conn} {city}" headline fits the budget verbatim;
   * the moment that candidate would overflow (forcing the cascade to drop the
   * company or truncate the role) the city is omitted so the role can occupy the
   * whole budget without a mid-word `…`.
   *
   * Default `false` — city is mandatory (the standard cascade keeps it while it
   * fits because it carries local-query intent AND guarantees multi-sede title
   * uniqueness). Callers may opt in ONLY when they have proven, at the corpus
   * level, that "{role} — {company}" (no city) is unique in the locale, so
   * dropping the city cannot collapse two pages into a duplicate <title>
   * (audit:title-uniqueness is a hard deploy gate). See the SSG plugin's
   * `noCityTitleCollisionByLocale` guard (build-plugins/jobsSeoPagesPlugin.ts).
   *
   * Closes the #1931 follow-up #1932: cuts the residual mid-`…` titles
   * (17.8 % active / 22.8 % expired) on non-colliding role+company pages.
   */
  cityOptional?: boolean;
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
 * EXCEPTION — `options.cityOptional` (#1932): for pages the caller has proven
 * non-colliding without the city, the city is droppable. WHEN a company exists,
 * the city survives only inside the full "role — company a city" candidate; the
 * moment that overflows the cascade skips the "role a city" and city-tail-
 * truncation steps and falls to the city-less "role — company" / "role" path so
 * the role fills the budget without a mid-`…`. WHEN there is no company,
 * "role a city" is the sole city-bearing candidate and is KEPT — so the city is
 * dropped only on OVERFLOW (via the empty `cityTail` in the truncation branch),
 * never when it would otherwise fit. This eliminates the residual mid-`…` titles
 * (17.8 % active / 22.8 % expired) where role+city blew the 66-char cap without
 * stripping the geo keyword from titles that had room for it.
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
  const cityOptional = options.cityOptional === true;

  // When the city is droppable, it survives ONLY in the full
  // "role — company a city" candidate: once that overflows we fall straight to
  // the city-less "role — company" path so the role takes the whole budget
  // without a mid-word `…`. Otherwise the city is mandatory and stays while it
  // fits (the standard cascade below).
  //
  // The "role a city" candidate is skipped only when the city is droppable AND
  // a company exists to carry the city-less fallback — for a no-company job
  // "role a city" is the ONLY candidate bearing the city, so keeping it ensures
  // the city is dropped on OVERFLOW (via the `cityTail` logic below), never when
  // it would otherwise fit. (#1932 reviewer 🔴.)
  const candidates = [
    cleanCompany && cleanCity ? `${role} — ${cleanCompany} ${connector} ${cleanCity}` : '',
    (!cityOptional || !cleanCompany) && cleanCity ? `${role} ${connector} ${cleanCity}` : '',
    cleanCompany ? `${role} — ${cleanCompany}` : '',
    role,
  ].filter(Boolean);
  let headline = candidates.find((c) => c.length <= budget);
  if (!headline) {
    // The city tail is preserved during truncation only when the city is
    // mandatory; a droppable city is sacrificed before the role is truncated.
    const cityTail = !cityOptional && cleanCity ? ` ${connector} ${cleanCity}` : '';
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
 * a collision disambiguator AND may drop the city on non-colliding pages
 * (`cityOptional`, #1932), so SPA and static titles match for most
 * non-colliding jobs and diverge by the ` · token` suffix on colliding ones
 * or by a dropped city on overflow-prone unique ones. The indexed <title> is
 * the static SSG HTML; the SPA keeps the city (no corpus map at runtime).
 * Callers must apply their own multi-location guard before passing
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
