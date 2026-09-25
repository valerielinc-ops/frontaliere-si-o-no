// @vitest-environment jsdom

/**
 * The consent record written by a sign-in.
 *
 * Owner decisions of 2026-09-25: registration stays silent (no checkbox), a
 * provider login always registers, and the consent record of a sign-in carries
 * the current registration formula as displayed, whatever the surface; the
 * surface the login came from is stored in `consent_origin`, the confirmation
 * origin beside `confirmed_at`, and the same block in the append-only event.
 * A restored session or a link autologin is not a sign-in act and never creates
 * a relationship on a document that has none (the banner asks instead).
 *
 * These tests run the real authService → newsletterSubscribers path with
 * Firestore faked at the SDK boundary and read the documents and audit events
 * that would be written, surface by surface.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('@/services/authService');

type Written = { path: string; data: Record<string, any>; options?: unknown };
const writes: Written[] = [];
const events: Written[] = [];
let docs: Record<string, Record<string, any>> = {};
/** Model of firestore.rules for the one decision that matters here. */
let rulesMode: 'accept' | 'unverified-owner' = 'accept';

vi.mock('firebase/firestore', () => {
  const pathOf = (parent: any, segments: string[]) =>
    [parent?.path, ...segments].filter(Boolean).join('/');
  return {
    getFirestore: vi.fn(() => ({ __db: true })),
    collection: vi.fn((parent: any, ...segments: string[]) => ({ path: pathOf(parent, segments) })),
    doc: vi.fn((parent: any, ...segments: string[]) => ({ path: pathOf(parent, segments) })),
    getDoc: vi.fn(async (ref: { path: string }) => ({
      exists: () => ref.path in docs,
      data: () => docs[ref.path],
    })),
    setDoc: vi.fn(async (ref: { path: string }, data: Record<string, any>, options?: unknown) => {
      // firestore.rules accept a verified owner's terms registration whether
      // or not the notice was displayed; without a verified owner they refuse
      // it (`isTermsBasedConfirmedCreate/Update` need isVerifiedSubscriberOwner).
      if (rulesMode === 'unverified-owner' && data.registration_terms_accepted === true) {
        throw Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' });
      }
      writes.push({ path: ref.path, data, options });
      docs[ref.path] = { ...(docs[ref.path] || {}), ...data };
    }),
    addDoc: vi.fn(async (ref: { path: string }, data: Record<string, any>) => {
      events.push({ path: ref.path, data });
      return { id: `evt-${events.length}` };
    }),
    increment: vi.fn((n: number) => ({ __increment: n })),
    serverTimestamp: vi.fn(() => '__server_timestamp__'),
    deleteField: vi.fn(() => '__delete_field__'),
  };
});

const signInWithCredential = vi.fn(async () => ({ user: GOOGLE_USER }));
const signInWithCustomToken = vi.fn(async () => ({ user: AUTOLOGIN_USER }));

vi.mock('firebase/auth', () => ({
  getAuth: vi.fn(() => ({ currentUser: null, authStateReady: async () => undefined, config: { apiKey: 'k' } })),
  setPersistence: vi.fn(async () => undefined),
  browserLocalPersistence: {},
  GoogleAuthProvider: { credential: vi.fn(() => ({})) },
  signInWithCredential,
  signInWithCustomToken,
}));

const GOOGLE_USER = {
  uid: 'uid-google',
  email: 'reader@example.test',
  emailVerified: true,
  displayName: 'Reader Test',
  photoURL: null,
  providerData: [{ providerId: 'google.com' }],
};
const AUTOLOGIN_USER = {
  uid: 'uid-autologin',
  email: 'profile-only@example.test',
  emailVerified: false,
  displayName: null,
  photoURL: null,
  providerData: [],
};

const SUB = (email: string) => `newsletter_subscribers/${email}`;

const { getDoc } = await import('firebase/firestore');
const auth = await import('@/services/authService');
const { CONSENT_TEXTS, consentDisplayText } = await import('@/services/consentTexts');
const firebase = await import('@/services/firebase');

let gisCallback: ((response: { credential: string; select_by?: string }) => Promise<void>) | null = null;

beforeAll(async () => {
  vi.mocked(firebase.getConfigValue).mockResolvedValue('google-client-id');
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
});

beforeEach(() => {
  vi.mocked(getDoc).mockClear();
  writes.length = 0;
  events.length = 0;
  docs = {};
  rulesMode = 'accept';
  document.body.innerHTML = '';
  window.sessionStorage.clear();
  window.history.replaceState(null, '', '/calcolatore/');
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ success: true }) })));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

