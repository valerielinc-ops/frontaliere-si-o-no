import { describe, it, expect } from 'vitest';
import { shouldStopAfterConsecutiveFailures } from '../scripts/relocalize-pending-jobs.mjs';

/**
 * Regression gate for issue #5976: a single company's error used to `break`
 * the entire per-company cascade loop in `relocalize-pending-jobs.mjs`,
 * leaving every company later in the traffic-weighted `companyKeys` order
 * untouched for that run. Low-traffic companies sort last, so they could go
 * untouched run after run — 408 jobs stuck 30d+, 93% never attempted once.
 *
 * The loop must only abort after MAX_CONSECUTIVE_COMPANY_FAILURES in a row
 * (a systemic signal, e.g. AI quota exhausted on every tier), and must keep
 * going past an isolated failure.
 */
describe('shouldStopAfterConsecutiveFailures — per-company cascade circuit breaker', () => {
  it('does NOT stop after an isolated failure (below the threshold)', () => {
    expect(shouldStopAfterConsecutiveFailures(1, 3)).toBe(false);
    expect(shouldStopAfterConsecutiveFailures(2, 3)).toBe(false);
  });

  it('stops once consecutive failures reach the threshold (systemic signal)', () => {
    expect(shouldStopAfterConsecutiveFailures(3, 3)).toBe(true);
    expect(shouldStopAfterConsecutiveFailures(4, 3)).toBe(true);
  });

  it('zero failures never stops the loop', () => {
    expect(shouldStopAfterConsecutiveFailures(0, 3)).toBe(false);
  });

  it('defaults to the module MAX_CONSECUTIVE_COMPANY_FAILURES when no max is passed', () => {
    // Mirrors the production default (3) without hardcoding it twice — a change
    // to the constant should not silently desync this test from the real threshold.
    expect(shouldStopAfterConsecutiveFailures(2)).toBe(false);
    expect(shouldStopAfterConsecutiveFailures(3)).toBe(true);
  });
});
