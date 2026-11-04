import { describe, expect, it } from 'vitest';

import {
  loadPrivateSocialNativeInsights,
  mergePrivateSocialFollowerGainSnapshots,
  mergePrivateSocialInsightPosts,
  mergePrivateInstagramStoryPublications,
  mergePrivateInstagramStoryState,
  mergePrivateInstagramStorySnapshots,
  normalizeInstagramPrivateSnapshots,
  savePrivateSocialNativeInsights,
  updatePrivateSocialNativeInsights,
  SOCIAL_NATIVE_INSIGHTS_COLLECTION,
  SOCIAL_NATIVE_INSIGHTS_DOCUMENT,
  toInstagramBrowserSnapshotDocument,
} from '../scripts/lib/social-native-insights-store.mjs';
import { INSTAGRAM_STORY_METRICS } from '../scripts/lib/instagram-story-contract.mjs';

describe('private social native insights store', () => {
  it('merges LinkedIn follower-gain days by date, retains explicit zeroes, and prunes beyond retention', () => {
    const asOf = new Date('2026-11-02T12:00:00.000Z');
    const older = {
      channel: 'linkedin-member',
      metric: 'followers-gained',
      date: '2026-11-01',
      value: 3,
      snapshotAt: '2026-11-01T12:00:00.000Z',
      status: 'available',
      source: 'linkedin-member-follower-gains',
    };
    const updated = { ...older, value: 0 };
    const expired = { ...older, date: '2026-06-24', snapshotAt: '2026-06-24T12:00:00.000Z', value: 9 };

    expect(mergePrivateSocialFollowerGainSnapshots([older, expired], [updated], { asOf })).toEqual([updated]);
  });

  it('bounds exact Story publications and replaces only an older matching window snapshot', () => {
    const asOf = new Date('2026-11-03T12:00:00.000Z');
    const publication = {
      storyId: 'story-private-id',
      publishedAt: '2026-11-02T12:00:00.000Z',
      sourceMediaId: 'source-media-id',
      followUpFormat: 'story-result',
      copyPackId: '0123456789abcdef',
      copyTemplateId: 'story-follow-up',
      copyAngleId: 'practical-question',
      copyPillarId: 'useful-tools',
      copyRevisionId: 'abcdef0123456789',
    };
    const expired = { ...publication, storyId: 'expired-story', publishedAt: '2026-05-01T12:00:00.000Z' };
    const firstSnapshot = {
      ...publication,
      snapshotAt: '2026-11-02T12:30:00.000Z',
      snapshotAgeHours: 0.5,
      measurementWindow: 'first-hour',
      metrics: { views: 10 },
      availableMetrics: ['views'],
      metricStatus: { views: 'available' },
    };
    const latestSnapshot = {
      ...firstSnapshot,
      snapshotAt: '2026-11-02T12:50:00.000Z',
      snapshotAgeHours: 0.833,
      metrics: { views: 20 },
    };
    const publications = mergePrivateInstagramStoryPublications([expired], [publication], { asOf });
    const snapshots = mergePrivateInstagramStorySnapshots([firstSnapshot], [latestSnapshot], { asOf });

    expect(publications).toEqual([publication]);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({ storyId: publication.storyId, metrics: { views: 20 } });
  });

  it('keeps bounded Story snapshots aligned with the retained publication identities', () => {
    const asOf = new Date('2026-11-03T12:00:00.000Z');
    const firstPublishedMs = Date.parse('2026-10-01T12:00:00.000Z');
    const publications = Array.from({ length: 401 }, (_, index) => ({
      storyId: `story-${String(index).padStart(3, '0')}`,
      publishedAt: new Date(firstPublishedMs + index * 60 * 60 * 1000).toISOString(),
    }));
    const snapshots = publications.map((publication, index) => {
      const snapshotAgeHours = index === 0 ? 23 : 0.5;
      return {
        ...publication,
        snapshotAt: new Date(Date.parse(publication.publishedAt) + snapshotAgeHours * 60 * 60 * 1000).toISOString(),
        snapshotAgeHours,
        measurementWindow: index === 0 ? 'near-24h' : 'first-hour',
        metrics: {},
        availableMetrics: [],
        metricStatus: {},
      };
    });
    const state = mergePrivateInstagramStoryState({}, {
      publicationAdditions: publications,
      snapshotAdditions: snapshots,
      asOf,
    });
    const retainedStoryIds = new Set(state.instagramStoryPublications.map(({ storyId }) => storyId));

    expect(state.instagramStoryPublications).toHaveLength(400);
    expect(state.instagramStorySnapshots).toHaveLength(400);
    expect(state.instagramStorySnapshots.every(({ storyId }) => retainedStoryIds.has(storyId))).toBe(true);
  });

  it('reads and writes the private Firestore document without exposing per-post data in its result', async () => {
    let stored: Record<string, unknown> | null = null;
    let path = '';
    const db = {
      collection(name: string) {
        path = name;
        return {
          doc(id: string) {
            path += `/${id}`;
            return {
              get: async () => ({ exists: stored !== null, data: () => stored }),
              set: async (document: Record<string, unknown>) => { stored = document; },
            };
          },
        };
      },
    };
    const document = {
      schemaVersion: 1,
      sources: { tiktok: { status: 'available' }, linkedinMember: { status: 'available' } },
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
    };
    const asOf = new Date('2026-11-02T12:00:00.000Z');

    const empty = await loadPrivateSocialNativeInsights(db, { asOf });
    expect(empty.posts).toEqual([]);
    expect(await savePrivateSocialNativeInsights(db, document, { updatedAt: asOf })).toMatchObject({ bytes: expect.any(Number) });

    const loaded = await loadPrivateSocialNativeInsights(db, { asOf });
    expect(path).toBe(`${SOCIAL_NATIVE_INSIGHTS_COLLECTION}/${SOCIAL_NATIVE_INSIGHTS_DOCUMENT}`);
    expect(loaded.posts).toEqual(document.posts);
    expect(stored).toMatchObject({ storeUpdatedAt: asOf.toISOString() });
  });

  it('loads legacy Story snapshots with newly added metrics marked unavailable', async () => {
    const asOf = new Date('2026-11-03T12:00:00.000Z');
    const publication = {
      storyId: 'legacy-story',
      publishedAt: '2026-11-03T11:30:00.000Z',
      sourceMediaId: null,
      followUpFormat: null,
      copyPackId: null,
      copyTemplateId: null,
      copyAngleId: null,
      copyPillarId: null,
      copyRevisionId: null,
    };
    const metrics = Object.fromEntries(INSTAGRAM_STORY_METRICS.map((name) => [name, null]));
    const metricStatus = Object.fromEntries(INSTAGRAM_STORY_METRICS.map((name) => [name, 'unavailable']));
    delete metrics.unmappedNavigationActions;
    delete metricStatus.unmappedNavigationActions;
    const legacy = {
      schemaVersion: 1,
      sources: {},
      posts: [],
      instagramStoryPublications: [publication],
      instagramStorySnapshots: [{
        ...publication,
        snapshotAt: asOf.toISOString(),
        snapshotAgeHours: 0.5,
        measurementWindow: 'first-hour',
        metrics,
        availableMetrics: [],
        metricStatus,
      }],
    };
    let stored: Record<string, any> = structuredClone(legacy);
    let writes = 0;
    const reference = {
      get: async () => ({ exists: true, data: () => stored }),
    };
    const db = {
      collection: () => ({ doc: () => reference }),
      runTransaction: async (callback: (transaction: any) => Promise<unknown>) => callback({
        get: async () => ({ exists: true, data: () => stored }),
        set: (_reference: unknown, document: Record<string, unknown>) => {
          stored = structuredClone(document);
          writes += 1;
        },
      }),
    };

    const loaded = await loadPrivateSocialNativeInsights(db, { asOf });
    expect(loaded.instagramStorySnapshots[0]).toMatchObject({
      metrics: { unmappedNavigationActions: null },
      metricStatus: { unmappedNavigationActions: 'unavailable' },
      availableMetrics: [],
    });
    expect(stored.instagramStorySnapshots[0].metrics).not.toHaveProperty('unmappedNavigationActions');

    await updatePrivateSocialNativeInsights(db, (current) => ({
      ...current,
      sources: { ...current.sources, instagramStoryInsights: { status: 'no-ready-stories' } },
    }), { updatedAt: asOf });
    expect(writes).toBe(1);
    expect(stored.instagramStorySnapshots[0]).toMatchObject({
      metrics: { unmappedNavigationActions: null },
      metricStatus: { unmappedNavigationActions: 'unavailable' },
    });
  });

  it('rejects malformed or oversized snapshots before writing', async () => {
    let writes = 0;
    const db = {
      collection() {
        return { doc: () => ({ set: async () => { writes += 1; } }) };
      },
    };

    await expect(savePrivateSocialNativeInsights(db, { schemaVersion: 9, sources: {}, posts: [] }))
      .rejects.toThrow('schemaVersion 1');
    expect(writes).toBe(0);
  });

  it('updates through a Firestore transaction and preserves rows written by another channel', async () => {
    let stored: Record<string, any> | null = {
      schemaVersion: 1,
      sources: { tiktok: { status: 'available' } },
      posts: [{
        channel: 'tiktok',
        postId: 'video-1',
        publishedAt: '2026-10-30T12:00:00.000Z',
        snapshotAt: '2026-11-02T12:00:00.000Z',
        windowHours: 72,
        snapshotAgeHours: 72,
        metrics: { views: 20 },
        availableMetrics: ['views'],
        metricStatus: { views: 'available' },
      }],
    };
    let transactionWrites = 0;
    const reference = {};
    const db = {
      collection: () => ({ doc: () => reference }),
      runTransaction: async (callback: (transaction: any) => Promise<unknown>) => callback({
        get: async () => ({ exists: stored !== null, data: () => stored }),
        set: (_ref: unknown, document: Record<string, unknown>) => {
          stored = structuredClone(document);
          transactionWrites += 1;
        },
      }),
    };

    await updatePrivateSocialNativeInsights(db, (current) => ({
      ...current,
      sources: { ...current.sources, instagram: { status: 'available' } },
      posts: [...current.posts, {
        channel: 'instagram',
        postId: 'media-1',
        publishedAt: '2026-10-30T12:00:00.000Z',
        snapshotAt: '2026-11-02T12:00:00.000Z',
        windowHours: 72,
        snapshotAgeHours: 72,
        metrics: { reach: 50 },
        availableMetrics: ['reach'],
        metricStatus: { reach: 'available' },
      }],
    }), { updatedAt: new Date('2026-11-02T12:00:00.000Z') });

    expect(transactionWrites).toBe(1);
    expect(stored?.posts.map((post: any) => post.channel)).toEqual(['tiktok', 'instagram']);
    expect(stored?.sources).toEqual({ tiktok: { status: 'available' }, instagram: { status: 'available' } });
  });

  it('normalizes browser Insights to a private exact-media record and expands it for existing analyzers', () => {
    const rows = normalizeInstagramPrivateSnapshots({
      windowHours: 72,
      posts: [{
        mediaId: 'ig-media-1',
        queueId: 'article-2026-10-10',
        kind: 'article',
        day: '2026-10-10',
        snapshotAt: '2026-10-13T12:00:00.000Z',
        snapshotAgeHours: 72,
        reach: 100,
        saves: 5,
        shares: 2,
        availableMetrics: ['reach', 'saves', 'shares'],
        copyMode: 'codex',
        copySlot: 'article',
        copyPackId: '0123456789abcdef',
        copyTemplateId: 'clear-question',
        copyAssignmentMode: 'firebase-balanced',
        copyAngleId: 'article-practical-question',
        copyPillarId: 'strumenti-utili',
        copyAngleIntent: 'both',
      }],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      channel: 'instagram',
      postId: 'ig-media-1',
      publishedAt: '2026-10-10T12:00:00.000Z',
      metrics: { reach: 100, saves: 5, shares: 2, views: null },
      availableMetrics: ['reach', 'saves', 'shares'],
      metricStatus: { views: 'unavailable', reach: 'available' },
      copyTemplateId: 'clear-question',
      copyAngleId: 'article-practical-question',
      copyPillarId: 'strumenti-utili',
      copyAngleIntent: 'both',
    });
    const document = {
      schemaVersion: 1,
      sources: { instagram: { status: 'available' } },
      posts: rows,
    };
    expect(toInstagramBrowserSnapshotDocument(document).posts[0]).toMatchObject({
      mediaId: 'ig-media-1',
      reach: 100,
      saves: 5,
      copyTemplateId: 'clear-question',
      copyAngleId: 'article-practical-question',
    });
  });

  it('preserves exact Reel metrics, decimal watch-time values, and per-metric availability', () => {
    const rows = normalizeInstagramPrivateSnapshots({
      windowHours: 72,
      posts: [{
        mediaId: 'ig-reel-1',
        mediaType: 'VIDEO',
        snapshotAt: '2026-10-13T12:00:00.000Z',
        snapshotAgeHours: 72,
        reach: 1000,
        views: 1500,
        follows: null,
        igReelsAvgWatchTime: 2.75,
        igReelsVideoViewTotalTime: 45000,
        reelsSkipRate: 0.35,
        availableMetrics: ['reach', 'views', 'igReelsAvgWatchTime', 'igReelsVideoViewTotalTime', 'reelsSkipRate'],
        metricStatus: {
          reach: 'available',
          views: 'available',
          follows: 'metric-unavailable',
          igReelsAvgWatchTime: 'available',
          igReelsVideoViewTotalTime: 'available',
          reelsSkipRate: 'available',
        },
        matchMethod: 'ledger-media-id',
        copyAttributionStatus: 'exact',
      }],
    });

    expect(rows[0]).toMatchObject({
      postId: 'ig-reel-1',
      mediaType: 'VIDEO',
      metrics: {
        reach: 1000,
        views: 1500,
        follows: null,
        igReelsAvgWatchTime: 2.75,
        igReelsVideoViewTotalTime: 45000,
        reelsSkipRate: 0.35,
      },
      metricStatus: {
        follows: 'metric-unavailable',
        igReelsAvgWatchTime: 'available',
      },
      copyAttributionStatus: 'exact',
    });
  });

  it('keeps legacy defaulted interaction zeros unknown while preserving explicitly observed zeros', () => {
    const rows = normalizeInstagramPrivateSnapshots({
      windowHours: 72,
      posts: [
        {
          mediaId: 'legacy-media',
          snapshotAt: '2026-10-13T12:00:00.000Z',
          snapshotAgeHours: 72,
          views: 23,
          reach: 23,
          reachSource: 'views',
          shares: 0,
          saves: 0,
          comments: 0,
        },
        {
          mediaId: 'current-media',
          snapshotAt: '2026-10-13T12:00:00.000Z',
          snapshotAgeHours: 72,
          views: 23,
          reach: 23,
          shares: 0,
          availableMetrics: ['views', 'shares'],
        },
      ],
    });

    expect(rows[0]).toMatchObject({
      metrics: { views: 23, reach: null, shares: null, saves: null, comments: null },
      availableMetrics: ['views'],
      metricStatus: { views: 'available', reach: 'unavailable', shares: 'unavailable' },
    });
    expect(rows[1]).toMatchObject({
      metrics: { views: 23, shares: 0 },
      availableMetrics: ['views', 'shares'],
      metricStatus: { shares: 'available' },
    });
  });

  it('does not replace an explicitly invalid row window with the snapshot default', () => {
    const rows = normalizeInstagramPrivateSnapshots({
      windowHours: 72,
      posts: [{
        mediaId: 'invalid-window-media',
        snapshotAt: '2026-10-13T12:00:00.000Z',
        snapshotAgeHours: 72,
        windowHours: 0,
        views: 23,
        availableMetrics: ['views'],
      }],
    });

    expect(rows).toEqual([]);
  });

  it('merges channel snapshots by exact identity and keeps the newer observation', () => {
    const older = { channel: 'instagram', postId: 'media-1', windowHours: 72, snapshotAt: '2026-10-13T12:00:00Z' };
    const newer = { ...older, snapshotAt: '2026-10-13T13:00:00Z', metrics: { reach: 9 } };
    const other = { channel: 'tiktok', postId: 'video-1', windowHours: 72, snapshotAt: '2026-10-13T12:00:00Z' };
    expect(mergePrivateSocialInsightPosts([older, other], [newer])).toEqual([newer, other]);
  });
});
