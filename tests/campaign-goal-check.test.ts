import { describe, it, expect, vi } from 'vitest';
import { PENDING_JOB_ALERT_ORIGINS } from '@/services/pendingJobAlert';
import {
  CAMPAIGN_START,
  computeMatureAt,
  isMature,
  decideGoalAction,
  buildIssueBody,
  runCampaignGoalCheck,
  isJobIntentBrandQuery,
  alertFunnelOutcome,
  ALERT_CTA_SURFACES,
  ALERT_FUNNEL_EVENT_NAMES,
  ALERT_CTA_SURFACE_DIMENSION,
  ALERT_CTA_SURFACE_NOT_SET,
  ALERT_CTA_SURFACE_MAX_NOT_SET_SHARE,
  buildAlertFunnelGa4Filter,
  checkAlertCtaSurfaceDimension,
  evalAlertFunnelConversionGa4,
  GA4_ERROR_RATE_EVENT_NAMES,
  GA4_ERROR_RATE_ACTIONABLE_TYPES,
  GA4_ERROR_RATE_NON_ACTIONABLE_MESSAGE_FILTERS,
  buildErrorRateGa4Filter,
  evalErrorRateGa4,
  GOALS,
  noGa4Equivalent,
} from '../scripts/campaign-goal-check.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

describe('isJobIntentBrandQuery', () => {
  // #5953: the brand_query_ctr goal (#4306) must only aggregate queries the
  // site can actually act on — a brand mention paired with job intent — not
  // retail/consumer brand queries (store promos, plain brand name) that no
  // job listing can ever win a click on regardless of content.
  it('matches a tracked brand paired with a job-intent term, any locale', () => {
    expect(isJobIntentBrandQuery('coop lavoro ticino')).toBe(true);
    expect(isJobIntentBrandQuery('jysk jobs')).toBe(true);
    expect(isJobIntentBrandQuery('coop emploi valais')).toBe(true);
    expect(isJobIntentBrandQuery('interdiscount stellen')).toBe(true);
    expect(isJobIntentBrandQuery('fielmann karriere')).toBe(true);
    expect(isJobIntentBrandQuery('coop praktikum')).toBe(true);
  });

  it('rejects a bare or retail-intent brand query with no job signal', () => {
    expect(isJobIntentBrandQuery('interdiscount')).toBe(false);
    expect(isJobIntentBrandQuery('fielmann promozione')).toBe(false);
    expect(isJobIntentBrandQuery('jysk schlieren')).toBe(false);
    expect(isJobIntentBrandQuery('offerta fielmann')).toBe(false);
    expect(isJobIntentBrandQuery('coop')).toBe(false);
  });

  it('rejects a job-intent term with no tracked brand', () => {
    expect(isJobIntentBrandQuery('offerte di lavoro ticino')).toBe(false);
  });

  it('handles missing/empty input without throwing', () => {
    expect(isJobIntentBrandQuery('')).toBe(false);
    expect(isJobIntentBrandQuery(undefined)).toBe(false);
  });
});

