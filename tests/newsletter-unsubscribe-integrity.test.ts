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
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

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
import { upsertNewsletterSubscriber } from '@/services/newsletterSubscribers';
import { handleSubscriptionManagement } from '../functions/src/newsletterSubscriptionManagement.js';
import { classify, decideRestore } from '../scripts/lib/mailtrapSuspensionClassify.mjs';
import { NEWSLETTER_EXCLUDED_STATUSES, isNewsletterExcluded } from '../services/emailSuppression.mjs';
import { FUNCTIONS_BASE } from '@/services/functionsBase';

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

/**
 * The shape that carried #5733 and #5734 past three issues written to close it.
 *
 * A stamp WITHOUT `status: 'unsubscribed'`. It is what the pre-#5673 SPA
 * unsubscribe left behind — `unsubscribedAt` and nothing else — on a document
 * a later write had already put back to `confirmed`/active. Every fixture in
 * this file used to say `status: 'unsubscribed'`, which takes the
 * `isActive: false` road and never reaches either defective branch: the gate
 * was green on a population that excluded the broken case.
 */
const CONFIRMED_WITH_CAMEL_STAMP = {
  email: EMAIL,
  status: 'confirmed',
  isActive: true,
  active: true,
  confirmed_at: '2026-07-01T09:00:00.000Z',
  unsubscribedAt: '2026-08-01T09:00:00.000Z',
};

/** Same shape in the other spelling — neither was tested. */
const CONFIRMED_WITH_SNAKE_STAMP = {
  ...CONFIRMED_WITH_CAMEL_STAMP,
  unsubscribedAt: undefined,
  unsubscribed_at: '2026-08-01T09:00:00.000Z',
};

/** Opted out before ever confirming: the status a preservation keeps is `pending`. */
const PENDING_WITH_STAMP = {
  email: EMAIL,
  status: 'pending',
  isActive: false,
  active: false,
  confirmed_at: '2026-07-01T09:00:00.000Z',
  unsubscribed_at: '2026-08-01T09:00:00.000Z',
  unsubscribedAt: '2026-08-01T09:00:00.000Z',
};

/** A subscribe write from one of the 16 anonymous surfaces: no status, no flag. */
const ANONYMOUS_SIGNUP = { email: EMAIL, source: 'popup' } as const;

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

  it('lifts the opt-out by STAMPING the re-opt-in, never by deleting the opt-out (#5711)', async () => {
    // scripts/send-newsletter.mjs drops any row carrying EITHER spelling
    // whatever `status` says, so a "riattiva" click that left the stamp
    // unaccompanied produced a subscriber who was confirmed and permanently
    // unmailable. Until #5711 the lift was performed by DELETING the stamps —
    // which also destroyed the record that the person had ever opted out, the
    // evidence an art. 25 request asks for and the signal the 186
    // resurrections of #5672 were found by.
    //
    // The lift is now a strictly-later `resubscribed_at` written BESIDE the
    // opt-out; `isNewsletterOptOutBinding` compares the two.
    getDocMock.mockResolvedValue({ exists: () => true, data: () => UNSUBSCRIBED_DOC });

    const result = await captureNewsletterSubscriber({} as any, {
      email: EMAIL,
      source: 'resubscribe_link',
      isActive: true,
    });

    expect(result.status).toBe('confirmed');
    const payload = (setDocMock.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(payload.resubscribed_at).toBe('__server_timestamp__');
    expect(payload.resubscribedAt).toBe('__server_timestamp__');
    // Not deleted, and not overwritten either: the merge simply does not
    // mention the field, so whatever the document already recorded survives.
    expect(payload).not.toHaveProperty('unsubscribed_at');
    expect(payload).not.toHaveProperty('unsubscribedAt');
  });

  it('and the resulting document is mailable again — the lift is not cosmetic', () => {
    // The half the deletion used to buy. Same document, plus the two stamps the
    // write above adds, run back through the predicate every sender consults.
    const lifted = {
      ...UNSUBSCRIBED_DOC,
      status: 'confirmed',
      isActive: true,
      active: true,
      resubscribed_at: '2026-08-02T09:00:00.000Z',
      resubscribedAt: '2026-08-02T09:00:00.000Z',
    };
    expect(isNewsletterOptOutBinding(lifted)).toBe(false);
    // …and an OLDER re-opt-in stamp does not lift anything.
    expect(isNewsletterOptOutBinding({
      ...lifted,
      resubscribed_at: '2026-07-01T09:00:00.000Z',
      resubscribedAt: '2026-07-01T09:00:00.000Z',
    })).toBe(true);
  });
});

