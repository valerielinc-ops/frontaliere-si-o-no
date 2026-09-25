/**
 * registrationTermsText.js — the registration notice as the Cloud Functions
 * store it, in the four locales the site renders it in.
 *
 * Cloud Functions cannot import the TypeScript register
 * (services/consentTexts.ts), so the sentence the browser shows has to be
 * copied here. There used to be two copies, one in linkedinAuthCallback.js and
 * one in newsletterSubscriptionManagement.js, and both had stopped at
 * `2026-09-15.1` while the site moved on: every server-written registration
 * stored a sentence and a version that no visitor had been shown since. One
 * copy, pinned byte for byte to `consentDisplayText('communicationsOptIn', …)`
 * and to that entry's version by tests/registration-terms-text-drift.test.ts,
 * so the next wording change fails the build here instead of drifting.
 */

/** `CONSENT_TEXTS.communicationsOptIn.version` in services/consentTexts.ts. */
export const REGISTRATION_TERMS_VERSION = '2026-09-25.2';

/** `consentDisplayText('communicationsOptIn', locale)`, per locale. */
export const REGISTRATION_TERMS_TEXT = Object.freeze({
  it: 'Registrandomi accetto le condizioni e mi iscrivo alle comunicazioni di Frontaliere Ticino. Condizioni (v. 2026-09-25.2).',
  en: 'By registering I accept the terms and subscribe to Frontaliere Ticino communications. Terms (v. 2026-09-25.2).',
  de: 'Mit der Registrierung akzeptiere ich die Bedingungen und abonniere die Mitteilungen von Frontaliere Ticino. Bedingungen (V. 2026-09-25.2).',
  fr: 'En m’inscrivant, j’accepte les conditions et m’inscris aux communications de Frontaliere Ticino. Conditions (v. 2026-09-25.2).',
});

/** The sentence for a locale, Italian when the locale is not one of the four. */
export function registrationTermsTextFor(locale) {
  const key = String(locale || 'it').slice(0, 2).toLowerCase();
  return REGISTRATION_TERMS_TEXT[key] || REGISTRATION_TERMS_TEXT.it;
}
