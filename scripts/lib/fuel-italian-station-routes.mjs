/**
 * URL slugs of the Italian per-station fuel pages.
 *
 * One rule for the two writers: the data generator, which records the slug of
 * every station it has ever listed (`italy.stationRoutes`), and the build,
 * which reuses it for live pages and for the bridges of retired stations.
 * Deriving a slug again from the current rows is not enough: they are sorted by
 * price, and among namesakes the `-2` suffix would move with the order.
 */

/**
 * Normalise a free-form string to a kebab-case URL slug.
 * Strips accents, punctuation, extra whitespace. Safe for station names,
 * addresses, brand names, city names.
 *
 * @param {string | null | undefined} raw
 * @returns {string}
 */
export function slugify(raw) {
  if (!raw) return '';
  return String(raw)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip diacritics
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80); // URL length sanity cap
}

/**
 * Derive a stable per-station slug from brand + address.
 *
 * Pattern: `{brand}-{street}`. We strip house numbers and postal codes to
 * keep the slug readable. Example: `eni-via-compolongo`.
 *
 * When brand is missing or is the sentinel "UNDEFINED", we fall back to the
 * station name (first word) combined with the street.
 *
 * @param {{ brand?: string | null, name?: string | null, address?: string | null }} opts
 * @returns {string}
 */
export function buildStationSlug(opts) {
  const { brand, name, address } = opts;
  // Extract "street part": everything before the postal code + city portion.
  // Addresses look like "Via Foo 12, 6830 Chiasso" or "Foo Road, Bar".
  // We keep the segment before the first comma, then strip house numbers.
  let street = '';
  if (address) {
    const firstPart = address.split(',')[0] ?? '';
    street = firstPart.replace(/\s+\d+[A-Za-z]?$/g, '').trim();
  }

  const brandClean = brand && brand.toUpperCase() !== 'UNDEFINED' ? brand : '';
  const firstNameWord = name ? name.split(/\s+/)[0] ?? '' : '';
  const prefix = brandClean || firstNameWord || 'stazione';

  const slug = slugify(`${prefix}-${street}`);
  return slug || slugify(name ?? '') || 'stazione';
}

const ROUTE_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Station id → slug inside one comune.
 *
 * A recorded slug is kept, and stays reserved even when its station is not in
 * `stations`. A station with no record takes, in list order, the base slug or
 * the first free `-N`. With nothing recorded this is the assignment the
 * published pages already have (rows of one id count once).
 *
 * @param {ReadonlyArray<{ id?: string, brand?: string, stationName?: string, address?: string }>} stations
 * @param {Readonly<Record<string, string>>} [recorded]
 * @returns {Map<string, string>}
 */
export function assignItalianStationSlugs(stations, recorded = {}) {
  const taken = new Set(Object.values(recorded).filter((slug) => ROUTE_SLUG_RE.test(slug)));
  const claimed = new Set();
  const routes = new Map();
  for (const { id } of stations) {
    if (!id || routes.has(id) || !Object.hasOwn(recorded, id)) continue;
    const slug = recorded[id];
    if (!ROUTE_SLUG_RE.test(slug) || claimed.has(slug)) continue;
    claimed.add(slug);
    routes.set(id, slug);
  }
  for (const station of stations) {
    if (!station.id || routes.has(station.id)) continue;
    if (!station.brand && !station.stationName) continue;
    const base = buildStationSlug({ brand: station.brand, name: station.stationName, address: station.address });
    let slug = base;
    for (let suffix = 2; taken.has(slug); suffix += 1) slug = `${base}-${suffix}`;
    taken.add(slug);
    routes.set(station.id, slug);
  }
  return routes;
}

/**
 * The page of one Italian station as the SPA must link it, or null when the
 * build wrote none. The build manifest's own id → page map wins: a slug derived
 * in the browser could name a namesake. A manifest without that map, or no
 * manifest yet, falls back to the derived slug.
 *
 * @param {string} stationId
 * @param {{ citySlug: string | null, stationSlug: string | undefined }} derived
 * @param {{ pages: ReadonlySet<string>, byStationId: Readonly<Record<string, string>> | null } | null} manifest
 * @returns {{ citySlug: string, stationSlug: string } | null}
 */
export function resolveItalianStationRoute(stationId, derived, manifest) {
  if (manifest?.byStationId) {
    const [citySlug, stationSlug] = Object.hasOwn(manifest.byStationId, stationId)
      ? manifest.byStationId[stationId].split('/')
      : [];
    return citySlug && stationSlug ? { citySlug, stationSlug } : null;
  }
  const { citySlug, stationSlug } = derived;
  if (!citySlug || !stationSlug) return null;
  if (manifest && !manifest.pages.has(`${citySlug}/${stationSlug}`)) return null;
  return { citySlug, stationSlug };
}
