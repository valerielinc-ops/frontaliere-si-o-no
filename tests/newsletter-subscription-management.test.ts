import { describe, expect, it } from 'vitest';
import { verifyHmacToken, handleSubscriptionManagement } from '../functions/src/newsletterSubscriptionManagement.js';
import { createHmac } from 'node:crypto';

const TEST_SECRET = 'test-newsletter-secret-key-2026';
const TEST_EMAIL = 'user@example.com';
const VALID_TOKEN = createHmac('sha256', TEST_SECRET).update(TEST_EMAIL).digest('hex');

function createFakeDb(existingDocs: Record<string, Record<string, Record<string, unknown>>> = {}) {
  const sets: Array<{ collection: string; docId: string; data: Record<string, unknown>; options?: unknown }> = [];
  const adds: Array<{ collection: string; data: Record<string, unknown> }> = [];

  const makeCollection = (name: string) => ({
    doc: (docId: string) => ({
      set: async (data: Record<string, unknown>, options?: unknown) => {
        sets.push({ collection: name, docId, data, options });
      },
      get: async () => {
        const docData = existingDocs[name]?.[docId];
        return { exists: !!docData, data: () => docData || {} };
      },
      collection: (subName: string) => ({
        add: async (data: Record<string, unknown>) => {
          adds.push({ collection: `${name}/${docId}/${subName}`, data });
        },
      }),
    }),
    add: async (data: Record<string, unknown>) => {
      adds.push({ collection: name, data });
    },
  });

  return {
    collection: (name: string) => makeCollection(name),
    __sets: sets,
    __adds: adds,
  };
}

describe('verifyHmacToken', () => {
  it('returns true for valid HMAC token', () => {
    expect(verifyHmacToken(TEST_EMAIL, VALID_TOKEN, TEST_SECRET)).toBe(true);
  });

  it('returns false for invalid token', () => {
    expect(verifyHmacToken(TEST_EMAIL, 'invalid-token-value', TEST_SECRET)).toBe(false);
  });

  it('returns false for wrong email', () => {
    expect(verifyHmacToken('other@example.com', VALID_TOKEN, TEST_SECRET)).toBe(false);
  });

  it('returns false when secret is missing', () => {
    expect(verifyHmacToken(TEST_EMAIL, VALID_TOKEN, '')).toBe(false);
  });

  it('normalizes email to lowercase', () => {
    const upperToken = createHmac('sha256', TEST_SECRET).update('user@example.com').digest('hex');
    expect(verifyHmacToken('User@Example.COM', upperToken, TEST_SECRET)).toBe(true);
  });
});

describe('handleSubscriptionManagement', () => {
  it('unsubscribes with valid HMAC token', async () => {
    const db = createFakeDb({
      newsletter_subscribers: {
        [TEST_EMAIL]: { status: 'confirmed', isActive: true },
      },
    });

    const result = await handleSubscriptionManagement({
      action: 'unsubscribe',
      email: TEST_EMAIL,
      token: VALID_TOKEN,
      locale: 'it',
      secret: TEST_SECRET,
      db: db as any,
    });

    expect(result.status).toBe(200);
    expect(result.html).toContain('Disiscrizione');
    expect(result.html).toContain(TEST_EMAIL);

    const subscriberSet = db.__sets.find((s) => s.collection === 'newsletter_subscribers');
    expect(subscriberSet).toBeTruthy();
    expect(subscriberSet!.data.status).toBe('unsubscribed');
    expect(subscriberSet!.data.isActive).toBe(false);

    const event = db.__adds.find((a) => a.collection.includes('/events'));
    expect(event).toBeTruthy();
    expect(event!.data.event_type).toBe('unsubscribe');
  });

  it('resubscribes with valid HMAC token', async () => {
    const db = createFakeDb({
      newsletter_subscribers: {
        [TEST_EMAIL]: { status: 'unsubscribed', isActive: false },
      },
    });

    const result = await handleSubscriptionManagement({
      action: 'resubscribe',
      email: TEST_EMAIL,
      token: VALID_TOKEN,
      locale: 'it',
      secret: TEST_SECRET,
      db: db as any,
    });

    expect(result.status).toBe(200);
    expect(result.html).toContain('riattivat');

    const subscriberSet = db.__sets.find((s) => s.collection === 'newsletter_subscribers');
    expect(subscriberSet!.data.status).toBe('confirmed');
    expect(subscriberSet!.data.isActive).toBe(true);
  });

  it('rejects invalid HMAC token', async () => {
    const db = createFakeDb();

    const result = await handleSubscriptionManagement({
      action: 'unsubscribe',
      email: TEST_EMAIL,
      token: 'bad-token',
      locale: 'it',
      secret: TEST_SECRET,
      db: db as any,
    });

    expect(result.status).toBe(403);
    expect(result.html).toContain('Link non valido');
    expect(db.__sets.length).toBe(0);
    expect(db.__adds.length).toBe(0);
  });

  it('rejects invalid action', async () => {
    const db = createFakeDb();

    const result = await handleSubscriptionManagement({
      action: 'delete',
      email: TEST_EMAIL,
      token: VALID_TOKEN,
      locale: 'it',
      secret: TEST_SECRET,
      db: db as any,
    });

    expect(result.status).toBe(400);
  });

  it('rejects invalid email', async () => {
    const db = createFakeDb();

    const result = await handleSubscriptionManagement({
      action: 'unsubscribe',
      email: 'not-an-email',
      token: 'whatever',
      locale: 'it',
      secret: TEST_SECRET,
      db: db as any,
    });

    expect(result.status).toBe(400);
    expect(result.html).toContain('Parametri mancanti');
  });
});
