import { describe, expect, it, vi } from 'vitest';

import {
  buildLinkedInMemberAnalyticsUrl,
  collectLinkedInMemberInsights,
  LINKEDIN_MEMBER_ANALYTICS_METRICS,
} from '../scripts/lib/linkedin-member-insights.mjs';

describe('LinkedIn member post analytics', () => {
  it('uses the metric names supported by the current Member Post Statistics API', () => {
    expect(LINKEDIN_MEMBER_ANALYTICS_METRICS).toEqual([
      'IMPRESSION', 'MEMBERS_REACHED', 'REACTION', 'COMMENT', 'RESHARE', 'LINK_CLICKS',
      'POST_SAVE', 'POST_SEND', 'FOLLOWER_GAINED_FROM_CONTENT', 'PROFILE_VIEW_FROM_CONTENT',
    ]);
  });

  it('builds the versioned Rest.li entity query for an exact share URN and calendar window', () => {
    const url = new URL(buildLinkedInMemberAnalyticsUrl(
      'urn:li:share:123',
      'IMPRESSION',
      Date.parse('2026-10-01T00:00:00.000Z'),
      Date.parse('2026-10-08T00:00:00.000Z'),
    ));

    expect(url.pathname).toBe('/rest/memberCreatorPostAnalytics');
    expect(url.searchParams.get('q')).toBe('entity');
    expect(url.search).toContain('&entity=(share:urn%3Ali%3Ashare%3A123)&');
    expect(url.searchParams.get('queryType')).toBe('IMPRESSION');
    expect(url.search).toContain('&dateRange=(start:(day:1,month:10,year:2026),end:(day:8,month:10,year:2026))');
    expect(url.search).not.toContain('%253A');
  });

  it('fetches metrics only for exact ledger URNs after the first seven UTC days', async () => {
    const publishedAt = '2026-10-01T16:45:00.000Z';
    const asOf = new Date('2026-10-10T00:00:00.000Z');
    const requests: string[] = [];
    const result = await collectLinkedInMemberInsights({
      accessToken: 'opaque-token',
      retentionPolicyApproved: true,
      asOf,
      delayMs: 0,
      ledger: { posted: [{
        id: 'article-1',
        kind: 'article',
        day: '2026-10-01',
        ts: publishedAt,
        linkedinPostId: 'urn:li:share:123',
        copyMode: 'codex',
        copySlot: 'article',
        copyPackId: '0123456789abcdef',
        copyTemplateId: 'clear-question',
        copyAssignmentMode: 'firebase-balanced',
        copyAngleId: 'article-practical-question',
        copyPillarId: 'strumenti-utili',
        copyAngleIntent: 'both',
      }] },
      fetchImpl: async (url: string) => {
        const parsed = new URL(url);
        requests.push(url);
        const metricType = parsed.searchParams.get('queryType') || '';
        return {
          ok: true,
          status: 200,
          json: async () => ({ elements: [{
            count: metricType === 'IMPRESSION' ? 101 : 2,
            metricType,
            targetEntity: { share: 'urn:li:share:123' },
          }] }),
        };
      },
    });

    expect(requests).toHaveLength(LINKEDIN_MEMBER_ANALYTICS_METRICS.length);
    expect(result).toMatchObject({
      status: 'snapshots-added',
      posts: [{
        postId: 'urn:li:share:123',
        sourceIds: ['article-1'],
        publishedAt,
        windowStartDay: '2026-10-01',
        windowEndDayExclusive: '2026-10-08',
        metrics: { impression: 101, members_reached: 2, link_clicks: 2 },
        metricStatus: { impression: 'available', post_save: 'available' },
        copy: { copyAngleId: 'article-practical-question', copyPillarId: 'strumenti-utili', copyAngleIntent: 'both' },
      }],
    });
  });

  it('fails closed before querying member post metrics without storage approval', async () => {
    const fetchImpl = vi.fn();
    const result = await collectLinkedInMemberInsights({
      accessToken: 'opaque-token',
      ledger: { posted: [{ ts: '2026-10-01T00:00:00Z', linkedinPostId: 'urn:li:share:123' }] },
      fetchImpl,
    });

    expect(result.status).toBe('policy-review-required');
    expect(result.posts).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('keeps missing credentials, read permission, and missing metrics distinct from zero', async () => {
    const missing = await collectLinkedInMemberInsights({ ledger: { posted: [] } });
    expect(missing.status).toBe('policy-review-required');

    const missingCredentials = await collectLinkedInMemberInsights({
      retentionPolicyApproved: true,
      ledger: { posted: [] },
    });
    expect(missingCredentials.status).toBe('credentials-missing');

    const noPermission = await collectLinkedInMemberInsights({
      retentionPolicyApproved: true,
      accessToken: 'opaque-token',
      asOf: new Date('2026-10-10T00:00:00.000Z'),
      delayMs: 0,
      ledger: { posted: [{ ts: '2026-10-01T00:00:00Z', linkedinPostId: 'urn:li:share:123' }] },
      fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({}) }),
    });
    expect(noPermission.status).toBe('permission-unavailable');

    const noMetrics = await collectLinkedInMemberInsights({
      retentionPolicyApproved: true,
      accessToken: 'opaque-token',
      asOf: new Date('2026-10-10T00:00:00.000Z'),
      delayMs: 0,
      ledger: { posted: [{ ts: '2026-10-01T00:00:00Z', linkedinPostId: 'urn:li:share:123' }] },
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ elements: [] }) }),
    });
    expect(noMetrics.posts[0].metrics.impression).toBeNull();
    expect(noMetrics.posts[0].metricStatus.impression).toBe('unavailable');
  });

  it('rejects analytics elements without the exact target post URN', async () => {
    const result = await collectLinkedInMemberInsights({
      accessToken: 'opaque-token',
      retentionPolicyApproved: true,
      asOf: new Date('2026-10-10T00:00:00.000Z'),
      delayMs: 0,
      ledger: { posted: [{ ts: '2026-10-01T00:00:00Z', linkedinPostId: 'urn:li:share:123' }] },
      fetchImpl: async (url: string) => {
        const metricType = new URL(url).searchParams.get('queryType') || '';
        return {
          ok: true,
          status: 200,
          json: async () => ({ elements: [{ count: 99, metricType }] }),
        };
      },
    });

    expect(result.posts[0].metrics.impression).toBeNull();
    expect(result.posts[0].metricStatus.impression).toBe('unavailable');
    expect(result.posts[0].availableMetrics).toEqual([]);
  });

  it('rejects boolean metric values instead of coercing them to counts', async () => {
    const result = await collectLinkedInMemberInsights({
      accessToken: 'opaque-token',
      retentionPolicyApproved: true,
      asOf: new Date('2026-10-10T00:00:00.000Z'),
      delayMs: 0,
      ledger: { posted: [{ ts: '2026-10-01T00:00:00Z', linkedinPostId: 'urn:li:share:123' }] },
      fetchImpl: async (url: string) => {
        const metricType = new URL(url).searchParams.get('queryType') || '';
        return {
          ok: true,
          status: 200,
          json: async () => ({ elements: [{
            count: metricType === 'IMPRESSION' ? true : metricType === 'MEMBERS_REACHED' ? false : 2,
            metricType,
            targetEntity: { share: 'urn:li:share:123' },
          }] }),
        };
      },
    });

    expect(result.posts[0].metrics.impression).toBeNull();
    expect(result.posts[0].metrics.members_reached).toBeNull();
    expect(result.posts[0].metricStatus.impression).toBe('unavailable');
    expect(result.posts[0].metricStatus.members_reached).toBe('unavailable');
  });
});
