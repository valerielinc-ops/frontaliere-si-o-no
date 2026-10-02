import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  CREATE_ACCOUNT_RE,
  authPageKind,
  codeField,
  hostKey,
  loginFields,
  newPortalPassword,
  portalAccountStore,
  portalPasswordLength,
  registrationOutcome,
  sameSite,
  verificationOutcome,
} from '../scripts/assisted-application/lib/portal/account.mjs';
import { handleAutomationAdminAction, loadAutomationForAdmin } from '../functions/src/assistedApplicationAutomationAdmin.js';
import { createMemoryFirestore } from './helpers/memoryFirestore';

const ORDER = 'order-1';
const ACCOUNTS = `assisted_applications/${ORDER}/automation/accounts`;
const RAW_KEY = randomBytes(32).toString('base64');
const KEY = Buffer.from(RAW_KEY, 'base64');
const HOST = 'sunrise.wd3.myworkdayjobs.com';
const ALIAS = 'c-abcdefghjk@candidature.frontaliereticino.ch';

const field = (id: string, inputType: string, label: string, extra: Record<string, unknown> = {}) => ({ id, kind: 'text', inputType, label, name: '', autocomplete: '', ...extra });

describe('portal account pages', () => {
  it('tells a create-account page (password + repeat) from a sign-in page', () => {
    const create = { fields: [field('f1', 'email', 'E-Mail-Adresse'), field('f2', 'password', 'Kennwort'), field('f3', 'password', 'Kennwort bestätigen')] };
    const signIn = { fields: [field('f1', 'email', 'E-Mail-Adresse'), field('f2', 'password', 'Kennwort')] };
    expect(authPageKind(create)).toBe('create');
    expect(authPageKind(signIn)).toBe('sign_in');
    expect(authPageKind({ fields: [field('f1', 'text', 'Vorname')] })).toBe('none');
    expect(loginFields(signIn)).toEqual({ email: signIn.fields[0], password: signIn.fields[1] });
    expect(codeField({ fields: [field('f1', 'text', 'Bestätigungscode')] })?.id).toBe('f1');
    expect(codeField({ fields: [field('f1', 'password', 'Code')] })).toBeNull();
  });

  it('makes a password every usual policy accepts: 20 characters, 16 on SuccessFactors', () => {
    const password = newPortalPassword({ portal: 'workday' });
    expect(password).toHaveLength(20);
    expect(password).toMatch(/[A-Z]/);
    expect(password).toMatch(/[a-z]/);
    expect(password).toMatch(/[0-9]/);
    expect(password).toMatch(/[^A-Za-z0-9]/);
    expect(newPortalPassword({ portal: 'workday' })).not.toBe(password);
    expect(newPortalPassword({ portal: HOST })).toHaveLength(20);
    expect(newPortalPassword()).toHaveLength(20);
    // Coop's SuccessFactors (2026-10-02): at least 8 and at most 18 characters.
    const short = newPortalPassword({ portal: 'career2.successfactors.eu' });
    expect(short).toHaveLength(16);
    expect(short).toMatch(/[A-Z]/);
    expect(short).toMatch(/[^A-Za-z0-9]/);
    expect(portalPasswordLength('career5.sapsf.eu')).toBe(16);
    expect(portalPasswordLength('successfactors')).toBe(16);
    expect(portalPasswordLength('workday')).toBe(20);
    expect(() => newPortalPassword({ bytes: Buffer.alloc(24, 0xff) })).toThrow('password_entropy');
    expect(() => newPortalPassword({ portal: 'career2.successfactors.eu', bytes: Buffer.alloc(24, 0xff) })).toThrow('password_entropy');
  });

  it('finds the create-account link and button of SuccessFactors in the four languages', () => {
    // Coop's career site, 2026-10-02: the link is a question and its answer.
    for (const label of [
      'Konto erstellen', 'Jetzt registrieren', 'Konto anlegen', 'Noch kein Profil? Hier registrieren',
      'Crea account', 'Non hai ancora un profilo? Registrati qui', 'Registrati',
      'Créer un compte', "Vous n'avez pas encore de compte? Créez-en un", 'Create an account', 'Sign up',
    ]) expect(CREATE_ACCOUNT_RE.test(label), label).toBe(true);
    for (const label of ['Kennwort vergessen?', 'Mit bestehendem Profil anmelden und bewerben', 'Job-Abo hier anlegen', 'Melde dich hier an.', 'Anmelden']) {
      expect(CREATE_ACCOUNT_RE.test(label), label).toBe(false);
    }
  });

  it('opens a verification link only on the portal’s own site or its ATS family, over https', () => {
    expect(sameSite(`https://${HOST}/de-CH/Sunrise/activate/abc`, HOST)).toBe(true);
    expect(sameSite('https://wd3.myworkday.com/sunrise/verify?t=1', HOST)).toBe(true);
    expect(sameSite('https://career5.sapsf.eu/career?verify=1', 'career5.successfactors.eu')).toBe(true);
    expect(sameSite('https://evil.example/verify', HOST)).toBe(false);
    expect(sameSite(`http://${HOST}/verify`, HOST)).toBe(false);
    expect(sameSite('not a url', HOST)).toBe(false);
    expect(hostKey(HOST)).toBe('sunrise_wd3_myworkdayjobs_com');
  });
});

