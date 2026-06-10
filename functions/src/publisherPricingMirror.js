/**
 * Pricing mirror for the Cloud Functions bundle (pure, no Firebase imports).
 *
 * The functions package is deployed in isolation and cannot import the SPA TS
 * module services/publisherPricing.ts. This file is the server-side mirror of
 * its constants + logic. They MUST stay in sync — tests/publisher-pricing-mirror.test.ts
 * asserts equality across unit counts, so any drift fails CI.
 */

export const PRICE_PER_UNIT_CHF = 49;

export const DISCOUNT_TIERS = [
  { minUnits: 1, rate: 0 },
  { minUnits: 3, rate: 0.1 },
  { minUnits: 4, rate: 0.15 },
  { minUnits: 5, rate: 0.2 },
  { minUnits: 6, rate: 0.25 },
  { minUnits: 7, rate: 0.3 },
  { minUnits: 8, rate: 0.35 },
  { minUnits: 9, rate: 0.4 },
];

export function discountRateForUnits(units) {
  if (!Number.isFinite(units) || units <= 0) return 0;
  let rate = 0;
  for (const tier of DISCOUNT_TIERS) {
    if (units >= tier.minUnits) rate = tier.rate;
    else break;
  }
  return rate;
}

/**
 * Distinct billable locations on a publisher_jobs `locations` array.
 * Accepts either {label} objects (PublisherJobLocation) or bare strings.
 */
export function countDistinctLocations(locations) {
  if (!Array.isArray(locations)) return 0;
  const seen = new Set();
  for (const loc of locations) {
    const raw = loc && typeof loc === 'object' && loc.label != null ? loc.label : loc;
    const key = String(raw ?? '').trim().toLowerCase();
    if (key) seen.add(key);
  }
  return seen.size;
}

/** Net CHF for one renewal period given a unit count. */
export function netChfForUnits(units) {
  const safe = Number.isFinite(units) && units > 0 ? Math.floor(units) : 0;
  const gross = safe * PRICE_PER_UNIT_CHF;
  const rate = discountRateForUnits(safe);
  return Math.round((gross * (1 - rate) + Number.EPSILON) * 100) / 100;
}
