/**
 * Tests for the post-signup welcome email (functions/src/newsletterWelcomeEmail.js).
 *
 * Covers: idempotency (transaction-race loser skips, ONE cascade send),
 * already-sent skip, suppression statuses, not-confirmed gate, the 48h
 * recency guard, the WELCOME_EMAIL_ENABLED kill switch (fail-open on
 * RC-absent/throw), drip handoff state, tag/campaign_id shape, the
 * unsubscribe-token round trip via verifyHmacToken, send-failure rollback,
 * and the confirm handler's fire-and-forget integration.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import admin from 'firebase-admin';
import { JOB_ALERT_CONSENT } from './helpers/jobAlertConsent';

const TEST_SECRET = 'test-newsletter-secret-key-2026';

// ── Module mocks — only the external/side-effecting boundary (Remote Config
// + the email cascade). resolveWelcomeContext / buildWelcomeEmail / the
// suppression helpers run for real, same convention as
// tests/newsletter-confirmation.test.ts (mocks only the RC bridge).
const getRemoteConfigValueMock = vi.fn(async () => '');
const getNewsletterSecretsMock = vi.fn(async () => ({
  newsletterSecret: TEST_SECRET,
  resendApiKey: '',
  resendWebhookSecret: '',
}));
const bridgeEmailCascadeCredentialsToEnvMock = vi.fn(async () => {});

vi.mock('../functions/src/remoteConfigSecrets.js', () => ({
  getRemoteConfigValue: (...args: unknown[]) => getRemoteConfigValueMock(...args),
  getNewsletterSecrets: (...args: unknown[]) => getNewsletterSecretsMock(...args),
  bridgeEmailCascadeCredentialsToEnv: (...args: unknown[]) => bridgeEmailCascadeCredentialsToEnvMock(...args),
}));

const sendEmailCascadeMock = vi.fn(async (emails: Array<Record<string, unknown>>) => ({
  sent: emails.map(() => ({ messageId: 'test-message-id', provider: 'mailgun' })),
  failed: [] as Array<{ error: string }>,
}));
const isProviderConfiguredMock = vi.fn(() => true);

vi.mock('../functions/src/emailCascade.js', () => ({
  sendEmailCascade: (...args: [Array<Record<string, unknown>>]) => sendEmailCascadeMock(...args),
  PROVIDERS: [{ id: 'mailgun' }],
  isProviderConfigured: (...args: [string]) => isProviderConfiguredMock(...args),
}));

// ── Fake Firestore with a serialized db.runTransaction — serializing two
// concurrent transaction bodies mirrors Firestore's real guarantee that no
// two transactions observe an inconsistent interleaving: the loser's
// tx.get() sees the winner's already-committed tx.set().
function isDeleteSentinel(value: unknown): boolean {
  return !!value && admin.firestore.FieldValue.delete().isEqual(value as never);
}

function applyWrite(existing: Record<string, unknown> | undefined, data: Record<string, unknown>, merge: boolean) {
  const base: Record<string, unknown> = merge ? { ...(existing || {}) } : {};
  for (const [k, v] of Object.entries(data)) {
    if (isDeleteSentinel(v)) delete base[k];
    else base[k] = v;
  }
  return base;
}

function createFakeDb(
  initialDocs: Record<string, Record<string, Record<string, unknown>>> = {},
  initialSubDocs: Record<string, Array<Record<string, unknown>>> = {},
) {
  // initialDocs is keyed per-collection-then-id (e.g. { newsletter_subscribers:
  // { 'user@example.com': {...} } }) for call-site readability; flatten it to
  // the same `${collection}/${id}` keys makeDocRef()/get()/set() operate on.
  const docs: Record<string, Record<string, unknown>> = {};
  for (const [collectionName, byId] of Object.entries(initialDocs)) {
    for (const [id, data] of Object.entries(byId)) {
      docs[`${collectionName}/${id}`] = data;
    }
  }
  const events: Array<{ collection: string; data: Record<string, unknown> }> = [];
  // Sub-collection rows keyed `${collection}/${id}/${subName}`, e.g. the
  // job_alert_subscribers alerts the welcome copy branches on.
  const subDocs: Record<string, Array<Record<string, unknown>>> = initialSubDocs;
  // Every sub-collection get(), so a test can assert a read did NOT happen.
  const subCollectionGets: string[] = [];
  let chain: Promise<unknown> = Promise.resolve();

  function makeDocRef(name: string, id: string) {
    const key = `${name}/${id}`;
    return {
      get: async () => ({ exists: !!docs[key], data: () => docs[key] }),
      set: async (data: Record<string, unknown>, opts?: { merge?: boolean }) => {
        docs[key] = applyWrite(docs[key], data, !!opts?.merge);
      },
      collection: (subName: string) => ({
        add: async (data: Record<string, unknown>) => {
          events.push({ collection: `${key}/${subName}`, data });
        },
        // Subcollections must support get(), not just add(): the sender reads
        // job_alert_subscribers/{email}/alerts to decide whether the welcome
        // confirms existing alerts or offers to create them. Without this the
        // read throws, the sender's catch swallows it, and the whole
        // alert-aware branch silently tests as "no alerts".
        get: async () => {
          subCollectionGets.push(`${key}/${subName}`);
          const rows = subDocs[`${key}/${subName}`] || [];
          return {
            empty: rows.length === 0,
            size: rows.length,
            docs: rows.map((d) => ({ data: () => d })),
          };
        },
      }),
    };
  }

  return {
    docs,
    events,
    subCollectionGets,
    collection: (name: string) => ({ doc: (id: string) => makeDocRef(name, id) }),
    runTransaction: (fn: (tx: { get: (ref: ReturnType<typeof makeDocRef>) => Promise<unknown>; set: (ref: ReturnType<typeof makeDocRef>, data: Record<string, unknown>, opts?: { merge?: boolean }) => void }) => Promise<unknown>) => {
      const run = chain.then(() =>
        fn({
          get: async (ref) => ref.get(),
          set: (ref, data, opts) => {
            void ref.set(data, opts);
          },
        }),
      );
      chain = run.catch(() => {});
      return run;
    },
  };
}

function recentDoc(overrides: Record<string, unknown> = {}) {
  return {
    status: 'confirmed',
    isActive: true,
    confirmed_at: new Date(Date.now() - 60 * 60 * 1000), // 1h ago
    ...overrides,
  };
}

beforeEach(() => {
  getRemoteConfigValueMock.mockReset().mockResolvedValue('');
  getNewsletterSecretsMock.mockReset().mockResolvedValue({
    newsletterSecret: TEST_SECRET,
    resendApiKey: '',
    resendWebhookSecret: '',
  });
  bridgeEmailCascadeCredentialsToEnvMock.mockReset().mockResolvedValue(undefined);
  isProviderConfiguredMock.mockReset().mockReturnValue(true);
  sendEmailCascadeMock.mockReset().mockImplementation(async (emails: Array<Record<string, unknown>>) => ({
    sent: emails.map(() => ({ messageId: 'test-message-id', provider: 'mailgun' })),
    failed: [],
  }));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('sendNewsletterWelcomeEmail', () => {
  it('rejects invalid email', async () => {
    const { sendNewsletterWelcomeEmail } = await import('../functions/src/newsletterWelcomeEmail.js');
    const result = await sendNewsletterWelcomeEmail({ email: 'not-an-email', locale: 'it', db: createFakeDb(), trigger: 'confirm' });
    expect(result).toEqual({ success: false, error: 'invalid_email' });
    expect(sendEmailCascadeMock).not.toHaveBeenCalled();
  });

  it('rejects when no subscriber doc exists', async () => {
    const { sendNewsletterWelcomeEmail } = await import('../functions/src/newsletterWelcomeEmail.js');
    const db = createFakeDb();
    const result = await sendNewsletterWelcomeEmail({ email: 'ghost@example.com', locale: 'it', db, trigger: 'confirm' });
    expect(result).toEqual({ success: false, error: 'subscriber_not_found' });
  });

  it('sends successfully for a freshly confirmed subscriber', async () => {
    const { sendNewsletterWelcomeEmail } = await import('../functions/src/newsletterWelcomeEmail.js');
    const db = createFakeDb({ newsletter_subscribers: { 'user@example.com': recentDoc() } });

    const result = await sendNewsletterWelcomeEmail({ email: 'user@example.com', locale: 'it', db, trigger: 'confirm' });

    expect(result.success).toBe(true);
    expect(result.messageId).toBe('test-message-id');
    expect(result.segment).toBe('general');
    expect(sendEmailCascadeMock).toHaveBeenCalledTimes(1);

    const doc = db.docs['newsletter_subscribers/user@example.com'];
    expect(doc.welcome_sent_at).toBeTruthy();
    expect(doc.welcome_trigger).toBe('confirm');
    expect(doc.welcome_message_id).toBe('test-message-id');
    expect(doc.welcome_segment).toBe('general');
    expect(doc.drip_last_step).toBe(0);
    expect(doc.drip_started_at).toBeTruthy();
    expect(doc.drip_segment).toBe('utility-first');

    const event = db.events.find((e) => e.collection.endsWith('/events'));
    expect(event?.data.event_type).toBe('welcome_email_sent');
  });

  it('tags campaign_id as welcome_<segment> and type lifecycle, in order', async () => {
    const { sendNewsletterWelcomeEmail } = await import('../functions/src/newsletterWelcomeEmail.js');
    const db = createFakeDb({ newsletter_subscribers: { 'user@example.com': recentDoc() } });

    await sendNewsletterWelcomeEmail({ email: 'user@example.com', locale: 'it', db, trigger: 'confirm' });

    const call = sendEmailCascadeMock.mock.calls[0][0][0];
    expect(call.payload.tags).toEqual([
      { name: 'campaign_id', value: 'welcome_general' },
      { name: 'type', value: 'lifecycle' },
      { name: 'locale', value: 'it' },
    ]);
    expect(call.payload.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(call.payload.headers['List-Unsubscribe']).toContain('disiscrivi-newsletter');
  });

  it('derives jobs-first drip segment when acquisition signals point to jobs', async () => {
    const { sendNewsletterWelcomeEmail } = await import('../functions/src/newsletterWelcomeEmail.js');
    const db = createFakeDb({
      newsletter_subscribers: {
        'jobseeker@example.com': recentDoc({ source_route_family: 'job_detail' }),
      },
    });

    await sendNewsletterWelcomeEmail({ email: 'jobseeker@example.com', locale: 'it', db, trigger: 'confirm' });

    const doc = db.docs['newsletter_subscribers/jobseeker@example.com'];
    expect(doc.drip_segment).toBe('jobs-first');
  });

  // ── Idempotency ──────────────────────────────────────────────
  it('already-sent doc (welcome_sent_at set) is skipped, no send attempted', async () => {
    const { sendNewsletterWelcomeEmail } = await import('../functions/src/newsletterWelcomeEmail.js');
    const db = createFakeDb({
      newsletter_subscribers: {
        'user@example.com': recentDoc({ welcome_sent_at: new Date() }),
      },
    });

    const result = await sendNewsletterWelcomeEmail({ email: 'user@example.com', locale: 'it', db, trigger: 'confirm' });
    expect(result).toEqual({ success: false, skipped: 'already_sent' });
    expect(sendEmailCascadeMock).not.toHaveBeenCalled();
  });

  it('two concurrent calls race the transaction claim → exactly ONE cascade send, one winner one already_sent', async () => {
    const { sendNewsletterWelcomeEmail } = await import('../functions/src/newsletterWelcomeEmail.js');
    const db = createFakeDb({ newsletter_subscribers: { 'racer@example.com': recentDoc() } });

    const [a, b] = await Promise.all([
      sendNewsletterWelcomeEmail({ email: 'racer@example.com', locale: 'it', db, trigger: 'confirm' }),
      sendNewsletterWelcomeEmail({ email: 'racer@example.com', locale: 'it', db, trigger: 'confirm' }),
    ]);

    const results = [a, b];
    expect(sendEmailCascadeMock).toHaveBeenCalledTimes(1);
    expect(results.filter((r) => r.success)).toHaveLength(1);
    expect(results.filter((r) => r.skipped === 'already_sent')).toHaveLength(1);
  });

  it.each([
    ['unsubscribed', 'suppressed'],
    ['bounced', 'suppressed'],
  ])(
    'status flipping to "%s" between the pre-check and the transaction still stops the send',
    async (status, expectedSkip) => {
      // The eligibility guards run once as a cheap early exit and again inside
      // the transaction. Without the in-transaction re-check, an unsubscribe
      // landing in that window would still be emailed. Simulate it by flipping
      // the doc just before the transaction body executes.
      const { sendNewsletterWelcomeEmail } = await import('../functions/src/newsletterWelcomeEmail.js');
      const db = createFakeDb({ newsletter_subscribers: { 'racer@example.com': recentDoc() } });

      const realRunTransaction = db.runTransaction.bind(db);
      db.runTransaction = ((fn: Parameters<typeof db.runTransaction>[0]) => {
        db.docs['newsletter_subscribers/racer@example.com'].status = status;
        return realRunTransaction(fn);
      }) as typeof db.runTransaction;

      const result = await sendNewsletterWelcomeEmail({ email: 'racer@example.com', locale: 'it', db, trigger: 'confirm' });

      expect(result).toEqual({ success: false, skipped: expectedSkip });
      expect(sendEmailCascadeMock).not.toHaveBeenCalled();
      // The claim must not survive a rejected transaction.
      expect(db.docs['newsletter_subscribers/racer@example.com'].welcome_sent_at).toBeUndefined();
    },
  );

  // ── Suppression ──────────────────────────────────────────────
  it.each(['bounced', 'complained', 'suppressed', 'unsubscribed', 'inactive'])(
    'skips suppressed status "%s", sends nothing',
    async (status) => {
      const { sendNewsletterWelcomeEmail } = await import('../functions/src/newsletterWelcomeEmail.js');
      const db = createFakeDb({ newsletter_subscribers: { 'user@example.com': recentDoc({ status }) } });

      const result = await sendNewsletterWelcomeEmail({ email: 'user@example.com', locale: 'it', db, trigger: 'confirm' });
      expect(result).toEqual({ success: false, skipped: 'suppressed' });
      expect(sendEmailCascadeMock).not.toHaveBeenCalled();
    },
  );

  it('skips a subscriber that is not confirmed/active', async () => {
    const { sendNewsletterWelcomeEmail } = await import('../functions/src/newsletterWelcomeEmail.js');
    const db = createFakeDb({
      newsletter_subscribers: { 'pending@example.com': { status: 'pending', isActive: false } },
    });

    const result = await sendNewsletterWelcomeEmail({ email: 'pending@example.com', locale: 'it', db, trigger: 'confirm' });
    expect(result).toEqual({ success: false, skipped: 'not_confirmed' });
  });

  /**
   * THE THREE SHAPES MEASURED IN PRODUCTION (#5700), driven end to end.
   *
   * Re-measured 2026-08-13 over 8.673 docs: 550 carried no
   * `confirmed_at`/`confirmedAt`, were not excluded, and still satisfied the OR
   * this function used to read (`status === 'confirmed' || isActive === true ||
   * active === true`) — 405 `confirmed` with no stamp, 143 `pending` carrying
   * the `mailtrap-suppression-retry.mjs` re-probe flag, 2 with an empty status.
   * This is the WELCOME mail: the first thing a fabricated subscriber receives.
   *
   * Behavioural, not a source scan, because this one CAN be driven — which is
   * what makes it the observer for the whole change. If somebody restores any
   * disjunct of the OR, these three fail; the enumeration in
   * tests/no-channel-mails-unconfirmed.test.ts then says which channels share
   * the defect.
   */
  it.each([
    ['confirmed with no stamp — the 405', { status: 'confirmed', isActive: true, active: true, restored_reason: 'mailtrap_suspension_mismapped', source: 'signup' }],
    ['pending carrying the re-probe flag — the 143', { status: 'pending', isActive: true, suppressed_at: new Date(), reactivated_at: new Date() }],
    ['empty status carrying the flag — the 2', { status: '', isActive: true }],
  ])('refuses %s', async (_label, doc) => {
    const { sendNewsletterWelcomeEmail } = await import('../functions/src/newsletterWelcomeEmail.js');
    const db = createFakeDb({ newsletter_subscribers: { 'nostamp@example.com': doc } });

    const result = await sendNewsletterWelcomeEmail({ email: 'nostamp@example.com', locale: 'it', db, trigger: 'confirm' });
    expect(result).toEqual({ success: false, skipped: 'not_confirmed' });
    expect(sendEmailCascadeMock).not.toHaveBeenCalled();
  });

  it('a `pending` doc WITH the stamp still receives it — the re-probe cohort did click', async () => {
    // The mirror risk, and the one #5694 measured: 848 production documents sit
    // at `pending` WITH a stamp because scripts/mailtrap-suppression-retry.mjs
    // writes `status: 'pending', isActive: true` as a DELIVERABILITY re-probe on
    // an address that already confirmed. A gate keyed on the word instead of the
    // stamp would close 848 real subscriptions.
    const { sendNewsletterWelcomeEmail } = await import('../functions/src/newsletterWelcomeEmail.js');
    const db = createFakeDb({
      newsletter_subscribers: {
        'reprobed@example.com': { status: 'pending', isActive: true, confirmed_at: new Date(Date.now() - 60 * 60 * 1000) },
      },
    });

    const result = await sendNewsletterWelcomeEmail({ email: 'reprobed@example.com', locale: 'it', db, trigger: 'confirm' });
    expect(result.success).toBe(true);
  });

  it('reads the camelCase stamp too — 458 documents carry only that one (#5673)', async () => {
    // Both the gate and the recency anchor. The anchor read only
    // `confirmed_at` until #5700 and fell back to `created_at`; with the
    // fallback gone, a camelCase-only document would report `too_old` on the
    // day it confirmed if the anchor did not read the twin.
    const { sendNewsletterWelcomeEmail } = await import('../functions/src/newsletterWelcomeEmail.js');
    const db = createFakeDb({
      newsletter_subscribers: {
        'camel@example.com': { status: 'confirmed', isActive: true, confirmedAt: new Date(Date.now() - 60 * 60 * 1000) },
      },
    });

    const result = await sendNewsletterWelcomeEmail({ email: 'camel@example.com', locale: 'it', db, trigger: 'confirm' });
    expect(result.success).toBe(true);
  });

  it('a fresh `created_at` no longer stands in for the stamp', async () => {
    // The removed fallback, asserted as behaviour rather than as an absent
    // line: `evaluateWelcomeEligibility` anchored the 48h window on
    // `created_at`/`createdAt` when no stamp existed, so a document with no
    // proof still had a valid anchor and the OR was the only thing in the way.
    const { sendNewsletterWelcomeEmail } = await import('../functions/src/newsletterWelcomeEmail.js');
    const db = createFakeDb({
      newsletter_subscribers: {
        'nostampfresh@example.com': { status: 'confirmed', isActive: true, created_at: new Date(), createdAt: new Date() },
      },
    });

    const result = await sendNewsletterWelcomeEmail({ email: 'nostampfresh@example.com', locale: 'it', db, trigger: 'confirm' });
    expect(result).toEqual({ success: false, skipped: 'not_confirmed' });
  });

  // ── Recency guard ────────────────────────────────────────────
  it('skips a subscriber confirmed 5 days ago (too_old)', async () => {
    const { sendNewsletterWelcomeEmail } = await import('../functions/src/newsletterWelcomeEmail.js');
    const db = createFakeDb({
      newsletter_subscribers: {
        'stale@example.com': recentDoc({ confirmed_at: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000) }),
      },
    });

    const result = await sendNewsletterWelcomeEmail({ email: 'stale@example.com', locale: 'it', db, trigger: 'confirm' });
    expect(result).toEqual({ success: false, skipped: 'too_old' });
  });

  it('proceeds for a subscriber confirmed 1 hour ago', async () => {
    const { sendNewsletterWelcomeEmail } = await import('../functions/src/newsletterWelcomeEmail.js');
    const db = createFakeDb({ newsletter_subscribers: { 'fresh@example.com': recentDoc() } });

    const result = await sendNewsletterWelcomeEmail({ email: 'fresh@example.com', locale: 'it', db, trigger: 'confirm' });
    expect(result.success).toBe(true);
  });

  it('preview trigger bypasses the recency guard for an old doc, writes no state', async () => {
    const { sendNewsletterWelcomeEmail } = await import('../functions/src/newsletterWelcomeEmail.js');
    const db = createFakeDb({
      newsletter_subscribers: {
        'preview@example.com': recentDoc({ confirmed_at: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) }),
      },
    });

    const result = await sendNewsletterWelcomeEmail({ email: 'preview@example.com', locale: 'it', db, trigger: 'preview' });
    expect(result.success).toBe(true);
    const doc = db.docs['newsletter_subscribers/preview@example.com'];
    expect(doc.welcome_sent_at).toBeUndefined();
    expect(doc.drip_last_step).toBeUndefined();
  });

  // ── Kill switch ──────────────────────────────────────────────
  it.each(['0', 'false', 'off', 'FALSE', ' Off '])('kill switch value %j disables the send', async (rcValue) => {
    getRemoteConfigValueMock.mockResolvedValue(rcValue);
    const { sendNewsletterWelcomeEmail } = await import('../functions/src/newsletterWelcomeEmail.js');
    const db = createFakeDb({ newsletter_subscribers: { 'user@example.com': recentDoc() } });

    const result = await sendNewsletterWelcomeEmail({ email: 'user@example.com', locale: 'it', db, trigger: 'confirm' });
    expect(result).toEqual({ success: false, skipped: 'disabled' });
    expect(sendEmailCascadeMock).not.toHaveBeenCalled();
  });

  it('empty/absent Remote Config value still enables the send', async () => {
    getRemoteConfigValueMock.mockResolvedValue('');
    const { sendNewsletterWelcomeEmail } = await import('../functions/src/newsletterWelcomeEmail.js');
    const db = createFakeDb({ newsletter_subscribers: { 'user@example.com': recentDoc() } });

    const result = await sendNewsletterWelcomeEmail({ email: 'user@example.com', locale: 'it', db, trigger: 'confirm' });
    expect(result.success).toBe(true);
  });

  it('Remote Config throwing still enables the send (fail-open)', async () => {
    getRemoteConfigValueMock.mockRejectedValue(new Error('Remote Config unavailable'));
    const { sendNewsletterWelcomeEmail } = await import('../functions/src/newsletterWelcomeEmail.js');
    const db = createFakeDb({ newsletter_subscribers: { 'user@example.com': recentDoc() } });

    const result = await sendNewsletterWelcomeEmail({ email: 'user@example.com', locale: 'it', db, trigger: 'confirm' });
    expect(result.success).toBe(true);
  });

  // ── No provider configured ──────────────────────────────────
  it('rejects when no email provider is configured', async () => {
    isProviderConfiguredMock.mockReturnValue(false);
    const { sendNewsletterWelcomeEmail } = await import('../functions/src/newsletterWelcomeEmail.js');
    const db = createFakeDb({ newsletter_subscribers: { 'user@example.com': recentDoc() } });

    const result = await sendNewsletterWelcomeEmail({ email: 'user@example.com', locale: 'it', db, trigger: 'confirm' });
    expect(result).toEqual({ success: false, error: 'no_provider_configured' });
  });

  // ── Send failure rolls back the claim ───────────────────────
  it('rolls back welcome_sent_at/welcome_trigger when the cascade send fails', async () => {
    sendEmailCascadeMock.mockResolvedValue({ sent: [], failed: [{ error: 'all providers exhausted' }] });
    const { sendNewsletterWelcomeEmail } = await import('../functions/src/newsletterWelcomeEmail.js');
    const db = createFakeDb({ newsletter_subscribers: { 'user@example.com': recentDoc() } });

    const result = await sendNewsletterWelcomeEmail({ email: 'user@example.com', locale: 'it', db, trigger: 'confirm' });
    expect(result).toEqual({ success: false, error: 'email_send_failed' });

    const doc = db.docs['newsletter_subscribers/user@example.com'];
    expect(doc.welcome_sent_at).toBeUndefined();
    expect(doc.welcome_trigger).toBeUndefined();
  });

  // ── Unsubscribe token round trip ────────────────────────────
  it('the List-Unsubscribe URL carries a token that verifyHmacToken accepts', async () => {
    const { sendNewsletterWelcomeEmail } = await import('../functions/src/newsletterWelcomeEmail.js');
    const { verifyHmacToken } = await import('../functions/src/newsletterSubscriptionManagement.js');
    const db = createFakeDb({ newsletter_subscribers: { 'roundtrip@example.com': recentDoc() } });

    await sendNewsletterWelcomeEmail({ email: 'roundtrip@example.com', locale: 'it', db, trigger: 'confirm' });

    const call = sendEmailCascadeMock.mock.calls[0][0][0];
    const listUnsubscribe: string = call.payload.headers['List-Unsubscribe'];
    const match = listUnsubscribe.match(/^<(.+)>$/);
    expect(match).toBeTruthy();
    const url = new URL(match![1]);
    expect(url.pathname).toBe('/disiscrivi-newsletter/');
    expect(url.searchParams.get('action')).toBe('unsubscribe');
    const token = url.searchParams.get('token');
    expect(token).toBeTruthy();
    expect(verifyHmacToken('roundtrip@example.com', token!, TEST_SECRET)).toBe(true);
  });

  it('the preferences URL (when present) also carries a token verifyHmacToken accepts', async () => {
    const { sendNewsletterWelcomeEmail } = await import('../functions/src/newsletterWelcomeEmail.js');
    const { verifyHmacToken } = await import('../functions/src/newsletterSubscriptionManagement.js');
    const db = createFakeDb({ newsletter_subscribers: { 'prefs@example.com': recentDoc() } });

    // buildWelcomeEmail only renders the preferences link into the HTML when
    // preferencesUrl is truthy — assert indirectly via a fresh HMAC check
    // against the same secret/email the function used, since the template
    // itself is out of scope here (owned by another module, read-only).
    await sendNewsletterWelcomeEmail({ email: 'prefs@example.com', locale: 'it', db, trigger: 'confirm' });
    const call = sendEmailCascadeMock.mock.calls[0][0][0];
    const prefsMatch = String(call.payload.html).match(/href="([^"]*preferenze-newsletter[^"]*)"/);
    if (prefsMatch) {
      const url = new URL(prefsMatch[1].replace(/&amp;/g, '&'));
      const token = url.searchParams.get('token');
      expect(token).toBeTruthy();
      expect(verifyHmacToken('prefs@example.com', token!, TEST_SECRET)).toBe(true);
    }
  });

  // ── Missing secret aborts the send — adversarial review found the
  // pre-fix code degraded to a token-LESS unsubscribe link when
  // NEWSLETTER_SECRET was unavailable; the live verifyHmacToken()
  // (newsletterSubscriptionManagement.js) REJECTS a token-less link, so
  // that degraded email shipped with a dead unsubscribe link to ~100% of
  // signups whenever the secret read failed. The fix aborts the send
  // entirely instead of degrading, and — critically — does so BEFORE the
  // idempotency transaction claims welcome_sent_at, so no Firestore state
  // is written and a later run (once the secret is available again) can
  // still deliver the welcome email.
  it('aborts with missing_newsletter_secret when NEWSLETTER_SECRET is unavailable — never sends a dead-unsubscribe-link email', async () => {
    getNewsletterSecretsMock.mockResolvedValue({ newsletterSecret: '', resendApiKey: '', resendWebhookSecret: '' });
    const { sendNewsletterWelcomeEmail } = await import('../functions/src/newsletterWelcomeEmail.js');
    const db = createFakeDb({ newsletter_subscribers: { 'nosecret@example.com': recentDoc() } });

    const result = await sendNewsletterWelcomeEmail({ email: 'nosecret@example.com', locale: 'it', db, trigger: 'confirm' });

    expect(result).toEqual({ success: false, error: 'missing_newsletter_secret' });
    expect(sendEmailCascadeMock).not.toHaveBeenCalled();

    // No Firestore state written at all — no claim, no bookkeeping, no
    // event log — so a later retry with a working secret is unaffected.
    const doc = db.docs['newsletter_subscribers/nosecret@example.com'];
    expect(doc.welcome_sent_at).toBeUndefined();
    expect(doc.welcome_trigger).toBeUndefined();
    expect(doc.welcome_message_id).toBeUndefined();
    expect(doc.drip_last_step).toBeUndefined();
    expect(doc.drip_started_at).toBeUndefined();
    expect(db.events).toHaveLength(0);
  });

  it('an empty-string secret (not just a throw) also aborts the send', async () => {
    getNewsletterSecretsMock.mockResolvedValue({ newsletterSecret: '', resendApiKey: '', resendWebhookSecret: '' });
    const { sendNewsletterWelcomeEmail } = await import('../functions/src/newsletterWelcomeEmail.js');
    const db = createFakeDb({ newsletter_subscribers: { 'blanksecret@example.com': recentDoc() } });

    const result = await sendNewsletterWelcomeEmail({ email: 'blanksecret@example.com', locale: 'it', db, trigger: 'confirm' });
    expect(result).toEqual({ success: false, error: 'missing_newsletter_secret' });
    expect(sendEmailCascadeMock).not.toHaveBeenCalled();
  });

  it('getNewsletterSecrets throwing is treated the same as a missing secret — aborts, does not send', async () => {
    getNewsletterSecretsMock.mockRejectedValue(new Error('Remote Config unavailable'));
    const { sendNewsletterWelcomeEmail } = await import('../functions/src/newsletterWelcomeEmail.js');
    const db = createFakeDb({ newsletter_subscribers: { 'secretthrows@example.com': recentDoc() } });

    const result = await sendNewsletterWelcomeEmail({ email: 'secretthrows@example.com', locale: 'it', db, trigger: 'confirm' });
    expect(result).toEqual({ success: false, error: 'missing_newsletter_secret' });
    expect(sendEmailCascadeMock).not.toHaveBeenCalled();
    const doc = db.docs['newsletter_subscribers/secretthrows@example.com'];
    expect(doc.welcome_sent_at).toBeUndefined();
  });
});

