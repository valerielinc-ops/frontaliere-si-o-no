import { describe, expect, it } from 'vitest';
import { persistMailgunEvent } from '../functions/src/newsletterMailgunWebhookCore.js';

/**
 * `existingEvents` seeds the `events` subcollection per doc (keyed by
 * `${collection}/${docId}`) so refreshPreferredSendHour's
 * `.collection('events').orderBy('occurred_at', 'desc').limit(300).get()`
 * query (FRO — #3798) has something to read. Real Firestore query semantics
 * (actual ordering/limiting) aren't reproduced — these tests only need the
 * seeded docs to come back so the sample count/hour computation runs.
 * Mirrors tests/newsletter-mailjet-webhook-core.test.ts.
 */
function createFakeDb(
  existingDocs: Record<string, Record<string, Record<string, unknown>>> = {},
  existingEvents: Record<string, Array<Record<string, unknown>>> = {},
) {
  const sets: Array<{ collection: string; docId: string; data: Record<string, unknown> }> = [];
  const adds: Array<{ collection: string; data: Record<string, unknown> }> = [];

  const makeCollection = (name: string) => ({
    doc: (docId: string) => {
      const docRef: any = {
        set: async (data: Record<string, unknown>) => {
          sets.push({ collection: name, docId, data });
        },
        get: async () => {
          const docData = existingDocs[name]?.[docId];
          return {
            exists: !!docData,
            data: () => docData || {},
          };
        },
        collection: (subName: string) => {
          const subPath = `${name}/${docId}/${subName}`;
          return {
            doc: (subDocId: string) => ({
              set: async (data: Record<string, unknown>, _opts?: unknown) => {
                sets.push({ collection: subPath, docId: subDocId, data });
              },
            }),
            add: async (data: Record<string, unknown>) => {
              adds.push({ collection: subPath, data });
            },
            // Minimal query shim: only `events` collections are queried
            // (refreshPreferredSendHour), keyed on `${name}/${docId}`.
            orderBy: () => ({
              limit: () => ({
                get: async () => {
                  const seeded = subName === 'events' ? (existingEvents[`${name}/${docId}`] || []) : [];
                  return { docs: seeded.map((d) => ({ data: () => d })) };
                },
              }),
            }),
          };
        },
      };
      // Minimal `db.runTransaction` shim (mirrors the real Firestore idiom used
      // by maybeEscalateSoftBounce / publisherPendingReapCore / trafficSchedulerCore)
      // — these single-threaded tests don't need real optimistic-concurrency
      // retries, just a tx.get/tx.set that delegate to the same doc.
      docRef.firestore = {
        runTransaction: async (updateFunction: (tx: any) => Promise<unknown>) => {
          const tx = {
            get: async (ref: any) => ref.get(),
            set: (ref: any, data: Record<string, unknown>, opts?: unknown) => {
              ref.set(data, opts);
            },
          };
          return updateFunction(tx);
        },
      };
      return docRef;
    },
  });

  return {
    collection(name: string) {
      return makeCollection(name);
    },
    __sets: sets,
    __adds: adds,
  };
}

describe('newsletterMailgunWebhookCore — preferred send hour (#3798)', () => {
  it('writes preferred_send_hour_utc/sample_count/strength on an "opened" event with enough seeded prior events', async () => {
    const docId = 'frequent-opener@example.com';
    const db = createFakeDb({}, {
      [`newsletter_subscribers/${docId}`]: [
        { event_type: 'open', occurred_at: new Date(Date.now() - 1 * 86400000).toISOString() },
        { event_type: 'click', occurred_at: new Date(Date.now() - 2 * 86400000).toISOString() },
        { event_type: 'open', occurred_at: new Date(Date.now() - 3 * 86400000).toISOString() },
      ],
    });

    const result = await persistMailgunEvent(db as any, {
      event: 'opened',
      recipient: docId,
      timestamp: 1700000200,
    });

    expect(result).toMatchObject({ processed: true, type: 'open' });

    const preferredSet = db.__sets.find(
      (s) => s.collection === 'newsletter_subscribers'
        && s.docId === docId
        && 'preferred_send_sample_count' in s.data,
    );
    expect(preferredSet).toBeTruthy();
    expect(preferredSet!.data.preferred_send_sample_count).toBe(3);
    expect(typeof preferredSet!.data.preferred_send_hour_utc).toBe('number');
    expect(preferredSet!.data.preferred_send_updated_at).toBeTruthy();
  });
});

