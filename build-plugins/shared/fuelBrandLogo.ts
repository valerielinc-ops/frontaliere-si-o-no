import { resolveBrandLogoUrl } from './seoContentTokens';

/**
 * Common Italian-/German-spelling aliases so brand strings from the TCS /
 * MIMIT feeds map to the logo slugs we actually have on disk. Keys are the
 * normalised brand (diacritic-folded, lowercased, non-[a-z0-9-] stripped);
 * values are the logo-manifest slug.
 *
 * Single source of truth shared by every fuel station-logo call-site (daily
 * zone hubs, Swiss/Italian station detail heroes, Italian city hubs, and the
 * browseable station indexes) so the alias map and the slug normalisation
 * can never drift between files.
 */
const BRAND_LOGO_ALIASES: Record<string, string> = {
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

/** Diacritic-fold + lowercase + strip to the `[a-z0-9-]` filter `resolveBrandLogoUrl` expects. */
function normaliseBrand(brand: string): string {
  return String(brand)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '');
}

/**
 * Resolve a station brand string to a public logo URL (PNG/SVG under
 * `/images/brands/...`), applying the shared alias map first. Returns `null`
 * when the brand has no logo on disk, so callers render their neutral
 * fallback (fuel-pump icon or initials monogram) instead.
 */
export function resolveStationBrandLogoUrl(
  rootDir: string | undefined,
  brand: string | undefined,
): string | null {
  if (!rootDir || !brand) return null;
  const normalised = normaliseBrand(brand);
  if (!normalised) return null;
  const aliased = BRAND_LOGO_ALIASES[normalised] ?? normalised;
  return resolveBrandLogoUrl(rootDir, aliased);
}
