/**
 * professionCityData.ts — routing + path data for city x profession
 * landings (e.g. IT `/lavoro-lugano-infermiere/`, EN `/en/jobs-lugano-nurse/`,
 * DE `/de/arbeit-lugano-pflegefachperson/`, FR `/fr/travail-lugano-infirmier/`).
 *
 * The canton family (professionCantonData.ts) already covers
 * `/lavoro-ticino-{role}/` for TI; this family covers the CROSS of
 * profession x a city hub — real on-site search demand (e.g. "autista
 * lugano", "ergoterapista zurigo") that neither the canton-wide page nor the
 * city hub itself names explicitly. Issue #4301 seeded the 5 legacy TI hubs
 * (data/search-location-gaps.json mined the gap); issue #4488 extends the
 * family to the 6 major non-TI cities (Zürich, Basel, Bern, Luzern, Genève,
 * Lausanne) whose extra-TI demand is visible in
 * data/profession-keyword-opportunities.json.
 *
 * Imported by services/router.ts (SPA — no fs) and the build plugin.
 * Routes enumerated over PROFESSION_CITY_DEFS (5 legacy TI hubs + 6 major CH
 * cities = 11) x PROFESSION_IDS (24, the TI-scoped profession set already used
 * by aggregateProfessionJobs — the 5 canton-only ids from #3657 are out of
 * scope here) x 4 locales = 1056 routes. The emitter gates each on a real
 * job-count floor: not every enumerated route gets static HTML, below-floor
 * pairs get a noindex,follow bridge to the always-live city hub (TI:
 * `/cerca-lavoro-ticino/{city}/`; CH: canton-aware
 * `/cerca-lavoro-{canton}/{city}/`) instead of a hard 404.
 */
import {
  PROFESSION_IDS,
  PROFESSION_LOCALES,
  PROFESSION_LOCALE_PREFIX,
  professionRoleKeyword,
  type ProfessionId,
  type ProfessionLocale,
} from './professionLandingsData';
import {
  TI_LEGACY_CITY_HUB_KEYS,
  CITY_HUB_SLUG,
  CITY_HUB_DISPLAY_NAME,
  type CityHubKey,
} from './cityJobsHub';

/**
 * A city this family covers, with the canton context the emitter needs to
 * build the always-live bridge/CTA target (`cantonUrlKey` -> canton section
 * slug + localized canton display) and the fallback salary median
 * (`cantonBfs` -> grossregion). `isTi` marks the 5 legacy TI hubs whose HTML
 * render path stays byte-frozen (issue #4301).
 */
export interface ProfessionCityDef {
  /** URL city segment + aggregation key (locale-independent), e.g. 'lugano', 'zurich'. */
  readonly key: CityHubKey;
  /** Native display name, e.g. 'Lugano', 'Zürich'. */
  readonly display: string;
  /** URL/group canton key for section slug + canton display, e.g. 'TI', 'ZH', 'BASILEA'. */
  readonly cantonUrlKey: string;
  /** BFS canton code for the grossregion salary median, e.g. 'TI', 'ZH', 'BS'. */
  readonly cantonBfs: string;
  /** True for the 5 legacy TI city hubs (byte-frozen render path). */
  readonly isTi: boolean;
}

const TI_CITY_DEFS: readonly ProfessionCityDef[] = TI_LEGACY_CITY_HUB_KEYS.map((key) => ({
  key,
  display: CITY_HUB_DISPLAY_NAME[key] ?? key,
  cantonUrlKey: 'TI',
  cantonBfs: 'TI',
  isTi: true,
}));

/**
 * The 6 major non-TI Swiss cities (issue #4488). Each reuses the always-live
 * per-canton city hub `/cerca-lavoro-{canton}/{city}/` (emitted unconditionally
 * by jobsSeoPagesPlugin.ts) as its below-floor bridge + CTA target. `key` is the
 * canonical asciifolded city slug the city hub itself uses; `cantonUrlKey` is the
 * half-canton URL group where applicable (Basel -> BASILEA); `cantonBfs` is the
 * real BFS code the grossregion salary index is keyed on (Basel -> BS).
 */
