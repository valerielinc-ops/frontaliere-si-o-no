/**
 * Job-market snapshot page data: locale slug maps, path builders, and the
 * route enumeration consumed by services/router.ts.
 *
 * F4 — Weekly Job Market Snapshot. A small, self-contained data module so
 * the plugin and the router can share a single source of truth for URL
 * shape without either file pulling in the heavier plugin logic.
 *
 * URL structure (all trailing-slash canonical):
 *  - Hub (evergreen):
 *      IT → /mercato-lavoro-ticino/
 *      EN → /en/ticino-job-market/
 *      DE → /de/tessiner-arbeitsmarkt/
 *      FR → /fr/marche-travail-tessin/
 *  - Weekly archive (ISO week):
 *      IT → /mercato-lavoro-ticino/settimana-16-2026/
 *      EN → /en/ticino-job-market/week-16-2026/
 *      DE → /de/tessiner-arbeitsmarkt/woche-16-2026/
 *      FR → /fr/marche-travail-tessin/semaine-16-2026/
 *  - Monthly aggregate:
 *      IT → /mercato-lavoro-ticino/aprile-2026/
 *      EN → /en/ticino-job-market/april-2026/
 *      DE → /de/tessiner-arbeitsmarkt/april-2026/
 *      FR → /fr/marche-travail-tessin/avril-2026/
 */

export type JobMarketSnapshotLocale = 'it' | 'en' | 'de' | 'fr';

export const JOB_MARKET_SNAPSHOT_LOCALES: readonly JobMarketSnapshotLocale[] = [
  'it',
  'en',
  'de',
  'fr',
] as const;

/** Section (hub) slug per locale — evergreen landing root. */
export const JOB_MARKET_SECTION_SLUG: Record<JobMarketSnapshotLocale, string> = {
  it: 'mercato-lavoro-ticino',
  en: 'ticino-job-market',
  de: 'tessiner-arbeitsmarkt',
  fr: 'marche-travail-tessin',
};

/** Locale URL prefix ("" for IT, "/en", "/de", "/fr"). */
export const JOB_MARKET_LOCALE_PREFIX: Record<JobMarketSnapshotLocale, string> = {
  it: '',
  en: '/en',
  de: '/de',
  fr: '/fr',
};

/** OG locale codes. */
export const JOB_MARKET_OG_LOCALE: Record<JobMarketSnapshotLocale, string> = {
  it: 'it_IT',
  en: 'en_US',
  de: 'de_DE',
  fr: 'fr_FR',
};

/** Breadcrumb / hub display name per locale. */
export const JOB_MARKET_HUB_NAME: Record<JobMarketSnapshotLocale, string> = {
  it: 'Mercato del lavoro in Ticino',
  en: 'Ticino job market',
  de: 'Tessiner Arbeitsmarkt',
  fr: 'Marché du travail au Tessin',
};

/** Week-prefix keyword per locale (e.g. "settimana-16-2026" / "week-16-2026"). */
export const JOB_MARKET_WEEK_PREFIX: Record<JobMarketSnapshotLocale, string> = {
  it: 'settimana',
  en: 'week',
  de: 'woche',
  fr: 'semaine',
};

/** Sector-collection slug per locale (the "/settore/" segment). */
export const JOB_MARKET_SECTOR_SEGMENT: Record<JobMarketSnapshotLocale, string> = {
  it: 'settore',
  en: 'sector',
  de: 'branche',
  fr: 'secteur',
};

/**
 * Sector keys covered by the F4 per-sector snapshot pages (D-3A).
 *
 * These are the high-intent sector verticals for which we emit a dedicated
 * hub under `/mercato-lavoro-ticino/settore/{slug}/`. The slug is locale-
 * agnostic and identical in all 4 locales (keeps crawlable URLs stable
 * across language switches and keeps the canonical structure predictable).
 */
export type JobMarketSectorKey =
  | 'infermieri'
  | 'educatori'
  | 'case-anziani'
  | 'sanita'
  | 'amministrativo'
  | 'vendite'
  | 'finanza'
  | 'informatica'
  | 'retail'
  | 'meccanica'
  | 'edilizia'
  | 'ristorazione'
  | 'logistica'
  | 'ingegneria';

export const JOB_MARKET_SECTOR_KEYS: readonly JobMarketSectorKey[] = [
  'infermieri',
  'educatori',
  'case-anziani',
  'sanita',
  'amministrativo',
  'vendite',
  'finanza',
  'informatica',
  'retail',
  'meccanica',
  'edilizia',
  'ristorazione',
  'logistica',
  'ingegneria',
] as const;

