/**
 * Swiss minimum-wage landings (#4479, epic #4478) — slug tables + path matchers.
 *
 * A curated hub + per-canton pages + a CCL page. 7 page types × 4 locales =
 * 28 static HTML pages:
 *
 *   hub   — /salario-minimo/                  (overview + comparison table)
 *   ccl   — /salario-minimo/contratti-collettivi/  (main sector CCL minimums)
 *   ge/bs/ju/ne/ti — /salario-minimo/{canton}/     (one per canton with a law)
 *
 * Routes (IT canonical; EN/DE/FR prefixed, localised slugs):
 *   IT  /salario-minimo/            · /salario-minimo/ticino/     · …/contratti-collettivi/
 *   EN  /en/minimum-wage/          · /en/minimum-wage/ticino/     · …/collective-agreements/
 *   DE  /de/mindestlohn/           · /de/mindestlohn/tessin/      · …/gesamtarbeitsvertraege/
 *   FR  /fr/salaire-minimum/       · /fr/salaire-minimum/tessin/  · …/conventions-collectives/
 *
 * Router consumes {@link MINWAGE_LANDING_ROUTES} + {@link parseMinWageLandingPath}
 * for `staticOverlay: true` matching (same pattern as holidaysLandingsData). The
 * page set is fixed and curated — no floor/threshold loop, so no below-floor
 * bridge / searchConsoleCompat self-map is required.
 */

export const MINWAGE_LOCALES = ['it', 'en', 'de', 'fr'] as const;
export type MinWageLocale = (typeof MINWAGE_LOCALES)[number];

/** Cantons with a statutory (legal) minimum wage. */
export const CANTON_IDS = ['ge', 'bs', 'ju', 'ne', 'ti'] as const;
export type CantonId = (typeof CANTON_IDS)[number];

export type MinWagePage =
  | { readonly kind: 'hub' }
  | { readonly kind: 'ccl' }
  | { readonly kind: 'canton'; readonly canton: CantonId };

const LOCALE_PREFIX: Record<MinWageLocale, string> = {
  it: '',
  en: '/en',
  de: '/de',
  fr: '/fr',
};

/** Hub base slug (no leading/trailing slash) per locale. */
const HUB_SLUG: Record<MinWageLocale, string> = {
  it: 'salario-minimo',
  en: 'minimum-wage',
  de: 'mindestlohn',
  fr: 'salaire-minimum',
};

/** CCL sub-page slug per locale. */
const CCL_SLUG: Record<MinWageLocale, string> = {
  it: 'contratti-collettivi',
  en: 'collective-agreements',
  de: 'gesamtarbeitsvertraege',
  fr: 'conventions-collectives',
};

/** Localised canton slug per canton × locale. */
const CANTON_SLUG: Record<CantonId, Record<MinWageLocale, string>> = {
  ge: { it: 'ginevra', en: 'geneva', de: 'genf', fr: 'geneve' },
  bs: { it: 'basilea-citta', en: 'basel-city', de: 'basel-stadt', fr: 'bale-ville' },
  ju: { it: 'giura', en: 'jura', de: 'jura', fr: 'jura' },
  ne: { it: 'neuchatel', en: 'neuchatel', de: 'neuenburg', fr: 'neuchatel' },
  ti: { it: 'ticino', en: 'ticino', de: 'tessin', fr: 'tessin' },
};

function hubBase(locale: MinWageLocale): string {
  return `${LOCALE_PREFIX[locale]}/${HUB_SLUG[locale]}`.replace(/\/+/g, '/');
}

export function buildMinWageLandingPath(locale: MinWageLocale, page: MinWagePage): string {
  const base = hubBase(locale);
  if (page.kind === 'hub') return `${base}/`;
  if (page.kind === 'ccl') return `${base}/${CCL_SLUG[locale]}/`;
  return `${base}/${CANTON_SLUG[page.canton][locale]}/`;
}

/** All page descriptors (order: hub, cantons, ccl). */
export const MINWAGE_PAGES: readonly MinWagePage[] = [
  { kind: 'hub' },
  ...CANTON_IDS.map((canton): MinWagePage => ({ kind: 'canton', canton })),
  { kind: 'ccl' },
];

/** Flat list of all 28 canonical paths (4 locales × 7 page types). */
export const MINWAGE_LANDING_ROUTES: readonly string[] = MINWAGE_LOCALES.flatMap((loc) =>
  MINWAGE_PAGES.map((page) => buildMinWageLandingPath(loc, page)),
);

export function parseMinWageLandingPath(
  pathname: string,
): { locale: MinWageLocale; page: MinWagePage } | null {
  const normalized = pathname.endsWith('/') ? pathname : `${pathname}/`;
  for (const locale of MINWAGE_LOCALES) {
    for (const page of MINWAGE_PAGES) {
      if (buildMinWageLandingPath(locale, page) === normalized) {
        return { locale, page };
      }
    }
  }
  return null;
}

export function isMinWageLandingPath(pathname: string): boolean {
  return parseMinWageLandingPath(pathname) !== null;
}

// ── Dataset shape (data/seo/swiss-minimum-wage.json) ──────────────────────

export type CclUnit = 'month' | 'hour';

export interface CantonMinWage {
  readonly id: CantonId;
  readonly code: string;
  readonly name: Record<MinWageLocale, string>;
  readonly hourlyMin: number;
  readonly hourlyMax: number;
  readonly monthlyMin: number;
  readonly monthlyMax: number;
  readonly since: number;
  readonly year: number;
  readonly law: Record<MinWageLocale, string>;
  readonly source: string;
  readonly sourceUrl: string;
  readonly note: Record<MinWageLocale, string>;
}

export interface CclMinWage {
  readonly id: string;
  readonly sector: Record<MinWageLocale, string>;
  readonly cclName: string;
  readonly scope: Record<MinWageLocale, string>;
  readonly rows: ReadonlyArray<{
    readonly label: Record<MinWageLocale, string>;
    readonly amount: string;
    readonly unit: CclUnit;
  }>;
  readonly source: string;
  readonly sourceUrl: string;
  readonly note: Record<MinWageLocale, string>;
}

export interface MinWageDataset {
  readonly meta: {
    readonly description: string;
    readonly source: string;
    readonly refreshScript: string;
    readonly refreshCadence: string;
    readonly year: number;
    readonly monthlyFactor: number;
    readonly generatedAt: string;
  };
  readonly cantons: readonly CantonMinWage[];
  readonly ccls: readonly CclMinWage[];
}
