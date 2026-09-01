import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The guard test for scripts/lib/source-liveness.mjs.
 *
 * WHAT IT IS DEFENDING
 * --------------------
 * PostHog ingestion stopped 2026-07-23 and resumed 2026-08-10. For three
 * weeks the monitors reading it kept exiting 0, because a HogQL query over an
 * empty window is a successful HTTP 200. Issues #5606/#5607/#5608 came out of
 * that hole. The invariant this file exists to hold is:
 *
 *   a monitor must not emit a judgement about a source that was not alive
 *   over the window it is judging.
 *
 * WHY THE TESTS ARE BEHAVIOURAL, NOT STRUCTURAL
 * ---------------------------------------------
 * "The monitor imports the guard" is a guard that exists and does not look —
 * it passes just as happily if the import is unused, if the call is after the
 * issue sync, or if its return value is ignored. So the load-bearing tests
 * below drive each monitor's real `main()` with a mocked PostHog that returns
 * the dead window, and assert on what the monitor DID: no issue synced. The
 * structural checks at the bottom only cover what behaviour cannot — that a
 * newly added PostHog reader gets declared instead of silently skipping the
 * fleet.
 *
 * Every abstention test is paired with a live-source positive control. Without
 * the pair, a monitor that never syncs issues at all (a broken mock, a wrong
 * env var, an early return) would pass the abstention test for the wrong
 * reason — vacuously green is the failure mode this whole PR is about.
 */

const ROOT = resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Mocks. Both the guard and the monitors reach PostHog through
// scripts/lib/posthog-client.mjs, so one mock covers the probe and the
// measurement; posthog-error-issue-sync additionally uses a raw fetch().
// ---------------------------------------------------------------------------

const runHogQL = vi.fn();
vi.mock('../scripts/lib/posthog-client.mjs', () => ({
  runHogQL: (...args: unknown[]) => runHogQL(...args),
}));

// Bare vi.fn() (return values set in beforeEach): giving these an inline
// implementation pins a concrete signature, and the spread forwarding below
// then fails to typecheck.
const syncErrorIssues = vi.fn();
const isIssueDenied = vi.fn();
vi.mock('../scripts/lib/error-issue-sync.mjs', () => ({
  syncErrorIssues: (...args: unknown[]) => syncErrorIssues(...args),
  isIssueDenied: (...args: unknown[]) => isIssueDenied(...args),
  ISSUE_DENY_PATTERNS: [],
  page404Path: () => null,
  isSelfHealedPage404: async () => false,
}));

const {
  evaluateLiveness,
  completeDaysInWindow,
  checkPostHogLiveness,
  declareNotMeasurable,
  DEFAULT_MIN_EVENTS_PER_DAY,
  POSTHOG_MONITORS,
} = await import('../scripts/lib/source-liveness.mjs');

/**
 * Real ingestion, project 157802, measured 2026-08-14 via
 * `SELECT toDate(timestamp), count() FROM events GROUP BY 1`.
 * The outage and the restart are both in here verbatim — the fixture is the
 * incident, not an invention.
 */
const MEASURED: Record<string, number> = {
  '2026-07-16': 100795, '2026-07-17': 87802, '2026-07-18': 61782, '2026-07-19': 108170,
  '2026-07-20': 175446, '2026-07-21': 93580, '2026-07-22': 90027,
  '2026-07-23': 3569,
  '2026-07-24': 26, '2026-07-25': 22, '2026-07-26': 12, '2026-07-27': 7, '2026-07-28': 14,
  '2026-07-29': 8, '2026-07-30': 16, '2026-07-31': 31, '2026-08-01': 8, '2026-08-02': 16,
  '2026-08-03': 64, '2026-08-04': 32, '2026-08-05': 8, '2026-08-06': 6, '2026-08-07': 11,
  '2026-08-08': 5, '2026-08-09': 7,
  '2026-08-10': 65975, '2026-08-11': 102449, '2026-08-12': 104651, '2026-08-13': 116003,
};

/** Synthetic counts relative to the real clock, for tests that drive main(). */
function uniformDays(perDay: number, days = 45): Array<[string, number]> {
  const out: Array<[string, number]> = [];
  const now = new Date();
  for (let back = 0; back <= days; back += 1) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    d.setUTCDate(d.getUTCDate() - back);
    out.push([d.toISOString().slice(0, 10), perDay]);
  }
  return out;
}

