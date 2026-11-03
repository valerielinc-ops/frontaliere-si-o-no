import { describe, expect, it } from 'vitest';

import {
  buildSocialCopyGa4Brief,
  buildSocialCopyGa4ActionBrief,
  buildSocialCopyGa4ActionRateRequest,
  buildSocialCopyGa4ActionRequest,
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
        row('facebook', 'facebook_article', 'story-three--cp0123456789abcdef-article.facebook-article-one.f', 3, 1),
        row('facebook', 'facebook_article', 'story-four--cp0123456789abcdef-article.facebook-article-one.f.abcdef01', 3, 2),
        row('facebook', 'facebook_article', 'story-five--cp0123456789abcdef-article.facebook-article-one.f.abcdef02', 4, 2),
        row('telegram', 'jobs_digest', 'job-slug--cp0123456789abcdef-job.telegram-job-two', 4, 2),
        row('facebook', 'facebook_article', 'legacy-story', 100, 80),
        row('facebook', 'facebook_article', 'wrong-slot--cp0123456789abcdef-job.facebook-job-one', 100, 90),
        row('instagram', 'facebook_article', 'story--cp0123456789abcdef-article.facebook-article-one', 100, 90),
        row('facebook', 'unknown_campaign', 'story--cp0123456789abcdef-article.facebook-article-one', 100, 90),
        row('linkedin', 'linkedin_company_article', 'story--cp0123456789abcdef-article.linkedin-company-one', 10, 6),
        row('tiktok', 'tiktok_daily_article', 'clip--cp0123456789abcdef-video.tiktok-video-one.b.1a2b3c4d', 14, 9),
        row('tiktok', 'tiktok_daily_article', 'carousel--cp0123456789abcdef-article.tiktok-article-one', 12, 7),
        row('reddit', 'reddit_job', 'job-id--cp0123456789abcdef-job.reddit-job-one', 11, 6),
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
      acceptedRows: 10,
    });
    expect(brief.variants).toEqual([
      {
        channel: 'facebook',
        kind: 'article',
        copySlot: 'article',
        packId: '0123456789abcdef',
        templateId: 'facebook-article-one',
        assignmentMode: 'deterministic-fallback',
        experimentIdHash: null,
        sessions: 3,
        engagedSessions: 1,
        eligibleForDescription: false,
        siteEngagedSessionRate: null,
      },
      {
        channel: 'facebook',
        kind: 'article',
        copySlot: 'article',
        packId: '0123456789abcdef',
        templateId: 'facebook-article-one',
        assignmentMode: 'deterministic-fallback',
        experimentIdHash: 'abcdef01',
        sessions: 3,
        engagedSessions: 2,
        eligibleForDescription: false,
        siteEngagedSessionRate: null,
      },
      {
        channel: 'facebook',
        kind: 'article',
        copySlot: 'article',
        packId: '0123456789abcdef',
        templateId: 'facebook-article-one',
        assignmentMode: 'deterministic-fallback',
        experimentIdHash: 'abcdef02',
        sessions: 4,
        engagedSessions: 2,
        eligibleForDescription: false,
        siteEngagedSessionRate: null,
      },
      {
        channel: 'facebook',
        kind: 'article',
        copySlot: 'article',
        packId: '0123456789abcdef',
        templateId: 'facebook-article-one',
        assignmentMode: 'legacy-unmarked',
        experimentIdHash: null,
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
        assignmentMode: 'legacy-unmarked',
        experimentIdHash: null,
        sessions: 10,
        engagedSessions: 6,
        eligibleForDescription: true,
        siteEngagedSessionRate: 6 / 10,
      },
      {
        channel: 'reddit',
        kind: 'job',
        copySlot: 'job',
        packId: '0123456789abcdef',
        templateId: 'reddit-job-one',
        assignmentMode: 'legacy-unmarked',
        experimentIdHash: null,
        sessions: 11,
        engagedSessions: 6,
        eligibleForDescription: true,
        siteEngagedSessionRate: 6 / 11,
      },
      {
        channel: 'telegram',
        kind: 'job',
        copySlot: 'job',
        packId: '0123456789abcdef',
        templateId: 'telegram-job-two',
        assignmentMode: 'legacy-unmarked',
        experimentIdHash: null,
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
        assignmentMode: 'legacy-unmarked',
        experimentIdHash: null,
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
        assignmentMode: 'firebase-balanced',
        experimentIdHash: '1a2b3c4d',
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

  it('keeps editorial angle IDs in exact GA4 session and site-action cohorts', () => {
    const content = 'story--cp0123456789abcdef-article.facebook-article-one.aarticle-practical-question.d';
    const brief = buildSocialCopyGa4Brief({ complete: true, rows: [row('facebook', 'facebook_article', content, 12, 6)] });
    expect(brief.variants[0]).toMatchObject({
      angleId: 'article-practical-question',
      assignmentMode: 'deterministic',
      sessions: 12,
    });

    const actions = buildSocialCopyGa4ActionBrief({
      complete: true,
      rows: [{
        dimensionValues: [
          { value: 'facebook' },
          { value: 'facebook_article' },
          { value: content },
          { value: 'job_apply_handoff' },
        ],
        metricValues: [{ value: '12' }],
      }],
    });
    expect(actions.events[0]).toMatchObject({ angleId: 'article-practical-question', eventCount: 12 });
  });

  it('keeps absent GA4 metric cells unavailable instead of turning them into zero', () => {
    const brief = buildSocialCopyGa4Brief({
      complete: true,
      rows: [{
        dimensionValues: [
          { value: 'facebook' },
          { value: 'facebook_article' },
          { value: 'story--cp0123456789abcdef-article.facebook-article-one' },
        ],
        metricValues: [{ value: '12' }, {}],
      }],
    });
    expect(brief.variants[0]).toMatchObject({
      sessions: 12,
      engagedSessions: null,
      eligibleForDescription: false,
      siteEngagedSessionRate: null,
    });
  });

  it('reports allowlisted site actions as event counts, not unique people or completed applications', () => {
    const actions = buildSocialCopyGa4ActionBrief({
      complete: true,
      rows: [{
        dimensionValues: [
          { value: 'facebook' },
          { value: 'facebook_article' },
          { value: 'story--cp0123456789abcdef-article.facebook-article-one' },
          { value: 'job_apply_handoff' },
        ],
        metricValues: [{ value: '12' }],
      }],
    });
    expect(actions.events[0]).toMatchObject({
      eventName: 'job_apply_handoff',
      eventCount: 12,
      eligibleForDescription: true,
      eventMeaning: expect.stringContaining('not a completed application'),
    });

    const request = buildSocialCopyGa4ActionRequest({ now: new Date('2026-11-02T12:00:00.000Z') });
    expect(request.dimensions.map(({ name }) => name)).toContain('eventName');
    expect(request.metrics.map(({ name }) => name)).toEqual(['eventCount']);
    expect(JSON.stringify(request.dimensionFilter)).toContain('checkout_completed');
  });

  it('measures qualified job-detail sessions as a descriptive tagged event with bounded claims', () => {
    const actions = buildSocialCopyGa4ActionBrief({
      complete: true,
      rows: [{
        dimensionValues: [
          { value: 'facebook' },
          { value: 'facebook_job' },
          { value: 'job--cp0123456789abcdef-job.facebook-job-one' },
          { value: 'job_qualified_session' },
        ],
        metricValues: [{ value: '9' }],
      }],
    });
    expect(actions.events[0]).toMatchObject({
      eventName: 'job_qualified_session',
      eventCount: 9,
      keyEventStatus: 'not-listed-in-repository-key-event-contract; live-property-state-not-queried',
      strongestClaim: expect.stringContaining('not a unique person'),
      eligibleForDescription: false,
    });
    expect(JSON.stringify(buildSocialCopyGa4ActionRequest({ now: new Date('2026-11-02T12:00:00.000Z') }).dimensionFilter))
      .toContain('job_qualified_session');
    expect(buildSocialCopyGa4ActionRateRequest({ eventNames: ['job_qualified_session'] })).toBeNull();
    expect(buildSocialCopyGa4ActionRateRequest({ eventNames: ['job_qualified_session', 'job_apply_handoff'] })?.metrics)
      .toEqual([{ name: 'sessions' }, { name: 'sessionKeyEventRate:job_apply_handoff' }]);
  });

  it('keeps qualified job-detail event counts but excludes the event from registered key-event rates', async () => {
    let rateMetricNames: string[] = [];
    const brief = await collectSocialCopyGa4Brief({
      now: new Date('2026-11-02T12:00:00.000Z'),
      propertyId: '123456',
      getTokenImpl: async () => 'opaque-token',
      listKeyEventMetricsImpl: async () => new Set([
        'sessionKeyEventRate:job_qualified_session',
        'sessionKeyEventRate:job_apply_handoff',
      ]),
      runReportImpl: async ({ body }) => {
        if (body.dimensions.some(({ name }: { name: string }) => name === 'eventName')) {
          return {
            complete: true,
            rows: [{
              dimensionValues: [
                { value: 'facebook' },
                { value: 'facebook_job' },
                { value: 'job--cp0123456789abcdef-job.facebook-job-one' },
                { value: 'job_qualified_session' },
              ],
              metricValues: [{ value: '12' }],
            }],
          };
        }
        if (body.metrics.some(({ name }: { name: string }) => name.startsWith('sessionKeyEventRate:'))) {
          rateMetricNames = body.metrics.map(({ name }: { name: string }) => name);
        }
        return { complete: true, rows: [] };
      },
    });

    expect(rateMetricNames).toEqual(['sessions', 'sessionKeyEventRate:job_apply_handoff']);
    expect(brief.siteActions).toEqual([expect.objectContaining({
      eventName: 'job_qualified_session',
      eventCount: 12,
      liveKeyEventRegistration: 'registered',
      sessionKeyEventRate: null,
      eligibleForSessionKeyEventRateDescription: false,
      sessionKeyEventRateStatus: 'excluded-by-event-contract',
    })]);
  });

  it('does not treat a missing GA4 event count as no actions', () => {
    const actions = buildSocialCopyGa4ActionBrief({
      complete: true,
      rows: [{
        dimensionValues: [
          { value: 'facebook' },
          { value: 'facebook_article' },
          { value: 'story--cp0123456789abcdef-article.facebook-article-one' },
          { value: 'checklist_completed' },
        ],
        metricValues: [{}],
      }],
    });
    expect(actions.events[0]).toMatchObject({ eventCount: null, eligibleForDescription: false });
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
