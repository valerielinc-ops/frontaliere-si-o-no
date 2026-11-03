import { describe, expect, it } from 'vitest';

import { validateSocialNativeInsightsDocument } from '../scripts/lib/social-native-insights-schema.mjs';

const AS_OF = new Date('2026-11-02T12:00:00.000Z');

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
});