/**
 * Slug map per sector per locale. We intentionally keep the URL slug
 * identical across all 4 locales (the slug lives inside
 * `/mercato-lavoro-ticino/settore/<slug>/` IT → `.../branche/<slug>/` DE etc.,
 * but the leaf slug itself stays in Italian for SEO continuity with the
 * existing city + sector hubs under `/cerca-lavoro-ticino/<slug>/`).
 */
export const JOB_MARKET_SECTOR_SLUG: Record<JobMarketSectorKey, string> = {
  infermieri: 'infermieri',
  educatori: 'educatori',
  'case-anziani': 'case-anziani',
  sanita: 'sanita',
  amministrativo: 'amministrativo',
  vendite: 'vendite',
  finanza: 'finanza',
  informatica: 'informatica',
  retail: 'retail',
  meccanica: 'meccanica',
  edilizia: 'edilizia',
  ristorazione: 'ristorazione',
  logistica: 'logistica',
  ingegneria: 'ingegneria',
};

/** Human-friendly sector name per locale (used in H1, breadcrumbs, intro). */
export const JOB_MARKET_SECTOR_DISPLAY: Record<
  JobMarketSnapshotLocale,
  Record<JobMarketSectorKey, string>
> = {
  it: {
    infermieri: 'infermieri',
    educatori: 'educatori',
    'case-anziani': 'case anziani',
    sanita: 'sanità',
    amministrativo: 'impiegati amministrativi',
    vendite: 'addetti alle vendite',
    finanza: 'finanza',
    informatica: 'informatica',
    retail: 'retail',
    meccanica: 'meccanica',
    edilizia: 'edilizia',
    ristorazione: 'ristorazione',
    logistica: 'logistica',
    ingegneria: 'ingegneria',
  },
  en: {
    infermieri: 'nurses',
    educatori: 'educators',
    'case-anziani': 'elderly care',
    sanita: 'healthcare',
    amministrativo: 'administrative staff',
    vendite: 'sales',
    finanza: 'finance',
    informatica: 'IT',
    retail: 'retail',
    meccanica: 'mechanical engineering',
    edilizia: 'construction',
    ristorazione: 'hospitality',
    logistica: 'logistics',
    ingegneria: 'engineering',
  },
  de: {
    infermieri: 'Pflegepersonal',
    educatori: 'Erzieher',
    'case-anziani': 'Altenpflege',
    sanita: 'Gesundheitswesen',
    amministrativo: 'Verwaltung',
    vendite: 'Verkauf',
    finanza: 'Finanzen',
    informatica: 'IT',
    retail: 'Einzelhandel',
    meccanica: 'Maschinenbau',
    edilizia: 'Bauwesen',
    ristorazione: 'Gastronomie',
    logistica: 'Logistik',
    ingegneria: 'Ingenieurwesen',
  },
  fr: {
    infermieri: 'infirmiers',
    educatori: 'éducateurs',
    'case-anziani': 'maisons de retraite',
    sanita: 'santé',
    amministrativo: 'personnel administratif',
    vendite: 'ventes',
    finanza: 'finance',
    informatica: 'informatique',
    retail: 'commerce de détail',
    meccanica: 'mécanique',
    edilizia: 'construction',
    ristorazione: 'restauration',
    logistica: 'logistique',
    ingegneria: 'ingénierie',
  },
};

/**
 * Case-insensitive multilingual keyword patterns used to filter the live
 * `jobs.json` snapshot down to a sector's matching postings. Mirrors the
 * pattern shape of `jobSectorLanding.ts::SECTOR_MATCHERS` but expands the
 * coverage beyond the 3 existing sector hubs.
 */
