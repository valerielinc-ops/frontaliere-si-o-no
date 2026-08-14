import { describe, it, expect, vi } from 'vitest';
import {
  CAMPAIGN_START,
  computeMatureAt,
  isMature,
  decideGoalAction,
  runCampaignGoalCheck,
} from '../scripts/campaign-goal-check.mjs';

// Maturation must gate on real elapsed time (14/30/90-day windows), so
// fixtures are relative to actual now — never hardcoded absolute dates
// (AGENTS.md: "date fixture relative a now, mai literal"). CAMPAIGN_START
// itself is the one legitimate absolute-date constant (owner-declared
// kickoff for issues #4298-#4307), so asserting its literal value is a
// sanity check, not a time-bomb.
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date();
const isoDaysAgo = (n: number) => new Date(NOW.getTime() - n * DAY).toISOString().slice(0, 10);
const isoDaysAhead = (n: number) => new Date(NOW.getTime() + n * DAY).toISOString().slice(0, 10);

describe('CAMPAIGN_START', () => {
  it('is the declared campaign kickoff date for #4298-#4307', () => {
    expect(CAMPAIGN_START).toBe('2026-07-17');
  });
});

describe('computeMatureAt', () => {
  it('adds matureAfterDays to campaignStart', () => {
    const start = isoDaysAgo(0);
    expect(computeMatureAt(start, 14)).toBe(isoDaysAhead(14));
  });
});

describe('isMature', () => {
  it('is false before the mature date', () => {
    expect(isMature(isoDaysAhead(1), NOW)).toBe(false);
  });

  it('is true on/after the mature date', () => {
    expect(isMature(isoDaysAgo(1), NOW)).toBe(true);
    expect(isMature(isoDaysAgo(0), NOW)).toBe(true);
  });
});

describe('decideGoalAction', () => {
  it('skips re-evaluation once a goal already passed, regardless of maturity', () => {
    expect(decideGoalAction({ matureAt: isoDaysAgo(5), now: NOW, priorState: 'passed' })).toBe('skip-passed');
    expect(decideGoalAction({ matureAt: isoDaysAhead(5), now: NOW, priorState: 'passed' })).toBe('skip-passed');
  });

  it('stays observing before maturity regardless of prior non-passed state', () => {
    expect(decideGoalAction({ matureAt: isoDaysAhead(5), now: NOW, priorState: undefined })).toBe('observing');
    expect(decideGoalAction({ matureAt: isoDaysAhead(5), now: NOW, priorState: 'failing' })).toBe('observing');
    expect(decideGoalAction({ matureAt: isoDaysAhead(5), now: NOW, priorState: 'error' })).toBe('observing');
  });

  it('evaluates once mature and not yet passed', () => {
    expect(decideGoalAction({ matureAt: isoDaysAgo(1), now: NOW, priorState: undefined })).toBe('evaluate');
    expect(decideGoalAction({ matureAt: isoDaysAgo(1), now: NOW, priorState: 'failing' })).toBe('evaluate');
    expect(decideGoalAction({ matureAt: isoDaysAgo(1), now: NOW, priorState: 'error' })).toBe('evaluate');
    expect(decideGoalAction({ matureAt: isoDaysAgo(1), now: NOW, priorState: 'observing' })).toBe('evaluate');
  });
});

