/**
 * Border-wait page data: slug maps, path builders, route enumeration.
 *
 * F8 — The TomTom→Firestore pipeline (functions/src/trafficSchedulerCore.js,
 * scripts/collect-traffic.mjs, .github/workflows/traffic-scheduler.yml) already
 * collects per-crossing wait times every 15 min in commuter peak hours and
 * writes them to Firestore (`trafficCurrent/{slug}` + `trafficHistory/{slug}/
 * snapshots/{snapshotId}`). What was missing: static HTML pages so Google can
 * index the time-sensitive "coda dogana {valico} oggi" intent.
 *
 * URL structure (mirror of F6 fuel-daily):
 *   IT root:          /traffico-dogane/
 *   IT regional hubs: /traffico-dogane/ticino-como/ + /traffico-dogane/ticino-varese/
 *   IT per-crossing:  /traffico-dogane/{crossing}/oggi/
 *   IT month archive: /traffico-dogane/{crossing}/2026-04/  (top-5 crossings only)
 *
 *   EN: /en/border-wait/... + /today/
 *   DE: /de/wartezeit-grenze/... + /heute/
 *   FR: /fr/temps-attente-douane/... + /aujourd-hui/
 *
 * No I/O, no side effects — tests can import directly.
 */

// ── Types ─────────────────────────────────────────────────────────

export type BorderWaitLocale = 'it' | 'en' | 'de' | 'fr';

/**
 * Crossing IDs mirror `services/router.ts#ALL_BORDER_CROSSING_IDS` 1:1 —
 * kept duplicated here (not imported) to avoid a cycle with router.ts, which
 * itself imports from this module.
 */
export type BorderCrossingSlug =
  | 'chiasso-centro'
  | 'chiasso-brogeda'
  | 'chiasso-strada'
  | 'maslianico-pizzamiglio'
  | 'maslianico-roggiana'
  | 'bizzarone-novazzano'
  | 'ronago-novazzano'
  | 'crociale-dei-mulini'
  | 'drezzo-pedrinate'
  | 'lanzo-d-intelvi-arogno'
  | 'campione-d-italia-bissone'
  | 'oria-gandria'
  | 'gaggiolo'
  | 'san-pietro'
  | 'clivio-ligornetto'
  | 'rodero-stabio'
  | 'saltrio-arzo'
  | 'ponte-tresa'
  | 'porto-ceresio-brusino'
  | 'cremenaga-ponte-cremenaga'
  | 'luino-fornasette'
  | 'zenna-dirinella'
  | 'biegno-indemini'
  | 'dumenza-cassinone';

export type BorderCrossingRegion = 'ticino-como' | 'ticino-varese';

export const BORDER_WAIT_LOCALES: readonly BorderWaitLocale[] = ['it', 'en', 'de', 'fr'] as const;

/** Full crossing registry (24) — must match ALL_BORDER_CROSSING_IDS in router.ts. */
export const BORDER_WAIT_CROSSINGS: readonly BorderCrossingSlug[] = [
  'chiasso-centro',
  'chiasso-brogeda',
  'chiasso-strada',
  'maslianico-pizzamiglio',
  'maslianico-roggiana',
  'bizzarone-novazzano',
  'ronago-novazzano',
  'crociale-dei-mulini',
  'drezzo-pedrinate',
  'lanzo-d-intelvi-arogno',
  'campione-d-italia-bissone',
  'oria-gandria',
  'gaggiolo',
  'san-pietro',
  'clivio-ligornetto',
  'rodero-stabio',
  'saltrio-arzo',
  'ponte-tresa',
  'porto-ceresio-brusino',
  'cremenaga-ponte-cremenaga',
  'luino-fornasette',
  'zenna-dirinella',
  'biegno-indemini',
  'dumenza-cassinone',
] as const;

/** Top-5 crossings eligible for monthly archive pages (highest GSC demand). */
export const TOP_5_CROSSINGS: readonly BorderCrossingSlug[] = [
  'chiasso-brogeda',
  'chiasso-centro',
  'gaggiolo',
  'oria-gandria',
  'ponte-tresa',
] as const;

