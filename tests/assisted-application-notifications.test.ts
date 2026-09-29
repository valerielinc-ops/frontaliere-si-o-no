import { beforeEach, describe, expect, it, vi } from 'vitest';

type Doc = Record<string, any>;
let store: Record<string, Doc> = {};

function isPlainObject(value: unknown): value is Doc {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && !(value instanceof Date) && Object.getPrototypeOf(value) === Object.prototype;
}

function deepMerge(target: Doc, source: Doc): Doc {
  const result: Doc = { ...target };
  for (const [key, value] of Object.entries(source)) {
    result[key] = isPlainObject(value) && isPlainObject(result[key])
      ? deepMerge(result[key], value)
      : value;
  }
  return result;
}

function docRef(id: string) {
  return {
    id,
    async get() {
      const data = store[id];
      return { id, exists: data != null, data: () => data, ref: docRef(id) };
    },
    async set(data: Doc, options?: { merge?: boolean }) {
      store[id] = options?.merge ? deepMerge(store[id] || {}, data) : data;
    },
  };
}

const db = {
  collection: (name: string) => {
    expect(name).toBe('assisted_applications');
    return {
      doc: (id: string) => docRef(id),
      where: (field: string, op: string, value: unknown) => ({
        async get() {
          expect(op).toBe('==');
          const docs = Object.entries(store)
            .filter(([, data]) => data?.[field] === value)
            .map(([id, data]) => ({ id, data: () => data, ref: docRef(id) }));
          return { docs };
        },
      }),
    };
  },
  runTransaction: async (callback: any) => callback({
    get: (ref: any) => ref.get(),
    set: (ref: any, data: Doc, options?: { merge?: boolean }) => ref.set(data, options),
  }),
};

vi.mock('firebase-admin', () => ({
  default: { firestore: Object.assign(() => db, { FieldValue: { serverTimestamp: () => '__server_timestamp__' } }) },
}));

vi.mock('../functions/src/remoteConfigSecrets.js', () => ({
  bridgeEmailCascadeCredentialsToEnv: vi.fn(async () => {}),
  getRemoteConfigValue: vi.fn(async () => ''),
}));

const sendEmailCascade = vi.fn();
vi.mock('../functions/src/emailCascade.js', () => ({
  PROVIDERS: [{ id: 'mailgun' }],
  isProviderConfigured: () => true,
  sendEmailCascade: (...args: unknown[]) => sendEmailCascade(...args),
}));

const {
  buildCustomerEmail,
  buildOrderPageUrl,
  localeFromSiteUrl,
  handleAssistedApplicationOrderWritten,
  runAssistedApplicationNotificationSweep,
  sendPaidOrderNotifications,
  NOTIFICATION_KEYS,
} = await import('../functions/src/assistedApplicationNotifications.js');

const NOW = Date.parse('2026-09-30T10:00:00Z');
const HOUR = 60 * 60 * 1000;

function paidOrder(overrides: Doc = {}): Doc {
  return {
    orderId: 'order-1',
    userId: 'user-1',
    jobId: 'job-1',
    jobTitle: 'Infermiere/a cure acute',
    companyName: 'Clinica Esempio',
    jobUrl: 'https://jobs.example.ch/infermiere',
    paymentStatus: 'paid',
    submissionStatus: 'awaiting_upload',
    amountTotal: 99,
    currency: 'eur',
    customerEmail: 'Candidate@Example.com',
    paidAt: new Date(NOW - HOUR),
    ...overrides,
  };
}

function acceptAll() {
  sendEmailCascade.mockImplementation(async (emails: any[]) => ({
    sent: emails.map((email) => ({ ...email, provider: 'mailgun', messageId: `msg-${email.meta.key}` })),
    accepted: emails,
    ambiguous: [],
    failed: [],
    providerBreakdown: {},
  }));
}

function payloads() {
  return sendEmailCascade.mock.calls.map((call) => call[0][0].payload);
}

beforeEach(() => {
  store = {};
  sendEmailCascade.mockReset();
  acceptAll();
});

