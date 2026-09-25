/**
 * The LinkedIn registration is written by the Cloud Function (Admin SDK), so
 * it is the one place where the consent record of a LinkedIn login is formed.
 * Until 2026-09-25 it stamped `consent_text_displayed: true` and a sentence at
 * version 2026-09-15.1 on every login, whatever the person had on screen.
 * Now it stores the record the browser measured at the click, validated, and
 * falls back to what can be proven (`displayed: false`) when there is none.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  docs: {} as Record<string, Record<string, any>>,
  sets: [] as Array<{ path: string; data: Record<string, any>; options?: unknown }>,
  adds: [] as Array<{ path: string; data: Record<string, any> }>,
}));

vi.mock('firebase-admin', () => {
  const makeDoc = (path: string): any => ({
    get: async () => ({ exists: path in state.docs, data: () => state.docs[path] }),
    set: async (data: Record<string, any>, options?: unknown) => {
      state.sets.push({ path, data, options });
      state.docs[path] = { ...(state.docs[path] || {}), ...data };
    },
    collection: (name: string) => ({
      add: async (data: Record<string, any>) => {
        state.adds.push({ path: `${path}/${name}`, data });
        return { id: 'evt' };
      },
    }),
  });
  const firestore = Object.assign(
    () => ({ collection: (name: string) => ({ doc: (id: string) => makeDoc(`${name}/${id}`) }) }),
    { FieldValue: { serverTimestamp: () => '__ts__', delete: () => '__delete__' } },
  );
  return { default: { firestore } };
});
vi.mock('../functions/src/newsletterResendWebhookCore.js', () => ({ ensureAdminApp: vi.fn() }));
vi.mock('../functions/src/remoteConfigSecrets.js', () => ({ getRemoteConfigValue: vi.fn(async () => '') }));

import {
  enrichSubscriberProfile,
  resolveLinkedInConsentRecord,
  resolveLinkedInExperimentVariant,
} from '../functions/src/linkedinAuthCallback.js';
import { REGISTRATION_TERMS_TEXT, REGISTRATION_TERMS_VERSION } from '../functions/src/lib/registrationTermsText.js';

const EMAIL = 'li@example.test';
const PATH = `newsletter_subscribers/${EMAIL}`;
const PROFILE = { auth_uid: 'linkedin:1', auth_provider: 'linkedin', name: 'Li Test', emailVerified: true };

const measured = (over: Record<string, unknown> = {}) => ({
  page: '/cerca-lavoro-ticino/',
  component: 'AiChatbot',
  consent: {
    surface: 'ai_chatbot',
    displayed: false,
    key: 'communicationsOptIn',
    locale: 'de',
    text: REGISTRATION_TERMS_TEXT.de,
    version: REGISTRATION_TERMS_VERSION,
    ...over,
  },
});

beforeEach(() => {
  state.docs = {};
  state.sets.length = 0;
  state.adds.length = 0;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('resolveLinkedInConsentRecord', () => {
  it('keeps a well-formed measured record', () => {
    expect(resolveLinkedInConsentRecord(measured({ displayed: true }))).toEqual({
      surface: 'ai_chatbot',
      displayed: true,
      key: 'communicationsOptIn',
      locale: 'de',
      text: REGISTRATION_TERMS_TEXT.de,
      version: REGISTRATION_TERMS_VERSION,
    });
  });

  it('without a record (an older tab): not displayed, surface auth_linkedin, the current sentence', () => {
    expect(resolveLinkedInConsentRecord({ page: '/' })).toEqual({
      surface: 'auth_linkedin',
      displayed: false,
      key: null,
      locale: 'it',
      text: REGISTRATION_TERMS_TEXT.it,
      version: REGISTRATION_TERMS_VERSION,
    });
  });

  it('refuses malformed fields instead of storing them', () => {
    const r = resolveLinkedInConsentRecord(measured({ surface: 'DROP TABLE', locale: 'xx', displayed: 'yes', version: '' }));
    expect(r.surface).toBe('auth_linkedin');
    expect(r.displayed).toBe(false);
    expect(r.locale).toBe('it');
    expect(r.text).toBe(REGISTRATION_TERMS_TEXT.it);
  });

  it('a displayed claim on a sentence the register does not know stores the canonical one, not displayed', () => {
    expect(resolveLinkedInConsentRecord({
      consent: {
        surface: 'auth_linkedin',
        displayed: true,
        key: 'communicationsOptIn',
        locale: 'it',
        text: 'testo non canonico',
        version: REGISTRATION_TERMS_VERSION,
      },
    })).toEqual({
      surface: 'auth_linkedin',
      displayed: false,
      key: null,
      locale: 'it',
      text: REGISTRATION_TERMS_TEXT.it,
      version: REGISTRATION_TERMS_VERSION,
    });
  });

  it('a displayed claim from another version (deploy skew) or another register key is not trusted', () => {
    expect(resolveLinkedInConsentRecord(measured({ displayed: true, version: '2026-09-16.1' })).displayed).toBe(false);
    expect(resolveLinkedInConsentRecord(measured({ displayed: true, key: 'signInAutoSubscribe' })).displayed).toBe(false);
    expect(resolveLinkedInConsentRecord(measured({ displayed: true, text: REGISTRATION_TERMS_TEXT.fr })).displayed).toBe(false);
  });
});

describe('enrichSubscriberProfile — the consent record of a LinkedIn login', () => {
  it('a new account from a surface that showed nothing: registered, displayed false, surface and confirmation origin recorded', async () => {
    await enrichSubscriberProfile(EMAIL, PROFILE, measured());
    const d = state.sets[0].data;
    expect(d).toMatchObject({
      status: 'confirmed',
      registration_terms_accepted: true,
      consent_text: REGISTRATION_TERMS_TEXT.de,
      consent_text_version: REGISTRATION_TERMS_VERSION,
      consent_text_displayed: false,
      consent_origin: 'ai_chatbot',
      consent_given_at: '__ts__',
      confirmation_method: 'provider_verified_email',
      confirmed_via_surface: 'ai_chatbot',
      created_at: '__ts__',
    });
    expect(state.adds).toHaveLength(1);
    expect(state.adds[0].path).toBe(`${PATH}/events`);
    expect(state.adds[0].data.metadata.consent).toMatchObject({
      origin: 'ai_chatbot',
      text_displayed: false,
      text_locale: 'de',
      page: '/cerca-lavoro-ticino/',
      confirmation_method: 'provider_verified_email',
    });
  });

  it('a notice on screen at the click is recorded as displayed', async () => {
    await enrichSubscriberProfile(EMAIL, PROFILE, measured({ surface: 'job_gate', displayed: true }));
    expect(state.sets[0].data).toMatchObject({ consent_text_displayed: true, consent_origin: 'job_gate' });
  });

  it('an address LinkedIn did not verify is not recorded as provider-verified', async () => {
    await enrichSubscriberProfile(EMAIL, { ...PROFILE, emailVerified: false }, measured());
    expect(state.sets[0].data.confirmation_method).toBe('none');
  });

  it('a profile-only row is registered like a missing one, and dated', async () => {
    state.docs[PATH] = { auth_uid: 'linkedin:1', lastLoginAt: 'old' };
    await enrichSubscriberProfile(EMAIL, PROFILE, measured());
    expect(state.sets[0].data).toMatchObject({
      status: 'confirmed',
      consent_text_displayed: false,
      created_at: '__ts__',
    });
  });

  it('a profile-only row carrying an opt-out is not registered by a login', async () => {
    state.docs[PATH] = { auth_uid: 'linkedin:1', unsubscribed_at: '2026-09-18T00:00:00.000Z' };
    await enrichSubscriberProfile(EMAIL, PROFILE, measured());
    expect(state.sets[0].data).not.toHaveProperty('status');
    expect(state.sets[0].data).not.toHaveProperty('registration_terms_accepted');
  });

  it('an earlier consent record is not rewritten by a later login', async () => {
    state.docs[PATH] = {
      status: 'confirmed',
      consent_text: 'formula precedente',
      consent_text_displayed: false,
      created_at: 'then',
    };
    await enrichSubscriberProfile(EMAIL, PROFILE, measured({ displayed: true }));
    const d = state.sets[0].data;
    expect(d.registration_terms_accepted).toBe(true);
    expect(d).not.toHaveProperty('consent_text');
    expect(d).not.toHaveProperty('consent_text_displayed');
    expect(d).not.toHaveProperty('created_at');
  });

  it('a gate login of an enrolled visitor creates the subscriber with its jobgate-v3 arm', async () => {
    await enrichSubscriberProfile(EMAIL, PROFILE, measured({ surface: 'job_gate', displayed: true, variant: 'jobgate-v3:social_first' }));
    expect(state.sets[0].data.variant).toBe('jobgate-v3:social_first');
    expect(state.adds[0].data.variant).toBe('jobgate-v3:social_first');
  });

  it('the arm never lands on a relationship that already existed, and a malformed tag is dropped', async () => {
    state.docs[PATH] = { status: 'confirmed', registration_terms_accepted: true, consent_text: 'x', created_at: 'then' };
    await enrichSubscriberProfile(EMAIL, PROFILE, measured({ variant: 'jobgate-v3:social_first' }));
    expect(state.sets[0].data).not.toHaveProperty('variant');
    expect(resolveLinkedInExperimentVariant({ consent: { variant: 'jobgate-v3:<script>' } })).toBeNull();
    expect(resolveLinkedInExperimentVariant({ page: '/' })).toBeNull();
  });

  it('a registered row only gets its login fields', async () => {
    state.docs[PATH] = {
      status: 'confirmed',
      registration_terms_accepted: true,
      consent_text: 'x',
      consent_advertising: true,
      created_at: 'then',
    };
    await enrichSubscriberProfile(EMAIL, PROFILE, measured());
    const d = state.sets[0].data;
    expect(d).not.toHaveProperty('consent_text_displayed');
    expect(d).not.toHaveProperty('status');
    expect(d.lastLoginAt).toBe('__ts__');
    expect(state.adds).toHaveLength(0);
  });
});