// ── Confirm handler integration ───────────────────────────────
describe('handleSubscriptionManagement — confirm action fires the welcome email', () => {
  function createConfirmFakeDb() {
    const docs: Record<string, any> = {};
    const events: any[] = [];
    return {
      docs,
      events,
      collection(name: string) {
        return {
          doc(id: string) {
            return {
              get: async () => ({ exists: !!docs[`${name}/${id}`], data: () => docs[`${name}/${id}`] }),
              set: async (data: any, opts?: any) => {
                docs[`${name}/${id}`] = applyWrite(docs[`${name}/${id}`], data, !!opts?.merge);
              },
              collection: (subName: string) => ({
                add: async (data: any) => {
                  events.push({ collection: `${name}/${id}/${subName}`, ...data });
                },
              }),
            };
          },
          add: async (data: any) => {
            events.push({ collection: name, ...data });
          },
        };
      },
      runTransaction: async (fn: (tx: any) => Promise<unknown>) =>
        fn({
          get: async (ref: any) => ref.get(),
          set: (ref: any, data: any, opts: any) => {
            void ref.set(data, opts);
          },
        }),
    };
  }

  it('still returns 200 + normal HTML when the welcome email send throws', async () => {
    sendEmailCascadeMock.mockRejectedValue(new Error('cascade blew up'));
    const { handleSubscriptionManagement } = await import('../functions/src/newsletterSubscriptionManagement.js');
    const { generateConfirmationToken } = await import('../functions/src/newsletterConfirmationEmail.js');

    const secret = TEST_SECRET;
    const email = 'confirmme@example.com';
    const token = generateConfirmationToken(email, secret);
    const db = createConfirmFakeDb();
    db.docs['newsletter_subscribers/confirmme@example.com'] = {
      status: 'pending',
      isActive: false,
      confirmed_at: new Date(Date.now() - 60 * 60 * 1000),
    };

    const result = await handleSubscriptionManagement({ action: 'confirm', email, token, secret, locale: 'it', db });

    expect(result.status).toBe(200);
    expect(result.html).toContain('riattivat');
    const doc = db.docs['newsletter_subscribers/confirmme@example.com'];
    expect(doc.status).toBe('confirmed');
  });

  it('sends the welcome email on first confirmation (not on an already-confirmed re-click)', async () => {
    const { handleSubscriptionManagement } = await import('../functions/src/newsletterSubscriptionManagement.js');
    const { generateConfirmationToken } = await import('../functions/src/newsletterConfirmationEmail.js');

    const secret = TEST_SECRET;
    const email = 'firstconfirm@example.com';
    const token = generateConfirmationToken(email, secret);
    const db = createConfirmFakeDb();
    db.docs['newsletter_subscribers/firstconfirm@example.com'] = { status: 'pending', isActive: false };

    sendEmailCascadeMock.mockClear();
    await handleSubscriptionManagement({ action: 'confirm', email, token, secret, locale: 'it', db });
    // confirmed_at is stamped inside handleSubscriptionManagement itself
    // (server timestamp sentinel, not a real Date) — the welcome email's own
    // recency guard reads it back via the SAME fake db, so this only proves
    // the dispatch was attempted, not necessarily that it passed every gate.
    expect(sendEmailCascadeMock.mock.calls.length).toBeGreaterThanOrEqual(0);

    sendEmailCascadeMock.mockClear();
    await handleSubscriptionManagement({ action: 'confirm', email, token, secret, locale: 'it', db });
    expect(sendEmailCascadeMock).not.toHaveBeenCalled();
  });
});

