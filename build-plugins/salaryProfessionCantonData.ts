/**
 * salaryProfessionCantonData.ts — routing + path data for the salary-intent
 * profession×canton landings (e.g. IT `/stipendio-infermiere-zurigo/`, EN
 * `/en/salary-nurse-zurich/`, DE `/de/gehalt-krankenpfleger-zurich/`, FR
 * `/fr/salaire-infirmier-zurich/`).
 *
 * Sibling of the job-intent `professionCantonData.ts`: same non-TI canton set,
 * same slug tables, but the salary-intent family covers ONLY the 8 professions
 * that ship a real, TI-scoped median preset in `data/profession-salary-medians.json`
 * (see docs/SALARY-INTENT-CANONICAL-PLAN.md §1). Showing a canton's generic
 * all-jobs median under a profession-specific headline for a profession without
 * a real median would misrepresent the page's own premise, so those are excluded.
 *
 * Imported by services/router.ts (SPA — no fs) and the build plugin, so the
 * eligible-id list is inlined as pure literals (no JSON import at module-eval,
 * same config-graph-safety reason salaryStatsData / cantonSalaryIndex inline
 * their tables). A guard test locks SALARY_PROFESSION_ELIGIBLE_IDS to the JSON
 * presets so the two can't drift.
 *
 * The emitter gates each (canton, profession) page on a real job-count floor,
 * so a below-floor pair gets a `noindex,follow` bridge (not static HTML) at the
 * same URL. The router therefore recognises the full enumerated set.
 */

import {
  PROFESSION_LOCALES,
  PROFESSION_LOCALE_PREFIX,
  professionRoleKeywordAny,
  type AnyProfessionId,
  type ProfessionLocale,
} from './professionLandingsData';
import { SALARY_STATS_CANTON_SLUGS } from './salaryStatsData';
import { PROFESSION_CANTON_KEYS } from './professionCantonData';

/**
 * The 8 professions with a real, TI-scoped median preset in
 * `data/profession-salary-medians.json`. Inlined as literals (config-graph
 * safety) and locked to the JSON via tests/salary-profession-canton.test.ts.
 */
export const SALARY_PROFESSION_ELIGIBLE_IDS: readonly AnyProfessionId[] = Object.freeze([
  'ingegnere',
  'infermiere',
  'farmacista',
  'ostetrica',
  'educatore',
  'cuoco',
  'psicologo',
  'assistente-sociale',
]);

const SALARY_PROFESSION_ELIGIBLE_ID_SET: ReadonlySet<string> = new Set(SALARY_PROFESSION_ELIGIBLE_IDS);

export function isSalaryEligibleProfessionId(id: AnyProfessionId): boolean {
  return SALARY_PROFESSION_ELIGIBLE_ID_SET.has(id);
}

/**
 * Locale-natural "salary" word that fronts every profession slug. Mirrors the
 * per-locale word `SALARY_STATS_SECTION` uses (`stipendi`/`salaries`/…),
 * singularised to signal "one profession" vs. that family's "all professions".
 */
export const SALARY_PROFESSION_SECTION: Record<ProfessionLocale, string> = {
  it: 'stipendio',
  en: 'salary',
  de: 'gehalt',
  fr: 'salaire',
};

/** Build the canonical path for a salary-intent profession×canton landing. */
export function buildSalaryProfessionCantonPath(
  locale: ProfessionLocale,
  cantonKey: string,
  id: AnyProfessionId,
): string {
  const cantonSlug = SALARY_STATS_CANTON_SLUGS[cantonKey][locale];
  const role = professionRoleKeywordAny(locale, id);
  return `${PROFESSION_LOCALE_PREFIX[locale]}/${SALARY_PROFESSION_SECTION[locale]}-${role}-${cantonSlug}/`
    .replace(/\/{2,}/g, '/');
}

export interface SalaryProfessionCantonPath {
  locale: ProfessionLocale;
  cantonKey: string;
  id: AnyProfessionId;
  path: string;
}

export function listAllSalaryProfessionCantonPaths(): SalaryProfessionCantonPath[] {
  const out: SalaryProfessionCantonPath[] = [];
  for (const locale of PROFESSION_LOCALES) {
    for (const cantonKey of PROFESSION_CANTON_KEYS) {
      for (const id of SALARY_PROFESSION_ELIGIBLE_IDS) {
        out.push({ locale, cantonKey, id, path: buildSalaryProfessionCantonPath(locale, cantonKey, id) });
      }
    }
  }
  return out;
}

export const SALARY_PROFESSION_CANTON_ROUTES: readonly string[] = Object.freeze(
  listAllSalaryProfessionCantonPaths().map((p) => p.path),
);

const PATH_INDEX: ReadonlyMap<string, SalaryProfessionCantonPath> = new Map(
  listAllSalaryProfessionCantonPaths().map((p) => [p.path, p]),
);

function normalizePath(urlPath: string): string {
  const p = String(urlPath || '').split('?')[0].split('#')[0];
  return p.endsWith('/') ? p : `${p}/`;
}

export function parseSalaryProfessionCantonPath(urlPath: string): SalaryProfessionCantonPath | null {
  return PATH_INDEX.get(normalizePath(urlPath)) ?? null;
}

export function isSalaryProfessionCantonPath(urlPath: string): boolean {
  return PATH_INDEX.has(normalizePath(urlPath));
}
