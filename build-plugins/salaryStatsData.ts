/**
 * salaryStatsData.ts — routing + path data for the per-canton salary
 * statistics landing family (e.g. IT `/stipendi-zurigo/`, EN
 * `/en/salaries-zurich/`, DE `/de/gehaelter-zurich/`, FR `/fr/salaires-zurich/`).
 *
 * Imported by BOTH services/router.ts (SPA runtime — no `fs`) and the build
 * plugin (Vite config graph — no JSON import at module-eval). So the canton
 * slug table is inlined as pure literals (mirrors data/canton-url-slugs.json;
 * a guard test in tests/salary-stats-landing.test.ts locks the two together).
 */

export type SalaryStatsLocale = 'it' | 'en' | 'de' | 'fr';

export const SALARY_STATS_LOCALES: readonly SalaryStatsLocale[] = ['it', 'en', 'de', 'fr'];

/** Per-locale path prefix for this family. */
export const SALARY_STATS_SECTION: Record<SalaryStatsLocale, string> = {
  it: 'stipendi',
  en: 'salaries',
  de: 'gehaelter',
  fr: 'salaires',
};

export const SALARY_STATS_LOCALE_PREFIX: Record<SalaryStatsLocale, string> = {
  it: '',
  en: '/en',
  de: '/de',
  fr: '/fr',
};

/**
 * URL canton key -> per-locale base slug. Mirrors data/canton-url-slugs.json
 * `cantons` (22 single cantons + the 2 half-canton URL groups APPENZELLO,
 * BASILEA). The `dePrefix` overrides in that file are job-board-specific
 * ("jobs-im-aargau") and do NOT apply here — this family uses its own prefix.
 */
export const SALARY_STATS_CANTON_SLUGS: Record<string, Record<SalaryStatsLocale, string>> = {
  AG: { it: 'argovia', en: 'aargau', de: 'aargau', fr: 'argovie' },
  APPENZELLO: { it: 'appenzello', en: 'appenzell', de: 'appenzell', fr: 'appenzell' },
  BE: { it: 'berna', en: 'bern', de: 'bern', fr: 'berne' },
  BASILEA: { it: 'basilea', en: 'basel', de: 'basel', fr: 'bale' },
  FR: { it: 'friburgo', en: 'fribourg', de: 'freiburg', fr: 'fribourg' },
  GE: { it: 'ginevra', en: 'geneva', de: 'genf', fr: 'geneve' },
  GL: { it: 'glarona', en: 'glarus', de: 'glarus', fr: 'glaris' },
  GR: { it: 'grigioni', en: 'graubunden', de: 'graubunden', fr: 'grisons' },
  JU: { it: 'giura', en: 'jura', de: 'jura', fr: 'jura' },
  LU: { it: 'lucerna', en: 'lucerne', de: 'luzern', fr: 'lucerne' },
  NE: { it: 'neuchatel', en: 'neuchatel', de: 'neuenburg', fr: 'neuchatel' },
  NW: { it: 'nidvaldo', en: 'nidwalden', de: 'nidwalden', fr: 'nidwald' },
  OW: { it: 'obvaldo', en: 'obwalden', de: 'obwalden', fr: 'obwald' },
  SG: { it: 'san-gallo', en: 'st-gallen', de: 'st-gallen', fr: 'saint-gall' },
  SH: { it: 'sciaffusa', en: 'schaffhausen', de: 'schaffhausen', fr: 'schaffhouse' },
  SO: { it: 'soletta', en: 'solothurn', de: 'solothurn', fr: 'soleure' },
  SZ: { it: 'svitto', en: 'schwyz', de: 'schwyz', fr: 'schwytz' },
  TG: { it: 'turgovia', en: 'thurgau', de: 'thurgau', fr: 'thurgovie' },
  TI: { it: 'ticino', en: 'ticino', de: 'tessin', fr: 'tessin' },
  UR: { it: 'uri', en: 'uri', de: 'uri', fr: 'uri' },
  VD: { it: 'vaud', en: 'vaud', de: 'waadt', fr: 'vaud' },
  VS: { it: 'vallese', en: 'valais', de: 'wallis', fr: 'valais' },
  ZG: { it: 'zugo', en: 'zug', de: 'zug', fr: 'zoug' },
  ZH: { it: 'zurigo', en: 'zurich', de: 'zurich', fr: 'zurich' },
};

/**
 * URL canton key -> a real BFS code usable for the salary factor lookup.
 * The half-canton groups collapse to one member; both members share the same
 * Grossregion (AI/AR -> Ostschweiz, BL/BS -> Nordwestschweiz) so the factor is
 * identical either way.
 */
export const SALARY_STATS_FACTOR_CODE: Record<string, string> = {
  APPENZELLO: 'AR',
  BASILEA: 'BS',
};

/** All URL canton keys this family emits, in a stable (sorted) order. */
export const SALARY_STATS_CANTON_KEYS: readonly string[] = Object.freeze(
  Object.keys(SALARY_STATS_CANTON_SLUGS).sort(),
);

/** Build the canonical path for a per-canton salary-stats page. */
export function buildSalaryStatsPath(locale: SalaryStatsLocale, cantonSlug: string): string {
  return `${SALARY_STATS_LOCALE_PREFIX[locale]}/${SALARY_STATS_SECTION[locale]}-${cantonSlug}/`
    .replace(/\/{2,}/g, '/');
}

export interface SalaryStatsPath {
  locale: SalaryStatsLocale;
  cantonKey: string;
  cantonSlug: string;
  path: string;
}

/** Enumerate every canonical path (locale × canton). */
export function listAllSalaryStatsPaths(): SalaryStatsPath[] {
  const out: SalaryStatsPath[] = [];
  for (const locale of SALARY_STATS_LOCALES) {
    for (const cantonKey of SALARY_STATS_CANTON_KEYS) {
      const cantonSlug = SALARY_STATS_CANTON_SLUGS[cantonKey][locale];
      out.push({ locale, cantonKey, cantonSlug, path: buildSalaryStatsPath(locale, cantonSlug) });
    }
  }
  return out;
}

export const SALARY_STATS_ROUTES: readonly string[] = Object.freeze(
  listAllSalaryStatsPaths().map((p) => p.path),
);

const SALARY_STATS_ROUTE_SET: ReadonlySet<string> = new Set(SALARY_STATS_ROUTES);

const SALARY_STATS_PATH_INDEX: ReadonlyMap<string, SalaryStatsPath> = new Map(
  listAllSalaryStatsPaths().map((p) => [p.path, p]),
);

function normalizePath(urlPath: string): string {
  const p = String(urlPath || '').split('?')[0].split('#')[0];
  return p.endsWith('/') ? p : `${p}/`;
}

export function isSalaryStatsPath(urlPath: string): boolean {
  return SALARY_STATS_ROUTE_SET.has(normalizePath(urlPath));
}

export function parseSalaryStatsPath(urlPath: string): SalaryStatsPath | null {
  return SALARY_STATS_PATH_INDEX.get(normalizePath(urlPath)) ?? null;
}
