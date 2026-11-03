import { describe, expect, it, vi } from 'vitest';

import { collectSocialNativeInsights } from '../scripts/social-native-insights.mjs';

describe('social native insights workflow runner', () => {
  it('collects Instagram post metrics into the private store with exact-ID attribution', async () => {
    const asOf = new Date('2026-11-02T12:00:00.000Z');
    const collectInstagramPosts = vi.fn(async ({ ledger, existing }: { ledger: any; existing: any }) => {
      expect(ledger).toHaveProperty('posted');
      expect(existing).toMatchObject({ schemaVersion: 2, posts: [] });
      return {
        status: 'snapshots-added',
        candidates: 1,
        matched: 1,
        additions: [{
          mediaId: 'instagram-reel-exact-id',
          mediaType: 'VIDEO',
          publishedAt: '2026-10-30T12:00:00.000Z',
          snapshotAt: asOf.toISOString(),
          snapshotAgeHours: 72,
          windowHours: 72,
          reach: 1200,
          views: 1600,
          follows: 4,
          igReelsAvgWatchTime: 3.25,
          igReelsVideoViewTotalTime: 52000,
          reelsSkipRate: 0.4,
          availableMetrics: ['reach', 'views', 'follows', 'igReelsAvgWatchTime', 'igReelsVideoViewTotalTime', 'reelsSkipRate'],
          metricStatus: {
            reach: 'available',
            views: 'available',
            follows: 'available',
            igReelsAvgWatchTime: 'available',
            igReelsVideoViewTotalTime: 'available',
            reelsSkipRate: 'available',
          },
          matchMethod: 'ledger-media-id',
          copyAttributionStatus: 'exact',
        }],
      };
    });
    const result = await collectSocialNativeInsights({
      env: {},
      asOf,
      existing: { schemaVersion: 1, posts: [], sources: {} },
      collectInstagramPosts,
      collectLinkedIn: false,
    });

    expect(collectInstagramPosts).toHaveBeenCalledOnce();
    expect(result.sources.instagramPostInsights).toBe('available');
    expect(result.document.posts[0]).toMatchObject({
      channel: 'instagram',
      postId: 'instagram-reel-exact-id',
      mediaType: 'VIDEO',
      metrics: {
        reach: 1200,
        follows: 4,
        igReelsAvgWatchTime: 3.25,
        igReelsVideoViewTotalTime: 52000,
        reelsSkipRate: 0.4,
      },
      matchMethod: 'ledger-media-id',
      copyAttributionStatus: 'exact',
    });
  });

  it('routes the three Facebook publisher ledgers through the gated exact-ID collector', async () => {
    const asOf = new Date('2026-11-03T12:00:00.000Z');
    const facebookPost = {
      channel: 'facebook',
      postId: '123456_789',
      publishedAt: '2026-10-31T12:00:00.000Z',
      snapshotAt: asOf.toISOString(),
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
    const collectFacebookPosts = vi.fn(async ({ ledger, eligibilityStatus }: { ledger: any[]; eligibilityStatus: string }) => {
      expect(ledger.length).toBeGreaterThan(0);
      expect(ledger.map((row) => row.ledgerSource)).toEqual(expect.arrayContaining([
        'facebookJobs', 'facebookArticles', 'facebookEvents',
      ]));
      expect(eligibilityStatus).toBe('post-insights-exact-id-probe-required');
      return { status: 'available', posts: [facebookPost], attempted: 1, skipped: 0 };
    });
    const result = await collectSocialNativeInsights({
      env: { FB_PAGE_ID: '123456', FB_PAGE_ACCESS_TOKEN: 'private-test-token' },
      asOf,
      existing: {
        schemaVersion: 1,
        posts: [],
        sources: {
          facebookAudience: { status: 'available', lastAttemptAt: asOf.toISOString() },
          facebook: { eligibilityStatus: 'post-insights-exact-id-probe-required' },
        },
      },
      collectFacebookPosts,
      collectInstagramPosts: async () => ({ status: 'nothing-collected', additions: [] }),
      collectLinkedIn: false,
    });

    expect(collectFacebookPosts).toHaveBeenCalledOnce();
    expect(result.sources.facebook).toBe('available');
    expect(result.document.posts).toContainEqual(facebookPost);
  });

  it('can skip the LinkedIn API between daily collection windows and retains its last status', async () => {
    const fetchTikTok = vi.fn<typeof fetch>();
    const fetchLinkedIn = vi.fn<typeof fetch>();
    const result = await collectSocialNativeInsights({
      env: {
        TIKTOK_ACCESS_TOKEN: 'configured-token-without-approval',
        LINKEDIN_MEMBER_POST_ANALYTICS_STORAGE_APPROVED: 'true',
      },
      asOf: new Date('2026-11-02T06:15:00.000Z'),
      existing: {
        schemaVersion: 1,
        posts: [],
        sources: { linkedinMember: { status: 'available' } },
      },
      fetchTikTok,
      fetchLinkedIn,
      collectLinkedIn: false,
    });

    expect(fetchTikTok).not.toHaveBeenCalled();
    expect(fetchLinkedIn).not.toHaveBeenCalled();
    expect(result.results.linkedinMember.status).toBe('not-collected-this-run');
    expect(result.sources.linkedinMember).toBe('available');
    expect(result.sources.tiktok).toBe('policy-review-required');
  });

  it('holds LinkedIn member-post analytics without storage approval and prunes old per-post rows', async () => {
    const asOf = new Date('2026-11-02T00:15:00.000Z');
    const collectLinkedInInsights = vi.fn(async () => ({ status: 'snapshots-added', posts: [], skipped: [] }));
    const result = await collectSocialNativeInsights({
      env: {},
      asOf,
      existing: {
        schemaVersion: 1,
        posts: [{
          channel: 'linkedin-member',
          postId: 'urn:li:share:123',
          publishedAt: '2026-10-20T12:00:00.000Z',
          snapshotAt: '2026-10-28T12:00:00.000Z',
          windowDays: 7,
          measurementWindow: 'first-seven-utc-calendar-days',
          metrics: { impression: 50 },
          availableMetrics: ['impression'],
          metricStatus: { impression: 'available' },
        }],
        audienceSnapshots: [{
          channel: 'linkedin-member',
          metric: 'followers',
          value: 1250,
          snapshotAt: asOf.toISOString(),
          status: 'available',
          source: 'linkedin-member-followers-count',
        }],
        sources: {
          linkedinMember: { status: 'available', postAnalyticsStorageApproved: true },
          linkedinAudience: { status: 'available', lastAttemptAt: asOf.toISOString() },
          linkedinFollowerGains: { status: 'available', lastAttemptAt: asOf.toISOString() },
        },
      },
      getLinkedInToken: async () => 'opaque-test-token',
      collectLinkedInInsights,
      collectInstagramPosts: async () => ({ status: 'nothing-collected', additions: [] }),
    });

    expect(collectLinkedInInsights).not.toHaveBeenCalled();
    expect(result.results.linkedinMember.status).toBe('policy-review-required');
    expect(result.document.posts).toEqual([]);
    expect(result.document.sources.linkedinMember).toMatchObject({
      status: 'policy-review-required',
      postAnalyticsStorageApproved: false,
    });
  });

  it('keeps a TikTok token-refresh failure from preventing LinkedIn collection', async () => {
    const getTikTokToken = vi.fn(async () => { throw new Error('refresh-token persistence failed'); });
    const getLinkedInToken = vi.fn(async () => 'linkedin-test-token');
    const collectLinkedInInsights = vi.fn(async () => ({
      status: 'no-new-eligible-posts',
      posts: [],
      skipped: [],
    }));
    const collectLinkedInFollowerGains = vi.fn(async () => ({ status: 'metric-unavailable', snapshots: [] }));
    const result = await collectSocialNativeInsights({
      env: {
        TIKTOK_DISPLAY_ANALYTICS_APPROVED: 'true',
        LINKEDIN_MEMBER_POST_ANALYTICS_STORAGE_APPROVED: 'true',
      },
      asOf: new Date('2026-11-02T06:15:00.000Z'),
      existing: { schemaVersion: 1, posts: [], sources: {} },
      getTikTokToken,
      getLinkedInToken,
      collectLinkedInInsights,
      collectLinkedInFollowerGains,
    });

    expect(getTikTokToken).toHaveBeenCalledOnce();
    expect(getLinkedInToken).toHaveBeenCalledOnce();
    expect(collectLinkedInInsights).toHaveBeenCalledOnce();
    expect(collectLinkedInFollowerGains).toHaveBeenCalledOnce();
    expect(result.results.tiktok.status).toBe('api-error');
    expect(result.results.linkedinMember.status).toBe('no-new-eligible-posts');
    expect(result.sources.linkedinMember).toBe('available');
  });

  it('collects LinkedIn member audience once per UTC day and persists only the count snapshot', async () => {
    const collectLinkedInAudience = vi.fn(async ({ asOf }: { asOf: Date }) => ({
      status: 'available',
      snapshotAt: asOf.toISOString(),
      snapshot: {
        channel: 'linkedin-member',
        metric: 'followers',
        value: 1250,
        snapshotAt: asOf.toISOString(),
        status: 'available',
        source: 'linkedin-member-followers-count',
      },
    }));
    const collectLinkedInInsights = vi.fn(async () => ({
      status: 'no-new-eligible-posts',
      posts: [],
      skipped: [],
    }));
    const followerRows = [
      {
        channel: 'linkedin-member',
        metric: 'followers-gained',
        date: '2026-10-31',
        value: 2,
        snapshotAt: '2026-10-31T12:00:00.000Z',
        status: 'available',
        source: 'linkedin-member-follower-gains',
      },
      {
        channel: 'linkedin-member',
        metric: 'followers-gained',
        date: '2026-11-01',
        value: 0,
        snapshotAt: '2026-11-01T12:00:00.000Z',
        status: 'available',
        source: 'linkedin-member-follower-gains',
      },
    ];
    const collectLinkedInFollowerGains = vi.fn(async ({ startDate, endDate }: { startDate: string; endDate: string }) => ({
      status: 'partial',
      expectedDays: 30,
      coverageDays: 2,
      snapshots: followerRows,
      requestedRange: { startDate, endDate },
    }));
    const asOf = new Date('2026-11-02T00:15:00.000Z');
    const result = await collectSocialNativeInsights({
      env: { LINKEDIN_MEMBER_POST_ANALYTICS_STORAGE_APPROVED: 'true' },
      asOf,
      existing: { schemaVersion: 1, posts: [], sources: {} },
      getLinkedInToken: async () => 'opaque-test-token',
      collectLinkedInInsights,
      collectLinkedInAudience,
      collectLinkedInFollowerGains,
      collectLinkedIn: true,
    });

    expect(collectLinkedInAudience).toHaveBeenCalledOnce();
    expect(result.results.linkedinAudience).toEqual({ status: 'available', snapshot: true });
    expect(result.document.audienceSnapshots).toContainEqual({
      channel: 'linkedin-member',
      metric: 'followers',
      value: 1250,
      snapshotAt: asOf.toISOString(),
      status: 'available',
      source: 'linkedin-member-followers-count',
    });
    expect(result.document.audienceBaselines['linkedin-member']).toBeUndefined();
    expect(result.results.linkedinFollowerGains).toMatchObject({ status: 'partial', snapshots: 2, coverageDays: 2, expectedDays: 30 });
    expect(result.document.followerGainSnapshots).toEqual(followerRows);
    expect(collectLinkedInFollowerGains).toHaveBeenCalledWith(expect.objectContaining({
      startDate: '2026-10-03',
      endDate: '2026-11-02',
    }));

    const sameDay = await collectSocialNativeInsights({
      env: { LINKEDIN_MEMBER_POST_ANALYTICS_STORAGE_APPROVED: 'true' },
      asOf: new Date('2026-11-02T06:15:00.000Z'),
      existing: result.document,
      getLinkedInToken: async () => 'opaque-test-token',
      collectLinkedInInsights,
      collectLinkedInAudience,
      collectLinkedInFollowerGains,
      collectLinkedIn: true,
    });
    expect(collectLinkedInAudience).toHaveBeenCalledOnce();
    expect(collectLinkedInFollowerGains).toHaveBeenCalledOnce();
    expect(sameDay.sources.linkedinAudience).toBe('available');
    expect(sameDay.sources.linkedinFollowerGains).toBe('partial');
  });

  it('calls TikTok Display API only after explicit use-case approval is configured', async () => {
    const fetchTikTok = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      data: { videos: [], has_more: false },
      error: { code: 'ok', message: '' },
    }), { status: 200 }));
    const result = await collectSocialNativeInsights({
      env: {
        TIKTOK_DISPLAY_ANALYTICS_APPROVED: 'true',
        TIKTOK_ACCESS_TOKEN: 'test-token',
      },
      asOf: new Date('2026-11-02T06:15:00.000Z'),
      existing: { schemaVersion: 1, posts: [], sources: {} },
      fetchTikTok,
      collectLinkedIn: false,
    });

    expect(fetchTikTok).toHaveBeenCalledTimes(2);
    const requestedPaths = fetchTikTok.mock.calls.map(([input]) => new URL(String(input)).pathname);
    expect(requestedPaths).toEqual(expect.arrayContaining(['/v2/video/list/', '/v2/user/info/']));
    expect(result.sources.tiktok).not.toBe('policy-review-required');
  });
});