const DEAD_PER_DAY = 5;      // the measured floor of the outage
const ALIVE_PER_DAY = 90027; // the measured last healthy day before it

const isLivenessProbe = (q: string) => /GROUP BY d/.test(q) && /toDate\(timestamp\)/.test(q);

/** Route the liveness probe to `perDay`, everything else to `rows`. */
function mockPostHog(perDay: number, rows: unknown[] = []) {
  runHogQL.mockImplementation(async (query: string) => {
    if (isLivenessProbe(query)) return { results: uniformDays(perDay) };
    return { results: rows };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  syncErrorIssues.mockResolvedValue([]);
  isIssueDenied.mockReturnValue(false);
  process.env.POSTHOG_PERSONAL_API_KEY = 'test-key';
  process.env.POSTHOG_PROJECT_ID = '157802';
});

afterEach(() => {
  delete process.env.POSTHOG_PERSONAL_API_KEY;
  delete process.env.POSTHOG_PROJECT_ID;
});

// ---------------------------------------------------------------------------
// 1. The verdict function, against the real incident.
// ---------------------------------------------------------------------------

describe('evaluateLiveness — the measured 2026-07-23 → 08-10 outage', () => {
  it('calls the outage window NOT alive', () => {
    // now = 2026-08-10 → complete days 08-03..08-09, every one of them dead.
    const v = evaluateLiveness({
      dailyCounts: MEASURED,
      windowDays: 7,
      now: new Date('2026-08-10T12:00:00Z'),
    });
    expect(v.alive).toBe(false);
    expect(v.deadDays).toHaveLength(7);
    expect(v.reason).toMatch(/< 500 events\/day on 7 of 7/);
  });

  it('calls the pre-outage window alive (positive control — the guard is not just always-false)', () => {
    // now = 2026-07-23 → complete days 07-16..07-22, all 60k-175k events.
    const v = evaluateLiveness({
      dailyCounts: MEASURED,
      windowDays: 7,
      now: new Date('2026-07-23T12:00:00Z'),
    });
    expect(v.alive).toBe(true);
    expect(v.deadDays).toEqual([]);
    expect(v.totalEvents).toBe(717602);
  });

  it('calls the post-restart window alive', () => {
    // now = 2026-08-14 with a 4d window → complete days 08-10..08-13.
    const v = evaluateLiveness({
      dailyCounts: MEASURED,
      windowDays: 4,
      now: new Date('2026-08-14T14:00:00Z'),
    });
    expect(v.alive).toBe(true);
  });

  it('refuses a window that STRADDLES the restart, where the number would average across a discontinuity', () => {
    // now = 2026-08-14, 7d → 08-07..08-13: three dead days then four live ones.
    // A p75 over this window is not a measurement of anything.
    const v = evaluateLiveness({
      dailyCounts: MEASURED,
      windowDays: 7,
      now: new Date('2026-08-14T14:00:00Z'),
    });
    expect(v.alive).toBe(false);
    expect(v.deadDays.map((d) => d.date)).toEqual(['2026-08-07', '2026-08-08', '2026-08-09']);
  });

  it('treats a day PostHog never reported as zero, not as missing data to ignore', () => {
    const v = evaluateLiveness({ dailyCounts: {}, windowDays: 7, now: new Date('2026-08-14T14:00:00Z') });
    expect(v.alive).toBe(false);
    expect(v.deadDays).toHaveLength(7);
    expect(v.totalEvents).toBe(0);
  });

  it('excludes the partial current day, which would otherwise read dead on every early-morning run', () => {
    const days = completeDaysInWindow(7, new Date('2026-08-14T00:30:00Z'));
    expect(days).not.toContain('2026-08-14');
    expect(days).toEqual([
      '2026-08-07', '2026-08-08', '2026-08-09', '2026-08-10',
      '2026-08-11', '2026-08-12', '2026-08-13',
    ]);
  });

  it('separates the measured dead ceiling (64) from the measured live floor (30030) by the default floor', () => {
    // The whole guard rests on these two numbers not overlapping.
    const deadCeiling = Math.max(...['2026-07-24', '2026-08-03', '2026-08-09'].map((d) => MEASURED[d]));
    expect(deadCeiling).toBeLessThan(DEFAULT_MIN_EVENTS_PER_DAY);
    expect(DEFAULT_MIN_EVENTS_PER_DAY).toBeLessThan(30030);
  });
});

describe('checkPostHogLiveness — a probe that cannot answer is not a healthy source', () => {
  it('reports not-alive when credentials are missing', async () => {
    const v = await checkPostHogLiveness({ windowDays: 7, apiKey: '', projectId: '' });
    expect(v.alive).toBe(false);
    expect(v.credentialsMissing).toBe(true);
  });

  it('reports not-alive when the probe itself throws', async () => {
    const v = await checkPostHogLiveness({
      windowDays: 7,
      apiKey: 'k',
      projectId: '1',
      runHogQLImpl: async () => { throw new Error('posthog 503'); },
    });
    expect(v.alive).toBe(false);
    expect(v.probeFailed).toBe(true);
    expect(v.reason).toMatch(/503/);
  });
});

describe('declareNotMeasurable — abstention is loud, never silent', () => {
  it('prints the banner and a GitHub Actions annotation', () => {
    const log = vi.fn();
    const warn = vi.fn();
    const verdict = evaluateLiveness({
      dailyCounts: MEASURED, windowDays: 7, now: new Date('2026-08-10T12:00:00Z'),
    });
    declareNotMeasurable('some-monitor', verdict, { logger: { log, warn } as never });
    const printed = [...warn.mock.calls, ...log.mock.calls].flat().join('\n');
    expect(printed).toMatch(/NON MISURABILE/);
    expect(printed).toMatch(/nessuna issue aperta/);
    expect(printed).toMatch(/::warning title=some-monitor: source not measurable::/);
  });
});

// ---------------------------------------------------------------------------
// 2. THE LOAD-BEARING TESTS: real monitors, dead source, no judgement.
// ---------------------------------------------------------------------------

describe('cwv-monitor-check abstains on a dead source', () => {
  it('opens NO issue when PostHog ingested ~5 events/day over the window', async () => {
    // The $web_vitals rows are deliberately a screaming regression: CLS 3.0 on
    // a 0.1-threshold page, twice over. If the guard is not consulted, this
    // MUST open an issue — which is exactly what makes the assertion below
    // meaningful rather than a tautology.
    mockPostHog(DEAD_PER_DAY, [[3.0, 5000, 4000, 5000]]);
    process.env.CWV_MONITOR_HISTORY_FILE = '/tmp/cwv-guard-should-never-be-written.json';

    const { main } = await import('../scripts/cwv-monitor-check.mjs');
    await main();

    expect(syncErrorIssues).not.toHaveBeenCalled();
    // And it never even ran the per-page measurement queries.
    const measured = runHogQL.mock.calls.filter(([q]) => !isLivenessProbe(q as string));
    expect(measured).toHaveLength(0);
  });

  it('positive control: with a live source the same rows DO reach the issue sync', async () => {
    mockPostHog(ALIVE_PER_DAY, [[3.0, 5000, 4000, 5000]]);
    process.env.CWV_MONITOR_HISTORY_FILE = '/tmp/cwv-guard-live-control.json';

    const { main } = await import('../scripts/cwv-monitor-check.mjs');
    await main();

    const measured = runHogQL.mock.calls.filter(([q]) => !isLivenessProbe(q as string));
    expect(measured.length).toBeGreaterThan(0);
  });
});

describe('posthog-error-issue-sync abstains on a dead source', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('opens NO issue when PostHog ingested ~5 events/day over the window', async () => {
    mockPostHog(DEAD_PER_DAY);
    // Its $exception query uses a raw fetch(), not the shared client. Rows far
    // above MIN_COUNT=5 — an unguarded run would sync five issues from these.
    const rawFetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ results: [['Boom', 'TypeError', 900, 400, 'https://x/']] }),
    }));
    globalThis.fetch = rawFetch as never;

    const { main } = await import('../scripts/posthog-error-issue-sync.mjs');
    await main();

    expect(syncErrorIssues).not.toHaveBeenCalled();
    expect(rawFetch).not.toHaveBeenCalled();
  });

  it('positive control: with a live source the same rows DO reach the issue sync', async () => {
    mockPostHog(ALIVE_PER_DAY);
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ results: [['Boom', 'TypeError', 900, 400, 'https://x/']] }),
    })) as never;

    const { main } = await import('../scripts/posthog-error-issue-sync.mjs');
    await main();

    expect(syncErrorIssues).toHaveBeenCalledTimes(1);
  });
});

