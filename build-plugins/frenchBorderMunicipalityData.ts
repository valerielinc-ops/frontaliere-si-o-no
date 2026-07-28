/**
 * Shared data + path logic for the per-municipality FRANCE border pages
 * ("vivere a {commune} e lavorare in Svizzera", issue #4545 — Genève/Vaud/
 * Neuchâtel/Jura/Valais corridor, first of the FR/DE/AT/LI rollout).
 *
 * Single source of truth for:
 *   - the committed dataset (data/french-border-municipalities.json, built by
 *     scripts/build-french-border-municipalities.mjs from
 *     data/frenchBorderMunicipalities.ts),
 *   - the sourced fiscal-regime tax figures (REGIME_TAX),
 *   - the per-locale URL for a commune (trailing-slash, 4 locales),
 *   - `isFrenchBorderMunicipalityPath()` — the O(1) membership check the
 *     Search Console 404 compat layer uses to self-map this family
 *     (build-plugins/searchConsoleCompat.ts). Both the above-floor page and
 *     the below-floor noindex bridge are emitted at the SAME URL, so every
 *     enumerated commune path (above OR below floor, any locale) self-maps.
 *
 * Kept in ONE module (mirroring build-plugins/fiscalMunicipalityData.ts) so
 * the plugin (renderer), router and compat layer never drift on the path
 * shape or the slug set.
 *
 * Architectural note: this family deliberately follows the FISCAL page
 * pattern (self-contained module, `{ activeTab: 'vita', staticOverlay: true }`
 * routing with NO sub-tab, NO hubChrome, NO bespoke locale-rewrite in
 * services/router.ts's updatePathForLocale) rather than the Italian
 * borderMunicipalityPagesPlugin.ts pattern — that one requires a HIGH-risk
 * SlugTable edit (161 impacted, per GitNexus) for its bespoke locale-URL
 * rewrite. This family also has no live wait-time/commute data for FR
 * crossings (data/borderCrossings.ts FR entries carry no avgWaitMorning/
 * avgWaitEvening/webcams), so it has no hydration/commute-simulator panel.
 */

import frenchDataset from '../data/french-border-municipalities.json';

export type FrenchLocale = 'it' | 'en' | 'de' | 'fr';
export const FRENCH_LOCALES: readonly FrenchLocale[] = ['it', 'en', 'de', 'fr'] as const;

export type FrenchRegime = 'geneve' | 'huit-cantons';

export interface FrenchBorderMunicipality {
  name: string;
  slug: string;
  inseeCode: string;
  dept: string;
  lat: number;
  lng: number;
  population: number;
  distanceKm: number;
  nearestCrossing: string;
  canton: string;
  regime: FrenchRegime;
  avgRentMonthly: number;
  rentSource: 'commune' | 'maille';
  rentObs: number;
}

interface FrenchDatasetShape {
  source: string;
  year: number;
  floor: Record<string, unknown>;
  profile: {
    annualIncomeCHF: number;
    maritalStatus: 'SINGLE' | 'MARRIED';
    children: number;
  };
  aboveFloor: FrenchBorderMunicipality[];
  belowFloor: FrenchBorderMunicipality[];
}

const DATASET = frenchDataset as FrenchDatasetShape;

export const FRENCH_SOURCE = DATASET.source;
export const FRENCH_YEAR = DATASET.year;
export const FRENCH_PROFILE = DATASET.profile;
export const FRENCH_ABOVE_FLOOR: readonly FrenchBorderMunicipality[] = DATASET.aboveFloor;
export const FRENCH_BELOW_FLOOR: readonly FrenchBorderMunicipality[] = DATASET.belowFloor;

/**
 * Annual tax on the reference profile (FRENCH_PROFILE: single, CHF 55'000/year
 * gross, no children — same profile as data/fiscal-municipalities.json) per
 * regime, sourced 2026-07-28:
 *
 * - geneve (canton GE, accord frontalieri 1973, rsGE D 1 45): Swiss taxation
 *   at source via barème A0. 2026 barème (ge.ch, "Barèmes 2026 impôt source",
 *   pubblicato 2025-12-05), scaglione 54'600–55'199 CHF → 6.54% combinato
 *   IFD+ICC → CHF 3'597/anno trattenuto alla fonte. Ginevra retrocede il 3.5%
 *   della massa salariale frontalieri alla Francia; la Francia concede credito
 *   d'imposta pieno (no doppia imposizione).
 * - huit-cantons (cantoni VD/NE/JU/VS presenti in questo corridoio — accord
 *   1983): la Francia tassa per intero, la Svizzera riceve compensazione 4.5%
 *   dalla Francia. Per il profilo di riferimento (55'000 CHF/anno → €58'850 al
 *   tasso ufficiale 1 CHF = 1.07 € per i redditi 2025): abattement forfaitario
 *   10% (€5'885, sotto il tetto €14'555) → R = €52'965 → scaglione barème 2025
 *   al 30% → I = R×0.30 − 6'896.01 = €8'993/anno. Décote non si applica
 *   (imposta >> soglia €1'982). Fonte: impots.gouv.fr, brochure ufficiale
 *   "Déclaration des revenus 2025" (barème + forfait 10% cap/floor + décote).
 */
