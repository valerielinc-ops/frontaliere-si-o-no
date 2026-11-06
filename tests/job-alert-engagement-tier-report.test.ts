import { describe, it, expect } from 'vitest';
import {
  aggregateEngagementTiers,
  emptyDistribution,
} from '../scripts/report-job-alert-engagement-tiers.mjs';
import { JOB_ALERT_ENGAGEMENT_TIERS } from '../scripts/lib/jobAlertEngagementTier.mjs';

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => NOW - n * DAY;

// Since #5767 the engine asks WHAT was clicked before it calls it engagement:
// a bare `last_click_at` is no longer proof, so the fixtures that mean "this
// person really clicked" carry the url the webhooks write beside it.
const JOB_AD_URL = 'https://frontaliereticino.ch/cerca-lavoro-ticino/annuncio-1';
const clicked = (n: number) => ({ last_click_at: daysAgo(n), last_clicked_url: JOB_AD_URL });

function alert(overrides: Record<string, unknown> = {}) {
  return {
    id: 'a1',
    email: 'user@example.com',
    frequency: 'daily',
    frequencyOverride: false,
    ...overrides,
  };
}

describe('aggregateEngagementTiers', () => {
  it('starts from an all-zero distribution', () => {
    expect(emptyDistribution()).toEqual({ daily: 0, 'every-other-day': 0, weekly: 0 });
  });

  it('counts a manually pinned alert without consulting the engine', () => {
    const alerts = [alert({ frequencyOverride: true, frequency: 'weekly' })];
    const profiles = new Map([['user@example.com', { last_click_at: daysAgo(1) }]]);
    const result = aggregateEngagementTiers(alerts, profiles, NOW);
    expect(result.manualByFrequency).toEqual({ daily: 0, weekly: 1 });
    expect(result.engineDistribution).toEqual(emptyDistribution());
  });

  it('classifies an engine-managed alert into the live tier', () => {
    const alerts = [alert({ email: 'a@x.com' }), alert({ email: 'b@x.com' }), alert({ email: 'c@x.com' })];
    const profiles = new Map([
      ['a@x.com', clicked(1)],
      ['b@x.com', { last_open_at: daysAgo(2) }],
      ['c@x.com', {}],
    ]);
    const result = aggregateEngagementTiers(alerts, profiles, NOW);
    expect(result.engineDistribution).toEqual({ daily: 1, 'every-other-day': 1, weekly: 1 });
    expect(result.totalAlerts).toBe(3);
  });

  it('flags an improvement when the live tier warms up vs. the last stamped snapshot', () => {
    const alerts = [alert({ email: 'a@x.com' })];
    const profiles = new Map([['a@x.com', { ...clicked(1), last_engagement_tier: JOB_ALERT_ENGAGEMENT_TIERS.WEEKLY }]]);
    const result = aggregateEngagementTiers(alerts, profiles, NOW);
    expect(result.delta.improved).toBe(1);
    expect(result.delta.regressed).toBe(0);
  });

  it('flags a regression when the live tier cools down vs. the last stamped snapshot', () => {
    const alerts = [alert({ email: 'a@x.com' })];
    const profiles = new Map([['a@x.com', { last_engagement_tier: JOB_ALERT_ENGAGEMENT_TIERS.DAILY }]]); // no open/click now → weekly
    const result = aggregateEngagementTiers(alerts, profiles, NOW);
    expect(result.delta.regressed).toBe(1);
    expect(result.delta.improved).toBe(0);
  });

  it('counts unchanged when the live tier matches the last stamped snapshot', () => {
    const alerts = [alert({ email: 'a@x.com' })];
    const profiles = new Map([['a@x.com', { ...clicked(1), last_engagement_tier: JOB_ALERT_ENGAGEMENT_TIERS.DAILY }]]);
    const result = aggregateEngagementTiers(alerts, profiles, NOW);
    expect(result.delta.unchanged).toBe(1);
  });

  it('counts a subscriber with no prior stamped tier as noPriorSnapshot, not a delta', () => {
    const alerts = [alert({ email: 'a@x.com' })];
    const profiles = new Map([['a@x.com', {}]]);
    const result = aggregateEngagementTiers(alerts, profiles, NOW);
    expect(result.delta.noPriorSnapshot).toBe(1);
    expect(result.delta.improved).toBe(0);
    expect(result.delta.regressed).toBe(0);
    expect(result.delta.unchanged).toBe(0);
  });

  it('never lets a manually pinned alert contribute to the delta tracker', () => {
    const alerts = [alert({ frequencyOverride: true, frequency: 'daily' })];
    const profiles = new Map([['user@example.com', { last_engagement_tier: JOB_ALERT_ENGAGEMENT_TIERS.WEEKLY }]]);
    const result = aggregateEngagementTiers(alerts, profiles, NOW);
    expect(result.delta.improved + result.delta.regressed + result.delta.unchanged + result.delta.noPriorSnapshot).toBe(0);
  });
});
