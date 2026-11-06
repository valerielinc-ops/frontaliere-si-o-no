/**
 * Career quick-win SEO landings — slug tables + path matchers (AE-2).
 *
 * Four quick-win keywords from `data/seo/semrush-organic-raw.csv` targeted
 * by this plugin:
 *
 *   LANDING_ID                  Target keyword cluster (IT, Semrush DB)
 *   agenzie-lavoro-lugano       "agenzie del lavoro lugano" (720/mo, KD 18)
 *   concorsi-pubblici-lugano    "concorsi lugano" (720/mo, KD 15)
 *   stage-lugano                "stage lugano" (260/mo, KD 16)
 *   contratti-lavoro-frontalieri "contratto nazionale frontalieri" (390/mo)
 *
 * All canonical IT paths sit at the root (no `/guida/`, no `/lavoro/`
 * prefix) to mirror the nursing landings convention and maximise
 * ranking weight. Locale variants get the usual `/en/`, `/de/`, `/fr/`.
 *
 * The router consumes {@link CAREER_LANDING_ROUTES} and
 * {@link parseCareerLandingPath} to resolve these URLs to a `staticOverlay`
 * SPA route — the build plugin renders static HTML outside `#root` via
 * `seoContentOutsideRoot: true` so the SPA doesn't replace it on hydrate.
 */

export const CAREER_LOCALES = ['it', 'en', 'de', 'fr'] as const;
export type CareerLocale = (typeof CAREER_LOCALES)[number];

export const CAREER_LANDING_IDS = [
  'agenzie-lavoro-lugano',
  'concorsi-pubblici-lugano',
  'stage-lugano',
  'contratti-lavoro-frontalieri',
] as const;
export type CareerLandingId = (typeof CAREER_LANDING_IDS)[number];

export const CAREER_LOCALE_PREFIX: Record<CareerLocale, string> = {
  it: '',
  en: '/en',
  de: '/de',
  fr: '/fr',
};

/**
 * Per-locale slug for each landing. Italian is canonical (no prefix) and
 * reflects the user's actual search query. EN/DE/FR slugs preserve the
 * cross-border work theme in the target language.
 */
export const CAREER_LANDING_SLUGS: Record<
  CareerLocale,
  Record<CareerLandingId, string>
> = {
  it: {
    'agenzie-lavoro-lugano': 'agenzie-del-lavoro-lugano',
    'concorsi-pubblici-lugano': 'concorsi-pubblici-lugano',
    'stage-lugano': 'stage-lugano',
    'contratti-lavoro-frontalieri': 'contratti-lavoro-frontalieri',
  },
  en: {
    'agenzie-lavoro-lugano': 'staffing-agencies-lugano',
    'concorsi-pubblici-lugano': 'public-sector-jobs-lugano',
    'stage-lugano': 'internships-lugano',
    'contratti-lavoro-frontalieri': 'cross-border-work-contracts',
  },
  de: {
    'agenzie-lavoro-lugano': 'personalvermittlung-lugano',
    'concorsi-pubblici-lugano': 'oeffentliche-stellen-lugano',
    'stage-lugano': 'praktikum-lugano',
    'contratti-lavoro-frontalieri': 'grenzgaenger-arbeitsvertraege',
  },
  fr: {
    'agenzie-lavoro-lugano': 'agences-interim-lugano',
    'concorsi-pubblici-lugano': 'concours-publics-lugano',
    'stage-lugano': 'stages-lugano',
    'contratti-lavoro-frontalieri': 'contrats-travail-frontaliers',
  },
};

export function buildCareerLandingPath(
  locale: CareerLocale,
  id: CareerLandingId,
): string {
  const prefix = CAREER_LOCALE_PREFIX[locale];
  const slug = CAREER_LANDING_SLUGS[locale][id];
  return `${prefix}/${slug}/`.replace(/\/+/g, '/');
}

/**
 * Flat list of every canonical path (4 locales × 4 ids = 16 URLs). Used
 * by the router to fast-match static-overlay routes without walking the
 * slug table.
 */
export const CAREER_LANDING_ROUTES: readonly string[] = CAREER_LOCALES.flatMap(
  (loc) => CAREER_LANDING_IDS.map((id) => buildCareerLandingPath(loc, id)),
);

/**
 * Resolve a pathname to a career landing match or return `null`. Accepts
 * paths with or without trailing slash — always normalises to trailing-
 * slash form before lookup.
 */
export function parseCareerLandingPath(
  pathname: string,
): { locale: CareerLocale; id: CareerLandingId } | null {
  const normalized = pathname.endsWith('/') ? pathname : `${pathname}/`;
  for (const locale of CAREER_LOCALES) {
    for (const id of CAREER_LANDING_IDS) {
      if (buildCareerLandingPath(locale, id) === normalized)
        return { locale, id };
    }
  }
  return null;
}

export function isCareerLandingPath(pathname: string): boolean {
  return parseCareerLandingPath(pathname) !== null;
}
