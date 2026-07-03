import { describe, expect, it } from 'vitest';
import { handleNewsletterSubscriberCreated } from '../functions/src/jobAlertBackfillTrigger.js';

interface AlertDoc {
  id: string;
  active?: boolean;
}

function fakeDb({
  existingAlerts = [] as AlertDoc[],
  parentExists = false,
}: { existingAlerts?: AlertDoc[]; parentExists?: boolean } = {}) {
  const writes: Array<{ path: string; payload: Record<string, unknown>; merge: boolean }> = [];

  return {
    writes,
    collection: () => ({
      doc: (email: string) => ({
        collection: () => ({
          get: async () => ({
            docs: existingAlerts.map((a) => ({ id: a.id, data: () => a })),
          }),
          doc: (alertId: string) => ({
            set: async (payload: Record<string, unknown>, opts: { merge: boolean }) => {
              writes.push({ path: `job_alert_subscribers/${email}/alerts/${alertId}`, payload, merge: opts.merge });
            },
          }),
        }),
        get: async () => ({ exists: parentExists }),
        set: async (payload: Record<string, unknown>, opts: { merge: boolean }) => {
          writes.push({ path: `job_alert_subscribers/${email}`, payload, merge: opts.merge });
        },
      }),
    }),
  };
}

describe('handleNewsletterSubscriberCreated — meta sentinel', () => {
  it('is a no-op for the _meta_ doc', async () => {
    const db = fakeDb();
    const result = await handleNewsletterSubscriberCreated('_meta_', {}, { db: db as any });
    expect(result).toEqual({ created: false, reason: 'meta_sentinel' });
    expect(db.writes).toHaveLength(0);
  });
});

describe('handleNewsletterSubscriberCreated — skip reasons', () => {
  it('skips a subscriber with no job or location signal', async () => {
    const db = fakeDb();
    const result = await handleNewsletterSubscriberCreated('a@b.ch', {}, { db: db as any });
    expect(result).toEqual({ created: false, reason: 'no-signal' });
    expect(db.writes).toHaveLength(0);
  });

  it('skips a suppressed/unsubscribed subscriber even with job signal', async () => {
    const db = fakeDb();
    const result = await handleNewsletterSubscriberCreated(
      'a@b.ch',
      { job_category: 'tech', status: 'unsubscribed' },
      { db: db as any },
    );
    expect(result).toEqual({ created: false, reason: 'suppressed' });
  });
});

describe('handleNewsletterSubscriberCreated — cap enforcement', () => {
  it('skips when the subscriber already has MAX_ALERTS_PER_USER active alerts', async () => {
    const db = fakeDb({
      existingAlerts: [
        { id: 'alert-1', active: true },
        { id: 'alert-2', active: true },
        { id: 'alert-3', active: true },
      ],
    });
    const result = await handleNewsletterSubscriberCreated('a@b.ch', { job_category: 'tech' }, { db: db as any });
    expect(result).toEqual({ created: false, reason: 'capped' });
    expect(db.writes).toHaveLength(0);
  });

  it('does not count inactive alerts toward the cap', async () => {
    const db = fakeDb({
      existingAlerts: [
        { id: 'alert-1', active: false },
        { id: 'alert-2', active: false },
        { id: 'alert-3', active: false },
      ],
    });
    const result = await handleNewsletterSubscriberCreated('a@b.ch', { job_category: 'tech' }, { db: db as any });
    expect(result.created).toBe(true);
  });
});

describe('handleNewsletterSubscriberCreated — creation', () => {
  it('creates an alert for a job-signal subscriber', async () => {
    const db = fakeDb();
    const result = await handleNewsletterSubscriberCreated(
      'a@b.ch',
      { job_category: 'tech', source_channel: 'job_gate' },
      { db: db as any },
    );
    expect(result.created).toBe(true);
    expect(result.tier).toBe('newsletter_subscribers:job_gate');
    const alertWrite = db.writes.find((w) => w.path.includes('/alerts/backfill-newsletter'));
    expect(alertWrite).toBeDefined();
    expect(alertWrite?.payload.active).toBe(true);
    expect(alertWrite?.payload.keywords).toEqual([]);
  });

  it('creates a location-fallback alert when there is no job signal but a location one', async () => {
    const db = fakeDb();
    const result = await handleNewsletterSubscriberCreated(
      'a@b.ch',
      { location_interest: 'Lugano', source_channel: 'popup' },
      { db: db as any },
    );
    expect(result.created).toBe(true);
    expect(result.tier).toBe('newsletter_subscribers:popup:location-fallback');
  });

  it('never reactivates an alert the user already disabled', async () => {
    const db = fakeDb({ existingAlerts: [{ id: 'backfill-newsletter', active: false }] });
    const result = await handleNewsletterSubscriberCreated('a@b.ch', { job_category: 'tech' }, { db: db as any });
    expect(result.created).toBe(true);
    const alertWrite = db.writes.find((w) => w.path.includes('/alerts/backfill-newsletter'));
    expect(alertWrite?.payload.active).toBe(false);
  });

  it('does not overwrite created_at on an already-existing parent doc', async () => {
    const db = fakeDb({ parentExists: true });
    await handleNewsletterSubscriberCreated('a@b.ch', { job_category: 'tech' }, { db: db as any });
    const parentWrite = db.writes.find((w) => w.path === 'job_alert_subscribers/a@b.ch');
    expect(parentWrite?.payload).not.toHaveProperty('created_at');
  });
});
