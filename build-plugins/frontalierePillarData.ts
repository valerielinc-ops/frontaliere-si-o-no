/**
 * Pillar hub "frontaliere" (#3393) — slug tables + path matchers.
 *
 * One orchestration page × 4 locales. Targets the site's largest single
 * GSC query ("frontaliere": 14.593 impressions/30d, avg pos 7.7, CTR 0.6%
 * at plan time) by consolidating the topic cluster: permits, salary,
 * taxes, health insurance, per-profession job landings, border life.
 *
 * The pillar ORCHESTRATES — every section links to the existing deep
 * pages (guida articles, calculator, tax sim, health premiums, profession
 * landings). It never duplicates their content, so it can't cannibalise
 * `/guida-frontaliere/` children.
 *
 * Router consumes {@link FRONTALIERE_PILLAR_ROUTES} and
 * {@link parseFrontalierePillarPath} to resolve the URLs as `staticOverlay`
 * routes (same contract as career/nursing/profession landings).
 */

export const FRONTALIERE_PILLAR_LOCALES = ['it', 'en', 'de', 'fr'] as const;
export type FrontalierePillarLocale = (typeof FRONTALIERE_PILLAR_LOCALES)[number];

export const FRONTALIERE_PILLAR_LOCALE_PREFIX: Record<FrontalierePillarLocale, string> = {
  it: '',
  en: '/en',
  de: '/de',
  fr: '/fr',
};

/**
 * Per-locale slug. IT canonical at the root (`/frontaliere/` — the exact
 * mother keyword). EN/DE/FR pick the locale-natural keyword.
 */
export const FRONTALIERE_PILLAR_SLUGS: Record<FrontalierePillarLocale, string> = {
  it: 'frontaliere',
  en: 'cross-border-worker',
  de: 'grenzgaenger',
  fr: 'frontalier',
};

export function buildFrontalierePillarPath(locale: FrontalierePillarLocale): string {
  const prefix = FRONTALIERE_PILLAR_LOCALE_PREFIX[locale];
  return `${prefix}/${FRONTALIERE_PILLAR_SLUGS[locale]}/`.replace(/\/+/g, '/');
}

/** Flat list of canonical routes (4 URLs). */
export const FRONTALIERE_PILLAR_ROUTES: readonly string[] = FRONTALIERE_PILLAR_LOCALES.map(
  (loc) => buildFrontalierePillarPath(loc),
);

/**
 * Resolve a pathname to the pillar. Trailing-slash tolerant, mirrors
 * parseNursingLandingPath.
 */
export function parseFrontalierePillarPath(
  pathname: string,
): { locale: FrontalierePillarLocale } | null {
  const normalized = pathname.endsWith('/') ? pathname : `${pathname}/`;
  for (const locale of FRONTALIERE_PILLAR_LOCALES) {
    if (buildFrontalierePillarPath(locale) === normalized) return { locale };
  }
  return null;
}

export function isFrontalierePillarPath(pathname: string): boolean {
  return parseFrontalierePillarPath(pathname) !== null;
}