describe('assisted application concierge copy', () => {
  it('writes the intro in Valerie’s voice with the checklist, the reply path and the order link', () => {
    const email = buildCustomerEmail('intro', paidOrder({
      orderPageUrl: 'https://frontaliereticino.ch/cerca-lavoro-ticino/?assisted_application_order_id=order-1',
    }), 'order-1', { nowMs: NOW });
    expect(email.locale).toBe('it');
    expect(email.subject).toBe('La tua candidatura per Infermiere/a cure acute: cosa mi serve per inviarla');
    expect(email.html).toContain('sono Valerie di Frontaliere Ticino');
    expect(email.html).toContain('il tuo CV (PDF, DOC o DOCX)');
    expect(email.html).toContain('rispondi a questa email');
    expect(email.html).toContain('https://frontaliereticino.ch/cerca-lavoro-ticino/?assisted_application_order_id=order-1');
    expect(email.text).toContain('https://jobs.example.ch/infermiere');
    expect(email.text).toMatch(/0,99\s€/);
  });

  it('reads the locale from the return path and escapes job data', () => {
    const email = buildCustomerEmail('recovery', paidOrder({
      jobTitle: 'Opérateur <b>ligne</b>',
      orderPageUrl: 'https://frontaliereticino.ch/fr/trouver-emploi-tessin/?assisted_application_order_id=order-1',
    }), 'order-1', { nowMs: NOW });
    expect(email.locale).toBe('fr');
    expect(email.subject).toContain('Votre candidature pour Opérateur <b>ligne</b>');
    expect(email.html).toContain('Opérateur &lt;b&gt;ligne&lt;/b&gt;');
    expect(email.html).not.toContain('<b>ligne</b>');
    expect(email.html).toContain('un problème technique de notre site');
    expect(email.html).toContain('remboursement');
  });

  it('never trusts a foreign return URL for the link we sign as Valerie', () => {
    expect(buildOrderPageUrl({ orderPageUrl: 'https://evil.example/x', locale: 'de' }, 'abc'))
      .toBe('https://frontaliereticino.ch/de/jobs-im-tessin/?assisted_application_order_id=abc');
    expect(localeFromSiteUrl('https://www.frontaliereticino.ch/en/find-jobs-ticino/')).toBe('en');
    expect(localeFromSiteUrl('https://frontaliereticino.ch/cerca-lavoro-ticino/')).toBe('it');
    expect(localeFromSiteUrl('https://evil.example/fr/')).toBeNull();
  });
});

