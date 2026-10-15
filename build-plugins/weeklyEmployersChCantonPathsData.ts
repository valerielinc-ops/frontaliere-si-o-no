/**
 * weeklyEmployersChCantonPathsData.ts — browser-safe path data for the
 * per-canton "companies hiring" pages (weeklyEmployersChCantonPages.ts).
 * Split out because that plugin imports `node:fs`/`node:path` (jobs-pool +
 * canton-slug-file loading) and is therefore unsafe to bundle into the
 * client — mirrors the exchangeSsgPaths.ts / exchangeRateSsgData.ts split
 * and jobMarketSnapshotChCantonPathsData.ts (same canton family).
 *
 * Every enumerated (locale, canton) pair gets real HTML at build time —
 * either the full page or a below-floor `noindex,follow` bridge at the
 * identical canonical path (renderBelowFloorBridge in the plugin) — so the
 * router can safely recognise the full set without knowing the per-canton
 * job-count floor.
 */

import { SALARY_STATS_CANTON_KEYS, SALARY_STATS_CANTON_SLUGS } from './salaryStatsData';
import { CANTON_JOB_BOARD_PREFIX } from './shared/cantonJobBoardPrefix';
import { WEEKLY_EMPLOYERS_LOCALE_PREFIX, WEEKLY_EMPLOYERS_SECTION, type WeeklyEmployersLocale } from './weeklyEmployersData';

export type { WeeklyEmployersLocale as ChCantonEmployersLocale };

export const CH_CANTON_EMPLOYERS_LOCALES: readonly WeeklyEmployersLocale[] = ['it', 'en', 'de', 'fr'];

export const CH_CANTON_EMPLOYERS_LOCALE_PREFIX: Record<WeeklyEmployersLocale, string> = WEEKLY_EMPLOYERS_LOCALE_PREFIX;

export const CH_CANTON_EMPLOYERS_JOB_BOARD_PREFIX: Record<WeeklyEmployersLocale, string> = CANTON_JOB_BOARD_PREFIX;

/** Canton keys this family emits for: every URL canton key except Ticino (legacy dedicated pipeline). */
export const CH_CANTON_EMPLOYERS_CANTON_KEYS: readonly string[] = Object.freeze(
  SALARY_STATS_CANTON_KEYS.filter((k) => k !== 'TI'),
);

export function buildCantonEmployersPath(locale: WeeklyEmployersLocale, cantonSlug: string): string {
  const prefix = CH_CANTON_EMPLOYERS_LOCALE_PREFIX[locale];
  const board = CH_CANTON_EMPLOYERS_JOB_BOARD_PREFIX[locale];
  return `${prefix}/${board}-${cantonSlug}/${WEEKLY_EMPLOYERS_SECTION[locale]}/`.replace(/\/{2,}/g, '/');
}

export interface ChCantonEmployersPath {
  locale: WeeklyEmployersLocale;
  cantonKey: string;
  path: string;
}

function normalizePath(urlPath: string): string {
  const p = String(urlPath || '').split('?')[0].split('#')[0];
  return p.endsWith('/') ? p : `${p}/`;
}

const PATH_INDEX: ReadonlyMap<string, ChCantonEmployersPath> = new Map(
  CH_CANTON_EMPLOYERS_LOCALES.flatMap((locale) =>
    CH_CANTON_EMPLOYERS_CANTON_KEYS.map((cantonKey) => {
      const cantonSlug = SALARY_STATS_CANTON_SLUGS[cantonKey][locale];
      const path = buildCantonEmployersPath(locale, cantonSlug);
      return [path, { locale, cantonKey, path }] as const;
    }),
  ),
);

export function isChCantonEmployersPath(urlPath: string): boolean {
  return PATH_INDEX.has(normalizePath(urlPath));
}

export function parseChCantonEmployersPath(urlPath: string): ChCantonEmployersPath | null {
  return PATH_INDEX.get(normalizePath(urlPath)) ?? null;
}
