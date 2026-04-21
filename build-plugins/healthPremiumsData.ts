/**
 * Health-premium landing page data: slug maps, age brackets, path builders.
 *
 * F2 — LAMal evergreen SEO moat.
 *
 * GSC evidence: ~10 imp/month on "premi cassa malati ticino 2026",
 * "lamal preise tessin", "primes lamal 2026". Low-volume but evergreen with
 * annual refresh + long-tail compounding. Generates 36 pages per locale
 * (5 canton hubs + 30 leaves + 1 root) × 4 locales = 144 static HTML pages.
 *
 * URL shape:
 *   IT: /premi-cassa-malati/ , /premi-cassa-malati/{canton}/, /premi-cassa-malati/{canton}/{age}/
 *   EN: /en/health-insurance-premiums/ , /en/health-insurance-premiums/{canton}/{age}/
 *   DE: /de/krankenkassenpraemien/ , ...
 *   FR: /fr/primes-assurance-maladie/ , ...
 *
 * Canton slugs are intentionally stable across locales (proper nouns) to
 * preserve URL equity when Google discovers alternates. Age slugs are
 * locale-specific to match native-language search queries.
 *
 * Kept standalone (no dep on jobsSeoPagesPlugin etc.) so parallel worktrees
 * merge cleanly — see memory/feedback_worktree_merge_router_duplicates.
 */

export type HealthPremiumLocale = 'it' | 'en' | 'de' | 'fr';

/**
 * BAG canton 2-letter codes we cover. Ticino is the primary target; the four
 * neighbours (GR, UR, VS) plus ZH as benchmark round out the moat.
 */
export type HealthPremiumCanton = 'ticino' | 'grigioni' | 'uri' | 'vallese' | 'zurigo';

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

export const HEALTH_PREMIUM_CANTONS: readonly HealthPremiumCanton[] = [
  'ticino',
  'grigioni',
  'uri',
  'vallese',
  'zurigo',
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
  },
  en: {
    ticino: 'Ticino',
    grigioni: 'Graubünden',
    uri: 'Uri',
    vallese: 'Valais',
    zurigo: 'Zurich',
  },
  de: {
    ticino: 'Tessin',
    grigioni: 'Graubünden',
    uri: 'Uri',
    vallese: 'Wallis',
    zurigo: 'Zürich',
  },
  fr: {
    ticino: 'Tessin',
    grigioni: 'Grisons',
    uri: 'Uri',
    vallese: 'Valais',
    zurigo: 'Zurich',
  },
};

/**
 * URL slug per locale × canton. We keep proper-noun slugs stable where they
 * coincide (ticino, uri, zurigo) and use native forms where different
 * languages diverge (grigioni/grisons/graubuenden).
 */
export const HEALTH_PREMIUM_CANTON_SLUG: Record<HealthPremiumLocale, Record<HealthPremiumCanton, string>> = {
  it: {
    ticino: 'ticino',
    grigioni: 'grigioni',
    uri: 'uri',
    vallese: 'vallese',
    zurigo: 'zurigo',
  },
  en: {
    ticino: 'ticino',
    grigioni: 'graubunden',
    uri: 'uri',
    vallese: 'valais',
    zurigo: 'zurich',
  },
  de: {
    ticino: 'tessin',
    grigioni: 'graubuenden',
    uri: 'uri',
    vallese: 'wallis',
    zurigo: 'zuerich',
  },
  fr: {
    ticino: 'tessin',
    grigioni: 'grisons',
    uri: 'uri',
    vallese: 'valais',
    zurigo: 'zurich',
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
 */
export const HEALTH_PREMIUM_COMPARATOR_PATH: Record<HealthPremiumLocale, string> = {
  it: '/compara-servizi/confronta-casse-malati/',
  en: '/en/comparators/compare-health-insurance/',
  de: '/de/service-vergleich/krankenkassen-vergleichen/',
  fr: '/fr/comparateurs/comparer-caisses-maladie/',
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
 * Count: 4 locales × (1 root + 5 canton hubs + 30 leaves) = 144.
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
