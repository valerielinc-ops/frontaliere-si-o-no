/**
 * Brand canonical map — declarative dedup for company-hub URLs that
 * cannibalise the same brand query in Google / Bing.
 *
 * Background (P5): SemRush reported ≥3 brand queries with multiple
 * competing URLs, eroding CTR:
 *   - "guess europe sagl"             → 7 URLs competing
 *   - "medacta international sa rancate" → 4 URLs competing
 *   - "casale lugano"                 → 7 URLs competing
 *
 * The cannibalisation happens because several alias slugs resolve to
 * (or could resolve to) the same company-hub landing page. This module
 * declares the **canonical** slug for each brand and every known
 * **alias** slug that must bridge to it via
 * `<link rel="canonical">` + `<meta name="robots" content="noindex,follow">`.
 *
 * The mapping is consumed by:
 *   - `build-plugins/jobsSeoPagesPlugin.ts` — emits alias bridge pages
 *     for every (locale × aliasSlug) under the company-hub path; the
 *     primary slug keeps the full hub HTML.
 *   - `build-plugins/jobsSeoPagesPlugin.ts` sitemap emitter — only the
 *     primary canonical enters `sitemap-jobs.xml`; alias slugs are
 *     skipped (bridge pages are reachable but not advertised).
 *   - `build-plugins/employerProfilePagesPlugin.ts` (via
 *     `build-plugins/shared/companyProfileSlug.mjs`) — folds alias slugs
 *     into the canonical so the evergreen `/aziende/<slug>/` surface never
 *     emits a second indexable page for an already-canonicalised brand.
 *
 * Runtime data + resolvers live in the sibling `brandCanonicalMap.mjs` so a
 * raw-node script (scripts/build-employer-profiles.mjs) can share the SAME
 * dedup map as the TS build plugins — a .ts module cannot be imported by node.
 * This file is the typed façade: it re-exports the runtime with types and owns
 * the `BrandCanonicalEntry` interface.
 *
 * Design rules:
 *   1. Primary slug = `canonicalEmployerBrandKey(company, companyKey)`
 *      (mirrors `services/employerBrands.ts`). Keep it in sync: any new
 *      alias added here must NOT collide with another brand's primary.
 *   2. Aliases must be lowercase, URL-safe (/^[a-z0-9-]+$/), and
 *      different from the canonical (self-redirect would loop).
 *   3. The map is the ONLY source of truth — plugins must not hardcode
 *      aliases inline. Adding a new brand = append one record in the .mjs.
 */
import {
  BRAND_CANONICAL_MAP as RAW_BRAND_CANONICAL_MAP,
  resolveBrandCanonical as rawResolveBrandCanonical,
  isBrandAlias as rawIsBrandAlias,
  listAllBrandAliases as rawListAllBrandAliases,
  listAllBrandCanonicals as rawListAllBrandCanonicals,
} from './brandCanonicalMap.mjs';

export interface BrandCanonicalEntry {
  /**
   * Canonical company slug (section-relative, no `azienda-` prefix).
   * Example: `guess-europe-sagl`. URL will be
   * `/{section}/azienda-{canonical}/`.
   */
  readonly canonical: string;
  /**
   * Company slugs that must bridge to the canonical above.
   * Example aliases for `guess-europe-sagl`: `guess`, `guess-europe`.
   */
  readonly aliases: readonly string[];
}

/**
 * Declarative brand-canonical dedup map. Keyed by canonical slug for O(1)
 * primary lookup. (Runtime source: `brandCanonicalMap.mjs`.)
 */
export const BRAND_CANONICAL_MAP: Readonly<Record<string, BrandCanonicalEntry>> =
  RAW_BRAND_CANONICAL_MAP as Readonly<Record<string, BrandCanonicalEntry>>;

/**
 * If `slug` is a known alias, return the canonical slug.
 * If `slug` is a canonical primary, return it unchanged.
 * Otherwise return `null` — caller treats it as an unmanaged slug.
 */
export const resolveBrandCanonical: (slug: string) => string | null = rawResolveBrandCanonical;

/**
 * True when `slug` is a non-canonical alias that needs a bridge page.
 */
export const isBrandAlias: (slug: string) => boolean = rawIsBrandAlias;

/**
 * All alias slugs declared across the map. Used by the sitemap emitter
 * to skip aliases and by tests to iterate.
 */
export const listAllBrandAliases: () => ReadonlyArray<{ alias: string; canonical: string }> =
  rawListAllBrandAliases;

/**
 * All canonical primary slugs declared. Used by tests to assert that
 * exactly one primary page per brand carries the self-canonical.
 */
export const listAllBrandCanonicals: () => ReadonlyArray<string> = rawListAllBrandCanonicals;