/** Display names — proper nouns, same across all locales. */
export const BORDER_CROSSING_DISPLAY: Record<BorderCrossingSlug, string> = {
  'chiasso-centro': 'Chiasso Centro',
  'chiasso-brogeda': 'Chiasso Brogeda',
  'chiasso-strada': 'Chiasso Strada',
  'maslianico-pizzamiglio': 'Maslianico Pizzamiglio',
  'maslianico-roggiana': 'Maslianico Roggiana',
  'bizzarone-novazzano': 'Bizzarone Novazzano',
  'ronago-novazzano': 'Ronago Novazzano',
  'crociale-dei-mulini': 'Crociale dei Mulini',
  'drezzo-pedrinate': 'Drezzo Pedrinate',
  'lanzo-d-intelvi-arogno': "Lanzo d'Intelvi Arogno",
  'campione-d-italia-bissone': "Campione d'Italia Bissone",
  'oria-gandria': 'Oria Gandria',
  gaggiolo: 'Gaggiolo (Cantello-Stabio)',
  'san-pietro': 'San Pietro (Clivio-Stabio)',
  'clivio-ligornetto': 'Clivio Ligornetto',
  'rodero-stabio': 'Rodero Stabio',
  'saltrio-arzo': 'Saltrio Arzo',
  'ponte-tresa': 'Ponte Tresa',
  'porto-ceresio-brusino': 'Porto Ceresio Brusino',
  'cremenaga-ponte-cremenaga': 'Cremenaga Ponte Cremenaga',
  'luino-fornasette': 'Luino Fornasette',
  'zenna-dirinella': 'Zenna Dirinella',
  'biegno-indemini': 'Biegno Indemini',
  'dumenza-cassinone': 'Dumenza Cassinone',
};

/** Regional grouping by Italian province. */
export const CROSSING_TO_REGION: Record<BorderCrossingSlug, BorderCrossingRegion> = {
  'chiasso-centro': 'ticino-como',
  'chiasso-brogeda': 'ticino-como',
  'chiasso-strada': 'ticino-como',
  'maslianico-pizzamiglio': 'ticino-como',
  'maslianico-roggiana': 'ticino-como',
  'bizzarone-novazzano': 'ticino-como',
  'ronago-novazzano': 'ticino-como',
  'crociale-dei-mulini': 'ticino-como',
  'drezzo-pedrinate': 'ticino-como',
  'lanzo-d-intelvi-arogno': 'ticino-como',
  'campione-d-italia-bissone': 'ticino-como',
  'oria-gandria': 'ticino-como',
  gaggiolo: 'ticino-varese',
  'san-pietro': 'ticino-varese',
  'clivio-ligornetto': 'ticino-varese',
  'rodero-stabio': 'ticino-varese',
  'saltrio-arzo': 'ticino-varese',
  'ponte-tresa': 'ticino-varese',
  'porto-ceresio-brusino': 'ticino-varese',
  'cremenaga-ponte-cremenaga': 'ticino-varese',
  'luino-fornasette': 'ticino-varese',
  'zenna-dirinella': 'ticino-varese',
  'biegno-indemini': 'ticino-varese',
  'dumenza-cassinone': 'ticino-varese',
};

/** Closest fuel-daily zone for each crossing (used by related-links helper). */
export const CROSSING_TO_FUEL_ZONE: Record<BorderCrossingSlug, 'chiasso' | 'mendrisio' | 'lugano'> = {
  'chiasso-centro': 'chiasso',
  'chiasso-brogeda': 'chiasso',
  'chiasso-strada': 'chiasso',
  'maslianico-pizzamiglio': 'chiasso',
  'maslianico-roggiana': 'chiasso',
  'bizzarone-novazzano': 'chiasso',
  'ronago-novazzano': 'chiasso',
  'crociale-dei-mulini': 'chiasso',
  'drezzo-pedrinate': 'chiasso',
  'lanzo-d-intelvi-arogno': 'lugano',
  'campione-d-italia-bissone': 'lugano',
  'oria-gandria': 'lugano',
  gaggiolo: 'mendrisio',
  'san-pietro': 'mendrisio',
  'clivio-ligornetto': 'mendrisio',
  'rodero-stabio': 'mendrisio',
  'saltrio-arzo': 'mendrisio',
  'ponte-tresa': 'lugano',
  'porto-ceresio-brusino': 'lugano',
  'cremenaga-ponte-cremenaga': 'lugano',
  'luino-fornasette': 'lugano',
  'zenna-dirinella': 'lugano',
  'biegno-indemini': 'lugano',
  'dumenza-cassinone': 'lugano',
};

/** Closest weekly-employers city slug for each crossing. */
export const CROSSING_TO_WEEKLY_CITY: Record<
  BorderCrossingSlug,
  'chiasso' | 'mendrisio' | 'lugano'
