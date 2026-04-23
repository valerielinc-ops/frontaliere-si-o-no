/**
 * Fuel-station deduplication (AE-9).
 *
 * The upstream TCS Firestore feed occasionally emits >1 document for the
 * same physical petrol station. Observed root cause: coordinate drift (two
 * imports with latitudes diverging by ~0.005°) combined with stable
 * brand/name/address strings. This produces downstream duplicates:
 *
 *   - `/prezzi-diesel/stazione/eni-caslano/`
 *   - `/prezzi-diesel/stazione/eni-caslano-2/`
 *
 * Both point to the same real-world station ("Eni, Via Cantonale 36, 6987
 * Caslano"), which Google classes as a cannibalization cluster.
 *
 * This helper canonicalises stations by (brand + name + address) after
 * Unicode normalisation + whitespace collapse, with lat/lng rounded to 4
 * decimal places (~11 m precision) as a tie-breaking safety net when brand
 * or address strings drift across scrapes.
 *
 * Tie-breaker for duplicates: keep the record with the most-recent
 * `updatedAt` (or `dieselUpdatedAt`). If still ambiguous, keep the first
 * one seen — stable, deterministic output.
 */

/**
 * Normalise a free-form string for comparison.
 * - NFD normalise → strip combining marks (diacritics)
 * - lowercase
 * - collapse any run of non-alphanumerics to a single space
 * - trim
 */
export function normalizeField(value) {
  if (value == null) return '';
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Round lat/lng to N decimals. 4 decimals ≈ 11 m at the equator. */
export function roundCoord(value, digits = 4) {
  if (value == null || !Number.isFinite(Number(value))) return null;
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}

/**
 * Canonical dedup key for a fuel station.
 *
 * Primary identity: (normBrand | normName | normAddress).
 * Secondary (coord) fallback: when name/address are blank or match the
 * placeholder "UNDEFINED", fall back to (brand | roundedLat | roundedLng)
 * so two records with stable brand + ≤ ~11 m coordinate drift merge.
 *
 * We intentionally do NOT include the raw Firestore id in the key — the
 * whole point is to merge records whose ids differ.
 */
export function stationDedupKey(station) {
  const brand = normalizeField(station?.brand);
  const name = normalizeField(station?.name);
  const address = normalizeField(station?.address);

  if (name || address) {
    return `nba|${brand}|${name}|${address}`;
  }

  const lat = roundCoord(station?.lat);
  const lng = roundCoord(station?.lng);
  return `coord|${brand}|${lat ?? 'x'}|${lng ?? 'x'}`;
}

/**
 * Timestamp recency helper — returns a number (ms since epoch) or -Infinity
 * when no usable timestamp is present. Higher = fresher.
 */
function recencyScore(station) {
  const raw = station?.updatedAt || station?.dieselUpdatedAt || null;
  if (!raw) return Number.NEGATIVE_INFINITY;
  const t = Date.parse(String(raw));
  return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY;
}

/** Prefer the record with a real diesel price over a null-diesel twin. */
function completenessScore(station) {
  let score = 0;
  if (Number.isFinite(Number(station?.sp95PriceChf))) score += 1;
  if (Number.isFinite(Number(station?.dieselPriceChf))) score += 1;
  if (station?.address) score += 1;
  if (station?.name) score += 1;
  return score;
}

/**
 * Pick the winner between two records with the same dedup key.
 *
 * Priority:
 *   1. Higher completeness (more non-null price fields + metadata).
 *   2. Higher recency score (most-recent updatedAt).
 *   3. Stable: keep the existing (first-seen) record.
 */
function pickWinner(existing, candidate) {
  const cExisting = completenessScore(existing);
  const cCandidate = completenessScore(candidate);
  if (cCandidate > cExisting) return candidate;
  if (cCandidate < cExisting) return existing;
  const rExisting = recencyScore(existing);
  const rCandidate = recencyScore(candidate);
  if (rCandidate > rExisting) return candidate;
  return existing;
}

/**
 * Dedupe a list of fuel stations in-place-safe (returns a new array).
 *
 * @param {Array<object>} stations - Raw station records from the TCS feed.
 * @param {{ logger?: (msg: string) => void }} [options]
 * @returns {Array<object>} Deduped station list, original order preserved
 *   for the first occurrence of each dedup key.
 */
export function dedupFuelStations(stations, options = {}) {
  const logger = options.logger || ((msg) => console.warn(msg));
  if (!Array.isArray(stations)) return [];

  const byKey = new Map();
  const collisions = [];

  for (const station of stations) {
    if (!station || typeof station !== 'object') continue;
    const key = stationDedupKey(station);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, station);
      continue;
    }
    const winner = pickWinner(existing, station);
    const loser = winner === existing ? station : existing;
    byKey.set(key, winner);
    collisions.push({
      key,
      winnerId: winner?.id ?? null,
      loserId: loser?.id ?? null,
      name: winner?.name ?? winner?.brand ?? '(unnamed)',
      address: winner?.address ?? null,
    });
  }

  if (collisions.length > 0) {
    logger(
      `⛽ fuel-station dedup: merged ${collisions.length} duplicate record(s):`,
    );
    for (const c of collisions) {
      logger(
        `   - "${c.name}" @ ${c.address ?? '—'}: kept ${c.winnerId}, dropped ${c.loserId}`,
      );
    }
  }

  return Array.from(byKey.values());
}
