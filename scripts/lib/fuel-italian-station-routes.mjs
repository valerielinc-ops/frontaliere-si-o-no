/**
 * URL slugs of the Italian per-station fuel pages.
 *
 * One rule for the two writers: the data generator, which records the slug of
 * every station it has ever listed (`italy.stationRoutes`), and the build,
 * which reuses it for live pages and for the bridges of retired stations.
 * Deriving a slug again from the current rows is not enough: they are sorted by
 * price, and among namesakes the `-2` suffix would move with the order.
 */

// The JS twin of `fuelDailyData.ts#buildStationSlug` (parity-tested).
import { buildStationSlug } from './fuel-station-slug.mjs';

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