describe('runCampaignGoalCheck (orchestration, injected goals — no network)', () => {
  // The PostHog vitality guard (scripts/lib/source-liveness.mjs) now runs
  // before any `source: 'posthog'` goal is evaluated, and abstains when the
  // source is dead. These orchestration tests are about the state machine,
  // not the guard, so they inject a live source; the guard's own abstention
  // behaviour is covered in tests/monitor-source-liveness-guard.test.ts and
  // by the dedicated case at the end of this block.
  const aliveSource = async () => ({
    alive: true, reason: 'test: source alive', windowDays: 30, floor: 500,
    daysEvaluated: [], deadDays: [], totalEvents: 1_000_000, source: 'posthog',
    dailyCounts: new Map(),
  });
  it('marks immature goals as observing without calling evaluate', async () => {
    const evaluate = vi.fn();
    const goals = [{ id: 'g1', title: 'G1', source: 'posthog', matureAfterDays: 14, issueRef: '#1', evaluate }];
    const { results, state } = await runCampaignGoalCheck({
      goals,
      now: NOW,
      campaignStart: isoDaysAgo(1), // matures in 13 days
      loadStateImpl: () => ({ goals: {} }),
      saveStateImpl: vi.fn(),
      checkLivenessImpl: aliveSource,
      createIssueImpl: vi.fn(),
    });
    expect(evaluate).not.toHaveBeenCalled();
    expect(results[0].state).toBe('observing');
    expect(state.goals.g1.state).toBe('observing');
  });

  it('marks a passing goal as passed and does not open an issue', async () => {
    const evaluate = vi.fn().mockResolvedValue({ passed: true, value: { x: 1 }, targetDescription: 't', detail: 'd' });
    const goals = [{ id: 'g2', title: 'G2', source: 'posthog', matureAfterDays: 14, issueRef: '#1', evaluate }];
    const createIssueImpl = vi.fn();
    const { results, state } = await runCampaignGoalCheck({
      goals,
      now: NOW,
      campaignStart: isoDaysAgo(20),
      loadStateImpl: () => ({ goals: {} }),
      saveStateImpl: vi.fn(),
      checkLivenessImpl: aliveSource,
      createIssueImpl,
    });
    expect(results[0].state).toBe('passed');
    expect(state.goals.g2.state).toBe('passed');
    expect(createIssueImpl).not.toHaveBeenCalled();
  });

  it('opens an issue and marks failing when a mature goal misses target', async () => {
    const evaluate = vi.fn().mockResolvedValue({ passed: false, value: { x: 0 }, targetDescription: 't', detail: 'd' });
    const goals = [{ id: 'g3', title: 'G3', source: 'posthog', matureAfterDays: 14, issueRef: '#1', evaluate }];
    const createIssueImpl = vi.fn().mockResolvedValue({ number: 1 });
    const { results } = await runCampaignGoalCheck({
      goals,
      now: NOW,
      campaignStart: isoDaysAgo(20),
      loadStateImpl: () => ({ goals: {} }),
      saveStateImpl: vi.fn(),
      checkLivenessImpl: aliveSource,
      createIssueImpl,
    });
    expect(results[0].state).toBe('failing');
    expect(createIssueImpl).toHaveBeenCalledTimes(1);
    expect(createIssueImpl.mock.calls[0][0].title).toBe('Campaign goal FAILED: g3');
  });

  it('never re-evaluates a goal already marked passed in prior state', async () => {
    const evaluate = vi.fn();
    const goals = [{ id: 'g4', title: 'G4', source: 'posthog', matureAfterDays: 14, issueRef: '#1', evaluate }];
    const priorState = { goals: { g4: { state: 'passed', lastValue: { x: 1 }, detail: 'ok' } } };
    const { results } = await runCampaignGoalCheck({
      goals,
      now: NOW,
      campaignStart: isoDaysAgo(20),
      loadStateImpl: () => priorState,
      saveStateImpl: vi.fn(),
      checkLivenessImpl: aliveSource,
      createIssueImpl: vi.fn(),
    });
    expect(evaluate).not.toHaveBeenCalled();
    expect(results[0].state).toBe('passed');
    expect(results[0].detail).toBe('ok');
  });

  it('marks error state without opening an issue on a provider failure', async () => {
    const failing = vi.fn().mockRejectedValue(new Error('boom'));
    const ok = vi.fn().mockResolvedValue({ passed: true, value: {}, targetDescription: 't', detail: 'd' });
    const goals = [
      { id: 'g5', title: 'G5', source: 'posthog', matureAfterDays: 14, issueRef: '#1', evaluate: failing },
      { id: 'g6', title: 'G6', source: 'posthog', matureAfterDays: 14, issueRef: '#1', evaluate: ok },
    ];
    const createIssueImpl = vi.fn();
    const { results, deadSources } = await runCampaignGoalCheck({
      goals,
      now: NOW,
      campaignStart: isoDaysAgo(20),
      loadStateImpl: () => ({ goals: {} }),
      saveStateImpl: vi.fn(),
      checkLivenessImpl: aliveSource,
      createIssueImpl,
    });
    expect(results.find((r) => r.id === 'g5')?.state).toBe('error');
    expect(createIssueImpl).not.toHaveBeenCalled();
    // g6 (same source) succeeded, so posthog is NOT flagged dead this run.
    expect(deadSources).toEqual([]);
  });

  it('never evaluates a PostHog goal when the vitality guard says the source is dead', async () => {
    // Regression cover for #5606/#5607/#5608: during the 2026-07-23 → 08-10
    // outage evalAlertFunnelConversion and evalCalcDeeplinkInputStart turned
    // "0 events" into passed:false and opened "Campaign goal FAILED" issues,
    // while evalDeadClicksReduction read 0 as beating its target and latched
    // `passed` permanently. The goal must not be evaluated at all.
    const evaluate = vi.fn();
    const goals = [
      { id: 'ph1', title: 'PH1', source: 'posthog', windowDays: 14, matureAfterDays: 14, issueRef: '#1', evaluate },
      { id: 'gsc1', title: 'GSC1', source: 'gsc', matureAfterDays: 14, issueRef: '#2', evaluate: vi.fn().mockResolvedValue({ passed: true, value: {}, targetDescription: 't', detail: 'd' }) },
    ];
    const createIssueImpl = vi.fn();
    const { results } = await runCampaignGoalCheck({
      goals,
      now: NOW,
      campaignStart: isoDaysAgo(20),
      loadStateImpl: () => ({ goals: {} }),
      saveStateImpl: vi.fn(),
      createIssueImpl,
      checkLivenessImpl: async () => ({
        alive: false, reason: 'posthog ingested < 500 events/day on 14 of 14 complete day(s)',
        windowDays: 30, floor: 500, daysEvaluated: [], deadDays: [], totalEvents: 70,
        source: 'posthog', dailyCounts: new Map(),
      }),
    });

    expect(evaluate).not.toHaveBeenCalled();
    expect(results.find((r) => r.id === 'ph1')?.state).toBe('unmeasurable');
    expect(createIssueImpl).not.toHaveBeenCalled();
    // A dead PostHog must not blind the goals sourced from somewhere else.
    expect(results.find((r) => r.id === 'gsc1')?.state).toBe('passed');
  });

  it('flags a source as dead when every attempted goal for it errors this run', async () => {
    const failing = vi.fn().mockRejectedValue(new Error('auth broken'));
    const goals = [
      { id: 'g7', title: 'G7', source: 'gsc', matureAfterDays: 14, issueRef: '#1', evaluate: failing },
      { id: 'g8', title: 'G8', source: 'gsc', matureAfterDays: 14, issueRef: '#1', evaluate: failing },
    ];
    const { deadSources } = await runCampaignGoalCheck({
      goals,
      now: NOW,
      campaignStart: isoDaysAgo(20),
      loadStateImpl: () => ({ goals: {} }),
      saveStateImpl: vi.fn(),
      checkLivenessImpl: aliveSource,
      createIssueImpl: vi.fn(),
    });
    expect(deadSources).toEqual(['gsc']);
  });

  it('marks unmeasurable without opening an issue', async () => {
    const evaluate = vi.fn().mockResolvedValue({ unmeasurable: true, note: 'endpoint not available' });
    const goals = [{ id: 'g9', title: 'G9', source: 'bing', matureAfterDays: 14, issueRef: '#1', evaluate }];
    const createIssueImpl = vi.fn();
    const { results } = await runCampaignGoalCheck({
      goals,
      now: NOW,
      campaignStart: isoDaysAgo(20),
      loadStateImpl: () => ({ goals: {} }),
      saveStateImpl: vi.fn(),
      checkLivenessImpl: aliveSource,
      createIssueImpl,
    });
    expect(results[0].state).toBe('unmeasurable');
    expect(createIssueImpl).not.toHaveBeenCalled();
  });

  it('never calls saveStateImpl or createIssueImpl in dry-run mode', async () => {
    const evaluate = vi.fn().mockResolvedValue({ passed: false, value: {}, targetDescription: 't', detail: 'd' });
    const goals = [{ id: 'g10', title: 'G10', source: 'posthog', matureAfterDays: 14, issueRef: '#1', evaluate }];
    const saveStateImpl = vi.fn();
    const createIssueImpl = vi.fn();
    const { results } = await runCampaignGoalCheck({
      goals,
      now: NOW,
      campaignStart: isoDaysAgo(20),
      loadStateImpl: () => ({ goals: {} }),
      saveStateImpl,
      createIssueImpl,
      checkLivenessImpl: aliveSource,
      dryRun: true,
    });
    expect(results[0].state).toBe('failing');
    expect(saveStateImpl).not.toHaveBeenCalled();
    expect(createIssueImpl).not.toHaveBeenCalled();
  });
});
