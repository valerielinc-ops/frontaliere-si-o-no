/**
 * Shared data + path logic for the per-municipality LIECHTENSTEIN border
 * pages ("vivere a {Gemeinde} (Liechtenstein) e lavorare in Svizzera",
 * issue #4884 — third of the FR/DE/LI rollout after France #4545/#4878 and
 * Germany #4882).
 *
 * Single source of truth for:
 *   - the committed dataset (data/liechtenstein-municipalities.json, built
 *     by scripts/build-liechtenstein-municipalities.mjs from
 *     data/liechtensteinMunicipalities.ts) — population-only floor, no
 *     distance/canton field (Liechtenstein is too small for a distance
 *     filter to discriminate, see the raw source's own header rationale),
 *   - the sourced treaty regime facts (LIECHTENSTEIN_REGIME — a qualitative
 *     taxation RULE, not a numeric CHF/EUR figure: unlike France/Germany,
 *     no sourced annual amount exists for this corridor at all, only the
 *     Art. 15 cpv. 4 residence-state rule),
 *   - the per-locale URL for a Gemeinde (trailing-slash, 4 locales),
 *   - `isLiechtensteinBorderMunicipalityPath()` — the O(1) membership check
 *     the Search Console 404 compat layer uses to self-map this family
 *     (build-plugins/searchConsoleCompat.ts). Both the above-floor page and
 *     the below-floor noindex bridge are emitted at the SAME URL, so every
 *     enumerated Gemeinde path (above OR below floor, any locale) self-maps.
 *
 * `LiechtensteinLocale`/`LIECHTENSTEIN_LOCALES` are imported from
 * data/liechtensteinCorridorContent.ts (not redeclared here) — that module
 * is the required reuse target for the actual page copy (issue brief:
 * "must reuse data/liechtensteinCorridorContent.ts instead of rewriting
 * copy for Liechtenstein"), so both modules share one locale-set definition
 * rather than risking two independently-edited unions drifting apart.
 *
 * Kept in ONE module (mirroring frenchBorderMunicipalityData.ts /
 * germanBorderMunicipalityData.ts) so the plugin (renderer), router and
 * compat layer never drift on the path shape or the slug set.
 *
 * Architectural note: this family deliberately follows the FISCAL/FRANCE
 * page pattern (self-contained module, `{ activeTab: 'vita', staticOverlay:
 * true }` routing with NO sub-tab, NO hubChrome, NO bespoke locale-rewrite
 * in services/router.ts's updatePathForLocale) rather than the Italian
 * borderMunicipalityPagesPlugin.ts pattern.
 *
 * Explicitly NOT modeled here (unverified / out of scope, see the tax
 * research doc's "NON pubblicabile" section for this corridor):
 *   - the health-insurance Optionsrecht — sourced only via secondary
 *     references for Liechtenstein, unlike Germany's BMF-letter-sourced
 *     Art. 2 cpv. 6 OAMal deadline. Do not add it here or in the pages
 *     plugin without a primary source.
 */

import liechtensteinDataset from '../data/liechtenstein-municipalities.json';
import { LIECHTENSTEIN_LOCALES, type LiechtensteinLocale } from '../data/liechtensteinCorridorContent';

export type { LiechtensteinLocale };
export { LIECHTENSTEIN_LOCALES };

export interface LiechtensteinBorderMunicipality {
  name: string;
  slug: string;
  wikidataId: string;
  lat: number;
  lng: number;
  population: number;
  populationYear: number;
}

interface LiechtensteinCommutingContext {
  year: number;
  chToLi: number;
  liToCh: number;
  ratio: string;
  workforceShareCrossBorder: string;
  note: string;
  source: string;
}

interface LiechtensteinDatasetShape {
  source: string;
  year: number;
  nationalPopulation: { value: number; year: number; source: string };
  commutingContext: LiechtensteinCommutingContext;
  floor: Record<string, unknown>;
  aboveFloor: LiechtensteinBorderMunicipality[];
  belowFloor: LiechtensteinBorderMunicipality[];
}

const DATASET = liechtensteinDataset as LiechtensteinDatasetShape;

export const LIECHTENSTEIN_SOURCE = DATASET.source;
export const LIECHTENSTEIN_YEAR = DATASET.year;
export const LIECHTENSTEIN_NATIONAL_POPULATION = DATASET.nationalPopulation;
export const LIECHTENSTEIN_COMMUTING_CONTEXT = DATASET.commutingContext;
export const LIECHTENSTEIN_ABOVE_FLOOR: readonly LiechtensteinBorderMunicipality[] = DATASET.aboveFloor;
export const LIECHTENSTEIN_BELOW_FLOOR: readonly LiechtensteinBorderMunicipality[] = DATASET.belowFloor;

/**
 * Treaty SR 0.672.951.43 (Switzerland-Liechtenstein double-taxation
 * agreement), read directly, plus Statistisches Jahrbuch 2025. Sourced
 * 2026-07-29 — full sourcing trail in data/liechtensteinMunicipalities.ts's
 * SOURCES header.
 *
 * Deliberately a QUALITATIVE rule, not a numeric CHF/EUR figure: this
 * corridor has no sourced annual tax amount at all (unlike France's
 * per-canton REGIME_TAX or even Germany's rate-based GERMAN_REGIME_TAX).
 * Art. 15 cpv. 4 is itself the single most useful fact for this page —
 * exclusive taxation in the state of residence for genuine daily
 * commuters, never split, never taxed at source — and is presented as
 * such rather than forcing an invented number into a tile.
 */