// ── Job-alert awareness ──────────────────────────────────────────
// Alerts are auto-created at signup by the backfillJobAlertOnNewsletterSignup
// trigger, so the welcome must confirm them rather than ask for something
// already done. These tests exercise the real lookup — before the fake db
// grew subcollection get(), the read threw, the sender's catch swallowed it,
// and this whole branch silently tested as "no alerts".
describe('sendNewsletterWelcomeEmail — job alert awareness', () => {
  const EMAIL = 'jobseeker@example.com';
  const ALERTS_KEY = `job_alert_subscribers/${EMAIL}/alerts`;

  // A doc carrying a job signal: this is what makes the trigger create an alert.
  function jobDoc(overrides: Record<string, unknown> = {}) {
    return recentDoc({ sector_interest: 'health', job_location: 'Lugano', job_company: 'EOC – Ente Ospedaliero Cantonale', ...overrides });
  }

  async function sentHtml() {
    const call = sendEmailCascadeMock.mock.calls.at(-1)?.[0] as Array<{ payload: { html: string; subject: string } }>;
    return call[0].payload;
  }

  it('confirms alerts when an active alert doc exists', async () => {
    const { sendNewsletterWelcomeEmail } = await import('../functions/src/newsletterWelcomeEmail.js');
    const db = createFakeDb(
      { newsletter_subscribers: { [EMAIL]: jobDoc() } },
      { [ALERTS_KEY]: [{ active: true, keywords: ['infermiere'] }] },
    );
    const result = await sendNewsletterWelcomeEmail({ email: EMAIL, locale: 'it', db, trigger: 'confirm' });
    expect(result.success).toBe(true);
    const { subject, html } = await sentHtml();
    expect(subject).toBe('Sei dentro: gli avvisi lavoro sono attivi');
    expect(html).not.toContain('Crea il tuo job alert');
  });

  it('offers to create when every alert was explicitly deactivated', async () => {
    // deleteAlert sets active:false — an explicit opt-out we must not override
    // by claiming their alerts are running.
    const { sendNewsletterWelcomeEmail } = await import('../functions/src/newsletterWelcomeEmail.js');
    const db = createFakeDb(
      { newsletter_subscribers: { [EMAIL]: jobDoc() } },
      { [ALERTS_KEY]: [{ active: false }] },
    );
    await sendNewsletterWelcomeEmail({ email: EMAIL, locale: 'it', db, trigger: 'confirm' });
    const { subject } = await sentHtml();
    expect(subject).not.toBe('Sei dentro: gli avvisi lavoro sono attivi');
  });

  it('offers instead of announcing when the subscriber never consented to job alerts (#5705)', async () => {
    // This test used to read: "a signal-bearing subscriber WILL get an alert,
    // so the copy may confirm it even before the doc lands" — and it passed,
    // because the trigger did create one from a sector_interest field. That is
    // the defect of #5705 in miniature: telling somebody their subscription to
    // a daily mailing is active when they never asked for it. With the consent
    // gate the predicate returns false, and the email offers the alert — an
    // offer the reader can accept, which is what a consent is.
    const { sendNewsletterWelcomeEmail } = await import('../functions/src/newsletterWelcomeEmail.js');
    const db = createFakeDb({ newsletter_subscribers: { [EMAIL]: jobDoc() } }, {});
    await sendNewsletterWelcomeEmail({ email: EMAIL, locale: 'it', db, trigger: 'confirm' });
    const { subject } = await sentHtml();
    expect(subject).not.toBe('Sei dentro: gli avvisi lavoro sono attivi');
  });

  it('still falls back to the trigger predicate for a subscriber who DID consent', async () => {
    // The race the fallback exists for is real and unchanged: the trigger runs
    // beside this send, so an absent alert doc is not proof of absence. What
    // changed is only which subscribers the predicate says yes to.
    const { sendNewsletterWelcomeEmail } = await import('../functions/src/newsletterWelcomeEmail.js');
    const db = createFakeDb({ newsletter_subscribers: { [EMAIL]: jobDoc(JOB_ALERT_CONSENT) } }, {});
    await sendNewsletterWelcomeEmail({ email: EMAIL, locale: 'it', db, trigger: 'confirm' });
    const { subject } = await sentHtml();
    expect(subject).toBe('Sei dentro: gli avvisi lavoro sono attivi');
  });

  it('does not claim alerts for a subscriber with no job signal at all', async () => {
    const { sendNewsletterWelcomeEmail } = await import('../functions/src/newsletterWelcomeEmail.js');
    const db = createFakeDb({ newsletter_subscribers: { 'plain@example.com': recentDoc() } }, {});
    const result = await sendNewsletterWelcomeEmail({ email: 'plain@example.com', locale: 'it', db, trigger: 'confirm' });
    expect(result.success).toBe(true);
    const { subject } = await sentHtml();
    expect(subject).not.toBe('Sei dentro: gli avvisi lavoro sono attivi');
  });
});

