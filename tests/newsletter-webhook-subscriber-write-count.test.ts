import { describe, expect, it, vi } from 'vitest';

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    delete: () => ({ __fieldValue: 'delete' }),
    increment: (amount: number) => ({ __fieldValue: 'increment', amount }),
    serverTimestamp: () => ({ __fieldValue: 'serverTimestamp' }),
  },
  getFirestore: vi.fn(),
}));

import { persistMailerooEvent } from '../functions/src/newsletterMailerooWebhookCore.js';
import { persistMailgunEvent } from '../functions/src/newsletterMailgunWebhookCore.js';
import { persistMailjetEvent } from '../functions/src/newsletterMailjetWebhookCore.js';
import { persistMailtrapEvent } from '../functions/src/newsletterMailtrapWebhookCore.js';
import { applyResendWebhookEvent } from '../functions/src/newsletterResendWebhookCore.js';

const EMAIL = 'cost-check@example.com';

function createDb() {
  const docs = new Map<string, Record<string, unknown>>([
    [`newsletter_subscribers/${EMAIL}`, {
      status: 'confirmed',
      send_count: 10,
      open_count: 5,
      click_count: 0,
      last_open_at: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000),
      engagement_score: 0,
      engagement_level: 'dormant',
    }],
  ]);
  const writes: Array<{ path: string; data: Record<string, unknown> }> = [];
  const eventHistory = [1, 2].map((daysAgo) => ({
    event_type: 'open',
    occurred_at: new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString(),
  }));

  const makeCollection = (path: string) => {
    const query = {
      where: () => query,
      orderBy: () => query,
      limit: () => query,
      get: async () => ({
        docs: path === `newsletter_subscribers/${EMAIL}/events`
          ? eventHistory.map((data) => ({ data: () => data }))
          : [],
      }),
    };

    return {
      doc(id: string) {
        const docPath = `${path}/${id}`;
        const ref: any = {
          path: docPath,
          get: async () => ({
            exists: docs.has(docPath),
            data: () => docs.get(docPath),
          }),
          set: async (data: Record<string, unknown>, options?: { merge?: boolean }) => {
            writes.push({ path: docPath, data });
            docs.set(docPath, options?.merge ? { ...(docs.get(docPath) || {}), ...data } : data);
          },
          create: async (data: Record<string, unknown>) => {
            writes.push({ path: docPath, data });
            docs.set(docPath, data);
          },
          collection: (name: string) => makeCollection(`${docPath}/${name}`),
          where: query.where,
          orderBy: query.orderBy,
          limit: query.limit,
          add: async (data: Record<string, unknown>) => {
            const addedPath = `${docPath}/auto-${writes.length}`;
            writes.push({ path: addedPath, data });
            docs.set(addedPath, data);
          },
        };
        ref.firestore = db;
        return ref;
      },
      ...query,
      add: async (data: Record<string, unknown>) => {
        const addedPath = `${path}/auto-${writes.length}`;
        writes.push({ path: addedPath, data });
        docs.set(addedPath, data);
      },
    };
  };

  const db: any = {
    collection: (name: string) => makeCollection(name),
    runTransaction: async (updateFunction: (transaction: any) => Promise<unknown>) => updateFunction({
      get: async (ref: any) => ref.get(),
      set: (ref: any, data: Record<string, unknown>, options?: { merge?: boolean }) => ref.set(data, options),
      create: (ref: any, data: Record<string, unknown>) => ref.create(data),
    }),
    __writes: writes,
    __docs: docs,
  };

  return db;
}

const webhookCases = [
  ['Mailgun', (db: any, timestamp: number, type: 'open' | 'click') => persistMailgunEvent(db, {
    event: type === 'open' ? 'opened' : 'clicked', recipient: EMAIL, timestamp, url: 'https://example.test/article',
  })],
  ['Mailjet', (db: any, timestamp: number, type: 'open' | 'click') => persistMailjetEvent(db, {
    event: type, email: EMAIL, time: timestamp, url: 'https://example.test/article',
  })],
  ['Mailtrap', (db: any, timestamp: number, type: 'open' | 'click') => persistMailtrapEvent(db, {
    event: type, email: EMAIL, timestamp, url: 'https://example.test/article',
  })],
  ['Maileroo', (db: any, timestamp: number, type: 'open' | 'click') => persistMailerooEvent(db, {
    event_type: type === 'open' ? 'opened' : 'clicked', event_id: `cost-check-${type}`, event_time: timestamp,
    event_data: { to: EMAIL, original_url: 'https://example.test/article' },
  })],
  ['Resend', (db: any, timestamp: number, type: 'open' | 'click') => applyResendWebhookEvent({
    type: type === 'open' ? 'email.opened' : 'email.clicked',
    data: {
      email: EMAIL,
      created_at: new Date(timestamp * 1000).toISOString(),
      ...(type === 'click' ? { click: { link: 'https://example.test/article', section_id: 'article' } } : {}),
    },
  }, { db })],
];

describe('newsletter webhook subscriber write cost', () => {
  it.each(webhookCases)('%s records open and click metrics with one parent write per event', async (_provider, deliver) => {
    const timestamp = Math.floor(Date.now() / 1000);

    for (const type of ['open', 'click'] as const) {
      const db = createDb();
      await deliver(db, timestamp, type);

      const parentWrites = db.__writes.filter((write: { path: string }) => write.path === `newsletter_subscribers/${EMAIL}`);
      expect(parentWrites).toHaveLength(1);
      expect(parentWrites[0].data).toMatchObject({
        engagement_score: type === 'open' ? 70 : 85,
        engagement_level: 'hot',
        preferred_send_sample_count: 3,
      });
      if (type === 'open') {
        expect(parentWrites[0].data.open_count).toEqual(expect.objectContaining({ __fieldValue: 'increment', amount: 1 }));
      } else {
        expect(parentWrites[0].data.click_count).toEqual(expect.objectContaining({ __fieldValue: 'increment', amount: 1 }));
      }
      expect(parentWrites[0].data.preferred_send_hour_buffer).toHaveLength(3);
    }
  });
});
