/**
 * tests/transactional-suppression-guard.test.ts
 *
 * `sendCalculatorReport` and `newsletterConfirmationEmail` used to send with no
 * suppression check at all. Both now consult ONE narrow predicate,
 * `isTransactionalHardBlock` (functions/src/lib/emailSuppression.js) — not a
 * second suppression list, and deliberately not the marketing-grade
 * NEWSLETTER_EXCLUDED_STATUSES.
 *
 * The allowed cases below are the point of the whole thing. These are
 * TRANSACTIONAL emails the user asked for seconds ago — a PDF they submitted a
 * form to get, a double-opt-in confirmation they just triggered. Blocking an
 * `unsubscribed` / `inactive` / `pending` / soft-bounced address would break a
 * working lead-magnet funnel and would be wrong on the merits: a marketing
 * opt-out does not revoke a transactional request. Only a provably dead mailbox
 * (hard bounce) or a filed spam complaint is blocked, because re-mailing those
 * burns sender reputation across five free-tier ESPs / is a compliance hazard.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('firebase-admin', () => ({
  default: {
    firestore: Object.assign(
      () => ({ collection: () => ({ doc: () => ({}) }) }),
      {
        FieldValue: {
          serverTimestamp: () => '__server_ts__',
          delete: () => '__delete__',
          increment: (n: number) => n,
        },
      },
    ),
  },
}));

vi.mock('firebase-admin/remote-config', () => ({
  getRemoteConfig: () => ({ getTemplate: async () => ({ parameters: {} }) }),
}));

vi.mock('../functions/src/newsletterResendWebhookCore.js', () => ({
  getAdminDb: () => ({ collection: () => ({ doc: () => ({}) }) }),
  ensureAdminApp: () => undefined,
}));

vi.mock('../functions/src/emailI18n.js', () => ({
  t: (_lang: string, _key: string) => 'stub',
  htmlLang: (l: string) => l,
  normalizeLocale: (l: string) => (['it', 'en', 'de', 'fr'].includes(l) ? l : 'it'),
}));

vi.mock('../functions/src/remoteConfigSecrets.js', () => ({
  bridgeEmailCascadeCredentialsToEnv: vi.fn(async () => {}),
}));

vi.mock('../functions/src/emailCascade.js', () => ({
  isProviderConfigured: vi.fn(() => true),
  sendEmailCascade: vi.fn(async () => ({ sent: [{ messageId: 'msg_1' }], failed: [] })),
  PROVIDERS: [{ id: 'resend' }],
}));

const VALID_PDF_BASE64 = Buffer.from('%PDF-1.4 fake', 'utf8').toString('base64');

/**
 * Firestore double covering both handlers: doc get/set/update plus the
 * `events` subcollection add. `getImpl` can be made to throw to exercise the
 * fail-OPEN path.
 *
 * `runTransaction` is here because sendNewsletterConfirmationEmail writes its
 * ledger inside one since #5843: the counter is re-derived from a read taken
 * in the transaction, so two simultaneous resend clicks increment sequentially
 * instead of both writing the same attempt number. This double just runs the
 * callback — the conflict/retry behaviour that fix depends on is exercised
 * against a versioned double in tests/newsletter-confirmation-ledger-atomicity.test.ts.
 * What matters here is only that the guard verdicts below are still reached.
 */
function makeDb(docData: Record<string, unknown> | null, opts: { getThrows?: boolean } = {}) {
  const writes: Record<string, any>[] = [];
  const events: Record<string, any>[] = [];
  const docRef: any = {
    get: async () => {
      if (opts.getThrows) throw new Error('UNAVAILABLE: simulated Firestore outage');
      return { exists: docData !== null, data: () => docData || {} };
    },
    set: async (data: any) => { writes.push(data); },
    update: async (data: any) => { writes.push(data); },
    collection: () => ({
      add: async (data: any) => { events.push(data); },
      doc: () => ({ __event: true }),
    }),
  };
  const db = {
    writes,
    events,
    collection: () => ({ doc: () => docRef }),
    runTransaction: async (fn: (tx: any) => Promise<any>) =>
      fn({
        get: async (ref: any) => ref.get(),
        update: (_ref: any, data: any) => { writes.push(data); },
        set: (ref: any, data: any) => { (ref?.__event ? events : writes).push(data); },
      }),
  };
  return db;
}

async function cascade() {
  return import('../functions/src/emailCascade.js');
}

