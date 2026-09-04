/**
 * Brand canonical map — runtime data + resolvers, in plain .mjs so BOTH the
 * TypeScript build plugins (via `brandCanonicalMap.ts`, which re-exports these
 * with types) AND raw-node scripts (scripts/build-employer-profiles.mjs, via
 * build-plugins/shared/companyProfileSlug.mjs) share ONE source of truth for
 * the alias→canonical dedup. A .ts module cannot be imported by a node script,
 * so the data lives here and the .ts is a typed thin re-export.
 *
 * See brandCanonicalMap.ts for the full rationale (P5 SERP-cannibalisation
 * dedup, issue #1247). Design rules unchanged: aliases lowercase URL-safe,
 * distinct from their canonical, each alias belongs to exactly one brand.
 */

/** @type {Readonly<Record<string, { canonical: string, aliases: readonly string[] }>>} */
export const BRAND_CANONICAL_MAP = {
  'guess-europe-sagl': {
    canonical: 'guess-europe-sagl',
    aliases: ['guess', 'guess-europe', 'guess-sagl', 'guess-europe-switzerland', 'guess-ticino'],
  },
  'medacta-international-sa': {
    canonical: 'medacta-international-sa',
    aliases: ['medacta', 'medacta-international', 'medacta-sa', 'medacta-italia', 'medacta-rancate'],
  },
  'casale-sa': {
    canonical: 'casale-sa',
    aliases: ['casale', 'casale-lugano', 'casale-chemical', 'casale-group'],
  },
  // Migros umbrella canonical — see brandCanonicalMap.ts header for the full
  // #1247 rationale (migros-ticino is the nationwide crawler key, gruppo-migros
  // a cosmetic variation; both bridge to the `migros` umbrella hub).
  migros: {
    canonical: 'migros',
    aliases: ['migros-ticino', 'gruppo-migros'],
  },
  'soh-solothurner-spitaeler': {
    canonical: 'soh-solothurner-spitaeler',
    aliases: ['solothurner-spitaeler'],
  },
  'hoch-health': { canonical: 'hoch-health', aliases: ['kssg'] },
  paraplegie: { canonical: 'paraplegie', aliases: ['spz'] },
  'spital-thurgau': { canonical: 'spital-thurgau', aliases: ['stgag'] },
  tschuggen: { canonical: 'tschuggen', aliases: ['bewerbermanagement-stellen'] },
  'buergenstock-hotels': { canonical: 'buergenstock-hotels', aliases: ['burgenstock-collection'] },
  gkb: { canonical: 'gkb', aliases: ['gkb-jobservice'] },
  'spital-davos': { canonical: 'spital-davos', aliases: ['bewerbungsmanagement-spital-davos'] },
  kzu: { canonical: 'kzu', aliases: ['kzu-recruiting'] },
  'spital-zollikerberg': {
    canonical: 'spital-zollikerberg',
    aliases: ['diakoniewerk-neumuenster'],
  },
};

/** aliasSlug → canonical slug, built once with the same fail-fast validation. */
const ALIAS_TO_CANONICAL = (() => {
  const map = new Map();
  for (const entry of Object.values(BRAND_CANONICAL_MAP)) {
    for (const alias of entry.aliases) {
      if (alias === entry.canonical) {
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
 * If `slug` is a known alias, return the canonical slug. If it is a canonical
 * primary, return it unchanged. Otherwise return null (unmanaged slug).
 * @param {string} slug
 * @returns {string | null}
 */
export function resolveBrandCanonical(slug) {
  if (!slug) return null;
  if (BRAND_CANONICAL_MAP[slug]) return slug;
  return ALIAS_TO_CANONICAL.get(slug) ?? null;
}

/**
 * True when `slug` is a non-canonical alias that needs a bridge page.
 * @param {string} slug
 * @returns {boolean}
 */
export function isBrandAlias(slug) {
  if (!slug) return false;
  return ALIAS_TO_CANONICAL.has(slug);
}

/** @returns {ReadonlyArray<{ alias: string, canonical: string }>} */
export function listAllBrandAliases() {
  const out = [];
  for (const [alias, canonical] of ALIAS_TO_CANONICAL) out.push({ alias, canonical });
  return out;
}

/** @returns {ReadonlyArray<string>} */
export function listAllBrandCanonicals() {
  return Object.keys(BRAND_CANONICAL_MAP);
}
