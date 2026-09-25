/**
 * The Cloud Functions store the registration sentence from their own copy
 * (functions/src/lib/registrationTermsText.js) because they cannot import the
 * TypeScript register. Two earlier copies had stopped at 2026-09-15.1 while
 * the site showed newer wording, so every server-written registration
 * recorded a sentence and version nobody had been shown. This pins the copy
 * to the register, byte for byte and version for version, in every locale.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { CONSENT_LOCALES, CONSENT_TEXTS, consentDisplayText } from '../services/consentTexts';
import {
  REGISTRATION_TERMS_TEXT,
  REGISTRATION_TERMS_VERSION,
  registrationTermsTextFor,
} from '../functions/src/lib/registrationTermsText.js';

describe('functions/src/lib/registrationTermsText.js follows services/consentTexts.ts', () => {
  it('carries the version of the displayed registration formula', () => {
    expect(REGISTRATION_TERMS_VERSION).toBe(CONSENT_TEXTS.communicationsOptIn.version);
  });

  it.each(CONSENT_LOCALES)('stores the sentence the site renders in %s', (locale) => {
    expect(REGISTRATION_TERMS_TEXT[locale]).toBe(consentDisplayText('communicationsOptIn', locale));
    expect(registrationTermsTextFor(`${locale}-CH`)).toBe(consentDisplayText('communicationsOptIn', locale));
  });

  it('is the only copy in the Functions writers', () => {
    const root = resolve(__dirname, '..');
    for (const file of ['functions/src/linkedinAuthCallback.js', 'functions/src/newsletterSubscriptionManagement.js']) {
      const src = readFileSync(resolve(root, file), 'utf8');
      expect(src, `${file} must import the shared copy`).toMatch(/from '\.\/lib\/registrationTermsText\.js'/);
      expect(src, `${file} keeps its own sentence`).not.toMatch(/Registrandomi accetto le condizioni/);
    }
  });
});
