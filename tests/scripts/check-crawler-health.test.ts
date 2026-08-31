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

  it('does not flag explicitly empty-ok crawlers when a fresh run finds zero jobs', () => {
    const prev = {
      lastSuccessfulRunAt: '2026-05-10T00:00:00.000Z',
      lastNonZeroJobs: 1,
      consecutiveEmptyRuns: 4,
      lastFailureReason: '4 consecutive runs returned 0 jobs',
      status: 'broken',
      _lastObservedAt: new Date(NOW_MS - DAY_MS).toISOString(),
      _lastObservedJobs: 0,
      _lastObservedAssembledAt: new Date(NOW_MS - DAY_MS).toISOString(),
    };
    const { status, state, reason } = nextCrawlerState(
      prev,
      {
        slug: 'csvp-poschiavo',
        jobCount: 0,
        freshnessAt: new Date(NOW_MS - 2 * 60 * 60 * 1000).toISOString(),
        freshnessSource: 'summary',
        generatedAt: new Date(NOW_MS - 2 * 60 * 60 * 1000).toISOString(),
        assembledAt: new Date(NOW_MS - 2 * 60 * 60 * 1000).toISOString(),
      },
      NOW_ISO,
      NOW_MS,
    );
    expect(status).toBe('healthy');
    expect(reason).toBeNull();
    expect(state.consecutiveEmptyRuns).toBe(0);
  });

  it('clears broken status for impresa-pizzarotti (Swiss-filtered, empty-ok) on a fresh zero-job run (#2979)', () => {
    // Reproduces the #2979 state: the dedicated Pizzarotti crawler is scoped to
    // Swiss-located vacancies only; the Italian builder currently lists only
    // Italy roles, so a healthy crawl legitimately returns 0. It must not stay
    // flagged broken once added to EMPTY_OK_CRAWLERS.
    const prev = {
      lastSuccessfulRunAt: '2026-06-23T22:54:52.257Z',
      lastNonZeroJobs: 1,
      consecutiveEmptyRuns: 5,
      lastFailureReason: '5 consecutive runs returned 0 jobs',
      status: 'broken',
      _lastObservedAt: new Date(NOW_MS - DAY_MS).toISOString(),
      _lastObservedJobs: 0,
      _lastObservedAssembledAt: new Date(NOW_MS - DAY_MS).toISOString(),
    };
    const { status, state, reason } = nextCrawlerState(
      prev,
      {
        slug: 'impresa-pizzarotti',
        jobCount: 0,
        freshnessAt: new Date(NOW_MS - 2 * 60 * 60 * 1000).toISOString(),
        freshnessSource: 'summary',
        generatedAt: new Date(NOW_MS - 2 * 60 * 60 * 1000).toISOString(),
        assembledAt: new Date(NOW_MS - 2 * 60 * 60 * 1000).toISOString(),
      },
      NOW_ISO,
      NOW_MS,
    );
    expect(status).toBe('healthy');
    expect(reason).toBeNull();
    expect(state.consecutiveEmptyRuns).toBe(0);
  });

  it('clears broken status for a-group (InRecruiting tenant, company-wide empty-ok) on a fresh zero-job run (#3198)', () => {
    // Reproduces the #3198 state: A++ Group's InRecruiting portal currently
    // has 0 open positions company-wide (verified via both the rendered page
    // and the underlying AJAX listing endpoint), not a selector/parser break.
    // It must not stay flagged broken once added to EMPTY_OK_CRAWLERS.
    const prev = {
      lastSuccessfulRunAt: '2026-06-27T21:07:06.689Z',
      lastNonZeroJobs: 1,
      consecutiveEmptyRuns: 3,
      lastFailureReason: '3 consecutive runs returned 0 jobs',
      status: 'broken',
      _lastObservedAt: new Date(NOW_MS - DAY_MS).toISOString(),
      _lastObservedJobs: 0,
      _lastObservedAssembledAt: new Date(NOW_MS - DAY_MS).toISOString(),
    };
    const { status, state, reason } = nextCrawlerState(
      prev,
      {
        slug: 'a-group',
        jobCount: 0,
        freshnessAt: new Date(NOW_MS - 2 * 60 * 60 * 1000).toISOString(),
        freshnessSource: 'summary',
        generatedAt: new Date(NOW_MS - 2 * 60 * 60 * 1000).toISOString(),
        assembledAt: new Date(NOW_MS - 2 * 60 * 60 * 1000).toISOString(),
      },
      NOW_ISO,
      NOW_MS,
    );
    expect(status).toBe('healthy');
    expect(reason).toBeNull();
    expect(state.consecutiveEmptyRuns).toBe(0);
  });

  it('clears broken status for axa-svizzera (national insurer, empty-ok hiring lull) on a fresh zero-job run (#3564)', () => {
    // Reproduces the #3564 state: the AXA Svizzera dedicated crawler's
    // national listing (Prospective.ch Career Center 2193) currently renders
    // its own "no-results" template with zero job anchors — verified via a
    // direct fetch and the production crawl log, not a selector/parser break
    // (detail pages still 410 normally, proving the ATS backend is live).
    // It must not stay flagged broken once added to EMPTY_OK_CRAWLERS.
    const prev = {
      lastSuccessfulRunAt: '2026-07-01T21:46:57.421Z',
      lastNonZeroJobs: 5,
      consecutiveEmptyRuns: 3,
      lastFailureReason: '3 consecutive runs returned 0 jobs',
      status: 'broken',
      _lastObservedAt: new Date(NOW_MS - DAY_MS).toISOString(),
      _lastObservedJobs: 0,
      _lastObservedAssembledAt: new Date(NOW_MS - DAY_MS).toISOString(),
    };
    const { status, state, reason } = nextCrawlerState(
      prev,
      {
        slug: 'axa-svizzera',
        jobCount: 0,
        freshnessAt: new Date(NOW_MS - 2 * 60 * 60 * 1000).toISOString(),
        freshnessSource: 'summary',
        generatedAt: new Date(NOW_MS - 2 * 60 * 60 * 1000).toISOString(),
        assembledAt: new Date(NOW_MS - 2 * 60 * 60 * 1000).toISOString(),
      },
      NOW_ISO,
      NOW_MS,
    );
    expect(status).toBe('healthy');
    expect(reason).toBeNull();
    expect(state.consecutiveEmptyRuns).toBe(0);
  });

  it('clears broken status for has-healthcare (Drupal micro-site, empty-ok) on a fresh zero-job run (#3565, #3819)', () => {
    // Reproduces the #3819 recurrence of #3565: the e-lavoro.ch/node/104
    // listing page (AITI Drupal micro-site) returns HTTP 200 with its own
    // legitimate empty-state markup — "Purtroppo non ci sono offerte di
    // lavoro, torna a trovarci!" — verified via a direct fetch with the
    // crawler's own selectors (job-title-row / w-100 p-3 /
    // main-list-job-percentage), which is unchanged and still correct; it
    // simply has nothing to match. #3565 was closed on this same evidence
    // but WITHOUT adding the crawler to EMPTY_OK_CRAWLERS, so the daily
    // monitor kept re-flagging it as broken every day until #3819 was
    // opened fresh 6 empty runs later. It must not stay flagged broken once
    // added to EMPTY_OK_CRAWLERS.
    const prev = {
      lastSuccessfulRunAt: '2026-07-01T22:28:50.370Z',
      lastNonZeroJobs: 4,
      consecutiveEmptyRuns: 6,
      lastFailureReason: '6 consecutive runs returned 0 jobs',
      status: 'broken',
      _lastObservedAt: new Date(NOW_MS - DAY_MS).toISOString(),
      _lastObservedJobs: 0,
      _lastObservedAssembledAt: new Date(NOW_MS - DAY_MS).toISOString(),
    };
    const { status, state, reason } = nextCrawlerState(
      prev,
      {
        slug: 'has-healthcare',
        jobCount: 0,
        freshnessAt: new Date(NOW_MS - 2 * 60 * 60 * 1000).toISOString(),
        freshnessSource: 'summary',
        generatedAt: new Date(NOW_MS - 2 * 60 * 60 * 1000).toISOString(),
        assembledAt: new Date(NOW_MS - 2 * 60 * 60 * 1000).toISOString(),
      },
      NOW_ISO,
      NOW_MS,
    );
    expect(status).toBe('healthy');
    expect(reason).toBeNull();
    expect(state.consecutiveEmptyRuns).toBe(0);
  });

  it('clears broken status for clariant (SuccessFactors Jobs2Web, empty-ok regional filter) on a fresh zero-job run (#4104)', () => {
    // Reproduces the #4104 state: Clariant's Jobs2Web listing/detail markup
    // (data-row / jobTitle-link / colLocation / colDepartment) is unchanged
    // and the parser still correctly parses every row on the unfiltered
    // /search/ page; walking all 110 currently open postings across all 6
    // result pages found none Switzerland-located. Clariant genuinely has 0
    // open Swiss roles right now, not a selector break. It must not stay
    // flagged broken once added to EMPTY_OK_CRAWLERS.
    const prev = {
      lastSuccessfulRunAt: '2026-07-07T22:17:10.074Z',
      lastNonZeroJobs: 1,
      consecutiveEmptyRuns: 3,
      lastFailureReason: '3 consecutive runs returned 0 jobs',
      status: 'broken',
      _lastObservedAt: new Date(NOW_MS - DAY_MS).toISOString(),
      _lastObservedJobs: 0,
      _lastObservedAssembledAt: new Date(NOW_MS - DAY_MS).toISOString(),
    };
    const { status, state, reason } = nextCrawlerState(
      prev,
      {
        slug: 'clariant',
        jobCount: 0,
        freshnessAt: new Date(NOW_MS - 2 * 60 * 60 * 1000).toISOString(),
        freshnessSource: 'summary',
        generatedAt: new Date(NOW_MS - 2 * 60 * 60 * 1000).toISOString(),
        assembledAt: new Date(NOW_MS - 2 * 60 * 60 * 1000).toISOString(),
      },
      NOW_ISO,
      NOW_MS,
    );
    expect(status).toBe('healthy');
    expect(reason).toBeNull();
    expect(state.consecutiveEmptyRuns).toBe(0);
  });

  // The whole `broken` cohort of the 2026-08-04 monitor snapshot, all five
  // verified live as "source healthy, zero qualifying openings" rather than
  // parser breaks (evidence per crawler in the EMPTY_OK_CRAWLERS comments in
  // scripts/check-crawler-health.mjs). Table-driven so the class is covered
  // in one place instead of five copy-pasted blocks.
  const emptyOkCohort: Array<{ slug: string; issue: string; why: string; priorNonZero: number; emptyStreak: number }> = [
    {
      slug: 'temenos',
      issue: '#4844',
      why: 'Workday tenant rejects the locationCountry facet (HTTP 400); the strict-CH fallback walks the whole 16-posting board and finds no Swiss role',
      priorNonZero: 1,
      emptyStreak: 19,
    },
    {
      slug: 'veeam',
      issue: '#5060',
      why: 'Greenhouse board veeamsoftware returns 235 live postings, none matching the parser SWISS_LOCATION_RE; careers.veeam.com itself reports 0 jobs for Switzerland',
      priorNonZero: 2,
      emptyStreak: 4,
    },
    {
      slug: 'gavi',
      issue: '#5059',
      why: 'fRecruit portal listing renders its unchanged page block with "Page 1 of 0" / "None found" and zero vacancyNo links',
      priorNonZero: 1,
      emptyStreak: 4,
    },
    {
      slug: 'rado',
      issue: '#5083',
      why: 'shared swatchgroup.com pool crawl is healthy (sibling eta-sa-swatch-group wrote 22 jobs same run); brand filter kept 0/7 because no posting carries a Rado legal entity',
      priorNonZero: 1,
      emptyStreak: 3,
    },
    {
      slug: 'swatch-group-assembly',
      issue: '#5013',
      why: 'same shared-pool brand filter kept 0/24 — no Swatch Group Assembly SA posting in the pool',
      priorNonZero: 14,
      emptyStreak: 7,
    },
    {
      slug: 'baronie',
      issue: '#5851',
      why: 'parser already repaired by #5860; careers page still yields all 4 /en/jobs/ anchors and every detail page parses end-to-end, but all 4 openings are BE/DE/UK so isSwissJob keeps 0/4',
      priorNonZero: 1,
      emptyStreak: 3,
    },
  ];

  for (const { slug, issue, why, priorNonZero, emptyStreak } of emptyOkCohort) {
    it(`clears broken status for ${slug} (empty-ok: ${why}) on a fresh zero-job run (${issue})`, () => {
      const prev = {
        // Relative to the simulated clock — never a calendar literal, so the
        // fixture cannot rot (AGENTS.md test-fixture rule).
        lastSuccessfulRunAt: new Date(NOW_MS - (emptyStreak + 1) * DAY_MS).toISOString(),
        lastNonZeroJobs: priorNonZero,
        consecutiveEmptyRuns: emptyStreak,
        lastFailureReason: `${emptyStreak} consecutive runs returned 0 jobs`,
        status: 'broken',
        _lastObservedAt: new Date(NOW_MS - DAY_MS).toISOString(),
        _lastObservedJobs: 0,
        _lastObservedAssembledAt: new Date(NOW_MS - DAY_MS).toISOString(),
      };
      const { status, state, reason } = nextCrawlerState(
        prev,
        {
          slug,
          jobCount: 0,
          freshnessAt: new Date(NOW_MS - 2 * 60 * 60 * 1000).toISOString(),
          freshnessSource: 'summary',
          generatedAt: new Date(NOW_MS - 2 * 60 * 60 * 1000).toISOString(),
          assembledAt: new Date(NOW_MS - 2 * 60 * 60 * 1000).toISOString(),
        },
        NOW_ISO,
        NOW_MS,
      );
      expect(status).toBe('healthy');
      expect(reason).toBeNull();
      expect(state.consecutiveEmptyRuns).toBe(0);
    });
  }

  it('still flags an unlisted crawler broken on the same fresh zero-job observation (empty-ok is not a blanket mute)', () => {
    // Guard against the class of "fix" this PR must never become: the five
    // additions above must not have loosened the gate for everyone else.
    const prev = {
      lastSuccessfulRunAt: new Date(NOW_MS - 4 * DAY_MS).toISOString(),
      lastNonZeroJobs: 12,
      consecutiveEmptyRuns: 3,
      lastFailureReason: '3 consecutive runs returned 0 jobs',
      status: 'broken',
      _lastObservedAt: new Date(NOW_MS - DAY_MS).toISOString(),
      _lastObservedJobs: 0,
      _lastObservedAssembledAt: new Date(NOW_MS - DAY_MS).toISOString(),
    };
    const { status, state } = nextCrawlerState(
      prev,
      {
        slug: 'not-an-empty-ok-crawler',
        jobCount: 0,
        freshnessAt: new Date(NOW_MS - 2 * 60 * 60 * 1000).toISOString(),
        freshnessSource: 'summary',
        generatedAt: new Date(NOW_MS - 2 * 60 * 60 * 1000).toISOString(),
        assembledAt: new Date(NOW_MS - 2 * 60 * 60 * 1000).toISOString(),
      },
      NOW_ISO,
      NOW_MS,
    );
    expect(status).toBe('broken');
    expect(state.consecutiveEmptyRuns).toBe(4);
  });

  it('does not double-count a re-observed stale summary as a second empty run (#6694)', () => {
    // giardino pattern: the crawl ran once, returned 0 jobs, then its
    // workflow stopped running for days. Each daily health-check tick kept
    // observing the SAME frozen summary generatedAt — that must not inflate
    // consecutiveEmptyRuns further; only a genuinely NEW freshnessAt counts.
    const frozenAt = new Date(NOW_MS - 3 * DAY_MS).toISOString();
    const prev = {
      lastSuccessfulRunAt: new Date(NOW_MS - 5 * DAY_MS).toISOString(),
      lastNonZeroJobs: 12,
      consecutiveEmptyRuns: 1,
      consecutiveEmptyOkRuns: 1,
      lastFailureReason: null,
      status: 'healthy',
      _lastObservedAt: new Date(NOW_MS - DAY_MS).toISOString(),
      _lastObservedJobs: 0,
      _lastObservedFreshnessAt: frozenAt,
      _lastObservedAssembledAt: frozenAt,
    };
    const { status, state, reason } = nextCrawlerState(
      prev,
      {
        slug: 'giardino',
        jobCount: 0,
        freshnessAt: frozenAt, // identical to the previous tick's observation
        freshnessSource: 'summary',
        generatedAt: frozenAt,
        assembledAt: frozenAt,
      },
      NOW_ISO,
      NOW_MS,
    );
    expect(status).toBe('healthy');
    expect(reason).toBeNull();
    expect(state.consecutiveEmptyRuns).toBe(1); // unchanged, not incremented to 2
    expect(state.consecutiveEmptyOkRuns).toBe(1);
  });

  it('ignores changed secondary timestamps when freshness, count and emptyOk still match (#6710)', () => {
    const frozenFreshness = new Date(NOW_MS - DAY_MS).toISOString();
    const prev = {
      lastNonZeroJobs: 12,
      consecutiveEmptyRuns: 1,
      consecutiveEmptyOkRuns: 1,
      status: 'healthy',
      _lastObservedJobs: 0,
      _lastObservedEmptyOk: false,
      _lastObservedFreshnessAt: frozenFreshness,
      _lastObservedGeneratedAt: new Date(NOW_MS - 3 * 60 * 60 * 1000).toISOString(),
      _lastObservedAssembledAt: new Date(NOW_MS - 2 * 60 * 60 * 1000).toISOString(),
    };
    const { state } = nextCrawlerState(
      prev,
      {
        slug: 'same-observable-run',
        jobCount: 0,
        freshnessAt: frozenFreshness,
        freshnessSource: 'summary',
        generatedAt: new Date(NOW_MS - 60 * 60 * 1000).toISOString(),
        assembledAt: NOW_ISO,
      },
      NOW_ISO,
      NOW_MS,
    );

    expect(state.consecutiveEmptyRuns).toBe(1);
    expect(state.consecutiveEmptyOkRuns).toBe(1);
  });

  it('counts a changed job total as a new run even when freshnessAt is unchanged (#6710)', () => {
    const frozenAt = new Date(NOW_MS - DAY_MS).toISOString();
    const prev = {
      lastSuccessfulRunAt: new Date(NOW_MS - 2 * DAY_MS).toISOString(),
      lastNonZeroJobs: 12,
      consecutiveEmptyRuns: 1,
      consecutiveEmptyOkRuns: 1,
      status: 'healthy',
      _lastObservedJobs: 0,
      _lastObservedEmptyOk: false,
      _lastObservedFreshnessAt: frozenAt,
      _lastObservedGeneratedAt: frozenAt,
      _lastObservedAssembledAt: frozenAt,
    };
    const { state } = nextCrawlerState(
      prev,
      {
        slug: 'same-day-granularity',
        jobCount: 5,
        freshnessAt: frozenAt,
        freshnessSource: 'summary',
        generatedAt: frozenAt,
        assembledAt: frozenAt,
      },
      NOW_ISO,
      NOW_MS,
    );
    expect(state.consecutiveEmptyRuns).toBe(0);
    expect(state.consecutiveEmptyOkRuns).toBe(0);
  });

  it('counts a changed emptyOk classification as a new run at equal freshnessAt (#6710)', () => {
    const frozenAt = new Date(NOW_MS - DAY_MS).toISOString();
    const prev = {
      lastSuccessfulRunAt: new Date(NOW_MS - 2 * DAY_MS).toISOString(),
      lastNonZeroJobs: 12,
      consecutiveEmptyRuns: 1,
      consecutiveEmptyOkRuns: 1,
      status: 'healthy',
      _lastObservedJobs: 0,
      _lastObservedEmptyOk: false,
      _lastObservedFreshnessAt: frozenAt,
      _lastObservedGeneratedAt: frozenAt,
      _lastObservedAssembledAt: frozenAt,
    };
    const { state } = nextCrawlerState(
      prev,
      {
        slug: 'same-day-granularity',
        jobCount: 0,
        discovered: 3,
        written: 0,
        freshnessAt: frozenAt,
        freshnessSource: 'summary',
        generatedAt: frozenAt,
        assembledAt: frozenAt,
      },
      NOW_ISO,
      NOW_MS,
    );
    expect(state.consecutiveEmptyRuns).toBe(0);
    expect(state.consecutiveEmptyOkRuns).toBe(2);
    expect(state._lastObservedEmptyOk).toBe(true);
  });

  it('treats explicit null legacy freshness as unobserved, never as a repeat (#6710)', () => {
    const prev = {
      consecutiveEmptyRuns: 1,
      consecutiveEmptyOkRuns: 1,
      status: 'healthy',
      _lastObservedJobs: 0,
      _lastObservedFreshnessAt: null,
    };
    const { state } = nextCrawlerState(
      prev,
      {
        slug: 'legacy-null-state',
        jobCount: 0,
        freshnessAt: null,
        freshnessSource: 'none',
        assembledAt: null,
        generatedAt: null,
      },
      NOW_ISO,
      NOW_MS,
    );
    expect(state.consecutiveEmptyRuns).toBe(2);
    expect(state.consecutiveEmptyOkRuns).toBe(2);
  });

  it('still increments consecutiveEmptyRuns when a NEW empty run follows a prior empty run', () => {
    const prev = {
      lastSuccessfulRunAt: new Date(NOW_MS - 5 * DAY_MS).toISOString(),
      lastNonZeroJobs: 12,
      consecutiveEmptyRuns: 1,
      consecutiveEmptyOkRuns: 1,
      lastFailureReason: null,
      status: 'healthy',
      _lastObservedAt: new Date(NOW_MS - DAY_MS).toISOString(),
      _lastObservedJobs: 0,
      _lastObservedFreshnessAt: new Date(NOW_MS - 2 * DAY_MS).toISOString(),
    };
    const { state } = nextCrawlerState(
      prev,
      {
        slug: 'giardino',
        jobCount: 0,
        freshnessAt: new Date(NOW_MS - DAY_MS).toISOString(), // genuinely newer
        freshnessSource: 'summary',
        generatedAt: new Date(NOW_MS - DAY_MS).toISOString(),
        assembledAt: new Date(NOW_MS - DAY_MS).toISOString(),
      },
      NOW_ISO,
      NOW_MS,
    );
    expect(state.consecutiveEmptyRuns).toBe(2);
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

  it('raises an advisory after 30+ consecutive empty-ok runs without flipping status away from healthy (#6496)', () => {
    // elettra-1938 pattern: EMPTY_OK_CRAWLERS pins consecutiveEmptyRuns at 0
    // forever, so `broken` never trips no matter how long the source has
    // been dead. The separate consecutiveEmptyOkRuns counter must still grow
    // and cross EMPTY_OK_ADVISORY_AFTER_RUNS (30) to surface a signal.
    let state = null;
    for (let i = 0; i < 30; i++) {
      const at = new Date(NOW_MS - (30 - i) * DAY_MS).toISOString();
      ({ state } = nextCrawlerState(
        state,
        {
          slug: 'csvp-poschiavo',
          jobCount: 0,
          freshnessAt: at,
          freshnessSource: 'summary',
          generatedAt: at,
          assembledAt: at,
        },
        at,
        Date.parse(at),
      ));
    }
    expect(state.status).toBe('healthy');
    expect(state.consecutiveEmptyRuns).toBe(0);
    expect(state.consecutiveEmptyOkRuns).toBe(30);
    expect(state.advisory).toBe(true);
    expect(state.advisoryReason).toMatch(/30 consecutive empty-ok runs/);
  });

  it('does not raise an advisory before crossing the threshold', () => {
    let state = null;
    for (let i = 0; i < 29; i++) {
      const at = new Date(NOW_MS - (29 - i) * DAY_MS).toISOString();
      ({ state } = nextCrawlerState(
        state,
        {
          slug: 'csvp-poschiavo',
          jobCount: 0,
          freshnessAt: at,
          freshnessSource: 'summary',
          generatedAt: at,
          assembledAt: at,
        },
        at,
        Date.parse(at),
      ));
    }
    expect(state.status).toBe('healthy');
    expect(state.consecutiveEmptyOkRuns).toBe(29);
    expect(state.advisory).toBe(false);
    expect(state.advisoryReason).toBeNull();
  });

  it('resets consecutiveEmptyOkRuns and clears the advisory once jobs return', () => {
    const prev = {
      lastSuccessfulRunAt: null,
      lastNonZeroJobs: 0,
      consecutiveEmptyRuns: 0,
      consecutiveEmptyOkRuns: 40,
      advisory: true,
      advisoryReason: '40 consecutive empty-ok runs (>= 30) — verify the source is still alive, not just "legitimately quiet"',
      lastFailureReason: null,
      status: 'healthy',
      _lastObservedAt: new Date(NOW_MS - DAY_MS).toISOString(),
      _lastObservedJobs: 0,
    };
    const { state } = nextCrawlerState(
      prev,
      obs(new Date(NOW_MS - 30 * 60 * 1000).toISOString(), 3, { assembledAt: new Date(NOW_MS - 30 * 60 * 1000).toISOString() }),
      NOW_ISO,
      NOW_MS,
    );
    expect(state.consecutiveEmptyOkRuns).toBe(0);
    expect(state.advisory).toBe(false);
    expect(state.advisoryReason).toBeNull();
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

describe('nextCrawlerState — discovered/written auto-classification (#5945)', () => {
  // Baronie-style shape: a summary slice MAY report `discovered` (pre-filter
  // count) and `written` (post-filter count). When discovered > 0 and the
  // run is empty, the crawler found candidates but its own Swiss/location
  // filter dropped all of them — that is "filtered", not "broken", and the
  // monitor should classify it as such without the slug being on the manual
  // EMPTY_OK_CRAWLERS allowlist.
  function obsWithCounts(jobCount: number, discovered: number | null, written: number | null) {
    return {
      slug: 'not-on-any-allowlist',
      jobCount,
      freshnessAt: NOW_ISO,
      freshnessSource: 'summary' as const,
      generatedAt: NOW_ISO,
      assembledAt: NOW_ISO,
      discovered,
      written,
    };
  }

  it('auto-classifies a fresh zero-job run as healthy when discovered > 0 (found, all filtered)', () => {
    const { status, reason, state } = nextCrawlerState(
      undefined,
      obsWithCounts(0, 12, 0),
      NOW_ISO,
      NOW_MS,
    );
    expect(status).toBe('healthy');
    expect(reason).toBeNull();
    expect(state._autoFilteredEmpty).toBe(true);
    expect(state._lastObservedDiscoveredCount).toBe(12);
    expect(state._lastObservedWrittenCount).toBe(0);
  });

  it('does not reset an existing empty streak — an already-broken slug stays broken-eligible without the discovered signal', () => {
    // Absence of the signal (undefined/null discovered) must behave exactly
    // as before this change: no auto-classification, empty-streak gate applies.
    const prev = {
      lastSuccessfulRunAt: null,
      lastNonZeroJobs: 0,
      consecutiveEmptyRuns: 2,
      lastFailureReason: null,
      status: 'healthy',
      _lastObservedAt: new Date(NOW_MS - DAY_MS).toISOString(),
      _lastObservedJobs: 0,
    };
    const { status, state } = nextCrawlerState(
      prev,
      obsWithCounts(0, null, null),
      NOW_ISO,
      NOW_MS,
    );
    expect(status).toBe('broken');
    expect(state._autoFilteredEmpty).toBe(false);
  });

  it('does NOT auto-classify as filtered when discovered is 0 too (source genuinely empty)', () => {
    const prev = {
      lastSuccessfulRunAt: null,
      lastNonZeroJobs: 0,
      consecutiveEmptyRuns: 2,
      lastFailureReason: null,
      status: 'healthy',
      _lastObservedAt: new Date(NOW_MS - DAY_MS).toISOString(),
      _lastObservedJobs: 0,
    };
    const { status, state } = nextCrawlerState(
      prev,
      obsWithCounts(0, 0, 0),
      NOW_ISO,
      NOW_MS,
    );
    // discovered === 0 too → no evidence of filtering, empty-streak gate
    // still applies exactly like the no-signal case.
    expect(status).toBe('broken');
    expect(state._autoFilteredEmpty).toBe(false);
  });

  it('does not mark autoFilteredEmpty when the run actually found and kept jobs', () => {
    const { state } = nextCrawlerState(
      undefined,
      obsWithCounts(5, 12, 5),
      NOW_ISO,
      NOW_MS,
    );
    expect(state._autoFilteredEmpty).toBe(false);
    expect(state._lastObservedDiscoveredCount).toBe(12);
    expect(state._lastObservedWrittenCount).toBe(5);
  });
});
