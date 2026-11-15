import { SLUG_TABLES } from './routeSlugs.data';

export const READER_SUBSCRIPTION_LOCALES = ['it', 'en', 'de', 'fr'] as const;
export type ReaderSubscriptionLocale = (typeof READER_SUBSCRIPTION_LOCALES)[number];

/** Canonical locale routes shared by house creatives and the static SPA shells. */
export const READER_SUBSCRIPTION_PATHS: Readonly<Record<ReaderSubscriptionLocale, string>> = Object.freeze({
  it: `/${SLUG_TABLES.it.subscribe}/`,
  en: `/en/${SLUG_TABLES.en.subscribe}/`,
  de: `/de/${SLUG_TABLES.de.subscribe}/`,
  fr: `/fr/${SLUG_TABLES.fr.subscribe}/`,
});
