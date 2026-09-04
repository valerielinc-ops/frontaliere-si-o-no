import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Drift-net fra la lista hardcoded di `consentFieldsTouched()` in
 * `firestore.rules` e i campi `consent_*` che i writer browser scrivono
 * davvero su `newsletter_subscribers` (#6681, follow-up di #6670).
 *
 * Le due liste non possono condividere una fonte: un file `.rules` non è
 * importabile da TypeScript e Firestore non valuta espressioni sui prefissi
 * di chiave, quindi il guard DEVE enumerare i nomi. Ciò che si può condividere
 * è la verifica, ed è questo file: se un writer aggiunge un campo `consent_*`
 * senza toccare `firestore.rules` in lockstep, quel campo resterebbe
 * scrivibile in anonimo su un documento esistente — il guard appena costruito
 * si indebolirebbe in silenzio, senza che nulla fallisca.
 *
 * Non è un rischio ipotetico: alla prima esecuzione questo test ha trovato
 * `consent_upgraded_at` e `consent_proof_verified` (prova costruita da
 * `services/newsletterConsentUpgrade.ts`) fuori dalla lista.
 *
 * Statico di proposito — nessun emulatore. Il comportamento del guard a
 * runtime è coperto da `tests/firestore-rules-consent-write.test.ts`; qui si
 * sorveglia solo la COMPLETEZZA dell'enumerazione.
 */

const ROOT = resolve(import.meta.dirname, '..');
const SERVICES_DIR = resolve(ROOT, 'services');

/** `consent_x`, mai il prefisso nudo `consent_` che compare nei commenti. */
const CONSENT_KEY_RE = /\bconsent_[a-z0-9]+[a-z0-9_]*\b/g;

/**
 * I moduli client che scrivono campi `consent_*` sul documento
 * `newsletter_subscribers/{email}` — gli unici il cui payload passa da
 * `firestore.rules`.
 */
const WRITERS = [
  // captureNewsletterSubscriber + i path di re-consenso/IP.
  'newsletterSubscribers.ts',
  // recordCommunicationsConsent: updateDoc field-level con la prova del banner.
  'newsletterConsentUpgrade.ts',
];

/**
 * File che nominano `newsletter_subscribers` e chiavi `consent_*` ma non
 * scrivono su quella collection — motivo per file, così che un lettore futuro
 * possa contestarlo invece di fidarsi.
 */
const NON_WRITERS: Readonly<Record<string, string>> = Object.freeze({
  // Catalogo dei testi di consenso: le chiavi compaiono solo in commenti/docs.
  'consentTexts.ts': 'catalogo di testi, nessuna scrittura Firestore',
  // Registry dei canali: cita `consent_text` nella prosa sulla prova art. 25.
  'communicationChannels.ts': 'registry dei canali, nessuna scrittura Firestore',
  // Scrive su job_alert_subscribers e lo dichiara esplicitamente (L57).
  'jobAlertConsentUpgrade.ts': 'scrive su job_alert_subscribers, mai su newsletter_subscribers',
});

/** Le chiavi enumerate dentro `hasAny([...])` di `consentFieldsTouched()`. */
function guardedConsentKeys(): string[] {
  const rules = readFileSync(resolve(ROOT, 'firestore.rules'), 'utf8');
  const fn = rules.match(/function consentFieldsTouched\([^)]*\)\s*\{([\s\S]*?)\n\s*\}/);
  expect(fn, 'consentFieldsTouched() non trovata in firestore.rules').not.toBeNull();
  const list = fn![1].match(/hasAny\(\[([\s\S]*?)\]\)/);
  expect(list, 'hasAny([...]) non trovato in consentFieldsTouched()').not.toBeNull();
  return [...list![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

/** I file `services/*.ts` che nominano la collection e almeno una chiave `consent_*`. */
function candidateFiles(): string[] {
  return readdirSync(SERVICES_DIR)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .filter((name) => {
      const src = readFileSync(resolve(SERVICES_DIR, name), 'utf8');
      return src.includes('newsletter_subscribers') && CONSENT_KEY_RE.test(src);
    });
}

function consentKeysIn(file: string): string[] {
  const src = readFileSync(resolve(SERVICES_DIR, file), 'utf8');
  return [...new Set(src.match(CONSENT_KEY_RE) ?? [])].sort();
}

describe('firestore.rules — consentFieldsTouched() copre i campi scritti', () => {
  it('enumera almeno le 13 chiavi introdotte da #6670', () => {
    const guarded = guardedConsentKeys();
    expect(guarded.length).toBeGreaterThanOrEqual(13);
    expect(new Set(guarded).size, 'chiavi duplicate nella lista').toBe(guarded.length);
  });

  it.each(WRITERS)('ogni chiave consent_* di %s è nel guard', (file) => {
    const guarded = new Set(guardedConsentKeys());
    const missing = consentKeysIn(file).filter((key) => !guarded.has(key));
    expect(
      missing,
      `${file} scrive chiavi consent_* assenti da consentFieldsTouched() in firestore.rules: `
        + `un write anonimo su un documento esistente potrebbe toccarle senza sessione. `
        + `Aggiungile alla lista in firestore.rules.`,
    ).toEqual([]);
  });

  it('nessun writer nuovo sfugge alla lista sorvegliata', () => {
    const known = new Set([...WRITERS, ...Object.keys(NON_WRITERS)]);
    const unclassified = candidateFiles().filter((name) => !known.has(name));
    expect(
      unclassified,
      'file services/ che nominano newsletter_subscribers e chiavi consent_*: '
        + 'aggiungili a WRITERS (se scrivono su quella collection) o a NON_WRITERS con il motivo.',
    ).toEqual([]);
  });
});