export const JOB_MARKET_SECTOR_MATCHERS: Record<JobMarketSectorKey, RegExp> = {
  infermieri:
    /infermier|infermiere|pfleger|pflegepersonal|pflegefach|krankenpfleg|krankensch|nurse|nursing|infirmier|infirmi[eè]re/i,
  educatori:
    /educator|educatric|educatrice|educatori|erzieher|erzieherin|p[aä]dagog|social[ -]pedagog|[eé]ducateur|[eé]ducatrice|educational[ -]assistant|operatore[ -]socio[ -]educativ/i,
  'case-anziani':
    /casa[ -]anzian|case[ -]anzian|altenpfleg|altersheim|pflegeheim|residenza[ -]per[ -]anzian|residenza[ -]anzian|elderly[ -]care|nursing[ -]home|maison[ -]de[ -]retraite|ehpad/i,
  sanita:
    /sanit[aà]|sanitari|ospedal|clinica|medico|medic[ao]|healthcare|hospital|clinic|physician|krankenhaus|klinik|arzt|m[eé]dical|m[eé]decin|hopital|h[oô]pital/i,
  amministrativo:
    /amministrativ|impiegat[ao][ -]amministrativ|administrative|secretary|secretar[iy]|back[ -]office|verwaltung|sachbearbeiter|sekret[aä]r|administratif|administrative|secr[eé]taire/i,
  vendite:
    /vendita|vendite|commercial|account[ -]manager|sales|sales[ -]representative|verkauf|verk[aä]ufer|au[ßs]endienst|vente|vendeur|commercial/i,
  finanza:
    /finanza|finanziari|contabil|ragioneria|controller|accountant|bookkeeper|finance|financial|buchhalt|finanzen|controlling|finance|comptabl|comptabilit[eé]/i,
  informatica:
    /informatica|software|sviluppator|programmatore|developer|engineer|devops|frontend|backend|fullstack|it[ -]support|informatik|softwareentwickler|programmierer|informatique|d[eé]veloppeur|ing[eé]nieur[ -]logiciel/i,
  retail:
    /retail|cassier|commess[ao]|addetto[ -]vendita|shop[ -]assistant|store[ -]manager|einzelhandel|verk[aä]ufer|kassier|magasin|caissi[eè]re/i,
  meccanica:
    /meccanic|meccanico|manutentor|tornitor|fresator|mechanical|maintenance[ -]technician|cnc|mechaniker|maschinenbau|wartungstechniker|m[eé]canicien|m[eé]canique|maintenance/i,
  edilizia:
    /edile|edilizia|muratore|carpentiere|capocantiere|construction|site[ -]manager|builder|bau|maurer|bauleiter|polier|construction|ma[çc]on|chef[ -]de[ -]chantier/i,
  ristorazione:
    /ristorazion|cuoc[ao]|chef|cameriere|cameriera|barista|pizzaiolo|hospitality|waiter|waitress|gastronomie|koch|kellner|kellnerin|restauration|cuisinier|serveur|serveuse/i,
  logistica:
    /logistic|magazzinier|autista|driver|warehouse|forklift|logistik|fahrer|lagerist|staplerfahrer|logistique|chauffeur|magasinier|cariste/i,
  ingegneria:
    /ingegner|ingegneri|engineer[- ]?\b|engineering|bauingenieur|elektroingenieur|maschineningenieur|ingenieur|ing[eé]nieur|ing[eé]nierie/i,
};

/** Month names per locale, 1-indexed (index 0 is a placeholder). */
export const JOB_MARKET_MONTH_NAMES: Record<
  JobMarketSnapshotLocale,
  ReadonlyArray<string>
> = {
  it: [
    '',
    'gennaio',
    'febbraio',
    'marzo',
    'aprile',
    'maggio',
    'giugno',
    'luglio',
    'agosto',
    'settembre',
    'ottobre',
    'novembre',
    'dicembre',
  ],
  en: [
    '',
    'january',
    'february',
    'march',
    'april',
    'may',
    'june',
    'july',
    'august',
    'september',
    'october',
    'november',
    'december',
  ],
  de: [
    '',
    'januar',
    'februar',
    'maerz',
    'april',
    'mai',
    'juni',
    'juli',
    'august',
    'september',
    'oktober',
    'november',
    'dezember',
  ],
  fr: [
    '',
    'janvier',
    'fevrier',
    'mars',
    'avril',
    'mai',
    'juin',
    'juillet',
    'aout',
    'septembre',
    'octobre',
    'novembre',
    'decembre',
  ],
};

// ── Helpers ───────────────────────────────────────────────────

function joinPath(parts: ReadonlyArray<string>): string {
  const nonEmpty = parts
    .map((p) => String(p).replace(/^\/+|\/+$/g, ''))
    .filter((p) => p.length > 0);
  return '/' + nonEmpty.join('/') + '/';
}

/**
 * ISO 8601 week number + ISO week year for a given Date (UTC-based).
 * ISO weeks start on Monday; week 1 contains the year's first Thursday.
 */
export function getIsoWeek(date: Date): { year: number; week: number } {
  const d = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  // Shift to the Thursday of the current ISO week
  const dayOfWeek = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayOfWeek);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return { year: d.getUTCFullYear(), week };
}