// ── #5733 / #5734: `isActive` is not a proxy for the opt-out ────────────────
//
// Two branches of the same function, the same confusion, and the same reason
// nothing caught either: `isNewsletterOptOutBinding` binds on a STAMP under
// either spelling, while both branches tested ACTIVITY. Where the two answers
// diverged — a document carrying a stamp whose status is not literally
// `unsubscribed` — an anonymous subscribe write walked straight through.

describe('a binding opt-out is never handed back active, whatever the status says (#5733)', () => {
  beforeEach(() => {
    setDocMock.mockClear();
    addDocMock.mockClear();
    getDocMock.mockReset();
  });

  it('the untested shape: a stamp on a `confirmed`, active document, in BOTH spellings', () => {
    for (const doc of [CONFIRMED_WITH_CAMEL_STAMP, CONFIRMED_WITH_SNAKE_STAMP]) {
      expect(isNewsletterOptOutBinding(doc)).toBe(true);
      // Was `{ status: 'confirmed', isActive: true }`: the preservation branch
      // corrected `isActive` only when `existingStatus === 'unsubscribed'`,
      // which is strictly narrower than the predicate that got us here.
      expect(inferNewsletterSubscriptionState({ ...ANONYMOUS_SIGNUP }, doc))
        .toEqual({ status: 'confirmed', isActive: false });
    }
  });

  it('holds across the whole matrix of shapes production actually carries', () => {
    // The property, not the instance: for any subscribe write against a
    // binding document the guard preserves the recorded status EXACTLY and
    // never reports active. Statuses × spellings × activity flag — the axis
    // the previous fixtures held constant is the axis the defect lived on.
    const stamp = '2026-08-01T09:00:00.000Z';
    for (const status of ['confirmed', 'pending', 'unsubscribed'] as const) {
      for (const stamps of [
        { unsubscribed_at: stamp },
        { unsubscribedAt: stamp },
        { unsubscribed_at: stamp, unsubscribedAt: stamp },
      ]) {
        for (const isActive of [true, false]) {
          const doc = { email: EMAIL, status, isActive, active: isActive, ...stamps };
          expect(isNewsletterOptOutBinding(doc), `${status}/${JSON.stringify(stamps)}`).toBe(true);
          for (const input of [
            { ...ANONYMOUS_SIGNUP },
            { email: EMAIL, source: 'signup' },
            { email: EMAIL, source: 'signup', sourceChannel: 'auth_google', isActive: true },
          ]) {
            expect(
              inferNewsletterSubscriptionState(input as any, doc),
              `${status}/${JSON.stringify(stamps)}/${JSON.stringify(input)}`,
            ).toEqual({ status, isActive: false });
          }
        }
      }
    }
  });

  it('an anonymous subscribe does not forge the re-opt-in stamp that lifts the opt-out', async () => {
    // #5720 replaced the stamp DELETION with a strictly-later `resubscribed_at`
    // written beside it, so the deletion this issue was filed about is gone —
    // but the CONDITION came along unchanged, and against the supersession rule
    // it is worse than a deletion: writing the stamp forges the very evidence
    // that a re-opt-in was granted. From that write on the opt-out is
    // superseded for every reader, and nothing on the document says otherwise.
    getDocMock.mockResolvedValue({ exists: () => true, data: () => CONFIRMED_WITH_CAMEL_STAMP });

    const result = await captureNewsletterSubscriber({} as any, { ...ANONYMOUS_SIGNUP });

    const payload = (setDocMock.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(payload).not.toHaveProperty('resubscribed_at');
    expect(payload).not.toHaveProperty('resubscribedAt');
    expect(payload.isActive).toBe(false);
    expect(payload.active).toBe(false);
    expect(result.optedOut).toBe(true);
    // The document the write leaves behind still binds — the whole point.
    expect(isNewsletterOptOutBinding({ ...CONFIRMED_WITH_CAMEL_STAMP, ...payload })).toBe(true);
  });

  it('a GRANTED re-opt-in still lifts it, from either signal', async () => {
    for (const input of [
      { email: EMAIL, source: 'resubscribe_link', isActive: true },
      { email: EMAIL, source: 'popup', isActive: true, reconsent: true },
    ]) {
      setDocMock.mockClear();
      getDocMock.mockResolvedValue({ exists: () => true, data: () => CONFIRMED_WITH_CAMEL_STAMP });

      const result = await captureNewsletterSubscriber({} as any, input as any);

      expect(result.status).toBe('confirmed');
      expect(result.optedOut).toBe(false);
      const payload = (setDocMock.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
      expect(payload.resubscribed_at).toBe('__server_timestamp__');
      expect(payload.resubscribedAt).toBe('__server_timestamp__');
    }
  });
});

describe('the post-filter never returns a status less protective than the recorded one (#5734)', () => {
  beforeEach(() => {
    setDocMock.mockClear();
    addDocMock.mockClear();
    getDocMock.mockReset();
  });

  it('an anonymous subscribe against a clean opt-out preserves `unsubscribed`, not `pending`', () => {
    // The root. `inferSubscriptionStateIgnoringOptOut` answers
    // `{ status: 'pending', isActive: false }` for a write with no explicit
    // status from a source outside CONFIRMED_NEWSLETTER_SOURCES, and the old
    // first line — `if (!inferred.isActive) return inferred` — returned it:
    // the preservation branch below was unreachable for exactly the population
    // it was written for.
    expect(inferNewsletterSubscriptionState({ ...ANONYMOUS_SIGNUP }, UNSUBSCRIBED_DOC))
      .toEqual({ status: 'unsubscribed', isActive: false });
  });

  it('and `pending` was not a harmless relabelling — the alert gate reads the status', () => {
    // Why the demotion IS the damage: `unsubscribed` is in the set every
    // sender consults, `pending` is not. Asserted against the shared
    // vocabulary rather than a copy of it.
    const { status } = inferNewsletterSubscriptionState({ ...ANONYMOUS_SIGNUP }, UNSUBSCRIBED_DOC);
    expect(isNewsletterExcluded(status)).toBe(true);
    expect(isNewsletterExcluded('pending')).toBe(false);
  });

  it('every suppression status still passes through byte-identically', () => {
    // The one case the shortcut existed to protect, kept — and widened from
    // the single `bounced` asserted above to the whole vocabulary, so the next
    // status added to the set is covered without anyone remembering to.
    // `inactive` is excluded: it is the sunset script's state, not a value any
    // writer on this path can produce (it is not in NewsletterSubscriberStatus).
    for (const status of NEWSLETTER_EXCLUDED_STATUSES) {
      if (status === 'inactive') continue;
      expect(
        inferNewsletterSubscriptionState({ email: EMAIL, status } as any, UNSUBSCRIBED_DOC),
        `webhook status ${status}`,
      ).toEqual({ status, isActive: false });
      expect(
        inferNewsletterSubscriptionState({ email: EMAIL, status } as any, CONFIRMED_WITH_CAMEL_STAMP),
        `webhook status ${status} over a camelCase stamp`,
      ).toEqual({ status, isActive: false });
    }
  });

  it('the write that follows reports the opt-out to its caller', async () => {
    getDocMock.mockResolvedValue({ exists: () => true, data: () => UNSUBSCRIBED_DOC });

    const result = await captureNewsletterSubscriber({} as any, { ...ANONYMOUS_SIGNUP });

    expect(result.status).toBe('unsubscribed');
    expect(result.optedOut).toBe(true);
  });
});

describe('no email of any kind to an address with a recorded opt-out (#5734)', () => {
  // The consequence that reaches a mailbox. Both branches of
  // upsertNewsletterSubscriber decide from `status` + `existed`, and `existed`
  // is `alreadyActive` — false for an opted-out document by definition — so
  // the guard they had was satisfied by exactly the people it had to exclude.
  //
  // `fetch` is stubbed at the network boundary rather than the module: the
  // helpers are internal closures of the same module, so a vi.mock on
  // newsletterSubscribers.ts would not intercept them (see the docblock of
  // tests/welcome-client-hook.test.ts). The URL proves WHICH helper fired.
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    setDocMock.mockClear();
    addDocMock.mockClear();
    getDocMock.mockReset();
    vi.stubGlobal('window', { location: { pathname: '/', href: 'https://frontaliereticino.ch/' } });
    fetchMock = vi.fn(async () => ({ json: async () => ({ success: true }) }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends no confirmation email to someone who opted out before confirming', async () => {
    // The case that survives the fix above, which is why the guard is its own
    // check and not a corollary: this document's preserved status IS `pending`
    // — legitimately, that is what it records — and `alreadyActive` is false.
    // Both halves of the old condition are true and no opt-out is involved in
    // either of them.
    getDocMock.mockResolvedValue({ exists: () => true, data: () => PENDING_WITH_STAMP });

    const result = await upsertNewsletterSubscriber({} as any, { ...ANONYMOUS_SIGNUP });

    expect(result.status).toBe('pending');
    expect(result.existed).toBe(false);
    expect(result.optedOut).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends no confirmation email after a clean opt-out either', async () => {
    getDocMock.mockResolvedValue({ exists: () => true, data: () => UNSUBSCRIBED_DOC });

    await upsertNewsletterSubscriber({} as any, { ...ANONYMOUS_SIGNUP });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends no WELCOME email either, on the shape that keeps a `confirmed` status', async () => {
    // Same class, other branch: `{ status: 'confirmed', isActive: false }` plus
    // a stamp makes `existed` false and the preserved status `confirmed`, so
    // the welcome branch fires on a document that is opted out.
    getDocMock.mockResolvedValue({
      exists: () => true,
      data: () => ({ ...CONFIRMED_WITH_CAMEL_STAMP, isActive: false, active: false }),
    });

    const result = await upsertNewsletterSubscriber({} as any, { ...ANONYMOUS_SIGNUP });

    expect(result.status).toBe('confirmed');
    expect(result.existed).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still sends the confirmation email to an address that never opted out', async () => {
    // The other direction, because a guard that blocks everything is not a
    // guard: the ordinary double-opt-in signup must be untouched.
    getDocMock.mockResolvedValue({ exists: () => false, data: () => undefined });

    const result = await upsertNewsletterSubscriber({} as any, {
      email: 'new@example.com',
      source: 'popup',
      // #5678: a NEW subscriber cannot be created without a consent text.
      consentText: 'formula di prova',
    });

    expect(result).toEqual({
      existed: false,
      id: 'new@example.com',
      status: 'pending',
      optedOut: false,
      // #5692 reports it so the caller can tell a first ask from asking
      // somebody to redo a thing they already did.
      hadConfirmationProof: false,
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${FUNCTIONS_BASE}/newsletterSendConfirmation`);
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

  async function runSpaPath(credential: string | null = 'autologin_code') {
    const { fields } = await unsubscribeNewsletterSubscriber({} as any, {
      email: EMAIL,
      sourceChannel: 'unsubscribe_link',
      sourcePage: '/',
      credential,
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

  it('both STAMP `credential` on the event, so the monitor grades both writers', async () => {
    // THE OBSERVER THAT WAS MISSING.
    //
    // #5719 gave the Cloud Function writer a `credential` field and its
    // docstring claimed it had given it to every `unsubscribe_link` event.
    // The SPA writer above had shipped four hours and fifty minutes earlier
    // (#5690) and never got it, and nothing anywhere compared the two events
    // — the test right above this one compares `event_type` and stops.
    //
    // scripts/lib/unsubscribeCredentialMetrics.mjs drops events with no
    // `credential` from its denominator as pre-deploy residue, so the SPA
    // half did not read as broken: it read as OLD. Measured read-only in
    // production over the 7 days to 2026-08-18, 209 `unsubscribe_link`
    // events: 52 of them from this writer, every day, uncounted — and by
    // construction (App.tsx cannot reach it without an `ac`) they were the
    // `autologin_code` cohort the monitor exists to size, the one #5724's TTL
    // is about to put a clock on. The reported fallback quota was 0,90%.
    const spa = await runSpaPath('autologin_code');
    const oneClick = await runOneClickPath();

    for (const [name, event] of [['SPA', spa.event], ['one-click', oneClick.event]] as const) {
      expect(event, `${name} path writes no \`credential\` key at all — it will be graded \`missing\` and dropped from the monitor's denominator`).toHaveProperty('credential');
      expect(
        ['autologin_code', 'email_token', 'legacy_auth_token'],
        `${name} path wrote an unrecognised credential (${String(event.credential)}); classifyCredential() folds it into \`missing\``,
      ).toContain(event.credential);
    }
  });

  it('App.tsx tells the SPA writer WHICH credential got the visitor out', async () => {
    // The behavioural test above can only prove the writer forwards what it
    // is handed. Its one caller is App.tsx, and a caller that omits the
    // argument reproduces the defect exactly — a `null` credential is graded
    // `missing` and vanishes from the denominator just like a missing key.
    // Both roads into that call require the `ac` (the authenticated branch
    // needs the exchange to have succeeded; the session-less fall-through
    // returns early unless `autologinCode` is present and unforged), so the
    // value is never the email HMAC.
    const appSrc = readFileSync(path.resolve(__dirname, '..', 'App.tsx'), 'utf8');
    const call = appSrc.match(/await unsubscribeNewsletterSubscriber\(db, \{[\s\S]*?\n\s*\}\);/);
    expect(call, 'the App.tsx call to unsubscribeNewsletterSubscriber moved or changed shape').toBeTruthy();
    expect(call![0], 'App.tsx must pass `credential` — see #5719 and the 52 uncounted events').toMatch(/\bcredential:/);
    expect(call![0]).toMatch(/autologin_code/);
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

// ── Who may lift an opt-out, at the call sites ───────────────────────────────

describe('reconsent is wired to deliberate acts and to nothing else', () => {
  // `isActive: true` makes an upsert a PROMOTION, which is the only thing the
  // guard declines. So exactly the callers passing it have to be classified:
  // a typed-address form is a deliberate act and gets `reconsent`, an effect
  // that fires off an authentication does not. Getting this wrong is silent
  // in both directions — a missing flag shows the reader a success state and
  // sends them nothing, a spurious one reopens the ring — so the classification
  // is pinned here rather than left to a reviewer's memory.
  const read = (rel: string) => readFileSync(path.resolve(__dirname, '..', rel), 'utf8');

  it('the two subscribe FORMS that promote to active carry it', () => {
    for (const rel of ['components/shared/LeadMagnetCTA.tsx', 'components/community/WeeklyDigest.tsx']) {
      const src = read(rel);
      expect(src, `${rel} promotes to active`).toMatch(/isActive:\s*true/);
      expect(src, `${rel} must declare the deliberate act`).toMatch(/reconsent:\s*true/);
    }
  });

  it('the publisher gate\'s sign-in effect does NOT', () => {
    // PublisherPublishPage's social branch runs from a useEffect on the auth
    // user, behind the same localStorage flag as the other three
    // auto-subscribe effects — a fourth sibling of the ring, not a form.
    // Its "implicit consent" is not consent to resume refused mail.
    const src = read('components/pages/PublisherPublishPage.tsx');
    expect(src).toMatch(/source:\s*'publisher_gate_social'/);
    expect(src).not.toMatch(/reconsent/);
  });

  it('no sign-in path grants it', () => {
    for (const rel of ['App.tsx', 'hooks/useUserState.ts', 'services/authService.ts', 'components/community/JobBoard.tsx']) {
      expect(read(rel), `${rel} must never assert re-consent from an auth event`).not.toMatch(/reconsent/);
    }
  });
});

describe('an opted-out recipient signing in produces NO write at all', () => {
  const read = (rel: string) => readFileSync(path.resolve(__dirname, '..', rel), 'utf8');

  beforeEach(() => {
    setDocMock.mockClear();
    addDocMock.mockClear();
    getDocMock.mockReset();
  });

  it('the upsert would write a subscribe_completed event even when the guard declines', async () => {
    // WHY the four sign-in paths must skip the call instead of relying on the
    // guard. `inferNewsletterSubscriptionState` refuses the promotion — the
    // document stays `unsubscribed` — but `captureNewsletterSubscriber` runs
    // to completion and records an event on the way out regardless. That
    // event is the signal a genuine re-subscription is recognised by (it is
    // how 95 real returns were separated from the 281), so one forged by a
    // login corrupts the only evidence there is. This test pins the damage,
    // so the guards below are not arbitrary.
    getDocMock.mockResolvedValue({ exists: () => true, data: () => UNSUBSCRIBED_DOC });

    const result = await captureNewsletterSubscriber({} as any, {
      email: EMAIL,
      source: 'publisher_gate_social',
      isActive: true,
      status: 'confirmed',
    });

    expect(result.status).toBe('unsubscribed');
    expect(setDocMock).toHaveBeenCalledTimes(1);
    expect(addDocMock).toHaveBeenCalledTimes(1);
    const event = (addDocMock.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(event.event_type).toBe('subscribe_completed');
  });

  it('the pre-check itself writes nothing — it is safe to run on every sign-in', async () => {
    getDocMock.mockResolvedValue({ exists: () => true, data: () => UNSUBSCRIBED_DOC });

    await expect(isNewsletterOptedOut({} as any, EMAIL)).resolves.toBe(true);

    // The whole point of gating on this: no document write, no event, nothing
    // added to the log that a later analysis would have to explain away.
    expect(setDocMock).not.toHaveBeenCalled();
    expect(addDocMock).not.toHaveBeenCalled();
  });

  it('all SIX auto-subscribe-on-sign-in paths gate the upsert on it', () => {
    // The guard has to precede the call, not merely appear in the file: an
    // `isNewsletterOptedOut` that runs after the upsert would read as fixed
    // and write the event anyway.
    //
    // SIX, not the five it grew to. JobBoard's autoNewsletterSubscribe is
    // the one nothing pointed at: two of its four callers are social
    // sign-in job unlocks that promote to confirmed/active, which is the ring
    // verbatim. TaxCalendar's Google/Facebook reminder sign-in is the same
    // ring on a different funnel — #5713 item 2.
    const paths = [
      'App.tsx',
      'hooks/useUserState.ts',
      'services/authService.ts',
      'components/pages/PublisherPublishPage.tsx',
      'components/community/JobBoard.tsx',
      'components/fisco/TaxCalendar.tsx',
    ];
    for (const rel of paths) {
      const src = read(rel);
      const guardAt = src.indexOf('isNewsletterOptedOut(');
      const upsertAt = src.search(/upsertNewsletterSubscriber(Record)?\(/);
      expect(guardAt, `${rel} must consult the recipient's real state`).toBeGreaterThan(-1);
      expect(upsertAt, `${rel} must still perform the upsert`).toBeGreaterThan(-1);
      expect(src.slice(guardAt), `${rel} must return early before upserting`)
        .toMatch(/isNewsletterOptedOut\([^)]*\)\)\s*return;/);
    }
  });

  it('none of them relies on the localStorage flag alone', () => {
    // The flag the unsubscribe handler itself removes. It may stay as a cheap
    // early exit, but never as the only thing between a login and a write.
    for (const rel of [
      'App.tsx',
      'hooks/useUserState.ts',
      'services/authService.ts',
      'components/pages/PublisherPublishPage.tsx',
      'components/community/JobBoard.tsx',
      'components/fisco/TaxCalendar.tsx',
    ]) {
      const src = read(rel);
      if (!src.includes("getItem('newsletter_subscribed')")) continue;
      expect(src, `${rel} still guards a sign-in write with localStorage alone`)
        .toMatch(/isNewsletterOptedOut\(/);
    }
  });
});