async function settle(): Promise<void> {
  // The sign-in handlers fire the profile write without awaiting it, and the
  // first write pays the dynamic imports of the writer modules.
  await vi.waitFor(() => {
    expect(vi.mocked(getDoc).mock.calls.length).toBeGreaterThan(0);
  }, { timeout: 15_000 });
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Wait for the registration write — or its refusal — to land. */
async function settleWrite(): Promise<void> {
  await vi.waitFor(() => {
    expect(
      writes.some((x) => 'source_channel' in x.data)
      || events.some((e) => e.data.event_type === 'registration_refused'),
    ).toBe(true);
  }, { timeout: 15_000 });
  await settle();
}

function registration(email = GOOGLE_USER.email): Record<string, any> {
  const w = writes.find((x) => x.path === SUB(email) && 'source_channel' in x.data);
  expect(w, `no registration write on ${SUB(email)}`).toBeDefined();
  return w!.data;
}

function consentEvent(email = GOOGLE_USER.email): Record<string, any> {
  const e = events.find((x) => x.path === `${SUB(email)}/events` && x.data.metadata?.consent);
  expect(e, 'no audit event carrying the consent block').toBeDefined();
  return e!.data;
}

const CURRENT_FORMULA = () => ({
  consent_text: consentDisplayText('communicationsOptIn', 'it'),
  consent_text_version: CONSENT_TEXTS.communicationsOptIn.version,
  consent_text_displayed: true,
  consent_act: 'registration_terms_acceptance',
  consent_method: 'terms_and_conditions',
  consent_basis: 'registration_terms',
  registration_terms_accepted: true,
});

describe('every sign-in surface: current formula, displayed, and the real surface', { timeout: 30_000 }, () => {
  it('One Tap on a plain page: registered, surface auth_one_tap, confirmation origin and audit event', async () => {
    await auth.promptOneTap(); // App.tsx's page-wide prompt
    await gisCallback!({ credential: 'jwt', select_by: 'user' });
    await settleWrite();

    const d = registration();
    expect(d).toMatchObject({ ...CURRENT_FORMULA(), status: 'confirmed', consent_origin: 'auth_one_tap' });
    expect(d.consent_given_at).toBe('__server_timestamp__');
    expect(d.confirmation_method).toBe('provider_verified_email');
    expect(d.confirmed_via_surface).toBe('auth_one_tap');

    expect(consentEvent().metadata.consent).toMatchObject({
      act: 'registration_terms_acceptance',
      origin: 'auth_one_tap',
      text_displayed: true,
      text_version: CONSENT_TEXTS.communicationsOptIn.version,
      text_locale: 'it',
      page: '/calcolatore/',
      trigger: 'sign_in',
      provider: 'google',
      one_tap_select_by: 'user',
      confirmation_method: 'provider_verified_email',
      confirmed_via_surface: 'auth_one_tap',
    });
    expect(events.some((e) => e.data.event_type === 'registration_refused')).toBe(false);
  });

  it('One Tap prompted by the job gate: surface job_gate', async () => {
    auth.saveAuthJobContext({ slug: 'infermiere-eoc', company: 'EOC', surface: 'modal' });
    await auth.promptOneTap({ surface: 'job_gate_modal' });
    await gisCallback!({ credential: 'jwt', select_by: 'user_1tap' });
    await settleWrite();
    expect(registration()).toMatchObject({ ...CURRENT_FORMULA(), consent_origin: 'job_gate', job_slug: 'infermiere-eoc' });
  });

  it('the newsletter popup button: surface newsletter_popup', async () => {
    await auth.renderGoogleButton(document.createElement('div'), {
      attribution: { cta: 'newsletter_popup_social', component: 'NewsletterPopup' },
    });
    const renderButton = (window as any).google.accounts.id.renderButton as ReturnType<typeof vi.fn>;
    renderButton.mock.calls[renderButton.mock.calls.length - 1][1].click_listener();
    await gisCallback!({ credential: 'jwt', select_by: 'btn' });
    await settleWrite();
    expect(registration()).toMatchObject({
      ...CURRENT_FORMULA(),
      consent_origin: 'newsletter_popup',
      confirmed_via_surface: 'newsletter_popup',
    });
  });

  it('the assistant: surface ai_chatbot', async () => {
    await auth.saveUserProfileToFirestore(GOOGLE_USER, 'google', null, { cta: 'ai_chatbot_social', component: 'AiChatbot' });
    expect(registration()).toMatchObject({ ...CURRENT_FORMULA(), consent_origin: 'ai_chatbot' });
  });

  it('the profile page (a Google button nobody attributed): surface auth_google_button', async () => {
    window.history.replaceState(null, '', '/profilo/');
    await auth.saveUserProfileToFirestore(GOOGLE_USER, 'google');
    expect(registration()).toMatchObject({ ...CURRENT_FORMULA(), consent_origin: 'auth_google_button' });
    expect(consentEvent().metadata.consent.page).toBe('/profilo/');
  });

  it('a job-gate login (job context parked): surface job_gate', async () => {
    auth.saveAuthJobContext({ slug: 'infermiere-eoc', company: 'EOC', surface: 'inline' });
    await auth.saveUserProfileToFirestore(GOOGLE_USER, 'google');
    expect(registration()).toMatchObject({ ...CURRENT_FORMULA(), consent_origin: 'job_gate', job_slug: 'infermiere-eoc' });
  });

  it('the formula follows the language the site is read in', async () => {
    const i18n = await import('@/services/i18n');
    const spy = vi.spyOn(i18n, 'getLocale').mockReturnValue('de' as any);
    try {
      await auth.saveUserProfileToFirestore(GOOGLE_USER, 'google');
      expect(registration().consent_text).toBe(consentDisplayText('communicationsOptIn', 'de'));
      expect(consentEvent().metadata.consent.text_locale).toBe('de');
    } finally {
      spy.mockRestore();
    }
  });

  it('email + password: pending with the same formula, no confirmation recorded yet', async () => {
    await auth.saveUserProfileToFirestore({ ...GOOGLE_USER, emailVerified: false, providerData: [] }, 'email', null, null);
    const d = registration();
    expect(d).toMatchObject({ ...CURRENT_FORMULA(), status: 'pending', consent_origin: 'auth_email_password' });
    expect(d).not.toHaveProperty('confirmation_method');
    expect(consentEvent().metadata.consent.confirmation_method).toBeNull();
  });
});

describe('reconciliation never creates a relationship', { timeout: 30_000 }, () => {
  it('newsletter autologin (`ac` → custom token) on a profile-only document: no relationship, no write', async () => {
    docs[SUB(AUTOLOGIN_USER.email)] = { auth_uid: 'uid-autologin', name: 'x', lastLoginAt: 'ts' };
    await auth.signInWithCustomAuthToken('custom-token');
    await settle();
    expect(writes).toEqual([]);
    expect(events).toEqual([]);
    // The banner still finds a document without consent to ask about.
    expect(docs[SUB(AUTOLOGIN_USER.email)]).not.toHaveProperty('consent_text');
  });

  it('newsletter autologin with no document at all: nothing is created', async () => {
    await auth.signInWithCustomAuthToken('custom-token');
    await settle();
    expect(writes).toEqual([]);
  });

  it('newsletter autologin on a registered document: only the login/profile fields', async () => {
    docs[SUB(AUTOLOGIN_USER.email)] = {
      status: 'confirmed',
      registration_terms_accepted: true,
      consent_text: 'formula originale',
      consent_text_displayed: true,
    };
    await auth.signInWithCustomAuthToken('custom-token');
    await settle();
    expect(writes).toHaveLength(1);
    expect(Object.keys(writes[0].data).sort()).toEqual(
      ['auth_provider', 'auth_uid', 'firstName', 'lastLoginAt', 'lastName', 'name', 'photoURL', 'updatedAt'],
    );
    expect(events).toEqual([]);
  });

  it('a restored session behaves the same (profile-only stays profile-only)', async () => {
    docs[SUB(GOOGLE_USER.email)] = { auth_uid: 'uid-google', lastLoginAt: 'ts' };
    await auth.saveUserProfileToFirestore(GOOGLE_USER, 'google', null, null, { trigger: 'session_restore' });
    expect(writes).toEqual([]);
  });

  it('a restored session does not consume the context a foreground login parked', async () => {
    auth.setAuthAttributionContext({ cta: 'offerwall_social', component: 'OfferwallNewsletterGate' });
    await auth.saveUserProfileToFirestore(GOOGLE_USER, 'google', null, null, { trigger: 'session_restore' });
    expect(auth.consumeAuthAttributionContext()).toMatchObject({ component: 'OfferwallNewsletterGate' });
  });
});

describe('a sign-in the rules refuse', { timeout: 30_000 }, () => {
  it('is recorded in the append-only log with its consent block, and writes no profile-only row', async () => {
    rulesMode = 'unverified-owner';
    await auth.promptOneTap();
    await gisCallback!({ credential: 'jwt', select_by: 'user' });
    await settleWrite();

    expect(writes).toEqual([]);
    const refused = events.find((e) => e.data.event_type === 'registration_refused');
    expect(refused?.path).toBe(`${SUB(GOOGLE_USER.email)}/events`);
    expect(refused?.data.metadata).toMatchObject({
      reason: 'firestore_rules_refused',
      consent: { origin: 'auth_one_tap', text_displayed: true, act: 'registration_terms_acceptance' },
    });
  });
});

describe('jobgate-v3: a social login from the gate carries the arm, like the email unlock', { timeout: 30_000 }, () => {
  const JOB_PAGE = '/cerca-lavoro-ticino/infermiere-eoc-lugano-abc123/';
  const enrolledContext = { slug: 'infermiere-eoc', surface: 'inline' as const, variant: 'social_first', experimentId: 'jobgate-v3' };

  beforeEach(() => {
    window.history.replaceState(null, '', JOB_PAGE);
  });

  it('an enrolled visitor\'s Google login from the gate is written with jobgate-v3:<arm>, counted by the readout', async () => {
    auth.saveAuthJobContext(enrolledContext);
    await auth.saveUserProfileToFirestore(GOOGLE_USER, 'google');
    const d = registration();
    expect(d.variant).toBe('jobgate-v3:social_first');
    expect(d.consent_origin).toBe('job_gate');

    // The readout's two readers see it: the arm aggregate (created in the
    // window, keyed by the tag) and the attribution coverage (tagged).
    const { classifySubscriber, aggregateSubscribers, attributionCoverage, armFromVariantTag } = await import('../scripts/lib/experiment-stats.mjs');
    const now = Date.now();
    const classified = classifySubscriber({ ...d, created_at: new Date(now - 60_000) });
    const agg = aggregateSubscribers([classified], {
      keyOf: (x: { variant: string }) => armFromVariantTag(x.variant, 'jobgate-v3'),
      startMs: now - 3_600_000,
      endMs: now + 1,
      nowMs: now,
    });
    expect(agg.byKey.social_first?.newSubscribers).toBe(1);
    expect(attributionCoverage(
      [{ variant: d.variant, sourcePage: d.source_page, sourceComponent: d.source_component }],
      { experimentId: 'jobgate-v3' },
    )).toMatchObject({ tagged: 1, untaggedFromGate: 0, coverage: 1 });
  });

  it('One Tap prompted by the gate carries the arm too', async () => {
    auth.saveAuthJobContext(enrolledContext);
    await auth.promptOneTap({ surface: 'job_gate_inline' });
    await gisCallback!({ credential: 'jwt', select_by: 'user' });
    await settleWrite();
    expect(registration().variant).toBe('jobgate-v3:social_first');
  });

  it('not enrolled (kill switch, timeout, bot bypass): the context carries the headline id, no arm is written', async () => {
    auth.saveAuthJobContext({ ...enrolledContext, variant: 'control', experimentId: 'authgate-headline-v3' });
    await auth.saveUserProfileToFirestore(GOOGLE_USER, 'google');
    expect(registration().variant).toBeNull();
  });

  it('a page-wide One Tap that only finds a stale gate context is not tagged', async () => {
    auth.saveAuthJobContext(enrolledContext);
    await auth.promptOneTap();
    await gisCallback!({ credential: 'jwt', select_by: 'user' });
    await settleWrite();
    expect(registration().variant).toBeNull();
  });

  it('never replaces the arm of an earlier capture, nor tags an address that already had a relationship', async () => {
    docs[SUB(GOOGLE_USER.email)] = {
      status: 'confirmed', isActive: true, active: true, source_channel: 'job_gate',
      registration_terms_accepted: true, created_at: 'then', variant: 'jobgate-v3:control',
    };
    auth.saveAuthJobContext(enrolledContext);
    await auth.saveUserProfileToFirestore(GOOGLE_USER, 'google');
    expect(registration().variant).toBe('jobgate-v3:control');

    writes.length = 0;
    docs = {
      [SUB(GOOGLE_USER.email)]: {
        status: 'confirmed', isActive: true, active: true, source_channel: 'auth_google',
        registration_terms_accepted: true, created_at: 'then',
      },
    };
    auth.saveAuthJobContext(enrolledContext);
    await auth.saveUserProfileToFirestore(GOOGLE_USER, 'google');
    expect(registration().variant).toBeNull();
  });

  it('the LinkedIn round trip gets the arm computed from the parked context', () => {
    expect(auth.jobGateSubscriberVariantFor(enrolledContext, 'job_gate')).toBe('jobgate-v3:social_first');
    expect(auth.jobGateSubscriberVariantFor(enrolledContext, 'newsletter_popup')).toBeNull();
    expect(auth.jobGateSubscriberVariantFor({ ...enrolledContext, variant: 'bogus' }, 'job_gate')).toBeNull();
    expect(auth.jobGateSubscriberVariantFor(null, 'job_gate')).toBeNull();
  });
});