/** Monday (inclusive) UTC date for the given ISO year/week. */
export function mondayOfIsoWeek(isoYear: number, isoWeek: number): Date {
  // January 4th is always in ISO week 1
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4Dow = jan4.getUTCDay() || 7;
  const week1Monday = new Date(jan4.getTime());
  week1Monday.setUTCDate(jan4.getUTCDate() - (jan4Dow - 1));
  const result = new Date(week1Monday.getTime());
  result.setUTCDate(week1Monday.getUTCDate() + (isoWeek - 1) * 7);
  return result;
}

/** Sunday (inclusive) UTC date for the given ISO year/week. */
export function sundayOfIsoWeek(isoYear: number, isoWeek: number): Date {
  const mon = mondayOfIsoWeek(isoYear, isoWeek);
  const sun = new Date(mon.getTime());
  sun.setUTCDate(mon.getUTCDate() + 6);
  return sun;
}

// ── Path builders ──────────────────────────────────────────────

export function buildHubPath(locale: JobMarketSnapshotLocale): string {
  return joinPath([JOB_MARKET_LOCALE_PREFIX[locale], JOB_MARKET_SECTION_SLUG[locale]]);
}

export function buildWeeklyPath(
  locale: JobMarketSnapshotLocale,
  isoYear: number,
  isoWeek: number,
): string {
  const weekSlug = `${JOB_MARKET_WEEK_PREFIX[locale]}-${String(isoWeek).padStart(2, '0')}-${isoYear}`;
  return joinPath([
    JOB_MARKET_LOCALE_PREFIX[locale],
    JOB_MARKET_SECTION_SLUG[locale],
    weekSlug,
  ]);
}

export function buildMonthlyPath(
  locale: JobMarketSnapshotLocale,
  year: number,
  /** 1-indexed month (1–12). */
  month: number,
): string {
  if (month < 1 || month > 12) {
    throw new RangeError(`invalid month ${month}; must be 1-12`);
  }
  const monthName = JOB_MARKET_MONTH_NAMES[locale][month];
  const monthSlug = `${monthName}-${year}`;
  return joinPath([
    JOB_MARKET_LOCALE_PREFIX[locale],
    JOB_MARKET_SECTION_SLUG[locale],
    monthSlug,
  ]);
}

/**
 * Build the canonical path for a per-sector snapshot page (D-3A).
 *
 *   IT → /mercato-lavoro-ticino/settore/infermieri/
 *   EN → /en/ticino-job-market/sector/infermieri/
 *   DE → /de/tessiner-arbeitsmarkt/branche/infermieri/
 *   FR → /fr/marche-travail-tessin/secteur/infermieri/
 */
export function buildSectorSnapshotPath(
  locale: JobMarketSnapshotLocale,
  sector: JobMarketSectorKey,
): string {
  const slug = JOB_MARKET_SECTOR_SLUG[sector];
  if (!slug) {
    throw new RangeError(`unknown sector key: ${sector}`);
  }
  return joinPath([
    JOB_MARKET_LOCALE_PREFIX[locale],
    JOB_MARKET_SECTION_SLUG[locale],
    JOB_MARKET_SECTOR_SEGMENT[locale],
    slug,
  ]);
}

/**
 * Parse a sector-snapshot path into `{ locale, sector }` or return null.
 * Accepts paths with or without a trailing slash.
 */
export function parseSectorSnapshotPath(
  pathname: string,
): { locale: JobMarketSnapshotLocale; sector: JobMarketSectorKey } | null {
  if (!pathname) return null;
  const leading = pathname.startsWith('/') ? pathname : `/${pathname}`;
  const normalised = leading.endsWith('/') ? leading : `${leading}/`;
  const parts = normalised.split('/').filter(Boolean);
  if (parts.length < 3) return null;
  let idx = 0;
  let locale: JobMarketSnapshotLocale = 'it';
  if (parts[0] === 'en' || parts[0] === 'de' || parts[0] === 'fr') {
    locale = parts[0];
    idx = 1;
  }
  if (parts[idx] !== JOB_MARKET_SECTION_SLUG[locale]) return null;
  if (parts[idx + 1] !== JOB_MARKET_SECTOR_SEGMENT[locale]) return null;
  const leaf = parts[idx + 2];
  if (!leaf) return null;
  const match = (JOB_MARKET_SECTOR_KEYS as ReadonlyArray<JobMarketSectorKey>).find(
    (s) => JOB_MARKET_SECTOR_SLUG[s] === leaf,
  );
  if (!match) return null;
  return { locale, sector: match };
}

// ── Route enumeration ─────────────────────────────────────────

/**
 * The hub routes are always known statically. Weekly and monthly routes
 * are data-dependent so we expose a predicate for the router rather than
 * a static list.
 */
