import { describe, expect, it } from 'vitest';

import {
  buildSocialCopyGa4Brief,
  buildSocialCopyGa4Request,
  collectSocialCopyGa4Brief,
  SOCIAL_COPY_GA4_MINIMUM_SESSIONS,
} from '../scripts/social-copy/ga4-performance-brief.mjs';

function row(source: string, campaign: string, content: string, sessions: number, engagedSessions: number) {
  return {
    dimensionValues: [{ value: source }, { value: campaign }, { value: content }],
    metricValues: [{ value: String(sessions) }, { value: String(engagedSessions) }],
  };
}

describe('GA4 social-copy performance brief', () => {
  it('aggregates only valid attributed variants and suppresses low-volume rates', () => {
    const report = {
      complete: true,
      rows: [
        row('facebook', 'facebook_article', 'story-one--cp0123456789abcdef-article.facebook-article-one', 6, 4),
        row('facebook', 'facebook_article', 'story-two--cp0123456789abcdef-article.facebook-article-one', 5, 3),
        row('telegram', 'jobs_digest', 'job-slug--cp0123456789abcdef-job.telegram-job-two', 4, 2),
        row('facebook', 'facebook_article', 'legacy-story', 100, 80),
        row('facebook', 'facebook_article', 'wrong-slot--cp0123456789abcdef-job.facebook-job-one', 100, 90),
        row('instagram', 'facebook_article', 'story--cp0123456789abcdef-article.facebook-article-one', 100, 90),
        row('facebook', 'unknown_campaign', 'story--cp0123456789abcdef-article.facebook-article-one', 100, 90),
        row('linkedin', 'linkedin_company_article', 'story--cp0123456789abcdef-article.linkedin-company-one', 10, 6),
        row('tiktok', 'tiktok_daily_article', 'clip--cp0123456789abcdef-video.tiktok-video-one', 14, 9),
        row('tiktok', 'tiktok_daily_article', 'carousel--cp0123456789abcdef-article.tiktok-article-one', 12, 7),
      ],
    };

    const brief = buildSocialCopyGa4Brief(report, {
      startDate: '2026-10-01',
      endDate: '2026-10-30',
    });
    expect(brief).toMatchObject({
      source: 'ga4-social-copy-attribution',
      available: true,
      minimumSessions: SOCIAL_COPY_GA4_MINIMUM_SESSIONS,
      acceptedRows: 6,
    });
    expect(brief.variants).toEqual([
      {
        channel: 'facebook',
        kind: 'article',
        copySlot: 'article',
        packId: '0123456789abcdef',
        templateId: 'facebook-article-one',
        sessions: 11,
        engagedSessions: 7,
        eligibleForDescription: true,
        siteEngagedSessionRate: 7 / 11,
      },
      {
        channel: 'linkedin',
        kind: 'article',
        copySlot: 'article',
        packId: '0123456789abcdef',
        templateId: 'linkedin-company-one',
        sessions: 10,
        engagedSessions: 6,
        eligibleForDescription: true,
        siteEngagedSessionRate: 6 / 10,
      },
      {
        channel: 'telegram',
        kind: 'job',
        copySlot: 'job',
        packId: '0123456789abcdef',
        templateId: 'telegram-job-two',
        sessions: 4,
        engagedSessions: 2,
        eligibleForDescription: false,
        siteEngagedSessionRate: null,
      },
      {
        channel: 'tiktok',
        kind: 'article',
        copySlot: 'article',
        packId: '0123456789abcdef',
        templateId: 'tiktok-article-one',
        sessions: 12,
        engagedSessions: 7,
        eligibleForDescription: true,
        siteEngagedSessionRate: 7 / 12,
      },
      {
        channel: 'tiktok',
        kind: 'article',
        copySlot: 'video',
        packId: '0123456789abcdef',
        templateId: 'tiktok-video-one',
        sessions: 14,
        engagedSessions: 9,
        eligibleForDescription: true,
        siteEngagedSessionRate: 9 / 14,
      },
    ]);
  });

  it('fails closed when the paged report is incomplete', () => {
    expect(buildSocialCopyGa4Brief({ complete: false, rows: [] })).toMatchObject({
      available: false,
      reason: 'incomplete-report',
      variants: [],
    });
  });

  it('queries only social UTM copy content and settled session metrics', () => {
    const request = buildSocialCopyGa4Request({ now: new Date('2026-11-02T12:00:00.000Z') });
    expect(request.dimensions.map(({ name }) => name)).toEqual([
      'sessionManualSource',
      'sessionManualCampaignName',
      'sessionManualAdContent',
    ]);
    expect(request.metrics.map(({ name }) => name)).toEqual(['sessions', 'engagedSessions']);
    expect(request.dateRanges[0].endDate).toBe('2026-10-31');
    expect(JSON.stringify(request.dimensionFilter)).toContain('sessionManualMedium');
    expect(JSON.stringify(request.dimensionFilter)).toContain('--cp[a-f0-9]{16}');
  });

  it('returns sanitized unavailable output when credentials or GA4 are unavailable', async () => {
    const noCredentials = await collectSocialCopyGa4Brief({ getTokenImpl: async () => null });
    expect(noCredentials).toMatchObject({ available: false, reason: 'credentials-unavailable', variants: [] });

    const failedReport = await collectSocialCopyGa4Brief({
      getTokenImpl: async () => 'opaque-token',
      runReportImpl: async () => { throw new Error('sensitive API error'); },
    });
    expect(failedReport).toMatchObject({ available: false, reason: 'report-unavailable', variants: [] });
    expect(JSON.stringify(failedReport)).not.toContain('sensitive API error');
  });
});