describe('what the portal answers', () => {
  const page = (text: string, fields: any[] = [], errors: string[] = []) => ({ text, fields, errors, buttons: [] });

  it('reads the page after the registration click: refused, verify, or created', () => {
    const createForm = [field('e', 'email', 'E-Mail'), field('p1', 'password', 'Kennwort'), field('p2', 'password', 'Kennwort bestätigen')];
    expect(registrationOutcome(page('Registrieren', createForm))).toBe('refused');
    expect(registrationOutcome(page('Registrieren', [], ['Ungültig']))).toBe('refused');
    expect(registrationOutcome(page('Wir haben Ihnen eine E-Mail gesendet. Bitte bestätigen Sie Ihre E-Mail-Adresse.'))).toBe('verify');
    expect(registrationOutcome(page('Enter the code', [field('c', 'text', 'Bestätigungscode')]))).toBe('verify');
    expect(registrationOutcome(page('Bewerbung', [field('v', 'text', 'Vorname'), field('n', 'text', 'Nachname'), field('m', 'email', 'E-Mail')]))).toBe('created');
  });

  it('records a verification only on a positive answer of the portal', () => {
    expect(verificationOutcome(page('Ihre E-Mail-Adresse wurde bestätigt.'))).toBe('accepted');
    expect(verificationOutcome(page('Anmelden', [field('e', 'email', 'E-Mail'), field('p', 'password', 'Kennwort')]))).toBe('accepted');
    expect(verificationOutcome(page('Bewerbung', [field('v', 'text', 'Vorname'), { ...field('cv', 'file', 'Lebenslauf'), kind: 'file' }]))).toBe('accepted');
    expect(verificationOutcome(page('Fehler: Ungültiger Link'))).toBe('rejected');
    expect(verificationOutcome(page('This link has expired. Request a new one.'))).toBe('rejected');
    expect(verificationOutcome(page('Code', [field('c', 'text', 'Bestätigungscode')], ['Der Code ist falsch']))).toBe('rejected');
    expect(verificationOutcome(page('Bitte bestätigen Sie Ihre E-Mail-Adresse.'))).toBe('unconfirmed');
    expect(verificationOutcome(page('Willkommen'))).toBe('unconfirmed');
  });
});

