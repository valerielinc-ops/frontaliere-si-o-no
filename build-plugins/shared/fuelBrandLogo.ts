import { resolveBrandLogoUrl } from './seoContentTokens';
import { brandLogoSlug } from './brandSlug';

/**
 * Resolve a station brand string to a public logo URL (PNG/SVG under
 * `/images/brands/...`), applying the shared alias map first via the canonical
 * `brandLogoSlug`. Returns `null` when the brand has no logo on disk, so callers
 * render their neutral fallback (fuel-pump icon or initials monogram) instead.
 */
export function resolveStationBrandLogoUrl(
  rootDir: string | undefined,
  brand: string | undefined,
): string | null {
  if (!rootDir || !brand) return null;
  const slug = brandLogoSlug(brand);
  if (!slug) return null;
  return resolveBrandLogoUrl(rootDir, slug);
}
