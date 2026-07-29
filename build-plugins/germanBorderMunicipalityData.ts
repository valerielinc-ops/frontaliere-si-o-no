/**
 * Shared data + path logic for the per-municipality GERMANY border pages
 * ("vivere a {Gemeinde} e lavorare in Svizzera", issue #4882 — Baden-
 * Württemberg corridor: Landkreise Lörrach/Waldshut/Konstanz/Schwarzwald-
 * Baar-Kreis, second of the FR/DE/LI rollout after France #4545/#4878).
 *
 * Single source of truth for:
 *   - the committed dataset (data/german-border-municipalities.json, built by
 *     scripts/build-german-border-municipalities.mjs from
 *     data/germanBorderMunicipalities.ts),
 *   - the sourced Art. 15a Grenzgänger regime facts (GERMAN_REGIME_TAX —
 *     UNIFORM across every municipality, unlike the French per-canton split:
 *     see data/germanBorderMunicipalities.ts's "REGIME" header note),
 *   - the per-locale URL for a Gemeinde (trailing-slash, 4 locales),
 *   - `isGermanBorderMunicipalityPath()` — the O(1) membership check the
 *     Search Console 404 compat layer uses to self-map this family
 *     (build-plugins/searchConsoleCompat.ts). Both the above-floor page and
 *     the below-floor noindex bridge are emitted at the SAME URL, so every
 *     enumerated Gemeinde path (above OR below floor, any locale) self-maps.
 *
 * Kept in ONE module (mirroring build-plugins/frenchBorderMunicipalityData.ts)
 * so the plugin (renderer), router and compat layer never drift on the path
 * shape or the slug set.
 *
 * Architectural note: this family deliberately follows the FISCAL/FRANCE page
 * pattern (self-contained module, `{ activeTab: 'vita', staticOverlay: true }`
 * routing with NO sub-tab, NO hubChrome, NO bespoke locale-rewrite in
 * services/router.ts's updatePathForLocale) rather than the Italian
 * borderMunicipalityPagesPlugin.ts pattern.
 */

import germanDataset from '../data/german-border-municipalities.json';

export type GermanLocale = 'it' | 'en' | 'de' | 'fr';
export const GERMAN_LOCALES: readonly GermanLocale[] = ['it', 'en', 'de', 'fr'] as const;

export type GermanLandkreis = 'Lörrach' | 'Waldshut' | 'Konstanz' | 'Schwarzwald-Baar-Kreis';

export interface GermanBorderMunicipality {
  name: string;
  slug: string;
  ags: string;
  landkreis: GermanLandkreis;
  lat: number;
  lng: number;
  population: number;
  plz: string;
  distanceKm: number;
  nearestCrossing: string;
  /** Swiss canton of the nearest crossing — geographic only, NOT a fiscal driver
   *  (Art. 15a is uniform across every row, unlike the French per-canton split). */
  canton: string;
  regime: 'grenzgaenger-15a';
}

interface GermanDatasetShape {
  source: string;
  year: number;
  floor: Record<string, unknown>;
  regime: { value: string; note: string };
  aboveFloor: GermanBorderMunicipality[];
  belowFloor: GermanBorderMunicipality[];
}

const DATASET = germanDataset as GermanDatasetShape;

export const GERMAN_SOURCE = DATASET.source;
export const GERMAN_YEAR = DATASET.year;
export const GERMAN_ABOVE_FLOOR: readonly GermanBorderMunicipality[] = DATASET.aboveFloor;
export const GERMAN_BELOW_FLOOR: readonly GermanBorderMunicipality[] = DATASET.belowFloor;

/**
 * Art. 15a DBA Deutschland/Schweiz Grenzgänger regime — UNIFORM across every
 * Gemeinde in this dataset (no per-canton split like the French corridor: see
 * data/germanBorderMunicipalities.ts's "REGIME" header note). Sourced
 * 2026-07-29 from the BMF letter of 2023-12-07, the treaty text and KVV/BAG —
 * see /Users/saggesel/.claude/jobs/acadf57f/tmp/tax-research-de-li.md.
 *
 * Deliberately expressed as a RATE on gross pay, not a computed CHF/EUR
 * amount: unlike the French dataset (which ships a reference income profile,
 * `FRENCH_PROFILE`), no such profile exists for this dataset, so multiplying
 * the rate by an assumed income would be an invented figure. The rate itself
 * is the sourced fact; a fixed amount is not.
 *
 * Deliberately NOT included here (unverified / contradictory sources, see the
 * research doc's "NON pubblicabile" section):
 *   - the Gre-2 form's current procedural status — tell readers to verify
 *     with their canton of employment instead;
 *   - the exact DBA article/sub-paragraph number for the credit-method double
 *     taxation relief (only the mechanism name is sourced, not the pinpoint
 *     citation).
 */
