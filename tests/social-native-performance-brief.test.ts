import { describe, expect, it } from 'vitest';

import { buildNativeSocialPerformanceBrief } from '../scripts/social-copy/native-performance-brief.mjs';

const AS_OF = new Date('2026-11-02T12:00:00.000Z');
const CODEX_COPY = {
  copyMode: 'codex',
  copySlot: 'article',
  copyPackId: '0123456789abcdef',
  copyTemplateId: 'clear-question',
  copyAssignmentMode: 'firebase-balanced',
  copyExperimentId: 'social-copy-balanced-v1',
  copyAngleId: 'article-practical-question',
  copyPillarId: 'strumenti-utili',
  copyAngleIntent: 'both',
};

describe('native social copy performance brief', () => {
  it('aggregates exact Instagram, TikTok and LinkedIn copy arms by channel-specific metrics', () => {
    const instagram = [1, 2, 3].map((n) => ({
      postId: `ig-${n}`,
      kind: 'article',
      publishedAt: `2026-10-${10 + n}T12:00:00.000Z`,
      snapshotAt: `2026-10-${13 + n}T12:00:00.000Z`,
      snapshotAgeHours: 72,
      windowHours: 72,
      reachSource: 'reach',
      reach: 100 * n,
      saves: n,
      shares: 2 * n,
      availableMetrics: ['reach', 'saves', 'shares'],
      copyAttributionStatus: 'exact',
      ...CODEX_COPY,
    }));
    const tiktok = [1, 2, 3].map((n) => ({
      channel: 'tiktok',
      postId: `tt-${n}`,
      kind: 'article',
      publishedAt: `2026-10-${10 + n}T12:00:00.000Z`,
      snapshotAt: `2026-10-${13 + n}T12:00:00.000Z`,
      snapshotAgeHours: 72,
      windowHours: 72,
      metrics: { views: n * 100, likes: n * 5, comments: n, shares: n },
      availableMetrics: ['views', 'likes', 'comments', 'shares'],
      copy: CODEX_COPY,
      copyAttributionStatus: 'exact',
    }));
    const linkedin = [1, 2, 3].map((n) => ({
      channel: 'linkedin-member',
      postId: `urn:li:share:${n}`,
      kind: 'article',
      publishedAt: `2026-10-${10 + n}T12:00:00.000Z`,
      windowDays: 7,
      measurementWindow: 'first-seven-utc-calendar-days',
      metrics: {
        impression: n * 100,
        members_reached: n * 80,
        link_clicks: n * 4,
        post_save: n,
        post_send: n,
        follower_gained_from_content: n,
        profile_view_from_content: n * 2,
      },
      availableMetrics: [
        'impression', 'members_reached', 'link_clicks', 'post_save', 'post_send',
        'follower_gained_from_content', 'profile_view_from_content',
      ],
      copy: CODEX_COPY,
      copyAttributionStatus: 'exact',
    }));

    const brief = buildNativeSocialPerformanceBrief({
      asOf: AS_OF,
      instagramInsights: { posts: instagram },
      nativeInsights: { posts: [...tiktok, ...linkedin] },
      tiktokDisplayAnalyticsApproved: true,
    });

    expect(brief.variants).toHaveLength(3);
    expect(brief.variants.find((row) => row.channel === 'instagram')).toMatchObject({
      angleId: 'article-practical-question',
      pillarId: 'strumenti-utili',
    });
    expect(brief.variants.find((row) => row.channel === 'instagram')?.metrics.savesPerThousandReach)
      .toMatchObject({ status: 'descriptive-sample', observations: 3, median: 10 });
    expect(brief.variants.find((row) => row.channel === 'tiktok')?.metrics.interactionsPerThousandViews)
      .toMatchObject({ status: 'descriptive-sample', observations: 3, median: 70 });
    expect(brief.variants.find((row) => row.channel === 'linkedinMember')?.metrics.linkClicksPerThousandImpressions)
      .toMatchObject({ status: 'descriptive-sample', observations: 3, median: 40 });
    expect(brief.variants.find((row) => row.channel === 'linkedinMember')?.metrics.post_send)
      .toMatchObject({ status: 'descriptive-sample', observations: 3, median: 2 });
    expect(brief.variants.find((row) => row.channel === 'linkedinMember')?.metrics.follower_gained_from_content)
      .toMatchObject({ status: 'descriptive-sample', observations: 3, median: 2 });
    expect(JSON.stringify(brief)).not.toContain('ig-1');
    expect(JSON.stringify(brief)).not.toContain('urn:li:share:1');
    expect(brief.interpretation).toContain('No winner');
  });

  it('includes Facebook exact-ID post metrics only for the verified 72-hour window', () => {
    const facebook = [1, 2, 3].map((n) => ({
      channel: 'facebook',
      postId: `fb-${n}`,
      kind: 'job',
      publishedAt: `2026-10-${10 + n}T12:00:00.000Z`,
      snapshotAt: `2026-10-${13 + n}T12:00:00.000Z`,
      snapshotAgeHours: 72,
      windowHours: 72,
      measurementWindow: 'first-72h-after-facebook-created-time',
      publicationTimeBasis: 'facebook-created-time',
      metrics: { mediaViews: n * 100, uniqueViewers: n * 80, reactions: n * 8, clicks: n * 4 },
      availableMetrics: ['mediaViews', 'uniqueViewers', 'reactions', 'clicks'],
      copy: CODEX_COPY,
      copyAttributionStatus: 'exact',
    }));
    const outsideWindow = {
      ...facebook[0],
      postId: 'fb-outside-window',
      snapshotAgeHours: 90,
    };

    const brief = buildNativeSocialPerformanceBrief({
      asOf: AS_OF,
      nativeInsights: { posts: [...facebook, outsideWindow] },
    });

    expect(brief.variants).toHaveLength(1);
    expect(brief.variants[0]).toMatchObject({ channel: 'facebook', observations: 3 });
    expect(brief.variants[0]?.metrics.reactionsPerThousandUniqueViewers)
      .toMatchObject({ status: 'descriptive-sample', observations: 3, median: 100 });
    expect(brief.variants[0]?.metrics.clicksPerThousandUniqueViewers)
      .toMatchObject({ status: 'descriptive-sample', observations: 3, median: 50 });
    expect(JSON.stringify(brief)).not.toContain('fb-1');
    expect(JSON.stringify(brief)).not.toContain('fb-outside-window');
  });

  it('does not include incomplete copy joins or promote undersized samples', () => {
    const row = {
      channel: 'tiktok',
      postId: 'video-1',
      kind: 'article',
      publishedAt: '2026-10-30T12:00:00.000Z',
      snapshotAt: '2026-11-02T12:00:00.000Z',
      snapshotAgeHours: 72,
      windowHours: 72,
      metrics: { views: 100 },
      availableMetrics: ['views'],
      copy: CODEX_COPY,
      copyAttributionStatus: 'incomplete-or-conflicting',
    };
    const brief = buildNativeSocialPerformanceBrief({ asOf: AS_OF, nativeInsights: { posts: [row] } });
    expect(brief.variants).toEqual([]);
  });

  it('keeps automatically promoted winner deliveries as a separate descriptive cohort', () => {
    const rows = [1, 2, 3].map((index) => ({
      channel: 'instagram',
      postId: `winner-${index}`,
      kind: 'article',
      publishedAt: `2026-10-${20 + index}T12:00:00.000Z`,
      snapshotAt: `2026-10-${23 + index}T12:00:00.000Z`,
      snapshotAgeHours: 72,
      windowHours: 72,
      metrics: { reach: 100, saves: 10 },
      availableMetrics: ['reach', 'saves'],
      copy: { ...CODEX_COPY, copyAssignmentMode: 'firebase-winner' },
      copyAttributionStatus: 'exact',
    }));
    const brief = buildNativeSocialPerformanceBrief({
      asOf: AS_OF,
      minimumObservations: 3,
      instagramInsights: { posts: rows },
    });

    expect(brief.variants).toHaveLength(1);
    expect(brief.variants[0]).toMatchObject({
      channel: 'instagram',
      assignmentMode: 'firebase-winner',
      observations: 3,
    });
    expect(brief.interpretation).toContain('No winner');
  });

  it('excludes Instagram arms whose copy-to-media join is inferred or missing', () => {
    const makeRow = (postId: string, copyAttributionStatus?: string) => ({
      channel: 'instagram',
      postId,
      kind: 'article',
      publishedAt: '2026-10-30T12:00:00.000Z',
      snapshotAt: '2026-11-02T12:00:00.000Z',
      snapshotAgeHours: 72,
      windowHours: 72,
      metrics: { reach: 100, saves: 5 },
      availableMetrics: ['reach', 'saves'],
      ...CODEX_COPY,
      ...(copyAttributionStatus ? { copyAttributionStatus } : {}),
    });
    const brief = buildNativeSocialPerformanceBrief({
      asOf: AS_OF,
      minimumObservations: 1,
      instagramInsights: { posts: [makeRow('inferred', 'inferred'), makeRow('unknown')] },
    });
    expect(brief.variants).toEqual([]);
  });

  it('hides stored TikTok rows until Display API eligibility is explicitly enabled', () => {
    const row = {
      channel: 'tiktok',
      postId: 'stored-video',
      kind: 'article',
      publishedAt: '2026-10-30T12:00:00.000Z',
      snapshotAt: '2026-11-02T12:00:00.000Z',
      snapshotAgeHours: 72,
      windowHours: 72,
      metrics: { views: 500, likes: 40, comments: 3, shares: 4 },
      availableMetrics: ['views', 'likes', 'comments', 'shares'],
      copy: CODEX_COPY,
      copyAttributionStatus: 'exact',
    };

    const brief = buildNativeSocialPerformanceBrief({ asOf: AS_OF, nativeInsights: { posts: [row] } });

    expect(brief.variants).toEqual([]);
  });
});