const CH_CITY_DEFS: readonly ProfessionCityDef[] = [
  { key: 'zurich', display: 'Zürich', cantonUrlKey: 'ZH', cantonBfs: 'ZH', isTi: false },
  { key: 'basel', display: 'Basel', cantonUrlKey: 'BASILEA', cantonBfs: 'BS', isTi: false },
  { key: 'bern', display: 'Bern', cantonUrlKey: 'BE', cantonBfs: 'BE', isTi: false },
  { key: 'luzern', display: 'Luzern', cantonUrlKey: 'LU', cantonBfs: 'LU', isTi: false },
  { key: 'geneve', display: 'Genève', cantonUrlKey: 'GE', cantonBfs: 'GE', isTi: false },
  { key: 'lausanne', display: 'Lausanne', cantonUrlKey: 'VD', cantonBfs: 'VD', isTi: false },
];

/** Every city this family enumerates: 5 legacy TI hubs + 6 major CH cities. */
export const PROFESSION_CITY_DEFS: readonly ProfessionCityDef[] = [...TI_CITY_DEFS, ...CH_CITY_DEFS];

const DEF_BY_KEY: ReadonlyMap<CityHubKey, ProfessionCityDef> = new Map(
  PROFESSION_CITY_DEFS.map((d) => [d.key, d]),
);

/** Resolve the canton context for a city key (undefined for unknown keys). */
export function getProfessionCityDef(key: CityHubKey): ProfessionCityDef | undefined {
  return DEF_BY_KEY.get(key);
}

/** All city keys this family covers (5 legacy TI hubs + 6 major CH cities). */
export const PROFESSION_CITY_KEYS: readonly CityHubKey[] = PROFESSION_CITY_DEFS.map((d) => d.key);

/** Locale-natural "area" word that fronts every profession-city slug (same convention as professionCantonData.ts). */
export const PROFESSION_CITY_AREA_WORD: Record<ProfessionLocale, string> = {
  it: 'lavoro',
  en: 'jobs',
  de: 'arbeit',
  fr: 'travail',
};

/** Build the canonical path for a profession x TI-city landing. */
export function buildProfessionCityPath(
  locale: ProfessionLocale,
  cityKey: CityHubKey,
  id: ProfessionId,
): string {
  const citySlug = CITY_HUB_SLUG[locale]?.[cityKey] ?? cityKey;
  const role = professionRoleKeyword(locale, id);
  return `${PROFESSION_LOCALE_PREFIX[locale]}/${PROFESSION_CITY_AREA_WORD[locale]}-${citySlug}-${role}/`
    .replace(/\/{2,}/g, '/');
}

export interface ProfessionCityPath {
  locale: ProfessionLocale;
  cityKey: CityHubKey;
  id: ProfessionId;
  path: string;
}

export function listAllProfessionCityPaths(): ProfessionCityPath[] {
  const out: ProfessionCityPath[] = [];
  for (const locale of PROFESSION_LOCALES) {
    for (const cityKey of PROFESSION_CITY_KEYS) {
      for (const id of PROFESSION_IDS) {
        out.push({ locale, cityKey, id, path: buildProfessionCityPath(locale, cityKey, id) });
      }
    }
  }
  return out;
}

export const PROFESSION_CITY_ROUTES: readonly string[] = Object.freeze(
  listAllProfessionCityPaths().map((p) => p.path),
);

const PATH_INDEX: ReadonlyMap<string, ProfessionCityPath> = new Map(
  listAllProfessionCityPaths().map((p) => [p.path, p]),
);

function normalizePath(urlPath: string): string {
  const p = String(urlPath || '').split('?')[0].split('#')[0];
  return p.endsWith('/') ? p : `${p}/`;
}

export function parseProfessionCityPath(urlPath: string): ProfessionCityPath | null {
  return PATH_INDEX.get(normalizePath(urlPath)) ?? null;
}

export function isProfessionCityPath(urlPath: string): boolean {
  return PATH_INDEX.has(normalizePath(urlPath));
}
