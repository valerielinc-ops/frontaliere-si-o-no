import { describe, expect, it } from 'vitest';
import { appendJobRankingParams, rankingStatsKey } from '../functions/src/lib/jobEmailRanking.js';
import {
  loadNewsletterRankingStats,
  recordJobEmailImpressions,
  recordJobEmailRankingClick,
} from '../functions/src/lib/jobEmailRankingStore.js';

function fakeDb() {
  const values = new Map<string, any>();
  const ref = (path: string): any => ({
    path,
    collection: (name: string) => ({ doc: (id: string) => ref(`${path}/${name}/${id}`) }),
  });
  const db: any = {
    collection: (name: string) => ({ doc: (id: string) => ref(`${name}/${id}`) }),
    batch: () => ({
      set: (documentRef: any, data: any) => values.set(documentRef.path, data),
      commit: async () => {},
    }),
    runTransaction: async (callback: (tx: any) => Promise<void>) => callback({
      get: async (documentRef: any) => ({ exists: values.has(documentRef.path) }),
      create: (documentRef: any, data: any) => values.set(documentRef.path, data),
      set: (documentRef: any, data: any) => values.set(documentRef.path, data),
      update: (documentRef: any, data: any) => values.set(documentRef.path, data),
    }),
  };
  return { db, values };
}

describe('job email ranking Firestore store', () => {
  it('records a click once even when the provider retries the webhook', async () => {
    const { db, values } = fakeDb();
    const url = appendJobRankingParams('https://frontaliereticino.ch/cerca-lavoro-ticino/job-one/', {
      jobId: 'job-one',
      surface: 'job_alert',
      surfaceId: 'alert-1',
      alertId: 'alert-1',
      deliveryId: 'jer_job_alert_1',
      position: 1,
      variant: 'treatment',
    });
    const first = await recordJobEmailRankingClick(db, {
      email: 'person@example.com',
      provider: 'resend',
      messageId: 'message-1',
      occurredAt: '2026-09-08T10:00:00.000Z',
      url,
    });
    const second = await recordJobEmailRankingClick(db, {
      email: 'person@example.com',
      provider: 'resend',
      messageId: 'message-1',
      occurredAt: '2026-09-08T10:00:01.000Z',
      url,
    });

    expect(first.recorded).toBe(true);
    expect(second.recorded).toBe(false);
    expect([...values.values()].some((value) => value.event_type === 'job_alert_click')).toBe(true);
    const stats = [...values.values()].find((value) => value.clicks);
    expect(stats).toBeTruthy();
    expect(stats.surface).toBe('job_alert');
    expect(stats.clicks).toHaveProperty('operand', 1);
    expect(stats.clicks_by_variant).toEqual({
      treatment: expect.objectContaining({ operand: 1 }),
    });
  });

  it('keeps the click aggregate when the alert document was deleted', async () => {
    const { db, values } = fakeDb();
    const url = appendJobRankingParams('https://frontaliereticino.ch/cerca-lavoro-ticino/job-one/', {
      jobId: 'job-one',
      surface: 'job_alert',
      surfaceId: 'alert-deleted',
      alertId: 'alert-deleted',
      deliveryId: 'jer_job_alert_deleted',
      position: 1,
      variant: 'treatment',
    });

    const result = await recordJobEmailRankingClick(db, {
      email: 'person@example.com',
      provider: 'resend',
      messageId: 'message-deleted-alert',
      occurredAt: '2026-09-08T10:00:00.000Z',
      url,
    });

    expect(result.recorded).toBe(true);
    expect([...values.values()].some((value) => value.event_type === 'job_alert_click')).toBe(true);
    expect([...values.values()].some((value) => value.clicks)).toBe(true);
  });

  it('mirrors a click into an existing alert document', async () => {
    const { db, values } = fakeDb();
    values.set('job_alert_subscribers/person@example.com/alerts/alert-1', { active: true });
    const url = appendJobRankingParams('https://frontaliereticino.ch/cerca-lavoro-ticino/job-one/', {
      jobId: 'job-one',
      surface: 'job_alert',
      surfaceId: 'alert-1',
      alertId: 'alert-1',
      deliveryId: 'jer_job_alert_existing',
      position: 1,
      variant: 'treatment',
    });

    const result = await recordJobEmailRankingClick(db, {
      email: 'person@example.com',
      provider: 'resend',
      messageId: 'message-existing-alert',
      occurredAt: '2026-09-08T10:00:00.000Z',
      url,
    });

    expect(result.recorded).toBe(true);
    expect(values.get('job_alert_subscribers/person@example.com/alerts/alert-1')).toEqual(
      expect.objectContaining({
        [`ranking_stats.${rankingStatsKey('job-one')}.days.2026-09-08.clicks`]: expect.objectContaining({ operand: 1 }),
      }),
    );
  });

  it('stores the full ranking manifest and impression attribution fields', async () => {
    const { db, values } = fakeDb();
    await recordJobEmailImpressions(db, [{
      deliveryId: 'jer_newsletter_2',
      surface: 'newsletter',
      surfaceId: 'newsletter_weekly',
      newsletterId: 'weekly_2026-09-08',
      email: 'person@example.com',
      variant: 'treatment',
      sentAt: '2026-09-08T10:00:00.000Z',
      jobs: [{
        jobId: 'job-one',
        ranking: {
          position: 2,
          rankingScore: 0.81,
          relevanceScore: 8,
          ctrShrink: 0.11,
          randomBoost: 0.4,
        },
      }],
    }]);

    const impression = [...values.values()].find((value) => value.event_type === 'newsletter_job_impression');
    expect(impression).toMatchObject({
      job_id: 'job-one',
      position: 2,
      ranking_variant: 'treatment',
      ranking_score: 0.81,
      relevance_score: 8,
      ctr_shrink: 0.11,
      random_boost: 0.4,
    });
    expect(impression.user_id).toHaveLength(32);
    expect(impression).not.toHaveProperty('email');
  });

  it('bounds newsletter stats reads to the ranking surface and rolling window', async () => {
    const whereCalls: Array<[string, string, string]> = [];
    const query: any = {
      where: (field: string, operator: string, value: string) => {
        whereCalls.push([field, operator, value]);
        return query;
      },
      get: async () => ({
        docs: [{
          data: () => ({
            surface: 'newsletter',
            surface_id: 'newsletter_weekly',
            job_id: 'job-one',
            date: '2026-09-08',
            impressions: 10,
            clicks: 2,
            position_sum: 12,
          }),
        }],
      }),
    };
    const db: any = {
      collection: (name: string) => {
        expect(name).toBe('job_email_ranking_stats');
        return query;
      },
    };

    const stats = await loadNewsletterRankingStats(db, { sinceDay: '2026-07-10' });
    expect(whereCalls).toEqual([
      ['surface', '==', 'newsletter'],
      ['surface_id', '==', 'newsletter_weekly'],
      ['date', '>=', '2026-07-10'],
    ]);
    expect(stats.get('job-one')?.days['2026-09-08']).toEqual({
      impressions: 10,
      clicks: 2,
      position_sum: 12,
    });
  });
});
