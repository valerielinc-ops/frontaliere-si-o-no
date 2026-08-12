/**
 * tests/newsletter-unsubscribe-integrity.test.ts
 *
 * Two defects with one root: an opt-out that only binds the path that created
 * it. Origin is an LPD art. 25/32 complaint from a recipient who had
 * unsubscribed several times without effect, and who turned out to be right.
 *
 * #5672 — THE RESURRECTION RING. `inferNewsletterSubscriptionState` had no
 * `unsubscribed` branch. Every link in every email we have ever sent carries
 * the deterministic, never-expiring `ac` autologin code, so reading an old
 * email signs the reader back in, the auto-subscribe-on-sign-in effect fires,
 * and `'signup'` — the first entry of CONFIRMED_NEWSLETTER_SOURCES — put them
 * back to `confirmed`/active. The only guard was a localStorage flag that the
 * unsubscribe handler itself removes, i.e. one that was always absent for
 * exactly the people it had to protect. Measured 2026-08-12 over all 8.604
 * subscriber documents: 281 opt-outs still active, 95 of them genuine
 * re-subscriptions, 186 resurrected with no action by the recipient, 49 of
 * whom received that day's brief.
 *
 * #5673 — THE INVISIBLE HALF. Two unsubscribe writers left different state:
 * the RFC 8058 one-click Cloud Function wrote `unsubscribed_at` (snake_case)
 * plus an `unsubscribe` event, while the "Disiscriviti" link in the body went
 * through the SPA and wrote `unsubscribedAt` (camelCase) and no event at all.
 * Everything that has to RESPECT an opt-out reads the first shape, so
 * scripts/restore-mailtrap-suspension-suppressions.mjs put SPA unsubscribers
 * back to `confirmed`. 458 documents carry only the camelCase stamp, 386 only
 * the snake_case one.
 *
 * The contract between the client writer and the scripts that read it has no
 * import form — which is precisely why nothing noticed the drift — so this
 * file gives it one: it runs BOTH writers and feeds each resulting state
 * through the real decision functions the scripts use.
 *
 * Every address here is on example.com (the repo is public).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';

const setDocMock = vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined);
const addDocMock = vi.fn<(...args: unknown[]) => Promise<{ id: string }>>(async () => ({ id: 'evt-1' }));
const getDocMock = vi.fn<(...args: unknown[]) => Promise<{ exists: () => boolean; data: () => any }>>();

vi.mock('firebase/firestore', () => ({
  collection: vi.fn(() => ({})),
  doc: vi.fn(() => ({})),
  getDoc: (...args: unknown[]) => getDocMock(...args),
  setDoc: (...args: unknown[]) => setDocMock(...args),
  addDoc: (...args: unknown[]) => addDocMock(...args),
  increment: vi.fn((n: number) => ({ __increment: n })),
  serverTimestamp: vi.fn(() => '__server_timestamp__'),
  deleteField: vi.fn(() => '__delete_field__'),
}));

import {
  captureNewsletterSubscriber,
  inferNewsletterSubscriptionState,
  isNewsletterOptOutBinding,
  isNewsletterOptedOut,
  unsubscribeNewsletterSubscriber,
} from '@/services/newsletterSubscribers';
import { handleSubscriptionManagement } from '../functions/src/newsletterSubscriptionManagement.js';
import { classify, decideRestore } from '../scripts/lib/mailtrapSuspensionClassify.mjs';

const EMAIL = 'optout@example.com';
const TEST_SECRET = 'test-newsletter-secret-key-2026';
const VALID_TOKEN = createHmac('sha256', TEST_SECRET).update(EMAIL).digest('hex');

/** The document the SPA unsubscribe handler leaves behind, as production has it. */
const UNSUBSCRIBED_DOC = {
  email: EMAIL,
  status: 'unsubscribed',
  isActive: false,
  active: false,
  unsubscribed_at: '2026-08-01T09:00:00.000Z',
  unsubscribedAt: '2026-08-01T09:00:00.000Z',
};

// ── #5672: the opt-out is binding against every write path ───────────────────

