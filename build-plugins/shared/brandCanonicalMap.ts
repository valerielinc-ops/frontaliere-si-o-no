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
 *
 * Design rules:
 *   1. Primary slug = `canonicalEmployerBrandKey(company, companyKey)`
 *      (mirrors `services/employerBrands.ts`). Keep it in sync: any new
 *      alias added here must NOT collide with another brand's primary.
 *   2. Aliases must be lowercase, URL-safe (/^[a-z0-9-]+$/), and
 *      different from the canonical (self-redirect would loop).
 *   3. The map is the ONLY source of truth — plugins must not hardcode
 *      aliases inline. Adding a new brand = append one record here.
 */

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
 * Declarative brand-canonical dedup map.
 * Keyed by canonical slug for O(1) primary lookup.
 */
export const BRAND_CANONICAL_MAP: Readonly<Record<string, BrandCanonicalEntry>> = {
  'guess-europe-sagl': {
    canonical: 'guess-europe-sagl',
    aliases: [
      'guess',
      'guess-europe',
      'guess-sagl',
      'guess-europe-switzerland',
      'guess-ticino',
    ],
  },
  'medacta-international-sa': {
    canonical: 'medacta-international-sa',
    aliases: [
      'medacta',
      'medacta-international',
      'medacta-sa',
      'medacta-italia',
      'medacta-rancate',
    ],
  },
  'casale-sa': {
    canonical: 'casale-sa',
    aliases: [
      'casale',
      'casale-lugano',
      'casale-chemical',
      'casale-group',
    ],
  },
} as const;

/**
 * Reverse lookup: aliasSlug → canonical slug.
 * Built once at module load; callers should not mutate.
 */
const ALIAS_TO_CANONICAL: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  for (const entry of Object.values(BRAND_CANONICAL_MAP)) {
    for (const alias of entry.aliases) {
      if (alias === entry.canonical) {
        // Defensive — an alias that equals canonical would self-loop.
        // We throw so the build fails fast rather than silently emitting bad pages.
        throw new Error(
          `[brandCanonicalMap] Alias "${alias}" equals canonical for brand "${entry.canonical}". ` +
          'Aliases must be distinct from the canonical slug.',
        );
      }
      const existing = map.get(alias);
      if (existing && existing !== entry.canonical) {
        throw new Error(
          `[brandCanonicalMap] Alias "${alias}" is already mapped to canonical "${existing}"; ` +
          `cannot remap to "${entry.canonical}". Each alias must belong to exactly one brand.`,
        );
      }
      map.set(alias, entry.canonical);
    }
  }
  return map;
})();

/**
 * If `slug` is a known alias, return the canonical slug.
 * If `slug` is a canonical primary, return it unchanged.
 * Otherwise return `null` — caller treats it as an unmanaged slug.
 */
export function resolveBrandCanonical(slug: string): string | null {
  if (!slug) return null;
  if (BRAND_CANONICAL_MAP[slug]) return slug;
  return ALIAS_TO_CANONICAL.get(slug) ?? null;
}

/**
 * True when `slug` is a non-canonical alias that needs a bridge page.
 */
export function isBrandAlias(slug: string): boolean {
  if (!slug) return false;
  return ALIAS_TO_CANONICAL.has(slug);
}

/**
 * All alias slugs declared across the map. Used by the sitemap emitter
 * to skip aliases and by tests to iterate.
 */
export function listAllBrandAliases(): ReadonlyArray<{ alias: string; canonical: string }> {
  const out: Array<{ alias: string; canonical: string }> = [];
  for (const [alias, canonical] of ALIAS_TO_CANONICAL) {
    out.push({ alias, canonical });
  }
  return out;
}

/**
 * All canonical primary slugs declared. Used by tests to assert that
 * exactly one primary page per brand carries the self-canonical.
 */
export function listAllBrandCanonicals(): ReadonlyArray<string> {
  return Object.keys(BRAND_CANONICAL_MAP);
}
