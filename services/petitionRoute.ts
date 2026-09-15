import type { Locale } from './i18n';

/**
 * Public, locale-aware URLs for the Stabio-Gaggiolo speed-bump petition.
 * Keeping the paths in one small module prevents the router, CTA links and
 * static-page tooling from quietly growing different spellings.
 */
export const STABIO_DOSSO_PETITION_PATHS: Record<Locale, string> = {
  it: '/petizione-dosso-stabio/',
  en: '/en/stabio-speed-bump-petition/',
  de: '/de/petition-geschwindigkeitsrampe-stabio/',
  fr: '/fr/petition-dos-d-ane-stabio/',
};

export function buildStabioDossoPetitionPath(locale: Locale): string {
  return STABIO_DOSSO_PETITION_PATHS[locale];
}
