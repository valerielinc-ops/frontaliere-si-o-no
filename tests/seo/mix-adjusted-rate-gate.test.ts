/**
 * mix-adjusted-rate-gate.test.ts
 *
 * Direct unit coverage for scripts/lib/mixAdjustedRateGate.mjs — the shared
 * composition-shift-neutral total-rate check used by both
 * audit-text-html-ratio.mjs and audit-title-length.mjs to fix the recurring
 * class of false regression where an accepted-thin feature growing its
 * SHARE of total pages drags a flat historical blended baseline rate
 * upward with zero per-feature quality change (incident #3232).
 */
import { describe, expect, it } from 'vitest';
import { computeMixAdjustedTotalCap, evaluateMixAdjustedTotalRegression } from '../../scripts/lib/mixAdjustedRateGate.mjs';

const TOL = { relPct: 20, absPp: 1.0, minAbsDelta: 5, maxDeltaPp: 3 };

describe('computeMixAdjustedTotalCap', () => {
  it('weights current scanned counts against baseline per-feature rates, not a flat blend', () => {
    const { expectedTotalRate } = computeMixAdjustedTotalCap({
      scannedByFeature: { a: 100, b: 400 },
      baseByFeature: { a: { ratePct: 5 }, b: { ratePct: 50 } },
      tol: TOL,
    });
    // (100*5 + 400*50) / 500 / 100 * 100 = (500 + 20000) / 500 = 41
    expect(expectedTotalRate).toBeCloseTo(41, 5);
  });

  it('treats a feature absent from baseline as 0 expected contribution', () => {
    const { expectedOffenders, expectedTotalRate } = computeMixAdjustedTotalCap({
      scannedByFeature: { a: 100, newFeature: 50 },
      baseByFeature: { a: { ratePct: 10 } },
      tol: TOL,
    });
    expect(expectedOffenders).toBeCloseTo(10, 5); // 100*10/100 + 50*0
    expect(expectedTotalRate).toBeCloseTo(10 / 150 * 100, 5);
  });

  // #3607: the inverse case — a baseline feature bucket absent from the
  // CURRENT scan (e.g. a partial BFS walk that never reached that template
  // category). Previously this silently contributed 0 to both
  // expectedOffenders and totalScanned, quietly lowering the expected total
  // instead of flagging that the scan itself is incomplete.
  it('flags a baseline feature missing from the current scan as an incomplete-scan signal', () => {
    const { missingFeatures } = computeMixAdjustedTotalCap({
      scannedByFeature: { a: 100 },
      baseByFeature: { a: { ratePct: 10, scanned: 100 }, b: { ratePct: 20, scanned: 500 } },
      tol: TOL,
    });
    expect(missingFeatures).toEqual(['b']);
  });

  it('does NOT flag a baseline feature that legitimately had zero scanned pages historically', () => {
    const { missingFeatures } = computeMixAdjustedTotalCap({
      scannedByFeature: { a: 100 },
      baseByFeature: { a: { ratePct: 10, scanned: 100 }, retired: { ratePct: 0, scanned: 0 } },
      tol: TOL,
    });
    expect(missingFeatures).toEqual([]);
  });

  it('does not flag when every baseline feature is present in the current scan', () => {
    const { missingFeatures } = computeMixAdjustedTotalCap({
      scannedByFeature: { a: 100, b: 400 },
      baseByFeature: { a: { ratePct: 5, scanned: 90 }, b: { ratePct: 50, scanned: 380 } },
      tol: TOL,
    });
    expect(missingFeatures).toEqual([]);
  });
});

describe('evaluateMixAdjustedTotalRegression', () => {
  it('PASS: mix shift toward a thin-but-flat-rate feature', () => {
    const r = evaluateMixAdjustedTotalRegression({
      scannedByFeature: { a: 100, b: 400 },
      baseByFeature: { a: { ratePct: 5 }, b: { ratePct: 50 } },
      tol: TOL,
      actualOffenders: 205, // a: 5, b: 200 — both exactly at baseline rate
      actualScanned: 500,
    });
    expect(r.regression).toBe(false);
  });

  it('FAIL: actual rate exceeds mix-adjusted expectation beyond tolerance + absolute floor', () => {
    const r = evaluateMixAdjustedTotalRegression({
      scannedByFeature: { a: 100, b: 400 },
      baseByFeature: { a: { ratePct: 5 }, b: { ratePct: 50 } },
      tol: TOL,
      actualOffenders: 300, // well above expected 205, real widespread creep
      actualScanned: 500,
    });
    expect(r.regression).toBe(true);
  });

  it('AND-condition guard: rate over cap but absolute count within minAbsDelta noise floor → PASS', () => {
    const r = evaluateMixAdjustedTotalRegression({
      scannedByFeature: { a: 100 },
      baseByFeature: { a: { ratePct: 5 } },
      tol: TOL,
      actualOffenders: 8, // expected 5, +3 — under minAbsDelta=5
      actualScanned: 100,
    });
    expect(r.regression).toBe(false);
  });

  // #3607: an incomplete scan (baseline feature bucket entirely missing from
  // the current scan) must fail the gate unconditionally — it must NOT be
  // masked by the same AND-condition noise floor that protects legitimate
  // denominator shrinks (class #1604), since the whole point is that a
  // missing bucket could be hiding a real regression the scan never saw.
  it('FAIL: baseline feature missing from current scan fails the gate even when the visible rate is perfectly within cap', () => {
    const r = evaluateMixAdjustedTotalRegression({
      scannedByFeature: { a: 100 },
      baseByFeature: { a: { ratePct: 5, scanned: 100 }, b: { ratePct: 20, scanned: 500 } },
      tol: TOL,
      actualOffenders: 5, // exactly at baseline rate for the features that WERE scanned
      actualScanned: 100,
    });
    expect(r.regression).toBe(true);
    expect(r.missingFeatures).toEqual(['b']);
  });

  it('PASS: no missing baseline features and rate within cap', () => {
    const r = evaluateMixAdjustedTotalRegression({
      scannedByFeature: { a: 100, b: 400 },
      baseByFeature: { a: { ratePct: 5, scanned: 90 }, b: { ratePct: 50, scanned: 380 } },
      tol: TOL,
      actualOffenders: 205,
      actualScanned: 500,
    });
    expect(r.regression).toBe(false);
    expect(r.missingFeatures).toEqual([]);
  });
});