> = {
  'chiasso-centro': 'chiasso',
  'chiasso-brogeda': 'chiasso',
  'chiasso-strada': 'chiasso',
  'maslianico-pizzamiglio': 'chiasso',
  'maslianico-roggiana': 'chiasso',
  'bizzarone-novazzano': 'chiasso',
  'ronago-novazzano': 'chiasso',
  'crociale-dei-mulini': 'chiasso',
  'drezzo-pedrinate': 'chiasso',
  'lanzo-d-intelvi-arogno': 'lugano',
  'campione-d-italia-bissone': 'lugano',
  'oria-gandria': 'lugano',
  gaggiolo: 'mendrisio',
  'san-pietro': 'mendrisio',
  'clivio-ligornetto': 'mendrisio',
  'rodero-stabio': 'mendrisio',
  'saltrio-arzo': 'mendrisio',
  'ponte-tresa': 'lugano',
  'porto-ceresio-brusino': 'lugano',
  'cremenaga-ponte-cremenaga': 'lugano',
  'luino-fornasette': 'lugano',
  'zenna-dirinella': 'lugano',
  'biegno-indemini': 'lugano',
  'dumenza-cassinone': 'lugano',
};

// ── URL slug tables ───────────────────────────────────────────────

export const BORDER_WAIT_LOCALE_PREFIX: Record<BorderWaitLocale, string> = {
  it: '',
  en: '/en',
  de: '/de',
  fr: '/fr',
};

/** Top-level section slug per locale. */
export const BORDER_WAIT_SECTION: Record<BorderWaitLocale, string> = {
  it: 'traffico-dogane',
  en: 'border-wait',
  de: 'wartezeit-grenze',
  fr: 'temps-attente-douane',
};

/** "Today" keyword per locale. */
export const BORDER_WAIT_TODAY_SLUG: Record<BorderWaitLocale, string> = {
  it: 'oggi',
  en: 'today',
  de: 'heute',
  fr: 'aujourd-hui',
};

/** Regional hub slugs (ticino-como / ticino-varese) — same across locales. */
export const BORDER_WAIT_REGIONS: readonly BorderCrossingRegion[] = ['ticino-como', 'ticino-varese'] as const;

export const BORDER_REGION_DISPLAY: Record<BorderCrossingRegion, string> = {
  'ticino-como': 'Ticino — Como',
  'ticino-varese': 'Ticino — Varese',
};

// ── Path builders ─────────────────────────────────────────────────

function joinPath(parts: string[]): string {
  const nonEmpty = parts.map((p) => String(p).replace(/^\/+|\/+$/g, '')).filter((p) => p.length > 0);
  return '/' + nonEmpty.join('/') + '/';
}

/** Build the canonical path for a per-crossing "today" page. */
export function buildOggiPath(locale: BorderWaitLocale, crossing: BorderCrossingSlug): string {
  return joinPath([
    BORDER_WAIT_LOCALE_PREFIX[locale],
    BORDER_WAIT_SECTION[locale],
    crossing,
    BORDER_WAIT_TODAY_SLUG[locale],
  ]);
}

/** Root hub: /traffico-dogane/ etc. */
export function buildRootHubPath(locale: BorderWaitLocale): string {
  return joinPath([BORDER_WAIT_LOCALE_PREFIX[locale], BORDER_WAIT_SECTION[locale]]);
}

/** Regional hub: /traffico-dogane/ticino-como/ etc. */
export function buildRegionalHubPath(locale: BorderWaitLocale, region: BorderCrossingRegion): string {
  return joinPath([BORDER_WAIT_LOCALE_PREFIX[locale], BORDER_WAIT_SECTION[locale], region]);
}

/** Monthly archive: /traffico-dogane/{crossing}/2026-04/. */
export function buildArchivePath(
  locale: BorderWaitLocale,
  crossing: BorderCrossingSlug,
  monthKey: string,
): string {
  return joinPath([
    BORDER_WAIT_LOCALE_PREFIX[locale],
    BORDER_WAIT_SECTION[locale],
    crossing,
    monthKey,
  ]);
}

// ── Route enumeration ─────────────────────────────────────────────

/**
 * All canonical "today" routes — regional hubs + per-crossing. Imported by
 * services/router.ts so unknown `/traffico-dogane/...` URLs resolve to a known
 * route (guida/border sub-tab) instead of falling through to 404.
 *
 * Count: 4 locales × (1 root + 2 regional + 24 crossings) = 108 canonical paths.
 */
