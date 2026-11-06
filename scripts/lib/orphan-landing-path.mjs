/**
 * Canonical URL contract for GSC orphan-query landings.
 *
 * The build plugin and the CI outcome exporter must join the same emitted
 * routes. Keeping the locale sections here prevents a bare `/<slug>/` from
 * silently becoming a different analytics cohort.
 */

export const ORPHAN_LANDING_LOCALES = Object.freeze(['it', 'en', 'de', 'fr']);

export const ORPHAN_LANDING_SECTION = Object.freeze({
  it: 'ricerca',
  en: 'search',
  de: 'suche',
  fr: 'recherche',
});

export const ORPHAN_LANDING_LOCALE_PREFIX = Object.freeze({
  it: '',
  en: '/en',
  de: '/de',
  fr: '/fr',
});

/** Build the canonical trailing-slash route emitted by orphanQueryLandingPlugin. */
export function buildOrphanLandingPath(locale, slug) {
  if (!Object.prototype.hasOwnProperty.call(ORPHAN_LANDING_SECTION, locale)) {
    throw new Error(`unsupported orphan landing locale: ${locale}`);
  }
  const normalizedSlug = String(slug ?? '').trim().replace(/^\/+|\/+$/gu, '');
  if (!normalizedSlug || normalizedSlug.includes('/')) {
    throw new Error('orphan landing slug is empty or contains a path separator');
  }
  return `${ORPHAN_LANDING_LOCALE_PREFIX[locale]}/${ORPHAN_LANDING_SECTION[locale]}/${normalizedSlug}/`
    .replace(/\/+/gu, '/');
}
