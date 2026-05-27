/**
 * Health-premium landing page data: slug maps, age brackets, path builders.
 *
 * F2 — LAMal evergreen SEO moat.
 *
 * GSC evidence: ~10 imp/month on "premi cassa malati ticino 2026",
 * "lamal preise tessin", "primes lamal 2026". Low-volume but evergreen with
 * annual refresh + long-tail compounding. Generates 183 pages per locale
 * (26 canton hubs + 156 leaves + 1 root) × 4 locales = 732 static HTML pages
 * covering every Swiss canton published by BAG open-data.
 *
 * URL shape:
 *   IT: /premi-cassa-malati/ , /premi-cassa-malati/{canton}/, /premi-cassa-malati/{canton}/{age}/
 *   EN: /en/health-insurance-premiums/ , /en/health-insurance-premiums/{canton}/{age}/
 *   DE: /de/krankenkassenpraemien/ , ...
 *   FR: /fr/primes-assurance-maladie/ , ...
 *
 * Canton slugs are localized to the native exonym where it differs across
 * locales (zurigo/zurich/zuerich, grigioni/grisons/graubuenden). For the
 * original 5 target cantons (ticino, grigioni, uri, vallese, zurigo) the
 * exact slug strings shipped pre-expansion are preserved byte-for-byte to
 * protect URL equity on already-indexed pages.
 *
 * Kept standalone (no dep on jobsSeoPagesPlugin etc.) so parallel worktrees
 * merge cleanly — see memory/feedback_worktree_merge_router_duplicates.
 */

export type HealthPremiumLocale = 'it' | 'en' | 'de' | 'fr';

/**
 * Internal canton identifier. Uses the Italian exonym / stable short form so
 * the identifier itself is locale-neutral — the URL slug, display label and
 * BAG 2-letter code are all derived via the lookup tables below.
 *
 * The first five values (ticino, grigioni, uri, vallese, zurigo) are the
 * original F2 target set; their URL slugs in every locale are frozen for
 * backward compatibility with already-indexed pages. The remaining 21 canton
 * identifiers were introduced by B-cont-2 to expand coverage to every Swiss
 * canton published by BAG open-data.
 */
export type HealthPremiumCanton =
  | 'ticino'
  | 'grigioni'
  | 'uri'
  | 'vallese'
  | 'zurigo'
  | 'argovia'
  | 'appenzello-interno'
  | 'appenzello-esterno'
  | 'berna'
  | 'basilea-campagna'
  | 'basilea-citta'
  | 'friborgo'
  | 'ginevra'
  | 'glarona'
  | 'giura'
  | 'lucerna'
  | 'neuchatel'
  | 'nidvaldo'
  | 'obvaldo'
  | 'san-gallo'
  | 'sciaffusa'
  | 'soletta'
  | 'svitto'
  | 'turgovia'
  | 'vaud'
  | 'zugo';

/**
 * LAMal age brackets. Under Swiss LAMal law the adult premium (26+) is flat —
 * 31-45, 46-55, 56-plus all receive the identical AKL-ERW rate. 0-18 and
 * 19-25 carry dedicated risk classes (AKL-KIN, AKL-JUG) that every insurer
 * prices independently; the dataset persists those real per-insurer values
 * when available and falls back to statutory multipliers only when the BAG
 * feed does not expose the class for a given insurer × region pair.
 */
export type HealthPremiumAgeBracket = '0-18' | '19-25' | '26-30' | '31-45' | '46-55' | '56-plus';

/**
 * BAG risk class that maps to each age bracket. KIN (Kinder) covers 0-18,
 * JUG (Junge Erwachsene) covers 19-25, ERW (Erwachsene) covers 26+.
 */
export type HealthPremiumRiskClass = 'KIN' | 'JUG' | 'ERW';

export const HEALTH_PREMIUM_BRACKET_RISK_CLASS: Record<HealthPremiumAgeBracket, HealthPremiumRiskClass> = {
  '0-18': 'KIN',
  '19-25': 'JUG',
  '26-30': 'ERW',
  '31-45': 'ERW',
  '46-55': 'ERW',
  '56-plus': 'ERW',
};

export interface HealthPremiumAgeDef {
  id: HealthPremiumAgeBracket;
  /** Inclusive min age */
  min: number;
  /** Inclusive max age (null = open-ended) */
  max: number | null;
}

export const HEALTH_PREMIUM_LOCALES: readonly HealthPremiumLocale[] = ['it', 'en', 'de', 'fr'] as const;

/**
 * Canonical ordering: the original 5 target cantons first (so their index in
 * the array is unchanged from pre-B-cont-2 builds), followed by the 21 new
 * cantons in alphabetical order of the internal identifier. Keep this order
 * stable — tests, hub grids and related-links sibling pickers walk it.
 */
