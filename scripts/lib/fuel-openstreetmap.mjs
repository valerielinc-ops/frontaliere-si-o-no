/**
 * OpenStreetMap fuel-station inventory adapter.
 *
 * OSM is used here as a physical-location registry, never as a price source.
 * TCS remains the source of the observed CHF prices; an OSM-only row is
 * deliberately emitted with both prices unavailable. This keeps the national
 * index honest while allowing the inventory to cover stations that TCS did not
 * return in its price snapshot.
 */
import { haversineKm } from './haversine.mjs';
import {
  normaliseFuelStationObservation,
  normaliseText,
} from './fuel-station-dedup.mjs';

export const OSM_FUEL_SOURCE = 'openstreetmap-amenity-fuel';
export const OSM_FUEL_PROVIDER = 'OpenStreetMap';
export const OSM_FUEL_LICENSE = 'ODbL 1.0';
export const OSM_FUEL_DATA_URL = 'https://download.geofabrik.de/europe/switzerland.html';
export const OSM_FUEL_MAP_URL = 'https://www.openstreetmap.org/copyright';
export const OSM_FUEL_QUERY_TAG = 'amenity=fuel';

const FUEL_TAGS = Object.freeze({
  'fuel:octane_91': 'octane_91',
  'fuel:octane_95': 'octane_95',
  'fuel:octane_98': 'octane_98',
  'fuel:diesel': 'diesel',
  'fuel:biodiesel': 'biodiesel',
  'fuel:lpg': 'lpg',
  'fuel:cng': 'cng',
  'fuel:lng': 'lng',
  'fuel:hydrogen': 'hydrogen',
  'fuel:ethanol': 'ethanol',
  'fuel:avgas': 'avgas',
  'fuel:jet': 'jet',
});

function finiteCoordinate(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
function flattenCoordinates(value, out = []) {
  if (!Array.isArray(value)) return out;
  if (value.length >= 2 && Number.isFinite(Number(value[0])) && Number.isFinite(Number(value[1]))) {
    out.push([Number(value[0]), Number(value[1])]);
    return out;
  }
  for (const child of value) flattenCoordinates(child, out);
  return out;
}

/**
 * Return a stable representative point for a GeoJSON feature. OSM fuel
 * stations are mostly points, but ways and relations are valid `amenity=fuel`
 * objects too; for those we use the mean of the exported geometry vertices.
 */
export function pointFromOsmFeature(feature) {
  const properties = feature?.properties && typeof feature.properties === 'object' ? feature.properties : {};
  const center = Array.isArray(properties.center) ? properties.center : feature?.center;
  if (center && Number.isFinite(Number(center[0])) && Number.isFinite(Number(center[1]))) {
    return { lng: Number(center[0]), lat: Number(center[1]) };
  }
  const geometry = feature?.geometry;
  const coordinates = geometry?.type === 'Point' ? geometry.coordinates : geometry?.coordinates;
  const rawPoints = flattenCoordinates(coordinates);
  const firstPoint = rawPoints[0];
  const lastPoint = rawPoints.at(-1);
  const points = rawPoints.length > 1 && firstPoint && lastPoint && firstPoint[0] === lastPoint[0] && firstPoint[1] === lastPoint[1]
    ? rawPoints.slice(0, -1)
    : rawPoints;
  if (!points.length) return null;
  const lng = points.reduce((sum, point) => sum + point[0], 0) / points.length;
  const lat = points.reduce((sum, point) => sum + point[1], 0) / points.length;
  const finiteLat = finiteCoordinate(lat);
  const finiteLng = finiteCoordinate(lng);
  return finiteLat == null || finiteLng == null ? null : { lat: finiteLat, lng: finiteLng };
}

function featureProperties(feature) {
  const properties = feature?.properties && typeof feature.properties === 'object' ? feature.properties : {};
  const tags = properties.tags && typeof properties.tags === 'object' ? properties.tags : {};
  return { ...properties, ...tags };
}

function firstText(...values) {
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (text) return text;
  }
  return '';
}

function featureId(feature, properties, point, name, address) {
  const raw = firstText(
    feature?.id,
    properties['@id'],
    properties.osm_id != null ? `${properties.osm_type || 'element'}/${properties.osm_id}` : '',
    properties.id,
  );
  if (raw) return `osm:${raw.replace(/^osm:/, '')}`;
  const fallback = `${normaliseText(name)}|${normaliseText(address)}|${point.lat.toFixed(6)},${point.lng.toFixed(6)}`;
  return `osm:fallback:${fallback}`;
}

