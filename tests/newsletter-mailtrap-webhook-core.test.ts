import { describe, expect, it } from 'vitest';
import { persistMailtrapEvent } from '../functions/src/newsletterMailtrapWebhookCore.js';

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

describe('newsletterMailtrapWebhookCore — preferred send hour (#3798)', () => {
  it('writes preferred_send_hour_utc/sample_count/strength on an "open" event with enough seeded prior events', async () => {
    const docId = 'frequent-opener@example.com';
    const db = createFakeDb({}, {
      [`newsletter_subscribers/${docId}`]: [
        { event_type: 'open', occurred_at: new Date(Date.now() - 1 * 86400000).toISOString() },
        { event_type: 'click', occurred_at: new Date(Date.now() - 2 * 86400000).toISOString() },
        { event_type: 'open', occurred_at: new Date(Date.now() - 3 * 86400000).toISOString() },
      ],
    });

    const result = await persistMailtrapEvent(db as any, {
      event: 'open',
      email: docId,
      message_id: 'm-open',
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

describe('newsletterMailtrapWebhookCore — job alert bounce handling', () => {
  it('soft bounce (soft_bounce) on a job-alert subscriber does not set permanent bounced status', async () => {
    const db = createFakeDb({
      job_alert_subscribers: { 'seeker@example.com': { status: 'active', soft_bounce_count: 0 } },
    });

    const result = await persistMailtrapEvent(db as any, {
      event: 'soft_bounce',
      email: 'seeker@example.com',
      message_id: 'm1',
      timestamp: 1700000000,
      custom_variables: { type: 'job-alert' },
      bounce_category: 'greylisted',
    });

    expect(result).toMatchObject({ processed: true, type: 'bounce', collection: 'job_alert_subscribers' });

    const subscriberSet = db.__sets.find(
      (s) => s.collection === 'job_alert_subscribers' && s.docId === 'seeker@example.com',
    );
    expect(subscriberSet!.data.status).not.toBe('bounced');
    expect(subscriberSet!.data.bounce_severity).toBe('soft');
    expect(subscriberSet!.data.soft_bounce_count).toBeDefined();
  });

  it('hard bounce (bounce) on a job-alert subscriber still sets permanent bounced status', async () => {
    const db = createFakeDb();

    const result = await persistMailtrapEvent(db as any, {
      event: 'bounce',
      email: 'deadend@example.com',
      message_id: 'm2',
      timestamp: 1700000001,
      custom_variables: { type: 'job-alert' },
      bounce_category: 'hard_bounce',
    });

    expect(result).toMatchObject({ processed: true, type: 'bounce', collection: 'job_alert_subscribers' });

    const subscriberSet = db.__sets.find(
      (s) => s.collection === 'job_alert_subscribers' && s.docId === 'deadend@example.com',
    );
    expect(subscriberSet!.data.status).toBe('bounced');
  });
});

// This suite used to assert the opposite — that a `suspension` stamps
// status=suppressed on the subscriber. That expectation encoded a defect, and
// production proved it: over 1700 subscribers, more than a fifth of the base, ended up suppressed
// and a 400-doc sample found 400 of them caused by a `suspension` event, none
// by a real bounce or complaint. Some were suppressed seconds after a delivery
// and an open. `suspension` is account/stream-level — Mailtrap saying it
// stopped sending — and its payload carries no bounce_category, response or
// response_code precisely because no recipient-side failure occurred.
describe('newsletterMailtrapWebhookCore — account-level suspension must not touch the subscriber', () => {
  it('ignores the event instead of suppressing the recipient', async () => {
    const db = createFakeDb();

    const result = await persistMailtrapEvent(db as any, {
      event: 'suspension',
      email: 'healthy@example.com',
      message_id: 'm-suspend',
      timestamp: 1700000300,
    });

    expect(result).toMatchObject({ skipped: true });
    // The load-bearing assertion: no write of any kind reaches the subscriber.
    const subscriberSet = db.__sets.find(
      (s) => s.collection === 'newsletter_subscribers' && s.docId === 'healthy@example.com',
    );
    expect(subscriberSet).toBeUndefined();
  });

  it('still suppresses on signals that really are recipient-level', async () => {
    // Guard the other direction: the fix must not have made the webhook inert
    // for genuine hard failures.
    const db = createFakeDb();
    const result = await persistMailtrapEvent(db as any, {
      event: 'spam_complaint',
      email: 'complainer@example.com',
      message_id: 'm-complaint',
      timestamp: 1700000400,
    });
    expect(result).toMatchObject({ processed: true, type: 'complaint' });
  });
});

describe('newsletterMailtrapWebhookCore — malformed "Name <email>" recipient (root-cause fix)', () => {
  it('keys the subscriber doc by the bare address, not the raw "Name <email>" string', async () => {
    const db = createFakeDb();

    const result = await persistMailtrapEvent(db as any, {
      event: 'delivery',
      email: 'Mario Rossi <mario.rossi@example.com>',
    });

    expect(result).toMatchObject({ processed: true, type: 'delivered', email: 'mario.rossi@example.com' });
    const subscriberSet = db.__sets.find(
      (s) => s.collection === 'newsletter_subscribers' && s.docId === 'mario.rossi@example.com',
    );
    expect(subscriberSet).toBeTruthy();
    expect(db.__sets.some((s) => s.docId.includes('<'))).toBe(false);
  });
});

describe('newsletterMailtrapWebhookCore — a provider opt-out leaves a COMPLETE opt-out (#5673)', () => {
  it('sets the mailable flags and both stamp spellings, not `status` alone', async () => {
    // This branch used to write `status: 'unsubscribed'` and nothing else,
    // while the `suppressed` branch three lines below it wrote
    // isActive/active too. That asymmetry is how a document ends up
    // `unsubscribed` yet still active — 281 of them measured on 2026-08-12 —
    // and how the same opt-out looked different depending on which of the
    // three writers recorded it.
    const db = createFakeDb();

    const result = await persistMailtrapEvent(db as any, {
      event: 'unsubscribe',
      email: 'optout@example.com',
      message_id: 'm-unsub',
      timestamp: 1700000300,
    });

    expect(result).toMatchObject({ processed: true, type: 'unsubscribed' });
    const subscriberSet = db.__sets.find(
      (s) => s.collection === 'newsletter_subscribers' && s.docId === 'optout@example.com',
    );
    expect(subscriberSet).toBeTruthy();
    expect(subscriberSet!.data.status).toBe('unsubscribed');
    expect(subscriberSet!.data.isActive).toBe(false);
    expect(subscriberSet!.data.active).toBe(false);
    expect(subscriberSet!.data.unsubscribed_at).toBeTruthy();
    expect(subscriberSet!.data.unsubscribedAt).toBeTruthy();
  });
});

/**
 * Campaign attribution (2026-08-20). sendViaMailtrap sets `body.category =
 * campaignIdTag(email)` and Mailtrap echoes it back on every event, but
 * extractCampaignId only ever looked at `custom_variables` — so the two halves
 * were never connected and the campaign fell through to the message id, the
 * same defect class found on Mailgun and Maileroo.
 */
describe('newsletterMailtrapWebhookCore — campaign attribution', () => {
  const campaignOf = (db: any) => {
    const added = db.__adds.find((a: any) => a.collection.endsWith('/events'));
    return added?.data?.campaign_id;
  };

  it('reads the campaign from `category`, which is what the cascade actually sets', async () => {
    const db = createFakeDb();
    await persistMailtrapEvent(db as any, {
      event: 'open',
      email: 'seeker@example.com',
      message_id: 'mt-message-id',
      category: 'daily-brief-2026-08-20',
    } as any);
    expect(campaignOf(db)).toBe('daily-brief-2026-08-20');
  });

  it('still prefers custom_variables when both are present', async () => {
    const db = createFakeDb();
    await persistMailtrapEvent(db as any, {
      event: 'open',
      email: 'seeker@example.com',
      message_id: 'mt-message-id',
      category: 'ignored',
      custom_variables: { campaign_id: 'weekly_2026-08-17' },
    } as any);
    expect(campaignOf(db)).toBe('weekly_2026-08-17');
  });

  it('falls back to the message id when neither is present', async () => {
    const db = createFakeDb();
    await persistMailtrapEvent(db as any, {
      event: 'open',
      email: 'seeker@example.com',
      message_id: 'mt-message-id',
    } as any);
    expect(campaignOf(db)).toBe('mt-message-id');
  });
});