export const HEALTH_PREMIUM_CANTONS: readonly HealthPremiumCanton[] = [
  // Original F2 target set — slugs frozen for backward compatibility.
  'ticino',
  'grigioni',
  'uri',
  'vallese',
  'zurigo',
  // B-cont-2 expansion — remaining 21 Swiss cantons.
  'argovia',
  'appenzello-interno',
  'appenzello-esterno',
  'berna',
  'basilea-campagna',
  'basilea-citta',
  'friborgo',
  'ginevra',
  'glarona',
  'giura',
  'lucerna',
  'neuchatel',
  'nidvaldo',
  'obvaldo',
  'san-gallo',
  'sciaffusa',
  'soletta',
  'svitto',
  'turgovia',
  'vaud',
  'zugo',
] as const;

export const HEALTH_PREMIUM_AGE_BRACKETS: readonly HealthPremiumAgeDef[] = [
  { id: '0-18', min: 0, max: 18 },
  { id: '19-25', min: 19, max: 25 },
  { id: '26-30', min: 26, max: 30 },
  { id: '31-45', min: 31, max: 45 },
  { id: '46-55', min: 46, max: 55 },
  { id: '56-plus', min: 56, max: null },
] as const;

/**
 * BAG 2-letter canton code for each hub. Used to index into
 * `data/health-premiums.json` entries (either canton-level `"type":"canton"`
 * blocks or commune-level blocks under `premiums[{plz}-{name}]`).
 */
export const HEALTH_PREMIUM_CANTON_BAG_CODE: Record<HealthPremiumCanton, string> = {
  ticino: 'TI',
  grigioni: 'GR',
  uri: 'UR',
  vallese: 'VS',
  zurigo: 'ZH',
  argovia: 'AG',
  'appenzello-interno': 'AI',
  'appenzello-esterno': 'AR',
  berna: 'BE',
  'basilea-campagna': 'BL',
  'basilea-citta': 'BS',
  friborgo: 'FR',
  ginevra: 'GE',
  glarona: 'GL',
  giura: 'JU',
  lucerna: 'LU',
  neuchatel: 'NE',
  nidvaldo: 'NW',
  obvaldo: 'OW',
  'san-gallo': 'SG',
  sciaffusa: 'SH',
  soletta: 'SO',
  svitto: 'SZ',
  turgovia: 'TG',
  vaud: 'VD',
  zugo: 'ZG',
};

/**
 * Display names per locale. Canton names are proper nouns but they have
 * genuine native translations (Graubünden / Grisons, Wallis / Valais, etc.)
 * so we localise the label even when the URL slug stays stable.
 */
export const HEALTH_PREMIUM_CANTON_DISPLAY: Record<HealthPremiumLocale, Record<HealthPremiumCanton, string>> = {
  it: {
    ticino: 'Ticino',
    grigioni: 'Grigioni',
    uri: 'Uri',
    vallese: 'Vallese',
    zurigo: 'Zurigo',
    argovia: 'Argovia',
    'appenzello-interno': 'Appenzello Interno',
    'appenzello-esterno': 'Appenzello Esterno',
    berna: 'Berna',
    'basilea-campagna': 'Basilea Campagna',
    'basilea-citta': 'Basilea Città',
    friborgo: 'Friborgo',
    ginevra: 'Ginevra',
    glarona: 'Glarona',
    giura: 'Giura',
    lucerna: 'Lucerna',
    neuchatel: 'Neuchâtel',
    nidvaldo: 'Nidvaldo',
    obvaldo: 'Obvaldo',
    'san-gallo': 'San Gallo',
    sciaffusa: 'Sciaffusa',
    soletta: 'Soletta',
    svitto: 'Svitto',
    turgovia: 'Turgovia',
    vaud: 'Vaud',
    zugo: 'Zugo',
  },
  en: {
    ticino: 'Ticino',
    grigioni: 'Graubünden',
    uri: 'Uri',
    vallese: 'Valais',
    zurigo: 'Zurich',
    argovia: 'Aargau',
    'appenzello-interno': 'Appenzell Innerrhoden',
    'appenzello-esterno': 'Appenzell Ausserrhoden',
    berna: 'Bern',
    'basilea-campagna': 'Basel-Landschaft',
    'basilea-citta': 'Basel-Stadt',
    friborgo: 'Fribourg',
    ginevra: 'Geneva',
    glarona: 'Glarus',
    giura: 'Jura',
    lucerna: 'Lucerne',
    neuchatel: 'Neuchâtel',
    nidvaldo: 'Nidwalden',
    obvaldo: 'Obwalden',
    'san-gallo': 'St. Gallen',
    sciaffusa: 'Schaffhausen',
    soletta: 'Solothurn',
    svitto: 'Schwyz',
    turgovia: 'Thurgau',
    vaud: 'Vaud',
    zugo: 'Zug',
  },
  de: {
    ticino: 'Tessin',
    grigioni: 'Graubünden',
    uri: 'Uri',
    vallese: 'Wallis',
    zurigo: 'Zürich',
    argovia: 'Aargau',
    'appenzello-interno': 'Appenzell Innerrhoden',
    'appenzello-esterno': 'Appenzell Ausserrhoden',
    berna: 'Bern',
    'basilea-campagna': 'Basel-Landschaft',
    'basilea-citta': 'Basel-Stadt',
    friborgo: 'Freiburg',
    ginevra: 'Genf',
    glarona: 'Glarus',
    giura: 'Jura',
    lucerna: 'Luzern',
    neuchatel: 'Neuenburg',
    nidvaldo: 'Nidwalden',
    obvaldo: 'Obwalden',
    'san-gallo': 'St. Gallen',
    sciaffusa: 'Schaffhausen',
    soletta: 'Solothurn',
    svitto: 'Schwyz',
    turgovia: 'Thurgau',
    vaud: 'Waadt',
    zugo: 'Zug',
  },
  fr: {
    ticino: 'Tessin',
    grigioni: 'Grisons',
    uri: 'Uri',
    vallese: 'Valais',
    zurigo: 'Zurich',
    argovia: 'Argovie',
    'appenzello-interno': 'Appenzell Rhodes-Intérieures',
    'appenzello-esterno': 'Appenzell Rhodes-Extérieures',
    berna: 'Berne',
    'basilea-campagna': 'Bâle-Campagne',
    'basilea-citta': 'Bâle-Ville',
    friborgo: 'Fribourg',
    ginevra: 'Genève',
    glarona: 'Glaris',
    giura: 'Jura',
    lucerna: 'Lucerne',
    neuchatel: 'Neuchâtel',
    nidvaldo: 'Nidwald',
    obvaldo: 'Obwald',
    'san-gallo': 'Saint-Gall',
    sciaffusa: 'Schaffhouse',
    soletta: 'Soleure',
    svitto: 'Schwytz',
    turgovia: 'Thurgovie',
    vaud: 'Vaud',
    zugo: 'Zoug',
  },
};

