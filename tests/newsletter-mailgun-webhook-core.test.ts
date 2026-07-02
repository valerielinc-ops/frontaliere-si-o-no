import { describe, expect, it } from 'vitest';
import { persistMailgunEvent } from '../functions/src/newsletterMailgunWebhookCore.js';

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
  });

  return {
    collection(name: string) {
      return makeCollection(name);
    },
    __sets: sets,
    __adds: adds,
  };
}

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
