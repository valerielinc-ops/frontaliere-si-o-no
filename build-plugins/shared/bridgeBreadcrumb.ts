/**
 * Shared BreadcrumbList JSON-LD builder for bridge plugins.
 *
 * Why this exists
 * ---------------
 * locationHubBridgePlugin, companyHubBridgePlugin and jobOrphanBridgePlugin
 * all emit `index,follow` HTML pages via `buildSeoPageHtml`. The
 * `tests/seo/breadcrumb-coverage.test.ts` (D.2 SEO gate) requires every
 * non-noindex page in `dist/` to carry a `BreadcrumbList` JSON-LD block —
 * before this helper, all three plugins passed `jsonLdScripts: []` and
 * tripped the gate (195 pages flagged in CI run 25688204009).
 *
 * Chain shape (3-level, identical for all bridge pages)
 * ----------------------------------------------------
 *   1. Home              (locale-prefixed root, e.g. `https://…/` or `/fr/`)
 *   2. Section landing   (e.g. `/cerca-lavoro-ticino/`,
 *                              `/fr/trouver-emploi-tessin/`)
 *   3. The bridge page itself (entity name, item = canonical of the leaf)
 */

import type { Locale } from '../../services/i18n';

const HOME_LABEL: Record<Locale, string> = {
  it: 'Home',
  en: 'Home',
  de: 'Startseite',
  fr: 'Accueil',
};

const LOCALE_PREFIX: Record<Locale, string> = {
  it: '',
  en: '/en',
  de: '/de',
  fr: '/fr',
};

interface BridgeBreadcrumbInput {
  readonly locale: Locale;
  readonly baseUrl: string;
  /** Section label shown as the 2nd crumb (e.g. "Lavoro in Ticino"). */
  readonly sectionLabel: string;
  /** Section URL path with leading slash and trailing slash. */
  readonly sectionPath: string;
  /** Leaf-page label shown as the 3rd crumb (e.g. city or company name). */
  readonly pageLabel: string;
  /** Canonical absolute URL of the bridge page itself. */
  readonly canonicalUrl: string;
}

/**
 * Build a 3-level BreadcrumbList JSON-LD string ready to drop into
 * `jsonLdScripts` of `buildSeoPageHtml`.
 */
export function buildBridgeBreadcrumbLd(opts: BridgeBreadcrumbInput): string {
  const homeUrl = `${opts.baseUrl}${LOCALE_PREFIX[opts.locale]}/`.replace(/(?<!:)\/+/g, '/');
  const sectionUrl = `${opts.baseUrl}${opts.sectionPath}`.replace(/(?<!:)\/+/g, '/');
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: HOME_LABEL[opts.locale], item: homeUrl },
      { '@type': 'ListItem', position: 2, name: opts.sectionLabel, item: sectionUrl },
      { '@type': 'ListItem', position: 3, name: opts.pageLabel, item: opts.canonicalUrl },
    ],
  });
}

/** Locale-aware label for the cross-border jobs section landing. */
export const JOBS_SECTION_LABEL: Record<Locale, string> = {
  it: 'Lavoro in Ticino',
  en: 'Jobs in Ticino',
  de: 'Stellen im Tessin',
  fr: 'Emplois au Tessin',
};
