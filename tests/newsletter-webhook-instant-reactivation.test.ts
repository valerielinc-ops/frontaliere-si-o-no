/**
 * Regression tests for issue #2852 item 2 — instant webhook reactivation.
 *
 * scripts/lib/subscriberSunset.mjs's classifySunset() puts never-engaging
 * newsletter subscribers into a soft `status: 'inactive'` state. Before this
 * fix, an 'inactive' subscriber who opened/clicked an email only got flipped
 * back to 'active' on the NEXT weekly run of scripts/newsletter-sunset.mjs —
 * up to a week of continued (wrong) exclusion from sends despite having just
 * re-engaged. Each ESP webhook handler now applies the same reactivation
 * transition immediately: status -> 'active', stamp reactivated_at, clear
 * winback_sent_at/winback_pending (functions/src/lib/subscriberReactivation.js).
 *
 * Covers all 5 provider webhook cores (sibling-pattern-fix discipline,
 * AGENTS.md #6) plus the shared helper directly.
 */
import admin from 'firebase-admin';
import { describe, expect, it } from 'vitest';

import { instantReactivationFields } from '../functions/src/lib/subscriberReactivation.js';
import { persistMailgunEvent } from '../functions/src/newsletterMailgunWebhookCore.js';
import { persistMailerooEvent } from '../functions/src/newsletterMailerooWebhookCore.js';
import { persistMailjetEvent } from '../functions/src/newsletterMailjetWebhookCore.js';
import { persistMailtrapEvent } from '../functions/src/newsletterMailtrapWebhookCore.js';
import { applyResendWebhookEvent } from '../functions/src/newsletterResendWebhookCore.js';

// ── Shared fake Firestore (same shape used by the existing provider test files) ──
function createFakeDb(existingDocs: Record<string, Record<string, Record<string, unknown>>> = {}) {
  const sets: Array<{ collection: string; docId: string; data: Record<string, unknown> }> = [];
  const adds: Array<{ collection: string; data: Record<string, unknown> }> = [];

  const makeCollection = (name: string): any => ({
    doc: (docId: string) => ({
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
              return { exists: !!docData, data: () => docData || undefined };
            },
          }),
          add: async (data: Record<string, unknown>) => {
            adds.push({ collection: subPath, data });
          },
        };
      },
    }),
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

function subscriberUpdateFor(db: ReturnType<typeof createFakeDb>, email: string) {
  const entries = db.__sets.filter((e) => e.collection === 'newsletter_subscribers' && e.docId === email);
  // The main subscriber-status write is always the FIRST set() on this doc —
  // refreshEngagementScore() (called right after) issues its own separate
  // set() with only engagement_score/engagement_level fields.
  return entries[0]?.data;
}

function isDeleteSentinel(value: unknown): boolean {
  return !!value && admin.firestore.FieldValue.delete().isEqual(value as any);
}

describe('instantReactivationFields (shared helper)', () => {
  it('returns reactivation fields only when current status is exactly "inactive"', () => {
    const fields = instantReactivationFields('inactive');
    expect(fields.status).toBe('active');
    expect(fields.reactivated_at).toBeTruthy();
    expect(isDeleteSentinel(fields.winback_sent_at)).toBe(true);
    expect(isDeleteSentinel(fields.winback_pending)).toBe(true);
  });

  it.each([undefined, null, '', 'confirmed', 'active', 'bounced', 'complained', 'unsubscribed', 'suppressed', 'pending'])(
    'is a no-op for status %j',
    (status) => {
      expect(instantReactivationFields(status as any)).toEqual({});
    },
  );
});

describe('newsletterMailgunWebhookCore — instant reactivation (#2852 item 2)', () => {
  it('reactivates an inactive subscriber on open', async () => {
    const email = 'inactive-mailgun@example.com';
    const db = createFakeDb({ newsletter_subscribers: { [email]: { status: 'inactive', winback_sent_at: 'ts', winback_pending: true } } });

    await persistMailgunEvent(db as any, {
      event: 'opened',
      recipient: email,
      timestamp: 1700000000,
      tags: [],
    });

    const update = subscriberUpdateFor(db, email)!;
    expect(update.status).toBe('active');
    expect(update.reactivated_at).toBeTruthy();
    expect(isDeleteSentinel(update.winback_sent_at)).toBe(true);
    expect(isDeleteSentinel(update.winback_pending)).toBe(true);
  });

  it('leaves an already-confirmed subscriber untouched on click', async () => {
    const email = 'confirmed-mailgun@example.com';
    const db = createFakeDb({ newsletter_subscribers: { [email]: { status: 'confirmed' } } });

    await persistMailgunEvent(db as any, {
      event: 'clicked',
      recipient: email,
      timestamp: 1700000000,
      url: 'https://frontaliereticino.ch/',
      tags: [],
    });

    const update = subscriberUpdateFor(db, email)!;
    expect(update.status).toBeUndefined();
    expect(update.reactivated_at).toBeUndefined();
  });

  it('does not reactivate a hard-suppressed (bounced) subscriber on a stray open', async () => {
    const email = 'bounced-mailgun@example.com';
    const db = createFakeDb({ newsletter_subscribers: { [email]: { status: 'bounced' } } });

    await persistMailgunEvent(db as any, { event: 'opened', recipient: email, timestamp: 1700000000, tags: [] });

    const update = subscriberUpdateFor(db, email)!;
    expect(update.status).toBeUndefined();
  });
});