beforeEach(async () => {
  vi.clearAllMocks();
  const c = await cascade();
  vi.mocked(c.isProviderConfigured).mockReturnValue(true);
  vi.mocked(c.sendEmailCascade).mockResolvedValue({ sent: [{ messageId: 'msg_1' }], failed: [] } as any);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

// ── The predicate itself ─────────────────────────────────────────────────────

describe('isTransactionalHardBlock', () => {
  it('blocks a hard bounce and a spam complaint, and nothing else', async () => {
    const { isTransactionalHardBlock } = await import('../functions/src/lib/emailSuppression.js');
    expect(isTransactionalHardBlock({ status: 'bounced', bounceSeverity: 'hard' })).toBe(true);
    expect(isTransactionalHardBlock({ status: 'complained' })).toBe(true);
    expect(isTransactionalHardBlock({ status: 'COMPLAINED' })).toBe(true);
    expect(isTransactionalHardBlock({ status: 'suppressed', bounceSeverity: 'hard' })).toBe(true);
  });

  it('lets every soft/consent state through — these users asked for this email', async () => {
    const { isTransactionalHardBlock } = await import('../functions/src/lib/emailSuppression.js');
    expect(isTransactionalHardBlock({ status: 'unsubscribed' })).toBe(false);
    expect(isTransactionalHardBlock({ status: 'inactive' })).toBe(false);
    expect(isTransactionalHardBlock({ status: 'pending' })).toBe(false);
    expect(isTransactionalHardBlock({ status: 'confirmed' })).toBe(false);
    expect(isTransactionalHardBlock({ status: 'bounced', bounceSeverity: 'soft' })).toBe(false);
    // No severity recorded → not provably a dead mailbox → allowed.
    expect(isTransactionalHardBlock({ status: 'bounced' })).toBe(false);
    expect(isTransactionalHardBlock({ status: 'suppressed' })).toBe(false);
    expect(isTransactionalHardBlock({})).toBe(false);
    expect(isTransactionalHardBlock()).toBe(false);
  });

  it('is narrower than the marketing exclusion set it must not be confused with', async () => {
    const { isTransactionalHardBlock, isNewsletterExcluded } = await import(
      '../functions/src/lib/emailSuppression.js'
    );
    for (const status of ['unsubscribed', 'inactive']) {
      expect(isNewsletterExcluded(status)).toBe(true);
      expect(isTransactionalHardBlock({ status })).toBe(false);
    }
  });
});

// ── sendCalculatorReport ─────────────────────────────────────────────────────

describe('handleSendCalculatorReport — narrow suppression guard', () => {
  async function send(docData: Record<string, unknown> | null, opts: { getThrows?: boolean } = {}) {
    const { handleSendCalculatorReport } = await import('../functions/src/sendCalculatorReport.js');
    const db = makeDb(docData, opts);
    const res = await handleSendCalculatorReport({
      email: 'user@example.com',
      pdfBase64: VALID_PDF_BASE64,
      resultSummary: { netCH_CHF: 1, netIT_CHF: 1, savingsCHF: 0 },
      locale: 'it',
      sourcePath: '/',
      source: 'calculator_paywall',
      db: db as any,
    });
    return { res, db };
  }

  it('blocks a hard-bounced address (dead mailbox → burns sender reputation)', async () => {
    const { res, db } = await send({ status: 'bounced', bounce_severity: 'hard' });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ success: false, error: 'address_suppressed' });
    expect(vi.mocked((await cascade()).sendEmailCascade)).not.toHaveBeenCalled();
    expect(db.writes).toHaveLength(0);
  });

  it('blocks an address that filed a spam complaint (compliance hazard)', async () => {
    const { res } = await send({ status: 'complained' });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ success: false, error: 'address_suppressed' });
    expect(vi.mocked((await cascade()).sendEmailCascade)).not.toHaveBeenCalled();
  });

  it('still delivers the PDF to an UNSUBSCRIBED address — the funnel must not break', async () => {
    const { res } = await send({ status: 'unsubscribed', isActive: false });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(vi.mocked((await cascade()).sendEmailCascade)).toHaveBeenCalledTimes(1);
  });

  it.each<[string, Record<string, unknown>]>([
    ['inactive (sunset never-engager)', { status: 'inactive' }],
    ['pending (never confirmed)', { status: 'pending', isActive: false }],
    ['soft-bounced (one provider hiccup)', { status: 'bounced', bounce_severity: 'soft' }],
    ['bounced with no severity recorded', { status: 'bounced' }],
    ['confirmed', { status: 'confirmed', isActive: true }],
    ['no status at all', {}],
  ])('still delivers the PDF when the subscriber is %s', async (_label, docData) => {
    const { res } = await send(docData);
    expect(res.status).toBe(200);
    expect(vi.mocked((await cascade()).sendEmailCascade)).toHaveBeenCalledTimes(1);
  });

  it('still delivers the PDF when no subscriber doc exists yet (first capture)', async () => {
    const { res, db } = await send(null);
    expect(res.status).toBe(200);
    expect(db.writes.length).toBeGreaterThan(0);
    expect(vi.mocked((await cascade()).sendEmailCascade)).toHaveBeenCalledTimes(1);
  });

  it('FAILS OPEN on a Firestore read error — a lookup hiccup must not swallow the PDF', async () => {
    const { res, db } = await send(null, { getThrows: true });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(vi.mocked((await cascade()).sendEmailCascade)).toHaveBeenCalledTimes(1);
    // The lead is still captured — a merge write, without the create-only
    // fields that would downgrade a confirmed subscriber to `pending`.
    expect(db.writes).toHaveLength(1);
    expect(db.writes[0]).not.toHaveProperty('status');
  });
});