describe('runCampaignGoalCheck (orchestration, injected goals — no network)', () => {
  // The GA4 vitality guard (scripts/lib/source-liveness.mjs) runs before any
  // `livenessGuarded` goal is evaluated, and abstains when the source is
  // dead. These orchestration tests are about the state machine,
  // not the guard, so they inject a live source; the guard's own abstention
  // behaviour is covered in tests/monitor-source-liveness-guard.test.ts and
  // by the dedicated case at the end of this block.
  const aliveSource = async () => ({
    alive: true, reason: 'test: source alive', windowDays: 30, floor: 500,
    daysEvaluated: [], deadDays: [], totalEvents: 1_000_000, source: 'ga4',
    dailyCounts: new Map(),
  });
  it('marks immature goals as observing without calling evaluate', async () => {
    const evaluate = vi.fn();
    const goals = [{ id: 'g1', title: 'G1', source: 'ga4', matureAfterDays: 14, issueRef: '#1', evaluate }];
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
    const goals = [{ id: 'g2', title: 'G2', source: 'ga4', matureAfterDays: 14, issueRef: '#1', evaluate }];
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
    const goals = [{ id: 'g3', title: 'G3', source: 'ga4', matureAfterDays: 14, issueRef: '#1', evaluate }];
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
    const goals = [{ id: 'g4', title: 'G4', source: 'ga4', matureAfterDays: 14, issueRef: '#1', evaluate }];
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
      { id: 'g5', title: 'G5', source: 'ga4', matureAfterDays: 14, issueRef: '#1', evaluate: failing },
      { id: 'g6', title: 'G6', source: 'ga4', matureAfterDays: 14, issueRef: '#1', evaluate: ok },
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
    // g6 (same source) succeeded, so ga4 is NOT flagged dead this run.
    expect(deadSources).toEqual([]);
  });

  it('never evaluates a guarded GA4 goal when the vitality guard says the source is dead', async () => {
    // Regression cover for #5606/#5607/#5608: during the 2026-07-23 → 08-10
    // PostHog outage the funnel goals turned "0 events" into passed:false and
    // opened "Campaign goal FAILED" issues, while the dead-click goal read 0
    // as beating its target and latched `passed` permanently. A GA4 runReport
    // over an empty window is the same HTTP 200: the goal must not be
    // evaluated at all.
    const evaluate = vi.fn();
    const goals = [
      { id: 'ga1', title: 'GA1', source: 'ga4', livenessGuarded: true, windowDays: 14, matureAfterDays: 14, issueRef: '#1', evaluate },
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
        alive: false, reason: 'ga4 ingested < 500 events/day on 14 of 14 complete day(s)',
        windowDays: 30, floor: 500, daysEvaluated: [], deadDays: [], totalEvents: 70,
        source: 'ga4', dailyCounts: new Map(),
      }),
    });

    expect(evaluate).not.toHaveBeenCalled();
    expect(results.find((r) => r.id === 'ga1')?.state).toBe('unmeasurable');
    expect(createIssueImpl).not.toHaveBeenCalled();
    // A dead GA4 must not blind the goals sourced from somewhere else.
    expect(results.find((r) => r.id === 'gsc1')?.state).toBe('passed');
  });

  it('evaluates a guarded GA4 goal when the vitality guard says the source is alive', async () => {
    // Positive control for the case above: without it, a guard that always
    // abstains would pass the abstention test for the wrong reason.
    const evaluate = vi.fn().mockResolvedValue({ passed: true, value: { x: 1 }, targetDescription: 't', detail: 'd [GA4]' });
    const checkLivenessImpl = vi.fn(aliveSource);
    const { results } = await runCampaignGoalCheck({
      goals: [{ id: 'ga2', title: 'GA2', source: 'ga4', livenessGuarded: true, windowDays: 14, matureAfterDays: 14, issueRef: '#1', evaluate }],
      now: NOW,
      campaignStart: isoDaysAgo(20),
      loadStateImpl: () => ({ goals: {} }),
      saveStateImpl: vi.fn(),
      createIssueImpl: vi.fn(),
      checkLivenessImpl,
    });

    expect(checkLivenessImpl).toHaveBeenCalledTimes(1);
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(results[0].state).toBe('passed');
  });

  it('no product-event goal reads PostHog any more (decision H9, 2026-10-05)', async () => {
    expect(GOALS.some((goal) => goal.source === 'posthog')).toBe(false);
    for (const id of ['alert_funnel_conversion', 'error_rate']) {
      const goal = GOALS.find((g) => g.id === id);
      expect(goal?.source, id).toBe('ga4');
      expect(goal?.livenessGuarded, id).toBe(true);
    }
    const src = fs.readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts/campaign-goal-check.mjs'),
      'utf8',
    );
    expect(src).not.toMatch(/posthog-client\.mjs|runHogQL|checkPostHogLiveness/);
  });

  it('goals with no GA4 equivalent stay unmeasurable: no pass/fail, no issue, even on a live source', async () => {
    const retired = GOALS.filter((g) => ['dead_clicks_reduction', 'calc_deeplink_input_start'].includes(g.id));
    expect(retired.map((g) => g.id).sort()).toEqual(['calc_deeplink_input_start', 'dead_clicks_reduction']);
    const createIssueImpl = vi.fn();
    const { results } = await runCampaignGoalCheck({
      goals: retired,
      now: NOW,
      campaignStart: isoDaysAgo(60),
      loadStateImpl: () => ({ goals: {} }),
      saveStateImpl: vi.fn(),
      createIssueImpl,
      checkLivenessImpl: aliveSource,
    });

    expect(results.length).toBe(retired.length);
    for (const r of results) {
      expect(r.state, r.id).toBe('unmeasurable');
      expect(r.detail, r.id).toContain('nessun equivalente GA4');
    }
    expect(createIssueImpl).not.toHaveBeenCalled();
    const outcome = await noGa4Equivalent('x')();
    expect(outcome.unmeasurable).toBe(true);
  });

  it('keeps a goal already passed under PostHog as passed (state file compatibility)', async () => {
    const evaluate = vi.fn();
    const { results } = await runCampaignGoalCheck({
      goals: [{ id: 'old', title: 'Old', source: 'ga4', livenessGuarded: true, windowDays: 14, matureAfterDays: 14, issueRef: '#1', evaluate }],
      now: NOW,
      campaignStart: isoDaysAgo(20),
      loadStateImpl: () => ({ goals: { old: { state: 'passed', source: 'posthog', detail: 'storico' } } }),
      saveStateImpl: vi.fn(),
      createIssueImpl: vi.fn(),
      checkLivenessImpl: vi.fn(),
    });
    expect(evaluate).not.toHaveBeenCalled();
    expect(results[0].state).toBe('passed');
  });

  it('un goal senza sorgente non tiene un passed letto da PostHog morto: torna unmeasurable', async () => {
    // Stato reale in data/campaign-goal-status.json al 2026-10-05:
    // dead_clicks_reduction "passed" con "0 $dead_click (14gg)", letto sulla
    // finestra PostHog morta. Senza sorgente nessuno puo' riconfermarlo.
    const createIssueImpl = vi.fn();
    const deadClicks = GOALS.find((g: { id: string }) => g.id === 'dead_clicks_reduction');
    const { results } = await runCampaignGoalCheck({
      goals: [deadClicks],
      now: NOW,
      campaignStart: isoDaysAgo(60),
      loadStateImpl: () => ({ goals: { dead_clicks_reduction: { state: 'passed', source: 'posthog', detail: '0 $dead_click (14gg)' } } }),
      saveStateImpl: vi.fn(),
      createIssueImpl,
      checkLivenessImpl: aliveSource,
    });
    expect(results[0].state).toBe('unmeasurable');
    expect(results[0].detail).toContain('nessun equivalente GA4');
    expect(createIssueImpl).not.toHaveBeenCalled();
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
    const goals = [{ id: 'g10', title: 'G10', source: 'ga4', matureAfterDays: 14, issueRef: '#1', evaluate }];
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

describe('campaign goal issue body', () => {
  it('emits a runnable tsx dry-run command accepted by monitor schede', () => {
    const body = buildIssueBody({
      goal: { id: 'alert_funnel_conversion', title: 'Alert funnel', source: 'ga4', matureAfterDays: 14, issueRef: '#4298' },
      outcome: { targetDescription: '>= 5%', detail: '1/100 utenti = 1%' },
      matureAt: '2026-08-01',
    });

    expect(body).toContain('**COMANDO**: `node --import tsx/esm scripts/campaign-goal-check.mjs --dry-run`');
  });
});

/**
 * Regression pin for issue #7311 — `alert_funnel_conversion` (#4298).
 *
 * The goal was scored on raw event counts: `job_alert_created` events over
 * `job_alert_cta_shown` events. The numerator is capped near one per person
 * (one alert per keyword, `MAX_ALERTS_PER_USER` for the rest) while the
 * denominator grows with pageviews × the number of alert CTA surfaces, so
 * every surface added to the site lowered the ratio even when it added
 * conversions. Measured on GA4 over the 14d window of #7311: 12,923
 * impressions from 3,612 people, 238 creations from 163 people — 1.84% per
 * event, 4.51% per person.
 *
 * The target stays 5% and the goal still fails at 4.51%: this pins the unit
 * of the ratio, never the threshold.
 */
describe('alertFunnelOutcome (#7311 — person-scoped funnel)', () => {
  it('keeps the 5% target: 4.51% (the measured person rate) still fails', () => {
    const out = alertFunnelOutcome({ created: 163, shown: 3612 });
    expect(out.value.rate).toBeCloseTo(0.0451, 4);
    expect(out.passed).toBe(false);
  });

  it('passes only at/above 5%', () => {
    expect(alertFunnelOutcome({ created: 5, shown: 100 }).passed).toBe(true);
    expect(alertFunnelOutcome({ created: 49, shown: 1000 }).passed).toBe(false);
  });

  it('is unmeasurable rather than 0% when nobody saw a CTA', () => {
    const out = alertFunnelOutcome({ created: 0, shown: 0 });
    expect(out.value.rate).toBeNull();
    expect(out.passed).toBe(false);
  });

  it('labels the unit in target and detail, and marks GA4 as the source', () => {
    const hog = alertFunnelOutcome({ created: 163, shown: 3612 });
    expect(hog.detail).toContain('163/3612 persone');
    expect(hog.targetDescription).toContain('persone job_alert_created');
    const ga4 = alertFunnelOutcome({ created: 163, shown: 3612, viaGa4: true });
    expect(ga4.detail).toContain('utenti');
    expect(ga4.detail).toContain('[GA4]');
    expect(ga4.detail).not.toContain('fallback');
    expect(ga4.targetDescription).toContain(', GA4');
  });

  it('queries GA4 per person, not per event', () => {
    const src = fs.readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts/campaign-goal-check.mjs'),
      'utf8',
    );
    expect(src).toContain('ga4EventCountByName');
    expect(src).toContain("'totalUsers'");
    expect(src).not.toContain("countIf(event = 'job_alert_cta_shown')");
  });
});

describe('alert funnel surface attribution (#7763/#7764)', () => {
  it('keeps one seven-surface allowlist on the GA4 filter', () => {
    expect(ALERT_CTA_SURFACES).toEqual([
      'inline_card',
      'job_detail_button',
      'job_detail_prompt',
      'job_board_filters',
      'job_match_pill',
      'sticky_banner',
      'end_card',
    ]);
    expect(ALERT_FUNNEL_EVENT_NAMES).toEqual(['job_alert_cta_shown', 'job_alert_created']);

    const filter = buildAlertFunnelGa4Filter();
    expect(filter.andGroup.expressions).toContainEqual({
      filter: { fieldName: 'eventName', inListFilter: { values: ALERT_FUNNEL_EVENT_NAMES } },
    });
    expect(filter.andGroup.expressions).toContainEqual({
      filter: { fieldName: ALERT_CTA_SURFACE_DIMENSION, inListFilter: { values: ALERT_CTA_SURFACES } },
    });
  });

  it('a post-auth replay keeps a qualifying origin without widening the allowlist (issue 9576)', () => {
    // Every origin the guest submit can carry through sign-in is a surface
    // that emits job_alert_cta_shown, so the replayed job_alert_created lands
    // on the numerator of the same population as its impression.
    expect(PENDING_JOB_ALERT_ORIGINS.length).toBeGreaterThan(0);
    for (const origin of PENDING_JOB_ALERT_ORIGINS) {
      expect(ALERT_CTA_SURFACES).toContain(origin);
    }
    // The diagnostic auth-path value stays OUT: no impression is ever
    // emitted under it, and admitting it would inflate only the numerator.
    expect(ALERT_CTA_SURFACES).not.toContain('post_auth_auto');
    expect(ALERT_CTA_SURFACES).not.toContain('post_auth_replay');

    // One filter, both sides: the created and the shown counts are read
    // through the very same surface predicate.
    const filter = buildAlertFunnelGa4Filter();
    expect(filter.andGroup.expressions).toHaveLength(2);
  });

  it('fails closed when GA4 rejects the unregistered custom dimension with 400', async () => {
    const error = Object.assign(
      new Error('GA4 400: Field customEvent:cta_surface is not a valid dimension.'),
      { status: 400 },
    );
    const runReportImpl = vi.fn().mockRejectedValue(error);
    const logImpl = vi.fn();
    const result = await checkAlertCtaSurfaceDimension('token', 14, { runReportImpl, logImpl });

    expect(result.ready).toBe(false);
    expect(result.reason).toContain('custom dimension `cta_surface` non registrata / non popolata');
    expect(logImpl).toHaveBeenCalledWith(expect.stringContaining('cta_surface (not set) n/a'));
    expect(runReportImpl).toHaveBeenCalledWith('token', expect.objectContaining({
      dimensions: [{ name: ALERT_CTA_SURFACE_DIMENSION }],
      metrics: ['totalUsers'],
      windowDays: 14,
    }));
  });

  it('fails closed on an all-(not set) report and never computes a rate', async () => {
    const runReportImpl = vi.fn()
      .mockResolvedValueOnce({
        rows: [{ dimensionValues: [{ value: '(not set)' }], metricValues: [{ value: '100' }] }],
      })
      .mockResolvedValueOnce({ rows: [{ metricValues: [{ value: '100' }] }] })
      .mockResolvedValueOnce({ rows: [{ metricValues: [{ value: '100' }] }] })
      .mockResolvedValueOnce({ rows: [{ metricValues: [{ value: '0' }] }] });
    const logImpl = vi.fn();
    const result = await evalAlertFunnelConversionGa4({ token: 'token', runReportImpl, logImpl });

    expect(result.unmeasurable).toBe(true);
    expect(result.note).toContain('custom dimension `cta_surface` non registrata / non popolata');
    expect(runReportImpl).toHaveBeenCalledTimes(4);
    expect(logImpl).toHaveBeenCalledWith(expect.stringContaining('(not set)'));
  });

  it('prints the coverage quota and applies the allowlist to the GA4 totals', async () => {
    const runReportImpl = vi.fn()
      .mockResolvedValueOnce({
        rows: [
          { dimensionValues: [{ value: 'inline_card' }], metricValues: [{ value: '80' }] },
          { dimensionValues: [{ value: 'job_detail_button' }], metricValues: [{ value: '80' }] },
          { dimensionValues: [{ value: '(not set)' }], metricValues: [{ value: '5' }] },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ metricValues: [{ value: '100' }] }],
      })
      .mockResolvedValueOnce({
        rows: [{ metricValues: [{ value: '5' }] }],
      })
      .mockResolvedValueOnce({
        rows: [{ metricValues: [{ value: '95' }] }],
      })
      .mockResolvedValueOnce({
        rows: [
          { dimensionValues: [{ value: 'job_alert_cta_shown' }], metricValues: [{ value: '100' }] },
          { dimensionValues: [{ value: 'job_alert_created' }], metricValues: [{ value: '10' }] },
        ],
      });
    const logImpl = vi.fn();
    const result = await evalAlertFunnelConversionGa4({ token: 'token', runReportImpl, logImpl });

    expect(result.unmeasurable).toBeUndefined();
    expect(result.value).toMatchObject({ created: 10, shown: 100, rate: 0.1, ctaSurfaceNotSetShare: ALERT_CTA_SURFACE_MAX_NOT_SET_SHARE });
    expect(result.detail).toContain('cta_surface (not set) 5.00%');
    expect(logImpl).toHaveBeenCalledWith(expect.stringContaining('5/100'));
    expect(runReportImpl).toHaveBeenCalledTimes(5);
    expect(runReportImpl.mock.calls[1][1]).toMatchObject({
      dimensions: [],
      metrics: ['totalUsers'],
      dimensionFilter: {
        filter: { fieldName: 'eventName', inListFilter: { values: ALERT_FUNNEL_EVENT_NAMES } },
      },
      windowDays: 14,
    });
    expect(runReportImpl.mock.calls[2][1]).toMatchObject({
      dimensions: [],
      metrics: ['totalUsers'],
      dimensionFilter: {
        andGroup: {
          expressions: [
            {
              filter: { fieldName: 'eventName', inListFilter: { values: ALERT_FUNNEL_EVENT_NAMES } },
            },
            {
              filter: {
                fieldName: ALERT_CTA_SURFACE_DIMENSION,
                stringFilter: { value: ALERT_CTA_SURFACE_NOT_SET, matchType: 'EXACT' },
              },
            },
          ],
        },
      },
      windowDays: 14,
    });
    expect(runReportImpl.mock.calls[3][1]).toMatchObject({
      dimensions: [],
      metrics: ['totalUsers'],
      dimensionFilter: buildAlertFunnelGa4Filter(),
      windowDays: 14,
    });
    expect(runReportImpl.mock.calls[4][1]).toMatchObject({
      dimensions: [{ name: 'eventName' }],
      metrics: ['totalUsers'],
      dimensionFilter: buildAlertFunnelGa4Filter(),
      windowDays: 14,
    });
    expect(runReportImpl.mock.calls[4][1].dimensionFilter).not.toEqual({
      filter: { fieldName: 'eventName', inListFilter: { values: ALERT_FUNNEL_EVENT_NAMES } },
    });
  });
});

