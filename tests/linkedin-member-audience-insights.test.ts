import { describe, expect, it, vi } from 'vitest';

import {
  collectLinkedInMemberFollowerGains,
  collectLinkedInMemberAudienceSnapshot,
  LINKEDIN_MEMBER_AUDIENCE_SCOPE,
} from '../scripts/lib/linkedin-member-audience-insights.mjs';

describe('LinkedIn member follower snapshots', () => {
  it('reads the authenticated member lifetime count with the required read scope', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ elements: [{ memberFollowersCount: 1250 }], paging: { total: 1 } }),
    }));
    const asOf = new Date('2026-11-02T00:15:00.000Z');

    const result = await collectLinkedInMemberAudienceSnapshot({
      accessToken: 'opaque-test-token',
      asOf,
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.linkedin.com/rest/memberFollowersCount?q=me');
    expect(options?.headers).toMatchObject({
      Authorization: 'Bearer opaque-test-token',
      'LinkedIn-Version': expect.stringMatching(/^\d{6}$/u),
      'X-Restli-Protocol-Version': '2.0.0',
    });
    expect(result).toEqual({
      status: 'available',
      snapshotAt: asOf.toISOString(),
      scope: LINKEDIN_MEMBER_AUDIENCE_SCOPE,
      apiVersion: expect.any(String),
      snapshot: {
        channel: 'linkedin-member',
        metric: 'followers',
        value: 1250,
        snapshotAt: asOf.toISOString(),
        status: 'available',
        source: 'linkedin-member-followers-count',
      },
    });
  });

  it('keeps permission failures, rate limits, and malformed responses unavailable', async () => {
    const permission = await collectLinkedInMemberAudienceSnapshot({
      accessToken: 'opaque-test-token',
      fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({}) }),
    });
    const limited = await collectLinkedInMemberAudienceSnapshot({
      accessToken: 'opaque-test-token',
      fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({}) }),
    });
    const malformed = await collectLinkedInMemberAudienceSnapshot({
      accessToken: 'opaque-test-token',
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ elements: [{ memberFollowersCount: true }] }) }),
    });

    expect(permission).toMatchObject({ status: 'permission-unavailable', snapshot: null });
    expect(limited).toMatchObject({ status: 'rate-limited', snapshot: null });
    expect(malformed).toMatchObject({ status: 'metric-unavailable', snapshot: null });
  });

  it('does not call LinkedIn without a token', async () => {
    const fetchImpl = vi.fn();
    const result = await collectLinkedInMemberAudienceSnapshot({ fetchImpl });
    expect(result.status).toBe('credentials-missing');
    expect(result.snapshot).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('collects a complete daily follower-gain series without confusing it with lifetime followers', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        elements: [
          {
            memberFollowersCount: 4,
            dateRange: {
              start: { year: 2026, month: 11, day: 1 },
              end: { year: 2026, month: 11, day: 2 },
            },
          },
          {
            memberFollowersCount: 0,
            dateRange: {
              start: { year: 2026, month: 11, day: 2 },
              end: { year: 2026, month: 11, day: 3 },
            },
          },
        ],
        paging: { start: 0, count: 50, total: 2 },
      }),
    }));
    const asOf = new Date('2026-11-03T01:00:00.000Z');

    const result = await collectLinkedInMemberFollowerGains({
      accessToken: 'opaque-test-token',
      startDate: '2026-11-01',
      endDate: '2026-11-03',
      asOf,
      fetchImpl,
    });

    expect(result).toMatchObject({
      status: 'available',
      scope: LINKEDIN_MEMBER_AUDIENCE_SCOPE,
      expectedDays: 2,
      coverageDays: 2,
      snapshots: [
        {
          channel: 'linkedin-member',
          metric: 'followers-gained',
          date: '2026-11-01',
          value: 4,
          source: 'linkedin-member-follower-gains',
        },
        {
          channel: 'linkedin-member',
          metric: 'followers-gained',
          date: '2026-11-02',
          value: 0,
          source: 'linkedin-member-follower-gains',
        },
      ],
    });
    const [requestUrl, options] = fetchImpl.mock.calls[0];
    const parsed = new URL(String(requestUrl));
    expect(parsed.searchParams.get('q')).toBe('dateRange');
    expect(parsed.searchParams.get('start')).toBe('0');
    expect(parsed.searchParams.get('count')).toBe('50');
    expect(parsed.searchParams.get('dateRange')).toContain('start:(year:2026,month:11,day:1)');
    expect(options?.headers).toMatchObject({
      Authorization: 'Bearer opaque-test-token',
      'LinkedIn-Version': expect.stringMatching(/^\d{6}$/u),
      'X-Restli-Protocol-Version': '2.0.0',
    });
  });

  it('paginates exact date ranges and marks missing days partial rather than zero', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          elements: [{
            memberFollowersCount: 2,
            dateRange: {
              start: { year: 2026, month: 10, day: 1 },
              end: { year: 2026, month: 10, day: 2 },
            },
          }],
          paging: { start: 0, count: 1, total: 2 },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          elements: [{
            memberFollowersCount: 3,
            dateRange: {
              start: { year: 2026, month: 10, day: 3 },
              end: { year: 2026, month: 10, day: 4 },
            },
          }],
          paging: { start: 1, count: 1, total: 2 },
        }),
      });

    const result = await collectLinkedInMemberFollowerGains({
      accessToken: 'opaque-test-token',
      startDate: '2026-10-01',
      endDate: '2026-10-04',
      asOf: new Date('2026-10-05T00:00:00.000Z'),
      fetchImpl,
    });

    expect(result).toMatchObject({ status: 'partial', expectedDays: 3, coverageDays: 2, reasonCode: 'daily-gain-series-incomplete' });
    expect(result.snapshots.map((row) => row.date)).toEqual(['2026-10-01', '2026-10-03']);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(new URL(String(fetchImpl.mock.calls[1][0])).searchParams.get('start')).toBe('1');
  });
});
