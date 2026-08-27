// Una sola catena di preferenza per la lingua di un iscritto.
//
// Chiude il follow-up #6273. Prima esistevano cinque catene scritte a mano e
// tutte diverse, quindi trigger Firestore e path `confirm` potevano mandare la
// STESSA welcome in due lingue diverse allo stesso iscritto a seconda di quale
// invocazione vinceva la corsa. Questi test non descrivono solo il resolver:
// il blocco «nessuna catena a mano sopravvive» e' l'osservatore che impedisce
// alla sesta di nascere.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSubscriberLocale } from '../functions/src/lib/subscriberLocale.js';
import { localeOf } from '../scripts/lib/subscriberLocale.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('resolveSubscriberLocale — la catena canonica', () => {
  it('una preferenza espressa DOPO l\'iscrizione batte il locale di cattura', () => {
    // Il caso reale: iscritto in italiano, poi scarica un report in tedesco.
    // `sendCalculatorReport.js` riscrive `preferred_locale` da solo e non
    // tocca `locale`. Prima il trigger leggeva `locale` e mandava italiano.
    expect(resolveSubscriberLocale({ locale: 'it', preferred_locale: 'de' })).toBe('de');
  });

  it('signup_locale batte il locale generico quando non c\'e\' preferenza', () => {
    expect(resolveSubscriberLocale({ locale: 'it', signup_locale: 'fr' })).toBe('fr');
  });

  it('rispetta l\'ordine completo preferred → signup → locale → it', () => {
    expect(resolveSubscriberLocale({ preferred_locale: 'de', signup_locale: 'fr', locale: 'en' })).toBe('de');
    expect(resolveSubscriberLocale({ signup_locale: 'fr', locale: 'en' })).toBe('fr');
    expect(resolveSubscriberLocale({ locale: 'en' })).toBe('en');
    expect(resolveSubscriberLocale({})).toBe('it');
    expect(resolveSubscriberLocale(null)).toBe('it');
  });

  it('un locale esplicito del chiamante vince, ma solo se non e\' vuoto', () => {
    expect(resolveSubscriberLocale({ preferred_locale: 'de' }, 'fr')).toBe('fr');
    // La stringa vuota NON deve vincere: era il modo in cui il path `confirm`
    // finiva a 'it' pur avendo un `preferred_locale` valorizzato.
    expect(resolveSubscriberLocale({ preferred_locale: 'de' }, '')).toBe('de');
    expect(resolveSubscriberLocale({ preferred_locale: 'de' }, undefined)).toBe('de');
  });

  it('normalizza le forme regionali e ignora i locale non supportati', () => {
    expect(resolveSubscriberLocale({ preferred_locale: 'de-CH' })).toBe('de');
    expect(resolveSubscriberLocale({ preferred_locale: 'en_US' })).toBe('en');
    expect(resolveSubscriberLocale({ preferred_locale: 'es' })).toBe('it');
  });

  it('`source_locale` non e\' un campo del documento iscritto e non conta', () => {
    // Vive solo sulla sottocollezione `events`. Il trigger lo leggeva da
    // `after`, dove non c'e' mai stato: era un ramo morto che dava l'illusione
    // di un fallback.
    expect(resolveSubscriberLocale({ source_locale: 'de' })).toBe('it');
  });
});

describe('localeOf (shim scripts/) — stessa catena, piu\' la grafia vecchia', () => {
  it('delega al modulo canonico', () => {
    expect(localeOf({ locale: 'it', preferred_locale: 'de' })).toBe('de');
    // Il buco che lo shim aveva per conto suo: saltava `signup_locale`.
    expect(localeOf({ signup_locale: 'fr' })).toBe('fr');
  });

  it('accetta ancora `lang`, dopo `locale`', () => {
    expect(localeOf({ lang: 'en' })).toBe('en');
    expect(localeOf({ locale: 'fr', lang: 'en' })).toBe('fr');
  });
});

describe('nessuna catena locale scritta a mano sopravvive', () => {
  // I cinque file che avevano la propria catena. Se uno di loro torna a
  // costruirla in casa, il drift ricomincia da li'.
  const GUARDED = [
    'functions/index.js',
    'functions/src/newsletterWelcomeEmail.js',
    'functions/src/newsletterConfirmationEmail.js',
    'functions/src/newsletterSubscriptionManagement.js',
    'functions/src/jobAlertBackfillCore.js',
    'scripts/lib/subscriberLocale.mjs',
    // Gemelli trovati dal gate sibling mentre si chiudeva #6273: stessa
    // catena a mano, ognuno con un campo diverso mancante.
    'scripts/newsletter-confirmation-followups.mjs',
    'scripts/lib/subscriberFromFirestoreRow.mjs',
  ];

  // Due campi locale dell'iscritto messi in `||` nella stessa espressione:
  // e' la forma esatta di ognuna delle cinque catene rimosse.
  const HAND_ROLLED = /\b(?:preferred_locale|signup_locale|source_locale)\b[^\n;]{0,80}\|\|[^\n;]{0,80}\b(?:preferred_locale|signup_locale|locale|source_locale)\b/;

  for (const rel of GUARDED) {
    it(`${rel} non ricostruisce la catena in casa`, () => {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
      // I commenti documentano le catene rimosse di proposito: si giudica il
      // codice, non la spiegazione di com'era prima.
      const code = src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((l) => !l.trim().startsWith('//'))
        .join('\n');
      expect(HAND_ROLLED.test(code), `${rel}: catena locale scritta a mano — usa resolveSubscriberLocale()`).toBe(false);
    });
  }

  it('tutti e cinque i file importano davvero il resolver condiviso', () => {
    for (const rel of GUARDED) {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
      expect(src, `${rel} non importa resolveSubscriberLocale`).toMatch(/resolveSubscriberLocale/);
    }
  });
});