export const BORDER_WAIT_ROUTES: readonly string[] = (() => {
  const out: string[] = [];
  for (const locale of BORDER_WAIT_LOCALES) {
    out.push(buildRootHubPath(locale));
    for (const region of BORDER_WAIT_REGIONS) {
      out.push(buildRegionalHubPath(locale, region));
    }
    for (const crossing of BORDER_WAIT_CROSSINGS) {
      out.push(buildOggiPath(locale, crossing));
    }
  }
  return out;
})();

const BORDER_WAIT_ROUTE_SET: ReadonlySet<string> = new Set(BORDER_WAIT_ROUTES);

/** O(1) router matcher (accepts paths with or without trailing slash). */
export function isBorderWaitPath(pathname: string): boolean {
  if (!pathname) return false;
  const leading = pathname.startsWith('/') ? pathname : `/${pathname}`;
  const normalised = leading.endsWith('/') ? leading : `${leading}/`;
  if (BORDER_WAIT_ROUTE_SET.has(normalised)) return true;
  return isBorderWaitArchivePath(normalised);
}

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const CROSSING_SET: ReadonlySet<string> = new Set(BORDER_WAIT_CROSSINGS as readonly string[]);

/** Return true when the path ends in /YYYY-MM/ under a border-wait section. */
export function isBorderWaitArchivePath(pathname: string): boolean {
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length < 3) return false;
  let idx = 0;
  if (parts[0] === 'en' || parts[0] === 'de' || parts[0] === 'fr') idx = 1;
  const section = parts[idx];
  const matchesSection = BORDER_WAIT_LOCALES.some((l) => BORDER_WAIT_SECTION[l] === section);
  if (!matchesSection) return false;
  const crossing = parts[idx + 1];
  const month = parts[idx + 2];
  if (!crossing || !CROSSING_SET.has(crossing)) return false;
  if (!month || !MONTH_PATTERN.test(month)) return false;
  return idx + 2 === parts.length - 1;
}

// ── Path parser ───────────────────────────────────────────────────

export interface ParsedBorderWaitPath {
  locale: BorderWaitLocale;
  crossing?: BorderCrossingSlug;
  region?: BorderCrossingRegion;
  monthKey?: string;
  isRoot?: boolean;
  isToday?: boolean;
  isRegional?: boolean;
  isArchive?: boolean;
}

/**
 * Reverse-lookup: given a pathname, return its parsed form if it matches a
 * border-wait route shape, else null. Used by services/router.ts.
 */
export function parseBorderWaitPath(pathname: string): ParsedBorderWaitPath | null {
  if (!pathname) return null;
  const leading = pathname.startsWith('/') ? pathname : `/${pathname}`;
  const normalised = leading.endsWith('/') ? leading : `${leading}/`;
  const parts = normalised.split('/').filter(Boolean);
  if (parts.length === 0) return null;

  // Detect locale prefix
  let locale: BorderWaitLocale = 'it';
  let idx = 0;
  if (parts[0] === 'en' || parts[0] === 'de' || parts[0] === 'fr') {
    locale = parts[0] as BorderWaitLocale;
    idx = 1;
  }

  // Section must match the locale's section slug
  const section = parts[idx];
  if (section !== BORDER_WAIT_SECTION[locale]) return null;
  idx++;

  // Root hub: /traffico-dogane/
  if (idx === parts.length) {
    return { locale, isRoot: true };
  }

  // /traffico-dogane/ticino-como/ — regional hub
  const maybeRegion = parts[idx] as BorderCrossingRegion;
  if ((BORDER_WAIT_REGIONS as readonly string[]).includes(maybeRegion) && idx === parts.length - 1) {
    return { locale, region: maybeRegion, isRegional: true };
  }

  // /traffico-dogane/{crossing}/{oggi|YYYY-MM}
  const maybeCrossing = parts[idx] as BorderCrossingSlug;
  if (!CROSSING_SET.has(maybeCrossing)) return null;
  idx++;
  if (idx >= parts.length) return null;

  const tail = parts[idx];
  if (tail === BORDER_WAIT_TODAY_SLUG[locale] && idx === parts.length - 1) {
    return { locale, crossing: maybeCrossing, isToday: true };
  }
  if (MONTH_PATTERN.test(tail) && idx === parts.length - 1) {
    return { locale, crossing: maybeCrossing, monthKey: tail, isArchive: true };
  }
  return null;
}
