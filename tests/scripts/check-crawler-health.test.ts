// @vitest-environment node
/**
 * Unit tests for the state-transition logic in
 * `scripts/check-crawler-health.mjs`.
 *
 * The monitor distinguishes four statuses:
 *   - healthy     — freshness OK AND (jobs > 0 OR has prior history)
 *   - stale       — `freshnessAt` older than 7 days
 *   - broken      — 3+ consecutive empty observations
 *   - warming_up  — first observation, fresh-empty, no prior state
 *
 * Freshness is derived from a TWO-TIER signal:
 *   1. PRIMARY  → summary slice `generatedAt`
 *      (`data/jobs-crawler-summaries/by-crawler/{slug}.json`), written on
 *      every workflow run including "Keeping existing" zero-job runs.
 *   2. FALLBACK → by-crawler slice `assembledAt`
 *      (`data/jobs/by-crawler/{slug}.json`), used when the summary is
 *      missing. This timestamp freezes for weeks on "Keeping existing"
 *      runs, so it is only trusted in absence of a summary.
 *
 * These cases cover the false-positive bugs the daily monitor was
 * generating before the fix:
 *   1. fresh-empty crawler on first run was flagged "stale" (Infinity
 *      ageMs). Now → warming_up.
 *   2. legitimately-empty source (BancaStato) re-observed daily stays
 *      healthy until the 3-empty-runs gate.
 *   3. truly stale slice (no run in > 7d) is correctly flagged stale.
 *   4. "Keeping existing" crawler with fresh summary + stale by-crawler
 *      slice stays healthy (the summary-vs-by-crawler timestamp split).
 */

import { describe, it, expect } from 'vitest';

import { nextCrawlerState } from '../../scripts/check-crawler-health.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

// Anchor "now" so the tests are deterministic regardless of clock.
const NOW_MS = Date.parse('2026-05-13T06:30:00.000Z');
const NOW_ISO = new Date(NOW_MS).toISOString();

interface Observation {
  slug: string;
  jobCount: number;
  freshnessAt: string | null;
  freshnessSource: 'summary' | 'by-crawler' | 'mtime' | 'none';
  generatedAt: string | null;
  assembledAt: string | null;
}

/** Convenience builder mirroring `inspectCrawler` output. */
function obs(
  freshnessAt: string | null,
  jobCount: number,
  opts: Partial<Omit<Observation, 'slug' | 'jobCount' | 'freshnessAt'>> = {},
): Observation {
  const source = opts.freshnessSource ?? 'summary';
  return {
    slug: 'test',
    jobCount,
    freshnessAt,
    freshnessSource: source,
    generatedAt: opts.generatedAt ?? (source === 'summary' ? freshnessAt : null),
    assembledAt:
      opts.assembledAt ?? (source === 'by-crawler' ? freshnessAt : null),
  };
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
    expect(reason).toMatch(/crawler not run in \d+ days/);
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

  it('treats missing freshnessAt as stale (slice age = Infinity)', () => {
    const { status } = nextCrawlerState(
      undefined,
      {
        slug: 'test',
        jobCount: 0,
        freshnessAt: null,
        freshnessSource: 'none',
        generatedAt: null,
        assembledAt: null,
      },
      NOW_ISO,
      NOW_MS,
    );
    expect(status).toBe('stale');
  });

  // --- Summary vs by-crawler timestamp logic (the fix this test file was
  // added to cover) ---

  it('uses summary generatedAt over a stale by-crawler assembledAt ("Keeping existing" run)', () => {
    // Real-world case: ail-lugano writes a fresh summary every day but the
    // by-crawler slice is frozen at the last non-zero run (>7d ago). Under
    // the old logic this was flagged stale; under the new logic the summary
    // proves the workflow ran today, so the crawler stays healthy.
    const { status, state } = nextCrawlerState(
      undefined,
      {
        slug: 'test',
        jobCount: 0,
        freshnessAt: new Date(NOW_MS - 3 * 60 * 60 * 1000).toISOString(),
        freshnessSource: 'summary',
        generatedAt: new Date(NOW_MS - 3 * 60 * 60 * 1000).toISOString(),
        assembledAt: new Date(NOW_MS - 11 * DAY_MS).toISOString(),
      },
      NOW_ISO,
      NOW_MS,
    );
    expect(status).toBe('warming_up');
    expect(state.lastFailureReason).toBeNull();
    expect(state._lastObservedFreshnessSource).toBe('summary');
  });

  it('flags stale when the summary itself has not been written in > 7d', () => {
    // The summary slice is the workflow heartbeat. If even that is stale
    // for more than 7 days, the workflow stopped running and the crawler
    // should be flagged.
    const { status, reason } = nextCrawlerState(
      undefined,
      {
        slug: 'test',
        jobCount: 0,
        freshnessAt: new Date(NOW_MS - 9 * DAY_MS).toISOString(),
        freshnessSource: 'summary',
        generatedAt: new Date(NOW_MS - 9 * DAY_MS).toISOString(),
        assembledAt: new Date(NOW_MS - 30 * DAY_MS).toISOString(),
      },
      NOW_ISO,
      NOW_MS,
    );
    expect(status).toBe('stale');
    expect(reason).toMatch(/source=summary/);
  });

  it('falls back to by-crawler assembledAt when no summary exists yet', () => {
    // Brand-new crawler: summary slice not yet written, by-crawler slice
    // is fresh. Should be treated as a normal observation.
    const { status, state } = nextCrawlerState(
      undefined,
      {
        slug: 'test',
        jobCount: 7,
        freshnessAt: new Date(NOW_MS - 4 * 60 * 60 * 1000).toISOString(),
        freshnessSource: 'by-crawler',
        generatedAt: null,
        assembledAt: new Date(NOW_MS - 4 * 60 * 60 * 1000).toISOString(),
      },
      NOW_ISO,
      NOW_MS,
    );
    expect(status).toBe('healthy');
    expect(state._lastObservedFreshnessSource).toBe('by-crawler');
    expect(state.lastNonZeroJobs).toBe(7);
  });
});
