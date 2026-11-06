/**
 * Guard against silent regression of the salary category → sector lookup
 * (issue #6230): a stale/incomplete CATEGORY_TO_SECTOR silently overflows
 * onto the Logistics fallback instead of failing loudly. This computes the
 * fallback rate on a snapshot of real observed category labels and fails
 * above a threshold, printing the rate every run so the threshold can be
 * tightened against measured data instead of intuition.
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

import { NORMALIZED_CATEGORY_TO_SECTOR, normalizeCategoryKey } from '../scripts/lib/salary-estimation.mjs';

const FIXTURE = JSON.parse(
  readFileSync(new URL('./fixtures/salary-category-corpus-snapshot.json', import.meta.url), 'utf8')
);

// Measured 2026-08-21 (issue #6230): 70.2% before the fix, ~10.3% after.
// Kept well above the measured rate to avoid flakiness on corpus drift,
// well below the pre-fix rate to still catch a real regression.
const MAX_FALLBACK_RATE = 0.35;

describe('salary category → sector fallback rate (guard, issue #6230)', () => {
  it('stays below the regression threshold on the observed category corpus', () => {
    let total = 0;
    let fallback = 0;
    for (const { category, count } of FIXTURE.categories) {
      total += count;
      const key = normalizeCategoryKey(category);
      if (!NORMALIZED_CATEGORY_TO_SECTOR[key]) fallback += count;
    }
    const rate = fallback / total;
    // eslint-disable-next-line no-console
    console.log(`salary category fallback rate: ${(rate * 100).toFixed(1)}% (${fallback}/${total} postings)`);
    expect(rate).toBeLessThan(MAX_FALLBACK_RATE);
  });
});
