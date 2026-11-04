import { describe, expect, it } from 'vitest';

import { validateSocialNativeInsightsDocument } from '../scripts/lib/social-native-insights-schema.mjs';
import { buildInstagramCommunityOutcomeSnapshot } from '../scripts/lib/instagram-community-outcomes.mjs';
import { instagramCommunityTopicSignalKey } from '../scripts/lib/instagram-community-topics.mjs';
import { INSTAGRAM_STORY_METRICS } from '../scripts/lib/instagram-story-contract.mjs';

const AS_OF = new Date('2026-11-02T12:00:00.000Z');

function storyDocument() {
  const publication = {
    storyId: 'story-private-id',
    publishedAt: '2026-11-02T11:30:00.000Z',
    sourceMediaId: 'source-media-id',
    followUpFormat: 'story-result',
    copyPackId: '0123456789abcdef',
    copyTemplateId: 'story-follow-up',
    copyAngleId: 'practical-question',
    copyPillarId: 'useful-tools',
    copyRevisionId: 'abcdef0123456789',
  };
  const metrics = Object.fromEntries(INSTAGRAM_STORY_METRICS.map((name) => [name, null]));
  metrics.views = 25;
  metrics.reach = 20;
  const metricStatus = Object.fromEntries(INSTAGRAM_STORY_METRICS.map((name) => [name, 'unavailable']));
  metricStatus.views = 'available';
  metricStatus.reach = 'available';
  return {
    schemaVersion: 1,
    sources: { instagramStoryInsights: { status: 'available', lastAttemptAt: AS_OF.toISOString() } },
    posts: [],
    instagramStoryPublications: [publication],
    instagramStorySnapshots: [{
      ...publication,
      snapshotAt: AS_OF.toISOString(),
      snapshotAgeHours: 0.5,
      measurementWindow: 'first-hour',
      metrics,
      availableMetrics: ['views', 'reach'],
      metricStatus,
    }],
  };
}

function documentWith(post: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    sources: { tiktok: { status: 'available' } },
    posts: [{
      channel: 'tiktok',
      postId: 'video-1',
      publishedAt: '2026-10-30T12:00:00.000Z',
      snapshotAt: '2026-11-02T12:00:00.000Z',
      snapshotAgeHours: 72,
      windowHours: 72,
      metrics: { views: 0 },
      availableMetrics: ['views'],
      metricStatus: { views: 'available' },
      ...post,
    }],
  };
}

