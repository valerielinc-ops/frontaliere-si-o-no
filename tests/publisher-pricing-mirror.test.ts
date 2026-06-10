/**
 * Drift guard: the Cloud Functions pricing mirror (JS, deployed in isolation)
 * MUST produce identical results to the SPA TS module. Any divergence in the
 * unit price or DISCOUNT_TIERS fails here.
 */
import { describe, it, expect } from 'vitest';
import {
  PRICE_PER_UNIT_CHF as TS_PRICE,
  discountRateForUnits as tsRate,
  priceForUnits,
} from '../services/publisherPricing';
import {
  PRICE_PER_UNIT_CHF as JS_PRICE,
  discountRateForUnits as jsRate,
  netChfForUnits as jsNet,
  countDistinctLocations as jsCount,
} from '../functions/src/publisherPricingMirror.js';

describe('publisher pricing mirror parity (TS ⇄ functions JS)', () => {
  it('shares the same per-unit price', () => {
    expect(JS_PRICE).toBe(TS_PRICE);
  });

  it('produces identical discount rate + net total for 0..12 units', () => {
    for (let units = 0; units <= 12; units++) {
      expect(jsRate(units)).toBe(tsRate(units));
      expect(jsNet(units)).toBe(priceForUnits(units).netChf);
    }
  });

  it('mirror location counter dedupes like the TS one', () => {
    expect(jsCount([{ label: 'Lugano' }, { label: 'lugano ' }, { label: '' }])).toBe(1);
    expect(jsCount(['Lugano', 'Locarno'])).toBe(2);
    expect(jsCount(null)).toBe(0);
  });
});
