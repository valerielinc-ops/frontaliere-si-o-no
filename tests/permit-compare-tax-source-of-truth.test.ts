import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { getPermitGSwissTaxRate, getPermitBSwissTaxRate } from '@/components/guide/PermitCompare';
import { getTicinoTaxRate } from '@/services/calculationService';

const HERE = dirname(fileURLToPath(import.meta.url));
const PERMIT_COMPARE = resolve(HERE, '../components/guide/PermitCompare.tsx');

/**
 * Issue #5375 — `PermitCompare` carried a SECOND copy of the Ticino A/B barème,
 * calibrated on 7 points against the 20 of `services/calculationService.ts`.
 * Same interpolation algorithm, different tables, so the same gross salary showed
 * one withholding rate in `TaxCreditCalculator`/`WithholdingRatesHub` and another
 * in `PermitCompare` — in production, on the same site, for the same G/B comparison.
 *
 * The golden master below is built from the CHOSEN SOURCE OF TRUTH
 * (`calculationService`, 20 points), NOT from `PermitCompare`. Deriving it from the
 * code under change would have frozen the 7-point table, i.e. the wrong number.
 *
 * Scope note, stated honestly: NEITHER table cites an official source — the comment
 * at `calculationService.ts:9` says only "Approximation via Interpolation Points 2026".
 * These tests assert that the two copies AGREE, not that they are CORRECT. Whether
 * the points match the real Ticino barème is an open question for the owner.
 */

// Golden master: rate in PERCENT, from the 20-point tables of calculationService.
// Hardcoded on purpose — computing them from the tables at test time would make the
// test agree with any future edit to those tables instead of pinning today's output.
//
// Coverage rule: every segment of both tables gets BOTH knots and one interior
// (midpoint) sample, plus the two clamps. That density is not cosmetic. The
// "agrees with getTicinoTaxRate" test below is a CONSISTENCY check — it compares two
// callers of the same helper, so a bug inside the shared helper keeps both sides
// equal and slips through. The golden master is the only thing standing under
// `interpolate` itself, and a sparse one has blind spots: an off-by-one that
// skipped the first segment (`let i = 1`) left barème A below CHF 17.000 and barème
// B below CHF 25.000 returning 0, and an earlier version of this file passed it
// because it sampled no income in those bands.
const GOLDEN_A: Array<[number, string]> = [
 [0, '0.000'],
 [8500, '0.100'],
 [17000, '0.200'],
 [21000, '1.100'],
 [25000, '2.000'],
 [27500, '2.600'],
 [30000, '3.200'],
 [35000, '4.200'],
 [40000, '5.200'],
 [45000, '5.600'],
 [50000, '6.000'],
 [55000, '7.250'],
 [60000, '8.500'],
 [70000, '9.900'],
 [80000, '11.300'],
 [90000, '12.250'],
 [100000, '13.200'],
 [110000, '14.050'],
 [120000, '14.900'],
 [125000, '15.300'],
 [130000, '15.700'],
 [132500, '15.850'],
 [135000, '16.000'],
 [137500, '16.250'],
 [140000, '16.500'],
 [145000, '16.850'],
 [150000, '17.200'],
 [165000, '18.050'],
 [180000, '18.900'],
 [190000, '19.150'],
 [200000, '19.400'],
 [225000, '21.100'],
 [250000, '22.800'],
 [275000, '23.650'],
 [300000, '24.500'],
 [400000, '26.400'],
 [500000, '28.300'],
 [750000, '29.900'],
 [1000000, '31.500'],
 [1050000, '31.500'],
];
const GOLDEN_B: Array<[number, string]> = [
 [0, '0.000'],
 [12500, '0.150'],
 [25000, '0.300'],
 [27500, '0.500'],
 [30000, '0.700'],
 [35000, '0.900'],
 [40000, '1.100'],
 [45000, '1.300'],
 [50000, '1.500'],
 [55000, '2.000'],
 [60000, '2.500'],
 [70000, '3.800'],
 [80000, '5.100'],
 [90000, '6.900'],
 [100000, '8.700'],
 [110000, '9.700'],
 [120000, '10.700'],
 [130000, '11.750'],
 [140000, '12.800'],
 [150000, '13.600'],
 [160000, '14.400'],
 [170000, '15.000'],
 [180000, '15.600'],
 [190000, '16.050'],
 [200000, '16.500'],
 [225000, '18.350'],
 [250000, '20.200'],
 [275000, '21.500'],
 [300000, '22.800'],
 [400000, '24.650'],
 [500000, '26.500'],
 [550000, '26.500'],
];

const pct = (fraction: number) => (fraction * 100).toFixed(3);

/** Source with comments stripped — so the prose ABOUT the old table never satisfies a guard. */
function sourceWithoutComments(): string {
 return readFileSync(PERMIT_COMPARE, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');
}

describe('PermitCompare — Ticino barème comes from the single source of truth (#5375)', () => {
 it('permit G rates match the calculationService golden master', () => {
  for (const [income, expected] of GOLDEN_A) {
   expect(pct(getPermitGSwissTaxRate(income)), `barème A at CHF ${income}`).toBe(expected);
  }
 });

 it('permit B rates match the calculationService golden master', () => {
  for (const [income, expected] of GOLDEN_B) {
   expect(pct(getPermitBSwissTaxRate(income)), `barème B at CHF ${income}`).toBe(expected);
  }
 });

 // The anti-divergence property. A re-forked local table passes the golden master
 // only if it reproduces it exactly at every one of these incomes — which a
 // 7-point recalibration cannot do. This sweep is what makes a fork detectable
 // between the golden-master anchor points.
 it('agrees with getTicinoTaxRate at every income from 0 to 300k', () => {
  const mismatches: string[] = [];
  for (let income = 0; income <= 300_000; income += 500) {
   const g = getPermitGSwissTaxRate(income);
   const b = getPermitBSwissTaxRate(income);
   const refG = getTicinoTaxRate(income, 'SINGLE', 0, false).rate;
   const refB = getTicinoTaxRate(income, 'MARRIED', 0, false).rate;
   if (g !== refG) mismatches.push(`A@${income}: ${pct(g)} vs ${pct(refG)}`);
   if (b !== refB) mismatches.push(`B@${income}: ${pct(b)} vs ${pct(refB)}`);
  }
  expect(mismatches.slice(0, 10), 'PermitCompare diverged from calculationService').toEqual([]);
 });

 it('declares no local interpolation table or interpolate helper', () => {
  const src = sourceWithoutComments();
  // Every barème point table in this codebase starts with the [0, 0] origin pair.
  expect(/\[\s*\[\s*0\s*,\s*0\s*\]\s*,/.test(src), 'a local point table was reintroduced').toBe(false);
  expect(/(?:function|const|let|var)\s+interpolate\b/.test(src), 'a local interpolate() was reintroduced').toBe(false);
  expect(src.includes('getTicinoTaxRate'), 'must consume calculationService').toBe(true);
 });

 it('takes the franchigia from @/constants, not a bare literal', () => {
  const src = sourceWithoutComments();
  expect(src.includes('FRANCHIGIA_NUOVI_FRONTALIERI')).toBe(true);
  // Both former sites (`const franchigia = 10000` and `grossEUR - 10000`) are gone.
  expect(/\b10000\b/.test(src), 'a bare 10000 franchigia literal is back').toBe(false);
 });
});
