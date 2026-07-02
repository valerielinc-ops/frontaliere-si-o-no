/**
 * Anti-shrink guard (writeJobsCrawlerSlice funnel).
 *
 * A parser whose mergeJobs() only keeps discoveredJobs.map(...) (the pattern
 * shared by ~74 update-*.mjs scripts) silently drops any existing job not
 * rediscovered this run. Confirmed incident: axa-svizzera 152→5 jobs in one
 * run because jobs.axa.ch returned a degraded 5-result page and the crawler
 * exited 0. shouldBlockShrink() is the pure predicate writeJobsCrawlerSlice
 * uses to refuse persisting that class of silent data loss.
 */
import { describe, it, expect } from 'vitest';
import { shouldBlockShrink } from '../../scripts/assemble-jobs-dataset.mjs';

describe('shouldBlockShrink()', () => {
  it('blocks the axa-svizzera incident shape (152 -> 5)', () => {
    expect(shouldBlockShrink(152, 5)).toBe(true);
  });

  it('does not block below the minimum baseline (small crawlers churn freely)', () => {
    expect(shouldBlockShrink(19, 0)).toBe(false);
    expect(shouldBlockShrink(10, 1)).toBe(false);
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