export const JOB_MARKET_SNAPSHOT_ROUTES: readonly string[] = JOB_MARKET_SNAPSHOT_LOCALES.map(
  (loc) => buildHubPath(loc),
);

const HUB_ROUTE_SET: ReadonlySet<string> = new Set(JOB_MARKET_SNAPSHOT_ROUTES);

const WEEK_PATTERN = /^(settimana|week|woche|semaine)-(\d{1,2})-(\d{4})$/;

/**
 * Recognise any job-market-snapshot canonical URL (hub, weekly archive, or
 * monthly aggregate) across all locales. Accepts paths with or without a
 * trailing slash.
 */
export function isJobMarketSnapshotPath(pathname: string): boolean {
  if (!pathname) return false;
  const leading = pathname.startsWith('/') ? pathname : `/${pathname}`;
  const normalised = leading.endsWith('/') ? leading : `${leading}/`;
  if (HUB_ROUTE_SET.has(normalised)) return true;
  // Strip leading/trailing slashes and inspect segments
  const parts = normalised.split('/').filter(Boolean);
  if (parts.length < 2) return false;
  // Optional locale prefix
  let idx = 0;
  if (parts[0] === 'en' || parts[0] === 'de' || parts[0] === 'fr') idx = 1;
  const sectionCandidate = parts[idx];
  const sectionMatchesLocale = (JOB_MARKET_SNAPSHOT_LOCALES as ReadonlyArray<JobMarketSnapshotLocale>).some(
    (loc) => JOB_MARKET_SECTION_SLUG[loc] === sectionCandidate,
  );
  if (!sectionMatchesLocale) return false;
  const sub = parts[idx + 1];
  if (!sub) return true; // hub (shouldn't happen since HUB_ROUTE_SET already caught it, but safe)
  if (WEEK_PATTERN.test(sub)) return true;
  // Month form: <month-name>-YYYY
  const monthMatch = /^([a-z]+)-(\d{4})$/.exec(sub);
  if (monthMatch) {
    const monthName = monthMatch[1];
    const allMonthNames = new Set<string>();
    for (const loc of JOB_MARKET_SNAPSHOT_LOCALES) {
      for (const name of JOB_MARKET_MONTH_NAMES[loc]) {
        if (name) allMonthNames.add(name);
      }
    }
    if (allMonthNames.has(monthName)) return true;
  }
  // Sector form: /<sectorSegment>/<sector-slug>/ (D-3A)
  // The section at parts[idx] is locale-matched above; sub must be the
  // localised sector segment and parts[idx+2] the sector leaf.
  const expectedSectorSeg = (JOB_MARKET_SNAPSHOT_LOCALES as ReadonlyArray<JobMarketSnapshotLocale>)
    .find((loc) => JOB_MARKET_SECTION_SLUG[loc] === sectionCandidate);
  if (expectedSectorSeg && sub === JOB_MARKET_SECTOR_SEGMENT[expectedSectorSeg]) {
    const leaf = parts[idx + 2];
    if (leaf) {
      const known = (JOB_MARKET_SECTOR_KEYS as ReadonlyArray<JobMarketSectorKey>).some(
        (s) => JOB_MARKET_SECTOR_SLUG[s] === leaf,
      );
      if (known) return true;
    }
  }
  return false;
}

/**
 * Parse an ISO week slug like "settimana-16-2026" / "week-16-2026" → { year, week }.
 * Returns null if the slug is not a valid week slug.
 */
export function parseWeekSlug(slug: string): { year: number; week: number } | null {
  const m = WEEK_PATTERN.exec(slug);
  if (!m) return null;
  const week = Number(m[2]);
  const year = Number(m[3]);
  if (!Number.isFinite(week) || week < 1 || week > 53) return null;
  if (!Number.isFinite(year) || year < 2020 || year > 2100) return null;
  return { year, week };
}

/**
 * Parse a month slug like "aprile-2026" / "april-2026" → { year, month } where
 * month is 1-12. Returns null if the slug does not map to any known localised
 * month name.
 */
export function parseMonthSlug(slug: string): { year: number; month: number } | null {
  const m = /^([a-z]+)-(\d{4})$/.exec(slug);
  if (!m) return null;
  const name = m[1];
  const year = Number(m[2]);
  if (!Number.isFinite(year) || year < 2020 || year > 2100) return null;
  for (const loc of JOB_MARKET_SNAPSHOT_LOCALES) {
    const idx = JOB_MARKET_MONTH_NAMES[loc].indexOf(name);
    if (idx >= 1) return { year, month: idx };
  }
  return null;
}
