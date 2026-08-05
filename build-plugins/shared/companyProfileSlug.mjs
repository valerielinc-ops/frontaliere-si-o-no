/**
 * Canonical company slug for the evergreen employer-profile surface.
 *
 * Shared by BOTH the dataset generator (scripts/build-employer-profiles.mjs)
 * and the SSG plugin (build-plugins/employerProfilePagesPlugin.ts) so the slug
 * written into data/employer-profiles.json and the slug the plugin emits pages
 * at (`/aziende/<slug>/`) can never drift.
 *
 * Mirrors build-plugins/weeklyEmployersData.ts:canonicalCompanySlug (itself a
 * documented mirror of jobsSeoPagesPlugin.ts:canonicalCompanySlugBuild) — same
 * Lidl special-case + ASCII slugify. Kept as a plain .mjs because a .ts plugin
 * can import it (tsconfig allowJs) AND a node .mjs script can import it, whereas
 * a .ts module cannot be imported by the raw-node dataset script.
 *
 * Brand-canonical dedup: the slugified result is folded through
 * `resolveBrandCanonical` (build-plugins/shared/brandCanonicalMap.mjs) BEFORE
 * being returned, so declared brand aliases collapse to the canonical primary
 * (e.g. `migros-ticino`/`gruppo-migros` → `migros`, `guess-ticino` → `guess-
 * europe-sagl`). Without this fold the evergreen /aziende/<slug>/ surface would
 * emit a SECOND indexable page for a brand jobsSeoPagesPlugin.ts already
 * canonicalises via the same map — the exact SERP-cannibalisation anti-pattern
 * brandCanonicalMap.ts (#1247) exists to prevent (reviewer finding, PR #4511).
 *
 * @param {string} company    Company display name (job.company).
 * @param {string} [companyKey] Optional crawler company key (job.companyKey).
 * @returns {string} URL-safe canonical slug (no leading/trailing dash).
 */
import { resolveBrandCanonical } from './brandCanonicalMap.mjs';

/**
 * SINGLE SOURCE OF TRUTH for company-name → URL-safe slug (issue #5012).
 *
 * Four byte-identical copies of this normalisation used to live in the repo —
 * `canonicalCompanyProfileSlug` (here), `canonicalEmployerBrandKey`
 * (services/employerBrands.ts), `canonicalCompanySlug`
 * (build-plugins/weeklyEmployersData.ts) and its hand-copied twin in
 * scripts/refresh-weekly-employers-top-pairs.mjs — differing only in what they
 * do AFTER slugifying. Non-Negotiable #6 ("una regex duplicata letteralmente
 * in ≥2 file → estraila in UN modulo condiviso") makes that a bug by
 * construction: CompanyAlert persists this token, and an alert saved under one
 * normalisation while the matcher reads another never fires, silently.
 *
 * Behaviour is unchanged from the four copies: lowercase, NFD-strip accents,
 * collapse every non-alphanumeric run to a single `-`, plus the Lidl
 * special-case (the crawler emits a dozen legal-entity variants of the same
 * brand). The brand-alias fold stays in `canonicalCompanyProfileSlug` only —
 * the SEO surfaces that must NOT fold keep calling this base directly.
 *
 * @param {string} company      Company display name (job.company).
 * @param {string} [companyKey] Optional crawler company key (job.companyKey).
 * @returns {string} URL-safe slug, no leading/trailing dash.
 */
export function baseCompanySlug(company, companyKey) {
  const norm = (s) =>
    String(s || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  const keyNorm = norm(companyKey || '');
  const nameNorm = norm(company);
  if (keyNorm.includes('lidl') || nameNorm.includes('lidl')) return 'lidl';
  return nameNorm.replace(/\s+/g, '-');
}

export function canonicalCompanyProfileSlug(company, companyKey) {
  const base = baseCompanySlug(company, companyKey);
  // Fold declared brand aliases into their canonical primary (single source of
  // truth: brandCanonicalMap). Unmanaged slugs pass through unchanged.
  return resolveBrandCanonical(base) ?? base;
}