/**
 * URL slug per locale × canton. All slugs are ASCII-safe kebab-case (no
 * diacritics, no spaces, no uppercase) to match search-engine URL hygiene
 * and avoid percent-encoding in the canonical path.
 *
 * CRITICAL — do NOT change the slug strings for the original 5 cantons
 * (ticino, grigioni, uri, vallese, zurigo). They are already indexed by
 * Google under these exact URLs and any change would cause a 404 / de-index
 * cascade. The 21 B-cont-2 cantons use native exonyms per locale (sciaffusa
 * / schaffhausen / schaffhouse, etc.) to catch long-tail queries in each
 * market's search language.
 */
export const HEALTH_PREMIUM_CANTON_SLUG: Record<HealthPremiumLocale, Record<HealthPremiumCanton, string>> = {
  it: {
    // Original 5 — slugs frozen, do NOT edit.
    ticino: 'ticino',
    grigioni: 'grigioni',
    uri: 'uri',
    vallese: 'vallese',
    zurigo: 'zurigo',
    // B-cont-2 additions — Italian exonyms.
    argovia: 'argovia',
    'appenzello-interno': 'appenzello-interno',
    'appenzello-esterno': 'appenzello-esterno',
    berna: 'berna',
    'basilea-campagna': 'basilea-campagna',
    'basilea-citta': 'basilea-citta',
    friborgo: 'friborgo',
    ginevra: 'ginevra',
    glarona: 'glarona',
    giura: 'giura',
    lucerna: 'lucerna',
    neuchatel: 'neuchatel',
    nidvaldo: 'nidvaldo',
    obvaldo: 'obvaldo',
    'san-gallo': 'san-gallo',
    sciaffusa: 'sciaffusa',
    soletta: 'soletta',
    svitto: 'svitto',
    turgovia: 'turgovia',
    vaud: 'vaud',
    zugo: 'zugo',
  },
  en: {
    // Original 5 — slugs frozen.
    ticino: 'ticino',
    grigioni: 'graubunden',
    uri: 'uri',
    vallese: 'valais',
    zurigo: 'zurich',
    // B-cont-2 additions — English forms.
    argovia: 'aargau',
    'appenzello-interno': 'appenzell-innerrhoden',
    'appenzello-esterno': 'appenzell-ausserrhoden',
    berna: 'bern',
    'basilea-campagna': 'basel-landschaft',
    'basilea-citta': 'basel-stadt',
    friborgo: 'fribourg',
    ginevra: 'geneva',
    glarona: 'glarus',
    giura: 'jura',
    lucerna: 'lucerne',
    neuchatel: 'neuchatel',
    nidvaldo: 'nidwalden',
    obvaldo: 'obwalden',
    'san-gallo': 'st-gallen',
    sciaffusa: 'schaffhausen',
    soletta: 'solothurn',
    svitto: 'schwyz',
    turgovia: 'thurgau',
    vaud: 'vaud',
    zugo: 'zug',
  },
  de: {
    // Original 5 — slugs frozen.
    ticino: 'tessin',
    grigioni: 'graubuenden',
    uri: 'uri',
    vallese: 'wallis',
    zurigo: 'zuerich',
    // B-cont-2 additions — German forms (umlaut → oe/ae/ue transliteration).
    argovia: 'aargau',
    'appenzello-interno': 'appenzell-innerrhoden',
    'appenzello-esterno': 'appenzell-ausserrhoden',
    berna: 'bern',
    'basilea-campagna': 'basel-landschaft',
    'basilea-citta': 'basel-stadt',
    friborgo: 'freiburg',
    ginevra: 'genf',
    glarona: 'glarus',
    giura: 'jura',
    lucerna: 'luzern',
    neuchatel: 'neuenburg',
    nidvaldo: 'nidwalden',
    obvaldo: 'obwalden',
    'san-gallo': 'st-gallen',
    sciaffusa: 'schaffhausen',
    soletta: 'solothurn',
    svitto: 'schwyz',
    turgovia: 'thurgau',
    vaud: 'waadt',
    zugo: 'zug',
  },
  fr: {
    // Original 5 — slugs frozen.
    ticino: 'tessin',
    grigioni: 'grisons',
    uri: 'uri',
    vallese: 'valais',
    zurigo: 'zurich',
    // B-cont-2 additions — French forms (accents stripped for URL hygiene).
    argovia: 'argovie',
    'appenzello-interno': 'appenzell-rhodes-interieures',
    'appenzello-esterno': 'appenzell-rhodes-exterieures',
    berna: 'berne',
    'basilea-campagna': 'bale-campagne',
    'basilea-citta': 'bale-ville',
    friborgo: 'fribourg',
    ginevra: 'geneve',
    glarona: 'glaris',
    giura: 'jura',
    lucerna: 'lucerne',
    neuchatel: 'neuchatel',
    nidvaldo: 'nidwald',
    obvaldo: 'obwald',
    'san-gallo': 'saint-gall',
    sciaffusa: 'schaffhouse',
    soletta: 'soleure',
    svitto: 'schwytz',
    turgovia: 'thurgovie',
    vaud: 'vaud',
    zugo: 'zoug',
  },
};