describe('inferNewsletterSubscriptionState — a recorded opt-out is not undone by signing in', () => {
  it('does not resurrect an opt-out through the `signup` source (the ring itself)', () => {
    // The literal shape of App.tsx's auto-subscribe effect:
    // upsertNewsletterSubscriber(authEmail, 'signup', ...). `'signup'` is the
    // first entry of CONFIRMED_NEWSLETTER_SOURCES, which is what used to
    // return confirmed/active here.
    expect(
      inferNewsletterSubscriptionState({ email: EMAIL, source: 'signup' }, UNSUBSCRIBED_DOC),
    ).toEqual({ status: 'unsubscribed', isActive: false });
  });

  it('does not resurrect an opt-out through an explicit isActive:true either', () => {
    // The path the effect ACTUALLY takes, and one the issue does not mention:
    // App.tsx's shared upsert callback passes `isActive: true`, so the write
    // never reaches the CONFIRMED_NEWSLETTER_SOURCES branch — it short-circuits
    // on the explicit-status branch at the very top. A guard placed only in
    // front of the source branch would have left the production ring open.
    expect(
      inferNewsletterSubscriptionState(
        { email: EMAIL, source: 'signup', sourceChannel: 'auth_google', isActive: true },
        UNSUBSCRIBED_DOC,
      ),
    ).toEqual({ status: 'unsubscribed', isActive: false });
  });

  it('does not resurrect an opt-out through a click on a newsletter link', () => {
    expect(
      inferNewsletterSubscriptionState(
        { email: EMAIL, source: 'newsletter_email_link' },
        UNSUBSCRIBED_DOC,
      ),
    ).toEqual({ status: 'unsubscribed', isActive: false });
  });

  it('honours a camelCase-only stamp — the 458 documents no script could see', () => {
    // Historic SPA unsubscribers carry `unsubscribedAt` and nothing else. No
    // data migration is performed anywhere in this PR; the guard reads both
    // spellings instead.
    const camelOnly = { email: EMAIL, status: 'pending', unsubscribedAt: '2026-07-02T10:00:00.000Z' };
    expect(isNewsletterOptOutBinding(camelOnly)).toBe(true);
    expect(
      inferNewsletterSubscriptionState({ email: EMAIL, source: 'signup' }, camelOnly),
    ).toEqual({ status: 'pending', isActive: false });
  });

  it('repairs the 281 documents that were `unsubscribed` yet still active', () => {
    // The measured inconsistency: status says opted out, isActive/active say
    // mailable. The guard corrects only in the direction the opt-out demands
    // — it never invents the opposite transition.
    expect(
      inferNewsletterSubscriptionState(
        { email: EMAIL, source: 'signup' },
        { ...UNSUBSCRIBED_DOC, isActive: true, active: true },
      ),
    ).toEqual({ status: 'unsubscribed', isActive: false });
  });

  it('still lets an explicit re-opt-in through', () => {
    // Two, and only two, signals lift it: the win-back / "riattiva" click…
    expect(
      inferNewsletterSubscriptionState(
        { email: EMAIL, source: 'resubscribe_link', isActive: true },
        UNSUBSCRIBED_DOC,
      ),
    ).toEqual({ status: 'confirmed', isActive: true });
    // …and the explicit flag, for a caller that can prove the same thing.
    expect(
      inferNewsletterSubscriptionState(
        { email: EMAIL, source: 'popup', isActive: true, reconsent: true },
        UNSUBSCRIBED_DOC,
      ),
    ).toEqual({ status: 'confirmed', isActive: true });
  });

  it('leaves every non-promoting write byte-identical', () => {
    // The guard is a post-filter that can only decline a promotion, so a
    // webhook demotion, a first-time signup and a healthy confirmed subscriber
    // all resolve exactly as they did before.
    expect(
      inferNewsletterSubscriptionState({ email: EMAIL, status: 'bounced' }, UNSUBSCRIBED_DOC),
    ).toEqual({ status: 'bounced', isActive: false });
    expect(
      inferNewsletterSubscriptionState({ email: EMAIL, source: 'popup' }, undefined),
    ).toEqual({ status: 'pending', isActive: false });
    expect(
      inferNewsletterSubscriptionState({ email: EMAIL, source: 'signup' }, undefined),
    ).toEqual({ status: 'confirmed', isActive: true });
    expect(
      inferNewsletterSubscriptionState(
        { email: EMAIL, source: 'signup' },
        { status: 'confirmed', isActive: true },
      ),
    ).toEqual({ status: 'confirmed', isActive: true });
  });

  it('does NOT accept confirmed_at as supersession — that is the 186 cohort', () => {
    // scripts/lib/suppressionDecay.mjs lets a `confirmed_at` newer than the
    // opt-out supersede the stamp. Copying that rule here would exempt exactly
    // the population this guard exists for: the resurrection wrote a fresh
    // `confirmed_at` on every one of the 186, because the transition guard in
    // captureNewsletterSubscriber fires when the previous state was not
    // confirmed. Only resubscribe_link/reconsent lift the opt-out.
    expect(
      inferNewsletterSubscriptionState(
        { email: EMAIL, source: 'signup' },
        { ...UNSUBSCRIBED_DOC, confirmed_at: '2026-08-12T06:00:00.000Z' },
      ),
    ).toEqual({ status: 'unsubscribed', isActive: false });
  });
});