describe('payment-time emails', () => {
  it('sends the customer intro from valerie@ and the owner notice on the paid transition', async () => {
    store['order-1'] = paidOrder();
    const result = await handleAssistedApplicationOrderWritten(
      { ...paidOrder(), paymentStatus: 'pending', submissionStatus: 'awaiting_payment' },
      store['order-1'],
      'order-1',
      { db, nowMs: NOW },
    );
    expect(result.ok).toBe(true);
    const [customer, owner] = payloads();
    expect(customer.from).toBe('Valerie · Frontaliere Ticino <valerie@frontaliereticino.ch>');
    expect(customer.to).toEqual(['candidate@example.com']);
    expect(customer.replyTo).toBeUndefined();
    expect(owner.to).toEqual(['valerie@frontaliereticino.ch']);
    expect(owner.replyTo).toBe('candidate@example.com');
    expect(owner.html).toContain('mailto:candidate%40example.com');
    expect(store['order-1'].notifications[NOTIFICATION_KEYS.customerIntro]).toMatchObject({
      status: 'sent', provider: 'mailgun', to: 'candidate@example.com', variant: 'intro',
    });
    expect(store['order-1'].notifications[NOTIFICATION_KEYS.ownerNewOrder].status).toBe('sent');
  });

  it('does not send twice when the trigger is delivered again', async () => {
    store['order-1'] = paidOrder();
    const before = { ...paidOrder(), paymentStatus: 'pending' };
    await handleAssistedApplicationOrderWritten(before, store['order-1'], 'order-1', { db, nowMs: NOW });
    await handleAssistedApplicationOrderWritten(before, store['order-1'], 'order-1', { db, nowMs: NOW });
    expect(sendEmailCascade).toHaveBeenCalledTimes(2);
  });

  it('ignores writes that are not lifecycle transitions', async () => {
    store['order-1'] = paidOrder();
    const result = await handleAssistedApplicationOrderWritten(paidOrder(), store['order-1'], 'order-1', { db, nowMs: NOW });
    expect(result).toEqual({ ok: true, skipped: 'no_transition' });
    expect(sendEmailCascade).not.toHaveBeenCalled();
  });

  it('releases the claim on a provider failure so the hourly sweep retries it', async () => {
    store['order-1'] = paidOrder();
    sendEmailCascade.mockImplementationOnce(async (emails: any[]) => ({
      sent: [], accepted: [], ambiguous: [], failed: [{ ...emails[0], error: 'smtp down' }], providerBreakdown: {},
    }));
    await sendPaidOrderNotifications(db, 'order-1', { nowMs: NOW });
    expect(store['order-1'].notifications.customer_intro).toMatchObject({ status: 'failed', lastError: 'smtp down' });

    sendEmailCascade.mockClear();
    const summary = await runAssistedApplicationNotificationSweep({ db, nowMs: NOW + HOUR });
    expect(summary.intros).toBe(1);
    expect(payloads().map((payload) => payload.to[0])).toEqual(['candidate@example.com']);
    expect(store['order-1'].notifications.customer_intro.status).toBe('sent');
  });

  it('retries Valerie’s notice on its own when the customer intro already went out', async () => {
    store['order-1'] = paidOrder({
      notifications: {
        customer_intro: { status: 'sent', sentAt: new Date(NOW - HOUR) },
        owner_new_order: { status: 'failed', lastError: 'smtp down' },
      },
    });
    const first = await runAssistedApplicationNotificationSweep({ db, nowMs: NOW });
    const second = await runAssistedApplicationNotificationSweep({ db, nowMs: NOW + HOUR });
    expect(first.intros).toBe(1);
    expect(second.intros).toBe(0);
    expect(payloads().map((payload) => payload.to[0])).toEqual(['valerie@frontaliereticino.ch']);
    expect(store['order-1'].notifications.owner_new_order.status).toBe('sent');
    expect(store['order-1'].notifications.customer_intro.status).toBe('sent');
  });

  it('never retries an ambiguous provider acceptance', async () => {
    store['order-1'] = paidOrder();
    sendEmailCascade.mockImplementationOnce(async (emails: any[]) => ({
      sent: [{ ...emails[0], provider: 'cloudflare' }], accepted: [], ambiguous: [emails[0]], failed: [], providerBreakdown: {},
    }));
    await sendPaidOrderNotifications(db, 'order-1', { nowMs: NOW });
    expect(store['order-1'].notifications.customer_intro.status).toBe('ambiguous');
    sendEmailCascade.mockClear();
    await sendPaidOrderNotifications(db, 'order-1', { nowMs: NOW + HOUR });
    expect(payloads().map((payload) => payload.to[0])).toEqual([]);
  });

  it('leaves orders paid before the concierge window to the recovery script', async () => {
    store.legacy = paidOrder({ paidAt: new Date(NOW - 5 * 24 * HOUR) });
    const summary = await runAssistedApplicationNotificationSweep({ db, nowMs: NOW });
    expect(summary).toMatchObject({ intros: 0, reminders: 0 });
    expect(sendEmailCascade).not.toHaveBeenCalled();
  });

  it('test mode sends to the override address and records nothing', async () => {
    store['order-1'] = paidOrder();
    const results = await sendPaidOrderNotifications(db, 'order-1', {
      variant: 'recovery', recipientOverride: 'owner@example.com', nowMs: NOW,
    });
    expect(results.every((result: any) => result.ok && result.test)).toBe(true);
    expect(payloads().map((payload) => payload.to[0])).toEqual(['owner@example.com', 'owner@example.com']);
    expect(payloads()[0].subject.startsWith('[TEST] ')).toBe(true);
    expect(store['order-1'].notifications).toBeUndefined();
  });
});