// ── newsletterConfirmationEmail ──────────────────────────────────────────────

describe('sendNewsletterConfirmationEmail — narrow suppression guard', () => {
  async function send(docData: Record<string, unknown> | null, purpose?: string) {
    const { sendNewsletterConfirmationEmail } = await import(
      '../functions/src/newsletterConfirmationEmail.js'
    );
    const db = makeDb(docData);
    const result = await sendNewsletterConfirmationEmail({
      email: 'user@example.com',
      locale: 'it',
      sourcePath: '/',
      secret: 'test-secret',
      purpose,
      db: db as any,
    });
    return { result, db };
  }

  it('blocks a hard-bounced address', async () => {
    const { result } = await send({ status: 'bounced', bounce_severity: 'hard' });
    expect(result).toEqual({ success: false, error: 'address_suppressed' });
    expect(vi.mocked((await cascade()).sendEmailCascade)).not.toHaveBeenCalled();
  });

  it('does NOT block on a stale hard severity once the status has recovered', async () => {
    // `bounce_severity` is never cleared on recovery, so it can outlive the
    // bounce (address resubscribed → status back to pending/subscribed). The
    // live signal is `status`; severity only qualifies an active suppression.
    const { result } = await send({ status: 'pending', bounce_severity: 'hard' });
    expect(result.success).toBe(true);
  });

  it('blocks an address that filed a spam complaint', async () => {
    const { result } = await send({ status: 'complained' });
    expect(result).toEqual({ success: false, error: 'address_suppressed' });
    expect(vi.mocked((await cascade()).sendEmailCascade)).not.toHaveBeenCalled();
  });

  it('sends to a PENDING subscriber — the normal double-opt-in case', async () => {
    const { result } = await send({ status: 'pending', isActive: false });
    expect(result.success).toBe(true);
    expect(vi.mocked((await cascade()).sendEmailCascade)).toHaveBeenCalledTimes(1);
  });

  it.each<[string, Record<string, unknown>]>([
    ['unsubscribed (re-signup via double opt-in)', { status: 'unsubscribed' }],
    ['inactive (sunset)', { status: 'inactive' }],
    ['soft-bounced', { status: 'pending', bounce_severity: 'soft' }],
  ])('still sends the confirmation when the subscriber is %s', async (_label, docData) => {
    const { result } = await send(docData);
    expect(result.success).toBe(true);
    expect(vi.mocked((await cascade()).sendEmailCascade)).toHaveBeenCalledTimes(1);
  });

  it('leaves the pre-existing already_confirmed short-circuit intact', async () => {
    const { result } = await send({ status: 'confirmed', isActive: true });
    expect(result).toEqual({ success: false, error: 'already_confirmed' });
  });

  it('blocks a hard bounce even on the login-link variant, which bypasses already_confirmed', async () => {
    const { result } = await send(
      { status: 'bounced', isActive: true, bounce_severity: 'hard' },
      'login',
    );
    expect(result).toEqual({ success: false, error: 'address_suppressed' });
  });
});