describe('captureNewsletterSubscriber — the write that follows the guard', () => {
  beforeEach(() => {
    setDocMock.mockClear();
    addDocMock.mockClear();
    getDocMock.mockReset();
  });

  it('keeps an opted-out document inactive when the login effect upserts', async () => {
    getDocMock.mockResolvedValue({ exists: () => true, data: () => UNSUBSCRIBED_DOC });

    const result = await captureNewsletterSubscriber({} as any, {
      email: EMAIL,
      source: 'signup',
      sourceChannel: 'auth_google',
      isActive: true,
    });

    expect(result.status).toBe('unsubscribed');
    const payload = (setDocMock.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(payload.status).toBe('unsubscribed');
    expect(payload.isActive).toBe(false);
    expect(payload.active).toBe(false);
    // …and the opt-out stamp is (re)asserted in both spellings rather than lost.
    expect(payload.unsubscribed_at).toBe('__server_timestamp__');
    expect(payload.unsubscribedAt).toBe('__server_timestamp__');
  });

  it('clears both stamps when a re-opt-in is granted, so the lift is not cosmetic', async () => {
    // scripts/send-newsletter.mjs drops any row carrying EITHER spelling
    // whatever `status` says, so a "riattiva" click that left the stamp
    // produced a subscriber who was confirmed and permanently unmailable.
    getDocMock.mockResolvedValue({ exists: () => true, data: () => UNSUBSCRIBED_DOC });

    const result = await captureNewsletterSubscriber({} as any, {
      email: EMAIL,
      source: 'resubscribe_link',
      isActive: true,
    });

    expect(result.status).toBe('confirmed');
    const payload = (setDocMock.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(payload.unsubscribed_at).toBe('__delete_field__');
    expect(payload.unsubscribedAt).toBe('__delete_field__');
    expect(payload.resubscribed_at).toBe('__server_timestamp__');
  });
});

describe('isNewsletterOptedOut — the guard the sign-in effects consult', () => {
  beforeEach(() => {
    getDocMock.mockReset();
  });

  it('reports an opt-out from either spelling, and nothing for an unknown address', async () => {
    getDocMock.mockResolvedValue({ exists: () => true, data: () => ({ unsubscribedAt: '2026-07-02T10:00:00.000Z' }) });
    await expect(isNewsletterOptedOut({} as any, EMAIL)).resolves.toBe(true);

    getDocMock.mockResolvedValue({ exists: () => false, data: () => undefined });
    await expect(isNewsletterOptedOut({} as any, 'new@example.com')).resolves.toBe(false);
  });

  it('fails CLOSED: a read error must not be read as "never unsubscribed"', async () => {
    getDocMock.mockRejectedValue(new Error('permission-denied'));
    await expect(isNewsletterOptedOut({} as any, EMAIL)).resolves.toBe(true);
  });
});

// ── #5673: the two unsubscribe paths leave the same observable state ──────────

/** Minimal firebase-admin-shaped double, same contract as the CF's own tests. */
function createFakeAdminDb(existing: Record<string, Record<string, unknown>> = {}) {
  const sets: Array<{ collection: string; docId: string; data: Record<string, unknown> }> = [];
  const adds: Array<{ collection: string; data: Record<string, unknown> }> = [];
  return {
    collection: (name: string) => ({
      doc: (docId: string) => ({
        set: async (data: Record<string, unknown>) => { sets.push({ collection: name, docId, data }); },
        get: async () => {
          const d = existing[docId];
          return { exists: !!d, data: () => d || {} };
        },
        collection: (sub: string) => ({
          add: async (data: Record<string, unknown>) => { adds.push({ collection: `${name}/${docId}/${sub}`, data }); },
          get: async () => ({ forEach: () => {} }),
        }),
      }),
      add: async (data: Record<string, unknown>) => { adds.push({ collection: name, data }); },
    }),
    __sets: sets,
    __adds: adds,
  };
}

/**
 * Fields every reader of an opt-out consults. Named here rather than inlined
 * so a future writer that drops one fails this file instead of failing a
 * subscriber.
 */
const OPT_OUT_CONTRACT_FIELDS = ['status', 'isActive', 'active', 'unsubscribed_at', 'unsubscribedAt'];

describe('the two unsubscribe paths leave the same observable state', () => {
  beforeEach(() => {
    setDocMock.mockClear();
    addDocMock.mockClear();
    getDocMock.mockReset();
  });

  async function runSpaPath() {
    const { fields } = await unsubscribeNewsletterSubscriber({} as any, {
      email: EMAIL,
      sourceChannel: 'unsubscribe_link',
      sourcePage: '/',
    });
    const event = (addDocMock.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    return { fields, event };
  }

  async function runOneClickPath() {
    const db = createFakeAdminDb({ [EMAIL]: { status: 'confirmed', isActive: true } });
    const result = await handleSubscriptionManagement({
      action: 'unsubscribe',
      email: EMAIL,
      token: VALID_TOKEN,
      locale: 'it',
      secret: TEST_SECRET,
      db: db as any,
    });
    expect(result.status).toBe(200);
    const fields = db.__sets.find((s) => s.collection === 'newsletter_subscribers')!.data;
    const event = db.__adds.find((a) => a.collection.includes('/events'))!.data;
    return { fields, event };
  }

  it('writes the same contract fields on the subscriber document', async () => {
    const spa = await runSpaPath();
    const oneClick = await runOneClickPath();

    for (const field of OPT_OUT_CONTRACT_FIELDS) {
      expect(spa.fields, `SPA path is missing ${field}`).toHaveProperty(field);
      expect(oneClick.fields, `one-click path is missing ${field}`).toHaveProperty(field);
    }
    for (const state of [spa.fields, oneClick.fields]) {
      expect(state.status).toBe('unsubscribed');
      expect(state.isActive).toBe(false);
      expect(state.active).toBe(false);
      expect(state.unsubscribed_at).toBeTruthy();
      expect(state.unsubscribedAt).toBeTruthy();
    }
  });

  it('both record an opt-out EVENT the recovery classifier recognises', async () => {
    // The SPA path recorded no event whatsoever, and `classify()` matched
    // `event_type === 'unsubscribed'` only — so even the Cloud Function's own
    // `event_type: 'unsubscribe'` went unseen unless a provider had also set
    // the raw `mailtrap_event` field. Both halves are asserted here.
    const spa = await runSpaPath();
    const oneClick = await runOneClickPath();

    expect(spa.event.event_type).toBe('unsubscribe');
    expect(oneClick.event.event_type).toBe('unsubscribe');
    expect(classify([spa.event]).sawUnsubscribe).toBe(true);
    expect(classify([oneClick.event]).sawUnsubscribe).toBe(true);
  });

  it('leaves both unrestorable by restore-mailtrap-suspension-suppressions.mjs', async () => {
    // The end of the chain, and the reason the drift mattered: that script
    // decides who stays suppressed. Modelled on the real cohort — a document
    // that opted out and was LATER swept up by the mis-mapped Mailtrap
    // `suspension` webhook, i.e. the one population the script may restore.
    const nowMs = Date.parse('2026-08-12T00:00:00.000Z');
    const suspensionEvents = [{ event_type: 'suppressed', mailtrap_event: 'suspension' }];
    const stamp = '2026-08-01T09:00:00.000Z';

    const spa = await runSpaPath();
    const oneClick = await runOneClickPath();

    const verdicts = [spa.fields, oneClick.fields].map((fields) =>
      decideRestore({
        // The two paths agree on every field but the timestamp REPRESENTATION
        // (ISO string client-side, a server sentinel in the function), so the
        // stamps are normalised to one value: what is under test is the shape,
        // not the clock.
        sub: { ...fields, unsubscribed_at: stamp, unsubscribedAt: stamp, status: 'suppressed' },
        events: suspensionEvents,
        nowMs,
      }),
    );

    for (const verdict of verdicts) expect(verdict.restore).toBe(false);
    expect(verdicts[0].code).toBe(verdicts[1].code);
  });

  it('keeps a camelCase-only historic document suppressed as well', async () => {
    // The 458 that predate this PR: no snake_case stamp, no event.
    const nowMs = Date.parse('2026-08-12T00:00:00.000Z');
    const verdict = decideRestore({
      sub: { email: EMAIL, status: 'suppressed', unsubscribedAt: '2026-06-14T08:00:00.000Z' },
      events: [{ event_type: 'suppressed', mailtrap_event: 'suspension' }],
      nowMs,
    });
    expect(verdict.restore).toBe(false);
  });
});
