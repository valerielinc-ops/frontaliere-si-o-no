import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { getRalComparatorSwissTaxRate } from '@/components/calculator/RalComparator';
import { getTicinoTaxRate } from '@/services/calculationService';

const HERE = dirname(fileURLToPath(import.meta.url));
const RAL_COMPARATOR = resolve(HERE, '../components/calculator/RalComparator.tsx');

/**
 * Issue #5374 — `RalComparator` carried a THIRD copy of the Ticino A/B barème
 * (found while fixing the second copy in `PermitCompare`, #5375/#5895),
 * calibrated on 14/12 points against the 20/16 of `services/calculationService.ts`.
 * Same interpolation algorithm, different (sparser) tables — measured divergence
 * up to 0.85pt on barème A and 3.7pt on barème B versus the shared source.
 *
 * The golden master below is built from the CHOSEN SOURCE OF TRUTH
 * (`calculationService`, 20/16 points), NOT from `RalComparator` — same reasoning
 * and same values as `tests/permit-compare-tax-source-of-truth.test.ts`, since
 * both wrappers reduce to `getTicinoTaxRate(income, 'SINGLE'|'MARRIED', 0, false)`.
 */

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
 [135000, '16.000'],
 [140000, '16.500'],
 [150000, '17.200'],
 [165000, '18.050'],
 [180000, '18.900'],
 [200000, '19.400'],
 [225000, '21.100'],
 [250000, '22.800'],
 [300000, '24.500'],
 [500000, '28.300'],
 [1000000, '31.500'],
];
const GOLDEN_B: Array<[number, string]> = [
 [0, '0.000'],
 [12500, '0.150'],
 [25000, '0.300'],
 [30000, '0.700'],
 [40000, '1.100'],
 [50000, '1.500'],
 [55000, '2.000'],
 [60000, '2.500'],
 [70000, '3.800'],
 [80000, '5.100'],
 [100000, '8.700'],
 [120000, '10.700'],
 [140000, '12.800'],
 [160000, '14.400'],
 [180000, '15.600'],
 [200000, '16.500'],
 [250000, '20.200'],
 [300000, '22.800'],
 [500000, '26.500'],
];

const pct = (fraction: number) => (fraction * 100).toFixed(3);

/** Source with comments stripped — so the prose ABOUT the old table never satisfies a guard. */
function sourceWithoutComments(): string {
 return readFileSync(RAL_COMPARATOR, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');
}

describe('RalComparator — Ticino barème comes from the single source of truth (#5374)', () => {
 it('SINGLE (barème A) rates match the calculationService golden master', () => {
  for (const [income, expected] of GOLDEN_A) {
   expect(pct(getRalComparatorSwissTaxRate(income, 'SINGLE')), `barème A at CHF ${income}`).toBe(expected);
  }
 });

 it('MARRIED (barème B) rates match the calculationService golden master', () => {
  for (const [income, expected] of GOLDEN_B) {
   expect(pct(getRalComparatorSwissTaxRate(income, 'MARRIED')), `barème B at CHF ${income}`).toBe(expected);
  }
 });

 it('agrees with getTicinoTaxRate at every income from 0 to 300k', () => {
  const mismatches: string[] = [];
  for (let income = 0; income <= 300_000; income += 500) {
   const single = getRalComparatorSwissTaxRate(income, 'SINGLE');
   const married = getRalComparatorSwissTaxRate(income, 'MARRIED');
   const refA = getTicinoTaxRate(income, 'SINGLE', 0, false).rate;
   const refB = getTicinoTaxRate(income, 'MARRIED', 0, false).rate;
   if (single !== refA) mismatches.push(`A@${income}: ${pct(single)} vs ${pct(refA)}`);
   if (married !== refB) mismatches.push(`B@${income}: ${pct(married)} vs ${pct(refB)}`);
  }
  expect(mismatches.slice(0, 10), 'RalComparator diverged from calculationService').toEqual([]);
 });

 it('declares no local interpolation table or interpolate helper', () => {
  const src = sourceWithoutComments();
  expect(/\[\s*\[\s*0\s*,\s*0\s*\]\s*,/.test(src), 'a local point table was reintroduced').toBe(false);
  expect(/(?:function|const|let|var)\s+interpolate\b/.test(src), 'a local interpolate() was reintroduced').toBe(false);
  expect(src.includes('getTicinoTaxRate'), 'must consume calculationService').toBe(true);
 });
});
