/**
 * Nursing / healthcare SEO landings — slug tables + path matchers.
 *
 * P2 — Target ~3.000 monthly IT searches on the Swiss-Italian healthcare
 * cross-border segment (Semrush IT database). Competitors `beecare.ch` and
 * `asiticino.ch` dominate: we cover none of this vertical. Three hubs:
 *
 *   LANDING_ID           Target keyword cluster
 *   nurses               "lavoro infermiere svizzera" + varianti
 *   oss                  "lavoro oss svizzera", "operatore socio sanitario svizzera"
 *   healthcare-ticino    "lavoro sanitario ticino" — hub EOC / Moncucco / LIS / Luganese / Ticino Cuore
 *
 * All canonical IT paths live at the root (no `/reports/` or other hub
 * prefix). Locale variants get the usual `/en/`, `/de/`, `/fr/` prefix.
 *
 * The router consumes {@link NURSING_LANDING_ROUTES} and
 * {@link parseNursingLandingPath} to resolve these URLs to a `staticOverlay`
 * SPA route, so the build-time static HTML emitted by
 * `nursingLandingsPlugin.ts` stays visible outside `#root` without the SPA
 * replacing it on hydrate.
 */

import {
  NURSING_LANDING_IDS as SHARED_NURSING_LANDING_IDS,
  NURSING_LANDING_SLUGS as SHARED_NURSING_LANDING_SLUGS,
  NURSING_LOCALE_PREFIX as SHARED_NURSING_LOCALE_PREFIX,
  NURSING_LOCALES as SHARED_NURSING_LOCALES,
  NURSING_ORPHAN_QUERY_TARGETS,
  buildNursingLandingPath as buildSharedNursingLandingPath,
  resolveNursingOrphanQueryTarget as resolveSharedNursingOrphanQueryTarget,
} from '../scripts/lib/nursing-landing-path.mjs';

export const NURSING_LOCALES = SHARED_NURSING_LOCALES as readonly ['it', 'en', 'de', 'fr'];
export type NursingLocale = (typeof NURSING_LOCALES)[number];

export const NURSING_LANDING_IDS = SHARED_NURSING_LANDING_IDS as readonly ['nurses', 'oss', 'healthcare-ticino'];
export type NursingLandingId = (typeof NURSING_LANDING_IDS)[number];

export const NURSING_LOCALE_PREFIX: Record<NursingLocale, string> = SHARED_NURSING_LOCALE_PREFIX as Record<NursingLocale, string>;

/**
 * Per-locale slug for each landing. Italian is canonical (no prefix). EN/DE/FR
 * slugs are SEO-friendly translations; the IT keyword intent is preserved
 * (e.g. "lavoro-infermieri-svizzera" → "nursing-jobs-switzerland").
 */
export const NURSING_LANDING_SLUGS: Record<NursingLocale, Record<NursingLandingId, string>> =
  SHARED_NURSING_LANDING_SLUGS as Record<NursingLocale, Record<NursingLandingId, string>>;

/** Explicit GSC orphan-query aliases already served by an evergreen landing. */
export { NURSING_ORPHAN_QUERY_TARGETS };

export function buildNursingLandingPath(locale: NursingLocale, id: NursingLandingId): string {
  return buildSharedNursingLandingPath(locale, id);
}

export interface NursingOrphanQueryTarget {
  locale: NursingLocale;
  id: NursingLandingId;
  path: string;
}

export function resolveNursingOrphanQueryTarget(
  canonicalQuery: string,
  canonicalSlug = '',
): NursingOrphanQueryTarget | null {
  return resolveSharedNursingOrphanQueryTarget(canonicalQuery, canonicalSlug) as NursingOrphanQueryTarget | null;
}

/**
 * Flat list of every canonical (all 4 locales × 3 ids = 12 URLs). Used by the
 * router to fast-match static-overlay routes without walking the slug table.
 */
export const NURSING_LANDING_ROUTES: readonly string[] = NURSING_LOCALES.flatMap((loc) =>
  NURSING_LANDING_IDS.map((id) => buildNursingLandingPath(loc, id)),
);

/**
 * Resolve a pathname to a nursing landing match or return `null`. Accepts
 * paths with or without trailing slash — always normalises to trailing-slash
 * form before lookup so `/lavoro-infermieri-svizzera` and
 * `/lavoro-infermieri-svizzera/` both resolve.
 */
export function parseNursingLandingPath(
  pathname: string,
): { locale: NursingLocale; id: NursingLandingId } | null {
  const normalized = pathname.endsWith('/') ? pathname : `${pathname}/`;
  for (const locale of NURSING_LOCALES) {
    for (const id of NURSING_LANDING_IDS) {
      if (buildNursingLandingPath(locale, id) === normalized) return { locale, id };
    }
  }
  return null;
}

export function isNursingLandingPath(pathname: string): boolean {
  return parseNursingLandingPath(pathname) !== null;
}
