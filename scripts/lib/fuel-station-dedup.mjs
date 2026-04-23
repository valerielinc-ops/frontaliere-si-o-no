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
 *   - unicode NFKC
 *   - lowercase
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
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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

  const aDiesel = Number.isFinite(Number(a.dieselPriceChf));
  const bDiesel = Number.isFinite(Number(b.dieselPriceChf));
  if (aDiesel !== bDiesel) return bDiesel ? b : a;

  // Stable lexicographic id tiebreak
  const aId = String(a.id ?? '');
  const bId = String(b.id ?? '');
  return bId < aId ? b : a;
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
    byKey.set(key, winner);
    removed.push({
      key,
      kept: String(winner.id ?? '∅'),
      dropped: String(loser.id ?? '∅'),
    });
    const keptCoord = `${roundCoord(winner.lat)},${roundCoord(winner.lng)}`;
    const droppedCoord = `${roundCoord(loser.lat)},${roundCoord(loser.lng)}`;
    logger(
      `⛽ dedup: "${key}" — kept id=${winner.id ?? '∅'} (${keptCoord}, upd=${winner.updatedAt ?? '∅'}) ` +
        `dropped id=${loser.id ?? '∅'} (${droppedCoord}, upd=${loser.updatedAt ?? '∅'})`,
    );
  }

  return { unique: Array.from(byKey.values()), removed };
}
