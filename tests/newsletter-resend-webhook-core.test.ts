import { describe, expect, it } from 'vitest';
import { applyResendWebhookEvent } from '../functions/src/newsletterResendWebhookCore.js';

/**
 * `existingEvents` seeds the `events` subcollection per doc (keyed by
 * `${collection}/${docId}`) so refreshPreferredSendHour's
 * `.collection('events').orderBy('occurred_at', 'desc').limit(300).get()`
 * query (FRO — #3798) has something to read. Real Firestore query semantics
 * (actual ordering/limiting) aren't reproduced — these tests only need the
 * seeded docs to come back so the sample count/hour computation runs.
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

describe('newsletterResendWebhookCore', () => {
  it('stores click webhook events across subscriber, delivery and events collections', async () => {
    const db = createFakeDb({
      newsletter_subscribers: {
        'testuser@example.com': { status: 'confirmed', isActive: true },
      },
    });

    const result = await applyResendWebhookEvent({
      type: 'email.clicked',
      data: {
        email: 'TestUser@example.com',
        email_id: 'msg_123',
        tags: [
          { name: 'campaign_id', value: 'weekly_2026-03-11' },
          { name: 'variant', value: 'jobs' },
          { name: 'subscriber_locale', value: 'it-IT' },
          { name: 'source_channel', value: 'job_gate' },
        ],
        click: {
          link: 'https://frontaliereticino.ch/cerca-lavoro-ticino/offerte-di-lavoro-ticino-oggi/',
          section_id: 'hero_cta',
          link_label: 'Apri offerte di oggi',
        },
      },
    }, { db: db as any });

    expect(result).toMatchObject({
      handled: true,
      email: 'testuser@example.com',
      type: 'click',
      campaignId: 'weekly_2026-03-11',
    });

    expect(db.__sets.some((entry) => entry.collection === 'newsletter_subscribers' && entry.docId === 'testuser@example.com')).toBe(true);
    expect(db.__sets.some((entry) => entry.collection.includes('/campaign_deliveries') && entry.docId.includes('weekly_2026-03-11__testuser@example.com'))).toBe(true);
    expect(db.__adds.some((entry) => entry.collection.includes('/events'))).toBe(true);
  });

  it('refreshes preferred_send_hour on a click event with too few prior events (cold start)', async () => {
    // No seeded events — refreshPreferredSendHour still runs and writes a
    // sampleCount of 0 (below PREFERRED_SEND_MIN_EVENTS), hourUtc null.
    const db = createFakeDb({
      newsletter_subscribers: {
        'coldstart@example.com': { status: 'confirmed', isActive: true },
      },
    });

    await applyResendWebhookEvent({
      type: 'email.clicked',
      data: { email: 'coldstart@example.com', email_id: 'msg_cold' },
    }, { db: db as any });

    const preferredSet = db.__sets.find(
      (s) => s.collection === 'newsletter_subscribers'
        && s.docId === 'coldstart@example.com'
        && 'preferred_send_sample_count' in s.data,
    );
    expect(preferredSet).toBeTruthy();
    expect(preferredSet!.data.preferred_send_sample_count).toBe(0);
    expect(preferredSet!.data.preferred_send_hour_utc).toBeNull();
  });

  it('refreshes preferred_send_hour on an open event with enough prior events', async () => {
    const docId = 'frequent-opener@example.com';
    const db = createFakeDb(
      {
        newsletter_subscribers: {
          [docId]: { status: 'confirmed', isActive: true },
        },
      },
      {
        [`newsletter_subscribers/${docId}`]: [
          { event_type: 'open', occurred_at: new Date(Date.now() - 1 * 86400000).toISOString() },
          { event_type: 'click', occurred_at: new Date(Date.now() - 2 * 86400000).toISOString() },
          { event_type: 'open', occurred_at: new Date(Date.now() - 3 * 86400000).toISOString() },
          // Wrong type — must be filtered out client-side (no where clause).
          { event_type: 'bounce', occurred_at: new Date(Date.now() - 1 * 86400000).toISOString() },
        ],
      },
    );

    await applyResendWebhookEvent({
      type: 'email.opened',
      data: { email: docId, email_id: 'msg_frequent' },
    }, { db: db as any });

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

  it('does NOT refresh preferred_send_hour on a delivered event (no time-of-day signal)', async () => {
    const db = createFakeDb({
      newsletter_subscribers: {
        'delivered-only@example.com': { status: 'confirmed', isActive: true },
      },
    });

    await applyResendWebhookEvent({
      type: 'email.delivered',
      data: { email: 'delivered-only@example.com', email_id: 'msg_delivered' },
    }, { db: db as any });

    const preferredSet = db.__sets.find(
      (s) => s.collection === 'newsletter_subscribers' && 'preferred_send_sample_count' in s.data,
    );
    expect(preferredSet).toBeUndefined();
  });

  it('does NOT promote pending subscribers to confirmed on delivered event (FRO-20)', async () => {
    const db = createFakeDb({
      newsletter_subscribers: {
        'pending@example.com': { status: 'pending', isActive: false },
      },
    });

    await applyResendWebhookEvent({
      type: 'email.delivered',
      data: { email: 'pending@example.com', email_id: 'msg_456' },
    }, { db: db as any });

    const subscriberSet = db.__sets.find(
      (s) => s.collection === 'newsletter_subscribers' && s.docId === 'pending@example.com',
    );
    expect(subscriberSet).toBeTruthy();
    expect(subscriberSet!.data.status).toBeUndefined();
    expect(subscriberSet!.data.isActive).toBeUndefined();
  });

  it('does NOT promote pending subscribers to confirmed on open event (FRO-20)', async () => {
    const db = createFakeDb({
      newsletter_subscribers: {
        'pending@example.com': { status: 'pending', isActive: false },
      },
    });

    await applyResendWebhookEvent({
      type: 'email.opened',
      data: { email: 'pending@example.com', email_id: 'msg_789' },
    }, { db: db as any });

    const subscriberSet = db.__sets.find(
      (s) => s.collection === 'newsletter_subscribers' && s.docId === 'pending@example.com',
    );
    expect(subscriberSet).toBeTruthy();
    expect(subscriberSet!.data.status).toBeUndefined();
    expect(subscriberSet!.data.isActive).toBeUndefined();
  });

  it('DOES promote confirmed subscribers normally on delivered event', async () => {
    const db = createFakeDb({
      newsletter_subscribers: {
        'confirmed@example.com': { status: 'confirmed', isActive: true },
      },
    });

    await applyResendWebhookEvent({
      type: 'email.delivered',
      data: { email: 'confirmed@example.com', email_id: 'msg_abc' },
    }, { db: db as any });

    const subscriberSet = db.__sets.find(
      (s) => s.collection === 'newsletter_subscribers' && s.docId === 'confirmed@example.com',
    );
    expect(subscriberSet).toBeTruthy();
    expect(subscriberSet!.data.status).toBe('confirmed');
    expect(subscriberSet!.data.isActive).toBe(true);
  });

  it('marks bounced subscribers as inactive regardless of current status', async () => {
    const db = createFakeDb({
      newsletter_subscribers: {
        'bounced@example.com': { status: 'confirmed', isActive: true },
      },
    });

    await applyResendWebhookEvent({
      type: 'email.bounced',
      data: { email: 'bounced@example.com', email_id: 'msg_bounce' },
    }, { db: db as any });

    const subscriberSet = db.__sets.find(
      (s) => s.collection === 'newsletter_subscribers' && s.docId === 'bounced@example.com',
    );
    expect(subscriberSet).toBeTruthy();
    expect(subscriberSet!.data.status).toBe('bounced');
    expect(subscriberSet!.data.isActive).toBe(false);
  });

  it('soft bounce (transient) on a job-alert subscriber does not set permanent bounced status', async () => {
    const db = createFakeDb({
      job_alert_subscribers: { 'seeker@example.com': { status: 'active', soft_bounce_count: 0 } },
    });

    const result = await applyResendWebhookEvent({
      type: 'email.bounced',
      data: {
        email: 'seeker@example.com',
        email_id: 'msg_ja_soft',
        tags: [
          { name: 'type', value: 'job-alert' },
          { name: 'alert_id', value: 'alert_1' },
        ],
        bounce: { type: 'transient', message: 'greylisted' },
      },
    }, { db: db as any });

    expect(result).toMatchObject({ handled: true, type: 'bounce', collection: 'job_alert_subscribers' });

    const subscriberSet = db.__sets.find(
      (s) => s.collection === 'job_alert_subscribers' && s.docId === 'seeker@example.com',
    );
    expect(subscriberSet!.data.status).not.toBe('bounced');
    expect(subscriberSet!.data.bounce_severity).toBe('soft');
    expect(subscriberSet!.data.soft_bounce_count).toBeDefined();
  });

  it('hard bounce (no transient/undetermined type) on a job-alert subscriber still sets permanent bounced status', async () => {
    const db = createFakeDb();

    const result = await applyResendWebhookEvent({
      type: 'email.bounced',
      data: {
        email: 'deadend@example.com',
        email_id: 'msg_ja_hard',
        tags: [
          { name: 'type', value: 'job-alert' },
          { name: 'alert_id', value: 'alert_2' },
        ],
        bounce: { message: 'user unknown' },
      },
    }, { db: db as any });

    expect(result).toMatchObject({ handled: true, type: 'bounce', collection: 'job_alert_subscribers' });

    const subscriberSet = db.__sets.find(
      (s) => s.collection === 'job_alert_subscribers' && s.docId === 'deadend@example.com',
    );
    expect(subscriberSet!.data.status).toBe('bounced');
  });

  it('marks complained subscribers as inactive', async () => {
    const db = createFakeDb({
      newsletter_subscribers: {
        'complainer@example.com': { status: 'confirmed', isActive: true },
      },
    });

    await applyResendWebhookEvent({
      type: 'email.complained',
      data: { email: 'complainer@example.com', email_id: 'msg_spam' },
    }, { db: db as any });

    const subscriberSet = db.__sets.find(
      (s) => s.collection === 'newsletter_subscribers' && s.docId === 'complainer@example.com',
    );
    expect(subscriberSet!.data.status).toBe('complained');
    expect(subscriberSet!.data.isActive).toBe(false);
  });

  it('handles new subscriber (no existing doc) — does not promote to confirmed', async () => {
    const db = createFakeDb(); // no existing docs

    await applyResendWebhookEvent({
      type: 'email.delivered',
      data: { email: 'new@example.com', email_id: 'msg_new' },
    }, { db: db as any });

    const subscriberSet = db.__sets.find(
      (s) => s.collection === 'newsletter_subscribers' && s.docId === 'new@example.com',
    );
    expect(subscriberSet).toBeTruthy();
    // null currentStatus is treated conservatively — no promotion
    expect(subscriberSet!.data.status).toBeUndefined();
  });

  // #3305 originally listed complained/suppressed/bounced together as "terminal".
  // That conflated two different things, and the machine-inferred half turned out
  // to be a ONE-WAY DOOR: a `suppressed` (provider list) or a `bounced` with a
  // soft/absent severity is an INFERENCE, and the delivered event that disproves
  // it could never take effect — 505 addresses were stuck that way in production.
  // The rule is now split by WHO decided (functions/src/lib/subscriberReactivation.js):
  // a human's decision is never overridden, a machine's is when disproven.
  const NEVER_RESURRECTED: Array<[string, Record<string, unknown>]> = [
    ['complained', { status: 'complained' }],
    // Not in the original #3305 list, and not in the pending/empty cases either,
    // so a delivered/open/click used to promote an unsubscribed subscriber
    // straight back to 'confirmed' + isActive:true. Same defect class.
    ['unsubscribed', { status: 'unsubscribed' }],
    ['hard-bounced', { status: 'bounced', bounce_severity: 'hard' }],
  ];

  it.each(NEVER_RESURRECTED)(
    'does NOT resurrect a %s subscriber back to confirmed on a later delivered event (#3305)',
    async (_label, seed) => {
      const db = createFakeDb({
        newsletter_subscribers: {
          'terminal@example.com': { ...seed, isActive: false, active: false },
        },
      });

      await applyResendWebhookEvent({
        type: 'email.delivered',
        data: { email: 'terminal@example.com', email_id: 'msg_resurrect' },
      }, { db: db as any });

      const subscriberSet = db.__sets.find(
        (s) => s.collection === 'newsletter_subscribers' && s.docId === 'terminal@example.com',
      );
      expect(subscriberSet).toBeTruthy();
      // Promotion must be skipped — status/isActive/active must NOT be
      // overwritten back to 'confirmed'/true for these statuses.
      expect(subscriberSet!.data.status).toBeUndefined();
      expect(subscriberSet!.data.isActive).toBeUndefined();
      expect(subscriberSet!.data.active).toBeUndefined();
    },
  );

  it.each(NEVER_RESURRECTED)(
    'does NOT resurrect a %s subscriber back to confirmed on a later open event (#3305)',
    async (_label, seed) => {
      const db = createFakeDb({
        newsletter_subscribers: {
          'terminal-open@example.com': { ...seed, isActive: false, active: false },
        },
      });

      await applyResendWebhookEvent({
        type: 'email.opened',
        data: { email: 'terminal-open@example.com', email_id: 'msg_resurrect_open' },
      }, { db: db as any });

      const subscriberSet = db.__sets.find(
        (s) => s.collection === 'newsletter_subscribers' && s.docId === 'terminal-open@example.com',
      );
      expect(subscriberSet).toBeTruthy();
      expect(subscriberSet!.data.status).toBeUndefined();
      expect(subscriberSet!.data.isActive).toBeUndefined();
    },
  );

  it.each(NEVER_RESURRECTED)(
    'does NOT resurrect a %s subscriber back to confirmed on a later click event (#3305)',
    async (_label, seed) => {
      const db = createFakeDb({
        newsletter_subscribers: {
          'terminal-click@example.com': { ...seed, isActive: false, active: false },
        },
      });

      await applyResendWebhookEvent({
        type: 'email.clicked',
        data: { email: 'terminal-click@example.com', email_id: 'msg_resurrect_click' },
      }, { db: db as any });

      const subscriberSet = db.__sets.find(
        (s) => s.collection === 'newsletter_subscribers' && s.docId === 'terminal-click@example.com',
      );
      expect(subscriberSet).toBeTruthy();
      expect(subscriberSet!.data.status).toBeUndefined();
      expect(subscriberSet!.data.isActive).toBeUndefined();
    },
  );

  it.each<[string, Record<string, unknown>]>([
    ['suppressed', { status: 'suppressed' }],
    ['soft-bounced', { status: 'bounced', bounce_severity: 'soft' }],
    ['bounced with no recorded severity (pre-classifier legacy doc)', { status: 'bounced' }],
  ])(
    'DOES recover a %s subscriber on a later delivered event (the mailbox answered)',
    async (_label, seed) => {
      const db = createFakeDb({
        newsletter_subscribers: {
          'recoverable@example.com': { ...seed, isActive: false, active: false },
        },
      });

      await applyResendWebhookEvent({
        type: 'email.delivered',
        data: { email: 'recoverable@example.com', email_id: 'msg_recover' },
      }, { db: db as any });

      const subscriberSet = db.__sets.find(
        (s) => s.collection === 'newsletter_subscribers' && s.docId === 'recoverable@example.com',
      );
      expect(subscriberSet!.data.status).toBe('active');
      expect(subscriberSet!.data.isActive).toBe(true);
      expect(subscriberSet!.data.recovered_from_status).toBe(seed.status);
      expect(subscriberSet!.data.recovered_by_event).toBe('delivered');
    },
  );

  it('rejects unsupported event types', async () => {
    const db = createFakeDb();
    const result = await applyResendWebhookEvent({
      type: 'email.unknown_type',
      data: { email: 'test@example.com' },
    }, { db: db as any });

    expect(result).toMatchObject({ handled: false, reason: 'unsupported_event_type' });
    expect(db.__sets.length).toBe(0);
    expect(db.__adds.length).toBe(0);
  });

  it('rejects events with missing email', async () => {
    const db = createFakeDb();
    const result = await applyResendWebhookEvent({
      type: 'email.delivered',
      data: {},
    }, { db: db as any });

    expect(result).toMatchObject({ handled: false, reason: 'missing_recipient' });
  });
});

describe('newsletterResendWebhookCore — malformed "Name <email>" recipient (root-cause fix)', () => {
  it('keys the subscriber doc by the bare address, not the raw "Name <email>" string', async () => {
    const db = createFakeDb();

    const result = await applyResendWebhookEvent({
      type: 'email.sent',
      data: {
        email: 'Mario Rossi <mario.rossi@example.com>',
        email_id: 'msg_456',
        tags: [{ name: 'campaign_id', value: 'weekly_2026-07-16' }],
      },
    }, { db: db as any });

    expect(result).toMatchObject({ handled: true, email: 'mario.rossi@example.com', type: 'send' });
    expect(db.__sets.some(
      (entry) => entry.collection === 'newsletter_subscribers' && entry.docId === 'mario.rossi@example.com',
    )).toBe(true);
    expect(db.__sets.some((entry) => entry.docId.includes('<'))).toBe(false);
  });
});

describe('newsletterResendWebhookCore — untagged sends do not collide on literal "unknown" (#4847)', () => {
  it('gives two untagged newsletter sends to the same recipient distinct campaign_deliveries docs', async () => {
    const db = createFakeDb();

    await applyResendWebhookEvent({
      type: 'email.sent',
      data: { email: 'untagged@example.com', email_id: 'msg_first' },
    }, { db: db as any });

    await applyResendWebhookEvent({
      type: 'email.sent',
      data: { email: 'untagged@example.com', email_id: 'msg_second' },
    }, { db: db as any });

    const deliveryDocIds = db.__sets
      .filter((entry) => entry.collection.endsWith('/campaign_deliveries'))
      .map((entry) => entry.docId);

    expect(deliveryDocIds.length).toBe(2);
    expect(new Set(deliveryDocIds).size).toBe(2);
    expect(deliveryDocIds.every((id) => id.includes('unknown'))).toBe(true);
  });

  it('gives two untagged job-alert sends to the same recipient distinct alert_deliveries docs', async () => {
    const db = createFakeDb();

    await applyResendWebhookEvent({
      type: 'email.sent',
      data: { email: 'alert@example.com', email_id: 'msg_alert_first', tags: [{ name: 'type', value: 'job-alert' }] },
    }, { db: db as any });

    await applyResendWebhookEvent({
      type: 'email.sent',
      data: { email: 'alert@example.com', email_id: 'msg_alert_second', tags: [{ name: 'type', value: 'job-alert' }] },
    }, { db: db as any });

    const deliveryDocIds = db.__sets
      .filter((entry) => entry.collection.endsWith('/alert_deliveries'))
      .map((entry) => entry.docId);

    expect(deliveryDocIds.length).toBe(2);
    expect(new Set(deliveryDocIds).size).toBe(2);
  });
});
