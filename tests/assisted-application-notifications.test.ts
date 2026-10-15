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
    // The order's subcollections (the automated flow), keyed "order-1/automation/flow".
    collection: (name: string) => ({ doc: (sub: string) => docRef(`${id}/${name}/${sub}`) }),
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
  buildOwnerEmail,
  buildOrderPageUrl,
  localeFromSiteUrl,
  handleAssistedApplicationOrderWritten,
  runAssistedApplicationNotificationSweep,
  sendPaidOrderNotifications,
  submittedReviewUrl,
  NOTIFICATION_KEYS,
} = await import('../functions/src/assistedApplicationNotifications.js');
const { renderBrandedEmail } = await import('../functions/src/assistedApplicationEmailLayout.js');
const { CONSENT_BOUND_EXPIRES_AT, verifyReviewToken } = await import('../functions/src/assistedApplicationReviewToken.js');

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

  // Owner decision 2026-10-03: a WhatsApp application (Coop's apprenticeships, PastaHR)
  // is sent once the candidate has its link and the steps, and this e-mail is that.
  it('turns the «inviata» e-mail of a WhatsApp application into its link and steps, in every language', () => {
    const link = 'https://prod.pastahr.com/api/v1/redirect/COFU2003?utm_medium=prospective-job-description&remote_job_id=167757';
    const pages: Record<string, string> = {
      it: '/cerca-lavoro-ticino/', fr: '/fr/trouver-emploi-tessin/', de: '/de/jobs-im-tessin/', en: '/en/find-jobs-ticino/',
    };
    const only: Record<string, string> = { it: 'solo via WhatsApp', fr: 'uniquement par WhatsApp', de: 'nur über WhatsApp', en: 'only on WhatsApp' };
    const whatsappOrder = (extra: Record<string, unknown> = {}) => paidOrder({
      submissionStatus: 'submitted', submittedAt: new Date('2026-10-03T09:00:00Z'), submissionChannel: 'whatsapp', whatsappApplyUrl: link, ...extra,
    });
    for (const [locale, page] of Object.entries(pages)) {
      const email = buildCustomerEmail('submitted', whatsappOrder({ orderPageUrl: `https://frontaliereticino.ch${page}?assisted_application_order_id=order-1` }), 'order-1', { nowMs: NOW });
      expect(email.locale).toBe(locale);
      expect(email.subject).toContain('WhatsApp');
      expect(email.text).toContain(only[locale]);
      expect(email.text).toMatch(/\n1\. .+\n2\. .+\n3\. .+\n4\. /);
      expect(email.text).toContain(link);
      expect(email.html).toContain(`href="${link.replace(/&/g, '&amp;')}"`);
      expect(email.html).not.toMatch(/undefined|\[object/);
    }
    const italian = buildCustomerEmail('submitted', whatsappOrder(), 'order-1', { nowMs: NOW });
    expect(italian.subject).toBe("La tua candidatura a Clinica Esempio: l'ultimo passo è su WhatsApp");
    expect(italian.text).toContain('Nessuno può farlo al posto tuo');
    expect(italian.html).toContain('<title>L&#39;ultimo passo è su WhatsApp — Frontaliere Ticino</title>');
    // Any other channel, or a link that is not https, keeps the usual «inviata».
    expect(buildCustomerEmail('submitted', whatsappOrder({ whatsappApplyUrl: 'javascript:alert(1)' }), 'order-1', { nowMs: NOW }).subject)
      .toBe('Ho inviato la tua candidatura a Clinica Esempio');
    expect(buildCustomerEmail('submitted', whatsappOrder({ submissionChannel: 'email' }), 'order-1', { nowMs: NOW }).subject)
      .toBe('Ho inviato la tua candidatura a Clinica Esempio');
  });

  it('never trusts a foreign return URL for the link we sign as Valerie', () => {
    expect(buildOrderPageUrl({ orderPageUrl: 'https://evil.example/x', locale: 'de' }, 'abc'))
      .toBe('https://frontaliereticino.ch/de/jobs-im-tessin/?assisted_application_order_id=abc');
    expect(localeFromSiteUrl('https://www.frontaliereticino.ch/en/find-jobs-ticino/')).toBe('en');
    expect(localeFromSiteUrl('https://frontaliereticino.ch/cerca-lavoro-ticino/')).toBe('it');
    expect(localeFromSiteUrl('https://evil.example/fr/')).toBeNull();
  });
});

