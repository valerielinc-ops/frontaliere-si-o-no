/**
 * Invariante: un login social con i termini di registrazione crea o aggiorna
 * l'iscritto `newsletter_subscribers/{email}` con attribuzione e consenso.
 *
 * ─── Perche' un test di comportamento ──────────────────────────────────────
 *
 * Dal 12 al 15 settembre 2026 (#8341 → #8754) il login ha scritto solo uno
 * stub di profilo: niente `status`, niente `registration_terms_*`, niente
 * `consent_*`, e le creazioni `auth_*` sono crollate da 60-80 a 0-3 al giorno.
 * I test esistenti su services/authService.ts sono regex sul sorgente
 * (`registrationTermsAccepted: true` presente nel file): passano anche se la
 * chiamata diventa codice morto, se il writer centrale smette di trasformare
 * quel flag nei campi di consenso, o se l'attribuzione cambia nome.
 *
 * Qui si esegue il percorso vero — `saveUserProfileToFirestore` →
 * `upsertNewsletterSubscriber` → `captureNewsletterSubscriber` — con Firestore
 * finto al confine del modulo `firebase/firestore` (stessa convenzione di
 * tests/welcome-client-hook.test.ts), e si legge il documento che verrebbe
 * scritto. Nessun modulo del sito viene modificato o finto al suo interno.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// tests/setup-common.tsx finge authService per tutta la suite: qui serve il vero.
vi.unmock('@/services/authService');

type Written = { path: string; data: Record<string, any>; options?: unknown };
const writes: Written[] = [];
let existingDoc: Record<string, any> | null = null;

vi.mock('firebase/firestore', () => ({
  getFirestore: vi.fn(() => ({ __db: true })),
  collection: vi.fn((_db: unknown, name: string) => ({ path: name })),
  doc: vi.fn((parent: any, ...segments: string[]) => ({
    path: [parent?.path, ...segments].filter(Boolean).join('/'),
  })),
  getDoc: vi.fn(async () => ({
    exists: () => existingDoc !== null,
    data: () => existingDoc ?? undefined,
  })),
  setDoc: vi.fn(async (ref: { path: string }, data: Record<string, any>, options?: unknown) => {
    writes.push({ path: ref.path, data, options });
  }),
  addDoc: vi.fn(async () => ({ id: 'evt-1' })),
  increment: vi.fn((n: number) => ({ __increment: n })),
  serverTimestamp: vi.fn(() => '__server_timestamp__'),
  deleteField: vi.fn(() => '__delete_field__'),
}));

vi.mock('@/services/firebase', () => ({
  getApp: vi.fn(async () => ({ __app: true })),
}));

import { saveUserProfileToFirestore } from '@/services/authService';

const SUBSCRIBERS = 'newsletter_subscribers';

function subscriberWrite(email: string): Record<string, any> {
  // Il writer centrale e' la scrittura che porta `source_channel`; quella di
  // arricchimento profilo che segue porta `auth_uid`.
  const w = writes.find((x) => x.path === `${SUBSCRIBERS}/${email}` && 'source_channel' in x.data);
  expect(w, `nessuna scrittura della relazione su ${SUBSCRIBERS}/${email}`).toBeDefined();
  return w!.data;
}

const googleUser = {
  uid: 'uid-google-1',
  email: '  Frontaliere.Test@Example.COM ',
  displayName: 'Anna Rossi',
  photoURL: null,
  providerData: [{ providerId: 'google.com' }],
};

describe('login social → iscritto con attribuzione e consenso', () => {
  beforeEach(() => {
    writes.length = 0;
    existingDoc = null;
    vi.stubGlobal('window', { location: { pathname: '/cerca-lavoro-ticino/infermieri/', href: 'https://frontaliereticino.ch/cerca-lavoro-ticino/infermieri/', search: '' } });
    vi.stubGlobal('navigator', { language: 'it-CH', userAgent: 'vitest' });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ success: true }) })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('Google, account nuovo: crea la relazione confermata sotto i termini di registrazione', async () => {
    await saveUserProfileToFirestore(googleUser, 'google', {
      slug: 'infermiere-eoc', company: 'EOC', title: 'Infermiere', location: 'Lugano', category: 'sanita', searchQuery: null,
    });
    const email = 'frontaliere.test@example.com';
    const d = subscriberWrite(email);

    // Attribuzione: il canale del login, leggibile dal dashboard e dal monitor.
    expect(d.email).toBe(email);
    expect(d.user_id).toBe('uid-google-1');
    expect(d.source_channel).toBe('auth_google');
    expect(d.source_channel.startsWith('auth_')).toBe(true);
    expect(d.source_component).toBe('authService');
    expect(d.source_route_family).toBe('authentication');
    expect(d.source_page).toBe('/cerca-lavoro-ticino/infermieri/');

    // Relazione attiva: provider verificato, nessun DOI.
    expect(d.status).toBe('confirmed');
    expect(d.isActive).toBe(true);

    // Consenso: la base giuridica e il testo mostrato sono registrati.
    expect(d.registration_terms_accepted).toBe(true);
    expect(typeof d.registration_terms_version).toBe('string');
    expect(d.registration_terms_version.length).toBeGreaterThan(0);
    expect(d.registration_terms_accepted_at).toBeTruthy();
    expect(d.consent_basis).toBe('registration_terms');
    expect(d.consent_given).toBe(true);
    expect(typeof d.consent_text).toBe('string');
    expect(d.consent_text.length).toBeGreaterThan(20);

    // Un documento nuovo nasce con created_at: e' cio' che contano il
    // dashboard e il monitor auth-signup-subscriber-monitor.
    expect(d.created_at).toBe('__server_timestamp__');

    // Il contesto del lavoro arriva all'iscritto (criteri iniziali degli alert).
    expect(d.job_slug).toBe('infermiere-eoc');

    // L'arricchimento del profilo segue e non sostituisce la relazione.
    const profile = writes.find((x) => x.path === `${SUBSCRIBERS}/${email}` && 'auth_uid' in x.data);
    expect(profile?.data.auth_provider).toBe('google');
    expect(profile?.options).toEqual({ merge: true });
    expect(writes.indexOf(profile!)).toBeGreaterThan(writes.findIndex((x) => 'source_channel' in x.data));
  });

  it('LinkedIn: stesso contratto, canale auth_linkedin', async () => {
    await saveUserProfileToFirestore({ ...googleUser, uid: 'linkedin:abc', email: 'li@example.com', providerData: [] }, 'linkedin', null);
    const d = subscriberWrite('li@example.com');
    expect(d.source_channel).toBe('auth_linkedin');
    expect(d.registration_terms_accepted).toBe(true);
    expect(d.consent_basis).toBe('registration_terms');
    expect(d.status).toBe('confirmed');
  });

  it('documento gia\' esistente come stub di profilo: il login lo promuove a iscritto con consenso', async () => {
    // La forma lasciata dal 12-15/09 su 130 account: solo profilo, nessuno status.
    existingDoc = { auth_uid: 'uid-google-1', auth_provider: 'google', lastLoginAt: 'x', name: 'Anna Rossi' };
    await saveUserProfileToFirestore(googleUser, 'google', null);
    const d = subscriberWrite('frontaliere.test@example.com');
    expect(d.status).toBe('confirmed');
    expect(d.source_channel).toBe('auth_google');
    expect(d.registration_terms_accepted).toBe(true);
    expect(d.consent_basis).toBe('registration_terms');
  });

  it('un login senza email non scrive nulla', async () => {
    await saveUserProfileToFirestore({ uid: 'u-no-mail', email: null, providerData: [] }, 'google', null);
    expect(writes).toEqual([]);
  });
});