describe('newsletterMailgunWebhookCore — job alert bounce handling', () => {
  it('soft bounce (severity=temporary) on a job-alert subscriber does not set permanent bounced status', async () => {
    const db = createFakeDb({
      job_alert_subscribers: { 'seeker@example.com': { status: 'active', soft_bounce_count: 0 } },
    });

    const result = await persistMailgunEvent(db as any, {
      event: 'failed',
      recipient: 'seeker@example.com',
      timestamp: 1700000000,
      tags: ['job-alert'],
      severity: 'temporary',
      reason: 'greylisted',
    });

    expect(result).toMatchObject({ processed: true, type: 'bounce', collection: 'job_alert_subscribers' });

    const subscriberSet = db.__sets.find(
      (s) => s.collection === 'job_alert_subscribers' && s.docId === 'seeker@example.com',
    );
    expect(subscriberSet!.data.status).not.toBe('bounced');
    expect(subscriberSet!.data.bounce_severity).toBe('soft');
    expect(subscriberSet!.data.soft_bounce_count).toBeDefined();
  });

  it('hard bounce (severity=permanent) on a job-alert subscriber still sets permanent bounced status', async () => {
    const db = createFakeDb();

    const result = await persistMailgunEvent(db as any, {
      event: 'failed',
      recipient: 'deadend@example.com',
      timestamp: 1700000001,
      tags: ['job-alert'],
      severity: 'permanent',
      reason: 'mailbox does not exist',
    });

    expect(result).toMatchObject({ processed: true, type: 'bounce', collection: 'job_alert_subscribers' });

    const subscriberSet = db.__sets.find(
      (s) => s.collection === 'job_alert_subscribers' && s.docId === 'deadend@example.com',
    );
    expect(subscriberSet!.data.status).toBe('bounced');
  });
});

describe('newsletterMailgunWebhookCore — malformed "Name <email>" recipient (root-cause fix)', () => {
  it('keys the subscriber doc by the bare address, not the raw "Name <email>" string', async () => {
    const db = createFakeDb();

    const result = await persistMailgunEvent(db as any, {
      event: 'delivered',
      recipient: 'Mario Rossi <mario.rossi@example.com>',
      timestamp: 1700000300,
    });

    expect(result).toMatchObject({ processed: true, type: 'delivered', email: 'mario.rossi@example.com' });
    const subscriberSet = db.__sets.find(
      (s) => s.collection === 'newsletter_subscribers' && s.docId === 'mario.rossi@example.com',
    );
    expect(subscriberSet).toBeTruthy();
    expect(db.__sets.some((s) => s.docId.includes('<'))).toBe(false);
  });
});

/**
 * Campaign attribution (2026-08-20). `o:tag` sends bare VALUES, so the name is
 * lost in transit and the old `campaign:` prefix scan matched nothing this
 * sender emits: every Mailgun event was filed under its raw message id. The
 * cascade now stamps `v:campaign_id`, which survives with its name.
 */
describe('newsletterMailgunWebhookCore — campaign attribution', () => {
  const docId = 'seeker@example.com';

  const campaignOf = (db: any) => {
    const added = db.__adds.find((a: any) => a.collection.endsWith('/events'));
    return added?.data?.campaign_id;
  };

  it('reads the campaign from the user-variables the cascade stamps', async () => {
    const db = createFakeDb();
    await persistMailgunEvent(db as any, {
      event: 'opened',
      recipient: docId,
      timestamp: 1700000200,
      'user-variables': { campaign_id: 'onboarding_drip_step_1' },
      tags: ['onboarding_drip_step_1', 'lifecycle', 'it'],
    } as any);
    expect(campaignOf(db)).toBe('onboarding_drip_step_1');
  });

  it('still honours the legacy campaign:<id> tag form for late-arriving events', async () => {
    const db = createFakeDb();
    await persistMailgunEvent(db as any, {
      event: 'opened',
      recipient: docId,
      timestamp: 1700000200,
      tags: ['campaign:weekly_2026-08-17'],
    } as any);
    expect(campaignOf(db)).toBe('weekly_2026-08-17');
  });

  it('does not crash on the bare-value tag array, and falls back to the message id', async () => {
    const db = createFakeDb();
    await persistMailgunEvent(db as any, {
      event: 'opened',
      recipient: docId,
      timestamp: 1700000200,
      tags: ['welcome_job', 'lifecycle', 'en'],
      id: 'mg-message-id',
    } as any);
    expect(campaignOf(db)).toBe('mg-message-id');
  });
});
