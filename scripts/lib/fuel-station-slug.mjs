/**
 * Per-station slug helpers, mirrored from build-plugins/fuelDailyData.ts.
 *
 * Why a duplicate: scripts/snapshot-fuel-history.mjs runs in a plain-Node
 * (ESM) context and cannot import .ts files. Keeping a tiny JS twin keeps
 * the snapshot writer slug-aligned with the TS renderer without bundling.
 *
 * Drift safety: tests/fuel-station-slug-parity.test.ts asserts these two
 * implementations produce byte-identical slugs across a fixture set.
 * If TS changes, JS must change too — and the test will fail loudly first.
 */

/**
 * Normalise a free-form string to a kebab-case URL slug.
 * MUST match `slugify` in build-plugins/fuelDailyData.ts.
 */
export function slugify(raw) {
  if (!raw) return '';
  return String(raw)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/**
 * Derive a stable per-station slug from brand + address.
 * MUST match `buildStationSlug` in build-plugins/fuelDailyData.ts.
 */
export function buildStationSlug({ brand, name, address }) {
  let street = '';
  if (address) {
    const firstPart = address.split(',')[0] ?? '';
    street = firstPart.replace(/\s+\d+[A-Za-z]?$/g, '').trim();
  }
  const brandClean = brand && String(brand).toUpperCase() !== 'UNDEFINED' ? brand : '';
  const firstNameWord = name ? String(name).split(/\s+/)[0] ?? '' : '';
  const prefix = brandClean || firstNameWord || 'stazione';
  const slug = slugify(`${prefix}-${street}`);
  return slug || slugify(name ?? '') || 'stazione';
}
