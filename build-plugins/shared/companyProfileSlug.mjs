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

const LEGAL_FORM_SUFFIXES = new Set([
  'ag', 'bv', 'gmbh', 'inc', 'ltd', 'nv', 'plc', 'sa', 'sagl', 'sarl', 'spa', 'srl',
]);

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
const normCompanyToken = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/**
 * Slug of the company name with NO brand handling at all — neither the Lidl
 * special-case nor the alias fold.
 *
 * Not an internal detail: both the job-board router and the SEO hub builder keep this
 * raw form ALONGSIDE the canonical one so an alias URL a crawler already emitted is
 * still recognised (`companyRouteSlugCandidates`, and the `rawSlugs` set that feeds the
 * hub redirects). Collapsing it into {@link baseCompanySlug} would fold Lidl's variants
 * into the canonical and drop those alternates, 404-ing URLs that are already indexed.
 *
 * It had a hand-written copy in JobBoard.tsx (`slugifyCompany`) and another in
 * jobsSeoPagesPlugin.ts (`slugifyCompanyBuild`); this is the one home.
 */
export function rawCompanySlug(company) {
  return normCompanyToken(company).replace(/\s+/g, '-');
}

export function baseCompanySlug(company, companyKey) {
  const keyNorm = normCompanyToken(companyKey || '');
  const nameNorm = normCompanyToken(company);
  if (keyNorm.includes('lidl') || nameNorm.includes('lidl')) return 'lidl';
  return rawCompanySlug(company);
}

export function canonicalCompanyProfileSlug(company, companyKey) {
  const base = baseCompanySlug(company, companyKey);
  // Fold declared brand aliases into their canonical primary (single source of
  // truth: brandCanonicalMap). Unmanaged slugs pass through unchanged.
  return resolveBrandCanonical(base) ?? base;
}

function withoutLegalForm(slug) {
  const parts = slug.split('-');
  while (parts.length > 1 && LEGAL_FORM_SUFFIXES.has(parts.at(-1))) {
    parts.pop();
  }
  return parts.join('-');
}

/**
 * Resolve the canonical identities represented by a company display name.
 *
 * The primary identity is the same brand-folded slug emitted for the employer
 * profile. A trailing legal-form suffix is an explicit, safe display-name
 * variant (e.g. `Board International` ↔ `Board International SA`); removing
 * it is deliberately the only non-exact variant accepted here. The stripped
 * variant is folded through the brand map too, so `Migros Ticino SA` resolves
 * to the declared `migros` alias. No crawler key participates in this set.
 *
 * @param {string} company Display name (`job.company` or subscriber display name).
 * @returns {string[]} Canonical display-identity slugs.
 */
export function companyDisplayIdentityKeys(company) {
  const canonical = canonicalCompanyProfileSlug(company, company);
  if (!canonical) return [];

  const stripped = withoutLegalForm(canonical);
  const aliases = [canonical, stripped];
  if (stripped && stripped !== canonical) aliases.push(resolveBrandCanonical(stripped) ?? stripped);
  return [...new Set(aliases.filter(Boolean))];
}

/**
 * Compare two employer display names by exact canonical identity.
 *
 * This resolver intentionally has no crawler-key or substring fallback: a
 * shared ATS key may publish several unrelated employer display labels.
 */
export function sameCompanyDisplayIdentity(left, right) {
  const rightKeys = new Set(companyDisplayIdentityKeys(right));
  return companyDisplayIdentityKeys(left).some((key) => rightKeys.has(key));
}

/**
 * Canonical URL path for an evergreen employer profile.
 *
 * The profile emitter and legacy company-hub bridges need the same
 * locale-aware `/aziende/<slug>/` shape. Keeping the path builder beside the
 * slug builder prevents a future locale-prefix drift from splitting those
 * surfaces again.
 *
 * @param {string} locale One of `it`, `en`, `de` or `fr`.
 * @param {string} slug Canonical company-profile slug.
 * @returns {string} Trailing-slash canonical path.
 */
export function buildEmployerProfilePath(locale, slug) {
  const prefix = locale === 'it' ? '' : `/${locale}`;
  return `${prefix}/aziende/${slug}/`;
}
