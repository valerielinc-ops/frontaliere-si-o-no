/**
 * Health-premium landing pages: slug maps, age brackets, path builders.
 *
 * PRIVO DI DIPENDENZE NODE — deliberatamente (#8125). Questo e' il modulo che
 * il bundle del browser raggiunge: `App.tsx`, `services/router.ts` e i
 * componenti stats hanno bisogno dei costruttori di path e della tabella di
 * route perche' la forma degli URL abbia UNA sola sorgente condivisa fra
 * l'emettitore SSG e il router della SPA. Il lettore di dataset che legge da
 * disco vive in `build-plugins/healthPremiumsData.ts`, che importa DA qui e
 * ri-esporta questi simboli per i consumatori Node.
 *
 * Il verso conta: rollup risolve `node:fs` a `__vite-browser-external`, che
 * non ha export nominati, quindi un builtin Node dentro un modulo raggiungibile
 * dal browser fa fallire il link della build — dopo ~80 minuti. Non aggiungere
 * qui import Node, nemmeno in forma namespace.
 *
 * F2 — LAMal evergreen SEO moat.
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
