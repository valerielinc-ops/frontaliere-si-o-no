import { describe, expect, it } from 'vitest';
import {
  persistMailerooEvent,
  verifyMailerooSignature,
} from '../functions/src/newsletterMailerooWebhookCore.js';
import crypto from 'crypto';

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
              get: async () => {
                const docData = existingDocs[subPath]?.[subDocId];
                return {
                  exists: !!docData,
                  data: () => docData || undefined,
                };
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
    add: async (data: Record<string, unknown>) => {
      adds.push({ collection: name, data });
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

describe('newsletterMailerooWebhookCore', () => {
  it('stores click events across subscriber, delivery and events collections', async () => {
    const db = createFakeDb({
      newsletter_subscribers: {
        'testuser@example.com': { status: 'confirmed', isActive: true },
      },
    });

    const result = await persistMailerooEvent(db as any, {
      event_type: 'clicked',
      message_id: 'msg_123',
      message_reference_id: 'ref_123',
      event_time: 1700000000,
      tags: { campaign_id: 'weekly_2026-03-11', source_channel: 'job_gate' },
      event_data: {
        to: 'TestUser@example.com',
        original_url: 'https://frontaliereticino.ch/cerca-lavoro-ticino/',
        ip: '1.2.3.4',
        user_agent: 'Mozilla/5.0',
      },
    });

    expect(result).toMatchObject({
      processed: true,
      type: 'click',
      email: 'testuser@example.com',
      campaignId: 'weekly_2026-03-11',
    });

    expect(db.__sets.some((e) => e.collection === 'newsletter_subscribers' && e.docId === 'testuser@example.com')).toBe(true);
    expect(db.__sets.some((e) => e.collection.includes('/campaign_deliveries') && e.docId.includes('weekly_2026-03-11_testuser@example.com'))).toBe(true);
    expect(db.__adds.some((e) => e.collection.includes('/events'))).toBe(true);
  });

  it('maps accepted → send and delivered → delivered', async () => {
    const db = createFakeDb();
    const accepted = await persistMailerooEvent(db as any, {
      event_type: 'accepted',
      message_id: 'm1',
      event_data: { to: 'a@example.com' },
    });
    expect(accepted).toMatchObject({ processed: true, type: 'send' });

    const delivered = await persistMailerooEvent(db as any, {
      event_type: 'delivered',
      message_id: 'm2',
      event_data: { to: 'a@example.com' },
    });
    expect(delivered).toMatchObject({ processed: true, type: 'delivered' });
  });

  it('marks rejected/failed events as bounced on the subscriber', async () => {
    const db = createFakeDb({
      newsletter_subscribers: { 'bounce@example.com': { status: 'confirmed' } },
    });

    await persistMailerooEvent(db as any, {
      event_type: 'failed',
      message_id: 'mb',
      event_data: { to: 'bounce@example.com', reason: 'mailbox unavailable' },
    });

    const subscriberSet = db.__sets.find(
      (s) => s.collection === 'newsletter_subscribers' && s.docId === 'bounce@example.com',
    );
    expect(subscriberSet!.data.status).toBe('bounced');
    expect(subscriberSet!.data.bounce_reason).toBe('mailbox unavailable');
  });

  it('routes job-alert tagged events to job_alert_subscribers', async () => {
    const db = createFakeDb();

    const result = await persistMailerooEvent(db as any, {
      event_type: 'opened',
      message_id: 'mja',
      tags: { type: 'job-alert', alert_id: 'alert_42' },
      event_data: { to: 'seeker@example.com' },
    });

    expect(result).toMatchObject({
      processed: true,
      type: 'open',
      collection: 'job_alert_subscribers',
    });
    expect(db.__sets.some((s) => s.collection === 'job_alert_subscribers' && s.docId === 'seeker@example.com')).toBe(true);
    expect(db.__sets.some((s) => s.collection === 'newsletter_subscribers')).toBe(false);
  });

  it('soft bounce (rejected) on a job-alert subscriber does not set permanent bounced status', async () => {
    const db = createFakeDb({
      job_alert_subscribers: { 'seeker2@example.com': { status: 'active', soft_bounce_count: 0 } },
    });

    const result = await persistMailerooEvent(db as any, {
      event_type: 'rejected',
      message_id: 'mja2',
      tags: { type: 'job-alert', alert_id: 'alert_43' },
      event_data: { to: 'seeker2@example.com', reason: 'greylisted' },
    });

    expect(result).toMatchObject({ processed: true, type: 'bounce', collection: 'job_alert_subscribers' });

    const subscriberSet = db.__sets.find(
      (s) => s.collection === 'job_alert_subscribers' && s.docId === 'seeker2@example.com',
    );
    expect(subscriberSet!.data.status).not.toBe('bounced');
    expect(subscriberSet!.data.bounce_severity).toBe('soft');
    expect(subscriberSet!.data.soft_bounce_count).toBeDefined();
  });

  it('hard bounce (failed) on a job-alert subscriber still sets permanent bounced status', async () => {
    const db = createFakeDb();

    const result = await persistMailerooEvent(db as any, {
      event_type: 'failed',
      message_id: 'mja3',
      tags: { type: 'job-alert', alert_id: 'alert_44' },
      event_data: { to: 'seeker3@example.com', reason: 'mailbox does not exist' },
    });

    expect(result).toMatchObject({ processed: true, type: 'bounce', collection: 'job_alert_subscribers' });

    const subscriberSet = db.__sets.find(
      (s) => s.collection === 'job_alert_subscribers' && s.docId === 'seeker3@example.com',
    );
    expect(subscriberSet!.data.status).toBe('bounced');
  });

  it('resolves recipient for opened/clicked events (no recipient/tags in payload) via newsletter_subscribers/_meta_/maileroo_refs', async () => {
    // Maileroo opened/clicked webhooks carry only message_reference_id — the send
    // pipeline pre-seeds the lookup record. Verify the click is attributed.
    const db = createFakeDb({
      'newsletter_subscribers/_meta_/maileroo_refs': {
        ref_abc: { email: 'resolved@example.com', campaign_id: 'weekly_2026-06-01', is_job_alert: false },
      },
    });

    const result = await persistMailerooEvent(db as any, {
      event_type: 'clicked',
      message_id: '<rfc-id@maileroo>',
      message_reference_id: 'ref_abc',
      event_time: 1748764800,
      tags: null,
      event_data: { original_url: 'https://frontaliereticino.ch/x', ip: '9.9.9.9' },
    });

    expect(result).toMatchObject({
      processed: true,
      type: 'click',
      email: 'resolved@example.com',
      campaignId: 'weekly_2026-06-01',
    });
    expect(db.__sets.some((e) => e.collection === 'newsletter_subscribers' && e.docId === 'resolved@example.com')).toBe(true);
  });

  it('routes opened/clicked to job_alert_subscribers when the lookup record flags job-alert', async () => {
    // send-job-alerts.mjs (sendBatch onSent) writes exactly { email, is_job_alert: true }
    // to newsletter_subscribers/_meta_/maileroo_refs/{referenceId} — no campaign_id
    // (job-alerts have no campaign concept). Mirror that prod shape here.
    const db = createFakeDb({
      'newsletter_subscribers/_meta_/maileroo_refs': {
        ref_ja: { email: 'seeker@example.com', is_job_alert: true },
      },
    });

    const result = await persistMailerooEvent(db as any, {
      event_type: 'opened',
      message_reference_id: 'ref_ja',
      tags: null,
      event_data: { ip: '8.8.8.8' },
    });

    expect(result).toMatchObject({ processed: true, type: 'open', collection: 'job_alert_subscribers' });
  });

  it('falls back to legacy maileroo_message_meta for in-flight refs', async () => {
    // Messages sent before the path migration stored their lookup in the top-level
    // collection. The webhook must still attribute their opens/clicks.
    const db = createFakeDb({
      maileroo_message_meta: {
        ref_legacy: { email: 'legacy@example.com', campaign_id: 'weekly_old', is_job_alert: false },
      },
    });

    const result = await persistMailerooEvent(db as any, {
      event_type: 'opened',
      message_reference_id: 'ref_legacy',
      tags: null,
      event_data: { ip: '7.7.7.7' },
    });

    expect(result).toMatchObject({
      processed: true,
      type: 'open',
      email: 'legacy@example.com',
      campaignId: 'weekly_old',
    });
  });

  it('skips opened/clicked when no lookup record exists (unattributable)', async () => {
    const db = createFakeDb();
    const result = await persistMailerooEvent(db as any, {
      event_type: 'clicked',
      message_reference_id: 'ref_unknown',
      tags: null,
      event_data: { original_url: 'https://x/y' },
    });
    expect(result).toMatchObject({ skipped: true, reason: 'invalid_email' });
  });

  it('skips deferred (transient) and unknown event types', async () => {
    const db = createFakeDb();
    const deferred = await persistMailerooEvent(db as any, {
      event_type: 'deferred',
      event_data: { to: 'x@example.com' },
    });
    expect(deferred).toMatchObject({ skipped: true });
    expect(db.__sets.length).toBe(0);
  });

  it('skips events with an invalid recipient', async () => {
    const db = createFakeDb();
    const result = await persistMailerooEvent(db as any, {
      event_type: 'delivered',
      event_data: {},
    });
    expect(result).toMatchObject({ skipped: true, reason: 'invalid_email' });
  });

  describe('preferred send hour (#3798)', () => {
    it('writes preferred_send_hour_utc/sample_count/strength on a "clicked" event with enough seeded prior events', async () => {
      const email = 'frequent-clicker@example.com';
      const db = createFakeDb({
        newsletter_subscribers: { [email]: { status: 'confirmed', isActive: true } },
      }, {
        [`newsletter_subscribers/${email}`]: [
          { event_type: 'open', occurred_at: new Date(Date.now() - 1 * 86400000).toISOString() },
          { event_type: 'click', occurred_at: new Date(Date.now() - 2 * 86400000).toISOString() },
          { event_type: 'open', occurred_at: new Date(Date.now() - 3 * 86400000).toISOString() },
        ],
      });

      const result = await persistMailerooEvent(db as any, {
        event_type: 'clicked',
        message_id: 'm-click',
        event_data: { to: email, original_url: 'https://frontaliereticino.ch/x' },
      });

      expect(result).toMatchObject({ processed: true, type: 'click', email });

      const preferredSet = db.__sets.find(
        (s) => s.collection === 'newsletter_subscribers'
          && s.docId === email
          && 'preferred_send_sample_count' in s.data,
      );
      expect(preferredSet).toBeTruthy();
      expect(preferredSet!.data.preferred_send_sample_count).toBe(3);
      expect(typeof preferredSet!.data.preferred_send_hour_utc).toBe('number');
      expect(preferredSet!.data.preferred_send_updated_at).toBeTruthy();
    });
  });
});

describe('verifyMailerooSignature', () => {
  const secret = 'whsec-maileroo-test';
  const payload = JSON.stringify({ event_type: 'delivered', event_data: { to: 'a@example.com' } });
  const goodSig = crypto.createHmac('sha256', secret).update(payload, 'utf8').digest('hex');

  it('accepts a valid HMAC-SHA256 hex signature', () => {
    expect(verifyMailerooSignature({ payload, signature: goodSig, signingSecret: secret })).toBe(true);
  });

  it('accepts a sha256=-prefixed signature', () => {
    expect(verifyMailerooSignature({ payload, signature: `sha256=${goodSig}`, signingSecret: secret })).toBe(true);
  });

  it('rejects a tampered signature', () => {
    expect(verifyMailerooSignature({ payload, signature: goodSig.replace(/.$/, '0'), signingSecret: secret })).toBe(false);
  });

  it('rejects when signature or secret is missing', () => {
    expect(verifyMailerooSignature({ payload, signature: '', signingSecret: secret })).toBe(false);
    expect(verifyMailerooSignature({ payload, signature: goodSig, signingSecret: '' })).toBe(false);
  });
});

describe('newsletterMailerooWebhookCore — malformed "Name <email>" recipient (root-cause fix)', () => {
  it('keys the subscriber doc by the bare address, not the raw "Name <email>" string', async () => {
    const db = createFakeDb();

    const result = await persistMailerooEvent(db as any, {
      event_type: 'delivered',
      event_data: { to: 'Mario Rossi <mario.rossi@example.com>' },
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
 * The array-tags twin (follow-up to #6195). `isJobAlertEvent` had the same
 * `!Array.isArray` guard that extractCampaignId had, so the array shape was
 * read as "not a job alert" and the event was routed to the newsletter
 * subscriber document instead of the job-alert one. Only reachable when the
 * maileroo_refs lookup does not resolve, which is why it stayed dormant.
 */
describe('newsletterMailerooWebhookCore — job-alert routing without a lookup record', () => {
  const routedCollections = (db: any) =>
    db.__adds.filter((a: any) => a.collection.endsWith('/events')).map((a: any) => a.collection);

  it('routes to job_alert_subscribers when the type tag arrives in the array shape', async () => {
    const db = createFakeDb();
    await persistMailerooEvent(db as any, {
      event_type: 'accepted',
      message_id: 'mr-1',
      event_data: { to: 'seeker@example.com' },
      tags: [{ name: 'type', value: 'job-alert' }, { name: 'locale', value: 'it' }],
    } as any);
    expect(routedCollections(db).join()).toContain('job_alert_subscribers');
  });

  it('still routes the object shape, which already worked', async () => {
    const db = createFakeDb();
    await persistMailerooEvent(db as any, {
      event_type: 'accepted',
      message_id: 'mr-2',
      event_data: { to: 'seeker@example.com' },
      tags: { type: 'job-alert-retry' },
    } as any);
    expect(routedCollections(db).join()).toContain('job_alert_subscribers');
  });

  it('leaves a non-job-alert event on the newsletter side', async () => {
    const db = createFakeDb();
    await persistMailerooEvent(db as any, {
      event_type: 'accepted',
      message_id: 'mr-3',
      event_data: { to: 'seeker@example.com' },
      tags: [{ name: 'type', value: 'lifecycle' }],
    } as any);
    expect(routedCollections(db).join()).toContain('newsletter_subscribers');
  });
});
