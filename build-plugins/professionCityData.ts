/**
 * professionCityData.ts — routing + path data for TI-city profession
 * landings (e.g. IT `/lavoro-lugano-infermiere/`, EN `/en/jobs-lugano-nurse/`,
 * DE `/de/arbeit-lugano-pflegefachperson/`, FR `/fr/travail-lugano-infirmier/`).
 *
 * The canton family (professionCantonData.ts) already covers
 * `/lavoro-ticino-{role}/` for TI; this family covers the CROSS of
 * profession x one of the 5 legacy TI city hubs (cityJobsHub.ts) — real
 * on-site search demand (e.g. "autista lugano") that neither the
 * canton-wide page nor the city hub itself names explicitly. Issue #4301,
 * data/search-location-gaps.json is the mined evidence for the gap.
 *
 * Imported by services/router.ts (SPA — no fs) and the build plugin.
 * Routes enumerated over TI_LEGACY_CITY_HUB_KEYS (5) x PROFESSION_IDS (24,
 * the TI-scoped profession set already used by aggregateProfessionJobs —
 * the 5 canton-only ids from #3657 are non-TI professions, out of scope
 * here) x 4 locales = 480 routes. The emitter gates each on a real
 * job-count floor: not every enumerated route gets static HTML, below-floor
 * pairs get a noindex,follow bridge to the always-live city hub instead of
 * a hard 404.
 */
import {
  PROFESSION_IDS,
  PROFESSION_LOCALES,
  PROFESSION_LOCALE_PREFIX,
  professionRoleKeyword,
  type ProfessionId,
  type ProfessionLocale,
} from './professionLandingsData';
import { TI_LEGACY_CITY_HUB_KEYS, CITY_HUB_SLUG, type CityHubKey } from './cityJobsHub';

/** The 5 legacy TI city hubs this family covers. */
export const PROFESSION_CITY_KEYS: readonly CityHubKey[] = TI_LEGACY_CITY_HUB_KEYS;

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
