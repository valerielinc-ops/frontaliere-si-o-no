/**
 * professionCantonData.ts — routing + path data for the per-canton profession
 * landings (e.g. IT `/lavoro-zurigo-infermiere/`, EN `/en/jobs-zurich-nurse/`,
 * DE `/de/arbeit-zurich-krankenpfleger/`, FR `/fr/travail-zurich-infirmier/`).
 *
 * Imported by services/router.ts (SPA — no fs) and the build plugin. Routes are
 * enumerated from the shared canton slug table (salaryStatsData) × the combined
 * profession id list (professionLandingsData: the 24 Ticino-bespoke professions
 * plus the 5 canton-only professions added for #3657 — see
 * ALL_CANTON_PROFESSION_IDS / professionRoleKeywordAny there), so there is no
 * new slug data to keep in sync.
 *
 * The emitter gates each (canton, profession) page on a real job-count floor,
 * so not every enumerated route gets static HTML — the rest fall back to the
 * SPA (job-board filtered view). The router therefore recognises the full set.
 */

import {
  ALL_CANTON_PROFESSION_IDS,
  PROFESSION_LOCALES,
  PROFESSION_LOCALE_PREFIX,
  professionRoleKeywordAny,
  type AnyProfessionId,
  type ProfessionLocale,
} from './professionLandingsData';
import { SALARY_STATS_CANTON_KEYS, SALARY_STATS_CANTON_SLUGS } from './salaryStatsData';

/**
 * Cantons this family emits for: every URL canton key EXCEPT Ticino. TI keeps
 * its dedicated legacy profession landings at the identical "lavoro-ticino-ROLE"
 * slugs (professionLandingsData) — including TI here would collide with them.
 */
export const PROFESSION_CANTON_KEYS: readonly string[] = Object.freeze(
  SALARY_STATS_CANTON_KEYS.filter((k) => k !== 'TI'),
);

/** Locale-natural "area" word that fronts every profession slug. */
export const PROFESSION_CANTON_AREA_WORD: Record<ProfessionLocale, string> = {
  it: 'lavoro',
  en: 'jobs',
  de: 'arbeit',
  fr: 'travail',
};

/** Build the canonical path for a per-canton profession landing. */
export function buildProfessionCantonPath(
  locale: ProfessionLocale,
  cantonKey: string,
  id: AnyProfessionId,
): string {
  const cantonSlug = SALARY_STATS_CANTON_SLUGS[cantonKey][locale];
  const role = professionRoleKeywordAny(locale, id);
  return `${PROFESSION_LOCALE_PREFIX[locale]}/${PROFESSION_CANTON_AREA_WORD[locale]}-${cantonSlug}-${role}/`
    .replace(/\/{2,}/g, '/');
}

export interface ProfessionCantonPath {
  locale: ProfessionLocale;
  cantonKey: string;
  id: AnyProfessionId;
  path: string;
}

export function listAllProfessionCantonPaths(): ProfessionCantonPath[] {
  const out: ProfessionCantonPath[] = [];
  for (const locale of PROFESSION_LOCALES) {
    for (const cantonKey of PROFESSION_CANTON_KEYS) {
      for (const id of ALL_CANTON_PROFESSION_IDS) {
        out.push({ locale, cantonKey, id, path: buildProfessionCantonPath(locale, cantonKey, id) });
      }
    }
  }
  return out;
}

export const PROFESSION_CANTON_ROUTES: readonly string[] = Object.freeze(
  listAllProfessionCantonPaths().map((p) => p.path),
);

const PATH_INDEX: ReadonlyMap<string, ProfessionCantonPath> = new Map(
  listAllProfessionCantonPaths().map((p) => [p.path, p]),
);

function normalizePath(urlPath: string): string {
  const p = String(urlPath || '').split('?')[0].split('#')[0];
  return p.endsWith('/') ? p : `${p}/`;
}

export function parseProfessionCantonPath(urlPath: string): ProfessionCantonPath | null {
  return PATH_INDEX.get(normalizePath(urlPath)) ?? null;
}

export function isProfessionCantonPath(urlPath: string): boolean {
  return PATH_INDEX.has(normalizePath(urlPath));
}
