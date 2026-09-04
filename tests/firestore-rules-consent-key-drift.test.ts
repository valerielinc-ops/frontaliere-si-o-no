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
 * Gemella senza `/g` per i predicati: `RegExp.prototype.test` su una regex
 * globale avanza `lastIndex` e lo conserva fra le chiamate, quindi riusare
 * `CONSENT_KEY_RE` in un `.test()` per-file salterebbe l'inizio dei file
 * successivi — cioè farebbe passare verde proprio il writer nuovo che questa
 * rete esiste per intercettare.
 */
const HAS_CONSENT_KEY_RE = /\bconsent_[a-z0-9]+[a-z0-9_]*\b/;

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

/**
 * Le chiavi enumerate nel primo `hasAny([...])` che segue la dichiarazione di
 * `consentFieldsTouched()`.
 *
 * L'ancoraggio è la dichiarazione, non il corpo delimitato da graffe: estrarre
 * il corpo con un match non-greedy si romperebbe alla prima graffa annidata
 * (un `if`, un ternario multilinea) e fallirebbe con «hasAny non trovato»
 * invece che sul drift reale — rumore che spinge a rilassare il parser proprio
 * mentre il guard cambia.
 */
function guardedConsentKeys(): string[] {
  const rules = readFileSync(resolve(ROOT, 'firestore.rules'), 'utf8');
  const declared = rules.indexOf('function consentFieldsTouched(');
  expect(declared, 'consentFieldsTouched() non trovata in firestore.rules').toBeGreaterThanOrEqual(0);
  const list = rules.slice(declared).match(/hasAny\(\[([\s\S]*?)\]\)/);
  expect(list, 'hasAny([...]) non trovato dopo consentFieldsTouched()').not.toBeNull();
  return [...list![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

/**
 * I file `services/*.ts` che nominano la collection e almeno una chiave
 * `consent_*`.
 *
 * Solo `.ts`, cioè il codice client: i moduli `.mjs` sotto `services/` girano
 * server-side con l'Admin SDK, che bypassa `firestore.rules` per definizione —
 * una loro chiave `consent_*` non sarebbe coperta dal guard neanche
 * enumerandola, e il rischio che governa quel path è un altro (nessuna regola
 * da tenere in lockstep).
 */
function candidateFiles(): string[] {
  return readdirSync(SERVICES_DIR)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .filter((name) => {
      const src = readFileSync(resolve(SERVICES_DIR, name), 'utf8');
      return src.includes('newsletter_subscribers') && HAS_CONSENT_KEY_RE.test(src);
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
      `${file} nomina chiavi consent_* assenti da consentFieldsTouched() in firestore.rules: `
        + `se sono NOMI DI CAMPO scritti sul documento, un write anonimo su un documento `
        + `esistente potrebbe toccarle senza sessione → aggiungile alla lista in firestore.rules. `
        + `Se invece sono valori costanti o token di prosa (non nomi di campo), vanno esclusi `
        + `qui, non aggiunti alle rules.`,
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
