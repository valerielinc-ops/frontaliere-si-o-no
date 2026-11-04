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
      matchMethod: 'ledger-media-id',
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
      matchMethod: 'ledger-media-id',
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

  it('limits Story feedback to recent exact windows and reports engagement per reach', () => {
    const stories = [
      { storyId: 'story-a', publishedAt: '2026-10-29T12:00:00.000Z', reach: 100, views: 120, totalInteractions: 10, follows: 2, unmappedNavigationActions: 1 },
      { storyId: 'story-b', publishedAt: '2026-10-30T12:00:00.000Z', reach: 200, views: 240, totalInteractions: 20, follows: 4, unmappedNavigationActions: 2 },
      { storyId: 'story-c', publishedAt: '2026-10-31T12:00:00.000Z', reach: 400, views: 480, totalInteractions: 40, follows: 8, unmappedNavigationActions: 3 },
      { storyId: 'story-old', publishedAt: '2026-09-20T12:00:00.000Z', reach: 10, views: 1000, totalInteractions: 500, follows: 100 },
    ].map((row) => ({
      ...row,
      snapshotAt: new Date(Date.parse(row.publishedAt) + 23.5 * 60 * 60 * 1000).toISOString(),
      snapshotAgeHours: 23.5,
      measurementWindow: 'near-24h',
      followUpFormat: 'story-result',
      copyAngleId: 'practical-question',
      copyRevisionId: 'abcdef0123456789',
      metrics: {
        views: row.views,
        reach: row.reach,
        totalInteractions: row.totalInteractions,
        follows: row.follows,
        unmappedNavigationActions: row.unmappedNavigationActions,
      },
      availableMetrics: ['views', 'reach', 'totalInteractions', 'follows', 'unmappedNavigationActions'],
    }));

    const brief = buildNativeSocialPerformanceBrief({
      asOf: AS_OF,
      nativeInsights: { instagramStorySnapshots: stories },
    });

    expect(brief.instagramStories).toMatchObject({ baselineDays: 30, available: true });
    expect(brief.instagramStories.variants).toHaveLength(1);
    expect(brief.instagramStories.variants[0]).toMatchObject({
      observations: 3,
      medianSnapshotAgeHours: 23.5,
      storyFollowUpFormat: 'story-result',
      sourceFeedAngleId: 'practical-question',
      sourceFeedCopyRevisionId: 'abcdef0123456789',
      copyAttributionBasis: 'linked-source-feed-post-proxy',
    });
    expect(brief.instagramStories.variants[0]?.metrics.views).toMatchObject({
      status: 'descriptive-sample', observations: 3, median: 240,
    });
    expect(brief.instagramStories.variants[0]?.metrics.totalInteractionsPerThousandReach).toMatchObject({
      status: 'descriptive-sample', observations: 3, median: 100,
    });
    expect(brief.instagramStories.variants[0]?.metrics.followsPerThousandReach).toMatchObject({
      status: 'descriptive-sample', observations: 3, median: 20,
    });
    expect(brief.instagramStories.variants[0]?.metrics.unmappedNavigationActions).toMatchObject({
      status: 'descriptive-sample', observations: 3, median: 2,
    });
    expect(brief.instagramStories.interpretation).toContain('linked-feed-post proxies');
    expect(JSON.stringify(brief.instagramStories)).not.toContain('"angleId"');
    expect(JSON.stringify(brief.instagramStories)).not.toContain('"copyRevisionId"');
    const serialized = JSON.stringify(brief.instagramStories);
    expect(serialized).not.toContain('story-a');
    expect(serialized).not.toContain('story-old');
  });

  it('keeps Story rates unavailable when no positive reach denominator exists', () => {
    const stories = [1, 2, 3].map((index) => ({
      storyId: `story-no-reach-${index}`,
      publishedAt: `2026-10-${20 + index}T12:00:00.000Z`,
      snapshotAt: `2026-10-${21 + index}T11:30:00.000Z`,
      snapshotAgeHours: 23.5,
      measurementWindow: 'near-24h',
      followUpFormat: 'story-result',
      metrics: { reach: null, follows: index },
      availableMetrics: ['follows'],
    }));
    const brief = buildNativeSocialPerformanceBrief({ asOf: AS_OF, nativeInsights: { instagramStorySnapshots: stories } });

    expect(brief.instagramStories.variants[0]?.metrics.followsPerThousandReach).toMatchObject({
      status: 'denominator-unavailable', observations: 0, median: null,
    });
  });

  it('passes only thresholded public-comment category bands into Codex briefs', () => {
    const brief = buildNativeSocialPerformanceBrief({
      asOf: AS_OF,
      nativeInsights: {
        communityOutcomes: {
          questionTopicDemand: {
            status: 'available',
            source: 'public-instagram-comments-local-closed-taxonomy',
            windowDays: 30,
            minimumPerCategory: 10,
            categories: [{
              category: 'permessi-amministrazione',
              countBand: '10-24',
              text: 'Private comment text must be dropped',
              key: 'private-comment-hash',
            }],
          },
        },
      },
    });

    expect(brief.instagramCommunityQuestionDemand).toEqual({
      status: 'available',
      windowDays: 30,
      minimumPerCategory: 10,
      categories: [{ category: 'permessi-amministrazione', countBand: '10-24' }],
    });
    expect(JSON.stringify(brief.instagramCommunityQuestionDemand)).not.toContain('Private comment text');
    expect(JSON.stringify(brief.instagramCommunityQuestionDemand)).not.toContain('private-comment-hash');
  });

  it('keeps exact hook/CTA revisions diagnostic and does not expose their text', () => {
    const rows = [
      { postId: 'copy-a', copyHook: 'Traffico al valico', copyCta: 'Controlla ora' },
      { postId: 'copy-b', copyHook: 'Traffico al valico', copyCta: 'Controlla ora' },
      { postId: 'copy-c', copyHook: 'Traffico al valico', copyCta: 'Apri la mappa' },
    ].map((row) => ({
      ...row,
      kind: 'article',
      publishedAt: '2026-10-30T12:00:00.000Z',
      snapshotAt: AS_OF.toISOString(),
      snapshotAgeHours: 72,
      windowHours: 72,
      matchMethod: 'ledger-media-id',
      reachSource: 'reach',
      reach: 100,
      saves: 10,
      availableMetrics: ['reach', 'saves'],
      copyAttributionStatus: 'exact',
      ...CODEX_COPY,
    }));

    const brief = buildNativeSocialPerformanceBrief({
      asOf: AS_OF,
      minimumObservations: 1,
      instagramInsights: { posts: rows },
    });

    expect(brief.variants).toHaveLength(2);
    expect(brief.variants.map((variant) => variant.copyRevisionId)).toEqual(expect.arrayContaining([
      expect.stringMatching(/^[a-f0-9]{16}$/u),
      expect.stringMatching(/^[a-f0-9]{16}$/u),
    ]));
    expect(JSON.stringify(brief)).not.toContain('Traffico al valico');
    expect(JSON.stringify(brief)).not.toContain('Controlla ora');
    expect(brief.interpretation).toContain('Revision fingerprints are diagnostic');
  });
});