/**
 * Age-bracket URL slug per locale. Localised so long-tail queries in each
 * language land on a URL that matches the native age-bracket phrasing.
 */
export const HEALTH_PREMIUM_AGE_SLUG: Record<HealthPremiumLocale, Record<HealthPremiumAgeBracket, string>> = {
  it: {
    '0-18': 'bambini-0-18',
    '19-25': 'giovani-adulti-19-25',
    '26-30': 'adulto-26-30',
    '31-45': 'adulto-31-45',
    '46-55': 'adulto-46-55',
    '56-plus': 'adulto-56-piu',
  },
  en: {
    '0-18': 'children-0-18',
    '19-25': 'young-adults-19-25',
    '26-30': 'adult-26-30',
    '31-45': 'adult-31-45',
    '46-55': 'adult-46-55',
    '56-plus': 'adult-56-plus',
  },
  de: {
    '0-18': 'kinder-0-18',
    '19-25': 'junge-erwachsene-19-25',
    '26-30': 'erwachsene-26-30',
    '31-45': 'erwachsene-31-45',
    '46-55': 'erwachsene-46-55',
    '56-plus': 'erwachsene-56-plus',
  },
  fr: {
    '0-18': 'enfants-0-18',
    '19-25': 'jeunes-adultes-19-25',
    '26-30': 'adulte-26-30',
    '31-45': 'adulte-31-45',
    '46-55': 'adulte-46-55',
    '56-plus': 'adulte-56-plus',
  },
};

/**
 * Human-readable bracket label per locale (used in H1s, breadcrumbs, etc.).
 */
export const HEALTH_PREMIUM_AGE_LABEL: Record<HealthPremiumLocale, Record<HealthPremiumAgeBracket, string>> = {
  it: {
    '0-18': 'bambini (0-18 anni)',
    '19-25': 'giovani adulti (19-25 anni)',
    '26-30': 'adulti (26-30 anni)',
    '31-45': 'adulti (31-45 anni)',
    '46-55': 'adulti (46-55 anni)',
    '56-plus': 'adulti (56+ anni)',
  },
  en: {
    '0-18': 'children (age 0-18)',
    '19-25': 'young adults (age 19-25)',
    '26-30': 'adults (age 26-30)',
    '31-45': 'adults (age 31-45)',
    '46-55': 'adults (age 46-55)',
    '56-plus': 'adults (age 56+)',
  },
  de: {
    '0-18': 'Kinder (0-18 Jahre)',
    '19-25': 'junge Erwachsene (19-25 Jahre)',
    '26-30': 'Erwachsene (26-30 Jahre)',
    '31-45': 'Erwachsene (31-45 Jahre)',
    '46-55': 'Erwachsene (46-55 Jahre)',
    '56-plus': 'Erwachsene (56+ Jahre)',
  },
  fr: {
    '0-18': 'enfants (0-18 ans)',
    '19-25': 'jeunes adultes (19-25 ans)',
    '26-30': 'adultes (26-30 ans)',
    '31-45': 'adultes (31-45 ans)',
    '46-55': 'adultes (46-55 ans)',
    '56-plus': 'adultes (56+ ans)',
  },
};