describe('newsletterMailerooWebhookCore — instant reactivation (#2852 item 2)', () => {
  it('reactivates an inactive subscriber on click', async () => {
    const email = 'inactive-maileroo@example.com';
    const db = createFakeDb({ newsletter_subscribers: { [email]: { status: 'inactive' } } });

    await persistMailerooEvent(db as any, {
      event_type: 'clicked',
      event_time: 1700000000,
      tags: {},
      event_data: { to: email, original_url: 'https://frontaliereticino.ch/' },
    });

    const update = subscriberUpdateFor(db, email)!;
    expect(update.status).toBe('active');
    expect(update.reactivated_at).toBeTruthy();
    expect(isDeleteSentinel(update.winback_sent_at)).toBe(true);
  });
});

describe('newsletterMailjetWebhookCore — instant reactivation (#2852 item 2)', () => {
  it('reactivates an inactive subscriber on open', async () => {
    const email = 'inactive-mailjet@example.com';
    const db = createFakeDb({ newsletter_subscribers: { [email]: { status: 'inactive' } } });

    await persistMailjetEvent(db as any, { event: 'open', email, time: 1700000000 });

    const update = subscriberUpdateFor(db, email)!;
    expect(update.status).toBe('active');
    expect(update.reactivated_at).toBeTruthy();
    expect(isDeleteSentinel(update.winback_sent_at)).toBe(true);
  });
});

describe('newsletterMailtrapWebhookCore — instant reactivation (#2852 item 2)', () => {
  it('reactivates an inactive subscriber on click', async () => {
    const email = 'inactive-mailtrap@example.com';
    const db = createFakeDb({ newsletter_subscribers: { [email]: { status: 'inactive' } } });

    await persistMailtrapEvent(db as any, { event: 'click', email, url: 'https://frontaliereticino.ch/', timestamp: 1700000000 });

    const update = subscriberUpdateFor(db, email)!;
    expect(update.status).toBe('active');
    expect(update.reactivated_at).toBeTruthy();
    expect(isDeleteSentinel(update.winback_sent_at)).toBe(true);
  });
});

describe('newsletterResendWebhookCore — instant reactivation (#2852 item 2)', () => {
  it('reactivates an inactive subscriber on open, overriding the plain "confirmed" promotion', async () => {
    const email = 'inactive-resend@example.com';
    const db = createFakeDb({ newsletter_subscribers: { [email]: { status: 'inactive' } } });

    await applyResendWebhookEvent(
      {
        type: 'email.opened',
        data: { email, email_id: 'msg_1', tags: [{ name: 'campaign_id', value: 'weekly_1' }] },
      },
      { db: db as any },
    );

    const update = subscriberUpdateFor(db, email)!;
    // Without the fix, buildSubscriberUpdate()'s pending-promotion side effect
    // would leave this at 'confirmed' with no reactivated_at / winback clear.
    expect(update.status).toBe('active');
    expect(update.reactivated_at).toBeTruthy();
    expect(isDeleteSentinel(update.winback_sent_at)).toBe(true);
    expect(isDeleteSentinel(update.winback_pending)).toBe(true);
  });

  it('does not reactivate a pending (unconfirmed) subscriber', async () => {
    const email = 'pending-resend@example.com';
    const db = createFakeDb({ newsletter_subscribers: { [email]: { status: 'pending' } } });

    await applyResendWebhookEvent(
      { type: 'email.opened', data: { email, email_id: 'msg_2', tags: [{ name: 'campaign_id', value: 'weekly_1' }] } },
      { db: db as any },
    );

    const update = subscriberUpdateFor(db, email)!;
    expect(update.status).toBeUndefined();
    expect(update.reactivated_at).toBeUndefined();
  });
});
