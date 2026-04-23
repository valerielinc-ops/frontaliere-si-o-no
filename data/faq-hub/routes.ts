/**
 * FAQ hub — router-safe slug + path helpers.
 *
 * This file deliberately does NOT import the 10 category data files
 * (~340KB of TS source → ~200KB bloat in the SPA bundle). The router
 * only needs the canonical paths to recognise FAQ hub URLs; the full
 * `ALL_FAQ_HUB` aggregate is plugin-only (build-time).
 */

import type { FaqHubLocale } from './types';
import { FAQ_HUB_LOCALES } from './types';

export const FAQ_HUB_LOCALE_PREFIX: Record<FaqHubLocale, string> = {
  it: '',
  en: '/en',
  de: '/de',
  fr: '/fr',
};

export const FAQ_HUB_SLUG: Record<FaqHubLocale, string> = {
  it: 'domande-frequenti-frontalieri',
  en: 'frequently-asked-questions',
  de: 'haeufige-fragen',
  fr: 'questions-frequentes',
};

export function buildFaqHubPath(locale: FaqHubLocale): string {
  const prefix = FAQ_HUB_LOCALE_PREFIX[locale];
  const slug = FAQ_HUB_SLUG[locale];
  return `${prefix}/${slug}/`.replace(/\/+/g, '/');
}

export const FAQ_HUB_ROUTES: ReadonlyArray<string> = FAQ_HUB_LOCALES.map((loc) =>
  buildFaqHubPath(loc),
);

export function parseFaqHubPath(pathname: string): { locale: FaqHubLocale } | null {
  const normalized = pathname.endsWith('/') ? pathname : `${pathname}/`;
  for (const locale of FAQ_HUB_LOCALES) {
    if (buildFaqHubPath(locale) === normalized) return { locale };
  }
  return null;
}

export function isFaqHubPath(pathname: string): boolean {
  return parseFaqHubPath(pathname) !== null;
}