function formatAddress(properties) {
  const full = firstText(properties['addr:full'], properties.address, properties.formattedAddress);
  if (full) return full;
  const street = [properties['addr:street'], properties['addr:housenumber']].filter(Boolean).join(' ').trim();
  const locality = [properties['addr:postcode'], properties['addr:city'] || properties['addr:place']]
    .filter(Boolean)
    .join(' ')
    .trim();
  return [street, locality].filter(Boolean).join(', ');
}

function fuelTypesFromProperties(properties) {
  return Object.entries(FUEL_TAGS)
    .filter(([key]) => ['yes', 'true', '1', 'only'].includes(String(properties[key] ?? '').toLowerCase()))
    .map(([, value]) => value);
}

function isRoadFuelStation(properties, fuelTypes) {
  // Aviation-only facilities are valid OSM fuel objects but are not usable
  // alternatives for a commuter car. Keep ordinary stations with no fuel
  // subtype tags because OSM commonly leaves those tags unmapped.
  if (fuelTypes.length === 0) return true;
  return fuelTypes.some((fuel) => !['avgas', 'jet'].includes(fuel));
}

function stationFromFeature(feature, { observedAt = null, cantonResolver = null } = {}) {
  const properties = featureProperties(feature);
  const point = pointFromOsmFeature(feature);
  if (!point) return null;
  const name = firstText(properties.name, properties.brand, properties.operator, 'Stazione di servizio');
  const brand = firstText(properties.brand, properties.operator, properties.name);
  const address = formatAddress(properties);
  const fuelTypes = fuelTypesFromProperties(properties);
  if (!isRoadFuelStation(properties, fuelTypes)) return null;
  const suppliedCantonCandidate = firstText(properties.canton, properties['addr:state']).toUpperCase();
  const suppliedCanton = /^[A-Z]{2}$/.test(suppliedCantonCandidate) ? suppliedCantonCandidate : null;
  const canton = suppliedCanton || (typeof cantonResolver === 'function' ? cantonResolver(point) : null);
  // A Geofabrik Switzerland extract contains small border/extract artefacts;
  // the official canton polygons are the deterministic CH boundary gate.
  if (!canton) return null;
  const id = featureId(feature, properties, point, name, address);
  const normalized = normaliseFuelStationObservation({
    id,
    name,
    brand,
    address,
    lat: point.lat,
    lng: point.lng,
    sp95PriceChf: null,
    dieselPriceChf: null,
    updatedAt: null,
    observedAt,
    source: OSM_FUEL_SOURCE,
    allowNoPrice: true,
  });
  if (!normalized) return null;
  return {
    ...normalized,
    canton,
    inventorySource: OSM_FUEL_SOURCE,
    inventoryId: id,
    fuelTypes,
    access: firstText(properties.access) || null,
    openingHours: firstText(properties.opening_hours, properties['opening_hours:url']) || null,
  };
}

/**
 * Parse the GeoJSON emitted by `osmium export` after filtering
 * `amenity=fuel`. The function is pure and intentionally accepts a canton
 * resolver so fixtures can avoid importing the large production boundary
 * table.
 */
export function parseOsmFuelGeoJson(input, { observedAt = null, cantonResolver = null } = {}) {
  const document = typeof input === 'string' ? JSON.parse(input) : input;
  const features = Array.isArray(document?.features) ? document.features : [];
  const byId = new Map();
  for (const feature of features) {
    const station = stationFromFeature(feature, { observedAt, cantonResolver });
    if (!station || byId.has(station.id)) continue;
    byId.set(station.id, station);
  }
  return [...byId.values()];
}

function keyPart(value) {
  return normaliseText(value).replace(/\b(ch|switzerland|schweiz|suisse|svizzera)\b/g, '').replace(/\s+/g, ' ').trim();
}

function streetKey(value) {
  const first = String(value ?? '').split(',')[0] || '';
  return keyPart(first).replace(/\b\d+[a-z]?\b/g, '').replace(/\s+/g, ' ').trim();
}

function brandsCompatible(a, b) {
  const left = keyPart(a);
  const right = keyPart(b);
  if (!left || !right) return false;
  return left === right || left.includes(right) || right.includes(left);
}