export const GERMAN_REGIME_TAX = {
  /** Swiss withholding tax rate on GROSS pay, conditional on a residence
   *  certificate (Ansässigkeitsbescheinigung) being on file with the employer. */
  quellensteuerRate: 0.045,
  appliesTo: 'gross' as const,
  mechanism: 'source' as const,
  /** Germany relieves the double taxation via the credit method (no pinpoint
   *  article/sub-paragraph cited — see header). */
  creditMethod: 'Anrechnungsmethode' as const,
  /** Working days per calendar year a Grenzgänger may fail to return home
   *  before losing the status for the ENTIRE year. Part-time proportion:
   *  5 days per month worked + 1 day per week worked. Homeoffice days do NOT
   *  count as non-return days. */
  nonReturnThresholdDaysPerYear: 60,
  /** No geographic "Grenzzone" restriction: the regime applies across the
   *  whole German/Swiss territory, not just a border strip. */
  geographicZoneRestricted: false,
  /** Health-insurance Optionsrecht (legal basis Art. 2 cpv. 6 OAMal): a
   *  Grenzgänger may opt out of Swiss compulsory health insurance in favour
   *  of the German system within a fixed deadline; the choice must be
   *  exercised explicitly (tacit exercise is invalid) and is generally
   *  irrevocable once made. */
  healthInsuranceOptionDeadlineMonths: 3,
  source:
    'Lettera BMF (Bundesministerium der Finanzen) del 2023-12-07; art. 15a DBA Germania-Svizzera; art. 2 cpv. 6 OAMal (Optionsrecht assicurazione malattia).',
};

/** Per-locale base path (NO trailing municipality slug, NO trailing slash). */
export const GERMAN_BASE_PATH: Record<GermanLocale, string> = {
  it: '/vivere-in-germania-lavorare-in-svizzera',
  en: '/en/living-in-germany-working-in-switzerland',
  de: '/de/leben-in-deutschland-arbeiten-in-der-schweiz',
  fr: '/fr/vivre-en-allemagne-travailler-en-suisse',
};

/** Canonical hub path per locale (index of the DE border-municipality family). */
export const GERMAN_HUB_PATH: Record<GermanLocale, string> = {
  it: `${GERMAN_BASE_PATH.it}/`,
  en: `${GERMAN_BASE_PATH.en}/`,
  de: `${GERMAN_BASE_PATH.de}/`,
  fr: `${GERMAN_BASE_PATH.fr}/`,
};

/** Trailing-slash URL for a Gemeinde's page in a locale. */
export function germanMunicipalityPathFor(locale: GermanLocale, slug: string): string {
  return `${GERMAN_BASE_PATH[locale]}/${slug}/`;
}

function normalizePath(input: string): string {
  const p = (input || '').split('?')[0].split('#')[0];
  return p.endsWith('/') ? p : `${p}/`;
}

/**
 * Precomputed Set of every emitted Gemeinde path (above + below floor × 4
 * locales), built ONCE at module load. Keeps `isGermanBorderMunicipalityPath`
 * O(1) inside the 150k+-path loop of tests/search-console-compat.test.ts —
 * same rationale as the other self-mappable families in searchConsoleCompat.ts.
 */
const GERMAN_PATH_SET: ReadonlySet<string> = (() => {
  const set = new Set<string>();
  for (const m of [...GERMAN_ABOVE_FLOOR, ...GERMAN_BELOW_FLOOR]) {
    for (const locale of GERMAN_LOCALES) set.add(germanMunicipalityPathFor(locale, m.slug));
  }
  return set;
})();

/** True for any emitted DE border-municipality URL (above-floor page OR
 *  below-floor bridge, any locale). Used by the Search Console 404 compat self-map. */
export function isGermanBorderMunicipalityPath(inputPath: string): boolean {
  return GERMAN_PATH_SET.has(normalizePath(inputPath));
}

/**
 * Reverse index (path → locale + slug) for the per-Gemeinde detail/bridge
 * pages, used by services/router.ts to recognise the URL at hydration time
 * and recover the locale without re-parsing the path shape. Same membership
 * as GERMAN_PATH_SET/isGermanBorderMunicipalityPath above (above + below floor).
 */
const GERMAN_DETAIL_INDEX: ReadonlyMap<string, { locale: GermanLocale; slug: string }> = (() => {
  const map = new Map<string, { locale: GermanLocale; slug: string }>();
  for (const m of [...GERMAN_ABOVE_FLOOR, ...GERMAN_BELOW_FLOOR]) {
    for (const locale of GERMAN_LOCALES) {
      map.set(normalizePath(germanMunicipalityPathFor(locale, m.slug)), { locale, slug: m.slug });
    }
  }
  return map;
})();

export function parseGermanBorderMunicipalityPath(inputPath: string): { locale: GermanLocale; slug: string } | null {
  return GERMAN_DETAIL_INDEX.get(normalizePath(inputPath)) ?? null;
}

/** Reverse index (path → locale) for the hub/index page, one per locale. */
const GERMAN_HUB_INDEX: ReadonlyMap<string, GermanLocale> = new Map(
  GERMAN_LOCALES.map((l) => [normalizePath(GERMAN_HUB_PATH[l]), l]),
);

export function isGermanBorderMunicipalityHubPath(inputPath: string): boolean {
  return GERMAN_HUB_INDEX.has(normalizePath(inputPath));
}

export function parseGermanBorderMunicipalityHubPath(inputPath: string): { locale: GermanLocale } | null {
  const found = GERMAN_HUB_INDEX.get(normalizePath(inputPath));
  return found ? { locale: found } : null;
}