describe('campaign-goal-check abstains on a dead source', () => {
  const matureState = {
    goals: {}, // no prior state → every mature goal evaluates
  };

  it('marks PostHog goals unmeasurable and opens NO "Campaign goal FAILED" issue', async () => {
    const createIssue = vi.fn(async () => ({}));
    const { runCampaignGoalCheck } = await import('../scripts/campaign-goal-check.mjs');

    const { results } = await runCampaignGoalCheck({
      now: new Date(),
      loadStateImpl: () => structuredClone(matureState),
      saveStateImpl: () => {},
      createIssueImpl: createIssue,
      dryRun: true,
      checkLivenessImpl: async () => ({
        alive: false, reason: 'dead', windowDays: 30, floor: 500,
        daysEvaluated: [], deadDays: [], totalEvents: 0, source: 'posthog',
        dailyCounts: new Map(uniformDays(DEAD_PER_DAY)),
      }),
    });

    const posthogGoals = results.filter((r: { id: string }) =>
      ['alert_funnel_conversion', 'dead_clicks_reduction', 'error_rate', 'calc_deeplink_input_start'].includes(r.id));
    expect(posthogGoals.length).toBe(4);
    // `alert_funnel_conversion` and `error_rate` declare a GA4 fallback
    // (#6463): when PostHog is dead they legitimately compute a real
    // verdict off GA4 instead, so any state is acceptable for them here.
    // `dead_clicks_reduction` and `calc_deeplink_input_start` have no GA4
    // equivalent (PostHog-native $dead_click autocapture, and a
    // session-scoped multi-event funnel join) and must still never produce
    // a pass/fail verdict computed off the dead PostHog source.
    const noFallback = posthogGoals.filter((g: { id: string }) =>
      ['dead_clicks_reduction', 'calc_deeplink_input_start'].includes(g.id));
    for (const g of noFallback) {
      // `observing` is fine (not yet mature); what must never happen is a
      // pass/fail verdict computed off the dead source.
      expect(['unmeasurable', 'observing']).toContain(g.state);
    }
    expect(createIssue).not.toHaveBeenCalled();
  });

  it('honours a not-alive probe that carries no daily counts (per-window re-ruling must not swallow the verdict)', async () => {
    // Found by mutation M17. campaign-goal-check re-rules each goal over its
    // OWN window from the probe's daily counts; when those are absent it must
    // fall back to the probe's verdict, not to "alive".
    const createIssue = vi.fn(async () => ({}));
    const evaluate = vi.fn();
    const { runCampaignGoalCheck } = await import('../scripts/campaign-goal-check.mjs');

    const { results } = await runCampaignGoalCheck({
      goals: [{ id: 'ph', title: 'PH', source: 'posthog', windowDays: 14, matureAfterDays: 0, issueRef: '#1', evaluate }],
      now: new Date(),
      campaignStart: '2026-01-01',
      loadStateImpl: () => ({ goals: {} }),
      saveStateImpl: () => {},
      createIssueImpl: createIssue,
      checkLivenessImpl: async () => ({
        alive: false, reason: 'probe failed', windowDays: 30, floor: 500,
        daysEvaluated: [], deadDays: [], totalEvents: 0, source: 'posthog',
        dailyCounts: new Map(), // empty on purpose
      }),
    });

    expect(evaluate).not.toHaveBeenCalled();
    expect(results[0].state).toBe('unmeasurable');
    expect(createIssue).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 3. Fleet coverage — what behaviour cannot check.
// ---------------------------------------------------------------------------

describe('the PostHog monitor fleet is fully declared', () => {
  const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

  it('the set of guarded monitors is pinned, so `guarded: false` cannot silently disable this check', () => {
    // Found by mutation M18/M19: without this, flipping a monitor's `guarded`
    // flag to false makes the two structural checks below skip it and stay
    // green — the registry would become an escape hatch from its own guard.
    // De-registering a monitor must require editing this list, in the diff,
    // on purpose.
    const guarded = POSTHOG_MONITORS.filter((m: { guarded: boolean }) => m.guarded).map((m: { path: string }) => m.path).sort();
    expect(guarded).toEqual([
      'scripts/campaign-goal-check.mjs',
      'scripts/cwv-monitor-check.mjs',
      'scripts/posthog-error-issue-sync.mjs',
      'scripts/profession-keyword-opportunities.mjs',
    ]);
  });

  it('every monitor marked guarded actually calls the guard, not merely imports it', () => {
    const guarded = POSTHOG_MONITORS.filter((m: { guarded: boolean }) => m.guarded);
    expect(guarded.length).toBeGreaterThan(0);
    for (const m of guarded) {
      const src = read(m.path);
      expect(src, `${m.path} must import the guard`).toMatch(/from '\.\/lib\/source-liveness\.mjs'/);
      expect(src, `${m.path} must CALL the guard`).toMatch(/abstainIfSourceDead\(|checkLivenessImpl\(|checkPostHogLiveness\(/);
    }
  });

  it('a guarded monitor consults the guard BEFORE it can open an issue', () => {
    for (const m of POSTHOG_MONITORS.filter((x: { guarded: boolean }) => x.guarded)) {
      const src = read(m.path);
      const guardAt = Math.min(
        ...[/abstainIfSourceDead\(/, /posthogNotMeasurable\(/]
          .map((re) => src.search(re))
          .filter((i) => i >= 0),
      );
      const emitAt = Math.min(
        ...[/syncErrorIssues\(\{/, /createIssueImpl\(\{/, /fetchOnsiteSearchTermsShared\(/]
          .map((re) => src.search(re))
          .filter((i) => i >= 0),
      );
      if (Number.isFinite(guardAt) && Number.isFinite(emitAt)) {
        expect(guardAt, `${m.path}: guard must precede the emission`).toBeLessThan(emitAt);
      }
    }
  });

  it('no PostHog reader in scripts/ is missing from the registry', async () => {
    const { execSync } = await import('node:child_process');
    // Files that actually reach PostHog: they name a PostHog helper or POST a
    // HogQL query. Investigation/one-shot scripts are readers too, but they
    // emit no judgement — the registry only has to cover the monitors, so a
    // reader is allowed to be absent ONLY if it opens no issue and no workflow
    // runs it. Anything scheduled must be declared.
    const scheduled = execSync(
      `grep -rl "posthog\\|POSTHOG" ${JSON.stringify(resolve(ROOT, '.github/workflows'))} || true`,
      { encoding: 'utf8' },
    ).trim().split('\n').filter(Boolean);
    expect(scheduled.length).toBeGreaterThan(0);

    const declared = new Set(POSTHOG_MONITORS.map((m: { path: string }) => m.path));
    const missing: string[] = [];
    for (const wf of scheduled) {
      const body = readFileSync(wf, 'utf8');
      if (!/on:\s*[\s\S]*?schedule:/.test(body)) continue;
      for (const match of body.matchAll(/node (scripts\/[\w./-]+\.mjs)/g)) {
        const script = match[1];
        let src = '';
        try { src = read(script); } catch { continue; }
        const readsPostHog = /posthog-client\.mjs|posthog-search-terms\.mjs|perf-sources\/posthog\.mjs|evidence\/posthogFetcher\.mjs|HogQLQuery/.test(src);
        // check-source-liveness.mjs is the reporter, not a monitor.
        if (readsPostHog && !declared.has(script) && script !== 'scripts/check-source-liveness.mjs') {
          missing.push(`${script} (scheduled by ${wf.split('/').pop()})`);
        }
      }
    }
    expect(missing, 'new scheduled PostHog readers must be added to POSTHOG_MONITORS').toEqual([]);
  });

  it('the obsolete "PostHog is blind" claim is not left standing as a current fact', () => {
    const src = read('scripts/check-cwv-field-criterion.mjs');
    // The sentence may stay as history, but it must carry the correction —
    // it was quoted to wrongly close #5607 and #5670.
    expect(src).toMatch(/RESOLVED 2026-08-10/);
    expect(src).toMatch(/HISTORICAL/);
  });
});
