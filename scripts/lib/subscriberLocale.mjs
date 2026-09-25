/**
 * Shim — il modulo canonico e' `functions/src/lib/subscriberLocale.js`, perche'
 * a servirne uno sono anzitutto le Cloud Functions, che non hanno bundler e
 * non possono importare niente fuori da `functions/`. Stesso schema di
 * `services/newsletter/recommendedBlock.mjs`.
 *
 * Prima di #6273 questo file teneva la SUA catena, diversa da tutte le altre
 * quattro nel repo: saltava `signup_locale`. Un iscritto con solo
 * `signup_locale` valorizzato riceveva la sunset/winback in italiano e la
 * welcome nella sua lingua — la stessa divergenza, dal lato degli script.
 *
 * @param {object} sub campi del documento `newsletter_subscribers`
 * @returns {string} locale a 2 lettere, default 'it'
 */
import { resolveSubscriberLocale } from '../../functions/src/lib/subscriberLocale.js';

export { resolveSubscriberLocale };

export function localeOf(sub) {
  // `lang` e' una quinta grafia, presente solo nei documenti vecchi che questi
  // due script incontrano; non risale al modulo canonico perche' le Functions
  // non la vedono mai. Entra qui nella posizione che aveva: dopo `locale`.
  return resolveSubscriberLocale({ ...sub, locale: sub?.locale || sub?.lang });
}