/**
 * Locale path prefix (empty for Italian default, /en|de|fr/ otherwise).
 */
export const HEALTH_PREMIUM_LOCALE_PREFIX: Record<HealthPremiumLocale, string> = {
  it: '',
  en: '/en',
  de: '/de',
  fr: '/fr',
};

/**
 * Root section slug per locale.
 */
export const HEALTH_PREMIUM_SECTION_SLUG: Record<HealthPremiumLocale, string> = {
  it: 'premi-cassa-malati',
  en: 'health-insurance-premiums',
  de: 'krankenkassenpraemien',
  fr: 'primes-assurance-maladie',
};

/**
 * Locale-aware comparator URL (existing /confronti/health page).
 * Slugs must match the canonical paths emitted by the SPA router +
 * staticPagesPlugin. Broken values here become site-wide broken internal
 * links from every canton landing page.
 */
export const HEALTH_PREMIUM_COMPARATOR_PATH: Record<HealthPremiumLocale, string> = {
  it: '/compara-servizi/confronta-casse-malati/',
  en: '/en/service-comparison/compare-health-insurance/',
  de: '/de/service-vergleich/krankenkassen-vergleichen/',
  fr: '/fr/comparaison-services/comparer-caisses-maladie/',
};

// ── Path builders ───────────────────────────────────────────────

function joinPath(parts: ReadonlyArray<string>): string {
  const clean = parts.map((p) => String(p).replace(/^\/+|\/+$/g, '')).filter((p) => p.length > 0);
  return '/' + clean.join('/') + '/';
}

export function buildHealthPremiumsRootPath(locale: HealthPremiumLocale): string {
  return joinPath([HEALTH_PREMIUM_LOCALE_PREFIX[locale], HEALTH_PREMIUM_SECTION_SLUG[locale]]);
}

export function buildHealthPremiumsCantonPath(
  locale: HealthPremiumLocale,
  canton: HealthPremiumCanton,
): string {
  return joinPath([
    HEALTH_PREMIUM_LOCALE_PREFIX[locale],
    HEALTH_PREMIUM_SECTION_SLUG[locale],
    HEALTH_PREMIUM_CANTON_SLUG[locale][canton],
  ]);
}

export function buildHealthPremiumsLeafPath(
  locale: HealthPremiumLocale,
  canton: HealthPremiumCanton,
  age: HealthPremiumAgeBracket,
): string {
  return joinPath([
    HEALTH_PREMIUM_LOCALE_PREFIX[locale],
    HEALTH_PREMIUM_SECTION_SLUG[locale],
    HEALTH_PREMIUM_CANTON_SLUG[locale][canton],
    HEALTH_PREMIUM_AGE_SLUG[locale][age],
  ]);
}

// ── Route enumeration ──────────────────────────────────────────

export interface HealthPremiumsPath {
  locale: HealthPremiumLocale;
  kind: 'root' | 'canton' | 'leaf';
  canton?: HealthPremiumCanton;
  age?: HealthPremiumAgeBracket;
  path: string;
}

/**
 * Enumerate every canonical health-premium path across all locales.
 * Count: 4 locales × (1 root + 26 canton hubs + 156 leaves) = 732.
 */
export function listHealthPremiumsPaths(): HealthPremiumsPath[] {
  const out: HealthPremiumsPath[] = [];
  for (const locale of HEALTH_PREMIUM_LOCALES) {
    out.push({ locale, kind: 'root', path: buildHealthPremiumsRootPath(locale) });
    for (const canton of HEALTH_PREMIUM_CANTONS) {
      out.push({ locale, kind: 'canton', canton, path: buildHealthPremiumsCantonPath(locale, canton) });
      for (const age of HEALTH_PREMIUM_AGE_BRACKETS) {
        out.push({
          locale,
          kind: 'leaf',
          canton,
          age: age.id,
          path: buildHealthPremiumsLeafPath(locale, canton, age.id),
        });
      }
    }
  }
  return out;
}

/**
 * Router route table: all health-premium canonical paths. Imported by
 * services/router.ts so URLs resolve to the health-premiums stats sub-tab
 * instead of falling through to 404 on back/forward navigation.
 */
export const HEALTH_PREMIUMS_ROUTES: readonly string[] = listHealthPremiumsPaths().map((p) => p.path);

const HEALTH_PREMIUMS_ROUTE_SET: ReadonlySet<string> = new Set(HEALTH_PREMIUMS_ROUTES);

/**
 * Return true when `pathname` (with or without trailing slash) matches a
 * canonical health-premium URL in any locale.
 */
export function isHealthPremiumsPath(pathname: string): boolean {
  if (!pathname) return false;
  const leading = pathname.startsWith('/') ? pathname : `/${pathname}`;
  const normalised = leading.endsWith('/') ? leading : `${leading}/`;
  return HEALTH_PREMIUMS_ROUTE_SET.has(normalised);
}

