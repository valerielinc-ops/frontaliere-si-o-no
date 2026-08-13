/**
 * tests/welcome-client-hook.test.ts — regression guard for the client-side
 * welcome-email wiring in services/newsletterSubscribers.ts.
 *
 * ~82% of newsletter signups are PRE-CONFIRMED, written client-side straight
 * to Firestore via upsertNewsletterSubscriber (Google One Tap,
 * Google/Facebook/LinkedIn sign-in, job-unlock gates — see
 * tests/auth-onetap-subscriber-persistence.test.ts, which confirms
 * persistOneTapSubscriber's sourceChannel: 'auth_google' resolves to
 * status: 'confirmed'). These signups never hit a confirmation-link Cloud
 * Function, so the requestWelcomeEmail branch added to
 * upsertNewsletterSubscriber is their ONLY welcome touchpoint.
 *
 * upsertNewsletterSubscriber has 17 direct callers (GitNexus impact:
 * impactedCount 29, risk CRITICAL) — this suite exists specifically to
 * prove the new branch is purely additive: byte-identical behavior for the
 * pre-existing pending/confirmed-existed cases, plus the one new case
 * (confirmed && !existed), and that a failing welcome-email request can
 * NEVER surface to callers of upsertNewsletterSubscriber.
 *
 * Firestore mocking follows the established convention (see
 * tests/services/newsletterSubscribers.resubscribe.test.ts): stub the
 * `firebase/firestore` module boundary, not the service module itself.
 * Self-mocking newsletterSubscribers.ts with vi.mock()+importOriginal() to
 * spy on requestWelcomeEmail/requestConfirmationEmail would NOT intercept
 * their calls from inside upsertNewsletterSubscriber — importOriginal()
 * yields a separately-executed module instance whose internal closures
 * still bind to the real, unmocked local functions, not a mocked exports
 * object. Instead, `fetch` is stubbed at the network boundary (same
 * convention as tests/adblock-detection.test.ts) and asserted on directly:
 * URL + body shape prove WHICH helper fired.
 *
 * This file is not in vitest.config.ts's JSDOM_TS_FILES list, so it runs
 * under the 'node' project (no `window` global by default).
 * requestConfirmationEmail (pre-existing, untouched by this change) reads
 * `window.location.pathname` with no window-guard, so `window` is stubbed
 * minimally in beforeEach — same technique as the non-jsdom
 * tests/router-locale-slugs.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FUNCTIONS_BASE } from '@/services/functionsBase';

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

import { upsertNewsletterSubscriber, requestWelcomeEmail } from '@/services/newsletterSubscribers';

const NOT_EXISTS = { exists: () => false, data: () => undefined };
const EXISTS_ACTIVE = {
  exists: () => true,
  data: () => ({ email: 'existing@example.com', status: 'confirmed', isActive: true, active: true }),
};

describe('welcome-email client-side wiring (services/newsletterSubscribers.ts)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    setDocMock.mockClear();
    addDocMock.mockClear();
    getDocMock.mockReset();
    vi.stubGlobal('window', {
      location: { pathname: '/', href: 'https://frontaliereticino.ch/' },
    });
    fetchMock = vi.fn(async () => ({ json: async () => ({ success: true }) }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('(a) confirmed && !existed calls requestWelcomeEmail exactly once', async () => {
    getDocMock.mockResolvedValue(NOT_EXISTS);

    const result = await upsertNewsletterSubscriber({} as any, {
      email: 'new-confirmed@example.com',
      status: 'confirmed',
      // #5678: a NEW subscriber cannot be created without a consent text.
      consentText: 'formula di prova',
    });

    expect(result).toEqual({ existed: false, id: 'new-confirmed@example.com', status: 'confirmed', optedOut: false, hadConfirmationProof: false });

    // requestWelcomeEmail is fired via a non-awaited `.catch()`-wrapped
    // promise, so the fetch call may still be in flight right after
    // upsertNewsletterSubscriber resolves — poll until it lands.
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${FUNCTIONS_BASE}/newsletterSendWelcome`);
  });

  it('(b) confirmed && existed does NOT call requestWelcomeEmail', async () => {
    getDocMock.mockResolvedValue(EXISTS_ACTIVE);

    const result = await upsertNewsletterSubscriber({} as any, {
      email: 'existing@example.com',
      status: 'confirmed',
    });

    expect(result).toEqual({ existed: true, id: 'existing@example.com', status: 'confirmed', optedOut: false, hadConfirmationProof: false });
    // Neither the pending nor the confirmed branch's `if` condition is true
    // for this input, so no async helper is ever scheduled — no polling
    // needed, the absence is deterministic and synchronous.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('(c) pending && !existed calls requestConfirmationEmail and NOT requestWelcomeEmail (pre-existing behavior)', async () => {
    getDocMock.mockResolvedValue(NOT_EXISTS);

    const result = await upsertNewsletterSubscriber({} as any, {
      email: 'new-pending@example.com',
      status: 'pending',
      // #5678: a NEW subscriber cannot be created without a consent text.
      consentText: 'formula di prova',
    });

    expect(result).toEqual({ existed: false, id: 'new-pending@example.com', status: 'pending', optedOut: false, hadConfirmationProof: false });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${FUNCTIONS_BASE}/newsletterSendConfirmation`);
    expect(url).not.toContain('newsletterSendWelcome');
  });

  it('(d) resolves normally with the unchanged result even when the welcome email request fails end-to-end', async () => {
    getDocMock.mockResolvedValue(NOT_EXISTS);
    fetchMock.mockRejectedValue(new Error('network down'));

    const result = await upsertNewsletterSubscriber({} as any, {
      email: 'flaky@example.com',
      status: 'confirmed',
      // #5678: a NEW subscriber cannot be created without a consent text.
      consentText: 'formula di prova',
    });

    // The return value is byte-identical to the success case: the failing
    // welcome-email request never touches upsertNewsletterSubscriber's
    // return path, whether it happens before or after this await settles.
    expect(result).toEqual({ existed: false, id: 'flaky@example.com', status: 'confirmed', optedOut: false, hadConfirmationProof: false });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // requestWelcomeEmail's own try/catch already guarantees it never
    // rejects (mirrors requestConfirmationEmail's non-throwing contract) —
    // verified directly here so the upsertNewsletterSubscriber .catch()
    // wrapper around it is proven to be defense-in-depth, not the only
    // thing standing between a network failure and a broken caller.
    await expect(requestWelcomeEmail('flaky@example.com')).resolves.toEqual({
      success: false,
      error: 'network down',
    });
  });

  it('(e) requestWelcomeEmail posts the right URL + body shape and never throws on network error or bad JSON', async () => {
    const ok = await requestWelcomeEmail('User@Example.com ');
    expect(ok).toEqual({ success: true });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${FUNCTIONS_BASE}/newsletterSendWelcome`);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body as string)).toEqual({ email: 'user@example.com', locale: 'it' });

    // Network error: fetch() itself rejects.
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    await expect(requestWelcomeEmail('x@example.com')).resolves.toEqual({ success: false, error: 'offline' });

    // Non-JSON response: resp.json() throws.
    fetchMock.mockResolvedValueOnce({ json: async () => { throw new SyntaxError('Unexpected token'); } });
    const bad = await requestWelcomeEmail('x@example.com');
    expect(bad.success).toBe(false);
  });
});