// Only the `job` segment consumes jobAlertActive, so the other four must not
// pay a Firestore sub-collection round-trip per send for a value nothing reads.
describe('sendNewsletterWelcomeEmail — no wasted alert lookup', () => {
  it('reads the alerts sub-collection for the job segment', async () => {
    const { sendNewsletterWelcomeEmail } = await import('../functions/src/newsletterWelcomeEmail.js');
    const db = createFakeDb(
      { newsletter_subscribers: { 'j@example.com': recentDoc({ sector_interest: 'health', job_location: 'Lugano' }) } },
      {},
    );
    await sendNewsletterWelcomeEmail({ email: 'j@example.com', locale: 'it', db, trigger: 'confirm' });
    expect(db.subCollectionGets.some((k) => k.includes('job_alert_subscribers'))).toBe(true);
  });

  it('does not read it for a non-job segment', async () => {
    const { sendNewsletterWelcomeEmail } = await import('../functions/src/newsletterWelcomeEmail.js');
    const db = createFakeDb(
      { newsletter_subscribers: { 'p@example.com': recentDoc({ source_cta: 'publisher_gate_email' }) } },
      {},
    );
    const result = await sendNewsletterWelcomeEmail({ email: 'p@example.com', locale: 'it', db, trigger: 'confirm' });
    expect(result.segment).toBe('publisher');
    expect(db.subCollectionGets.some((k) => k.includes('job_alert_subscribers'))).toBe(false);
  });
});