describe('social native insights persistence contract', () => {
  it('accepts an explicitly available zero counter without reclassifying it as missing', () => {
    expect(validateSocialNativeInsightsDocument(documentWith(), { asOf: AS_OF })).toMatchObject({
      posts: [{ metrics: { views: 0 }, availableMetrics: ['views'] }],
    });
  });

  it('accepts exact-ID Story snapshots only when their private publication and metric statuses agree', () => {
    expect(validateSocialNativeInsightsDocument(storyDocument(), { asOf: AS_OF })).toMatchObject({
      instagramStorySnapshots: [{
        storyId: 'story-private-id',
        measurementWindow: 'first-hour',
        metrics: { views: 25, reach: 20, replies: null },
        availableMetrics: ['views', 'reach'],
      }],
    });

    const orphaned = storyDocument();
    orphaned.instagramStoryPublications = [];
    expect(() => validateSocialNativeInsightsDocument(orphaned, { asOf: AS_OF }))
      .toThrow(/no matching publication/);

    const mislabeled = storyDocument();
    mislabeled.instagramStorySnapshots[0].metricStatus.views = 'unavailable';
    expect(() => validateSocialNativeInsightsDocument(mislabeled, { asOf: AS_OF }))
      .toThrow(/invalid Instagram Story metric views/);
  });

  it('accepts a validated recurring audience target cycle without exposing it to public storage', () => {
    const doc = {
      ...documentWith(),
      audienceBaselines: {},
      audienceGrowthCycles: {
        instagram: {
          schemaVersion: 1,
          channel: 'instagram',
          cycleNumber: 1,
          status: 'active',
          currentBaseline: {
            schemaVersion: 1,
            channel: 'instagram',
            metric: 'followers',
            startAt: '2026-10-01T12:00:00.000Z',
            endAt: '2026-10-31T12:00:00.000Z',
            startValue: 1000,
            endValue: 1000,
            netChange: 0,
            coverageDays: 30,
            observations: 31,
            frozenAt: '2026-11-02T12:00:00.000Z',
          },
          lastCompleted: null,
        },
      },
    };
    expect(validateSocialNativeInsightsDocument(doc, { asOf: AS_OF })).toEqual(doc);

    const malformed = structuredClone(doc);
    malformed.audienceGrowthCycles.instagram.status = 'completed';
    expect(() => validateSocialNativeInsightsDocument(malformed, { asOf: AS_OF }))
      .toThrow(/invalid audience growth cycle/);
  });

  it('accepts decimal Instagram Reel watch metrics and explicit metric-unavailable status', () => {
    const value = {
      schemaVersion: 1,
      sources: { instagramPostInsights: { status: 'available' } },
      posts: [{
        channel: 'instagram',
        postId: 'reel-1',
        publishedAt: '2026-10-30T12:00:00.000Z',
        snapshotAt: '2026-11-02T12:00:00.000Z',
        snapshotAgeHours: 72,
        windowHours: 72,
        mediaType: 'VIDEO',
        metrics: {
          reach: 1200,
          views: 1600,
          follows: null,
          igReelsAvgWatchTime: 3.25,
          igReelsVideoViewTotalTime: 52000.5,
          reelsSkipRate: 0.4,
        },
        availableMetrics: ['reach', 'views', 'igReelsAvgWatchTime', 'igReelsVideoViewTotalTime', 'reelsSkipRate'],
        metricStatus: {
          reach: 'available',
          views: 'available',
          follows: 'metric-unavailable',
          igReelsAvgWatchTime: 'available',
          igReelsVideoViewTotalTime: 'available',
          reelsSkipRate: 'available',
        },
      }],
    };
    expect(validateSocialNativeInsightsDocument(value, { asOf: AS_OF })).toEqual(value);
  });

  it('rejects credentials and malformed metric-availability combinations', () => {
    expect(() => validateSocialNativeInsightsDocument(documentWith({ accessToken: 'must-not-persist' }), { asOf: AS_OF }))
      .toThrow(/sensitive field/);
    expect(() => validateSocialNativeInsightsDocument(documentWith({ availableMetrics: [] }), { asOf: AS_OF }))
      .toThrow(/availability disagrees/);
    expect(() => validateSocialNativeInsightsDocument(documentWith({ copyAttributionStatus: 'ambiguous' }), { asOf: AS_OF }))
      .toThrow(/copy attribution status/);
    expect(() => validateSocialNativeInsightsDocument(documentWith({
      copy: { copyAngleId: 'bad id', copyPillarId: 'strumenti-utili', copyAngleIntent: 'both' },
    }), { asOf: AS_OF })).toThrow(/editorial angle metadata/);
  });

  it('requires TikTok observations to stay in the explicit fixed-age window', () => {
    expect(() => validateSocialNativeInsightsDocument(documentWith({ snapshotAgeHours: 400 }), { asOf: AS_OF }))
      .toThrow(/fixed 72-hour window/);
  });

  it('requires Facebook samples to use Meta created_time for the fixed-age window', () => {
    const facebookPost = {
      channel: 'facebook',
      postId: '123456_789',
      publishedAt: '2026-10-30T12:00:00.000Z',
      snapshotAt: '2026-11-02T12:00:00.000Z',
      snapshotAgeHours: 72,
      windowHours: 72,
      measurementWindow: 'first-72h-after-facebook-created-time',
      publicationTimeBasis: 'facebook-created-time',
      metrics: { mediaViews: 140, uniqueViewers: 100, reactions: 6, clicks: 3 },
      availableMetrics: ['mediaViews', 'uniqueViewers', 'reactions', 'clicks'],
      metricStatus: {
        mediaViews: 'available', uniqueViewers: 'available', reactions: 'available', clicks: 'available',
      },
    };
    const doc = { schemaVersion: 1, sources: { facebook: { status: 'available' } }, posts: [facebookPost] };
    expect(validateSocialNativeInsightsDocument(doc, { asOf: AS_OF })).toEqual(doc);
    expect(() => validateSocialNativeInsightsDocument({
      ...doc,
      posts: [{ ...facebookPost, publicationTimeBasis: 'scheduled-for' }],
    }, { asOf: AS_OF })).toThrow(/Facebook snapshot is outside the fixed 72-hour window/);
  });

  it('allows a missing LinkedIn metric only when its status remains explicitly unavailable', () => {
    const doc = documentWith({
      channel: 'linkedin-member',
      postId: 'urn:li:share:123',
      publishedAt: '2026-10-20T12:00:00.000Z',
      snapshotAgeHours: undefined,
      windowHours: undefined,
      windowDays: 7,
      measurementWindow: 'first-seven-utc-calendar-days',
      metrics: { impression: null },
      availableMetrics: [],
      metricStatus: { impression: 'metric-unavailable' },
    });
    expect(validateSocialNativeInsightsDocument(doc, { asOf: AS_OF })).toMatchObject({
      posts: [{ metrics: { impression: null }, metricStatus: { impression: 'metric-unavailable' } }],
    });
  });

  it('accepts private Instagram snapshots with exact post identity and an explicit observation window', () => {
    const doc = {
      schemaVersion: 1,
      sources: { instagram: { status: 'available' } },
      posts: [{
        channel: 'instagram',
        postId: 'media-1',
        publishedAt: '2026-10-30T12:00:00.000Z',
        snapshotAt: '2026-11-02T12:00:00.000Z',
        snapshotAgeHours: 72,
        windowHours: 72,
        metrics: { reach: 0, saves: null },
        availableMetrics: ['reach'],
        metricStatus: { reach: 'available', saves: 'unavailable' },
      }],
    };
    expect(validateSocialNativeInsightsDocument(doc, { asOf: AS_OF })).toMatchObject({
      sources: { instagram: { status: 'available' } },
      posts: [{ channel: 'instagram', metrics: { reach: 0, saves: null } }],
    });
  });

  it('accepts a private LinkedIn member audience snapshot without exposing member identity', () => {
    const doc = {
      schemaVersion: 1,
      sources: { linkedinAudience: { status: 'available', lastSuccessAt: '2026-11-02T12:00:00.000Z' } },
      posts: [],
      audienceSnapshots: [{
        channel: 'linkedin-member',
        metric: 'followers',
        value: 1250,
        snapshotAt: '2026-11-02T12:00:00.000Z',
        status: 'available',
        source: 'linkedin-member-followers-count',
      }],
    };
    expect(validateSocialNativeInsightsDocument(doc, { asOf: AS_OF })).toMatchObject({
      audienceSnapshots: [{ channel: 'linkedin-member', metric: 'followers', value: 1250 }],
    });
  });

  it('validates LinkedIn daily follower gains as a separate channel metric', () => {
    const doc = {
      schemaVersion: 1,
      sources: { linkedinFollowerGains: { status: 'partial' } },
      posts: [],
      followerGainSnapshots: [{
        channel: 'linkedin-member',
        metric: 'followers-gained',
        date: '2026-11-01',
        value: 0,
        snapshotAt: '2026-11-01T12:00:00.000Z',
        status: 'available',
        source: 'linkedin-member-follower-gains',
      }],
    };
    expect(validateSocialNativeInsightsDocument(doc, { asOf: AS_OF })).toMatchObject({
      followerGainSnapshots: [{ metric: 'followers-gained', value: 0 }],
    });
    expect(() => validateSocialNativeInsightsDocument({
      ...doc,
      followerGainSnapshots: [{ ...doc.followerGainSnapshots[0], metric: 'followers' }],
    }, { asOf: AS_OF })).toThrow(/invalid LinkedIn follower-gain row/);
  });

  it('accepts only thresholded closed-category community demand in outcome schema v2', () => {
    const communityOutcomes = buildInstagramCommunityOutcomeSnapshot({
      asOf: AS_OF,
      source: 'graph',
      coverage: 'graph-bounded-pages-and-recent-media',
      trackingStartedAt: AS_OF,
      interactions: [{
        surface: 'comments',
        source: 'graph',
        receivedAt: '2026-11-02T11:00:00.000Z',
        observedAt: '2026-11-02T11:30:00.000Z',
        status: 'delivery-uncertain',
        responseAt: null,
        escalationReason: 'delivery-uncertain',
      }],
      questionTopicSignals: Array.from({ length: 10 }, (_, index) => ({
        key: instagramCommunityTopicSignalKey(`comment-${index}`),
        category: 'permessi-amministrazione',
        receivedAt: '2026-11-01T10:00:00.000Z',
      })),
    });
    const document = { schemaVersion: 1, sources: {}, posts: [], communityOutcomes };
    expect(validateSocialNativeInsightsDocument(document, { asOf: AS_OF })).toMatchObject({
      communityOutcomes: {
        schemaVersion: 2,
        questionTopicDemand: {
          status: 'available',
          categories: [{ category: 'permessi-amministrazione', countBand: '10-24' }],
        },
      },
    });
    expect(() => validateSocialNativeInsightsDocument({
      ...document,
      communityOutcomes: {
        ...communityOutcomes,
        questionTopicDemand: {
          ...communityOutcomes.questionTopicDemand,
          categories: [{ category: 'permessi-amministrazione', countBand: '10-24', text: 'raw comment' }],
        },
      },
    }, { asOf: AS_OF })).toThrow(/invalid Instagram community question category/);
  });
});
