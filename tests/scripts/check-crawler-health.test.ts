// @vitest-environment node
/**
 * Unit tests for the state-transition logic in
 * `scripts/check-crawler-health.mjs`.
 *
 * The monitor distinguishes four statuses:
 *   - healthy     — slice fresh AND (jobs > 0 OR has prior history)
 *   - stale       — slice `assembledAt` older than 7 days
 *   - broken      — 3+ consecutive empty observations
 *   - warming_up  — first observation, fresh-empty, no prior state
 *
 * These cases cover the false-positive bugs the daily monitor was
 * generating before the fix:
 *   1. fresh-empty crawler on first run was flagged "stale" (Infinity
 *      ageMs). Now → warming_up.
 *   2. legitimately-empty source (BancaStato) re-observed daily stays
 *      healthy until the 3-empty-runs gate.
 *   3. truly stale slice (assembledAt > 7d) is correctly flagged stale.
 */

import { describe, it, expect } from 'vitest';

import { nextCrawlerState } from '../../scripts/check-crawler-health.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

// Anchor "now" so the tests are deterministic regardless of clock.
const NOW_MS = Date.parse('2026-05-13T06:30:00.000Z');
const NOW_ISO = new Date(NOW_MS).toISOString();

function obs(assembledAt: string, jobCount: number) {
  return { slug: 'test', assembledAt, jobCount };
}

describe('nextCrawlerState', () => {
  it('flags warming_up on first observation when fresh-empty and no prior state', () => {
    const { status, reason } = nextCrawlerState(
      undefined,
      obs(new Date(NOW_MS - 3 * 60 * 60 * 1000).toISOString(), 0), // 3h ago
      NOW_ISO,
      NOW_MS,
    );
    expect(status).toBe('warming_up');
    expect(reason).toBeNull();
  });

  it('reports healthy on first observation when fresh and has jobs', () => {
    const { status, state } = nextCrawlerState(
      undefined,
      obs(new Date(NOW_MS - 5 * 60 * 60 * 1000).toISOString(), 12),
      NOW_ISO,
      NOW_MS,
    );
    expect(status).toBe('healthy');
    expect(state.lastNonZeroJobs).toBe(12);
    expect(state.consecutiveEmptyRuns).toBe(0);
    expect(state.lastSuccessfulRunAt).not.toBeNull();
  });

  it('keeps a fresh-empty crawler healthy on subsequent runs while empty streak is below the gate', () => {
    // BancaStato pattern: slice refreshed daily, jobs always 0.
    const prev = {
      lastSuccessfulRunAt: null,
      lastNonZeroJobs: 0,
      consecutiveEmptyRuns: 1,
      lastFailureReason: null,
      status: 'warming_up',
      _lastObservedAt: new Date(NOW_MS - DAY_MS).toISOString(),
      _lastObservedJobs: 0,
      _lastObservedAssembledAt: new Date(NOW_MS - DAY_MS).toISOString(),
    };
    const { status, state } = nextCrawlerState(
      prev,
      obs(new Date(NOW_MS - 2 * 60 * 60 * 1000).toISOString(), 0),
      NOW_ISO,
      NOW_MS,
    );
    expect(status).toBe('healthy');
    expect(state.consecutiveEmptyRuns).toBe(2);
  });

  it('flags broken after 3 consecutive empty observations', () => {
    const prev = {
      lastSuccessfulRunAt: null,
      lastNonZeroJobs: 0,
      consecutiveEmptyRuns: 2,
      lastFailureReason: null,
      status: 'healthy',
      _lastObservedAt: new Date(NOW_MS - DAY_MS).toISOString(),
      _lastObservedJobs: 0,
      _lastObservedAssembledAt: new Date(NOW_MS - DAY_MS).toISOString(),
    };
    const { status, state, reason } = nextCrawlerState(
      prev,
      obs(new Date(NOW_MS - 2 * 60 * 60 * 1000).toISOString(), 0),
      NOW_ISO,
      NOW_MS,
    );
    expect(status).toBe('broken');
    expect(state.consecutiveEmptyRuns).toBe(3);
    expect(reason).toMatch(/3 consecutive runs returned 0 jobs/);
  });

  it('flags stale when slice assembledAt is older than 7 days (regardless of empty streak)', () => {
    // heineken-ch fixture: slice from 8d ago.
    const { status, state, reason } = nextCrawlerState(
      undefined,
      obs(new Date(NOW_MS - 8 * DAY_MS).toISOString(), 0),
      NOW_ISO,
      NOW_MS,
    );
    expect(status).toBe('stale');
    expect(reason).toMatch(/slice not updated in \d+ days/);
    expect(state.consecutiveEmptyRuns).toBe(1);
  });

  it('flags stale on very old slices (31d) too', () => {
    // posta-svizzera fixture.
    const { status } = nextCrawlerState(
      undefined,
      obs(new Date(NOW_MS - 31 * DAY_MS).toISOString(), 0),
      NOW_ISO,
      NOW_MS,
    );
    expect(status).toBe('stale');
  });

  it('resets consecutiveEmptyRuns to 0 when jobs return', () => {
    const prev = {
      lastSuccessfulRunAt: null,
      lastNonZeroJobs: 0,
      consecutiveEmptyRuns: 2,
      lastFailureReason: null,
      status: 'healthy',
      _lastObservedAt: new Date(NOW_MS - DAY_MS).toISOString(),
      _lastObservedJobs: 0,
      _lastObservedAssembledAt: new Date(NOW_MS - DAY_MS).toISOString(),
    };
    const { state } = nextCrawlerState(
      prev,
      obs(new Date(NOW_MS - 30 * 60 * 1000).toISOString(), 5),
      NOW_ISO,
      NOW_MS,
    );
    expect(state.consecutiveEmptyRuns).toBe(0);
    expect(state.lastNonZeroJobs).toBe(5);
  });

  it('exits the warming_up state once prior history exists, even if still empty', () => {
    // Once we have any prior state we trust the empty-streak gate to do
    // its job — warming_up is strictly a first-observation safety net.
    const prev = {
      lastSuccessfulRunAt: null,
      lastNonZeroJobs: 0,
      consecutiveEmptyRuns: 1,
      lastFailureReason: null,
      status: 'warming_up',
      _lastObservedAt: new Date(NOW_MS - DAY_MS).toISOString(),
      _lastObservedJobs: 0,
      _lastObservedAssembledAt: new Date(NOW_MS - DAY_MS).toISOString(),
    };
    const { status } = nextCrawlerState(
      prev,
      obs(new Date(NOW_MS - 2 * 60 * 60 * 1000).toISOString(), 0),
      NOW_ISO,
      NOW_MS,
    );
    expect(status).toBe('healthy');
  });

  it('treats missing assembledAt as stale (slice age = Infinity)', () => {
    const { status } = nextCrawlerState(
      undefined,
      { slug: 'test', assembledAt: null, jobCount: 0 },
      NOW_ISO,
      NOW_MS,
    );
    expect(status).toBe('stale');
  });
});
