// @vitest-environment jsdom

/**
 * The consent record written by a sign-in says what really happened
 * (owner decision of 2026-09-25: registration stays silent — no checkbox — but
 * the consent data and the origin of the confirmation must be stored and true).
 *
 * Measured on production the same day: every authentication stamped
 * `consent_act: registration_terms_acceptance` + `consent_text_displayed: true`
 * — One Tap, the assistant, the profile page, the `ac` autologin of a
 * newsletter link and even a restored session, none of which renders a notice.
 * 41 former profile-only documents gained a relationship that way, 16 of them
 * mailable, 7 right after an email click. `captureNewsletterSubscriber` forced
 * the flag for every write.
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
let refuseUndisplayedRegistrations = false;

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
      // The one thing firestore.rules decide that matters here: a browser may
      // create/promote a terms registration only with a displayed notice.
      if (
        refuseUndisplayedRegistrations
        && data.registration_terms_accepted === true
        && data.consent_text_displayed !== true
      ) {
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
  refuseUndisplayedRegistrations = false;
  document.body.innerHTML = '';
  window.sessionStorage.clear();
  window.history.replaceState(null, '', '/calcolatore/');
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ success: true }) })));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

/** A `<ConsentNotice>` as it renders: `data-consent-key` + the sentence. */
function renderNotice(text: string, key = 'communicationsOptIn', opts: { onScreen?: boolean } = {}): HTMLElement {
  const el = document.createElement('span');
  el.setAttribute('data-consent-key', key);
  el.textContent = text;
  document.body.appendChild(el);
  if (opts.onScreen !== false) {
    // jsdom has no layout: give the node the box a rendered notice has.
    el.getClientRects = () => [{}] as unknown as DOMRectList;
    el.getBoundingClientRect = () => ({
      top: 400, left: 16, bottom: 432, right: 360, width: 344, height: 32, x: 16, y: 400, toJSON: () => ({}),
    }) as DOMRect;
  }
  return el;
}

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

describe('One Tap', { timeout: 30_000 }, () => {
  it('on a plain page: registered with the truth — nothing displayed, surface auth_one_tap', async () => {
    await auth.promptOneTap(); // App.tsx's page-wide prompt
    await gisCallback!({ credential: 'jwt', select_by: 'user' });
    await settleWrite();

    const d = registration();
    expect(d.consent_text_displayed).toBe(false);
    expect(d.consent_origin).toBe('auth_one_tap');
    expect(d.consent_act).toBe('registration_terms_acceptance');
    expect(d.consent_text).toBe(consentDisplayText('communicationsOptIn', 'it'));
    expect(d.consent_text_version).toBe(CONSENT_TEXTS.communicationsOptIn.version);
    expect(d.consent_given_at).toBe('__server_timestamp__');
    // How the address got confirmed, and where: Google vouched for it.
    expect(d.confirmation_method).toBe('provider_verified_email');
    expect(d.confirmed_via_surface).toBe('auth_one_tap');

    const e = consentEvent();
    expect(e.metadata.consent).toMatchObject({
      act: 'registration_terms_acceptance',
      origin: 'auth_one_tap',
      text_displayed: false,
      text_version: CONSENT_TEXTS.communicationsOptIn.version,
      text_locale: 'it',
      page: '/calcolatore/',
      trigger: 'sign_in',
      provider: 'google',
      one_tap_select_by: 'user',
      confirmation_method: 'provider_verified_email',
    });
  });

  it('prompted by the job gate with its notice on screen: displayed, surface job_gate, the sentence that was shown', async () => {
    auth.saveAuthJobContext({ slug: 'infermiere-eoc', company: 'EOC', surface: 'modal' });
    const shown = consentDisplayText('communicationsOptIn', 'de');
    renderNotice(shown);
    await auth.promptOneTap({ surface: 'job_gate_modal' });
    await gisCallback!({ credential: 'jwt', select_by: 'user_1tap' });
    await settleWrite();

    const d = registration();
    expect(d.consent_text_displayed).toBe(true);
    expect(d.consent_origin).toBe('job_gate');
    // The German sentence the page showed, not the governing Italian one.
    expect(d.consent_text).toBe(shown);
    expect(consentEvent().metadata.consent).toMatchObject({ text_displayed: true, text_locale: 'de', notice_key: 'communicationsOptIn' });
  });

  it('a notice that is in the DOM but not on screen is not "displayed"', async () => {
    renderNotice(consentDisplayText('communicationsOptIn', 'it'), 'communicationsOptIn', { onScreen: false });
    await auth.promptOneTap();
    await gisCallback!({ credential: 'jwt', select_by: 'auto' });
    await settleWrite();
    expect(registration().consent_text_displayed).toBe(false);
  });
});