export const REGIME_TAX: Record<FrenchRegime, {
  amount: number;
  currency: 'CHF' | 'EUR';
  mechanism: 'source' | 'declaration';
  source: string;
}> = {
  geneve: {
    amount: 3597,
    currency: 'CHF',
    mechanism: 'source',
    source: 'ge.ch, "Barèmes 2026 impôt source" (pubblicato 2025-12-05); accord frontalieri Genève 1973 (rsGE D 1 45)',
  },
  'huit-cantons': {
    amount: 8993,
    currency: 'EUR',
    mechanism: 'declaration',
    source: 'impots.gouv.fr, brochure ufficiale "Déclaration des revenus 2025" (barème + forfait 10% + décote); accord frontalieri 1983',
  },
};

/** Per-locale base path (NO trailing municipality slug, NO trailing slash). */
export const FRENCH_BASE_PATH: Record<FrenchLocale, string> = {
  it: '/vivere-in-francia-lavorare-in-svizzera',
  en: '/en/living-in-france-working-in-switzerland',
  de: '/de/leben-in-frankreich-arbeiten-in-der-schweiz',
  fr: '/fr/vivre-en-france-travailler-en-suisse',
};

/** Canonical hub path per locale (index of the FR border-municipality family). */
export const FRENCH_HUB_PATH: Record<FrenchLocale, string> = {
  it: `${FRENCH_BASE_PATH.it}/`,
  en: `${FRENCH_BASE_PATH.en}/`,
  de: `${FRENCH_BASE_PATH.de}/`,
  fr: `${FRENCH_BASE_PATH.fr}/`,
};

/** Trailing-slash URL for a commune's page in a locale. */
export function frenchMunicipalityPathFor(locale: FrenchLocale, slug: string): string {
  return `${FRENCH_BASE_PATH[locale]}/${slug}/`;
}

function normalizePath(input: string): string {
  const p = (input || '').split('?')[0].split('#')[0];
  return p.endsWith('/') ? p : `${p}/`;
}

/**
 * Precomputed Set of every emitted commune path (above + below floor × 4
 * locales), built ONCE at module load. Keeps `isFrenchBorderMunicipalityPath`
 * O(1) inside the 150k+-path loop of tests/search-console-compat.test.ts —
 * same rationale as the other self-mappable families in searchConsoleCompat.ts.
 */
const FRENCH_PATH_SET: ReadonlySet<string> = (() => {
  const set = new Set<string>();
  for (const m of [...FRENCH_ABOVE_FLOOR, ...FRENCH_BELOW_FLOOR]) {
    for (const locale of FRENCH_LOCALES) set.add(frenchMunicipalityPathFor(locale, m.slug));
  }
  return set;
})();

/** True for any emitted FR border-municipality URL (above-floor page OR
 *  below-floor bridge, any locale). Used by the Search Console 404 compat self-map. */
export function isFrenchBorderMunicipalityPath(inputPath: string): boolean {
  return FRENCH_PATH_SET.has(normalizePath(inputPath));
}

/**
 * Reverse index (path → locale + slug) for the per-commune detail/bridge
 * pages, used by services/router.ts to recognise the URL at hydration time
 * and recover the locale without re-parsing the path shape. Same membership
 * as FRENCH_PATH_SET/isFrenchBorderMunicipalityPath above (above + below floor).
 */
const FRENCH_DETAIL_INDEX: ReadonlyMap<string, { locale: FrenchLocale; slug: string }> = (() => {
  const map = new Map<string, { locale: FrenchLocale; slug: string }>();
  for (const m of [...FRENCH_ABOVE_FLOOR, ...FRENCH_BELOW_FLOOR]) {
    for (const locale of FRENCH_LOCALES) {
      map.set(normalizePath(frenchMunicipalityPathFor(locale, m.slug)), { locale, slug: m.slug });
    }
  }
  return map;
})();

export function parseFrenchBorderMunicipalityPath(inputPath: string): { locale: FrenchLocale; slug: string } | null {
  return FRENCH_DETAIL_INDEX.get(normalizePath(inputPath)) ?? null;
}

/** Reverse index (path → locale) for the hub/index page, one per locale. */
const FRENCH_HUB_INDEX: ReadonlyMap<string, FrenchLocale> = new Map(
  FRENCH_LOCALES.map((l) => [normalizePath(FRENCH_HUB_PATH[l]), l]),
);

export function isFrenchBorderMunicipalityHubPath(inputPath: string): boolean {
  return FRENCH_HUB_INDEX.has(normalizePath(inputPath));
}

export function parseFrenchBorderMunicipalityHubPath(inputPath: string): { locale: FrenchLocale } | null {
  const found = FRENCH_HUB_INDEX.get(normalizePath(inputPath));
  return found ? { locale: found } : null;
}
