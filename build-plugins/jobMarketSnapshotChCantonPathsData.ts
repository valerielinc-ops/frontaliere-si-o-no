/**
 * jobMarketSnapshotChCantonPathsData.ts — browser-safe path data for the
 * per-canton job-market snapshot pages (jobMarketSnapshotChCantonPages.ts,
 * T2.5). Split out because that plugin imports `node:fs`/`node:path`
 * (jobs-pool loading) and is therefore unsafe to bundle into the client —
 * mirrors the exchangeSsgPaths.ts / exchangeRateSsgData.ts split.
 *
 * Every enumerated (locale, canton) pair gets real HTML at build time —
 * either the full snapshot or a below-floor `noindex,follow` bridge at the
 * identical canonical path (renderBelowFloorBridge in the plugin) — so the
 * router can safely recognise the full set without knowing the per-canton
 * job-count floor.
 */

import { SALARY_STATS_CANTON_KEYS, SALARY_STATS_CANTON_SLUGS } from './salaryStatsData';
import { CANTON_JOB_BOARD_PREFIX } from './shared/cantonJobBoardPrefix';

export type ChCantonSnapshotLocale = 'it' | 'en' | 'de' | 'fr';

export const CH_CANTON_SNAPSHOT_LOCALES: readonly ChCantonSnapshotLocale[] = ['it', 'en', 'de', 'fr'];

export const CH_CANTON_SNAPSHOT_LOCALE_PREFIX: Record<ChCantonSnapshotLocale, string> = {
  it: '',
  en: '/en',
  de: '/de',
  fr: '/fr',
};

/** Locale-aware "find-jobs-{canton}" URL segment prefix. */
export const CH_CANTON_SNAPSHOT_JOB_BOARD_PREFIX: Record<ChCantonSnapshotLocale, string> = CANTON_JOB_BOARD_PREFIX;

/** "snapshot" segment — same word in all 4 locales for predictable URL shape. */
export const CH_CANTON_SNAPSHOT_SEGMENT = 'snapshot';

/** Canton keys this family emits for: every URL canton key except Ticino (legacy dedicated pipeline). */
export const CH_CANTON_SNAPSHOT_CANTON_KEYS: readonly string[] = Object.freeze(
  SALARY_STATS_CANTON_KEYS.filter((k) => k !== 'TI'),
);

export function buildCantonSnapshotPath(locale: ChCantonSnapshotLocale, cantonSlug: string): string {
  const prefix = CH_CANTON_SNAPSHOT_LOCALE_PREFIX[locale];
  const board = CH_CANTON_SNAPSHOT_JOB_BOARD_PREFIX[locale];
  return `${prefix}/${board}-${cantonSlug}/${CH_CANTON_SNAPSHOT_SEGMENT}/`.replace(/\/{2,}/g, '/');
}

export interface ChCantonSnapshotPath {
  locale: ChCantonSnapshotLocale;
  cantonKey: string;
  path: string;
}

function normalizePath(urlPath: string): string {
  const p = String(urlPath || '').split('?')[0].split('#')[0];
  return p.endsWith('/') ? p : `${p}/`;
}

const PATH_INDEX: ReadonlyMap<string, ChCantonSnapshotPath> = new Map(
  CH_CANTON_SNAPSHOT_LOCALES.flatMap((locale) =>
    CH_CANTON_SNAPSHOT_CANTON_KEYS.map((cantonKey) => {
      const cantonSlug = SALARY_STATS_CANTON_SLUGS[cantonKey][locale];
      const path = buildCantonSnapshotPath(locale, cantonSlug);
      return [path, { locale, cantonKey, path }] as const;
    }),
  ),
);

export function isChCantonSnapshotPath(urlPath: string): boolean {
  return PATH_INDEX.has(normalizePath(urlPath));
}

export function parseChCantonSnapshotPath(urlPath: string): ChCantonSnapshotPath | null {
  return PATH_INDEX.get(normalizePath(urlPath)) ?? null;
}