describe('follow-up emails', () => {
  it('confirms the upload to the customer and tells Valerie the CV arrived', async () => {
    store['order-1'] = paidOrder({ submissionStatus: 'ready_for_manual_submission', cvStorageKey: 'assisted-application-uploads/order-1/cv.pdf', applicantEmail: 'form@example.com' });
    const checkCv = vi.fn(async () => ({ verdict: 'ok' }));
    const result = await handleAssistedApplicationOrderWritten(paidOrder(), store['order-1'], 'order-1', { db, nowMs: NOW, checkCv });
    expect(result.ok).toBe(true);
    const [customer, owner] = payloads();
    expect(customer.to).toEqual(['form@example.com']);
    expect(customer.subject).toBe('Ho ricevuto il tuo CV per Infermiere/a cure acute');
    expect(owner.subject).toContain('CV caricato');
  });

  it('type-checks a newly referenced CV before anyone opens it', async () => {
    const checkCv = vi.fn(async () => ({ verdict: 'ok' }));
    store['order-1'] = paidOrder({ cvStorageKey: 'assisted-application-uploads/order-1/cv.pdf' });
    const result = await handleAssistedApplicationOrderWritten(paidOrder(), store['order-1'], 'order-1', { db, nowMs: NOW, checkCv });
    expect(checkCv).toHaveBeenCalledWith({ orderId: 'order-1', key: 'assisted-application-uploads/order-1/cv.pdf', db });
    expect(result.ok).toBe(true);

    checkCv.mockClear();
    await handleAssistedApplicationOrderWritten(store['order-1'], store['order-1'], 'order-1', { db, nowMs: NOW, checkCv });
    expect(checkCv).not.toHaveBeenCalled();
  });

  it('tells the customer when Valerie marks the application as submitted', async () => {
    store['order-1'] = paidOrder({ submissionStatus: 'submitted', submittedAt: new Date('2026-10-01T09:00:00Z') });
    await handleAssistedApplicationOrderWritten(
      paidOrder({ submissionStatus: 'in_progress' }), store['order-1'], 'order-1', { db, nowMs: NOW },
    );
    const [customer] = payloads();
    expect(customer.subject).toBe('Ho inviato la tua candidatura a Clinica Esempio');
    expect(customer.html).toContain('1 ottobre 2026');
  });

  it('sends one 48 h reminder while the materials are still missing', async () => {
    store['order-1'] = paidOrder({
      paidAt: new Date(NOW - 50 * HOUR),
      notifications: {
        customer_intro: { status: 'sent', sentAt: new Date(NOW - 49 * HOUR) },
        owner_new_order: { status: 'sent', sentAt: new Date(NOW - 49 * HOUR) },
      },
    });
    const first = await runAssistedApplicationNotificationSweep({ db, nowMs: NOW });
    const second = await runAssistedApplicationNotificationSweep({ db, nowMs: NOW + HOUR });
    expect(first.reminders).toBe(1);
    expect(second.reminders).toBe(0);
    expect(payloads()).toHaveLength(1);
    expect(payloads()[0].subject).toContain('Promemoria');
  });

  it('retries a failed owner notice and still sends the due reminder in the same pass', async () => {
    store['order-1'] = paidOrder({
      paidAt: new Date(NOW - 50 * HOUR),
      notifications: {
        customer_intro: { status: 'sent', sentAt: new Date(NOW - 49 * HOUR) },
        owner_new_order: { status: 'failed' },
      },
    });
    const summary = await runAssistedApplicationNotificationSweep({ db, nowMs: NOW });
    expect(summary).toMatchObject({ intros: 1, reminders: 1, failed: 0 });
    expect(payloads().map((payload) => payload.to[0])).toEqual(['valerie@frontaliereticino.ch', 'candidate@example.com']);
  });

  it('does not remind once Valerie marked the materials as received', async () => {
    store['order-1'] = paidOrder({
      submissionStatus: 'in_progress',
      notifications: {
        customer_intro: { status: 'sent', sentAt: new Date(NOW - 49 * HOUR) },
        owner_new_order: { status: 'sent', sentAt: new Date(NOW - 49 * HOUR) },
      },
    });
    const summary = await runAssistedApplicationNotificationSweep({ db, nowMs: NOW });
    expect(summary.reminders).toBe(0);
    expect(sendEmailCascade).not.toHaveBeenCalled();
  });
});