describe('portal account store', () => {
  it('keeps only the encrypted password in Firestore and masks it on every read and write', async () => {
    const store = createMemoryFirestore();
    const mask = vi.fn();
    const accounts = portalAccountStore({ db: store.db, orderId: ORDER, key: KEY, mask, nowMs: () => 1000 });
    await accounts.save(HOST, { email: ALIAS, password: 'Secret123Aa7!' });
    expect(JSON.stringify(store.read(ACCOUNTS))).not.toContain('Secret123Aa7!');
    expect(store.read(ACCOUNTS)?.[hostKey(HOST)]).toMatchObject({ host: HOST, email: ALIAS, createdAt: 1000, verifiedAt: null });
    expect(await accounts.load(HOST)).toMatchObject({ email: ALIAS, password: 'Secret123Aa7!', createdAt: 1000 });
    expect(mask).toHaveBeenCalledWith('Secret123Aa7!');
    await accounts.mark(HOST, { verifiedAt: 2000 });
    expect(store.read(ACCOUNTS)?.[hostKey(HOST)]).toMatchObject({ verifiedAt: 2000, createdAt: 1000 });
    expect(await accounts.load('other.example')).toBeNull();
  });

  it('keeps a credential pending until the portal confirms the registration, and forgets a refused one', async () => {
    const store = createMemoryFirestore();
    const accounts = portalAccountStore({ db: store.db, orderId: ORDER, key: KEY, nowMs: () => 1000 });
    await accounts.save(HOST, { email: ALIAS, password: 'Secret123Aa7!' });
    expect(store.read(ACCOUNTS)?.[hostKey(HOST)]).toMatchObject({ status: 'pending' });
    // Refused (validation error): no account exists, so the next run creates it again.
    await accounts.discard(HOST, 'registration_refused');
    expect(store.read(ACCOUNTS)?.[hostKey(HOST)]).toMatchObject({ status: 'discarded', passwordEnc: null, discardReason: 'registration_refused' });
    expect(await accounts.load(HOST)).toBeNull();
    await accounts.save(HOST, { email: ALIAS, password: 'Other123Aa7!' });
    await accounts.mark(HOST, { status: 'created' });
    expect(await accounts.load(HOST)).toMatchObject({ password: 'Other123Aa7!' });
  });

  it('waits for the verification message received after the account was created, on the portal’s site', async () => {
    const store = createMemoryFirestore({
      [`assisted_applications/${ORDER}/inbox/old`]: { receivedAt: 100, category: 'verification', verificationUrl: `https://${HOST}/old`, verificationCode: '' },
      [`assisted_applications/${ORDER}/inbox/phish`]: { receivedAt: 600, category: 'verification', verificationUrl: 'https://evil.example/verify', verificationCode: '' },
      [`assisted_applications/${ORDER}/inbox/ack`]: { receivedAt: 700, category: 'auto_acknowledgement', verificationUrl: '', verificationCode: '' },
    });
    let now = 500;
    const sleep = vi.fn(async (ms: number) => {
      now += ms;
      if (now >= 20_500) {
        await store.db.collection('assisted_applications').doc(ORDER).collection('inbox').doc('real')
          .set({ receivedAt: now, category: 'verification', verificationUrl: `https://${HOST}/de-CH/Sunrise/activate/xyz`, verificationCode: '' });
      }
    });
    const mask = vi.fn();
    const accounts = portalAccountStore({ db: store.db, orderId: ORDER, key: KEY, mask, nowMs: () => now, sleep });
    const verification = await accounts.waitForVerification({ host: HOST, sinceMs: 500 });
    expect(verification).toMatchObject({ url: `https://${HOST}/de-CH/Sunrise/activate/xyz`, messageId: 'real' });
    expect(mask).toHaveBeenCalledWith(`https://${HOST}/de-CH/Sunrise/activate/xyz`);

    now = 0;
    const empty = portalAccountStore({ db: createMemoryFirestore().db, orderId: ORDER, key: KEY, nowMs: () => now, sleep: async (ms: number) => { now += ms; } });
    expect(await empty.waitForVerification({ host: HOST, sinceMs: 0, timeoutMs: 30_000 })).toBeNull();
  });
});

describe('owner queue: portal accounts', () => {
  it('lists the accounts without their password and reveals one on request, recording who looked', async () => {
    const store = createMemoryFirestore({ [`assisted_applications/${ORDER}`]: { status: 'in_progress' } });
    await portalAccountStore({ db: store.db, orderId: ORDER, key: KEY, nowMs: () => 1000 }).save(HOST, { email: ALIAS, password: 'Secret123Aa7!' });

    const view = await loadAutomationForAdmin(store.db, ORDER);
    expect(view?.accounts).toEqual([{ host: HOST, email: ALIAS, createdAt: 1000, verifiedAt: null, lastSignInAt: null, revealedAt: null }]);
    expect(JSON.stringify(view)).not.toContain('passwordEnc');

    const deps = { runEffect: vi.fn(), nowMs: 5000, runKey: async () => RAW_KEY };
    const body = await handleAutomationAdminAction(store.db, { action: 'automationRevealAccount', orderId: ORDER, host: HOST }, 'owner@example.com', deps);
    expect(body).toEqual({ ok: true, host: HOST, email: ALIAS, password: 'Secret123Aa7!' });
    expect(store.read(ACCOUNTS)?.[hostKey(HOST)]).toMatchObject({ revealedAt: 5000, revealedBy: 'owner@example.com' });

    await expect(handleAutomationAdminAction(store.db, { action: 'automationRevealAccount', orderId: ORDER, host: 'other.example' }, 'owner@example.com', deps))
      .rejects.toMatchObject({ code: 'no_account', status: 404 });
    await expect(handleAutomationAdminAction(store.db, { action: 'automationRevealAccount', orderId: ORDER, host: HOST }, 'owner@example.com', { ...deps, runKey: async () => '' }))
      .rejects.toMatchObject({ code: 'run_key_missing' });
  });
});
