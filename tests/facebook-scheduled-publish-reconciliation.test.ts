import { describe, expect, it, vi } from 'vitest';
import { reconcileFacebookScheduledPosts } from '../scripts/lib/facebook-scheduled-publish-reconciliation.mjs';

const makeResponse = (data: unknown, ok = true, status = ok ? 200 : 500) => ({
  ok,
  status,
  json: async () => data,
});

describe('Facebook scheduled-post reconciliation', () => {
  const now = new Date('2026-11-03T08:00:00.000Z');
  const makeRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'job-1',
    fbPostId: '123_456',
    scheduledFor: '2026-11-02T22:55:00.000Z',
    ts: '2026-11-02T08:00:00.000Z',
    ...overrides,
  });

  it('persists Meta created_time and moves the shared reservation to the actual Zurich publish day', async () => {
    const rows = [makeRow()];
    const saveRows = vi.fn(async () => {});
    const markPublished = vi.fn(async () => true);
    const refreshReservation = vi.fn(async () => true);
    const fetchImpl = vi.fn(async (input: URL) => {
      expect(input.pathname).toBe('/v26.0/123_456');
      expect(input.searchParams.get('fields')).toBe('id,is_published,created_time,scheduled_publish_time');
      return makeResponse({
        id: '123_456',
        is_published: true,
        created_time: '2026-11-02T23:04:12+0000',
      });
    });

    const result = await reconcileFacebookScheduledPosts({
      rows,
      pageId: 'page-1',
      token: 'test-token',
      fetchImpl,
      now,
      saveRows,
      markPublished,
      refreshReservation,
    });

    expect(result).toEqual({ checked: 1, reconciled: 1, pending: 0, uncertain: 0 });
    expect(rows[0].actualPublishedAt).toBe('2026-11-02T23:04:12.000Z');
    expect(saveRows).toHaveBeenCalledWith(rows);
    expect(markPublished).toHaveBeenCalledWith(expect.objectContaining({
      platform: 'facebook',
      accountId: 'page-1',
      key: 'facebook:job:job-1',
      publishAt: '2026-11-02T23:04:12.000Z',
      publishedAt: '2026-11-02T23:04:12.000Z',
    }));
    expect(refreshReservation).not.toHaveBeenCalled();
  });

  it('keeps an unpublished schedule reserved through today and tomorrow', async () => {
    const rows = [makeRow()];
    const refreshReservation = vi.fn(async () => true);

    const result = await reconcileFacebookScheduledPosts({
      rows,
      pageId: 'page-1',
      token: 'test-token',
      fetchImpl: async () => makeResponse({ id: '123_456', is_published: false }),
      now,
      refreshReservation,
      markPublished: vi.fn(),
      saveRows: vi.fn(),
    });

    expect(result).toEqual({ checked: 1, reconciled: 0, pending: 1, uncertain: 0 });
    expect(refreshReservation).toHaveBeenCalledWith(expect.objectContaining({
      platform: 'facebook',
      accountId: 'page-1',
      key: 'facebook:job:job-1',
      publishAt: now,
      now,
      unpublishedConfirmed: true,
    }));
    expect(rows[0]).not.toHaveProperty('actualPublishedAt');
  });

  it('fails closed on a mismatched native ID and refreshes the unresolved hold', async () => {
    const refreshReservation = vi.fn(async () => true);
    const markPublished = vi.fn();

    const result = await reconcileFacebookScheduledPosts({
      rows: [makeRow()],
      pageId: 'page-1',
      token: 'test-token',
      fetchImpl: async () => makeResponse({ id: 'unexpected-id', is_published: true, created_time: now.toISOString() }),
      now,
      refreshReservation,
      markPublished,
      saveRows: vi.fn(),
    });

    expect(result.uncertain).toBe(1);
    expect(markPublished).not.toHaveBeenCalled();
    expect(refreshReservation).toHaveBeenCalledOnce();
  });

  it('does not query future schedules or already reconciled posts', async () => {
    const fetchImpl = vi.fn();
    const result = await reconcileFacebookScheduledPosts({
      rows: [
        makeRow({ scheduledFor: '2026-11-04T08:00:00.000Z' }),
        makeRow({ id: 'job-2', actualPublishedAt: now.toISOString() }),
      ],
      pageId: 'page-1',
      token: 'test-token',
      fetchImpl,
      now,
    });

    expect(result).toEqual({ checked: 0, reconciled: 0, pending: 0, uncertain: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
