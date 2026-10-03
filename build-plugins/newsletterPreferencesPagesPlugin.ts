import fs from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';
import { SLUG_TABLES } from '../services/routeSlugs.data';
import { BASE_URL } from './constants';
import { EMIT_LOCALES } from './shared/localeEmitFilter';
import { buildSeoPageHtml } from './shared/seoPageShell';

const COPY = {
  it: ['Preferenze newsletter', 'Per gestire le tue preferenze, apri il link personale presente nelle email ricevute.'],
  en: ['Newsletter preferences', 'To manage your preferences, open the personal link in the emails you received.'],
  de: ['Newsletter-Einstellungen', 'Um Ihre Einstellungen zu verwalten, öffnen Sie den persönlichen Link in Ihren erhaltenen E-Mails.'],
  fr: ['Préférences newsletter', 'Pour gérer vos préférences, ouvrez le lien personnel figurant dans les emails reçus.'],
} as const;

/** Public bootstrap only: preferences remain behind the existing signed-token API. */
export function newsletterPreferencesPagesPlugin(rootDir: string): Plugin {
  return {
    name: 'newsletter-preferences-pages',
    apply: 'build',
    enforce: 'post',
    closeBundle() {
      const distDir = path.join(rootDir, 'dist');
      for (const locale of EMIT_LOCALES) {
        const route = `${locale === 'it' ? '' : `/${locale}`}/${SLUG_TABLES[locale].newsletterPreferences}/`;
        const [title, description] = COPY[locale];
        const html = buildSeoPageHtml({
          locale, title, description, canonicalUrl: `${BASE_URL}${route}`,
          robots: 'noindex,follow', distDir,
          // React replaces this public explanation with the token-gated UI.
          seoContentOutsideRoot: false,
          bodyHtml: `<main class="max-w-2xl mx-auto px-4 py-8"><h1>${title}</h1><p>${description}</p></main>`,
        });
        const destination = path.join(distDir, route, 'index.html');
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, html);
      }
    },
  };
}