describe('rendered Google buttons and generic sign-ins', { timeout: 30_000 }, () => {
  it('the newsletter popup button, notice on screen at the click: displayed, surface newsletter_popup', async () => {
    renderNotice(consentDisplayText('communicationsOptIn', 'it'));
    await auth.renderGoogleButton(document.createElement('div'), {
      attribution: { cta: 'newsletter_popup_social', component: 'NewsletterPopup' },
    });
    const renderButton = (window as any).google.accounts.id.renderButton as ReturnType<typeof vi.fn>;
    renderButton.mock.calls[renderButton.mock.calls.length - 1][1].click_listener();
    document.body.innerHTML = ''; // the popup closes behind the Google chooser
    await gisCallback!({ credential: 'jwt', select_by: 'btn' });
    await settleWrite();

    const d = registration();
    expect(d.consent_text_displayed).toBe(true);
    expect(d.consent_origin).toBe('newsletter_popup');
    expect(d.confirmed_via_surface).toBe('newsletter_popup');
  });

  it('the assistant sign-in: nothing displayed, surface ai_chatbot', async () => {
    await auth.saveUserProfileToFirestore(GOOGLE_USER, 'google', null, { cta: 'ai_chatbot_social', component: 'AiChatbot' }, {
      consentEvidence: auth.captureConsentNoticeEvidence(),
    });
    const d = registration();
    expect(d.consent_text_displayed).toBe(false);
    expect(d.consent_origin).toBe('ai_chatbot');
  });

  it('the profile page (a Google button nobody attributed): nothing displayed, surface auth_google_button', async () => {
    window.history.replaceState(null, '', '/profilo/');
    auth.parkConsentEvidence(auth.captureConsentNoticeEvidence());
    await auth.saveUserProfileToFirestore(GOOGLE_USER, 'google');
    const d = registration();
    expect(d.consent_text_displayed).toBe(false);
    expect(d.consent_origin).toBe('auth_google_button');
    expect(consentEvent().metadata.consent.page).toBe('/profilo/');
  });

  it('a job-gate login (job context parked) with the gate notice on screen: displayed, surface job_gate', async () => {
    renderNotice(consentDisplayText('communicationsOptIn', 'it'));
    auth.parkConsentEvidence(auth.captureConsentNoticeEvidence());
    auth.saveAuthJobContext({ slug: 'infermiere-eoc', company: 'EOC', surface: 'inline' });
    await auth.saveUserProfileToFirestore(GOOGLE_USER, 'google');
    const d = registration();
    expect(d.consent_text_displayed).toBe(true);
    expect(d.consent_origin).toBe('job_gate');
    expect(d.job_slug).toBe('infermiere-eoc');
  });

  it('email + password: pending, nothing displayed, no confirmation recorded yet', async () => {
    await auth.saveUserProfileToFirestore({ ...GOOGLE_USER, emailVerified: false, providerData: [] }, 'email', null, null, {
      consentEvidence: null,
    });
    const d = registration();
    expect(d.status).toBe('pending');
    expect(d.consent_text_displayed).toBe(false);
    expect(d.consent_origin).toBe('auth_email_password');
    expect(d).not.toHaveProperty('confirmation_method');
    expect(consentEvent().metadata.consent.confirmation_method).toBeNull();
  });

  it('a historical register key on screen cannot turn into a displayed claim', async () => {
    renderNotice(CONSENT_TEXTS.signInAutoSubscribe.text, 'signInAutoSubscribe');
    auth.parkConsentEvidence(auth.captureConsentNoticeEvidence());
    await auth.saveUserProfileToFirestore(GOOGLE_USER, 'google');
    expect(registration().consent_text_displayed).toBe(false);
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

describe('when firestore.rules refuse an undisplayed registration', { timeout: 30_000 }, () => {
  it('records the refused attempt truthfully and writes no profile-only row', async () => {
    refuseUndisplayedRegistrations = true;
    await auth.promptOneTap();
    await gisCallback!({ credential: 'jwt', select_by: 'user' });
    await settleWrite();

    expect(writes).toEqual([]);
    const refused = events.find((e) => e.data.event_type === 'registration_refused');
    expect(refused?.path).toBe(`${SUB(GOOGLE_USER.email)}/events`);
    expect(refused?.data.metadata).toMatchObject({
      reason: 'firestore_rules_require_displayed_notice',
      consent: { origin: 'auth_one_tap', text_displayed: false, act: 'registration_terms_acceptance' },
    });
  });

  it('a displayed registration is not affected', async () => {
    refuseUndisplayedRegistrations = true;
    renderNotice(consentDisplayText('communicationsOptIn', 'it'));
    auth.parkConsentEvidence(auth.captureConsentNoticeEvidence());
    await auth.saveUserProfileToFirestore(GOOGLE_USER, 'google');
    expect(registration().consent_text_displayed).toBe(true);
    expect(events.some((e) => e.data.event_type === 'registration_refused')).toBe(false);
  });
});

describe('notice evidence', () => {
  it('reads the visible notice, its key and its exact text', () => {
    const shown = consentDisplayText('communicationsOptIn', 'fr');
    renderNotice(shown);
    expect(auth.captureConsentNoticeEvidence()).toEqual({ displayed: true, key: 'communicationsOptIn', text: shown });
  });

  it('ignores a notice scrolled off screen', () => {
    const el = renderNotice(consentDisplayText('communicationsOptIn', 'it'));
    el.getBoundingClientRect = () => ({
      top: 5000, left: 16, bottom: 5032, right: 360, width: 344, height: 32, x: 16, y: 5000, toJSON: () => ({}),
    }) as DOMRect;
    expect(auth.captureConsentNoticeEvidence().displayed).toBe(false);
  });

  it('parked evidence is one-shot and bound to the LinkedIn state it was parked with', () => {
    auth.parkConsentEvidence({ displayed: true, key: 'communicationsOptIn', text: 't' }, { linkedinState: 'a' });
    expect(auth.consumeConsentEvidence({ linkedinState: 'b' })).toBeNull();
    auth.parkConsentEvidence({ displayed: true, key: 'communicationsOptIn', text: 't' }, { linkedinState: 'a' });
    expect(auth.consumeConsentEvidence({ linkedinState: 'a' })).toMatchObject({ displayed: true });
    expect(auth.consumeConsentEvidence({ linkedinState: 'a' })).toBeNull();
  });

  it('an abandoned provider click leaves no evidence for a later login', () => {
    auth.parkConsentEvidence({ displayed: true, key: 'communicationsOptIn', text: 't' });
    auth.clearAuthAttributionContext();
    expect(auth.consumeConsentEvidence()).toBeNull();
  });
});
