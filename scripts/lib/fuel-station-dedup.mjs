/**
 * Fuel-station dedup (AE-9).
 *
 * TCS Firestore occasionally emits multiple records for the same physical
 * station: same brand name + same postal address, but different document ids
 * and drifted coordinates (observed: two "Eni" docs at "Via Cantonale 36,
 * 6987 Caslano" with coords ~500 m apart; two "Eni Gondo" at the same
 * Simplonstrasse address with coords ~50 m apart).
 *
 * We dedup at the crawler level so every downstream consumer (SEO pages,
 * ranking, JSON-LD, cannibalization audit) sees a single canonical entry per
 * physical station.
 *
 * Dedup key: normalised (name + address).
 *   - unicode NFKD compatibility decomposition
 *   - remove accents and lowercase
 *   - strip punctuation / collapse whitespace
 * Coord precision (4 dp ≈ 11 m) is used as a secondary signal for logging
 * only — addresses are the authoritative identity for TCS records.
 *
 * Winner selection (in order):
 *   1. Most recent `updatedAt`
 *   2. Entry with diesel price (more complete)
 *   3. Lexicographically lowest id (stable tiebreak)
 */

/**
 * Normalise a free-text field for dedup key construction.
 * Idempotent: normaliseText(normaliseText(x)) === normaliseText(x).
 *
 * @param {string | null | undefined} value
 * @returns {string}
 */
export function normaliseText(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/\p{Diacritic}+/gu, '')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export const FUEL_STATION_SCHEMA_VERSION = 1;

