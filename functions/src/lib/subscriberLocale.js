// functions/src/lib/subscriberLocale.js
//
// UNA catena di preferenza per la lingua di un iscritto, condivisa da tutti
// quelli che gliene mandano una.
//
// Prima di questo modulo ce n'erano cinque, tutte scritte a mano e nessuna
// uguale a un'altra (follow-up #6273):
//
//   newsletterWelcomeEmail.js      preferred → signup → locale → it
//   newsletterConfirmationEmail.js preferred → signup → it
//   newsletterSubscriptionManagement.js  preferred → signup   (nessun default)
//   jobAlertBackfillCore.js        preferred → locale → it    (niente signup)
//   index.js (welcomeOnConfirmation)     locale → source_locale → it
//
// L'ultima era la piu' sbagliata delle cinque, e in due modi distinti:
//
//   1. `source_locale` non esiste sul documento iscritto. Si scrive solo sulla
//      sottocollezione `events` (services/newsletterSubscribers.ts,
//      functions/src/newsletterResendWebhookCore.js), quindi quel ramo era
//      morto e la catena era in pratica `locale → it`.
//   2. Rendendo SEMPRE un valore veritiero, il trigger cortocircuitava la
//      catena corretta del chiamato (`locale || data.preferred_locale || …`):
//      `preferred_locale` non veniva mai consultato.
//
// E i due campi divergono davvero. Partono uguali alla cattura
// (`resolveCaptureDefaults`), ma `preferred_locale` viene riscritto DA SOLO,
// piu' tardi, da almeno due writer che `locale` non lo toccano —
// `sendCalculatorReport.js` e `lib/confirmationFollowup.js`. Un iscritto
// registrato in italiano che poi scarica un report in tedesco resta
// `locale:'it'`, `preferred_locale:'de'`: il trigger Firestore gli mandava la
// welcome in italiano e il path `confirm` la stessa welcome in tedesco, a
// seconda di quale invocazione vinceva la corsa.
//
// L'ordine qui sotto e' quello del chiamato — il piu' completo dei cinque, e
// l'unico che rispetta una preferenza espressa dopo l'iscrizione.

import { normalizeLocale } from '../emailI18n.js';

/**
 * Lingua da usare per un iscritto.
 *
 * @param {object|null} data documento `newsletter_subscribers` (non gli eventi)
 * @param {string} [explicit] locale gia' deciso dal chiamante, se ne ha uno
 *   piu' attendibile del documento (es. la lingua della pagina da cui arriva
 *   la richiesta). Vince su tutto, ma solo se non e' vuoto.
 * @returns {'it'|'en'|'de'|'fr'}
 */
export function resolveSubscriberLocale(data, explicit) {
  return normalizeLocale(
    explicit
      || data?.preferred_locale
      || data?.signup_locale
      || data?.locale
      || 'it',
  );
}
