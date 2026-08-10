/**
 * Per-locale hrefs for the pillar/guide pages that the shallow SEO rails link.
 *
 * Why this module exists (#5428)
 * ------------------------------
 * These paths were hand-copied as literal `Record<Locale, string>` tables into
 * four places — `staticPagesPlugin`'s `ORPHAN_PILLAR_LINKS`,
 * `holidaysLandingsPlugin`/`minimumWageLandingsPlugin`'s `PERMITS_GUIDE_URL`,
 * and `companyHubFrontalierContext`'s `fiscalGuideUrl`. That is precisely the
 * drift `services/routeSlugs.data.ts` was centralised to stop (#4315): the
 * EN and DE copies had fallen behind the slug table and were pointing at URLs
 * the build does not emit.
 *
 * Measured against production on 2026-08-10 (`curl` on frontaliereticino.ch,
 * status + `<meta name="robots">`), the four copies shipped:
 *
 *   /en/cross-border-worker-guide/                                → 404
 *   /en/cross-border-worker-guide/complete-cross-border-work-…/   → 404
 *   /en/cross-border-worker-guide/lamal-cross-border-workers/     → 404
 *   /en/guide-cross-border-taxation-2026/                         → 404
 *   /de/leitfaden-grenzgaenger-besteuerung-2026/                  → 404
 *   /de/grenzgaenger-leitfaden/…                                  → 200 noindex,follow
 *
 * The `noindex` half matters as much as the 404s: the BFS-depth gate walks the
 * emitted HTML and `scripts/audit-bfs-depth.mjs` does `continue` on ANY
 * `noindex` page, so a rail pill pointing at a `searchConsoleCompat` catch-all
 * carries zero crawl depth — it looks like a link and behaves like a wall.
 * `/de/grenzgaenger-leitfaden/*` is exactly that: a compat catch-all whose
 * canonical is the section root, while the real, `index,follow` guide lives at
 * `/de/grenzgaenger-ratgeber/*` — the slug `SLUG_TABLES.de.guida` already held.
 *
 * Deriving the section segment from `SLUG_TABLES` makes the whole class of
 * failure — "the rail links a section slug that no page is emitted under" —
 * structurally impossible, the same way `buildFaqHubPath()` made the DE FAQ
 * 404 impossible in #5509.
 *
 * Leaf module by design: it imports only `routeSlugs.data` (pure data, one
 * type-only import) so it can never take part in a plugin import cycle — see
 * the cycle post-mortem in `shared/calcHref.ts`.
 */

import { SLUG_TABLES, type SlugTable } from '../../services/routeSlugs.data';
import type { Locale } from '../../services/i18n';

export type PillarGuideLocale = Locale;

export const PILLAR_GUIDE_LOCALES: readonly PillarGuideLocale[] = ['it', 'en', 'de', 'fr'];

/** Italian is the default locale and carries no path prefix. */
export const PILLAR_LOCALE_PREFIX: Record<PillarGuideLocale, string> = {
  it: '',
  en: '/en',
  de: '/de',
  fr: '/fr',
};

/** `/`-terminated absolute path for a top-level section of `SLUG_TABLES`. */
export function sectionHref(locale: PillarGuideLocale, key: keyof SlugTable): string {
  return `${PILLAR_LOCALE_PREFIX[locale]}/${SLUG_TABLES[locale][key]}/`;
}

/** `/`-terminated absolute path for a page nested under a `SLUG_TABLES` section. */
export function subPageHref(
  locale: PillarGuideLocale,
  section: keyof SlugTable,
  leaf: keyof SlugTable,
): string {
  return `${PILLAR_LOCALE_PREFIX[locale]}/${SLUG_TABLES[locale][section]}/${SLUG_TABLES[locale][leaf]}/`;
}

function byLocale(build: (locale: PillarGuideLocale) => string): Record<PillarGuideLocale, string> {
  return {
    it: build('it'),
    en: build('en'),
    de: build('de'),
    fr: build('fr'),
  };
}

/**
 * The cross-border guide section root — `/guida-frontaliere/`,
 * `/en/cross-border-guide/`, `/de/grenzgaenger-ratgeber/`,
 * `/fr/guide-frontalier/`.
 */
export const GUIDE_HUB_HREF: Record<PillarGuideLocale, string> = byLocale(
  (locale) => sectionHref(locale, 'guida'),
);

/** The "complete cross-border work guide 2026" pillar under the guide section. */
export const COMPLETE_WORK_GUIDE_HREF: Record<PillarGuideLocale, string> = byLocale(
  (locale) => subPageHref(locale, 'guida', 'guidaCompleta'),
);

/** The standalone taxation pillar hub (`tassazioneHub`, not nested). */
export const TAXATION_HUB_HREF: Record<PillarGuideLocale, string> = byLocale(
  (locale) => sectionHref(locale, 'tassazioneHub'),
);

/** Withholding-tax rates page under the fisco section. */
export const WITHHOLDING_RATES_HREF: Record<PillarGuideLocale, string> = byLocale(
  (locale) => subPageHref(locale, 'fisco', 'withholdingRates'),
);

/** New-cross-border-worker tax simulation under the fisco section. */
export const NEW_FRONTIER_TAX_SIM_HREF: Record<PillarGuideLocale, string> = byLocale(
  (locale) => subPageHref(locale, 'fisco', 'newFrontierTaxSim'),
);

/**
 * LAMal / health-insurance pillar leaf slugs.
 *
 * These four have no `SLUG_TABLES` key — the pillar is emitted by the guide
 * section's own page set, not by the router — so the leaf stays a literal.
 * The SECTION still comes from `SLUG_TABLES`, which is where all three broken
 * copies actually went wrong, and the values below are the site's own
 * `hreflang` alternates of `/guida-frontaliere/lamal-frontalieri/` (read from
 * production 2026-08-10), not a translation guess.
 */
const LAMAL_PILLAR_LEAF: Record<PillarGuideLocale, string> = {
  it: 'lamal-frontalieri',
  en: 'lamal-for-cross-border-workers',
  de: 'krankenversicherung-grenzgaenger',
  fr: 'lamal-frontaliers',
};

export const LAMAL_PILLAR_HREF: Record<PillarGuideLocale, string> = byLocale(
  (locale) => `${sectionHref(locale, 'guida')}${LAMAL_PILLAR_LEAF[locale]}/`,
);
