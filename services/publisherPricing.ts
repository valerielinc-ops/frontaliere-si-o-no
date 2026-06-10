/**
 * Publisher job-posting pricing — pure, dependency-free.
 *
 * Locked owner decisions (2026-06-10, see docs/PUBLISHER-PORTAL-PLAN.md §0):
 *  - Unit  = one ad in one location = CHF 49 / 30 days, auto-renewing subscription,
 *            newsletter blast included.
 *  - The same ad text published to N locations counts as N billable units (N × 49).
 *  - Volume discount for > 2 units, progressive ("10% a crescere"): see DISCOUNT_TIERS.
 *
 * This module is intentionally free of any framework / Firebase / DOM dependency so it
 * can be imported from the SPA (`@/services/publisherPricing`), a Cloud Function, the
 * Stripe checkout builder, and the test suite without pulling the config graph.
 *
 * All amounts are in CHF. Currency formatting lives in the UI layer, not here.
 */

/** Price of a single ad-in-one-location billing unit, per 30-day renewal. */
export const PRICE_PER_UNIT_CHF = 49;

/** ISO currency code for every publisher charge. */
export const PRICING_CURRENCY = 'CHF';

/** Billing period length in days (Stripe subscription interval). */
export const BILLING_PERIOD_DAYS = 30;

/**
 * Progressive volume discount keyed by total billable units.
 * Decision §0.3: "> 2 ads → 10% a crescere". Concrete default curve:
 *   1–2 → 0% · 3 → 10% · 4 → 15% · 5 → 20% · 6 → 25% · 7 → 30% · 8 → 35% · ≥9 → 40%.
 * Owner can retune this single table without touching any other logic.
 * Each entry: minimum unit count (inclusive) → discount rate (0..1).
 * Must stay sorted ascending by `minUnits`.
 */
export interface DiscountTier {
  readonly minUnits: number;
  readonly rate: number;
}

export const DISCOUNT_TIERS: readonly DiscountTier[] = [
  { minUnits: 1, rate: 0 },
  { minUnits: 3, rate: 0.1 },
  { minUnits: 4, rate: 0.15 },
  { minUnits: 5, rate: 0.2 },
  { minUnits: 6, rate: 0.25 },
  { minUnits: 7, rate: 0.3 },
  { minUnits: 8, rate: 0.35 },
  { minUnits: 9, rate: 0.4 },
];

/** A single ad as configured by the publisher: one ad targeting one or more locations. */
export interface AdSpec {
  /** Stable id for the ad within the cart (any non-empty string). */
  readonly id?: string;
  /** Distinct target locations for this ad. Each location is one billable unit. */
  readonly locations: readonly string[];
}

/** Resolved price breakdown for a publisher order (one renewal period). */
export interface PriceBreakdown {
  /** Total billable units = sum of distinct locations across all ads. */
  readonly units: number;
  /** Units × PRICE_PER_UNIT_CHF, before discount. */
  readonly grossChf: number;
  /** Applied discount rate in 0..1. */
  readonly discountRate: number;
  /** Absolute discount in CHF (rounded to the cent). */
  readonly discountChf: number;
  /** grossChf − discountChf (rounded to the cent). */
  readonly netChf: number;
  /** Effective price per unit after discount (rounded to the cent). */
  readonly effectiveUnitChf: number;
  /** Currency code (always CHF). */
  readonly currency: typeof PRICING_CURRENCY;
  /** Billing cadence in days. */
  readonly periodDays: typeof BILLING_PERIOD_DAYS;
}

/** Round a CHF amount to 2 decimals, avoiding binary float drift (e.g. 1.005). */
function roundChf(amount: number): number {
  return Math.round((amount + Number.EPSILON) * 100) / 100;
}

/**
 * Number of distinct locations for one ad = billable units it contributes.
 * Blank / whitespace-only / duplicate locations (case-insensitive, trimmed) do not
 * double-charge: each real distinct location is exactly one unit.
 */
export function countAdUnits(ad: AdSpec): number {
  if (!ad || !Array.isArray(ad.locations)) return 0;
  const seen = new Set<string>();
  for (const loc of ad.locations) {
    const key = String(loc ?? '').trim().toLowerCase();
    if (key) seen.add(key);
  }
  return seen.size;
}

/** Total billable units across a cart of ads. */
export function countCartUnits(ads: readonly AdSpec[]): number {
  if (!Array.isArray(ads)) return 0;
  return ads.reduce((sum, ad) => sum + countAdUnits(ad), 0);
}

/**
 * Discount rate (0..1) for a given unit count, from DISCOUNT_TIERS.
 * Picks the highest tier whose `minUnits` is ≤ `units`.
 */
export function discountRateForUnits(units: number): number {
  if (!Number.isFinite(units) || units <= 0) return 0;
  let rate = 0;
  for (const tier of DISCOUNT_TIERS) {
    if (units >= tier.minUnits) rate = tier.rate;
    else break;
  }
  return rate;
}

/** Compute the full price breakdown for a given number of billable units. */
export function priceForUnits(units: number): PriceBreakdown {
  const safeUnits = Number.isFinite(units) && units > 0 ? Math.floor(units) : 0;
  const grossChf = roundChf(safeUnits * PRICE_PER_UNIT_CHF);
  const discountRate = discountRateForUnits(safeUnits);
  const discountChf = roundChf(grossChf * discountRate);
  const netChf = roundChf(grossChf - discountChf);
  const effectiveUnitChf = safeUnits > 0 ? roundChf(netChf / safeUnits) : 0;
  return {
    units: safeUnits,
    grossChf,
    discountRate,
    discountChf,
    netChf,
    effectiveUnitChf,
    currency: PRICING_CURRENCY,
    periodDays: BILLING_PERIOD_DAYS,
  };
}

/** Compute the price breakdown for a cart of ads (each ad × its locations). */
export function priceForCart(ads: readonly AdSpec[]): PriceBreakdown {
  return priceForUnits(countCartUnits(ads));
}