// ── Multi-year loader + YoY computation (F2 A3) ────────────────
//
// Premiums are now stored under `data/health-premiums/{year}.json` so we can
// compute year-over-year variation for each insurer × canton × age. The
// legacy flat path (`data/health-premiums.json`) remains supported as a
// fallback for the current-year dataset so pre-A3 consumers stay green.

import fs from 'node:fs';
import path from 'node:path';

/**
 * Minimal shape of the dataset JSON — we intentionally avoid re-importing
 * the full `HealthPremiumsDataset` type from the plugin to prevent a circular
 * import (plugin imports from this file).
 */
interface PremiumsJsonShape {
  year?: number;
  fetchedAt?: string;
  insurers?: Array<{ id: string; name?: string; website?: string }>;
  premiums?: Record<string, unknown>;
}

/**
 * Load the premiums dataset for a given calendar year. Returns `null` when
 * the file does not exist or fails to parse — callers must treat this as a
 * soft miss, never a build failure (F2 A3 "graceful degradation").
 */
export function loadPremiumsForYear(
  rootDir: string,
  year: number,
): PremiumsJsonShape | null {
  const candidates = [
    path.resolve(rootDir, 'data', 'health-premiums', `${year}.json`),
    // Legacy fallback: the flat `data/health-premiums.json` mirrors the
    // current year. Only treat it as a match when the embedded `year`
    // metadata agrees — otherwise a historical-year request could silently
    // read the wrong dataset.
    path.resolve(rootDir, 'data', 'health-premiums.json'),
  ];
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    try {
      const raw = fs.readFileSync(p, 'utf-8');
      const parsed = JSON.parse(raw) as PremiumsJsonShape;
      if (parsed.year === year) return parsed;
    } catch {
      // fall through to next candidate
    }
  }
  return null;
}

/**
 * Per-insurer standard-premium YoY variation (percent). Positive means the
 * 2026 premium is higher than 2025. `null` entries signal that the prior-year
 * dataset did not expose a usable premium for that insurer.
 */
export type YoyInsurerDeltaMap = Record<string, number | null>;

/**
 * Per-bracket YoY delta slice. `perInsurer` is keyed by insurer id → percent
 * change between the two years at the requested risk class; `medianPct` is
 * the median of non-null entries; `sourceInsurers` records how many insurers
 * contributed to the median calculation so downstream UI can hide sparse
 * deltas (< 3 insurers).
 */
export interface YoyBracketDelta {
  riskClass: HealthPremiumRiskClass;
  perInsurer: YoyInsurerDeltaMap;
  medianPct: number | null;
  sourceInsurers: number;
}

/**
 * Full YoY delta for a canton: one slice per age bracket, plus an aggregate
 * canton-level median across the adult bracket (ERW). Returns `null` when
 * no prior dataset was available — callers skip the entire YoY section in
 * that case.
 */
export interface YoyCantonDelta {
  priorYear: number;
  currentYear: number;
  byBracket: Record<HealthPremiumAgeBracket, YoyBracketDelta | null>;
  /** Median YoY percent across adults (ERW) — the headline figure. */
  adultMedianPct: number | null;
  /** Number of insurers contributing to the adult median. */
  adultInsurers: number;
}

/**
 * Percent-change helper, rounded to two decimal places. Returns `null` when
 * either value is non-finite or the denominator is zero.
 */
function pctDelta(current: number, prior: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(prior) || prior === 0) return null;
  return Math.round(((current - prior) / prior) * 100 * 100) / 100;
}

/**
 * Compute per-insurer standard-premium averages, aggregated across every
 * premium block that belongs to a given BAG canton code, for a given risk
 * class. Only `standard` prices with matching `byAgeClass[riskClass]` are
 * considered — we never blend in multiplier-derived values for YoY (that
 * would hide real variation behind the multiplier).
 *
 * Kept internal to the YoY path so we do not alter the existing plugin
 * aggregation semantics used by `aggregatePremiumsByRiskClass`.
 */
function averageRealPremiumsForCanton(
  dataset: PremiumsJsonShape,
  cantonCode: string,
  riskClass: HealthPremiumRiskClass,
): Record<string, number> {
  const all = dataset.premiums ?? {};
  const sums: Record<string, { sum: number; count: number }> = {};

  for (const [key, rawBlock] of Object.entries(all)) {
    if (!rawBlock || typeof rawBlock !== 'object') continue;
    // Accept either canton-level or commune-level blocks belonging to the
    // requested canton code.
    const block = rawBlock as {
      canton?: string;
      type?: string;
      insurers?: Record<string, {
        standard?: number;
        byAgeClass?: Partial<Record<HealthPremiumRiskClass, { standard?: number }>>;
      }>;
    };
    if (key !== cantonCode && block.canton !== cantonCode) continue;
    if (key === cantonCode && block.type !== 'canton') {
      // The canton-code key is valid only when it is a canton-level block.
      if (block.canton !== cantonCode) continue;
    }
    for (const [insurerId, models] of Object.entries(block.insurers ?? {})) {
      const bac = models.byAgeClass?.[riskClass];
      let price: number | null = null;
      if (bac && typeof bac.standard === 'number') {
        price = bac.standard;
      } else if (riskClass === 'ERW' && typeof models.standard === 'number') {
        // Legacy datasets alias ERW in the flat field.
        price = models.standard;
      }
      if (price === null || !Number.isFinite(price)) continue;
      if (!sums[insurerId]) sums[insurerId] = { sum: 0, count: 0 };
      sums[insurerId].sum += price;
      sums[insurerId].count += 1;
    }
  }

  const out: Record<string, number> = {};
  for (const [id, { sum, count }] of Object.entries(sums)) {
    if (count === 0) continue;
    out[id] = Math.round((sum / count) * 100) / 100;
  }
  return out;
}

