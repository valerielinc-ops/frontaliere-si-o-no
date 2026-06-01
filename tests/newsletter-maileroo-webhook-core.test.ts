import { describe, expect, it } from 'vitest';
import {
  persistMailerooEvent,
  verifyMailerooSignature,
} from '../functions/src/newsletterMailerooWebhookCore.js';
import crypto from 'crypto';

function createFakeDb(existingDocs: Record<string, Record<string, Record<string, unknown>>> = {}) {
  const sets: Array<{ collection: string; docId: string; data: Record<string, unknown> }> = [];
  const adds: Array<{ collection: string; data: Record<string, unknown> }> = [];

  const makeCollection = (name: string) => ({
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
