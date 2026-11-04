// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { collectInstagramStoryInsights } from '../scripts/lib/instagram-story-insights.mjs';
import {
  instagramStoryInsightsExitCode,
  runInstagramStoryInsights,
} from '../scripts/instagram-story-insights.mjs';

const PUBLISHED_AT = '2026-11-03T11:30:00.000Z';
const AS_OF = new Date('2026-11-03T12:00:00.000Z');

function response(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
  };
}

function metricResponse(metric: string) {
  return response({
    data: [{
      name: metric,
      values: [{ value: metric === 'navigation'
        ? [
          { key: 'tap_forward', value: 12 },
          { key: 'tap_back', value: 3 },
          { key: 'exit', value: 2 },
          { key: 'swipe_forward', value: 1 },
        ]
        : 25 }],
    }],
  });
}

describe('Instagram Story insights collector', () => {
  it('retries transient Meta limits once with a fresh timeout and keeps the token out of the URL', async () => {
    const calls: { url: URL; options: RequestInit }[] = [];
    let viewRequests = 0;
    let activeRequests = 0;
    let maximumConcurrentRequests = 0;
    const fetchImpl = vi.fn(async (input: URL | RequestInfo, options: RequestInit = {}) => {
      const url = new URL(String(input));
      calls.push({ url, options });
      const metric = url.searchParams.get('metric') || '';
      activeRequests += 1;
      maximumConcurrentRequests = Math.max(maximumConcurrentRequests, activeRequests);
      await new Promise((resolve) => setTimeout(resolve, 0));
      activeRequests -= 1;
      if (metric === 'views' && viewRequests++ === 0) return response({ error: { code: 4 } }, 400);
      return metricResponse(metric);
    });

    const result = await collectInstagramStoryInsights({
      publications: [{ storyId: 'story-1', publishedAt: PUBLISHED_AT }],
      accessToken: 'never-print-this-token',
      asOf: AS_OF,
      fetchImpl,
      sleepImpl: async () => {},
    });

    expect(result).toMatchObject({ status: 'snapshots-added', candidates: 1, attempted: 8, requestAttempts: 9 });
    expect(fetchImpl).toHaveBeenCalledTimes(9);
    expect(calls.every(({ url }) => !url.href.includes('never-print-this-token'))).toBe(true);
    expect(calls[0]?.options.headers).toEqual({ Authorization: 'Bearer never-print-this-token' });
    const navigationCall = calls.find(({ url }) => url.searchParams.get('metric') === 'navigation');
    expect(navigationCall?.url.searchParams.get('breakdown')).toBe('story_navigation_action_type');
    const viewCalls = calls.filter(({ url }) => url.searchParams.get('metric') === 'views');
    expect(viewCalls[0]?.options.signal).not.toBe(viewCalls[1]?.options.signal);
    expect(maximumConcurrentRequests).toBe(3);
    expect(result.additions[0]).toMatchObject({
      storyId: 'story-1',
      measurementWindow: 'first-hour',
      metrics: { views: 25, reach: 25, tapsForward: 12, exits: 2 },
    });
  });

  it('does not call Meta without a token and avoids repeating a stored window', async () => {
    const fetchImpl = vi.fn();
    const missing = await collectInstagramStoryInsights({
      publications: [{ storyId: 'story-1', publishedAt: PUBLISHED_AT }],
      fetchImpl,
    });
    expect(missing).toMatchObject({ status: 'credentials-missing', candidates: 0, requestAttempts: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();

    const stored = await collectInstagramStoryInsights({
      publications: [{ storyId: 'story-1', publishedAt: PUBLISHED_AT }],
      existing: [{
        storyId: 'story-1',
        publishedAt: PUBLISHED_AT,
        snapshotAt: AS_OF.toISOString(),
        snapshotAgeHours: 0.5,
        measurementWindow: 'first-hour',
        metrics: {
          views: 25, reach: 25, totalInteractions: 25, replies: 25, shares: 25, follows: 25,
          profileVisits: 25, tapsForward: 12, tapsBack: 3, exits: 2, swipesForward: 1,
          unmappedNavigationActions: 0,
        },
        availableMetrics: ['views', 'reach', 'totalInteractions', 'replies', 'shares', 'follows', 'profileVisits', 'tapsForward', 'tapsBack', 'exits', 'swipesForward', 'unmappedNavigationActions'],
        metricStatus: {
          views: 'available', reach: 'available', totalInteractions: 'available', replies: 'available',
          shares: 'available', follows: 'available', profileVisits: 'available', tapsForward: 'available',
          tapsBack: 'available', exits: 'available', swipesForward: 'available',
          unmappedNavigationActions: 'available',
        },
      }],
      accessToken: 'token',
      asOf: AS_OF,
      fetchImpl,
    });
    expect(stored).toMatchObject({ status: 'no-ready-stories', candidates: 0, requestAttempts: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('preserves metric-unavailable states and returns the second exact-ID window', async () => {
    const result = await collectInstagramStoryInsights({
      publications: [{ storyId: 'story-2', publishedAt: '2026-11-02T13:30:00.000Z' }],
      existing: [{ storyId: 'story-2', measurementWindow: 'first-hour' }],
      accessToken: 'token',
      asOf: AS_OF,
      fetchImpl: async (input) => {
        const metric = new URL(String(input)).searchParams.get('metric') || '';
        if (metric === 'views') return metricResponse(metric);
        if (metric === 'reach') return response({ error: { code: 200 } }, 400);
        return response({ error: { code: 100 } }, 400);
      },
      sleepImpl: async () => {},
    });

    expect(result).toMatchObject({ status: 'partial-metrics', candidates: 1, retryableUnavailable: 1 });
    expect(result.additions[0]).toMatchObject({
      measurementWindow: 'near-24h',
      metrics: { views: 25, reach: null },
      metricStatus: { views: 'available', reach: 'unavailable' },
    });
    expect(result.additions[0]?.availableMetrics).toEqual(['views']);
  });

  it('keeps ambiguous object-or-permission errors unavailable instead of mislabeling them as unsupported metrics', async () => {
    const result = await collectInstagramStoryInsights({
      publications: [{ storyId: 'story-ambiguous', publishedAt: PUBLISHED_AT }],
      accessToken: 'token',
      asOf: AS_OF,
      fetchImpl: async (input) => {
        const metric = new URL(String(input)).searchParams.get('metric') || '';
        if (metric === 'views') return response({ error: { code: 100, error_subcode: 33 } }, 400);
        return metricResponse(metric);
      },
      sleepImpl: async () => {},
    });

    expect(result.additions[0]?.metricStatus.views).toBe('unavailable');
    expect(result.additions[0]?.availableMetrics).not.toContain('views');
  });

  it('marks a due Story window with no supported metrics as unavailable', async () => {
    const result = await collectInstagramStoryInsights({
      publications: [{ storyId: 'story-no-metrics', publishedAt: PUBLISHED_AT }],
      accessToken: 'token',
      asOf: AS_OF,
      fetchImpl: async () => response({ error: { code: 100, error_subcode: 33 } }, 400),
      sleepImpl: async () => {},
    });

    expect(result).toMatchObject({ status: 'metrics-unavailable', candidates: 1, attempted: 8 });
    expect(result.additions).toHaveLength(1);
    expect(result.additions[0]?.availableMetrics).toEqual([]);
  });

  it('reads Meta total_value breakdown rows for Story navigation', async () => {
    const result = await collectInstagramStoryInsights({
      publications: [{ storyId: 'story-navigation-breakdown', publishedAt: PUBLISHED_AT }],
      accessToken: 'token',
      asOf: AS_OF,
      fetchImpl: async (input) => {
        const metric = new URL(String(input)).searchParams.get('metric') || '';
        if (metric !== 'navigation') return metricResponse(metric);
        return response({
          data: [{
            name: 'navigation',
            values: [{ value: 18 }],
            total_value: {
              value: 18,
              breakdowns: [{
                dimension_keys: ['story_navigation_action_type'],
                results: [
                  { dimension_values: ['TAP_FORWARD'], value: 12 },
                  { dimension_values: ['TAP_BACK'], value: 3 },
                  { dimension_values: ['TAP_EXIT'], value: 2 },
                  { dimension_values: ['SWIPE_FORWARD'], value: 1 },
                  { dimension_values: ['TAP_REPLY'], value: 6 },
                ],
              }],
            },
          }],
        });
      },
      sleepImpl: async () => {},
    });

    expect(result.additions[0]).toMatchObject({
      metrics: {
        tapsForward: 12, tapsBack: 3, exits: 2, swipesForward: 1,
        unmappedNavigationActions: 6,
      },
      metricStatus: {
        tapsForward: 'available',
        tapsBack: 'available',
        exits: 'available',
        swipesForward: 'available',
        unmappedNavigationActions: 'available',
      },
    });
    expect(JSON.stringify(result.additions[0])).not.toContain('tap_reply');
  });

  it('keeps mapped navigation actions when a breakdown also contains a malformed row', async () => {
    const result = await collectInstagramStoryInsights({
      publications: [{ storyId: 'story-navigation-malformed-row', publishedAt: PUBLISHED_AT }],
      accessToken: 'token',
      asOf: AS_OF,
      fetchImpl: async (input) => {
        const metric = new URL(String(input)).searchParams.get('metric') || '';
        if (metric !== 'navigation') return metricResponse(metric);
        return response({
          data: [{
            name: 'navigation',
            total_value: {
              breakdowns: [{
                dimension_keys: ['story_navigation_action_type'],
                results: [
                  { dimension_values: ['TAP_FORWARD'], value: 12 },
                  { dimension_values: ['TAP_REPLY'], value: 6 },
                  null,
                ],
              }],
            },
          }],
        });
      },
      sleepImpl: async () => {},
    });

    expect(result.additions[0]).toMatchObject({
      metrics: { tapsForward: 12, unmappedNavigationActions: null },
      metricStatus: { tapsForward: 'available', unmappedNavigationActions: 'metric-unavailable' },
    });
    expect(result.additions[0]?.availableMetrics).toContain('tapsForward');
    expect(result.additions[0]?.availableMetrics).not.toContain('unmappedNavigationActions');
    expect(JSON.stringify(result.additions[0])).not.toContain('TAP_REPLY');
  });

  it('does not interpret an empty object navigation payload as zero actions', async () => {
    const result = await collectInstagramStoryInsights({
      publications: [{ storyId: 'story-navigation-empty-object', publishedAt: PUBLISHED_AT }],
      accessToken: 'token',
      asOf: AS_OF,
      fetchImpl: async (input) => {
        const metric = new URL(String(input)).searchParams.get('metric') || '';
        if (metric !== 'navigation') return metricResponse(metric);
        return response({ data: [{ name: 'navigation', values: [{ value: {} }] }] });
      },
      sleepImpl: async () => {},
    });

    expect(result.additions[0]).toMatchObject({
      metrics: { unmappedNavigationActions: null },
      metricStatus: { unmappedNavigationActions: 'metric-unavailable' },
    });
    expect(result.additions[0]?.availableMetrics).not.toContain('unmappedNavigationActions');
  });

  it('fails the scheduled job when credentials or due Story measurements are unavailable', () => {
    expect(instagramStoryInsightsExitCode({ status: 'credentials-missing' })).toBe(2);
    expect(instagramStoryInsightsExitCode({ status: 'metrics-unavailable' })).toBe(2);
    expect(instagramStoryInsightsExitCode({ status: 'partial-metrics', retryableUnavailable: 1 })).toBe(2);
    expect(instagramStoryInsightsExitCode({ status: 'partial-metrics', retryableUnavailable: 0 })).toBe(0);
    expect(instagramStoryInsightsExitCode({ status: 'no-ready-stories', persistedStatus: 'metrics-unavailable' })).toBe(2);
    expect(instagramStoryInsightsExitCode({ status: 'no-ready-stories', persistedStatus: 'credentials-missing' })).toBe(2);
    expect(instagramStoryInsightsExitCode({ status: 'no-ready-stories' })).toBe(0);
  });

  it('retries only transiently unavailable metrics and preserves earlier Story measurements', async () => {
    const existing = [{
      storyId: 'story-partial',
      publishedAt: PUBLISHED_AT,
      snapshotAt: '2026-11-03T11:45:00.000Z',
      snapshotAgeHours: 0.25,
      measurementWindow: 'first-hour',
      metrics: {
        views: 25, reach: null, totalInteractions: null, replies: null, shares: null, follows: null,
        profileVisits: null, tapsForward: null, tapsBack: null, exits: null, swipesForward: null,
      },
      availableMetrics: ['views'],
      metricStatus: {
        views: 'available', reach: 'unavailable', totalInteractions: 'metric-unavailable', replies: 'metric-unavailable',
        shares: 'metric-unavailable', follows: 'metric-unavailable', profileVisits: 'metric-unavailable',
        tapsForward: 'metric-unavailable', tapsBack: 'metric-unavailable', exits: 'metric-unavailable', swipesForward: 'metric-unavailable',
      },
    }];
    const calls: string[] = [];
    const failedRetry = await collectInstagramStoryInsights({
      publications: [{ storyId: 'story-partial', publishedAt: PUBLISHED_AT }],
      existing,
      accessToken: 'token',
      asOf: AS_OF,
      fetchImpl: async (input) => {
        const metric = new URL(String(input)).searchParams.get('metric') || '';
        calls.push(metric);
        return response({ error: { code: 100, error_subcode: 33 } }, 400);
      },
      sleepImpl: async () => {},
    });

    expect(calls).toEqual(['reach', 'navigation']);
    expect(failedRetry).toMatchObject({ status: 'partial-metrics', attempted: 2, retryableUnavailable: 6 });
    expect(failedRetry.additions[0]).toMatchObject({ metrics: { views: 25, reach: null } });

    const recovered = await collectInstagramStoryInsights({
      publications: [{ storyId: 'story-partial', publishedAt: PUBLISHED_AT }],
      existing: failedRetry.additions,
      accessToken: 'token',
      asOf: new Date(AS_OF.getTime() + 15 * 60 * 1000),
      fetchImpl: async (input) => {
        const metric = new URL(String(input)).searchParams.get('metric') || '';
        calls.push(metric);
        return metricResponse(metric);
      },
      sleepImpl: async () => {},
    });

    expect(calls).toEqual(['reach', 'navigation', 'reach', 'navigation']);
    expect(recovered).toMatchObject({ status: 'partial-metrics', attempted: 2, retryableUnavailable: 0 });
    expect(recovered.additions[0]).toMatchObject({
      metrics: { views: 25, reach: 25, unmappedNavigationActions: 0 },
    });
    expect(recovered.additions[0]?.availableMetrics).toContain('unmappedNavigationActions');
  });

  it('keeps rounded ages below each exclusive measurement-window boundary', async () => {
    const result = await collectInstagramStoryInsights({
      publications: [
        { storyId: 'story-near-first-hour', publishedAt: '2026-11-03T11:00:00.100Z' },
        { storyId: 'story-near-24h', publishedAt: '2026-11-02T12:00:00.100Z' },
      ],
      existing: [{ storyId: 'story-near-24h', measurementWindow: 'first-hour' }],
      accessToken: 'token',
      asOf: new Date('2026-11-03T11:59:59.900Z'),
      fetchImpl: async (input) => metricResponse(new URL(String(input)).searchParams.get('metric') || ''),
      sleepImpl: async () => {},
    });

    expect(result.additions).toHaveLength(2);
    expect(result.additions.find((row) => row.storyId === 'story-near-first-hour')?.snapshotAgeHours).toBeLessThan(1);
    expect(result.additions.find((row) => row.storyId === 'story-near-24h')?.snapshotAgeHours).toBeLessThan(24);
  });

  it('persists missing-token health without loading metric rows or losing the previous success timestamp', async () => {
    const existing = {
      sources: {
        instagramStoryInsights: {
          status: 'snapshots-added',
          lastSuccessAt: '2026-11-03T10:00:00.000Z',
        },
      },
      instagramStoryPublications: [],
      instagramStorySnapshots: [],
      posts: [],
    };
    const getDb = vi.fn();
    const loadInsights = vi.fn();
    let updated: any;
    const updateInsights = vi.fn(async (_db: unknown, update: (current: any) => any) => {
      updated = update(existing);
      return { changed: true };
    });
    const result = await runInstagramStoryInsights({
      env: {},
      db: {},
      asOf: AS_OF,
      getDb,
      loadInsights,
      updateInsights,
    });

    expect(result).toMatchObject({
      status: 'credentials-missing',
      persistedStatus: 'credentials-missing',
      persisted: true,
      requestAttempts: 0,
    });
    expect(getDb).not.toHaveBeenCalled();
    expect(loadInsights).not.toHaveBeenCalled();
    expect(updateInsights).toHaveBeenCalledOnce();
    expect(updated.sources.instagramStoryInsights).toMatchObject({
      status: 'credentials-missing',
      lastAttemptStatus: 'credentials-missing',
      lastAttemptAt: AS_OF.toISOString(),
      lastSuccessAt: '2026-11-03T10:00:00.000Z',
    });
  });

  it('uses the existing Page token when the dedicated Instagram Insights token is absent', async () => {
    const authorizationHeaders: string[] = [];
    const result = await runInstagramStoryInsights({
      env: { FB_PAGE_ACCESS_TOKEN: 'page-token-from-rc' },
      db: {},
      asOf: AS_OF,
      loadInsights: async () => ({
        posts: [],
        instagramStoryPublications: [{ storyId: 'story-private-id', publishedAt: PUBLISHED_AT }],
        instagramStorySnapshots: [],
        sources: {},
      }),
      fetchImpl: async (input, options = {}) => {
        authorizationHeaders.push(String((options.headers as Record<string, string>)?.Authorization || ''));
        return metricResponse(new URL(String(input)).searchParams.get('metric') || '');
      },
      updateInsights: async () => ({ changed: true }),
    });

    expect(result).toMatchObject({ status: 'snapshots-added', snapshots: 1, persisted: true });
    expect(authorizationHeaders).toHaveLength(8);
    expect(authorizationHeaders.every((value) => value === 'Bearer page-token-from-rc')).toBe(true);
    expect(JSON.stringify(result)).not.toContain('page-token-from-rc');
  });

  it('retains an unresolved due-window error across no-ready runs until a later due window succeeds', async () => {
    let privateState: any = {
      schemaVersion: 1,
      posts: [],
      sources: {},
      instagramStoryPublications: [{ storyId: 'story-failed', publishedAt: PUBLISHED_AT }],
      instagramStorySnapshots: [],
    };
    const loadInsights = vi.fn(async () => privateState);
    const updateInsights = vi.fn(async (_db: unknown, update: (current: any) => any) => {
      privateState = update(privateState);
      return { changed: true };
    });
    const failed = await runInstagramStoryInsights({
      env: { INSTAGRAM_ACCESS_TOKEN: 'opaque-token' },
      db: {},
      asOf: AS_OF,
      loadInsights,
      updateInsights,
      fetchImpl: async () => response({ error: { code: 4 } }, 400),
      sleepImpl: async () => {},
    });
    expect(failed).toMatchObject({
      status: 'metrics-unavailable',
      persistedStatus: 'metrics-unavailable',
    });
    expect(instagramStoryInsightsExitCode(failed)).toBe(2);

    const noReady = await runInstagramStoryInsights({
      env: { INSTAGRAM_ACCESS_TOKEN: 'opaque-token' },
      db: {},
      asOf: new Date('2026-11-03T14:00:00.000Z'),
      loadInsights,
      updateInsights,
      fetchImpl: vi.fn(),
      sleepImpl: async () => {},
    });
    expect(noReady).toMatchObject({
      status: 'no-ready-stories',
      persistedStatus: 'metrics-unavailable',
    });
    expect(privateState.sources.instagramStoryInsights).toMatchObject({
      status: 'metrics-unavailable',
      lastAttemptStatus: 'no-ready-stories',
    });
    expect(instagramStoryInsightsExitCode(noReady)).toBe(2);

    privateState.instagramStoryPublications.push({
      storyId: 'story-recovered',
      publishedAt: '2026-11-03T14:00:00.000Z',
    });
    const recovered = await runInstagramStoryInsights({
      env: { INSTAGRAM_ACCESS_TOKEN: 'opaque-token' },
      db: {},
      asOf: new Date('2026-11-03T14:30:00.000Z'),
      loadInsights,
      updateInsights,
      fetchImpl: async (input) => metricResponse(new URL(String(input)).searchParams.get('metric') || ''),
      sleepImpl: async () => {},
    });
    expect(recovered).toMatchObject({
      status: 'snapshots-added',
      persistedStatus: 'snapshots-added',
    });
    expect(privateState.sources.instagramStoryInsights.status).toBe('snapshots-added');
    expect(instagramStoryInsightsExitCode(recovered)).toBe(0);
  });

  it('persists only aggregate-safe metadata with exact Story IDs held in the private store', async () => {
    const existing = {
      posts: [],
      instagramStoryPublications: [{ storyId: 'story-private-id', publishedAt: PUBLISHED_AT }],
      instagramStorySnapshots: [],
      sources: {},
    };
    let updated: any;
    const result = await runInstagramStoryInsights({
      env: { INSTAGRAM_ACCESS_TOKEN: 'opaque-token' },
      db: {},
      asOf: AS_OF,
      loadInsights: async () => existing,
      fetchImpl: async (input) => metricResponse(new URL(String(input)).searchParams.get('metric') || ''),
      updateInsights: async (_db, update) => {
        updated = update(existing);
        return { changed: true };
      },
    });

    expect(result).toMatchObject({ status: 'snapshots-added', snapshots: 1, persisted: true });
    expect(updated.instagramStorySnapshots).toHaveLength(1);
    expect(updated.instagramStorySnapshots[0].storyId).toBe('story-private-id');
    expect(JSON.stringify(result)).not.toContain('story-private-id');
  });
});