function finiteNumber(value) {
  if (value == null || (typeof value === 'string' && value.trim() === '')) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * Convert a provider-specific station adapter result to the canonical station
 * shape consumed by the fuel dataset. Provider adapters are responsible for
 * mapping their own fuel names to `sp95PriceChf` / `dieselPriceChf`; this
 * function deliberately knows nothing about TCS (or any future provider).
 *
 * `observedAt` is the retrieval timestamp when a source does not expose a
 * per-price timestamp. `sourceObservedAt` is optional and must only be set
 * when the provider supplies an authoritative timestamp. `allowNoPrice` and
 * `inventoryOnly` are reserved for physical registries such as OpenStreetMap;
 * those rows remain visible with both fuel statuses unavailable.
 *
 * @param {object} station
 * @returns {object | null}
 */
export function normaliseFuelStationObservation(station = {}) {
  const id = String(station.id ?? '').trim();
  const lat = finiteNumber(station.lat);
  const lng = finiteNumber(station.lng);
  const sp95PriceChf = finiteNumber(station.sp95PriceChf);
  const dieselPriceChf = finiteNumber(station.dieselPriceChf);
  const inventoryOnly = station.allowNoPrice === true || station.inventoryOnly === true;
  if (!id || lat == null || lng == null || (!inventoryOnly && sp95PriceChf == null && dieselPriceChf == null)) return null;

  const observedAt = station.observedAt == null ? null : String(station.observedAt);
  const sourceObservedAt = station.sourceObservedAt == null ? null : String(station.sourceObservedAt);
  const dieselPresent = dieselPriceChf != null;
  const sp95SourceQuality = station.sp95SourceQuality == null ? null : String(station.sp95SourceQuality);
  const dieselSourceQuality = station.dieselSourceQuality == null ? null : String(station.dieselSourceQuality);
  return {
    schemaVersion: FUEL_STATION_SCHEMA_VERSION,
    id,
    name: String(station.name ?? station.brand ?? 'Station').trim() || 'Station',
    brand: String(station.brand ?? '').trim(),
    address: String(station.address ?? '').trim(),
    lat,
    lng,
    sp95PriceChf,
    dieselPriceChf,
    dieselSource: dieselPresent ? (station.dieselSource ?? 'api') : 'unknown',
    dieselUpdatedAt: dieselPresent
      ? (Object.hasOwn(station, 'dieselUpdatedAt') ? station.dieselUpdatedAt : sourceObservedAt ?? observedAt)
      : null,
    // `null` is meaningful for an inventory-only row: OSM tells us that a
    // physical station was observed, not when a price changed. Preserve an
    // explicitly supplied null instead of turning it into the inventory
    // snapshot time through the nullish-coalescing fallback.
    updatedAt: Object.hasOwn(station, 'updatedAt') ? station.updatedAt : observedAt,
    observedAt,
    source: String(station.source ?? 'unknown'),
    priceStatus: {
      sp95: sp95PriceChf != null ? 'available' : 'unavailable',
      diesel: dieselPresent ? 'available' : 'unavailable',
    },
    // Keep the provider fiability channels explicit even when one fuel is
    // absent; null means “no observation for this fuel”, not a timestamp.
    sp95SourceQuality,
    dieselSourceQuality,
    ...(sourceObservedAt ? { sourceObservedAt } : {}),
    ...(station.sourceQuality ? { sourceQuality: String(station.sourceQuality) } : {}),
  };
}

/**
 * Build the canonical dedup key for a station record.
 *
 * @param {{ name?: string | null; address?: string | null }} station
 * @returns {string}
 */
export function buildStationDedupKey(station) {
  return `${normaliseText(station?.name)}|${normaliseText(station?.address)}`;
}

/**
 * Return a deterministic order for a provider-neutral station collection.
 * Feed order is not a contract, so national snapshots must not change merely
 * because the upstream response was enumerated differently.
 */
export function sortStationsStable(stations) {
  return [...(stations ?? [])].sort((a, b) => (
    buildStationDedupKey(a).localeCompare(buildStationDedupKey(b))
    || String(a?.id ?? '').localeCompare(String(b?.id ?? ''))
  ));
}

/**
 * Round a coordinate to 4 decimal places (~11 m at Swiss latitudes).
 *
 * @param {number | null | undefined} value
 * @returns {number | null}
 */
export function roundCoord(value) {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.round(value * 10_000) / 10_000;
}

/**
 * Parse an ISO-like timestamp safely. Returns 0 for invalid / missing values
 * so they lose every tiebreak.
 *
 * @param {string | number | null | undefined} value
 * @returns {number}
 */
function parseTimestamp(value) {
  if (!value) return 0;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Decide the winner between two duplicate records. `a` is the current
 * winner; `b` is the challenger. Returns the winner.
 *
 * @template {{ updatedAt?: string | null; dieselPriceChf?: number | null; id?: string }} T
 * @param {T} a
 * @param {T} b
 * @returns {T}
 */
function pickWinner(a, b) {
  const aTs = parseTimestamp(a.updatedAt);
  const bTs = parseTimestamp(b.updatedAt);
  if (bTs !== aTs) return bTs > aTs ? b : a;

  const priceCount = (station) => ['sp95PriceChf', 'dieselPriceChf']
    .filter((field) => Number.isFinite(Number(station?.[field])) && Number(station[field]) > 0)
    .length;
  const aPrices = priceCount(a);
  const bPrices = priceCount(b);
  if (bPrices !== aPrices) return bPrices > aPrices ? b : a;

  const aDiesel = Number.isFinite(Number(a.dieselPriceChf));
  const bDiesel = Number.isFinite(Number(b.dieselPriceChf));
  if (aDiesel !== bDiesel) return bDiesel ? b : a;

  // Stable lexicographic id tiebreak
  const aId = String(a.id ?? '');
  const bId = String(b.id ?? '');
  return bId < aId ? b : a;
}

/**
 * Keep the stable winner's identity and observation metadata, but do not lose
 * a fuel observation that exists only on the duplicate record. TCS can expose
 * the same physical address under more than one document id and the national
 * SP95/DIESEL union makes that loss visible: the merged row must retain both
 * independent prices and their provider quality signals.
 *
 * @template {Record<string, any>} T
 * @param {T} winner
 * @param {T} loser
 * @returns {T}
 */
function mergeFuelObservationFields(winner, loser) {
  const merged = { ...winner };
  for (const field of ['sp95PriceChf', 'dieselPriceChf']) {
    const winnerValue = merged[field] == null || merged[field] === '' ? null : Number(merged[field]);
    const loserValue = loser?.[field] == null || loser?.[field] === '' ? null : Number(loser[field]);
    if ((!Number.isFinite(winnerValue) || winnerValue <= 0) && Number.isFinite(loserValue) && loserValue > 0) merged[field] = loser[field];
  }
  for (const field of ['dieselUpdatedAt', 'sp95SourceQuality', 'dieselSourceQuality']) {
    if (merged[field] == null && loser?.[field] != null) merged[field] = loser[field];
  }
  if (merged.sourceQuality == null && loser?.sourceQuality != null) merged.sourceQuality = loser.sourceQuality;

  const winnerStatus = merged.priceStatus && typeof merged.priceStatus === 'object' ? merged.priceStatus : {};
  const loserStatus = loser?.priceStatus && typeof loser.priceStatus === 'object' ? loser.priceStatus : {};
  // Preserve physical-registry identity when an OSM row and a TCS row
  // collapse on the same normalized name/address but the conservative spatial
  // matcher did not attach them first.
  for (const field of ['inventorySource', 'inventoryId', 'inventoryObservedAt', 'canton', 'fuelTypes', 'access', 'openingHours']) {
    if (merged[field] == null && loser?.[field] != null) merged[field] = loser[field];
  }

  const priceStatus = { ...winnerStatus };
  for (const fuel of ['sp95', 'diesel']) {
    if (priceStatus[fuel] !== 'available' && loserStatus[fuel] === 'available') priceStatus[fuel] = 'available';
  }
  if (Object.keys(priceStatus).length > 0) merged.priceStatus = priceStatus;
  return merged;
}

/**
 * Deduplicate a list of Swiss fuel-station records.
 *
 * @template {{
 *   id?: string;
 *   name?: string | null;
 *   address?: string | null;
 *   lat?: number | null;
 *   lng?: number | null;
 *   updatedAt?: string | null;
 *   dieselPriceChf?: number | null;
 * }} T
 * @param {ReadonlyArray<T>} stations
 * @param {{ logger?: (msg: string) => void }} [options]
 * @returns {{ unique: T[]; removed: Array<{ key: string; kept: string; dropped: string }> }}
 */
export function dedupStations(stations, options = {}) {
  const logger = options.logger ?? ((msg) => console.log(msg));
  /** @type {Map<string, T>} */
  const byKey = new Map();
  /** @type {Array<{ key: string; kept: string; dropped: string }>} */
  const removed = [];

  for (const station of stations ?? []) {
    if (!station || typeof station !== 'object') continue;
    const key = buildStationDedupKey(station);
    // Skip dedup when both name and address are empty — can't identify.
    if (key === '|') {
      byKey.set(`__empty__${byKey.size}`, station);
      continue;
    }
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, station);
      continue;
    }
    const winner = pickWinner(existing, station);
    const loser = winner === existing ? station : existing;
    byKey.set(key, mergeFuelObservationFields(winner, loser));
    const mergedWinner = byKey.get(key);
    removed.push({
      key,
      kept: String(mergedWinner.id ?? '∅'),
      dropped: String(loser.id ?? '∅'),
    });
    const keptCoord = `${roundCoord(mergedWinner.lat)},${roundCoord(mergedWinner.lng)}`;
    const droppedCoord = `${roundCoord(loser.lat)},${roundCoord(loser.lng)}`;
    logger(
      `⛽ dedup: "${key}" — kept id=${mergedWinner.id ?? '∅'} (${keptCoord}, upd=${mergedWinner.updatedAt ?? '∅'}) ` +
        `dropped id=${loser.id ?? '∅'} (${droppedCoord}, upd=${loser.updatedAt ?? '∅'})`,
    );
  }

  return { unique: Array.from(byKey.values()), removed };
}