function medianOf(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round(((sorted[mid - 1] + sorted[mid]) / 2) * 100) / 100
    : sorted[mid];
}

/**
 * Compute YoY variation for a canton. Returns `null` when the prior dataset
 * is absent — the plugin skips the "Variazione vs {priorYear}" section in
 * that case, exactly as A3 specifies (no fake data).
 */
export function computeYoyDelta(opts: {
  current: PremiumsJsonShape;
  prior: PremiumsJsonShape | null;
  cantonBagCode: string;
}): YoyCantonDelta | null {
  const { current, prior, cantonBagCode } = opts;
  if (!prior) return null;
  if (!current.year || !prior.year) return null;
  if (current.year === prior.year) return null;

  const byBracket = {} as Record<HealthPremiumAgeBracket, YoyBracketDelta | null>;
  for (const ab of HEALTH_PREMIUM_AGE_BRACKETS) {
    const rc = HEALTH_PREMIUM_BRACKET_RISK_CLASS[ab.id];
    const cur = averageRealPremiumsForCanton(current, cantonBagCode, rc);
    const pri = averageRealPremiumsForCanton(prior, cantonBagCode, rc);
    const perInsurer: YoyInsurerDeltaMap = {};
    const deltas: number[] = [];
    for (const [id, curPrice] of Object.entries(cur)) {
      const priPrice = pri[id];
      if (typeof priPrice !== 'number') {
        perInsurer[id] = null;
        continue;
      }
      const delta = pctDelta(curPrice, priPrice);
      perInsurer[id] = delta;
      if (delta !== null) deltas.push(delta);
    }
    if (Object.keys(perInsurer).length === 0) {
      byBracket[ab.id] = null;
    } else {
      byBracket[ab.id] = {
        riskClass: rc,
        perInsurer,
        medianPct: medianOf(deltas),
        sourceInsurers: deltas.length,
      };
    }
  }

  const adult = byBracket['31-45'];
  return {
    priorYear: prior.year,
    currentYear: current.year,
    byBracket,
    adultMedianPct: adult?.medianPct ?? null,
    adultInsurers: adult?.sourceInsurers ?? 0,
  };
}

// ── 3-year tri-year trend (B-cont-4) ───────────────────────────
//
// Wave A3 added a 2-year YoY (current vs prior). B-cont-4 extends the same
// pattern to a 3-year trend (oldest → prior → current) that lets each
// canton × age leaf show two consecutive YoY deltas plus a cumulative
// 2-year percentage. The earliest year is OPTIONAL: callers must gracefully
// degrade to the existing YoY-only rendering when no 2024 dataset is
// available, exactly per CLAUDE.md rule #6 (no fake data).

/**
 * Median premium per age bracket across all insurers, both for the prior and
 * the oldest years. Used by leaf and hub trend sparklines so we can plot
 * the 3-year trajectory of the bracket median without recomputing inside the
 * renderer.
 */
export interface BracketTrendPoint {
  /** Calendar year (e.g. 2024). */
  year: number;
  /** Median standard premium across insurers (CHF/month). */
  median: number | null;
  /** Insurers that contributed to the median. */
  insurers: number;
}

export interface BracketTrend {
  riskClass: HealthPremiumRiskClass;
  /** Always sorted oldest → newest (e.g. [2024, 2025, 2026]). */
  points: BracketTrendPoint[];
  /** Year-over-year percent: index i is `points[i+1]` vs `points[i]`. */
  yoyPct: Array<number | null>;
  /** Cumulative percent change from the oldest to the newest point. */
  cumulativePct: number | null;
}

export interface TriYearCantonDelta {
  /** Oldest year in the window (e.g. 2024). */
  oldestYear: number;
  priorYear: number;
  currentYear: number;
  byBracket: Record<HealthPremiumAgeBracket, BracketTrend | null>;
  /** Median 2-year cumulative % across the adult bracket (ERW 31-45). */
  adultCumulativePct: number | null;
}

