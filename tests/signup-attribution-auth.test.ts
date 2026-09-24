// @vitest-environment jsdom

/**
 * Signup attribution for authentication-driven registrations.
 *
 * Measured on newsletter_subscribers (30 days): One Tap sign-ups landed as the
 * generic `authService` login (the One Tap writer with cta `one_tap` was
 * removed by #8341), logins started from a box lost the box identity, and a
 * background session restore overwrote the last-touch page on every visit.
 * These tests exercise the real authService module (unmocked) with the
 * Firebase SDKs stubbed at the boundary.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('@/services/authService');

const upsertNewsletterSubscriber = vi.fn(async (_db: unknown, _input: Record<string, unknown>) => ({
  existed: true,
  id: 'x',
  status: 'confirmed',
  optedOut: false,
  hadConfirmationProof: true,
}));

vi.mock('@/services/newsletterSubscribers', () => ({
  upsertNewsletterSubscriber,
}));

vi.mock('firebase/firestore', () => ({
  getFirestore: vi.fn(() => ({})),
  doc: vi.fn(() => ({})),
  setDoc: vi.fn(async () => undefined),
  serverTimestamp: vi.fn(() => 'ts'),
}));

const signInWithCredential = vi.fn(async () => ({
  user: {
    uid: 'uid-1',
    email: 'reader@example.test',
    displayName: 'Reader Test',
    providerData: [{ providerId: 'google.com' }],
  },
}));

vi.mock('firebase/auth', () => ({
  getAuth: vi.fn(() => ({ currentUser: null, authStateReady: async () => undefined, config: { apiKey: 'k' } })),
  setPersistence: vi.fn(async () => undefined),
  browserLocalPersistence: {},
  GoogleAuthProvider: { credential: vi.fn(() => ({})) },
  signInWithCredential,
}));

const auth = await import('@/services/authService');
const firebase = await import('@/services/firebase');

let gisCallback: ((response: { credential: string; select_by?: string }) => Promise<void>) | null = null;

beforeAll(async () => {
  vi.mocked(firebase.getConfigValue).mockResolvedValue('google-client-id');
  // loadGISScript() returns early when the GIS <script> is already present.
  const script = document.createElement('script');
  script.src = 'https://accounts.google.com/gsi/client';
  document.head.appendChild(script);
  (window as any).google = {
    accounts: {
      id: {
        initialize: (config: { callback: typeof gisCallback }) => { gisCallback = config.callback; },
        prompt: vi.fn(),
        cancel: vi.fn(),
        disableAutoSelect: vi.fn(),
        renderButton: vi.fn(),
      },
    },
  };
  expect(await auth.initOneTap()).toBe(true);
  expect(gisCallback).toBeTypeOf('function');
});

beforeEach(() => {
  upsertNewsletterSubscriber.mockClear();
  window.sessionStorage.clear();
  window.history.replaceState(null, '', '/calcolatore/');
});

async function lastUpsertInput(): Promise<Record<string, unknown>> {
  await vi.waitFor(() => expect(upsertNewsletterSubscriber).toHaveBeenCalled());
  const calls = upsertNewsletterSubscriber.mock.calls;
  return calls[calls.length - 1][1] as Record<string, unknown>;
}

describe('Google One Tap prompt → cta one_tap / component auth_one_tap', () => {
  it('attributes a prompt credential to One Tap, overwriting the last touch', async () => {
    await gisCallback!({ credential: 'jwt', select_by: 'user' });
    const input = await lastUpsertInput();
    expect(input.sourceCta).toBe('one_tap');
    expect(input.sourceComponent).toBe('auth_one_tap');
    expect(input.sourcePage).toBe('/calcolatore/');
    expect(input.attributionMode).toBe('overwrite');
    // First touch stays the provider channel; the merge keeps an existing one.
    expect(input.source).toBe('auth_google');
    expect(input.sourceChannel).toBe('auth_google');
  });

  it('attributes an auto sign-in (no select_by) to One Tap as well', async () => {
    await gisCallback!({ credential: 'jwt' });
    const input = await lastUpsertInput();
    expect(input.sourceCta).toBe('one_tap');
    expect(input.sourceComponent).toBe('auth_one_tap');
  });

  it('drops a stale box context instead of attributing the prompt to it', async () => {
    auth.setAuthAttributionContext({ cta: 'lead_magnet_social', component: 'LeadMagnetCTA' });
    await gisCallback!({ credential: 'jwt', select_by: 'user_1tap' });
    const input = await lastUpsertInput();
    expect(input.sourceComponent).toBe('auth_one_tap');
    expect(auth.consumeAuthAttributionContext()).toBeNull();
  });
});

describe('login started from a box → the box is the last touch', () => {
  it('a rendered Google button click carries the box context parked by its click listener', async () => {
    await auth.renderGoogleButton(document.createElement('div'), {
      attribution: { cta: 'newsletter_popup_social', component: 'NewsletterPopup' },
    });
    const renderButton = (window as any).google.accounts.id.renderButton as ReturnType<typeof vi.fn>;
    const options = renderButton.mock.calls[renderButton.mock.calls.length - 1][1];
    // Our own option never reaches GIS; the click listener parks it instead.
    expect(options).not.toHaveProperty('attribution');
    options.click_listener();

    window.history.replaceState(null, '', '/somewhere-else/');
    await gisCallback!({ credential: 'jwt', select_by: 'btn' });
    const input = await lastUpsertInput();
    expect(input.sourceCta).toBe('newsletter_popup_social');
    expect(input.sourceComponent).toBe('NewsletterPopup');
    expect(input.sourcePage).toBe('/calcolatore/');
    expect(input.attributionMode).toBe('overwrite');
  });

  it('a login without a surface is a reconciliation that only fills missing fields', async () => {
    await auth.saveUserProfileToFirestore(
      { uid: 'u', email: 'reader@example.test', providerData: [{ providerId: 'google.com' }] },
      'google',
      null,
    );
    const input = await lastUpsertInput();
    expect(input.sourceComponent).toBe('authService');
    expect(input.sourceCta).toBeNull();
    expect(input.attributionMode).toBe('fill');
  });

  it('a background listener write (null contexts) does not consume a pending box context', async () => {
    auth.setAuthAttributionContext({ cta: 'offerwall_social', component: 'OfferwallNewsletterGate' });
    await auth.saveUserProfileToFirestore({ uid: 'u', email: 'reader@example.test' }, 'google', null);
    expect(auth.consumeAuthAttributionContext()).toMatchObject({ component: 'OfferwallNewsletterGate' });
  });
});

describe('attribution context storage', () => {
  it('is one-shot, pathname-only and ignores click events passed as context', () => {
    window.history.replaceState(null, '', '/lavoro/offerta/?email=someone%40example.test#x');
    auth.setAuthAttributionContext({ cta: 'pdf_download_gate_social', component: 'PdfDownloadGate' });
    expect(auth.consumeAuthAttributionContext()).toEqual({
      cta: 'pdf_download_gate_social',
      component: 'PdfDownloadGate',
      page: '/lavoro/offerta/',
      routeFamily: null,
    });
    expect(auth.consumeAuthAttributionContext()).toBeNull();
    expect(auth.explicitAuthAttribution({ type: 'click', target: {} })).toBeNull();
    expect(auth.explicitAuthAttribution({ cta: 'bad value with spaces', component: '<script>' })).toBeNull();
  });

  it('expires after 30 minutes', () => {
    auth.setAuthAttributionContext({ cta: 'ai_chatbot_social', component: 'AiChatbot' });
    expect(auth.consumeAuthAttributionContext({ now: Date.now() + 31 * 60 * 1000 })).toBeNull();
  });

  it('a LinkedIn-bound context is returned only for the same OAuth state', () => {
    const state = encodeURIComponent('/lavoro/');
    auth.setAuthAttributionContext({ cta: 'lead_magnet_social', component: 'LeadMagnetCTA' }, { linkedinState: state });
    expect(auth.consumeAuthAttributionContext()).toBeNull();

    auth.setAuthAttributionContext({ cta: 'lead_magnet_social', component: 'LeadMagnetCTA' }, { linkedinState: state });
    expect(auth.consumeAuthAttributionContext({ linkedinState: encodeURIComponent('/altro/') })).toBeNull();

    auth.setAuthAttributionContext({ cta: 'lead_magnet_social', component: 'LeadMagnetCTA' }, { linkedinState: state });
    expect(auth.consumeAuthAttributionContext({ linkedinState: state })).toMatchObject({
      cta: 'lead_magnet_social',
      component: 'LeadMagnetCTA',
      page: '/calcolatore/',
    });
  });
});

describe('LinkedIn: origin page survives the OAuth round trip', () => {
  it('signInWithLinkedIn parks the origin page under the state it sends, same-origin only', async () => {
    const assign = vi.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...original, origin: 'https://frontaliereticino.ch', pathname: '/calcolatore/', search: '', set href(v: string) { assign(v); } },
    });
    try {
      vi.mocked(firebase.getConfigValue).mockResolvedValue('linkedin-client');
      await auth.signInWithLinkedIn('//evil.example/phish', { cta: 'subscription_cta_social', component: 'SubscriptionCTA' });
      const url = new URL(assign.mock.calls[0][0]);
      const state = url.searchParams.get('state')!;
      // An unsafe redirectPath falls back to the current same-origin path.
      expect(decodeURIComponent(state)).toBe('/calcolatore/');
      expect(auth.consumeAuthAttributionContext({ linkedinState: state })).toMatchObject({
        cta: 'subscription_cta_social',
        component: 'SubscriptionCTA',
        page: '/calcolatore/',
      });
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: original });
      vi.mocked(firebase.getConfigValue).mockResolvedValue('google-client-id');
    }
  });

  it('a generic LinkedIn button parks a page-only context that fills, not overwrites', () => {
    expect(auth.buildAuthAttributionUpsertFields({ page: '/fisco/' }, '/')).toEqual({
      sourcePage: '/fisco/',
      sourceCta: null,
      sourceComponent: 'authService',
      sourceRouteFamily: null,
      attributionMode: 'fill',
    });
  });

  it('sanitizeAuthReturnPath rejects every off-origin shape', () => {
    expect(auth.sanitizeAuthReturnPath('/lavoro/?q=1')).toBe('/lavoro/?q=1');
    for (const bad of ['//evil.example', '/\\evil.example', 'https://evil.example/', 'javascript:alert(1)', '', '/a\nb', 42]) {
      expect(auth.sanitizeAuthReturnPath(bad)).toBeNull();
    }
  });
});