function namesCompatible(a, b) {
  const left = keyPart(a);
  const right = keyPart(b);
  if (!left || !right) return false;
  return left === right || left.includes(right) || right.includes(left);
}

const INVENTORY_GRID_DEG = 0.0025;

function gridKey(lat, lng) {
  return `${Math.floor(lat / INVENTORY_GRID_DEG)}:${Math.floor(lng / INVENTORY_GRID_DEG)}`;
}

function nearbyCandidates(index, station) {
  const latCell = Math.floor(station.lat / INVENTORY_GRID_DEG);
  const lngCell = Math.floor(station.lng / INVENTORY_GRID_DEG);
  const candidates = [];
  for (let latOffset = -1; latOffset <= 1; latOffset += 1) {
    for (let lngOffset = -1; lngOffset <= 1; lngOffset += 1) {
      const list = index.get(`${latCell + latOffset}:${lngCell + lngOffset}`);
      if (list) candidates.push(...list);
    }
  }
  return candidates;
}

function scoreInventoryMatch(priceStation, inventoryStation) {
  const distanceKm = haversineKm(priceStation.lat, priceStation.lng, inventoryStation.lat, inventoryStation.lng);
  if (!Number.isFinite(distanceKm) || distanceKm > 0.5) return null;
  const exactAddress = keyPart(priceStation.address) && keyPart(priceStation.address) === keyPart(inventoryStation.address);
  const sameStreet = streetKey(priceStation.address) && streetKey(priceStation.address) === streetKey(inventoryStation.address);
  const sameBrand = brandsCompatible(priceStation.brand, inventoryStation.brand);
  const sameName = namesCompatible(priceStation.name, inventoryStation.name);
  if (!exactAddress && !sameStreet && !sameBrand && !sameName) return null;
  if (exactAddress && distanceKm <= 0.5) return { score: 100 - distanceKm, distanceKm };
  if (sameStreet && (sameBrand || sameName) && distanceKm <= 0.3) return { score: 80 - distanceKm, distanceKm };
  if (sameBrand && sameName && distanceKm <= 0.2) return { score: 70 - distanceKm, distanceKm };
  if (sameBrand && distanceKm <= 0.12) return { score: 50 - distanceKm, distanceKm };
  if (sameName && distanceKm <= 0.12) return { score: 45 - distanceKm, distanceKm };
  return null;
}

/**
 * Attach OSM identity to matching TCS price rows and append OSM-only rows.
 * Matching is deliberately conservative: an unmatched row is preferable to
 * silently assigning the price of a neighbouring same-brand station.
 */
export function mergeSwissStationInventories(priceStations = [], inventoryStations = []) {
  const output = [...priceStations].map((station) => ({ ...station }));
  const index = new Map();
  output.forEach((station, indexValue) => {
    if (!Number.isFinite(station?.lat) || !Number.isFinite(station?.lng)) return;
    const key = gridKey(station.lat, station.lng);
    const list = index.get(key) || [];
    list.push({ index: indexValue, station });
    index.set(key, list);
  });
  const matchedInventoryIds = new Set();
  const matchedPriceIndices = new Set();
  let matchCount = 0;
  for (const inventoryStation of inventoryStations) {
    const candidates = nearbyCandidates(index, inventoryStation);
    let best = null;
    for (const candidate of candidates) {
      if (matchedPriceIndices.has(candidate.index)) continue;
      const score = scoreInventoryMatch(candidate.station, inventoryStation);
      if (!score || (best && score.score <= best.score)) continue;
      best = { ...score, index: candidate.index };
    }
    if (!best) continue;
    const current = output[best.index];
    output[best.index] = {
      ...current,
      inventorySource: inventoryStation.inventorySource || OSM_FUEL_SOURCE,
      inventoryId: inventoryStation.inventoryId || inventoryStation.id,
      inventoryObservedAt: inventoryStation.observedAt || null,
      fuelTypes: inventoryStation.fuelTypes || [],
      canton: current.canton || inventoryStation.canton || null,
    };
    matchedInventoryIds.add(inventoryStation.id);
    matchedPriceIndices.add(best.index);
    matchCount += 1;
  }
  const unmatched = inventoryStations.filter((station) => !matchedInventoryIds.has(station.id));
  return {
    stations: [...output, ...unmatched],
    matchCount,
    inventoryOnlyCount: unmatched.length,
  };
}
