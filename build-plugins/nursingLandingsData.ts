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

export const NURSING_LOCALES = ['it', 'en', 'de', 'fr'] as const;
export type NursingLocale = (typeof NURSING_LOCALES)[number];

export const NURSING_LANDING_IDS = ['nurses', 'oss', 'healthcare-ticino'] as const;
export type NursingLandingId = (typeof NURSING_LANDING_IDS)[number];

export const NURSING_LOCALE_PREFIX: Record<NursingLocale, string> = {
  it: '',
  en: '/en',
  de: '/de',
  fr: '/fr',
};

/**
 * Per-locale slug for each landing. Italian is canonical (no prefix). EN/DE/FR
 * slugs are SEO-friendly translations; the IT keyword intent is preserved
 * (e.g. "lavoro-infermieri-svizzera" → "nursing-jobs-switzerland").
 */
export const NURSING_LANDING_SLUGS: Record<NursingLocale, Record<NursingLandingId, string>> = {
  it: {
    nurses: 'lavoro-infermieri-svizzera',
    oss: 'lavoro-oss-svizzera',
    'healthcare-ticino': 'lavoro-sanitario-ticino',
  },
  en: {
    nurses: 'nursing-jobs-switzerland',
    oss: 'healthcare-assistant-jobs-switzerland',
    'healthcare-ticino': 'healthcare-jobs-ticino',
  },
  de: {
    nurses: 'pflegejobs-schweiz',
    oss: 'pflegehilfe-jobs-schweiz',
    'healthcare-ticino': 'gesundheitsjobs-tessin',
  },
  fr: {
    nurses: 'emplois-infirmiers-suisse',
    oss: 'emplois-aide-soignante-suisse',
    'healthcare-ticino': 'emplois-sante-tessin',
  },
};

export function buildNursingLandingPath(locale: NursingLocale, id: NursingLandingId): string {
  const prefix = NURSING_LOCALE_PREFIX[locale];
  const slug = NURSING_LANDING_SLUGS[locale][id];
  return `${prefix}/${slug}/`.replace(/\/+/g, '/');
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
