import { describe, expect, it } from 'vitest';
import { verifyHmacToken, handleSubscriptionManagement, normalizeCompanyAlertKey } from '../functions/src/newsletterSubscriptionManagement.js';
import { createHmac } from 'node:crypto';

const TEST_SECRET = 'test-newsletter-secret-key-2026';
const TEST_EMAIL = 'user@example.com';
const VALID_TOKEN = createHmac('sha256', TEST_SECRET).update(TEST_EMAIL).digest('hex');

function createFakeDb(existingDocs: Record<string, any> = {}, subcollectionDocs: Record<string, any> = {}) {
  const sets: Array<{ collection: string; docId: string; data: Record<string, unknown>; options?: unknown }> = [];
  const adds: Array<{ collection: string; data: Record<string, unknown> }> = [];
  const deletes: Array<{ collection: string; docId: string }> = [];

  const getSubDocs = (name: string, docId: string, subName: string): Record<string, Record<string, unknown>> => {
    subcollectionDocs[name] ||= {};
    subcollectionDocs[name][docId] ||= {};
    subcollectionDocs[name][docId][subName] ||= {};
    return subcollectionDocs[name][docId][subName];
  };

  const makeCollection = (name: string): any => ({
    doc: (docId: string): any => ({
      set: async (data: Record<string, unknown>, options?: unknown) => {
        sets.push({ collection: name, docId, data, options });
        existingDocs[name] ||= {};
        existingDocs[name][docId] = { ...(existingDocs[name][docId] || {}), ...data };
      },
      get: async () => {
        const docData = existingDocs[name]?.[docId];
        return { exists: !!docData, data: () => docData || {} };
      },
      delete: async () => {
        deletes.push({ collection: name, docId });
        delete existingDocs[name]?.[docId];
      },
      collection: (subName: string): any => ({
        add: async (data: Record<string, unknown>) => {
          adds.push({ collection: `${name}/${docId}/${subName}`, data });
          const subDocs = getSubDocs(name, docId, subName);
          const id = `new-${Object.keys(subDocs).length + 1}`;
          subDocs[id] = { ...data };
          return {
            id,
            get: async () => ({ exists: true, data: () => subDocs[id] }),
          };
        },
        get: async () => {
          const entries = Object.entries(getSubDocs(name, docId, subName));
          return {
            forEach: (cb: (doc: { id: string; data: () => Record<string, unknown> }) => void) => {
              entries.forEach(([id, data]) => cb({ id, data: () => data }));
            },
          };
        },
        doc: (childId: string): any => {
          const subDocs = getSubDocs(name, docId, subName);
          return {
            id: childId,
            set: async (data: Record<string, unknown>, options?: unknown) => {
              sets.push({ collection: `${name}/${docId}/${subName}`, docId: childId, data, options });
              subDocs[childId] = options ? { ...(subDocs[childId] || {}), ...data } : { ...data };
            },
            get: async () => ({ exists: !!subDocs[childId], data: () => subDocs[childId] || {} }),
            delete: async () => {
              deletes.push({ collection: `${name}/${docId}/${subName}`, docId: childId });
              delete subDocs[childId];
            },
          };
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
    __deletes: deletes,
    __subcollectionDocs: subcollectionDocs,
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
  it('uses the canonical brand aliases at the token boundary', () => {
    expect(normalizeCompanyAlertKey('Migros Ticino')).toBe('migros');
    expect(normalizeCompanyAlertKey('gruppo-migros')).toBe('migros');
    expect(normalizeCompanyAlertKey('Guess Ticino')).toBe('guess-europe-sagl');
    expect(normalizeCompanyAlertKey('guess-europe-switzerland')).toBe('guess-europe-sagl');
  });

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

  it('resubscribes with valid HMAC token on a POST', async () => {
    // POST since #5711: the token is necessary but no longer sufficient, because
    // a link-following scanner gets the token for free — it is in the URL of the
    // page it is scanning. See tests/newsletter-resubscribe-post.test.ts.
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
      method: 'POST',
      db: db as any,
    });

    expect(result.status).toBe(200);
    expect(result.html).toContain('riattivat');

    const subscriberSet = db.__sets.find((s) => s.collection === 'newsletter_subscribers');
    expect(subscriberSet!.data.status).toBe('confirmed');
    expect(subscriberSet!.data.isActive).toBe(true);
  });

  it('reactivates the job-alert parent when a new alert is created after account deletion', async () => {
    const db = createFakeDb({
      job_alert_subscribers: {
        [TEST_EMAIL]: {
          status: 'inactive',
          isActive: false,
          active: false,
          account_deleted_at: '2026-08-01T09:00:00.000Z',
        },
      },
    });

    const result = await handleSubscriptionManagement({
      action: 'create_alert',
      email: TEST_EMAIL,
      token: VALID_TOKEN,
      locale: 'it',
      secret: TEST_SECRET,
      method: 'POST',
      keywords: 'engineer',
      locations: 'Lugano',
      sectors: '',
      frequency: 'weekly',
      db: db as any,
    });

    expect(result.status).toBe(200);
    const parentSet = db.__sets.find(
      (s) => s.collection === 'job_alert_subscribers' && s.docId === TEST_EMAIL,
    );
    expect(parentSet?.data).toMatchObject({
      status: 'active',
      isActive: true,
      active: true,
    });
    expect(parentSet?.data).toHaveProperty('account_deleted_at');
    const alertDocs = db.__subcollectionDocs.job_alert_subscribers[TEST_EMAIL].alerts;
    expect(Object.values(alertDocs).some((data: any) => data.locations?.includes('Lugano'))).toBe(true);
  });

  it('deletes an alert by state transition and keeps the audit document', async () => {
    const db = createFakeDb({}, {
      job_alert_subscribers: {
        [TEST_EMAIL]: {
          alerts: {
            'alert-keep': { keywords: ['Sviluppo'], active: true, createdAt: 'before' },
          },
        },
      },
    });

    const result = await handleSubscriptionManagement({
      action: 'delete_alert',
      email: TEST_EMAIL,
      token: VALID_TOKEN,
      alertId: 'alert-keep',
      locale: 'it',
      secret: TEST_SECRET,
      db: db as any,
    });

    expect(result.status).toBe(200);
    expect(db.__deletes).toHaveLength(0);
    const transition = db.__sets.find(
      (s) => s.collection === `job_alert_subscribers/${TEST_EMAIL}/alerts` && s.docId === 'alert-keep',
    );
    expect(transition?.data).toMatchObject({ active: false, unsubscribe_source: 'preferences_link' });
    expect(db.__subcollectionDocs.job_alert_subscribers[TEST_EMAIL].alerts['alert-keep']).toMatchObject({
      keywords: ['Sviluppo'],
      active: false,
    });
  });

  it('returns a safe followup action after a company-follow confirmation', async () => {
    const db = createFakeDb({
      newsletter_subscribers: {
        [TEST_EMAIL]: {
          status: 'confirmed',
          isActive: true,
          active: true,
          source_channel: 'company_follow_button',
          source_page: '/lavoro/azienda/',
        },
      },
    });

    const result = await handleSubscriptionManagement({
      action: 'confirm',
      email: TEST_EMAIL,
      token: VALID_TOKEN,
      locale: 'it',
      secret: TEST_SECRET,
      db: db as any,
    });

    expect(result.status).toBe(200);
    expect((result as any).companyFollowFollowup).toEqual({
      required: true,
      sourcePath: '/lavoro/azienda/',
      newsletterActive: true,
    });
  });

  it('keeps a company-only confirmation suppressed until the alert action completes', async () => {
    const db = createFakeDb({
      newsletter_subscribers: {
        [TEST_EMAIL]: {
          status: 'pending',
          isActive: false,
          active: false,
          source_channel: 'company_follow_button',
          source_page: '/lavoro/azienda/board/',
          company_follow_only: true,
          company_follow_followup_pending: true,
        },
      },
    });

    const result = await handleSubscriptionManagement({
      action: 'confirm',
      email: TEST_EMAIL,
      token: VALID_TOKEN,
      locale: 'it',
      secret: TEST_SECRET,
      db: db as any,
    });

    const subscriberSet = db.__sets.find(
      (s) => s.collection === 'newsletter_subscribers' && s.docId === TEST_EMAIL,
    );
    expect(result.status).toBe(200);
    expect(subscriberSet?.data).toMatchObject({
      status: 'suppressed',
      isActive: false,
      active: false,
      company_follow_followup_pending: true,
    });
    expect((result as any).companyFollowFollowup).toEqual({
      required: true,
      sourcePath: '/lavoro/azienda/board/',
      newsletterActive: false,
    });
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

describe('handleSubscriptionManagement — get_full_status (issue #4298 follow-up fix)', () => {
  // `active` is SOLELY the soft-delete flag written by
  // services/jobAlertService.ts's deleteAlert() — a soft-deleted doc must
  // never reappear here. Pause/resume is tracked by the dedicated, orthogonal
  // `paused` field written by update_alert, so it can never collide with a
  // real delete.
  it('includes a paused alert (active:true, paused:true) and marks it paused', async () => {
    const db = createFakeDb(
      {
        newsletter_subscribers: {
          [TEST_EMAIL]: { status: 'confirmed', isActive: true },
        },
      },
      {
        job_alert_subscribers: {
          [TEST_EMAIL]: {
            alerts: {
              'alert-active': { keywords: ['Sviluppo'], locations: [], sectors: [], frequency: 'weekly', active: true, paused: false, specificCompanyKey: 'migros', specificJobId: 'job-1' },
              'alert-paused': { keywords: ['Logistica'], locations: [], sectors: [], frequency: 'weekly', active: true, paused: true },
            },
          },
        },
      },
    );

    const result = await handleSubscriptionManagement({
      action: 'get_full_status',
      email: TEST_EMAIL,
      token: VALID_TOKEN,
      locale: 'it',
      secret: TEST_SECRET,
      db: db as any,
    });

    expect(result.status).toBe(200);
    expect(result.json.success).toBe(true);
    expect(result.json.alerts).toHaveLength(2);

    const active = result.json.alerts.find((a: any) => a.id === 'alert-active');
    const paused = result.json.alerts.find((a: any) => a.id === 'alert-paused');
    expect(active.active).toBe(true);
    expect(active.paused).toBe(false);
    expect(active.specificCompanyKey).toBe('migros');
    expect(active.specificJobId).toBe('job-1');
    expect(paused).toBeTruthy();
    expect(paused.active).toBe(true);
    expect(paused.paused).toBe(true);
  });

  // Regression guard: a real soft-deleted alert (active:false, written by
  // services/jobAlertService.ts's deleteAlert()) must never resurrect as
  // "paused" — that would un-opt-out a user who deliberately deleted it.
  it('never returns a soft-deleted alert (active:false)', async () => {
    const db = createFakeDb(
      {
        newsletter_subscribers: {
          [TEST_EMAIL]: { status: 'confirmed', isActive: true },
        },
      },
      {
        job_alert_subscribers: {
          [TEST_EMAIL]: {
            alerts: {
              'alert-live': { keywords: ['Sviluppo'], locations: [], sectors: [], frequency: 'weekly', active: true },
              'alert-deleted': {
                keywords: ['Logistica'],
                locations: [],
                sectors: [],
                frequency: 'weekly',
                active: false,
                unsubscribed_at: 'irrelevant',
                unsubscribe_source: 'profile_ui',
              },
            },
          },
        },
      },
    );

    const result = await handleSubscriptionManagement({
      action: 'get_full_status',
      email: TEST_EMAIL,
      token: VALID_TOKEN,
      locale: 'it',
      secret: TEST_SECRET,
      db: db as any,
    });

    expect(result.status).toBe(200);
    expect(result.json.alerts).toHaveLength(1);
    expect(result.json.alerts[0].id).toBe('alert-live');
  });
});
