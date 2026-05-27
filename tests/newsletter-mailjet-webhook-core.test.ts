import { describe, expect, it } from 'vitest';
import { persistMailjetEvent, handleMailjetWebhookRequest } from '../functions/src/newsletterMailjetWebhookCore.js';

/**
 * Fake Firestore db that captures all set/add calls for assertion.
 */
function createFakeDb() {
  const sets: Array<{ collection: string; docId: string; data: Record<string, unknown> }> = [];
  const adds: Array<{ collection: string; data: Record<string, unknown> }> = [];

  const makeCollection = (name: string) => ({
    doc: (docId: string) => ({
      set: async (data: Record<string, unknown>, _opts?: unknown) => {
        sets.push({ collection: name, docId, data });
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
        };
      },
    }),
  });

  return {
    collection(name: string) {
      return makeCollection(name);
    },
    __sets: sets,
    __adds: adds,
  };
}

describe('newsletterMailjetWebhookCore', () => {
  describe('persistMailjetEvent', () => {
    it('processes a "sent" event and stores subscriber + delivery + event', async () => {
      const db = createFakeDb();

      const result = await persistMailjetEvent(db as any, {
        event: 'sent',
        time: 1700000000,
        email: 'User@Example.com',
        MessageID: 12345678901234,
        Message_GUID: 'abc-def-123',
        mj_campaign_id: 7257,
        CustomID: 'weekly_2026-04-01',
      });

      expect(result).toMatchObject({
        processed: true,
        type: 'send',
        email: 'user@example.com',
        campaignId: 'weekly_2026-04-01',
      });

      // Campaign delivery doc created
      expect(db.__sets.some(s =>
        s.collection.includes('/campaign_deliveries') &&
        s.data.provider === 'mailjet' &&
        s.data.campaign_id === 'weekly_2026-04-01',
      )).toBe(true);

      // Event log appended
      expect(db.__adds.some(a =>
        a.collection.includes('/events') &&
        a.data.event_type === 'send' &&
        a.data.mailjet_event === 'sent' &&
        a.data.provider === 'mailjet',
      )).toBe(true);
    });

    it('processes a "click" event with URL', async () => {
      const db = createFakeDb();

      const result = await persistMailjetEvent(db as any, {
        event: 'click',
        time: 1700000100,
        email: 'clicker@example.com',
        MessageID: 99999,
        CustomID: 'weekly_2026-04-01',
        url: 'https://frontaliereticino.ch/cerca-lavoro-ticino/',
        ip: '1.2.3.4',
        geo: 'CH',
        agent: 'Mozilla/5.0',
      });

      expect(result).toMatchObject({
        processed: true,
        type: 'click',
        email: 'clicker@example.com',
      });

      // Delivery doc has click data
      const deliverySet = db.__sets.find(s => s.collection.includes('/campaign_deliveries'));
      expect(deliverySet?.data.last_clicked_url).toBe('https://frontaliereticino.ch/cerca-lavoro-ticino/');

      // Event metadata has click details
      const eventAdd = db.__adds.find(a => a.collection.includes('/events'));
      expect((eventAdd?.data.metadata as any)?.url).toBe('https://frontaliereticino.ch/cerca-lavoro-ticino/');
      expect((eventAdd?.data.metadata as any)?.geo).toBe('CH');
    });

    it('processes "open" event', async () => {
      const db = createFakeDb();

      const result = await persistMailjetEvent(db as any, {
        event: 'open',
        time: 1700000200,
        email: 'opener@example.com',
        MessageID: 55555,
        CustomID: 'weekly_2026-04-01',
        ip: '5.6.7.8',
        geo: 'IT',
      });

      expect(result).toMatchObject({ processed: true, type: 'open' });

      const deliverySet = db.__sets.find(s => s.collection.includes('/campaign_deliveries'));
      expect(deliverySet?.data.opened_at).toBeTruthy();
    });

    it('processes "bounce" event and marks subscriber as bounced', async () => {
      const db = createFakeDb();

      const result = await persistMailjetEvent(db as any, {
        event: 'bounce',
        time: 1700000300,
        email: 'bounced@example.com',
        MessageID: 11111,
        hard_bounce: true,
        blocked: false,
        error_related_to: 'recipient',
        error: 'user unknown',
      });

      expect(result).toMatchObject({ processed: true, type: 'bounce' });

      // Subscriber marked as bounced
      const subscriberSet = db.__sets.find(s =>
        s.collection === 'newsletter_subscribers' && s.docId === 'bounced@example.com',
      );
      expect(subscriberSet?.data.status).toBe('bounced');
      expect(subscriberSet?.data.bounce_reason).toBe('user unknown');
      expect(subscriberSet?.data.bounce_hard).toBe(true);
    });

    it('processes "blocked" event as bounce', async () => {
      const db = createFakeDb();

      const result = await persistMailjetEvent(db as any, {
        event: 'blocked',
        email: 'blocked@example.com',
      });

      expect(result).toMatchObject({ processed: true, type: 'bounce' });
    });

    it('processes "spam" event and marks subscriber as complained', async () => {
      const db = createFakeDb();

      const result = await persistMailjetEvent(db as any, {
        event: 'spam',
        email: 'spammer@example.com',
        source: 'JMRPP',
      });

      expect(result).toMatchObject({ processed: true, type: 'complaint' });

      const subscriberSet = db.__sets.find(s =>
        s.collection === 'newsletter_subscribers',
      );
      expect(subscriberSet?.data.status).toBe('complained');
    });

    it('processes "unsub" event and marks subscriber as unsubscribed', async () => {
      const db = createFakeDb();

      const result = await persistMailjetEvent(db as any, {
        event: 'unsub',
        email: 'unsub@example.com',
        mj_campaign_id: 9999,
      });

      expect(result).toMatchObject({ processed: true, type: 'unsubscribed' });

      const subscriberSet = db.__sets.find(s =>
        s.collection === 'newsletter_subscribers',
      );
      expect(subscriberSet?.data.status).toBe('unsubscribed');
    });

    it('skips events with invalid email', async () => {
      const db = createFakeDb();

      const result = await persistMailjetEvent(db as any, {
        event: 'sent',
        email: '',
      });

      expect(result).toMatchObject({ skipped: true, reason: 'invalid_email' });
      expect(db.__sets.length).toBe(0);
      expect(db.__adds.length).toBe(0);
    });

    it('skips unknown event types', async () => {
      const db = createFakeDb();

      const result = await persistMailjetEvent(db as any, {
        event: 'unknown_type',
        email: 'test@example.com',
      });

      expect(result).toMatchObject({ skipped: true, reason: 'unknown_event: unknown_type' });
    });

    it('uses mj_campaign_id as fallback when CustomID is missing', async () => {
      const db = createFakeDb();

      const result = await persistMailjetEvent(db as any, {
        event: 'sent',
        email: 'test@example.com',
        mj_campaign_id: 42,
      });

      expect(result.campaignId).toBe('42');
    });

    it('uses customcampaign as second fallback', async () => {
      const db = createFakeDb();

      const result = await persistMailjetEvent(db as any, {
        event: 'sent',
        email: 'test@example.com',
        customcampaign: 'my-campaign',
      });

      expect(result.campaignId).toBe('my-campaign');
    });

    it('normalizes email to lowercase', async () => {
      const db = createFakeDb();

      await persistMailjetEvent(db as any, {
        event: 'open',
        email: 'TeSt@ExAmPlE.COM',
      });

      const eventAdd = db.__adds.find(a => a.collection.includes('/events'));
      expect(eventAdd?.data.email).toBe('test@example.com');
    });
  });

  describe('handleMailjetWebhookRequest', () => {
    it('rejects when webhook secret does not match', async () => {
      await expect(
        handleMailjetWebhookRequest({
          body: [{ event: 'sent', email: 'test@example.com' }],
          query: { secret: 'wrong' },
          webhookSecret: 'correct-secret',
          db: null as any,
        }),
      ).rejects.toThrow('Invalid Mailjet webhook secret');
    });

    it('rejects when webhook secret is missing from query', async () => {
      await expect(
        handleMailjetWebhookRequest({
          body: [{ event: 'sent', email: 'test@example.com' }],
          query: {},
          webhookSecret: 'correct-secret',
          db: null as any,
        }),
      ).rejects.toThrow('Invalid Mailjet webhook secret');
    });

    it('processes batch of events when no secret is configured', async () => {
      const db = createFakeDb();
      // When MAILJET_WEBHOOK_SECRET is empty in Remote Config, skip verification
      const result = await handleMailjetWebhookRequest({
        body: [
          { event: 'sent', email: 'a@example.com', CustomID: 'c1' },
          { event: 'open', email: 'b@example.com', CustomID: 'c1' },
        ],
        query: {},
        webhookSecret: '',
        db: db as any,
      });

      expect(result.total).toBe(2);
      expect(result.processed).toBe(2);
    });

    it('wraps single event object in array', async () => {
      const db = createFakeDb();
      const result = await handleMailjetWebhookRequest({
        body: { event: 'sent', email: 'single@example.com' },
        query: {},
        webhookSecret: '',
        db: db as any,
      });

      expect(result.total).toBe(1);
      expect(result.processed).toBe(1);
    });

    it('handles empty body gracefully', async () => {
      const result = await handleMailjetWebhookRequest({
        body: [],
        query: {},
        webhookSecret: '',
        db: null as any,
      });

      expect(result.processed).toBe(0);
      expect(result.total).toBeUndefined();
    });
  });
});
