/**
 * Direction guard for the exchange-rate FALLBACKS (#5388).
 *
 * `services/exchangeRateService.ts` is the app's single source of truth for the
 * CHF→EUR rate, and every one of its live sources produces that direction:
 *
 *   - fetchFromTwelveData() → the getExchangeRate Cloud Function, which queries
 *     `api.twelvedata.com/exchange_rate?symbol=CHF/EUR` (functions/src/exchangeRate.js:12);
 *   - fetchEcbHistory() → `1 / obsValue` over `D.CHF.EUR.SP00.A`, the division
 *     existing precisely to land in this direction;
 *   - fetchFrankfurter() → `base=CHF&quotes=EUR`;
 *   - the Firestore doc `config/exchange_rate`, whose committed daily snapshot
 *     (data/exchange-rate-snapshot.json) reads `currentRate: ~1.07`;
 *   - and every consumer MULTIPLIES a CHF amount by the rate
 *     (`grossMonthlyCHF * exchangeRate`, calculationService.ts:438), with the UI
 *     labelling it `1 CHF = {rate} EUR` (InputCard.tsx).
 *
 * The two FALLBACKS, however, shipped the reciprocal:
 *
 *   services/exchangeRateService.ts:21        const DEFAULT_RATE = 0.94;
 *   components/calculator/NaspiCalculator.tsx const FALLBACK_EXCHANGE_RATE = 0.95;
 *
 * DEFAULT_RATE is not decorative: it is the initial state of `useExchangeRate()`
 * on a cold cache — i.e. the number EVERY new visitor's first render uses — and
 * the terminal value when Firestore, TwelveData and localStorage all fail. So a
 * fresh visitor saw euro figures ~12-14% below the ones that appeared a moment
 * later, with no error anywhere.
 *
 * A value guard alone would not have prevented this: 0.94 IS a real CHF/EUR
 * quotation, just of the opposite pair. What discriminates is the DIRECTION —
 * a CHF→EUR rate is above 1 — plus agreement with the live path's own number.
 * That is what this file pins, at both fallback sites.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { renderHook, waitFor } from '@testing-library/react';
import { DEFAULT_EXCHANGE_RATE } from '@/constants';
import { calculateNaspi } from '@/services/calculationService';
import exchangeSnapshot from '../data/exchange-rate-snapshot.json';

const MODULE = '@/services/exchangeRateService';
const REPO_ROOT = path.resolve(__dirname, '..');

/** The rate the live path actually produced the last time it ran, from the committed snapshot. */
const LIVE_RATE = (exchangeSnapshot as { currentRate: number }).currentRate;

/** The two literals that shipped before this fix — used to prove the guards discriminate. */
const PRE_FIX_SERVICE_RATE = 0.94;
const PRE_FIX_NASPI_RATE = 0.95;

const relGap = (a: number, b: number): number => Math.abs(a - b) / b;

/** Extracts `<NAME> = <number>` at module scope, or null when it is not a literal. */
function literalAssignedTo(relPath: string, name: string): number | null {
  const src = fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
  const m = new RegExp(`^const\\s+${name}\\s*=\\s*([^;]+);`, 'm').exec(src);
  expect(m, `${name} must still be declared at module scope in ${relPath}`).not.toBeNull();
  const rhs = m![1].trim();
  return /^-?\d+(\.\d+)?$/.test(rhs) ? Number(rhs) : null;
}

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

afterEach(() => {
  localStorage.clear();
});

describe('the shared default holds the CHF→EUR direction', () => {
  it('is above 1, and inside a plausible band', () => {
    // 1 CHF buys more than 1 EUR — has for years. Below 1 means the direction
    // flipped, not that the market moved; above 1.3 means the number is not a
    // CHF/EUR quotation at all.
    expect(typeof DEFAULT_EXCHANGE_RATE).toBe('number');
    expect(DEFAULT_EXCHANGE_RATE).toBeGreaterThan(1);
    expect(DEFAULT_EXCHANGE_RATE).toBeLessThan(1.3);
  });

  it('agrees with the number the live path itself last produced', () => {
    // data/exchange-rate-snapshot.json is written by scripts/snapshot-exchange-history.mjs
    // from Firestore `config/exchange_rate` — the very doc fetchExchangeRate()
    // reads. If the fallback and that value disagree by much, the fallback is
    // not a stale rate: it is a different quantity.
    expect(LIVE_RATE).toBeGreaterThan(1);
    expect(relGap(DEFAULT_EXCHANGE_RATE, LIVE_RATE)).toBeLessThan(0.08);
  });

  it('rejects the two literals that actually shipped (guard is not vacuous)', () => {
    expect(PRE_FIX_SERVICE_RATE).toBeLessThan(1);
    expect(PRE_FIX_NASPI_RATE).toBeLessThan(1);
    // Both are >8% away from the live rate, so the band check above fails them too.
    expect(relGap(PRE_FIX_SERVICE_RATE, LIVE_RATE)).toBeGreaterThan(0.08);
    expect(relGap(PRE_FIX_NASPI_RATE, LIVE_RATE)).toBeGreaterThan(0.08);
  });
});

