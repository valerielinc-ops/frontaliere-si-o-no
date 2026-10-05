import { describe, expect, it } from 'vitest';
import { rankingStatsKey } from '../functions/src/lib/jobEmailRanking.js';
import { appendJobRankingParams } from '../functions/src/lib/jobEmailRankingLinks.js';
import {
  recordJobEmailImpressions,
  recordJobEmailRankingClick,
} from '../functions/src/lib/jobEmailRankingStore.js';

function fakeDb() {
  const values = new Map<string, any>();
  const directReads: string[] = [];
  const transactionReads: string[] = [];
  const deleteAfterDirectRead = new Set<string>();
  const alertUpdates: Array<{ path: string; data: any }> = [];
  const transactionControls = {
    retryAfterFirstCreate: false,
    attempts: 0,
  };
  const createdDocumentPaths: string[] = [];
  const ref = (path: string): any => ({
    path,
    collection: (name: string) => ({ doc: (id: string) => ref(`${path}/${name}/${id}`) }),
    get: async () => {
      directReads.push(path);
      const exists = values.has(path);
      if (deleteAfterDirectRead.has(path)) values.delete(path);
      return { exists };
    },
    update: async (data: any) => {
      if (!values.has(path)) {
        throw Object.assign(new Error(`NOT_FOUND: ${path}`), { code: 5 });
      }
      alertUpdates.push({ path, data });
      values.set(path, data);
    },
  });
  const makeTransaction = () => ({
    get: async (documentRef: any) => {
      transactionReads.push(documentRef.path);
      return { exists: values.has(documentRef.path) };
    },
    create: (documentRef: any, data: any) => {
      createdDocumentPaths.push(documentRef.path);
      values.set(documentRef.path, data);
    },
    set: (documentRef: any, data: any) => values.set(documentRef.path, data),
    // Real Firestore rejects update() with NOT_FOUND on a missing document.
    // The fake has to do the same, otherwise the deleted-alert regression
    // below passes even when the transaction writes the mirror blindly.
    update: (documentRef: any, data: any) => {
      if (!values.has(documentRef.path)) {
        throw Object.assign(new Error(`NOT_FOUND: ${documentRef.path}`), { code: 5 });
      }
      values.set(documentRef.path, data);
    },
  });
  const db: any = {
    collection: (name: string) => ({ doc: (id: string) => ref(`${name}/${id}`) }),
    batch: () => ({
      set: (documentRef: any, data: any) => values.set(documentRef.path, data),
      commit: async () => {},
    }),
    runTransaction: async (callback: (tx: any) => Promise<void>) => {
      const runAttempt = async () => {
        transactionControls.attempts += 1;
        return callback(makeTransaction());
      };
      const result = await runAttempt();
      if (transactionControls.retryAfterFirstCreate && createdDocumentPaths.length > 0) {
        transactionControls.retryAfterFirstCreate = false;
        // A competing transaction committed the idempotency event before
        // Firestore re-invoked our callback after an optimistic conflict.
        values.set(createdDocumentPaths[0], { event_type: 'job_alert_click', concurrent: true });
        return runAttempt();
      }
      return result;
    },
  };
  return {
    db,
    values,
    directReads,
    transactionReads,
    deleteAfterDirectRead,
    alertUpdates,
    transactionControls,
  };
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
      variant: 'affinity',
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
      affinity: expect.objectContaining({ operand: 1 }),
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
      variant: 'affinity',
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
    const { db, values, directReads, transactionReads } = fakeDb();
    values.set('job_alert_subscribers/person@example.com/alerts/alert-1', { active: true });
    const url = appendJobRankingParams('https://frontaliereticino.ch/cerca-lavoro-ticino/job-one/', {
      jobId: 'job-one',
      surface: 'job_alert',
      surfaceId: 'alert-1',
      alertId: 'alert-1',
      deliveryId: 'jer_job_alert_existing',
      position: 1,
      variant: 'affinity',
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
    expect(directReads).toContain('job_alert_subscribers/person@example.com/alerts/alert-1');
    expect(transactionReads).not.toContain('job_alert_subscribers/person@example.com/alerts/alert-1');
  });

  it('keeps the durable click when the alert is deleted after the mirror probe', async () => {
    const { db, values, deleteAfterDirectRead } = fakeDb();
    const alertPath = 'job_alert_subscribers/person@example.com/alerts/alert-race';
    values.set(alertPath, { active: true });
    deleteAfterDirectRead.add(alertPath);
    const url = appendJobRankingParams('https://frontaliereticino.ch/cerca-lavoro-ticino/job-one/', {
      jobId: 'job-one',
      surface: 'job_alert',
      surfaceId: 'alert-race',
      alertId: 'alert-race',
      deliveryId: 'jer_job_alert_race',
      position: 1,
      variant: 'affinity',
    });

    const result = await recordJobEmailRankingClick(db, {
      email: 'person@example.com',
      provider: 'resend',
      messageId: 'message-alert-race',
      occurredAt: '2026-09-08T10:00:00.000Z',
      url,
    });

    expect(result.recorded).toBe(true);
    expect(values.has(alertPath)).toBe(false);
    expect([...values.values()].some((value) => value.event_type === 'job_alert_click')).toBe(true);
    expect([...values.values()].some((value) => value.clicks)).toBe(true);
  });

  it('does not mirror a click when a transaction retry finds a concurrent event', async () => {
    const { db, values, alertUpdates, transactionControls } = fakeDb();
    const alertPath = 'job_alert_subscribers/person@example.com/alerts/alert-concurrent';
    values.set(alertPath, { active: true });
    transactionControls.retryAfterFirstCreate = true;
    const url = appendJobRankingParams('https://frontaliereticino.ch/cerca-lavoro-ticino/job-one/', {
      jobId: 'job-one',
      surface: 'job_alert',
      surfaceId: 'alert-concurrent',
      alertId: 'alert-concurrent',
      deliveryId: 'jer_job_alert_concurrent',
      position: 1,
      variant: 'affinity',
    });

    const result = await recordJobEmailRankingClick(db, {
      email: 'person@example.com',
      provider: 'resend',
      messageId: 'message-alert-concurrent',
      occurredAt: '2026-09-08T10:00:00.000Z',
      url,
    });

    expect(transactionControls.attempts).toBe(2);
    expect(result.recorded).toBe(false);
    expect(alertUpdates).toHaveLength(0);
    expect(values.get(alertPath)).toEqual({ active: true });
  });

  it('stores the full ranking manifest and impression attribution fields', async () => {
    const { db, values } = fakeDb();
    await recordJobEmailImpressions(db, [{
      deliveryId: 'jer_newsletter_2',
      surface: 'newsletter',
      surfaceId: 'newsletter_weekly',
      newsletterId: 'weekly_2026-09-08',
      email: 'person@example.com',
      variant: 'affinity',
      affinityProfile: true,
      sentAt: '2026-09-08T10:00:00.000Z',
      jobs: [{
        jobId: 'job-one',
        category: 'Informatica',
        canton: 'TI',
        ranking: {
          position: 2,
          rankingScore: 0.81,
          relevanceScore: 8,
          affinityScore: 0.75,
        },
      }],
    }]);

    const impression = [...values.values()].find((value) => value.event_type === 'newsletter_job_impression');
    expect(impression).toMatchObject({
      job_id: 'job-one',
      position: 2,
      ranking_variant: 'affinity',
      ranking_score: 0.81,
      relevance_score: 8,
      affinity_profile: true,
    });
    // The CTR experiment's per-job fields are no longer written.
    expect(impression).not.toHaveProperty('ctr_shrink');
    expect(impression).not.toHaveProperty('random_boost');
    expect(impression.user_id).toHaveLength(32);
    expect(impression).not.toHaveProperty('email');

    const delivery = [...values.values()].find((value) => value.delivery_id === 'jer_newsletter_2' && Array.isArray(value.jobs));
    expect(delivery).toMatchObject({ ranking_variant: 'affinity', affinity_profile: true });
    expect(delivery.jobs[0]).toMatchObject({ job_id: 'job-one', affinity_score: 0.75, category: 'Informatica', canton: 'TI' });
  });

  it('writes affinity_profile on every delivery and impression of BOTH variants', async () => {
    const { db, values } = fakeDb();
    const record = (deliveryId: string, variant: string, affinityProfile: boolean | undefined) => ({
      deliveryId,
      surface: 'job_alert',
      surfaceId: `alert-${deliveryId}`,
      alertId: `alert-${deliveryId}`,
      email: `${deliveryId}@example.com`,
      variant,
      affinityProfile,
      sentAt: '2026-10-05T10:00:00.000Z',
      jobs: [{ jobId: `${deliveryId}-a` }, { jobId: `${deliveryId}-b` }],
    });
    await recordJobEmailImpressions(db, [
      record('c-with', 'control', true),
      record('c-without', 'control', false),
      record('a-with', 'affinity', true),
      record('a-without', 'affinity', false),
      // A job-alert retry queued before the field existed carries no value.
      record('legacy', 'control', undefined),
    ]);

    const rows = [...values.values()];
    const expected: Record<string, boolean | null> = {
      'c-with': true, 'c-without': false, 'a-with': true, 'a-without': false, legacy: null,
    };
    for (const [deliveryId, flag] of Object.entries(expected)) {
      const delivery = rows.find((value) => value.delivery_id === deliveryId && Array.isArray(value.jobs));
      expect(delivery?.affinity_profile, deliveryId).toBe(flag);
      const impressions = rows.filter((value) => value.delivery_id === deliveryId && value.event_type === 'job_alert_impression');
      expect(impressions, deliveryId).toHaveLength(2);
      for (const impression of impressions) expect(impression.affinity_profile, deliveryId).toBe(flag);
    }
  });
});
