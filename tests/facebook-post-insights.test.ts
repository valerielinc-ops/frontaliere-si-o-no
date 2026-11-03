import { describe, expect, it, vi } from 'vitest';
import { collectFacebookPostInsights } from '../scripts/lib/facebook-post-insights.mjs';

const NOW = new Date('2026-11-03T12:00:00.000Z');
const PAGE_ID = '123456';
const POST_ID = `${PAGE_ID}_789`;
const TOKEN = 'never-return-this-token';
const COPY = {
  copyMode: 'codex',
  copySlot: 'job',
  copyPackId: 'pack-2026-11',
  copyTemplateId: 'job-hook-a',
  copyAssignmentMode: 'balanced',
};

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function makeFetch({ createdTime = '2026-10-31T12:00:00.000Z', published = true } = {}) {
  const calls = [];
  const fetchImpl = vi.fn(async (rawUrl, options = {}) => {
    const url = new URL(rawUrl);
    calls.push({ url, options });
    if (url.searchParams.has('fields')) {
      return jsonResponse({ id: POST_ID, is_published: published, created_time: createdTime });
    }
    return jsonResponse({ data: [
      { name: 'post_media_view', values: [{ value: '140' }] },
      { name: 'post_total_media_view_unique', values: [{ value: 100 }] },
      { name: 'post_reactions_by_type_total', values: [{ value: { like: 4, love: 2 } }] },
      { name: 'post_clicks', values: [{ value: 3 }] },
    ] });
  });
  return { fetchImpl, calls };
}

describe('Facebook exact-post Insights', () => {
  it('uses Meta created_time to select and timestamp the fixed-age sample', async () => {
    const { fetchImpl, calls } = makeFetch();
    const scheduledFor = new Date(NOW.getTime() - 82 * 60 * 60 * 1000).toISOString();
    const result = await collectFacebookPostInsights({
      ledger: [{ postId: POST_ID, scheduledFor, ...COPY }],
      eligibilityStatus: 'post-insights-exact-id-probe-required',
      pageId: PAGE_ID,
      accessToken: TOKEN,
      asOf: NOW,
      fetchImpl,
    });

    expect(result.status).toBe('available');
    expect(result.posts).toHaveLength(1);
    expect(result.posts[0]).toMatchObject({
      postId: POST_ID,
      publishedAt: '2026-10-31T12:00:00.000Z',
      publicationTimeBasis: 'facebook-created-time',
      snapshotAgeHours: 72,
      windowHours: 72,
      measurementWindow: 'first-72h-after-facebook-created-time',
      metrics: { mediaViews: 140, uniqueViewers: 100, reactions: 6, clicks: 3 },
      copyAttributionStatus: 'exact',
    });
    expect(calls).toHaveLength(2);
    expect(calls[0].url.searchParams.get('fields')).toBe('id,is_published,created_time');
    expect(calls[1].url.pathname).toContain(`/${POST_ID}/insights`);
    expect(calls.every(({ options }) => options.headers.Authorization === `Bearer ${TOKEN}`)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it('does not query metrics when the exact publication age is outside the accepted window', async () => {
    const { fetchImpl, calls } = makeFetch({ createdTime: '2026-11-01T00:00:00.000Z' });
    const result = await collectFacebookPostInsights({
      ledger: [{ postId: POST_ID, scheduledFor: '2026-10-31T12:00:00.000Z', ...COPY }],
      eligibilityStatus: 'post-insights-exact-id-probe-required',
      pageId: PAGE_ID,
      accessToken: TOKEN,
      asOf: NOW,
      fetchImpl,
    });

    expect(result.status).toBe('no-posts-in-window');
    expect(result.posts).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('fails closed below the Page Insights eligibility threshold', async () => {
    const fetchImpl = vi.fn();
    const result = await collectFacebookPostInsights({
      ledger: [{ postId: POST_ID, scheduledFor: '2026-10-31T12:00:00.000Z', ...COPY }],
      eligibilityStatus: 'post-insights-below-100-page-likes',
      pageId: PAGE_ID,
      accessToken: TOKEN,
      asOf: NOW,
      fetchImpl,
    });

    expect(result).toMatchObject({ status: 'post-insights-below-100-page-likes', posts: [], attempted: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
