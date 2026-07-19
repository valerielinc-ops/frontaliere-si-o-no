/**
 * BFS salary-by-age / salary-by-education landings (#4481) — slug tables +
 * path matchers.
 *
 * Two page families (curated set, no floor/threshold loop):
 *   - age:       5 anchor ages (20, 30, 40, 50, 60) × 4 locales = 20 pages
 *   - education: 4 education levels × 4 locales                 = 16 pages
 *   → 36 static HTML pages total.
 *
 * Routes:
 *   Age  IT  /stipendio-medio-svizzera-{age}-anni/
 *        EN  /en/average-salary-switzerland-age-{age}/
 *        DE  /de/durchschnittslohn-schweiz-{age}-jahre/
 *        FR  /fr/salaire-moyen-suisse-{age}-ans/
 *   Edu  IT  /stipendio-svizzera-{levelSlug}/
 *        EN  /en/salary-switzerland-{levelSlug}/
 *        DE  /de/lohn-schweiz-{levelSlug}/
 *        FR  /fr/salaire-suisse-{levelSlug}/
 *
 * Data source: data/seo/bfs-salary-by-age.json (BFS LSE, STAT-TAB) — refreshed
 * by scripts/update-bfs-salary-by-age.mjs.
 */

export const SALARY_LOCALES = ['it', 'en', 'de', 'fr'] as const;
export type SalaryLocale = (typeof SALARY_LOCALES)[number];

/** Anchor ages surfaced as pages. Each maps onto a BFS age band at render. */
export const SALARY_AGE_ANCHORS = [20, 30, 40, 50, 60] as const;
export type SalaryAgeAnchor = (typeof SALARY_AGE_ANCHORS)[number];

/** Education level ids — must match ids in data/seo/bfs-salary-by-age.json. */
export const SALARY_EDUCATION_IDS = [
  'scuola-obbligatoria',
  'apprendistato-afc',
  'formazione-superiore',
  'universita',
] as const;
export type SalaryEducationId = (typeof SALARY_EDUCATION_IDS)[number];

const LOCALE_PREFIX: Record<SalaryLocale, string> = {
  it: '',
  en: '/en',
  de: '/de',
  fr: '/fr',
};

/** Age slug template per locale — `{age}` is filled with the anchor age. */
const AGE_SLUG: Record<SalaryLocale, (age: number) => string> = {
  it: (age) => `stipendio-medio-svizzera-${age}-anni`,
  en: (age) => `average-salary-switzerland-age-${age}`,
  de: (age) => `durchschnittslohn-schweiz-${age}-jahre`,
  fr: (age) => `salaire-moyen-suisse-${age}-ans`,
};

const AGE_ROOT: Record<SalaryLocale, string> = {
  it: 'stipendio-medio-svizzera-',
  en: 'average-salary-switzerland-age-',
  de: 'durchschnittslohn-schweiz-',
  fr: 'salaire-moyen-suisse-',
};

/** Localised education-level slug fragment. */
const EDU_SLUG: Record<SalaryEducationId, Record<SalaryLocale, string>> = {
  'scuola-obbligatoria': {
    it: 'scuola-obbligo',
    en: 'compulsory-school',
    de: 'obligatorische-schule',
    fr: 'scolarite-obligatoire',
  },
  'apprendistato-afc': {
    it: 'apprendistato',
    en: 'apprenticeship',
    de: 'berufslehre',
    fr: 'apprentissage',
  },
  'formazione-superiore': {
    it: 'formazione-superiore',
    en: 'higher-vocational',
    de: 'hoehere-berufsbildung',
    fr: 'formation-superieure',
  },
  universita: {
    it: 'laurea',
    en: 'university-degree',
    de: 'hochschulabschluss',
    fr: 'diplome-universitaire',
  },
};

const EDU_PREFIX: Record<SalaryLocale, string> = {
  it: 'stipendio-svizzera-',
  en: 'salary-switzerland-',
  de: 'lohn-schweiz-',
  fr: 'salaire-suisse-',
};

export function buildSalaryAgeLandingPath(locale: SalaryLocale, age: SalaryAgeAnchor): string {
  return `${LOCALE_PREFIX[locale]}/${AGE_SLUG[locale](age)}/`.replace(/\/+/g, '/');
}

export function buildSalaryEducationLandingPath(
  locale: SalaryLocale,
  eduId: SalaryEducationId,
): string {
  return `${LOCALE_PREFIX[locale]}/${EDU_PREFIX[locale]}${EDU_SLUG[eduId][locale]}/`.replace(
    /\/+/g,
    '/',
  );
}

/** Flat list of all 36 canonical paths. */
export const SALARY_LANDING_ROUTES: readonly string[] = [
  ...SALARY_LOCALES.flatMap((loc) => SALARY_AGE_ANCHORS.map((age) => buildSalaryAgeLandingPath(loc, age))),
  ...SALARY_LOCALES.flatMap((loc) =>
    SALARY_EDUCATION_IDS.map((id) => buildSalaryEducationLandingPath(loc, id)),
  ),
];

export type SalaryLandingParse =
  | { kind: 'age'; locale: SalaryLocale; age: SalaryAgeAnchor }
  | { kind: 'education'; locale: SalaryLocale; eduId: SalaryEducationId };

export function parseSalaryLandingPath(pathname: string): SalaryLandingParse | null {
  const normalized = pathname.endsWith('/') ? pathname : `${pathname}/`;
  for (const locale of SALARY_LOCALES) {
    for (const age of SALARY_AGE_ANCHORS) {
      if (buildSalaryAgeLandingPath(locale, age) === normalized) {
        return { kind: 'age', locale, age };
      }
    }
    for (const eduId of SALARY_EDUCATION_IDS) {
      if (buildSalaryEducationLandingPath(locale, eduId) === normalized) {
        return { kind: 'education', locale, eduId };
      }
    }
  }
  return null;
}

export function isSalaryLandingPath(pathname: string): boolean {
  return parseSalaryLandingPath(pathname) !== null;
}

// Re-export the age-root map for any callsite that needs prefix detection.
export { AGE_ROOT };

// ── Dataset shape (data/seo/bfs-salary-by-age.json) ───────────────────────

export interface BfsAgeBand {
  readonly id: string;
  readonly label: string;
  readonly medianChf: number;
  readonly anchorAges: readonly number[];
}

export interface BfsEducationLevel {
  readonly id: SalaryEducationId;
  readonly medianChf: number;
  readonly name: Record<SalaryLocale, string>;
}

export interface BfsSalaryDataset {
  readonly meta: {
    readonly description: string;
    readonly source: string;
    readonly cubes: Record<string, string>;
    readonly pxwebEndpoint: string;
    readonly waveYear: number;
    readonly currency: string;
    readonly basis: string;
    readonly refreshScript: string;
    readonly refreshCadence: string;
    readonly generatedAt: string;
  };
  readonly nationalMedianChf: number;
  readonly ageBands: readonly BfsAgeBand[];
  readonly educationLevels: readonly BfsEducationLevel[];
}
