import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { PUBLIC_CONTACT_EMAIL } from '../services/publicContact';

const ROOT = resolve(import.meta.dirname, '..');
const PERSONAL_ADDRESSES = ['valerie@frontaliereticino.ch', 'valerie@frontaliere.ch', 'valerielinc@gmail.com'];
const PUBLIC_SOURCES = [
  'App.tsx',
  'build-plugins/staticPagesPlugin.ts',
  'components/pages/AdminPanel.tsx',
  'components/pages/ContactPage.tsx',
  'components/pages/NewsletterPreferences.tsx',
  'components/pages/PrivacyPolicy.tsx',
  'components/pages/TermsOfService.tsx',
  'services/locales/de-core.ts',
  'services/locales/en-core.ts',
  'services/locales/fr-core.ts',
  'services/locales/it-core.ts',
  'services/adminIdentity.ts',
  'services/newsletter-template.mjs',
  'services/weather/metNoFetcher.ts',
  'functions/src/coldEmailSequence.js',
  'functions/src/lib/dataControllerIdentity.js',
  'hooks/useUserState.ts',
];

describe('public contact mailbox', () => {
  it.each(PUBLIC_SOURCES)('$s does not bundle a personal contact address', (relativePath) => {
    const source = readFileSync(resolve(ROOT, relativePath), 'utf8').toLowerCase();
    for (const address of PERSONAL_ADDRESSES) {
      expect(source, `${relativePath} still exposes ${address}`).not.toContain(address);
    }
  });

  it('uses the shared public mailbox as the replacement', () => {
    expect(PUBLIC_CONTACT_EMAIL).toBe('redazione@frontaliereticino.ch');
  });
});
