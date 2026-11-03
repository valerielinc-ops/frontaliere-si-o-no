import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  advanceAudienceGrowthCycles,
  buildSocialGrowthScorecard,
  freezeEligibleSocialSiteOutcomeBaselines,
  renderSocialGrowthScorecard,
} from '../scripts/lib/social-growth-scorecard.mjs';
import { createScorecard, loadSocialPublicationLedgers } from '../scripts/social-growth-scorecard.mjs';

const AS_OF = new Date('2026-11-02T12:00:00.000Z');

describe('cross-social growth scorecard', () => {
  it('combines Facebook and Telegram ledgers while failing closed on a missing source ledger', () => {
    const root = mkdtempSync(join(tmpdir(), 'social-scorecard-ledgers-'));
    try {
      const paths = Object.fromEntries([
        'instagram', 'tiktok', 'linkedinMember', 'facebookJobs', 'facebookArticles',
        'facebookEvents', 'telegramJobs', 'telegramAnnouncements',
      ].map((name) => [name, join(root, `${name}.json`)]));
      for (const [name, path] of Object.entries(paths)) {
        mkdirSync(root, { recursive: true });
        writeFileSync(path, JSON.stringify({ posted: [{ id: name, ts: '2026-11-01T12:00:00.000Z' }] }));
      }

      const complete = loadSocialPublicationLedgers(paths);
      expect(complete.facebook).toMatchObject({ status: 'available' });
      expect(complete.facebook.posts).toHaveLength(3);
      expect(complete.telegram).toMatchObject({ status: 'available' });
      expect(complete.telegram.posts).toHaveLength(2);

      rmSync(paths.facebookEvents);
      const partial = loadSocialPublicationLedgers(paths);
      expect(partial.facebook).toEqual({ status: 'ledger-partial', posts: [] });
      expect(loadSocialPublicationLedgers({ instagram: paths.instagram }).facebook)
        .toEqual({ status: 'ledger-partial', posts: [] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('builds dated, separate rolling 30-day Instagram benchmarks without forecasts', () => {
    const posts = [
      { day: '2026-10-10', windowHours: 72, snapshotAgeHours: 72, reach: 100, views: 120, reachSource: 'reach', saves: 5, shares: 2, availableMetrics: ['reach', 'views', 'saves', 'shares'] },
      { day: '2026-10-15', windowHours: 72, snapshotAgeHours: 73, reach: 120, views: 140, reachSource: 'reach', saves: 0, shares: 3, availableMetrics: ['reach', 'views', 'saves', 'shares'] },
      { day: '2026-10-20', windowHours: 72, snapshotAgeHours: 71, reach: 80, views: 100, reachSource: 'reach', saves: 4, shares: 1, availableMetrics: ['reach', 'views', 'saves', 'shares'] },
      { day: '2026-10-21', windowHours: 72, snapshotAgeHours: 72, reach: null, views: 200, reachSource: 'views', saves: 10, shares: 5, availableMetrics: ['views', 'saves', 'shares'] },
      { day: '2026-10-22', windowHours: 72, snapshotAgeHours: 72, reach: null, views: 180, reachSource: 'views', saves: 9, shares: 4, availableMetrics: ['views', 'saves', 'shares'] },
      { day: '2026-10-23', windowHours: 72, snapshotAgeHours: 72, reach: null, views: 220, reachSource: 'views', saves: 11, shares: 6, availableMetrics: ['views', 'saves', 'shares'] },
      { day: '2026-10-24', windowHours: 72, snapshotAgeHours: 400, reach: 900, views: 900, reachSource: 'reach', saves: 99, shares: 99, availableMetrics: ['reach', 'views', 'saves', 'shares'] },
      { day: '2026-10-25', windowHours: 72, reach: 1000, views: 1000, reachSource: 'reach', saves: 100, shares: 100, availableMetrics: ['reach', 'views', 'saves', 'shares'] },
    ];
    const result = buildSocialGrowthScorecard({
      asOf: AS_OF,
      instagramInsights: { posts },
      sources: { instagram: { status: 'available' } },
    });
    const instagram = result.channels.instagram;

    expect(result).toMatchObject({
      schemaVersion: 9,
      baselineAsOf: AS_OF.toISOString(),
      growthObjective: {
        status: 'default',
        primaryMetric: 'net-followers-per-channel',
        primaryMetricMeasurement: {
          status: 'incomplete',
          notYetMeasuredChannels: ['instagram', 'tiktok', 'facebook', 'linkedinMember', 'telegram', 'youtubeShorts', 'threads', 'reddit'],
        },
        secondaryMetric: 'qualified-social-attributed-sessions-per-channel-and-registered-event',
        qualityGuardrailMetric: 'registered-key-event-session-rate-per-channel-and-event',
        comparison: 'per-channel; frozen-30-day-baseline-required-for-recurring-90-day-decisions',
        businessOutcomeTarget: {
          metric: 'qualified-social-attributed-sessions-per-channel-and-registered-event',
          horizonDays: 90,
          minimumRelativeLift: 0.25,
          minimumBaselineSessions: 100,
          rateGuardrailRetention: 0.9,
          scope: 'per-channel-and-event; only after a qualified frozen baseline',
        },
        businessOutcomeTargetStatus: 'awaiting-registered-channel-events',
        businessOutcomeTargetCoverage: {
          registeredUtmChannelEventPairs: 0,
          activePilotChannelEventPairs: 0,
          activePilotQualifiedFrozenBaselinePairs: 0,
          activePilotAvailableComparisons: 0,
          activePilotPendingFollowups: 0,
          activePilotMissingFollowups: 0,
        },
      },
    });
    expect(instagram.metrics.reachPerPost).toMatchObject({ status: 'available', observations: 3, baselineMedian: 100 });
    expect(instagram.metrics.viewsPerPost).toMatchObject({ status: 'available', observations: 3, baselineMedian: 200 });
    expect(instagram.metrics.savesPerThousandReach).toMatchObject({ status: 'available', observations: 3, baselineMedian: 50 });
    expect(instagram.metrics.reachPerPost).not.toHaveProperty('projectedValue');
    expect(instagram.denominatorSources).toEqual(['reach', 'views']);

    const stricterSample = buildSocialGrowthScorecard({
      asOf: AS_OF,
      instagramInsights: { posts },
      minimumPosts: 4,
      sources: { instagram: { status: 'permission-unavailable' } },
    });
    expect(stricterSample.channels.instagram.metrics.reachPerPost).toMatchObject({
      status: 'insufficient-sample', observations: 3, minimumPosts: 4, baselineMedian: null,
    });
  });

  it('reports absolute Reel follows separately from follows per reach', () => {
    const posts = [
      { kind: 'reel', day: '2026-10-28', windowHours: 72, snapshotAgeHours: 72, reach: 100, views: 140, reachSource: 'reach', follows: 4, availableMetrics: ['reach', 'views', 'follows'] },
      { kind: 'reel', day: '2026-10-29', windowHours: 72, snapshotAgeHours: 72, reach: 200, views: 250, reachSource: 'reach', follows: 6, availableMetrics: ['reach', 'views', 'follows'] },
      { kind: 'reel', day: '2026-10-30', windowHours: 72, snapshotAgeHours: 72, reach: 200, views: 300, reachSource: 'reach', follows: 5, availableMetrics: ['reach', 'views', 'follows'] },
      { kind: 'reel', day: '2026-10-31', windowHours: 72, snapshotAgeHours: 72, reach: null, views: 100, reachSource: 'views', follows: 2, availableMetrics: ['views', 'follows'] },
      { kind: 'article', day: '2026-10-30', windowHours: 72, snapshotAgeHours: 72, reach: 100, views: 100, reachSource: 'reach', follows: 99, availableMetrics: ['reach', 'views', 'follows'] },
    ];
    const scorecard = buildSocialGrowthScorecard({
      asOf: AS_OF,
      instagramInsights: { posts },
      sources: { instagram: { status: 'available' } },
    });

    expect(scorecard.channels.instagram.metrics.reelFollowsPerPost)
      .toMatchObject({ status: 'available', observations: 4, baselineMedian: 4.5 });
    expect(scorecard.channels.instagram.metrics.reelFollowsPerThousandReach)
      .toMatchObject({ status: 'available', observations: 3, baselineMedian: 30 });
    expect(scorecard.channels.instagram.metrics.reelFollowsPerThousandViews)
      .toMatchObject({ status: 'insufficient-sample', observations: 1, baselineMedian: null });
  });

  it('sets a 90-day tagged-session target with a registered-event-rate guardrail', () => {
    const followupRows = Array.from({ length: 30 }, (_, index) => {
      const date = new Date(Date.parse('2026-08-30T12:00:00.000Z') + index * 24 * 60 * 60 * 1000)
        .toISOString().slice(0, 10);
      return {
        channel: 'facebook',
        eventName: 'job_apply_handoff',
        eventContractVersion: 1,
        date,
        timeZone: 'UTC',
        sessions: 50,
        sessionKeyEventRate: 0.036,
        status: 'available',
        source: 'ga4-session-key-event-rate',
      };
    });
    const baseline = {
      schemaVersion: 1,
      channel: 'facebook',
      eventName: 'job_apply_handoff',
      eventContractVersion: 1,
      metric: 'session-key-event-rate',
      startDate: '2026-06-01',
      endDate: '2026-06-30',
      timeZone: 'UTC',
      sessions: 1000,
      sessionKeyEventRate: 0.04,
      coverageDays: 30,
      observations: 30,
      frozenAt: '2026-07-01T12:00:00.000Z',
    };
    const result = buildSocialGrowthScorecard({
      asOf: new Date('2026-10-01T12:00:00.000Z'),
      nativeInsights: { siteOutcomeSnapshots: followupRows, siteOutcomeBaselines: [baseline] },
      publicationLedgers: {
        facebook: {
          status: 'available',
          posts: [{ id: 'fb-post-1', postId: 'fb-media-1', publishedAt: '2026-09-20T12:00:00.000Z' }],
        },
      },
      sources: {
        socialSiteOutcomes: {
          status: 'available',
          registeredEventNames: ['job_apply_handoff'],
          timeZone: 'UTC',
          latestDataEndDate: '2026-09-28',
        },
      },
    });
    const comparison = result.siteOutcomeGrowth.facebook.metrics.job_apply_handoff.frozenBaselineComparison;

    expect(comparison).toMatchObject({
      status: 'descriptive-comparison-available',
      baselineSessions: 1000,
      sessions: 1500,
      targetSessions: 1250,
      targetSessionsMet: true,
      baselineSessionKeyEventRate: 0.04,
      rateGuardrailMet: true,
      targetMet: true,
      targetStatus: 'met',
    });
    expect(comparison.followupSessionKeyEventRate).toBeCloseTo(0.036, 12);
    expect(comparison.rateGuardrailFloor).toBeCloseTo(0.036, 12);
    expect(renderSocialGrowthScorecard(result)).toContain('+25% sessioni social-attribuite');
    expect(renderSocialGrowthScorecard(result)).toContain('non causale');
    expect(result.growthObjective).toMatchObject({
      businessOutcomeTargetStatus: 'all-qualified-comparisons-available',
      businessOutcomeTargetCoverage: {
        registeredUtmChannelEventPairs: 8,
        activePilotChannelEventPairs: 1,
        activePilotQualifiedFrozenBaselinePairs: 1,
        activePilotAvailableComparisons: 1,
        activePilotPendingFollowups: 0,
        activePilotMissingFollowups: 0,
      },
    });
    expect(renderSocialGrowthScorecard(result)).toContain('1500/1250; met');
    expect(renderSocialGrowthScorecard(result)).toContain('coppie canale/evento dei pilot attivi coperte 1/1; coppie registrate nel mapping UTM 8');

    const belowGuardrail = buildSocialGrowthScorecard({
      asOf: new Date('2026-10-01T12:00:00.000Z'),
      nativeInsights: {
        siteOutcomeSnapshots: followupRows.map((row) => ({ ...row, sessionKeyEventRate: 0.035999999999 })),
        siteOutcomeBaselines: [baseline],
      },
      sources: {
        socialSiteOutcomes: {
          status: 'available',
          registeredEventNames: ['job_apply_handoff'],
          timeZone: 'UTC',
          latestDataEndDate: '2026-09-28',
        },
      },
    });
    expect(belowGuardrail.siteOutcomeGrowth.facebook.metrics.job_apply_handoff.frozenBaselineComparison)
      .toMatchObject({ rateGuardrailMet: false, targetMet: false, targetStatus: 'not-met' });

    const belowSessionGoal = buildSocialGrowthScorecard({
      asOf: new Date('2026-10-01T12:00:00.000Z'),
      nativeInsights: {
        siteOutcomeSnapshots: followupRows.map((row) => ({ ...row, sessions: 40, sessionKeyEventRate: 0.04 })),
        siteOutcomeBaselines: [baseline],
      },
      sources: {
        socialSiteOutcomes: {
          status: 'available',
          registeredEventNames: ['job_apply_handoff'],
          timeZone: 'UTC',
          latestDataEndDate: '2026-09-28',
        },
      },
    });
    expect(belowSessionGoal.siteOutcomeGrowth.facebook.metrics.job_apply_handoff.frozenBaselineComparison)
      .toMatchObject({
        sessions: 1200,
        targetSessionsMet: false,
        rateGuardrailMet: true,
        targetMet: false,
        targetStatus: 'not-met',
      });

    const zeroBaseline = buildSocialGrowthScorecard({
      asOf: new Date('2026-10-01T12:00:00.000Z'),
      nativeInsights: {
        siteOutcomeSnapshots: followupRows.map((row) => ({ ...row, sessionKeyEventRate: 0 })),
        siteOutcomeBaselines: [{ ...baseline, sessionKeyEventRate: 0 }],
      },
      sources: {
        socialSiteOutcomes: {
          status: 'available',
          registeredEventNames: ['job_apply_handoff'],
          timeZone: 'UTC',
          latestDataEndDate: '2026-09-28',
        },
      },
    });
    expect(zeroBaseline.siteOutcomeGrowth.facebook.metrics.job_apply_handoff.frozenBaselineComparison)
      .toMatchObject({
        targetSessionsMet: true,
        rateGuardrailMet: null,
        targetMet: null,
        targetStatus: 'baseline-rate-zero',
      });
  });

  it('does not baseline an event-count-only action from stale registered-rate data', () => {
    const snapshots = Array.from({ length: 30 }, (_, index) => {
      const date = new Date(Date.parse('2026-10-02T12:00:00.000Z') + index * 24 * 60 * 60 * 1000)
        .toISOString().slice(0, 10);
      return {
        channel: 'facebook',
        eventName: 'job_qualified_session',
        eventContractVersion: 1,
        date,
        timeZone: 'UTC',
        sessions: 50,
        sessionKeyEventRate: 0.5,
        status: 'available',
        source: 'ga4-session-key-event-rate',
      };
    });
    const sourceState = {
      status: 'available',
      registeredEventNames: ['job_qualified_session'],
      timeZone: 'UTC',
      latestDataEndDate: '2026-10-31',
    };

    expect(freezeEligibleSocialSiteOutcomeBaselines([], snapshots, sourceState, AS_OF)).toEqual([]);

    const result = buildSocialGrowthScorecard({
      asOf: AS_OF,
      nativeInsights: {
        siteOutcomeSnapshots: snapshots,
        siteOutcomeBaselines: [{
          schemaVersion: 1,
          channel: 'facebook',
          eventName: 'job_qualified_session',
          eventContractVersion: 1,
          metric: 'session-key-event-rate',
          startDate: '2026-10-02',
          endDate: '2026-10-31',
          timeZone: 'UTC',
          sessions: 1500,
          sessionKeyEventRate: 0.5,
          coverageDays: 30,
          observations: 30,
          frozenAt: '2026-11-01T12:00:00.000Z',
        }],
      },
      sources: { socialSiteOutcomes: sourceState },
    });

    expect(result.siteOutcomeGrowth.facebook.metrics.job_qualified_session).toMatchObject({
      status: 'event-not-rate-eligible',
      metric: 'not-rate-eligible',
      sessionKeyEventRate: null,
      baselineSessionKeyEventRate: null,
      frozenBaselineComparison: { status: 'event-not-rate-eligible' },
    });
    expect(result.growthObjective.secondaryMetricMeasurement.registeredEvents).toEqual([]);
  });

  it('marks global GA4 target coverage partial when one channel follow-up is missing', () => {
    const followupRows = Array.from({ length: 30 }, (_, index) => {
      const date = new Date(Date.parse('2026-08-30T12:00:00.000Z') + index * 24 * 60 * 60 * 1000)
        .toISOString().slice(0, 10);
      return {
        channel: 'facebook',
        eventName: 'job_apply_handoff',
        eventContractVersion: 1,
        date,
        timeZone: 'UTC',
        sessions: 50,
        sessionKeyEventRate: 0.04,
        status: 'available',
        source: 'ga4-session-key-event-rate',
      };
    });
    const baseline = (channel: string) => ({
      schemaVersion: 1,
      channel,
      eventName: 'job_apply_handoff',
      eventContractVersion: 1,
      metric: 'session-key-event-rate',
      startDate: '2026-06-01',
      endDate: '2026-06-30',
      timeZone: 'UTC',
      sessions: 1000,
      sessionKeyEventRate: 0.04,
      coverageDays: 30,
      observations: 30,
      frozenAt: '2026-07-01T12:00:00.000Z',
    });
    const result = buildSocialGrowthScorecard({
      asOf: new Date('2026-10-10T12:00:00.000Z'),
      nativeInsights: {
        siteOutcomeSnapshots: followupRows,
        siteOutcomeBaselines: [baseline('facebook'), baseline('instagram')],
      },
      publicationLedgers: {
        facebook: {
          status: 'available',
          posts: [{ id: 'fb-post-1', postId: 'fb-media-1', publishedAt: '2026-09-20T12:00:00.000Z' }],
        },
        instagram: {
          status: 'available',
          posts: [{ id: 'ig-post-1', mediaId: 'ig-media-1', publishedAt: '2026-09-20T12:00:00.000Z' }],
        },
      },
      sources: {
        socialSiteOutcomes: {
          status: 'available',
          registeredEventNames: ['job_apply_handoff'],
          timeZone: 'UTC',
          latestDataEndDate: '2026-10-06',
        },
      },
    });

    expect(result.growthObjective).toMatchObject({
      businessOutcomeTargetStatus: 'partial-with-missing-follow-up',
      businessOutcomeTargetCoverage: {
        registeredUtmChannelEventPairs: 8,
        activePilotChannelEventPairs: 2,
        activePilotQualifiedFrozenBaselinePairs: 2,
        activePilotAvailableComparisons: 1,
        activePilotPendingFollowups: 0,
        activePilotMissingFollowups: 1,
      },
    });
    expect(renderSocialGrowthScorecard(result)).toContain('follow-up mancanti 1');
  });

  it('keeps registered UTM channels separate from an empty active-pilot denominator', () => {
    const result = buildSocialGrowthScorecard({
      asOf: new Date('2026-10-01T12:00:00.000Z'),
      sources: {
        socialSiteOutcomes: {
          status: 'available',
          registeredEventNames: ['job_apply_handoff'],
          timeZone: 'UTC',
          latestDataEndDate: '2026-09-28',
        },
      },
    });

    expect(result.growthObjective).toMatchObject({
      businessOutcomeTargetStatus: 'awaiting-active-pilot-publications',
      businessOutcomeTargetCoverage: {
        registeredUtmChannelEventPairs: 8,
        activePilotChannelEventPairs: 0,
        activePilotQualifiedFrozenBaselinePairs: 0,
        activePilotAvailableComparisons: 0,
        activePilotPendingFollowups: 0,
        activePilotMissingFollowups: 0,
      },
    });
    expect(renderSocialGrowthScorecard(result)).toContain('coppie canale/evento dei pilot attivi coperte 0/0; coppie registrate nel mapping UTM 8');
  });

  it('sets a per-channel 90-day growth objective with a 25% floor and a 150% pace stretch', () => {
    const buildTarget = (netChange: number, endValue: number) => buildSocialGrowthScorecard({
      asOf: AS_OF,
      nativeInsights: {
        audienceBaselines: {
          instagram: {
            schemaVersion: 1,
            channel: 'instagram',
            metric: 'followers',
            startAt: '2026-10-01T12:00:00.000Z',
            endAt: '2026-10-31T12:00:00.000Z',
            startValue: 1000,
            endValue,
            netChange,
          },
        },
      },
      sources: { instagramAudience: { status: 'available' } },
    });

    const floorTarget = buildTarget(0, 1000);
    expect(floorTarget.audienceGrowth.instagram.growthTarget90d).toMatchObject({
      status: 'available',
      policyVersion: 2,
      targetNetChange: 250,
      targetAudienceValue: 1250,
      formula: 'max(150%-of-linearized-baseline-pace,25%-of-follow-up-start-audience,1-audience-member)',
    });
    expect(floorTarget.growthObjective.targetPolicy).toMatchObject({
      paceStretchMultiplier: 1.5,
      startingAudienceFloor: 0.25,
      minimumNetAudienceCount: 1,
      recurrence: 'advance-after-qualified-88-to-92-day-observation-and-new-25-day-baseline',
      scope: 'per-channel; never aggregate across platforms',
    });

    const paceTarget = buildTarget(400, 1400);
    expect(paceTarget.audienceGrowth.instagram.growthTarget90d).toMatchObject({
      observedMonthlyNetChange: 400,
      targetNetChange: 1800,
      targetAudienceValue: 3200,
    });
  });

  it('normalizes the 90-day audience target to the accepted 88–92 day observation window', () => {
    const baselineEnd = Date.parse('2026-10-31T12:00:00.000Z');
    const baseline = {
      schemaVersion: 1,
      channel: 'instagram',
      metric: 'followers',
      startAt: '2026-10-01T12:00:00.000Z',
      endAt: new Date(baselineEnd).toISOString(),
      startValue: 1000,
      endValue: 1000,
      netChange: 0,
      frozenAt: new Date(baselineEnd).toISOString(),
    };
    const scorecardAtDay = (days: number) => {
      const snapshotAt = new Date(baselineEnd + days * 24 * 60 * 60 * 1000).toISOString();
      return buildSocialGrowthScorecard({
        asOf: new Date(snapshotAt),
        nativeInsights: {
          audienceBaselines: { instagram: baseline },
          audienceSnapshots: [{
            channel: 'instagram',
            metric: 'followers',
            status: 'available',
            source: 'instagram-graph',
            value: 1250,
            snapshotAt,
          }],
        },
        sources: { instagramAudience: { status: 'available' } },
      });
    };

    const early = scorecardAtDay(88);
    expect(early.audienceGrowth.instagram.frozenBaselineComparison).toMatchObject({
      followupWindowDays: 88,
      targetNetChange: 250,
      targetNetChangeForObservedWindow: 245,
      followupNetChange: 250,
      targetMet: true,
    });
    expect(renderSocialGrowthScorecard(early)).toContain('sì (soglia +245)');

    const late = scorecardAtDay(92);
    expect(late.audienceGrowth.instagram.frozenBaselineComparison).toMatchObject({
      followupWindowDays: 92,
      targetNetChange: 250,
      targetNetChangeForObservedWindow: 256,
      followupNetChange: 250,
      targetMet: false,
    });
    expect(renderSocialGrowthScorecard(late)).toContain('no (soglia +256)');
  });

  it('starts the next audience target cycle from the completed window and a fresh qualified baseline', () => {
    const baselineEnd = Date.parse('2026-10-31T12:00:00.000Z');
    const targetAt = baselineEnd + 90 * 24 * 60 * 60 * 1000;
    const initialBaseline = {
      schemaVersion: 1,
      channel: 'instagram',
      metric: 'followers',
      startAt: '2026-10-01T12:00:00.000Z',
      endAt: new Date(baselineEnd).toISOString(),
      startValue: 1000,
      endValue: 1000,
      netChange: 0,
      coverageDays: 30,
      observations: 31,
      frozenAt: new Date(baselineEnd).toISOString(),
    };
    const snapshots = Array.from({ length: 31 }, (_, index) => ({
      channel: 'instagram',
      metric: 'followers',
      status: 'available',
      source: 'instagram-graph',
      value: 1100 + index * 5,
      snapshotAt: new Date(baselineEnd + (60 + index) * 24 * 60 * 60 * 1000).toISOString(),
    }));
    const cycles = advanceAudienceGrowthCycles(
      {},
      { instagram: initialBaseline },
      snapshots,
      { instagramAudience: { status: 'available' } },
      new Date(targetAt),
    );

    expect(cycles.instagram).toMatchObject({
      schemaVersion: 1,
      channel: 'instagram',
      cycleNumber: 2,
      status: 'active',
      currentBaseline: {
        startValue: 1100,
        endValue: 1250,
        netChange: 150,
        coverageDays: 30,
        observations: 31,
      },
      lastCompleted: {
        cycleNumber: 1,
        baselineNetChange: 0,
        followupNetChange: 250,
        targetNetChange: 250,
        targetNetChangeForObservedWindow: 250,
        targetMet: true,
      },
    });

    const next = advanceAudienceGrowthCycles(
      cycles,
      { instagram: initialBaseline },
      snapshots,
      { instagramAudience: { status: 'available' } },
      new Date(targetAt),
    );
    expect(next).toEqual(cycles);
    const scorecard = buildSocialGrowthScorecard({
      asOf: new Date(targetAt),
      nativeInsights: { audienceGrowthCycles: cycles, audienceSnapshots: snapshots },
      sources: { instagramAudience: { status: 'available' } },
    });
    expect(scorecard.audienceGrowth.instagram).toMatchObject({
      growthTarget90d: { targetNetChange: 675, targetAudienceValue: 1925 },
      growthTargetCycle: { cycleNumber: 2, status: 'active' },
    });
    expect(renderSocialGrowthScorecard(scorecard)).toContain('ciclo 2 (active)');
  });

  it('does not admit snapshots whose actual measurement age is missing or outside the fixed window', () => {
    const posts = [
      { day: '2026-10-20', windowHours: 72, reach: 100, reachSource: 'reach', availableMetrics: ['reach'] },
      { day: '2026-10-21', windowHours: 72, publishedAt: '2026-10-20T12:00:00Z', snapshotAt: '2026-10-24T00:00:00Z', reach: 200, reachSource: 'reach', availableMetrics: ['reach'] },
      { day: '2026-10-22', windowHours: 72, publishedAt: '2026-10-20T12:00:00Z', snapshotAt: '2026-10-23T12:00:00Z', reach: 300, reachSource: 'reach', availableMetrics: ['reach'] },
    ];
    const scorecard = buildSocialGrowthScorecard({
      asOf: AS_OF,
      instagramInsights: { posts },
      sources: { instagram: { status: 'available' } },
    });
    expect(scorecard.channels.instagram.metrics.reachPerPost).toMatchObject({
      status: 'insufficient-sample', observations: 1, baselineMedian: null,
    });
  });

  it('uses channel-specific observation windows and leaves permission gaps unavailable', () => {
    const tiktokPosts = ['a', 'b', 'c'].map((postId, index) => ({
      channel: 'tiktok',
      postId,
      day: `2026-10-${10 + index}`,
      windowHours: 72,
      snapshotAgeHours: 72,
      metrics: { views: 100 + index * 10, likes: 5, comments: 1, shares: 1 },
      availableMetrics: ['views', 'likes', 'comments', 'shares'],
    }));
    const linkedin = [{
      channel: 'linkedin-member',
      postId: 'urn:li:share:1',
      publishedAt: '2026-10-20T12:00:00Z',
      measurementWindow: 'first-seven-utc-calendar-days',
      windowDays: 7,
      metrics: { impression: 200, link_clicks: 4, follower_gained_from_content: 2 },
      availableMetrics: ['impression', 'link_clicks', 'follower_gained_from_content'],
    }];
    const telegramHistory = [
      { date: '2026-10-04', count: 7 },
      { date: '2026-11-01', count: 9 },
    ].map((row) => JSON.stringify(row)).join('\n');
    const scorecard = buildSocialGrowthScorecard({
      asOf: AS_OF,
      nativeInsights: { posts: [...tiktokPosts, ...linkedin] },
      telegramHistory,
      sources: {
        tiktok: { status: 'available' },
        linkedinMember: { status: 'available' },
        facebook: { status: 'scope-probe-pending' },
        youtubeShorts: { status: 'account-not-configured' },
      },
    });

    expect(scorecard.channels.tiktok.metrics.viewsPerPost).toMatchObject({ status: 'available', observations: 3, baselineMedian: 110 });
    expect(scorecard.channels.linkedinMember.metrics.impressionsPerPost).toMatchObject({ status: 'insufficient-sample', observations: 1, baselineMedian: null });
    expect(scorecard.channels.linkedinMember.metrics.followersGainedPerPost).toMatchObject({ status: 'insufficient-sample', observations: 1, baselineMedian: null });
    expect(scorecard.channels.telegram.metrics.netMembers30d).toMatchObject({ status: 'available', baseline: 2 });
    expect(scorecard.channels.telegram.metrics.netMembers30d).not.toHaveProperty('projectionStatus');
    expect(scorecard.channels.facebook.status).toBe('scope-probe-pending');
    expect(scorecard.channels.youtubeShorts.status).toBe('account-not-configured');
    const rendered = renderSocialGrowthScorecard(scorecard);
    expect(rendered).toContain('No combined target, forecast, or causal claim.');
    expect(rendered).toContain('Copertura fonti:');
    expect(rendered).toContain('Copertura metrica follower: incomplete; non misurata per instagram, tiktok, facebook, linkedinMember, telegram, youtubeShorts, threads, reddit.');
    expect(rendered).not.toContain('Scenario +90g');
    expect(rendered).not.toContain('proiezione');
  });

  it('keeps a zero baseline descriptive and does not invent an outcome', () => {
    const posts = ['a', 'b', 'c'].map((postId, index) => ({
      channel: 'tiktok',
      postId,
      publishedAt: `2026-10-${20 + index}T12:00:00.000Z`,
      windowHours: 72,
      snapshotAgeHours: 72,
      metrics: { views: 0 },
      availableMetrics: ['views'],
    }));
    const scorecard = buildSocialGrowthScorecard({
      asOf: AS_OF,
      nativeInsights: { posts },
      sources: { tiktok: { status: 'available' } },
    });

    expect(scorecard.channels.tiktok.metrics.viewsPerPost).toMatchObject({
      status: 'available',
      observations: 3,
      baselineMedian: 0,
    });
    expect(scorecard.channels.tiktok.metrics.viewsPerPost).not.toHaveProperty('projectedValue');
  });

  it('reports LinkedIn daily gains separately and never fills missing days with zero', () => {
    const start = Date.parse('2026-10-03T00:00:00.000Z');
    const followerGainSnapshots = Array.from({ length: 30 }, (_, index) => {
      const date = new Date(start + index * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      return {
        channel: 'linkedin-member',
        metric: 'followers-gained',
        date,
        value: index % 2,
        snapshotAt: `${date}T12:00:00.000Z`,
        status: 'available',
        source: 'linkedin-member-follower-gains',
      };
    });
    const complete = buildSocialGrowthScorecard({
      asOf: AS_OF,
      nativeInsights: { followerGainSnapshots },
      sources: { linkedinFollowerGains: { status: 'available' } },
    });

    expect(complete.linkedinFollowerGains).toMatchObject({
      status: 'available',
      metric: 'followers-gained',
      expectedDays: 30,
      coverageDays: 30,
      followerGains30d: 15,
      observedFollowerGains: 15,
      latestDate: '2026-11-01',
    });
    expect(complete.sourceFreshness.linkedinMemberFollowerGains.status).toBe('fresh');

    const partial = buildSocialGrowthScorecard({
      asOf: AS_OF,
      nativeInsights: { followerGainSnapshots: followerGainSnapshots.slice(1) },
      sources: { linkedinFollowerGains: { status: 'partial' } },
    });
    expect(partial.linkedinFollowerGains).toMatchObject({
      status: 'partial',
      coverageDays: 29,
      followerGains30d: null,
      observedFollowerGains: 15,
    });
    expect(renderSocialGrowthScorecard(partial)).toContain('I giorni mancanti restano sconosciuti');
  });

  it('excludes private snapshots collected after a historical scorecard date', async () => {
    const loadNativeInsights = vi.fn(async () => ({
      schemaVersion: 1,
      sources: { tiktok: { status: 'available' } },
      posts: [{
        channel: 'tiktok',
        postId: 'future-video',
        publishedAt: '2026-10-19T12:00:00.000Z',
        snapshotAt: '2026-10-22T12:00:00.000Z',
        snapshotAgeHours: 72,
        windowHours: 72,
        metrics: { views: 200 },
        availableMetrics: ['views'],
      }],
    }));

    const scorecard = await createScorecard(new Date('2026-10-20T12:00:00.000Z'), {
      loadNativeInsights,
      env: { TIKTOK_DISPLAY_ANALYTICS_APPROVED: 'true' },
    });

    expect(loadNativeInsights).toHaveBeenCalledOnce();
    expect(loadNativeInsights).toHaveBeenCalledWith();
    expect(scorecard.channels.tiktok.metrics.viewsPerPost).toMatchObject({
      status: 'no-attributable-observations',
      observations: 0,
    });
  });

  it('hides already stored TikTok rows from scorecards until Display API use is approved', async () => {
    const scorecard = await createScorecard(AS_OF, {
      env: {},
      loadNativeInsights: async () => ({
        schemaVersion: 1,
        sources: { tiktok: { status: 'available' } },
        posts: [{
          channel: 'tiktok',
          postId: 'stored-video',
          publishedAt: '2026-10-30T12:00:00.000Z',
          snapshotAt: '2026-11-02T12:00:00.000Z',
          snapshotAgeHours: 72,
          windowHours: 72,
          metrics: { views: 500 },
          availableMetrics: ['views'],
        }],
      }),
    });

    expect(scorecard.sourceCoverage.tiktok).toBe('policy-review-required');
    expect(scorecard.channels.tiktok.metrics.viewsPerPost).toMatchObject({
      status: 'policy-review-required',
      observations: 0,
      baselineMedian: null,
    });
  });

  it('reports aggregate pilot cadence and exact post-ID coverage without exposing IDs', () => {
    const publishedAt = '2026-10-29T12:00:00.000Z';
    const scorecard = buildSocialGrowthScorecard({
      asOf: AS_OF,
      instagramInsights: {
        posts: [{
          channel: 'instagram',
          postId: 'ig-native-1',
          mediaId: 'ig-native-1',
          publishedAt,
          snapshotAt: '2026-11-01T12:00:00.000Z',
          snapshotAgeHours: 72,
          windowHours: 72,
          reach: 100,
          reachSource: 'reach',
          availableMetrics: ['reach'],
        }],
      },
      publicationLedgers: {
        instagram: {
          status: 'available',
          posts: [
            { id: 'article-a', kind: 'article', day: '2026-10-29', creativeId: 'creative-a', ts: publishedAt, instagramMediaId: 'ig-native-1' },
            { id: 'article-b', kind: 'article', day: '2026-10-29', creativeId: 'creative-b', ts: publishedAt },
          ],
        },
        facebook: {
          status: 'available',
          posts: [
            { id: 'job-a', ts: publishedAt, fbPostId: 'page_1' },
            { id: 'article-a', ts: publishedAt, fbPostId: 'page_2' },
            { id: 'weekend-digest-TI-2026-10-31', postedAt: publishedAt, postId: 'page_3' },
            { id: 'event-covered-by-digest', postedAt: publishedAt, viaDigest: 'weekend-digest-TI-2026-10-31' },
          ],
        },
        telegram: {
          status: 'available',
          posts: [
            { id: 'telegram-job-a', ts: publishedAt, ledgerSource: 'telegramJobs' },
            { id: 'telegram-job-b', ts: '2026-10-29T12:00:00.001Z', ledgerSource: 'telegramJobs' },
            { id: 'telegram-job-c', ts: '2026-11-01T13:00:00.000Z', telegramMessageId: 42, telegramDeliveryId: '00000000-0000-4000-8000-000000000001', ledgerSource: 'telegramJobs' },
            { id: 'telegram-job-d', ts: '2026-11-01T14:00:00.000Z', telegramMessageId: 42, telegramDeliveryId: '00000000-0000-4000-8000-000000000002', ledgerSource: 'telegramJobs' },
            { id: 'telegram-job-e', ts: '2026-10-30T12:00:00.000Z', ledgerSource: 'telegramJobs' },
            { id: 'telegram-job-f', ts: '2026-10-30T14:00:00.000Z', ledgerSource: 'telegramJobs' },
            { id: 'telegram-before-zurich-midnight', ts: '2026-11-01T22:59:58.000Z', ledgerSource: 'telegramJobs' },
            { id: 'telegram-after-zurich-midnight', ts: '2026-11-01T23:00:01.000Z', ledgerSource: 'telegramJobs' },
            { id: 'border-week-1', ts: publishedAt, telegramMessageId: 7, ledgerSource: 'telegramAnnouncements' },
            { id: 'announcement-1', ts: publishedAt, telegramMessageId: 8, ledgerSource: 'telegramAnnouncements' },
          ],
        },
      },
      sources: {
        instagram: { status: 'available' },
        instagramAudience: { status: 'available' },
        facebookAudience: { status: 'available' },
        linkedinAudience: { status: 'permission-missing' },
        tiktok: { status: 'policy-review-required' },
      },
    });

    expect(scorecard.channelPilots.instagram).toMatchObject({
      contractVersion: 4,
      cadenceIncreaseAllowed: false,
      minimumOrganicPilotDays: 28,
      audienceMetricStatus: 'no-audience-observations',
      postIdCoverage: {
        status: 'exact-post-ids-incomplete',
        publishedPosts30d: 2,
        exactPostIds30d: 1,
        exactPostIdCoverageRate: 0.5,
        eligibleForMetrics: 1,
        postsWithExactMetricSnapshot: 1,
        exactMetricJoinRate: 1,
      },
      promotionStatus: 'descriptive-only-protocol-unqualified',
    });
    expect(scorecard.channelPilots.instagram.cadenceCap)
      .toContain('shared atomic cap: feed/Reels 2/day, Stories 6/day');
    expect(scorecard.channelPilots.instagram.cadenceCap).toContain('Graph API, Reels, and robot');
    expect(scorecard.channelPilots).toMatchObject({
      linkedinCompanyPage: {
        readinessStatus: 'delivery-held-or-unconfigured',
        sourceStatus: 'organization-social-permission-missing',
      },
      x: {
        readinessStatus: 'delivery-held-or-unconfigured',
        sourceStatus: 'account-and-oauth-not-configured',
      },
      whatsappChannels: {
        readinessStatus: 'delivery-held-or-unconfigured',
        sourceStatus: 'account-and-oauth-not-configured',
      },
    });
    expect(scorecard.channelPilots.tiktok).toMatchObject({
      readinessStatus: 'delivery-held-or-unconfigured',
      cadenceIncreaseAllowed: false,
      promotionStatus: 'descriptive-only-protocol-unqualified',
    });
    expect(scorecard.channelPilots.facebook).toMatchObject({
      cadenceCap: 'shared atomic Page cap 144/day across scheduled jobs, articles, events, and manual posts; configured job schedules and batch limits remain unchanged',
      postIdCoverage: {
        status: 'exact-metric-join-incomplete',
        publishedPosts30d: 3,
        exactPostIds30d: 3,
        exactPostIdCoverageRate: 1,
        eligibleForMetrics: 3,
        postsWithExactMetricSnapshot: 0,
        exactMetricJoinRate: 0,
      },
    });
    expect(scorecard.channelPilots.telegram).toMatchObject({
      cadenceCap: 'daily jobs digest; weekly border ranking; no increase',
      postIdCoverage: {
        status: 'count-only-no-native-post-metrics',
        publishedPosts30d: 9,
        exactPostIds30d: null,
        exactMetricJoinRate: null,
        publicationCountBasis: expect.stringContaining('legacy-send-time-cluster-inference'),
      },
    });
    const messageIdOnly = buildSocialGrowthScorecard({
      asOf: AS_OF,
      publicationLedgers: {
        telegram: {
          status: 'available',
          posts: [{ id: 'telegram-job-message-only', ts: publishedAt, telegramMessageId: 42, ledgerSource: 'telegramJobs' }],
        },
      },
    });
    expect(messageIdOnly.channelPilots.telegram.postIdCoverage.publicationCountBasis)
      .toBe('telegram-message-id-fallback');
    expect(scorecard.channelPilots.linkedinMember.sourceStatus).toBe('permission-missing');
    const linkedinOverrun = buildSocialGrowthScorecard({
      asOf: AS_OF,
      publicationLedgers: {
        linkedinMember: {
          status: 'available',
          posts: ['article-a', 'job-a', 'article-b'].map((id, index) => ({
            id,
            kind: id.startsWith('job') ? 'job' : 'article',
            linkedinPostId: `urn:li:share:${index}`,
            ts: `2026-11-01T${String(index + 8).padStart(2, '0')}:00:00.000Z`,
          })),
        },
      },
    });
    expect(linkedinOverrun.channelPilots.linkedinMember).toMatchObject({
      cadenceOverrun: {
        status: 'cap-exceeded',
        capPerDay: 2,
        overrunDays: 1,
        maximumPostsPerDay: 3,
        lastOverrunDay: '2026-11-01',
      },
      stopCriteriaTriggered: ['existing-publisher-cap-exceeded'],
    });
    const rendered = renderSocialGrowthScorecard(scorecard);
    expect(rendered).toContain('## Pilot readiness by channel');
    expect(rendered).toContain('linkedinCompanyPage');
    expect(rendered).toContain('whatsappChannels');
    expect(rendered).toContain('shared atomic Page cap 144/day across scheduled jobs, articles, events, and manual posts');
    expect(rendered).toContain('Sforamenti cap 30g');
    expect(rendered).toContain('50.0%');
    expect(rendered).not.toContain('ig-native-1');
  });

  it('excludes unconfirmed future Facebook schedules and measures confirmed jobs by actual publish time', () => {
    const scorecard = buildSocialGrowthScorecard({
      asOf: new Date('2026-11-03T08:00:00.000Z'),
      publicationLedgers: {
        facebook: {
          status: 'available',
          posts: [
            {
              id: 'job-pending',
              fbPostId: 'page_pending',
              ts: '2026-11-02T08:00:00.000Z',
              scheduledFor: '2026-11-02T22:55:00.000Z',
            },
            {
              id: 'job-published',
              fbPostId: 'page_published',
              ts: '2026-11-02T08:00:00.000Z',
              scheduledFor: '2026-11-02T22:55:00.000Z',
              actualPublishedAt: '2026-11-02T23:04:00.000Z',
            },
          ],
        },
      },
    });

    expect(scorecard.channelPilots.facebook.postIdCoverage).toMatchObject({
      publishedPosts30d: 1,
      exactPostIds30d: 1,
    });
    expect(scorecard.channelPilots.facebook.cadenceOverrun).toMatchObject({
      timezone: 'Europe/Zurich',
      daysObserved: 1,
      maximumPostsPerDay: 1,
      overrunDays: 0,
    });
  });
});
