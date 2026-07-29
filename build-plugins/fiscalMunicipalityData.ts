/**
 * Shared data + path logic for the per-municipality FISCAL guide pages
 * ("tasse frontaliere residente a {comune}: vecchio vs nuovo regime",
 * epic #4482 / sub #4484).
 *
 * Single source of truth for:
 *   - the committed dataset (data/fiscal-municipalities.json, built by
 *     scripts/build-fiscal-municipalities.mjs),
 *   - the per-locale URL for a comune (trailing-slash, 4 locales),
 *   - `isFiscalMunicipalityPath()` — the O(1) membership check the Search
 *     Console 404 compat layer uses to self-map this family (build-plugins/
 *     searchConsoleCompat.ts). Both the above-floor page and the below-floor
 *     noindex bridge are emitted at the SAME URL, so every enumerated comune
 *     path (above OR below floor, any locale) self-maps.
 *
 * Kept in ONE module so the plugin (renderer) and the compat layer never drift
 * on the path shape or the slug set.
 */

import fiscalDataset from '../data/fiscal-municipalities.json';

export type FiscalLocale = 'it' | 'en' | 'de' | 'fr';
export const FISCAL_LOCALES: readonly FiscalLocale[] = ['it', 'en', 'de', 'fr'] as const;

export interface FiscalMunicipality {
  name: string;
  slug: string;
  province: string;
  irpefAddizionale: number;
  distanceKm: number;
  population: number;
  avgRentMonthly: number;
  lat: number;
  lng: number;
  /** Set only when irpefAddizionale is a derived/effective rate needing
   *  context (progressive bracket schedule, or no tax instituted). */
  note?: string;
  /** Machine-readable discriminant for `note` — drives the locale-native
   *  FAQ disclosure clause instead of splicing the Italian `note` text. */
  noteType?: 'progressive' | 'noTax';
}

interface FiscalDatasetShape {
  source: string;
  year: number;
  floor: Record<string, unknown>;
  profile: {
    annualIncomeCHF: number;
    maritalStatus: 'SINGLE' | 'MARRIED';
    children: number;
    distanceZone: 'WITHIN_20KM' | 'OVER_20KM';
  };
  aboveFloor: FiscalMunicipality[];
  belowFloor: FiscalMunicipality[];
}

const DATASET = fiscalDataset as FiscalDatasetShape;

export const FISCAL_SOURCE = DATASET.source;
export const FISCAL_YEAR = DATASET.year;
export const FISCAL_PROFILE = DATASET.profile;
export const FISCAL_ABOVE_FLOOR: readonly FiscalMunicipality[] = DATASET.aboveFloor;
export const FISCAL_BELOW_FLOOR: readonly FiscalMunicipality[] = DATASET.belowFloor;

/** Per-locale base path (NO trailing municipality slug, NO trailing slash). */
export const FISCAL_BASE_PATH: Record<FiscalLocale, string> = {
  it: '/tasse-frontalieri-comune',
  en: '/en/cross-border-tax-municipality',
  de: '/de/grenzgaenger-steuern-gemeinde',
  fr: '/fr/impots-frontaliers-commune',
};

/** Canonical hub path per locale (index of the fiscal-guide family). */
export const FISCAL_HUB_PATH: Record<FiscalLocale, string> = {
  it: `${FISCAL_BASE_PATH.it}/`,
  en: `${FISCAL_BASE_PATH.en}/`,
  de: `${FISCAL_BASE_PATH.de}/`,
  fr: `${FISCAL_BASE_PATH.fr}/`,
};

/** Trailing-slash URL for a comune's fiscal page in a locale. */
export function fiscalPathFor(locale: FiscalLocale, slug: string): string {
  return `${FISCAL_BASE_PATH[locale]}/${slug}/`;
}

function normalizePath(input: string): string {
  const p = (input || '').split('?')[0].split('#')[0];
  return p.endsWith('/') ? p : `${p}/`;
}

/**
 * Precomputed Set of every emitted fiscal comune path (above + below floor ×
 * 4 locales), built ONCE at module load. Keeps `isFiscalMunicipalityPath` O(1)
 * inside the 150k+-path loop of tests/search-console-compat.test.ts — same
 * rationale as the other self-mappable families in searchConsoleCompat.ts.
 */
const FISCAL_PATH_SET: ReadonlySet<string> = (() => {
  const set = new Set<string>();
  for (const m of [...FISCAL_ABOVE_FLOOR, ...FISCAL_BELOW_FLOOR]) {
    for (const locale of FISCAL_LOCALES) set.add(fiscalPathFor(locale, m.slug));
  }
  return set;
})();

/** True for any emitted fiscal-guide comune URL (above-floor page OR below-floor
 *  bridge, any locale). Used by the Search Console 404 compat self-map. */
export function isFiscalMunicipalityPath(inputPath: string): boolean {
  return FISCAL_PATH_SET.has(normalizePath(inputPath));
}

/**
 * Reverse index (path → locale + slug) for the per-comune detail/bridge pages,
 * used by services/router.ts to recognise the URL at hydration time and
 * recover the locale without re-parsing the path shape. Same membership as
 * FISCAL_PATH_SET/isFiscalMunicipalityPath above (above + below floor).
 */
const FISCAL_DETAIL_INDEX: ReadonlyMap<string, { locale: FiscalLocale; slug: string }> = (() => {
  const map = new Map<string, { locale: FiscalLocale; slug: string }>();
  for (const m of [...FISCAL_ABOVE_FLOOR, ...FISCAL_BELOW_FLOOR]) {
    for (const locale of FISCAL_LOCALES) {
      map.set(normalizePath(fiscalPathFor(locale, m.slug)), { locale, slug: m.slug });
    }
  }
  return map;
})();

export function parseFiscalMunicipalityPath(inputPath: string): { locale: FiscalLocale; slug: string } | null {
  return FISCAL_DETAIL_INDEX.get(normalizePath(inputPath)) ?? null;
}

/** Reverse index (path → locale) for the hub/index page, one per locale. */
const FISCAL_HUB_INDEX: ReadonlyMap<string, FiscalLocale> = new Map(
  FISCAL_LOCALES.map((l) => [normalizePath(FISCAL_HUB_PATH[l]), l]),
);

export function isFiscalHubPath(inputPath: string): boolean {
  return FISCAL_HUB_INDEX.has(normalizePath(inputPath));
}

export function parseFiscalHubPath(inputPath: string): { locale: FiscalLocale } | null {
  const found = FISCAL_HUB_INDEX.get(normalizePath(inputPath));
  return found ? { locale: found } : null;
}
