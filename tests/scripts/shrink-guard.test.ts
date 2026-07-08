/**
 * Anti-shrink guard (writeJobsCrawlerSlice funnel).
 *
 * A parser whose mergeJobs() only keeps discoveredJobs.map(...) (the pattern
 * shared by ~74 update-*.mjs scripts) silently drops any existing job not
 * rediscovered this run. Confirmed incident: axa-svizzera 152→5 jobs in one
 * run because jobs.axa.ch returned a degraded 5-result page and the crawler
 * exited 0. shouldBlockShrink() is the pure predicate writeJobsCrawlerSlice
 * uses to refuse persisting that class of silent data loss.
 *
 * The MIN_BASELINE ratio-gate below deliberately lets small crawlers churn
 * freely (e.g. 6 -> 3 is normal noise for a small employer). But that same
 * gate had a blind spot: a small-baseline crawler dropping to exactly zero
 * is never legitimate churn, and sailed through unguarded. Confirmed
 * incident: corner-banca 17 -> 0 jobs in one run (2026-07-06), below
 * MIN_BASELINE=20, so the ratio check never even evaluated. Total wipeouts
 * are now blocked unconditionally, regardless of baseline size.
 *
 * Residual gap (#3840): the same failure mode without landing on exactly
 * zero — e.g. 17 -> 1 (94% loss) — still sailed through, since it's neither
 * a total wipeout nor above MIN_BASELINE for the ratio check. A stricter
 * ratio now catches near-total (non-zero) drops below baseline too, while
 * still letting ordinary small-crawler churn through.
 */
import { describe, it, expect } from 'vitest';
import { shouldBlockShrink } from '../../scripts/assemble-jobs-dataset.mjs';

describe('shouldBlockShrink()', () => {
  it('blocks the axa-svizzera incident shape (152 -> 5)', () => {
    expect(shouldBlockShrink(152, 5)).toBe(true);
  });

  it('blocks the corner-banca incident shape (17 -> 0, below MIN_BASELINE)', () => {
    expect(shouldBlockShrink(17, 0)).toBe(true);
  });

  it('blocks any total wipeout regardless of baseline size', () => {
    expect(shouldBlockShrink(1, 0)).toBe(true);
    expect(shouldBlockShrink(5, 0)).toBe(true);
    expect(shouldBlockShrink(19, 0)).toBe(true);
  });

  it('blocks a near-total (non-zero) drop below the minimum baseline (#3840)', () => {
    expect(shouldBlockShrink(17, 1)).toBe(true); // issue #3840 example, 94% loss
    expect(shouldBlockShrink(19, 1)).toBe(true);
    expect(shouldBlockShrink(10, 1)).toBe(true);
  });

  it('does not block ordinary small-crawler churn below the minimum baseline', () => {
    expect(shouldBlockShrink(6, 3)).toBe(false); // documented normal-noise example
    expect(shouldBlockShrink(10, 4)).toBe(false);
    expect(shouldBlockShrink(5, 2)).toBe(false);
  });

  it('blocks below the small-baseline ratio threshold, not at or above it', () => {
    expect(shouldBlockShrink(15, 2)).toBe(true); // < 20% remaining
    expect(shouldBlockShrink(15, 3)).toBe(false); // exactly 20% remaining, not blocked
  });

  it('does not block normal churn within observed 15-day range (down to ~50-70% of baseline)', () => {
    expect(shouldBlockShrink(32, 22)).toBe(false); // Denner natural swing
    expect(shouldBlockShrink(100, 60)).toBe(false);
  });

  it('blocks a drop below the ratio threshold at baseline', () => {
    expect(shouldBlockShrink(100, 39)).toBe(true);
    expect(shouldBlockShrink(100, 40)).toBe(false); // exactly at threshold, not blocked
  });

  it('never blocks growth or an unchanged count', () => {
    expect(shouldBlockShrink(100, 100)).toBe(false);
    expect(shouldBlockShrink(100, 500)).toBe(false);
  });

  it('does not block when prior count is zero (first-ever run)', () => {
    expect(shouldBlockShrink(0, 0)).toBe(false);
  });
});