describe('error-rate GA4 fallback (#7312)', () => {
  it('keeps the event/type allowlist and mirrors the known self-healed classes', () => {
    const filter = buildErrorRateGa4Filter();
    expect(GA4_ERROR_RATE_EVENT_NAMES).toEqual(['app_error', 'exception']);
    expect(GA4_ERROR_RATE_ACTIONABLE_TYPES).toEqual(['error_boundary', 'api_error', 'unhandled_error']);
    expect(filter.andGroup.expressions).toContainEqual({
      filter: { fieldName: 'eventName', inListFilter: { values: GA4_ERROR_RATE_EVENT_NAMES } },
    });
    expect(filter.andGroup.expressions).toContainEqual({
      filter: { fieldName: 'customEvent:error_type', inListFilter: { values: GA4_ERROR_RATE_ACTIONABLE_TYPES } },
    });
    for (const entry of GA4_ERROR_RATE_NON_ACTIONABLE_MESSAGE_FILTERS) {
      expect(filter.andGroup.expressions).toContainEqual({
        notExpression: { filter: { fieldName: 'customEvent:error_message', stringFilter: entry } },
      });
    }
  });

  it('applies the filtered person numerator without a network call in the regression', async () => {
    const runReportImpl = vi.fn()
      .mockResolvedValueOnce({ rows: [{ metricValues: [{ value: '9' }] }] })
      .mockResolvedValueOnce({ rows: [{ metricValues: [{ value: '1000' }] }] });

    const result = await evalErrorRateGa4({
      tokenImpl: async () => 'token',
      runReportImpl,
    });

    expect(result.passed).toBe(true);
    expect(result.value).toMatchObject({ errorPersons: 9, pageviewPersons: 1000, rate: 0.009 });
    expect(runReportImpl).toHaveBeenCalledTimes(2);
    expect(runReportImpl.mock.calls[0][1]).toMatchObject({
      dimensions: [],
      metrics: ['totalUsers'],
      dimensionFilter: buildErrorRateGa4Filter(),
      windowDays: 30,
    });
    expect(runReportImpl.mock.calls[1][1]).toMatchObject({
      dimensionFilter: { filter: { fieldName: 'eventName', inListFilter: { values: ['page_view'] } } },
      windowDays: 30,
    });
  });
});