export const LIECHTENSTEIN_REGIME = {
  /** Art. 15 cpv. 4: genuine daily commuters are taxed EXCLUSIVELY in
   *  their state of residence — never split, never at source. This is the
   *  inverse of the French/German mechanism (Swiss source withholding). */
  taxationRule: 'residence-exclusive' as const,
  treatyArticle: 'Art. 15 cpv. 4' as const,
  /** Working days per calendar year beyond which frontaliere status is
   *  lost. The source does NOT say what happens fiscally after the
   *  threshold is exceeded (unlike Germany's Art. 15a, which is explicit) —
   *  do not analogize to the German 60-day consequence here. */
  nonReturnThresholdDaysPerYear: 45,
  /** Customs union since 1923, monetary union 1980/1981, shared VAT
   *  territory: no customs formalities, no currency change, no VAT-rate
   *  difference crossing the border. */
  customsUnionSince: 1923,
  monetaryUnionSince: 1980,
  source: 'SR 0.672.951.43 (convenzione di doppia imposizione Svizzera-Liechtenstein), art. 15 cpv. 4; Statistisches Jahrbuch 2025.',
};

/** Per-locale base path (NO trailing municipality slug, NO trailing slash). */
export const LIECHTENSTEIN_BASE_PATH: Record<LiechtensteinLocale, string> = {
  it: '/vivere-in-liechtenstein-lavorare-in-svizzera',
  en: '/en/living-in-liechtenstein-working-in-switzerland',
  de: '/de/leben-in-liechtenstein-arbeiten-in-der-schweiz',
  fr: '/fr/vivre-au-liechtenstein-travailler-en-suisse',
};

/** Canonical hub path per locale (index of the LI border-municipality family). */
export const LIECHTENSTEIN_HUB_PATH: Record<LiechtensteinLocale, string> = {
  it: `${LIECHTENSTEIN_BASE_PATH.it}/`,
  en: `${LIECHTENSTEIN_BASE_PATH.en}/`,
  de: `${LIECHTENSTEIN_BASE_PATH.de}/`,
  fr: `${LIECHTENSTEIN_BASE_PATH.fr}/`,
};

/** Trailing-slash URL for a Gemeinde's page in a locale. */
export function liechtensteinMunicipalityPathFor(locale: LiechtensteinLocale, slug: string): string {
  return `${LIECHTENSTEIN_BASE_PATH[locale]}/${slug}/`;
}

function normalizePath(input: string): string {
  const p = (input || '').split('?')[0].split('#')[0];
  return p.endsWith('/') ? p : `${p}/`;
}

/**
 * Precomputed Set of every emitted Gemeinde path (above + below floor × 4
 * locales), built ONCE at module load. Keeps
 * `isLiechtensteinBorderMunicipalityPath` O(1) inside the 150k+-path loop of
 * tests/search-console-compat.test.ts — same rationale as the other
 * self-mappable families in searchConsoleCompat.ts.
 */
const LIECHTENSTEIN_PATH_SET: ReadonlySet<string> = (() => {
  const set = new Set<string>();
  for (const m of [...LIECHTENSTEIN_ABOVE_FLOOR, ...LIECHTENSTEIN_BELOW_FLOOR]) {
    for (const locale of LIECHTENSTEIN_LOCALES) set.add(liechtensteinMunicipalityPathFor(locale, m.slug));
  }
  return set;
})();

/** True for any emitted LI border-municipality URL (above-floor page OR
 *  below-floor bridge, any locale). Used by the Search Console 404 compat self-map. */
export function isLiechtensteinBorderMunicipalityPath(inputPath: string): boolean {
  return LIECHTENSTEIN_PATH_SET.has(normalizePath(inputPath));
}

/**
 * Reverse index (path → locale + slug) for the per-Gemeinde detail/bridge
 * pages, used by services/router.ts to recognise the URL at hydration time
 * and recover the locale without re-parsing the path shape. Same membership
 * as LIECHTENSTEIN_PATH_SET/isLiechtensteinBorderMunicipalityPath above
 * (above + below floor).
 */
const LIECHTENSTEIN_DETAIL_INDEX: ReadonlyMap<string, { locale: LiechtensteinLocale; slug: string }> = (() => {
  const map = new Map<string, { locale: LiechtensteinLocale; slug: string }>();
  for (const m of [...LIECHTENSTEIN_ABOVE_FLOOR, ...LIECHTENSTEIN_BELOW_FLOOR]) {
    for (const locale of LIECHTENSTEIN_LOCALES) {
      map.set(normalizePath(liechtensteinMunicipalityPathFor(locale, m.slug)), { locale, slug: m.slug });
    }
  }
  return map;
})();

export function parseLiechtensteinBorderMunicipalityPath(
  inputPath: string,
): { locale: LiechtensteinLocale; slug: string } | null {
  return LIECHTENSTEIN_DETAIL_INDEX.get(normalizePath(inputPath)) ?? null;
}

/** Reverse index (path → locale) for the hub/index page, one per locale. */
const LIECHTENSTEIN_HUB_INDEX: ReadonlyMap<string, LiechtensteinLocale> = new Map(
  LIECHTENSTEIN_LOCALES.map((l) => [normalizePath(LIECHTENSTEIN_HUB_PATH[l]), l]),
);

export function isLiechtensteinBorderMunicipalityHubPath(inputPath: string): boolean {
  return LIECHTENSTEIN_HUB_INDEX.has(normalizePath(inputPath));
}

export function parseLiechtensteinBorderMunicipalityHubPath(inputPath: string): { locale: LiechtensteinLocale } | null {
  const found = LIECHTENSTEIN_HUB_INDEX.get(normalizePath(inputPath));
  return found ? { locale: found } : null;
}