describe('brand shell', () => {
  const PAGES: Record<string, string> = {
    it: '/cerca-lavoro-ticino/', fr: '/fr/trouver-emploi-tessin/', de: '/de/jobs-im-tessin/', en: '/en/find-jobs-ticino/',
  };
  const BADGES: Record<string, string> = {
    it: 'Candidatura assistita', fr: 'Candidature assistée', de: 'Begleitete Bewerbung', en: 'Assisted application',
  };

  it('wraps every customer email in the job-alert brand shell, in the customer’s language', () => {
    for (const locale of ['it', 'fr', 'de', 'en']) {
      const order = paidOrder({ orderPageUrl: `https://frontaliereticino.ch${PAGES[locale]}?assisted_application_order_id=order-1` });
      const heroes = new Set<string>();
      for (const kind of ['intro', 'recovery', 'reminder', 'received', 'submitted']) {
        const { html } = buildCustomerEmail(kind, order, 'order-1', { nowMs: NOW });
        expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
        expect(html).toContain(`<html lang="${locale}">`);
        expect(html).toContain('#0f172a'); // BRAND_DARK bands
        expect(html).toContain('</span> Frontaliere Ticino');
        expect(html).toContain(BADGES[locale].replace(/'/g, '&#39;'));
        expect(html).toContain('Infermiere/a cure acute — Clinica Esempio');
        expect(html).toContain('order-1');
        expect(html).toContain('redazione@frontaliereticino.ch'); // public data-controller line in the footer
        expect(html).not.toMatch(/undefined|\[object/);
        heroes.add(html.match(/<title>([^<]+) — Frontaliere Ticino<\/title>/)?.[1] || '');
      }
      expect(heroes.size).toBe(5); // one title per kind
    }
  });

  it('with automation on, says the 12 hours start with the draft e-mail, not now', () => {
    const order = paidOrder({ applicantName: 'Maria Rossi' });
    const received = buildCustomerEmail('received', order, 'order-1', { nowMs: NOW, automation: true });
    expect(received.text).toContain('Per ora non devi fare nulla');
    expect(received.text).toContain('seconda email con la bozza');
    expect(received.text).toContain('Solo da quel momento hai 12 ore');
    const intro = buildCustomerEmail('intro', order, 'order-1', { nowMs: NOW, automation: true });
    expect(intro.text).toContain('Solo da quel momento hai 12 ore');
    expect(intro.text).not.toContain('Se non rispondi entro 12 ore');
    // Without automation the manual copy stays: no 12 hours at all.
    expect(buildCustomerEmail('received', order, 'order-1', { nowMs: NOW, automation: false }).text).not.toContain('12 ore');
  });

  it('turns the order link into a button and the reply path into the highlighted box', () => {
    const url = 'https://frontaliereticino.ch/cerca-lavoro-ticino/?assisted_application_order_id=order-1';
    const { html } = buildCustomerEmail('intro', paidOrder({ orderPageUrl: url }), 'order-1', { nowMs: NOW });
    expect(html).toMatch(new RegExp(`<a href="${url.replace(/[.?/]/g, '\\$&')}"[^>]*>Apri il tuo ordine</a>`));
    expect(html).toContain('Cosa mi serve');
    expect(html).toContain('<strong>Il modo più semplice: rispondi a questa email</strong>');
    expect(html).toContain('La tua candidatura è in buone mani');
  });

  it('brands Valerie’s internal notice and keeps the reply-to-customer link', () => {
    const { html } = buildOwnerEmail('new_order', paidOrder(), 'order-1', { nowMs: NOW });
    expect(html).toContain('Nuova candidatura pagata');
    expect(html).toContain('Candidatura assistita · interno');
    expect(html).toMatch(/<a href="mailto:candidate%40example\.com[^"]*"[^>]*>Rispondi al cliente<\/a>/);
  });

  it('escapes every plain-text argument of the shell', () => {
    const html = renderBrandedEmail({
      heroTitle: '<script>x</script>',
      heroSubtitle: 'a & <b>',
      badge: '"quoted"',
      preheader: '<i>pre</i>',
      bodyHtml: '<p>trusted</p>',
      footerLines: ['<img src=x>'],
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(html).toContain('a &amp; &lt;b&gt;');
    expect(html).toContain('&quot;quoted&quot;');
    expect(html).not.toContain('<img src=x>');
    expect(html).toContain('<p>trusted</p>');
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
    // No header of a test copy may point at the real customer.
    expect(payloads().map((payload) => payload.replyTo)).toEqual([undefined, undefined]);
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

  it('sends a WhatsApp application its link and steps when the robot marks it submitted', async () => {
    const link = 'https://prod.pastahr.com/api/v1/redirect/COFU2003?remote_job_id=167757';
    store['order-1'] = paidOrder({ submissionStatus: 'submitted', submittedAt: new Date('2026-10-03T09:00:00Z'), submissionChannel: 'whatsapp', whatsappApplyUrl: link });
    await handleAssistedApplicationOrderWritten(
      paidOrder({ submissionStatus: 'in_progress', submissionChannel: 'whatsapp', whatsappApplyUrl: link }), store['order-1'], 'order-1', { db, nowMs: NOW },
    );
    const [customer] = payloads();
    expect(customer.subject).toBe("La tua candidatura a Clinica Esempio: l'ultimo passo è su WhatsApp");
    expect(customer.text).toContain(link);
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

// Close-out P8 (owner decisions of 2026-10-03): the «inviata» e-mail of an automated order links the page
// where the candidate keeps the documents, until the retention purge deletes them; in a WhatsApp
// application the candidate sends the CV they choose there.
describe('the «inviata» e-mail and the candidate’s documents', () => {
  const DAY = 24 * HOUR;
  const SECRET = 's'.repeat(40);
  const REVIEW_URL = 'https://frontaliereticino.ch/cerca-lavoro-ticino/?assisted_application_review=ar1.order-1.1.tz5ch8.0123456789abcdef0123456789abcdef';
  const LINK = 'https://prod.pastahr.com/api/v1/redirect/COFU2003?remote_job_id=167757';
  const PAGES: Record<string, string> = { it: '/cerca-lavoro-ticino/', fr: '/fr/trouver-emploi-tessin/', de: '/de/jobs-im-tessin/', en: '/en/find-jobs-ticino/' };
  const CTA: Record<string, string> = { it: 'I tuoi documenti', fr: 'Vos documents', de: 'Deine Unterlagen', en: 'Your documents' };
  // Step 3 of the WhatsApp steps: the CV the candidate gave, or the one they choose on the page it links.
  const CV_STEP: Record<string, [string, string]> = {
    it: ['se ti chiede il CV, invia lo stesso che hai dato a me;', 'se ti chiede il CV, invia quello che scegli tra i tuoi documenti nella pagina della tua candidatura;'],
    fr: ["s'il demande votre CV, envoyez celui que vous m'avez transmis ;", "s'il demande votre CV, envoyez celui que vous choisissez parmi vos documents sur la page de votre candidature ;"],
    de: ['fragt er nach dem Lebenslauf, schick denselben, den du mir gegeben hast;', 'fragt er nach dem Lebenslauf, schick den, den du unter deinen Unterlagen auf der Seite deiner Bewerbung auswählst;'],
    en: ['if it asks for your CV, send the one you gave me;', 'if it asks for your CV, send the one you choose from your documents on your application page;'],
  };
  const submitted = (extra: Doc = {}) => paidOrder({ submissionStatus: 'submitted', submittedAt: new Date('2026-10-01T09:00:00Z'), ...extra });
  const whatsapp = (extra: Doc = {}) => submitted({ submissionChannel: 'whatsapp', whatsappApplyUrl: LINK, ...extra });
  const steps = (text: string) => text.split('\n').filter((line) => /^\d\. /.test(line));

  it('adds one button to the review page; the WhatsApp variant adds one sentence and sends the candidate to the CV they choose there', () => {
    const plain = buildCustomerEmail('submitted', submitted(), 'order-1', { nowMs: NOW });
    expect(plain.html).not.toContain('assisted_application_review');
    const linked = buildCustomerEmail('submitted', submitted(), 'order-1', { nowMs: NOW, reviewUrl: REVIEW_URL });
    expect(linked.html.match(/assisted_application_review=/g)).toHaveLength(1);
    expect(linked.text).toContain(`I tuoi documenti: ${REVIEW_URL}`);
    expect(linked.subject).toBe(plain.subject);
    // Only the block is added.
    expect(linked.text.replace(`\n\nNella pagina della tua candidatura trovi i documenti preparati e inviati: puoi scaricarli e conservarli.\nI tuoi documenti: ${REVIEW_URL}`, '')).toBe(plain.text);

    const without = buildCustomerEmail('submitted', whatsapp(), 'order-1', { nowMs: NOW });
    const withPage = buildCustomerEmail('submitted', whatsapp(), 'order-1', { nowMs: NOW, reviewUrl: REVIEW_URL });
    expect(withPage.subject).toBe(without.subject);
    expect(withPage.html.match(/assisted_application_review=/g)).toHaveLength(1);
    expect(without.text).toContain(CV_STEP.it[0]);
    expect(withPage.text).not.toContain(CV_STEP.it[0]);
    // The third step changes, the other three stay as they are, and one sentence with its button is added.
    expect(steps(withPage.text)).toHaveLength(4);
    expect(steps(withPage.text).filter((step, index) => step !== steps(without.text)[index])).toEqual([steps(without.text)[2].replace(CV_STEP.it[0], CV_STEP.it[1])]);
    expect(withPage.text.replace(CV_STEP.it[1], CV_STEP.it[0])
      .replace(`\n\nLa lettera e il CV per questa candidatura sono nella pagina della tua candidatura, tra i tuoi documenti.\nI tuoi documenti: ${REVIEW_URL}`, '')).toBe(without.text);

    for (const [locale, page] of Object.entries(PAGES)) {
      const localized = { orderPageUrl: `https://frontaliereticino.ch${page}?assisted_application_order_id=order-1` };
      const email = buildCustomerEmail('submitted', submitted(localized), 'order-1', { nowMs: NOW, reviewUrl: REVIEW_URL });
      expect([locale, email.text.includes(`${CTA[locale]}: ${REVIEW_URL}`)]).toEqual([locale, true]);
      const chat = buildCustomerEmail('submitted', whatsapp(localized), 'order-1', { nowMs: NOW, reviewUrl: REVIEW_URL });
      expect(chat.text).toContain(`${CTA[locale]}: ${REVIEW_URL}`);
      expect(steps(chat.text)[2]).toContain(CV_STEP[locale][1]);
      expect(chat.text).not.toContain(CV_STEP[locale][0]);
      // Without the page the step keeps the CV the candidate gave: it never points to a page the e-mail does not link.
      const unlinked = buildCustomerEmail('submitted', whatsapp(localized), 'order-1', { nowMs: NOW });
      expect(steps(unlinked.text)[2]).toContain(CV_STEP[locale][0]);
      expect(unlinked.text).not.toContain(CTA[locale]);
      for (const html of [email.html, chat.html]) expect(html).not.toMatch(/undefined|\[object/);
    }
  });

  it('tells an order with an active alias how the employer answer reaches them, instead of inviting replies to Valerie', () => {
    const alias = { candidateAlias: { address: 'mario.rossi.ab2c@candidature.frontaliereticino.ch', active: true } };
    const ASK_VALERIE = "Se ricevi una risposta o hai bisogno di altro, scrivimi pure rispondendo a questa email.";
    const PHONE = "L'azienda può chiamarti al numero di telefono che mi hai dato oppure scriverti per email.";
    const FORWARD = 'te lo inoltro subito in questa casella. Per rispondere all\'azienda basta rispondere all\'email inoltrata';
    const NEXT = 'Se qualcosa non funziona, scrivimi rispondendo a questa email. In bocca al lupo!';

    const withPhone = buildCustomerEmail('submitted', submitted({ ...alias, applicantPhone: '+41 79 000 00 00' }), 'order-1', { nowMs: NOW });
    for (const body of [withPhone.text, withPhone.html.replace(/&#39;/g, "'")]) {
      expect(body).toContain(PHONE);
      expect(body).toContain(FORWARD);
      expect(body).toContain(NEXT);
      expect(body).not.toContain(ASK_VALERIE);
    }
    // The text never names the alias itself: it would only confuse the candidate.
    expect(withPhone.text).not.toContain('candidature.frontaliereticino.ch');
    expect(withPhone.text.indexOf(PHONE)).toBeLessThan(withPhone.text.indexOf(FORWARD));

    // No phone in the order (it may come from the CV): the phone is not promised.
    const noPhone = buildCustomerEmail('submitted', submitted(alias), 'order-1', { nowMs: NOW });
    expect(noPhone.text).not.toContain(PHONE);
    expect(noPhone.text).toContain(FORWARD);

    // No active alias (concierge, or the rule not created yet): the employer has the candidate's own address.
    for (const order of [submitted(), submitted({ candidateAlias: { ...alias.candidateAlias, active: false }, applicantPhone: '+41 79 000 00 00' })]) {
      const email = buildCustomerEmail('submitted', order, 'order-1', { nowMs: NOW });
      expect(email.text).toContain(ASK_VALERIE);
      expect(email.text).not.toContain(FORWARD);
    }
    // WhatsApp keeps its own closing: the chat starts from the candidate's phone.
    expect(buildCustomerEmail('submitted', whatsapp(alias), 'order-1', { nowMs: NOW }).text).not.toContain(FORWARD);

    const LOCALIZED: Record<string, [string, string, string]> = {
      it: ['numero di telefono', 'te lo inoltro subito', 'scrivimi pure rispondendo'],
      fr: ['numéro de téléphone', 'je vous le transfère aussitôt', "avez besoin d'autre chose"],
      de: ['Telefonnummer', 'ich leite sie dir sofort', 'noch etwas brauchst'],
      en: ['phone number', 'I forward it to this inbox right away', 'need anything else'],
    };
    for (const [locale, page] of Object.entries(PAGES)) {
      const localized = { ...alias, applicantPhone: '+41 79 000 00 00', orderPageUrl: `https://frontaliereticino.ch${page}?assisted_application_order_id=order-1` };
      const email = buildCustomerEmail('submitted', submitted(localized), 'order-1', { nowMs: NOW });
      const [phone, forward, askValerie] = LOCALIZED[locale];
      expect([locale, email.text.includes(phone), email.text.includes(forward), email.text.includes(askValerie)]).toEqual([locale, true, true, false]);
      expect(email.html).not.toMatch(/undefined|\[object/);
    }
  });

  it('links the review page of an automated order marked submitted until the purge; a failed mint never stops the e-mail', async () => {
    const cvUploadedAt = new Date(NOW - 10 * DAY);
    const before = submitted({ submissionStatus: 'in_progress', automationState: 'submitted' });
    const send = async (order: Doc, reviewSecret: () => Promise<string>) => {
      sendEmailCascade.mockClear();
      store['order-1'] = order;
      await handleAssistedApplicationOrderWritten(before, store['order-1'], 'order-1', { db, nowMs: NOW, reviewSecret });
      return payloads()[0];
    };
    store['order-1/automation/flow'] = { state: 'submitted', round: 2 };
    const reviewSecret = vi.fn(async () => SECRET);
    const customer = await send(submitted({ automationState: 'submitted', cvUploadedAt }), reviewSecret);
    const token = /assisted_application_review=([^\s&"]+)/.exec(customer.text)?.[1];
    // Until the purge deletes the documents (the CV upload plus 90 days), not the 30 days of a review link.
    expect(verifyReviewToken({ secret: SECRET, token, nowMs: NOW }))
      .toMatchObject({ ok: true, orderId: 'order-1', round: 2, kind: 'review', expiresAt: Math.floor((cvUploadedAt.getTime() + 90 * DAY) / 1000) * 1000 });
    expect(verifyReviewToken({ secret: SECRET, token, nowMs: NOW + 79 * DAY }).ok).toBe(true);
    expect(verifyReviewToken({ secret: SECRET, token, nowMs: NOW + 81 * DAY })).toMatchObject({ ok: false, error: 'expired' });

    // The secret cannot be read: the e-mail still leaves, without the link.
    const failing = vi.fn(async () => { throw new Error('review_secret_missing'); });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const unlinked = await send(submitted({ automationState: 'submitted', cvUploadedAt }), failing);
    warn.mockRestore();
    expect(unlinked.subject).toBe('Ho inviato la tua candidatura a Clinica Esempio');
    expect(unlinked.text).not.toContain('assisted_application_review');
    // A concierge order (no automated flow): no link, and the secret is never read.
    const concierge = vi.fn(async () => SECRET);
    expect((await send(submitted({ cvUploadedAt }), concierge)).text).not.toContain('assisted_application_review');
    expect(concierge).not.toHaveBeenCalled();
  });

  it('mints the link only for a flow that left, and only while the documents are kept', async () => {
    const getSecret = async () => SECRET;
    store['order-1/automation/flow'] = { state: 'submitting', round: 1 };
    expect(await submittedReviewUrl({ db, orderId: 'order-1', order: { automationState: 'submitted', cvUploadedAt: new Date(NOW) }, nowMs: NOW, getSecret })).toBe('');
    store['order-1/automation/flow'] = { state: 'submitted', round: 1 };
    // Already due for the purge: no link to documents about to go.
    expect(await submittedReviewUrl({ db, orderId: 'order-1', order: { automationState: 'submitted', cvUploadedAt: new Date(NOW - 91 * DAY) }, nowMs: NOW, getSecret })).toBe('');
    // A refund anchors the purge.
    const refunded = await submittedReviewUrl({ db, orderId: 'order-1', order: { automationState: 'submitted', cvUploadedAt: new Date(NOW - 80 * DAY), refundedAt: new Date(NOW) }, nowMs: NOW, getSecret });
    expect(verifyReviewToken({ secret: SECRET, token: new URL(refunded).searchParams.get('assisted_application_review'), nowMs: NOW })).toMatchObject({ ok: true, expiresAt: NOW + 90 * DAY });
    // An order kept for the talent pool: as long as the consent (owner decision 2026-10-05), which the
    // review endpoint checks at every access — well beyond 30 days and the 90 of the purge.
    const kept = await submittedReviewUrl({ db, orderId: 'order-1', order: { automationState: 'submitted', cvUploadedAt: new Date(NOW - 200 * DAY), talentPoolConsent: true }, nowMs: NOW, getSecret });
    const keptToken = new URL(kept).searchParams.get('assisted_application_review');
    expect(verifyReviewToken({ secret: SECRET, token: keptToken, nowMs: NOW + 400 * DAY }))
      .toMatchObject({ ok: true, kind: 'review', consentBound: true, expiresAt: CONSENT_BOUND_EXPIRES_AT });
    // Without a date for the purge and without the consent: the usual 30 days, never bound to a consent.
    const undated = await submittedReviewUrl({ db, orderId: 'order-1', order: { automationState: 'submitted' }, nowMs: NOW, getSecret });
    expect(verifyReviewToken({ secret: SECRET, token: new URL(undated).searchParams.get('assisted_application_review'), nowMs: NOW }))
      .toMatchObject({ ok: true, expiresAt: NOW + 30 * DAY, consentBound: false });
    // An order the purge already emptied is no longer kept for the pool: its documents are gone.
    expect(await submittedReviewUrl({ db, orderId: 'order-1', order: { automationState: 'submitted', talentPoolConsent: true, retentionPurgedAt: new Date(NOW) }, nowMs: NOW, getSecret })).not.toContain('assisted_application_review');
  });
});
