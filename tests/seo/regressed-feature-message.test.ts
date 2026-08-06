// A gate that decides correctly and then reports its decision ambiguously is
// one bad afternoon away from being switched off.
//
// The old message was `spa-locale(2.182% > 1.87% allowed, 30 vs 31)`. Those
// two counts are on DIFFERENT SCALES: 30 is what a 25 % sample saw, 31 is the
// baseline's full-corpus figure — four times apart. Read literally it says the
// offenders went from 31 down to 30, the exact opposite of what the gate had
// just decided; the real comparison was ~120 against 31.
//
// On 2026-08-06 that misreading produced a written conclusion that two red
// features were harmless denominator artifacts and that the ratchet could
// safely be re-baselined. Acting on it would have cemented a three-to-fourfold
// regression as the new accepted floor.
import { describe, it, expect } from 'vitest';
import { formatRegressedFeature } from '../../scripts/lib/mixAdjustedRateGate.mjs';

describe('formatRegressedFeature — the two counts cannot be misread', () => {
  // The exact record that misled a reader, at the sample rate that run used.
  const spaLocale = {
    feature: 'spa-locale', count: 30, countFull: 120, max: 31, rate: 2.182, maxRate: 1.87,
  };

  it('puts both counts on one scale and names it', () => {
    const out = formatRegressedFeature(spaLocale, 0.25);
    expect(out).toContain('~120');
    expect(out).toContain('31 baseline');
    expect(out).toContain('25 % sample');
  });

  it('never prints the sampled count next to the baseline as a bare pair', () => {
    // "30 vs 31" is the shape that reads as an improvement. It must not occur.
    const out = formatRegressedFeature(spaLocale, 0.25);
    expect(out).not.toMatch(/\b30 vs 31\b/);
  });

  it('keeps the raw sampled figure, because that is what the log shows', () => {
    expect(formatRegressedFeature(spaLocale, 0.25)).toContain('30 seen');
  });

  it('says nothing about sampling when the scan was complete', () => {
    const out = formatRegressedFeature(
      { feature: 'x', count: 9, max: 3, rate: 1, maxRate: 0.5 }, 1,
    );
    expect(out).not.toContain('sample');
    expect(out).toContain('~9 vs 3 baseline');
  });

  it('extrapolates itself when the caller did not', () => {
    const out = formatRegressedFeature({ feature: 'y', count: 25, max: 40, rate: 9, maxRate: 8 }, 0.25);
    expect(out).toContain('~100');
  });

  it('handles the count-mode record shape too', () => {
    expect(formatRegressedFeature({ feature: 'z', count: 12, max: 4 }, 1)).toBe('z(12 > 4 allowed)');
  });

  it('is total on a junk record rather than throwing inside a failure path', () => {
    expect(() => formatRegressedFeature(undefined as never, 0.25)).not.toThrow();
    expect(() => formatRegressedFeature({} as never)).not.toThrow();
  });
});

describe('the three rate-ratchet audits all use it — no local copy to drift', () => {
  it.each([
    'scripts/audit-title-length.mjs',
    'scripts/audit-h1-title-duplicates.mjs',
    'scripts/audit-text-html-ratio.mjs',
  ])('%s', async (path) => {
    const src = await import('node:fs').then((fs) => fs.readFileSync(path, 'utf8'));
    expect(src).toContain('formatRegressedFeature');
    // The hand-rolled shape that caused this is gone from all three.
    expect(src).not.toMatch(/allowed, \$\{r\.count\} vs \$\{r\.max\}/);
  });
});
