import { describe, it, expect } from 'vitest';
import {
  PRICE_PER_UNIT_CHF,
  PRICING_CURRENCY,
  BILLING_PERIOD_DAYS,
  DISCOUNT_TIERS,
  countAdUnits,
  countCartUnits,
  discountRateForUnits,
  priceForUnits,
  priceForCart,
} from '../services/publisherPricing';

describe('publisherPricing — units', () => {
  it('charges one unit per distinct location', () => {
    expect(countAdUnits({ locations: ['Lugano'] })).toBe(1);
    expect(countAdUnits({ locations: ['Lugano', 'Locarno'] })).toBe(2);
  });

  it('dedupes blank/duplicate/case-variant locations', () => {
    expect(countAdUnits({ locations: ['Lugano', 'lugano ', '  ', ''] })).toBe(1);
    expect(countAdUnits({ locations: [] })).toBe(0);
    // @ts-expect-error guard against malformed input
    expect(countAdUnits({})).toBe(0);
  });

  it('sums units across a cart (same ad in N locations = N units)', () => {
    const cart = [
      { id: 'fisio', locations: ['Lugano', 'Locarno'] }, // 2 units
      { id: 'segr', locations: ['Bellinzona'] }, // 1 unit
    ];
    expect(countCartUnits(cart)).toBe(3);
  });

  it('handles empty / malformed carts', () => {
    expect(countCartUnits([])).toBe(0);
    expect(countCartUnits(null as unknown as never[])).toBe(0);
  });
});

describe('publisherPricing — discount tiers', () => {
  it('no discount for 1–2 units', () => {
    expect(discountRateForUnits(1)).toBe(0);
    expect(discountRateForUnits(2)).toBe(0);
  });

  it('progressive discount > 2 units, matching the locked table', () => {
    expect(discountRateForUnits(3)).toBe(0.1);
    expect(discountRateForUnits(4)).toBe(0.15);
    expect(discountRateForUnits(5)).toBe(0.2);
    expect(discountRateForUnits(6)).toBe(0.25);
    expect(discountRateForUnits(7)).toBe(0.3);
    expect(discountRateForUnits(8)).toBe(0.35);
    expect(discountRateForUnits(9)).toBe(0.4);
  });

  it('caps at the highest tier for large counts', () => {
    expect(discountRateForUnits(50)).toBe(0.4);
  });

  it('ignores non-positive / non-finite counts', () => {
    expect(discountRateForUnits(0)).toBe(0);
    expect(discountRateForUnits(-3)).toBe(0);
    expect(discountRateForUnits(NaN)).toBe(0);
  });

  it('DISCOUNT_TIERS stays sorted ascending by minUnits', () => {
    for (let i = 1; i < DISCOUNT_TIERS.length; i++) {
      expect(DISCOUNT_TIERS[i].minUnits).toBeGreaterThan(DISCOUNT_TIERS[i - 1].minUnits);
    }
  });
});

describe('publisherPricing — price breakdown', () => {
  it('uses CHF 49 per unit with no discount below 3 units', () => {
    const one = priceForUnits(1);
    expect(one.grossChf).toBe(49);
    expect(one.discountChf).toBe(0);
    expect(one.netChf).toBe(49);
    expect(one.effectiveUnitChf).toBe(49);
    expect(one.currency).toBe(PRICING_CURRENCY);
    expect(one.periodDays).toBe(BILLING_PERIOD_DAYS);

    const two = priceForUnits(2);
    expect(two.grossChf).toBe(98);
    expect(two.netChf).toBe(98);
  });

  it('applies the 10% tier at 3 units', () => {
    const three = priceForUnits(3);
    expect(three.units).toBe(3);
    expect(three.grossChf).toBe(147); // 3 × 49
    expect(three.discountRate).toBe(0.1);
    expect(three.discountChf).toBe(14.7);
    expect(three.netChf).toBe(132.3);
    expect(three.effectiveUnitChf).toBe(44.1);
  });

  it('applies higher tiers correctly (5 units → 20%)', () => {
    const five = priceForUnits(5);
    expect(five.grossChf).toBe(245); // 5 × 49
    expect(five.discountRate).toBe(0.2);
    expect(five.discountChf).toBe(49);
    expect(five.netChf).toBe(196);
  });

  it('zero/negative/fractional units degrade safely', () => {
    expect(priceForUnits(0).netChf).toBe(0);
    expect(priceForUnits(0).effectiveUnitChf).toBe(0);
    expect(priceForUnits(-5).units).toBe(0);
    expect(priceForUnits(2.9).units).toBe(2); // floored
  });

  it('exposes the per-unit constant', () => {
    expect(PRICE_PER_UNIT_CHF).toBe(49);
  });
});

describe('publisherPricing — cart pricing (PhysioMedical-style)', () => {
  it('prices the PhysioMedical lead: fisio in Lugano + Locarno = 2 units, no discount', () => {
    // "due fisioterapisti per Lugano ed uno per Locarno" → one ad text, 2 distinct locations
    const cart = [{ id: 'fisioterapista', locations: ['Lugano', 'Locarno'] }];
    const p = priceForCart(cart);
    expect(p.units).toBe(2);
    expect(p.netChf).toBe(98);
    expect(p.discountRate).toBe(0);
  });

  it('a 3rd location would unlock the first discount tier', () => {
    const cart = [{ id: 'fisioterapista', locations: ['Lugano', 'Locarno', 'Bellinzona'] }];
    const p = priceForCart(cart);
    expect(p.units).toBe(3);
    expect(p.discountRate).toBe(0.1);
    expect(p.netChf).toBe(132.3);
  });
});