function bracketMedian(
  dataset: PremiumsJsonShape | null,
  cantonCode: string,
  riskClass: HealthPremiumRiskClass,
): { median: number | null; insurers: number } {
  if (!dataset) return { median: null, insurers: 0 };
  const perInsurer = averageRealPremiumsForCanton(dataset, cantonCode, riskClass);
  const values = Object.values(perInsurer).filter((v): v is number => Number.isFinite(v));
  return { median: medianOf(values), insurers: values.length };
}

/**
 * Compute the 3-year trend for a canton. The function tolerates a missing
 * `oldest` dataset — when only `prior` + `current` are available it returns
 * the same 2-point series so callers can still render a YoY arc but no
 * tri-year cumulative point. Returns `null` when neither prior nor current
 * carry data for the canton (no point worth plotting).
 */
export function computeTriYearDelta(opts: {
  current: PremiumsJsonShape;
  prior: PremiumsJsonShape | null;
  oldest: PremiumsJsonShape | null;
  cantonBagCode: string;
}): TriYearCantonDelta | null {
  const { current, prior, oldest, cantonBagCode } = opts;
  if (!current.year) return null;

  const byBracket = {} as Record<HealthPremiumAgeBracket, BracketTrend | null>;
  let hasAnyTrend = false;

  for (const ab of HEALTH_PREMIUM_AGE_BRACKETS) {
    const rc = HEALTH_PREMIUM_BRACKET_RISK_CLASS[ab.id];
    const points: BracketTrendPoint[] = [];

    if (oldest?.year) {
      const m = bracketMedian(oldest, cantonBagCode, rc);
      if (m.median !== null) points.push({ year: oldest.year, median: m.median, insurers: m.insurers });
    }
    if (prior?.year) {
      const m = bracketMedian(prior, cantonBagCode, rc);
      if (m.median !== null) points.push({ year: prior.year, median: m.median, insurers: m.insurers });
    }
    {
      const m = bracketMedian(current, cantonBagCode, rc);
      if (m.median !== null) points.push({ year: current.year, median: m.median, insurers: m.insurers });
    }

    // Need at least 2 anchor points (one YoY) to render a trend; otherwise
    // there is nothing meaningful and the bracket gets a null.
    if (points.length < 2) {
      byBracket[ab.id] = null;
      continue;
    }
    points.sort((a, b) => a.year - b.year);
    const yoyPct: Array<number | null> = [];
    for (let i = 1; i < points.length; i++) {
      yoyPct.push(pctDelta(points[i].median!, points[i - 1].median!));
    }
    const first = points[0].median!;
    const last = points[points.length - 1].median!;
    const cumulativePct = pctDelta(last, first);
    byBracket[ab.id] = {
      riskClass: rc,
      points,
      yoyPct,
      cumulativePct,
    };
    hasAnyTrend = true;
  }

  if (!hasAnyTrend) return null;

  const oldestYear = oldest?.year ?? prior?.year ?? current.year;
  const priorYear = prior?.year ?? current.year;
  const adult = byBracket['31-45'];
  return {
    oldestYear,
    priorYear,
    currentYear: current.year,
    byBracket,
    adultCumulativePct: adult?.cumulativePct ?? null,
  };
}

/**
 * Convenience helper: load up to 3 years of premium datasets. Returns the
 * raw datasets so callers can compose richer views without re-reading from
 * disk. `currentYear` defaults to the calendar year.
 */
export function loadPriorTwoYearsForBracket(
  rootDir: string,
  currentYear: number = new Date().getUTCFullYear(),
): {
  current: PremiumsJsonShape | null;
  prior: PremiumsJsonShape | null;
  oldest: PremiumsJsonShape | null;
} {
  return {
    current: loadPremiumsForYear(rootDir, currentYear),
    prior: loadPremiumsForYear(rootDir, currentYear - 1),
    oldest: loadPremiumsForYear(rootDir, currentYear - 2),
  };
}

// ── BAG age-bracket multipliers (FALLBACK ONLY) ────────────────
//
// Since F2-LAMal real data wiring, the dataset persists per-insurer premiums
// for all three BAG risk classes (AKL-KIN, AKL-JUG, AKL-ERW). These
// multipliers are retained only as a graceful-degradation fallback for the
// edge case where `byAgeClass.KIN` / `byAgeClass.JUG` are missing on an
// insurer × region pair — either legacy datasets pre-dating the schema
// upgrade or a BAG feed regression.
//
// The BAG statutory maxima (art. 61 al. 3 LAMal, BAG 2026) are:
//   - Children 0-18: capped at ~25% of adult premium.
//   - Young adults 19-25: capped at ~80% of adult premium.
// Callers should prefer the real per-insurer premium from
// `byAgeClass[riskClass]` and reach for these ratios only when the real
// value is absent.
export const HEALTH_PREMIUM_AGE_MULTIPLIER: Record<HealthPremiumAgeBracket, number> = {
  '0-18': 0.25,
  '19-25': 0.80,
  '26-30': 1.0,
  '31-45': 1.0,
  '46-55': 1.0,
  '56-plus': 1.0,
};
