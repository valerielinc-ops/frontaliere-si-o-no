import { describe, expect, it } from 'vitest';

import {
  collectTikTokNativeInsights,
  listTikTokVideos,
  matchTikTokVideosToLedger,
  TIKTOK_VIDEO_FIELDS,
} from '../scripts/lib/tiktok-native-insights.mjs';

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

describe('TikTok Display API native insights', () => {
  it('requests only the declared video fields and reads the authenticated user video list', async () => {
    let requestUrl = '';
    let requestBody = '';
    const result = await listTikTokVideos('opaque-token', {
      fetchImpl: async (url: string, init: RequestInit) => {
        requestUrl = String(url);
        requestBody = String(init.body);
        return ok({
          data: {
            videos: [{
              id: 'video-1',
              create_time: 1790863200,
              view_count: 120,
              like_count: 8,
              comment_count: 2,
              share_count: 1,
            }],
            has_more: false,
          },
          error: { code: 'ok' },
        });
      },
    });

    expect(new URL(requestUrl).searchParams.get('fields')?.split(',')).toEqual([...TIKTOK_VIDEO_FIELDS]);
    expect(JSON.parse(requestBody)).toMatchObject({ max_count: 20 });
    expect(result).toMatchObject({
      status: 'available',
      videos: [{ postId: 'video-1', metrics: { views: 120, likes: 8, comments: 2, shares: 1 } }],
    });
  });

  it('preserves missing counters as unavailable and distinguishes missing scope from zero views', async () => {
    const missingMetric = await listTikTokVideos('opaque-token', {
      fetchImpl: async () => ok({
        data: { videos: [{ id: 'video-1', create_time: 1790863200, view_count: 0 }], has_more: false },
        error: { code: 'ok' },
      }),
    });
    expect(missingMetric.videos[0]).toMatchObject({
      metrics: { views: 0, likes: null, comments: null, shares: null },
      availableMetrics: ['views'],
    });

    const noScope = await listTikTokVideos('opaque-token', {
      fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({ error: { code: 'scope_not_authorized' } }) }),
    });
    expect(noScope).toMatchObject({ status: 'permission-unavailable', reasonCode: 'scope_not_authorized' });
  });

  it('rejects booleans as malformed metric values instead of coercing them to counts', async () => {
    const result = await listTikTokVideos('opaque-token', {
      fetchImpl: async () => ok({
        data: { videos: [{ id: 'video-1', create_time: 1790863200, view_count: false, like_count: true }], has_more: false },
        error: { code: 'ok' },
      }),
    });
    expect(result.videos[0].metrics).toMatchObject({ views: null, likes: null });
    expect(result.videos[0].availableMetrics).toEqual([]);
  });

  it('joins through the exact published TikTok ID and rejects caption/time inference', () => {
    const result = matchTikTokVideosToLedger([
      { postId: 'video-known', metrics: {} },
      { postId: 'video-unmatched', metrics: {} },
    ], {
      posted: [{
        id: 'article-1', kind: 'article', day: '2026-10-01', tiktokPostId: 'video-known',
        copyMode: 'codex', copySlot: 'article', copyPackId: '0123456789abcdef',
        copyTemplateId: 'clear-question', copyAssignmentMode: 'firebase-balanced',
        copyAngleId: 'article-practical-question', copyPillarId: 'strumenti-utili', copyAngleIntent: 'both',
      }],
    });

    expect(result.matches).toMatchObject([{
      postId: 'video-known', sourceIds: ['article-1'], kind: 'article', day: '2026-10-01',
      copy: { copyAngleId: 'article-practical-question', copyPillarId: 'strumenti-utili', copyAngleIntent: 'both' },
      copyAttributionStatus: 'exact',
    }]);
    expect(result.unmatched).toContainEqual({ postId: 'video-unmatched', reason: 'exact-ledger-id-missing' });
  });

  it('rejects partial angle metadata across duplicate ledger rows for one published ID', () => {
    const base = {
      kind: 'article',
      tiktokPostId: 'video-known',
      copyMode: 'codex',
      copySlot: 'article',
      copyPackId: '0123456789abcdef',
      copyTemplateId: 'clear-question',
      copyAssignmentMode: 'firebase-balanced',
    };
    const result = matchTikTokVideosToLedger([{ postId: 'video-known', metrics: {} }], {
      posted: [
        { ...base, id: 'article-1', copyAngleId: 'article-practical-question', copyPillarId: 'strumenti-utili', copyAngleIntent: 'both' },
        { ...base, id: 'article-duplicate' },
      ],
    });

    expect(result.matches[0]).toMatchObject({ copy: null, copyAttributionStatus: 'incomplete-or-conflicting' });
  });

  it('collects only a fixed 72-hour observation and reports absent historical IDs', async () => {
    const asOf = new Date('2026-10-04T12:00:00.000Z');
    const result = await collectTikTokNativeInsights({
      accessToken: 'opaque-token',
      asOf,
      ledger: { posted: [{ id: 'article-1', kind: 'article', day: '2026-10-01', tiktokPostId: 'video-1' }] },
      fetchImpl: async () => ok({
        data: { videos: [{
          id: 'video-1',
          create_time: Date.parse('2026-10-01T12:00:00.000Z') / 1000,
          view_count: 100,
          like_count: 4,
          comment_count: 1,
          share_count: 2,
        }], has_more: false },
        error: { code: 'ok' },
      }),
    });

    expect(result).toMatchObject({
      status: 'snapshots-added',
      posts: [{
        channel: 'tiktok',
        postId: 'video-1',
        snapshotAgeHours: 72,
        windowHours: 72,
        metrics: { views: 100, likes: 4, comments: 1, shares: 2 },
      }],
    });

    const noIds = await collectTikTokNativeInsights({
      accessToken: 'opaque-token',
      asOf,
      ledger: { posted: [{ id: 'article-legacy', kind: 'article' }] },
      fetchImpl: async () => ok({ data: { videos: [], has_more: false }, error: { code: 'ok' } }),
    });
    expect(noIds.status).toBe('mapping-unavailable');
  });

  it('keeps matched observations from a truncated listing and marks coverage partial', async () => {
    const asOf = new Date('2026-10-04T12:00:00.000Z');
    const result = await collectTikTokNativeInsights({
      accessToken: 'opaque-token',
      asOf,
      maxPages: 1,
      ledger: { posted: [
        { id: 'article-1', kind: 'article', day: '2026-10-01', tiktokPostId: 'video-1' },
        { id: 'article-older', kind: 'article', day: '2026-09-01', tiktokPostId: 'video-older' },
      ] },
      fetchImpl: async () => ok({
        data: {
          videos: [{
            id: 'video-1',
            create_time: Date.parse('2026-10-01T12:00:00.000Z') / 1000,
            view_count: 100,
            like_count: 4,
            comment_count: 1,
            share_count: 2,
          }],
          has_more: true,
          cursor: 1,
        },
        error: { code: 'ok' },
      }),
    });

    expect(result).toMatchObject({
      status: 'partial-snapshots-added',
      partial: true,
      posts: [{ postId: 'video-1', metrics: { views: 100 } }],
      unmatched: [{ postId: 'video-older', reason: 'exact-id-not-in-returned-prefix' }],
      pages: 1,
    });
  });

  it('keeps matched observations from earlier pages when a later page is rate-limited', async () => {
    const asOf = new Date('2026-10-04T12:00:00.000Z');
    let requests = 0;
    const result = await collectTikTokNativeInsights({
      accessToken: 'opaque-token',
      asOf,
      ledger: { posted: [{ id: 'article-1', kind: 'article', day: '2026-10-01', tiktokPostId: 'video-1' }] },
      fetchImpl: async () => {
        requests += 1;
        if (requests === 1) return ok({
          data: {
            videos: [{
              id: 'video-1',
              create_time: Date.parse('2026-10-01T12:00:00.000Z') / 1000,
              view_count: 100,
              like_count: 4,
              comment_count: 1,
              share_count: 2,
            }],
            has_more: true,
            cursor: 1,
          },
          error: { code: 'ok' },
        });
        return { ok: false, status: 429, json: async () => ({ error: { code: 'rate_limit_exceeded' } }) };
      },
    });

    expect(result).toMatchObject({
      status: 'partial-snapshots-added',
      partial: true,
      listingStatus: 'rate-limited',
      reasonCode: 'rate_limit_exceeded',
      posts: [{ postId: 'video-1', snapshotAgeHours: 72 }],
    });
    expect(result.unmatched).toEqual([]);
  });
});
