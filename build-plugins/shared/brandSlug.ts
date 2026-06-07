/**
 * Canonical fuel-station brand-slug normalisation — the single source of truth
 * shared by every consumer (build-time logo resolution in `fuelBrandLogo.ts`,
 * SSG hero rendering, and the client-side "Stats" tab station list) so the
 * diacritic-fold + strip and the alias map can never drift between files
 * (AGENTS.md non-negotiable #6: a regex/constant duplicated literally in ≥2
 * files belongs in ONE shared module).
 *
 * Pure (no `fs`/`path`) → safe to import from both build plugins and the client
 * bundle via the `@/build-plugins/shared/brandSlug` alias.
 */

/**
 * Common Italian-/German-spelling aliases so brand strings from the TCS /
 * MIMIT feeds map to the logo slugs we actually have on disk. Keys are the
 * normalised brand (diacritic-folded, lowercased, non-`[a-z0-9-]` stripped);
 * values are the logo-manifest slug.
 */
export const BRAND_LOGO_ALIASES: Record<string, string> = {
  eni: 'agipeni',
  agip: 'agipeni',
  coop: 'cooppronto',
  cooppronto: 'cooppronto',
  ruedirussel: 'ruedirussel',
  ruedirüssel: 'ruedirussel',
  migrolino: 'migrol',
  total: 'totalenergies',
  totalenergies: 'totalenergies',
};

/** Diacritic-fold + lowercase + strip to the `[a-z0-9-]` filter logo lookups expect. */
export function normaliseBrand(brand: string | undefined | null): string {
  return String(brand ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '');
}

/**
 * Brand → logo slug: normalise, then apply the alias map. This is the single
 * value both the build-time logo resolver and the client image path build, so a
 * branded station (e.g. "Eni" → `agipeni`, "Coop" → `cooppronto`) resolves to
 * the SAME slug on the SSG page and in the live Stats tab — no more drift where
 * the build picked up the aliased logo but the client fell back to initials.
 */
export function brandLogoSlug(brand: string | undefined | null): string {
  const normalised = normaliseBrand(brand);
  return BRAND_LOGO_ALIASES[normalised] ?? normalised;
}
