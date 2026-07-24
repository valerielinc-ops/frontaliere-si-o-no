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
import {
  computeMixAdjustedTotalCap,
  evaluateMixAdjustedTotalRegression,
  extrapolateSampledCount,
  isPlausibleSamplingMiss,
} from '../../scripts/lib/mixAdjustedRateGate.mjs';

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

// Regression guard for the sampling-vs-baseline mismatch found in PR #4695's
// review (2 🔴 Important, both still unfixed when the PR merged — this is the
// real fix). AUDIT_SAMPLE_RATE reads only a fraction of dist/ per run; these
// functions previously compared sampled current counts against unsampled
// baseline counts, and treated ANY baseline feature missing from a sampled
// scan as a hard "incomplete scan" regression even when a small bucket
// legitimately draws zero pages by chance.
describe('extrapolateSampledCount', () => {
  it('scales a sampled count up to full-corpus-equivalent scale', () => {
    expect(extrapolateSampledCount(10, 0.25)).toBe(40);
  });

  it('is the identity at rate=1 (no sampling)', () => {
    expect(extrapolateSampledCount(10, 1)).toBe(10);
  });

  it('is the identity when rate is omitted/invalid', () => {
    expect(extrapolateSampledCount(10, 0)).toBe(10);
    expect(extrapolateSampledCount(10, 1.5)).toBe(10);
  });
});

describe('isPlausibleSamplingMiss', () => {
  it('is plausible for a small baseline bucket at 25% sampling (the weekly-employers-hub case: 8 pages)', () => {
    // (1-0.25)^8 ≈ 10% — well above the 1% tolerance, a legitimate miss.
    expect(isPlausibleSamplingMiss(8, 0.25)).toBe(true);
  });

  it('is NOT plausible for a large baseline bucket at 25% sampling (e.g. career-landings-scale, 1000s of pages)', () => {
    // (1-0.25)^100 is astronomically small — an all-zero draw this large is real signal.
    expect(isPlausibleSamplingMiss(100, 0.25)).toBe(false);
  });

  it('is never plausible when sampling is inactive (rate=1)', () => {
    expect(isPlausibleSamplingMiss(1, 1)).toBe(false);
    expect(isPlausibleSamplingMiss(1, 0)).toBe(false);
  });
});

describe('computeMixAdjustedTotalCap — sampling-aware missingFeatures', () => {
  it('does NOT flag a small baseline bucket missing from a sampled scan (weekly-employers-hub: 8 baseline pages, 25% sample)', () => {
    const r = computeMixAdjustedTotalCap({
      scannedByFeature: { 'job-board': 1000 }, // weekly-employers-hub absent from this sampled run
      baseByFeature: {
        'job-board': { ratePct: 5, scanned: 4000 },
        'weekly-employers-hub': { ratePct: 0, scanned: 8 },
      },
      tol: TOL,
      sampleRate: 0.25,
    });
    expect(r.missingFeatures).toEqual([]);
  });

  it('still flags a large baseline bucket missing from a sampled scan (real incomplete-scan signal)', () => {
    const r = computeMixAdjustedTotalCap({
      scannedByFeature: { 'job-board': 1000 },
      baseByFeature: {
        'job-board': { ratePct: 5, scanned: 4000 },
        'career-landings': { ratePct: 2, scanned: 20364 },
      },
      tol: TOL,
      sampleRate: 0.25,
    });
    expect(r.missingFeatures).toEqual(['career-landings']);
  });

  it('flags any missing feature at rate=1 (no sampling) same as before this fix — regression guard', () => {
    const r = computeMixAdjustedTotalCap({
      scannedByFeature: { a: 100 },
      baseByFeature: { a: { ratePct: 5, scanned: 90 }, b: { ratePct: 10, scanned: 8 } },
      tol: TOL,
      sampleRate: 1,
    });
    expect(r.missingFeatures).toEqual(['b']);
  });
});

describe('evaluateMixAdjustedTotalRegression — sampled actualOffenders extrapolation', () => {
  // Baseline (unsampled, seed-workflow scale): a: scanned=400 rate=5%,
  // b: scanned=1600 rate=50%. At 25% sampling, an UNCHANGED site produces
  // roughly a quarter of those counts in the current run.
  const baseByFeature = { a: { ratePct: 5, scanned: 400 }, b: { ratePct: 50, scanned: 1600 } };
  const scannedByFeature = { a: 100, b: 400 };

  it('does not false-fail when a sampled run matches the baseline rate (no real regression)', () => {
    const r = evaluateMixAdjustedTotalRegression({
      scannedByFeature, baseByFeature, tol: TOL,
      actualOffenders: 205, // ~25% of the baseline's 820 total offenders
      actualScanned: 500,
      sampleRate: 0.25,
    });
    expect(r.regression).toBe(false);
  });

  it('still fails on a genuine regression visible in the sampled rate', () => {
    const r = evaluateMixAdjustedTotalRegression({
      scannedByFeature, baseByFeature, tol: TOL,
      actualOffenders: 250, // 50% rate vs baseline's 41% — real, both pre- and post-extrapolation
      actualScanned: 500,
      sampleRate: 0.25,
    });
    expect(r.regression).toBe(true);
  });
});