describe('exchangeRateService — the terminal fallback', () => {
  it('resolves to the shared default, in the right direction, when every source fails', async () => {
    // IS_TEST_ENV makes getFirestoreRate/fetchFromTwelveData return null, and
    // localStorage is empty — exactly the all-sources-down path.
    const mod = await import(MODULE);
    const rate = await mod.fetchExchangeRate();
    expect(mod.getRateSource()).toBe('fallback');
    expect(rate).toBe(DEFAULT_EXCHANGE_RATE);
    expect(rate).toBeGreaterThan(1);
  });

  it('does not re-introduce a sub-1 literal for DEFAULT_RATE', () => {
    // The fix imports the constant instead of re-typing it; a future edit that
    // pastes a number back in is caught here even if it never runs.
    const literal = literalAssignedTo('services/exchangeRateService.ts', 'DEFAULT_RATE');
    if (literal !== null) expect(literal).toBeGreaterThan(1);
    const src = fs.readFileSync(path.join(REPO_ROOT, 'services/exchangeRateService.ts'), 'utf8');
    expect(src).toMatch(/import\s*\{[^}]*\bDEFAULT_EXCHANGE_RATE\b[^}]*\}\s*from\s*['"]@\/constants['"]/);
  });
});

describe('the cold-cache window — first render vs the value a moment later', () => {
  it('useExchangeRate() opens on the same number it settles on', async () => {
    const mod = await import(MODULE);
    const { result, unmount } = renderHook(() => mod.useExchangeRate());

    // First render, before the effect's fetch has resolved: what a brand new
    // visitor sees for the first few hundred ms.
    const firstPaint = result.current.rate;

    await waitFor(() => expect(result.current.lastUpdate).not.toBeNull());
    const settled = result.current.rate;

    // The defect was a visible jump between these two.
    expect(firstPaint).toBe(settled);
    // …and both must be the live direction, not just equal to each other:
    // pre-fix they were also equal (0.94 → 0.94) whenever every source failed,
    // yet both were the wrong way round.
    expect(firstPaint).toBeGreaterThan(1);
    expect(relGap(firstPaint, LIVE_RATE)).toBeLessThan(0.08);

    unmount();
  });

  it('a cached rate still wins over the default on the first render (fast path intact)', async () => {
    // Proves the assertion above is about the DEFAULT and not about the hook
    // ignoring its cache: with a cache entry present, the first paint is that
    // entry, not DEFAULT_EXCHANGE_RATE.
    localStorage.setItem('exchange_rate_cache', JSON.stringify({
      rate: 1.0421,
      timestamp: Date.now(),
      source: 'twelvedata',
    }));
    const mod = await import(MODULE);
    const { result, unmount } = renderHook(() => mod.useExchangeRate());
    expect(result.current.rate).toBe(1.0421);
    await waitFor(() => expect(result.current.lastUpdate).not.toBeNull());
    expect(result.current.rate).toBe(1.0421);
    unmount();
  });
});

describe('NaspiCalculator — the same fallback, the same direction', () => {
  it('consumes the shared constant instead of its own literal', () => {
    const rel = path.join('components', 'calculator', 'NaspiCalculator.tsx');
    const src = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
    expect(src).toMatch(/import\s*\{[^}]*\bDEFAULT_EXCHANGE_RATE\b[^}]*\}\s*from\s*['"]@\/constants['"]/);
    const literal = literalAssignedTo(rel, 'FALLBACK_EXCHANGE_RATE');
    if (literal !== null) expect(literal).toBeGreaterThan(1);
  });

  it('produces a NASpI figure consistent with the live rate, which the old literal did not', () => {
    // 2500 CHF/month keeps the result off the €1,584.70 monthly cap in both
    // scenarios — above the cap every rate collapses to the same number and the
    // comparison would be vacuous. Asserted, not assumed.
    const SALARY_CHF = 2500;
    const MONTHS = 24;
    const AGE = 35;
    const withLive = calculateNaspi(SALARY_CHF, MONTHS, AGE, LIVE_RATE).monthlyInitial;
    const withFallback = calculateNaspi(SALARY_CHF, MONTHS, AGE, DEFAULT_EXCHANGE_RATE).monthlyInitial;
    const withPreFix = calculateNaspi(SALARY_CHF, MONTHS, AGE, PRE_FIX_NASPI_RATE).monthlyInitial;

    expect(withLive).toBeLessThan(1584.7);
    expect(withFallback).toBeLessThan(1584.7);
    expect(withPreFix).toBeLessThan(1584.7);

    expect(relGap(withFallback, withLive)).toBeLessThan(0.03);
    // The literal that shipped is off by enough to be a different euro figure
    // on screen — which is the user-visible half of #5388.
    expect(relGap(withPreFix, withLive)).toBeGreaterThan(0.03);
  });
});
