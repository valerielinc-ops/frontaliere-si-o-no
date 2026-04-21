/**
 * Cross-feature related-links helper for the SEO landing pages.
 *
 * Internal linking — layer 1. Every feature-specific static page
 * (fuel-daily, weekly-employers, job-market-snapshot, health-premiums,
 * orphan-landing) calls {@link generateRelatedLinksBlock} once, at the end
 * of its main content, to inject a localized `<nav>` block with 5 related
 * links pointing into other SEO features. This:
 *
 *   - propagates link equity across the 6 new feature clusters
 *   - gives Googlebot a discovery path beyond the sitemap
 *   - reduces the number of "orphan on navigation graph" pages flagged by GSC
 *
 * Link targets are built from the feature-specific path builders (no
 * hardcoded URLs for the 5 cross-feature clusters); a few stable evergreen
 * paths (job board listing root, salary hub, health comparator) are the
 * one exception and are centralised here.
 *
 * The HTML output uses inline-styled markup that is consistent with the
 * other plugin templates — no Tailwind classes, no dark-mode color
 * prefixes (compliant with no-dark-color-classes.test.ts).
 */

import {
  FUEL_DAILY_LOCALES,
  FUEL_ZONES,
  FUEL_ZONE_DISPLAY,
  buildFuelTodayPath,
  type FuelDailyLocale,
  type FuelType,
  type FuelZone,
} from '../fuelDailyData';
import {
  WEEKLY_EMPLOYERS_COMPANY_CITY_LIST,
  buildCompanyCityCurrentPath,
  buildCurrentWeekPath,
  type WeeklyEmployersCity,
  type WeeklyEmployersCompanyCity,
  type WeeklyEmployersLocale,
} from '../weeklyEmployersData';
import {
  buildHubPath as buildJobMarketHubPath,
  type JobMarketSnapshotLocale,
} from '../jobMarketSnapshotData';
import {
  buildHealthPremiumsRootPath,
  buildHealthPremiumsCantonPath,
  buildHealthPremiumsLeafPath,
  HEALTH_PREMIUM_COMPARATOR_PATH,
  HEALTH_PREMIUM_CANTON_DISPLAY,
  HEALTH_PREMIUM_AGE_LABEL,
  type HealthPremiumLocale,
  type HealthPremiumCanton,
  type HealthPremiumAgeBracket,
} from '../healthPremiumsData';
import {
  buildOggiPath as buildBorderOggiPath,
  buildRootHubPath as buildBorderRootHubPath,
  BORDER_CROSSING_DISPLAY,
  CROSSING_TO_FUEL_ZONE,
  CROSSING_TO_WEEKLY_CITY,
  type BorderCrossingSlug,
  type BorderWaitLocale,
} from '../borderWaitData';

// ── Types ────────────────────────────────────────────────────────

export type SeoPageType =
  | 'fuel_daily'
  | 'weekly_employers'
  | 'weekly_employer_company_city'
  | 'job_market_snapshot'
  | 'health_premiums'
  | 'orphan_landing'
  | 'border_wait';

export type LinkLocale = 'it' | 'en' | 'de' | 'fr';

export interface RelatedLink {
  readonly href: string;
  readonly title: string;
}

export interface RelatedLinksContext {
  readonly city?: string;
  readonly cantonSlug?: HealthPremiumCanton;
  readonly age?: HealthPremiumAgeBracket;
  readonly fuelType?: FuelType;
  readonly fuelZone?: FuelZone;
  /** Weekly-employers current city (regional "ticino" hub is the default). */
  readonly weeklyCity?: WeeklyEmployersCity;
  /** Border crossing for the border_wait page type (context for sibling links). */
  readonly borderCrossing?: BorderCrossingSlug;
  /**
   * Company slug for the weekly_employer_company_city page type — enables
   * generating a cross-link from other feature pages back to a specific
   * company × city hub when the context carries one.
   */
  readonly companySlug?: string;
  /** Canonical employer display name for copy interpolation. */
  readonly employer?: string;
}

// ── Evergreen paths (not covered by feature-specific builders) ──

/** Job board listing root per locale. */
const JOB_LISTING_ROOT: Record<LinkLocale, string> = {
  it: '/cerca-lavoro-ticino/',
  en: '/en/find-jobs-ticino/',
  de: '/de/jobs-im-tessin/',
  fr: '/fr/trouver-emploi-tessin/',
};

/** Recency hubs: "last 3 days" — locale-specific slug under the listing. */
const LAST_3_DAYS_PATH: Record<LinkLocale, string> = {
  it: '/cerca-lavoro-ticino/ultimi-3-giorni/',
  en: '/en/find-jobs-ticino/last-3-days/',
  de: '/de/jobs-im-tessin/letzte-3-tage/',
  fr: '/fr/trouver-emploi-tessin/derniers-3-jours/',
};

/** Recency hubs: "since yesterday". */
const SINCE_YESTERDAY_PATH: Record<LinkLocale, string> = {
  it: '/cerca-lavoro-ticino/da-ieri/',
  en: '/en/find-jobs-ticino/since-yesterday/',
  de: '/de/jobs-im-tessin/seit-gestern/',
  fr: '/fr/trouver-emploi-tessin/depuis-hier/',
};

/** Salary simulator / hub path (home calculator). */
const SALARY_SIM_ROOT: Record<LinkLocale, string> = {
  it: '/',
  en: '/en/',
  de: '/de/',
  fr: '/fr/',
};

/** City-hub path builder for the three geo hubs (Lugano/Mendrisio/Bellinzona). */
function cityHubPath(locale: LinkLocale, city: 'lugano' | 'mendrisio' | 'bellinzona'): string {
  return `${JOB_LISTING_ROOT[locale].replace(/\/$/, '')}/${city}/`;
}

// ── Localised strings ────────────────────────────────────────────

interface Copy {
  readonly heading: string;
  readonly fuelToday: (fuelLabel: string, zoneLabel?: string) => string;
  readonly fuelStatsTab: string;
  readonly weeklyEmployers: (cityLabel: string) => string;
  readonly jobMarketSnapshot: string;
  readonly cityJobsLugano: string;
  readonly cityJobsMendrisio: string;
  readonly cityJobsBellinzona: string;
  readonly last3Days: string;
  readonly sinceYesterday: string;
  readonly allJobs: string;
  readonly healthPremiums: string;
  readonly healthPremiumsTicino: string;
  readonly healthComparator: string;
  readonly healthPremiumCanton: (cantonLabel: string) => string;
  readonly healthPremiumAgeBracket: (label: string) => string;
  readonly salaryBenchmarks: string;
  readonly costOfLiving: string;
  readonly borderWaitCrossing: (crossing: string) => string;
  readonly borderWaitHub: string;
  readonly frontierGuide: string;
}

/**
 * Link-label / section-title copy per locale. Short phrases only — the
 * related-links block is meant for skim-reading, not long-form content.
 */
const COPY: Record<LinkLocale, Copy> = {
  it: {
    heading: 'Approfondimenti correlati',
    fuelToday: (f, z) => (z ? `Prezzo ${f.toLowerCase()} oggi a ${z}` : `Prezzo ${f.toLowerCase()} oggi in Ticino`),
    fuelStatsTab: 'Statistiche prezzi carburanti',
    weeklyEmployers: (c) => `Aziende che assumono a ${c} questa settimana`,
    jobMarketSnapshot: 'Mercato del lavoro in Ticino — report settimanale',
    cityJobsLugano: 'Offerte di lavoro a Lugano',
    cityJobsMendrisio: 'Offerte di lavoro a Mendrisio',
    cityJobsBellinzona: 'Offerte di lavoro a Bellinzona',
    last3Days: 'Offerte di lavoro degli ultimi 3 giorni',
    sinceYesterday: 'Nuove offerte di lavoro da ieri',
    allJobs: 'Tutte le offerte di lavoro in Ticino',
    healthPremiums: 'Premi cassa malati per cantone',
    healthPremiumsTicino: 'Premi cassa malati in Ticino',
    healthComparator: 'Confronta le casse malati',
    healthPremiumCanton: (c) => `Premi cassa malati — ${c}`,
    healthPremiumAgeBracket: (l) => `Premi cassa malati ${l}`,
    salaryBenchmarks: 'Benchmark salari frontalieri 2026',
    costOfLiving: 'Costo della vita Svizzera vs Italia',
    borderWaitCrossing: (c) => `Coda dogana ${c} adesso`,
    borderWaitHub: 'Tempi attesa dogane Ticino — live',
    frontierGuide: 'Guida frontaliere: permessi e fisco',
  },
  en: {
    heading: 'Related reading',
    fuelToday: (f, z) => (z ? `${f} price today in ${z}` : `${f} price today in Ticino`),
    fuelStatsTab: 'Fuel price statistics',
    weeklyEmployers: (c) => `Companies hiring in ${c} this week`,
    jobMarketSnapshot: 'Ticino job market — weekly report',
    cityJobsLugano: 'Jobs in Lugano',
    cityJobsMendrisio: 'Jobs in Mendrisio',
    cityJobsBellinzona: 'Jobs in Bellinzona',
    last3Days: 'Jobs posted in the last 3 days',
    sinceYesterday: 'New jobs since yesterday',
    allJobs: 'All Ticino jobs',
    healthPremiums: 'Health-insurance premiums by canton',
    healthPremiumsTicino: 'Health-insurance premiums in Ticino',
    healthComparator: 'Compare health insurers',
    healthPremiumCanton: (c) => `Health-insurance premiums — ${c}`,
    healthPremiumAgeBracket: (l) => `Premiums for ${l}`,
    salaryBenchmarks: 'Cross-border salary benchmarks 2026',
    costOfLiving: 'Cost of living Switzerland vs Italy',
    borderWaitCrossing: (c) => `${c} border wait right now`,
    borderWaitHub: 'Ticino border wait times — live',
    frontierGuide: 'Cross-border worker guide: permits & tax',
  },
  de: {
    heading: 'Weiterführende Seiten',
    fuelToday: (f, z) => (z ? `${f}preis heute in ${z}` : `${f}preis heute im Tessin`),
    fuelStatsTab: 'Treibstoffpreis-Statistiken',
    weeklyEmployers: (c) => `Arbeitgeber, die in ${c} diese Woche einstellen`,
    jobMarketSnapshot: 'Tessiner Arbeitsmarkt — Wochenbericht',
    cityJobsLugano: 'Jobs in Lugano',
    cityJobsMendrisio: 'Jobs in Mendrisio',
    cityJobsBellinzona: 'Jobs in Bellinzona',
    last3Days: 'Stellen der letzten 3 Tage',
    sinceYesterday: 'Neue Stellen seit gestern',
    allJobs: 'Alle Tessiner Stellen',
    healthPremiums: 'Krankenkassenprämien pro Kanton',
    healthPremiumsTicino: 'Krankenkassenprämien im Tessin',
    healthComparator: 'Krankenkassen vergleichen',
    healthPremiumCanton: (c) => `Krankenkassenprämien — ${c}`,
    healthPremiumAgeBracket: (l) => `Prämien für ${l}`,
    salaryBenchmarks: 'Lohn-Benchmarks für Grenzgänger 2026',
    costOfLiving: 'Lebenshaltungskosten Schweiz vs. Italien',
    borderWaitCrossing: (c) => `Wartezeit ${c} jetzt`,
    borderWaitHub: 'Tessin-Wartezeiten an den Grenzen — live',
    frontierGuide: 'Grenzgänger-Leitfaden: Bewilligungen & Steuern',
  },
  fr: {
    heading: 'Pour aller plus loin',
    fuelToday: (f, z) => (z ? `Prix du ${f.toLowerCase()} aujourd'hui à ${z}` : `Prix du ${f.toLowerCase()} aujourd'hui au Tessin`),
    fuelStatsTab: 'Statistiques prix carburants',
    weeklyEmployers: (c) => `Entreprises qui recrutent à ${c} cette semaine`,
    jobMarketSnapshot: 'Marché du travail au Tessin — rapport hebdomadaire',
    cityJobsLugano: 'Offres à Lugano',
    cityJobsMendrisio: 'Offres à Mendrisio',
    cityJobsBellinzona: 'Offres à Bellinzona',
    last3Days: 'Offres des 3 derniers jours',
    sinceYesterday: 'Nouvelles offres depuis hier',
    allJobs: 'Toutes les offres au Tessin',
    healthPremiums: 'Primes assurance-maladie par canton',
    healthPremiumsTicino: 'Primes assurance-maladie au Tessin',
    healthComparator: 'Comparer les caisses-maladie',
    healthPremiumCanton: (c) => `Primes assurance-maladie — ${c}`,
    healthPremiumAgeBracket: (l) => `Primes pour ${l}`,
    salaryBenchmarks: 'Benchmarks salariaux frontaliers 2026',
    costOfLiving: 'Coût de la vie Suisse vs Italie',
    borderWaitCrossing: (c) => `File à ${c} en ce moment`,
    borderWaitHub: 'Temps d\'attente aux douanes du Tessin — direct',
    frontierGuide: 'Guide frontalier : permis & fiscalité',
  },
};

// ── Helpers ─────────────────────────────────────────────────────

function escHtml(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Map a fuel zone to the display label in the given locale (proper noun). */
function zoneLabel(zone: FuelZone): string {
  return FUEL_ZONE_DISPLAY[zone];
}

/**
 * Fuel-type display label per locale — kept here (and not imported from
 * fuelDailyData) to avoid a cross-module transitive dependency cycle.
 */
function fuelLabel(locale: LinkLocale, fuel: FuelType): string {
  if (fuel === 'diesel') return locale === 'de' || locale === 'en' || locale === 'it' ? 'Diesel' : 'Gasoil';
  // benzina
  if (locale === 'it') return 'Benzina';
  if (locale === 'en') return 'Gasoline';
  if (locale === 'de') return 'Benzin';
  return 'Essence';
}

/** Pick 2–3 sibling fuel zones (not the one passed in) for the fuel_daily links. */
function pickSiblingFuelZones(current: FuelZone | undefined, count: number): FuelZone[] {
  const out: FuelZone[] = [];
  for (const z of FUEL_ZONES) {
    if (z === current) continue;
    out.push(z);
    if (out.length >= count) break;
  }
  return out;
}

/** Normalize a string to a weekly-employers city key (falls back to 'ticino'). */
function normalizeWeeklyCity(raw: string | undefined): WeeklyEmployersCity {
  if (!raw) return 'ticino';
  const lc = raw.toLowerCase();
  if (lc === 'ticino' || lc === 'lugano' || lc === 'mendrisio' || lc === 'chiasso'
    || lc === 'stabio' || lc === 'bellinzona' || lc === 'locarno') {
    return lc as WeeklyEmployersCity;
  }
  return 'ticino';
}

/**
 * Pick the primary border-wait crossing for a given fuel zone / city context.
 * Used when we want to add one border-wait link inside the fuel-daily and
 * weekly-employers related-links blocks.
 */
function crossingForCityOrZone(cityOrZone: string | undefined): BorderCrossingSlug {
  if (!cityOrZone) return 'chiasso-brogeda';
  const lc = cityOrZone.toLowerCase();
  if (lc === 'mendrisio' || lc === 'stabio') return 'gaggiolo';
  if (lc === 'lugano' || lc === 'bellinzona' || lc === 'locarno') return 'ponte-tresa';
  // Default: chiasso-brogeda (covers chiasso zone + regional fallback)
  return 'chiasso-brogeda';
}

/** Pick 2 sibling crossings (not the one passed) in the same region when possible. */
function pickSiblingCrossings(
  current: BorderCrossingSlug,
  count: number,
): BorderCrossingSlug[] {
  // Prefer traffic-heavy siblings: pick from the top-5 list first
  const top5: BorderCrossingSlug[] = [
    'chiasso-brogeda',
    'chiasso-centro',
    'gaggiolo',
    'oria-gandria',
    'ponte-tresa',
  ];
  const out: BorderCrossingSlug[] = [];
  for (const c of top5) {
    if (c === current) continue;
    out.push(c);
    if (out.length >= count) break;
  }
  return out;
}

// ── Link builders per page type ─────────────────────────────────

function linksForFuelDaily(locale: LinkLocale, copy: Copy, ctx?: RelatedLinksContext): RelatedLink[] {
  const fuel: FuelType = ctx?.fuelType ?? 'diesel';
  const zone = ctx?.fuelZone;
  const weeklyCity = normalizeWeeklyCity(ctx?.city ?? zone);
  const fuelDailyLocale = locale as FuelDailyLocale;
  const weeklyLocale = locale as WeeklyEmployersLocale;
  const jobMarketLocale = locale as JobMarketSnapshotLocale;
  const fuelL = fuelLabel(locale, fuel);

  const siblings = pickSiblingFuelZones(zone, 2);
  const out: RelatedLink[] = [];

  // 1) Weekly employers for the same city (or Ticino regional).
  out.push({
    href: buildCurrentWeekPath(weeklyLocale, weeklyCity),
    title: copy.weeklyEmployers(
      weeklyCity === 'ticino' ? (locale === 'it' ? 'Ticino' : 'Ticino') : FUEL_ZONE_DISPLAY[weeklyCity as FuelZone] || weeklyCity,
    ),
  });

  // 2) Job-market snapshot hub.
  out.push({ href: buildJobMarketHubPath(jobMarketLocale), title: copy.jobMarketSnapshot });

  // 3) Border-wait for the crossing closest to this zone — bidirectional
  //    internal link (fuel-zone ↔ border-wait) that satisfies the F8 test
  //    gate and gives commuters a quick "check queue before you fill up"
  //    path.
  {
    const borderCrossing = crossingForCityOrZone(zone ?? ctx?.city);
    out.push({
      href: buildBorderOggiPath(locale as BorderWaitLocale, borderCrossing),
      title: copy.borderWaitCrossing(BORDER_CROSSING_DISPLAY[borderCrossing]),
    });
  }

  // 4) One sibling fuel zone (same fuel, same locale).
  for (const sib of siblings.slice(0, 1)) {
    out.push({
      href: buildFuelTodayPath(fuelDailyLocale, fuel, sib),
      title: copy.fuelToday(fuelL, zoneLabel(sib)),
    });
  }

  // 5) All jobs (listing root) for the locale — broad discovery anchor.
  out.push({ href: JOB_LISTING_ROOT[locale], title: copy.allJobs });

  return out.slice(0, 5);
}

function linksForWeeklyEmployers(locale: LinkLocale, copy: Copy, ctx?: RelatedLinksContext): RelatedLink[] {
  const weeklyLocale = locale as WeeklyEmployersLocale;
  const fuelDailyLocale = locale as FuelDailyLocale;
  const jobMarketLocale = locale as JobMarketSnapshotLocale;
  const weeklyCity = normalizeWeeklyCity(ctx?.weeklyCity ?? ctx?.city);

  const out: RelatedLink[] = [];

  // 1) Job-market weekly report hub.
  out.push({ href: buildJobMarketHubPath(jobMarketLocale), title: copy.jobMarketSnapshot });

  // 2) City-jobs hub (Lugano/Mendrisio/Bellinzona) if the weekly city is one.
  if (weeklyCity === 'lugano') {
    out.push({ href: cityHubPath(locale, 'lugano'), title: copy.cityJobsLugano });
  } else if (weeklyCity === 'mendrisio') {
    out.push({ href: cityHubPath(locale, 'mendrisio'), title: copy.cityJobsMendrisio });
  } else if (weeklyCity === 'bellinzona') {
    out.push({ href: cityHubPath(locale, 'bellinzona'), title: copy.cityJobsBellinzona });
  } else {
    out.push({ href: cityHubPath(locale, 'lugano'), title: copy.cityJobsLugano });
  }

  // 3) Recency hubs: last 3 days.
  out.push({ href: LAST_3_DAYS_PATH[locale], title: copy.last3Days });

  // 4) Fuel daily for the same city (fall back to regional).
  const fuelZoneForCity: FuelZone | undefined =
    weeklyCity === 'lugano' || weeklyCity === 'mendrisio'
      || weeklyCity === 'chiasso' || weeklyCity === 'bellinzona'
      || weeklyCity === 'locarno'
      ? weeklyCity
      : undefined;
  out.push({
    href: buildFuelTodayPath(fuelDailyLocale, 'diesel', fuelZoneForCity),
    title: copy.fuelToday(fuelLabel(locale, 'diesel'), fuelZoneForCity ? zoneLabel(fuelZoneForCity) : undefined),
  });

  // 5) Border-wait for the crossing closest to this city — "check the queue
  //    before you commute to the job" is a natural cross-link.
  {
    const borderCrossing = crossingForCityOrZone(weeklyCity);
    out.push({
      href: buildBorderOggiPath(locale as BorderWaitLocale, borderCrossing),
      title: copy.borderWaitCrossing(BORDER_CROSSING_DISPLAY[borderCrossing]),
    });
  }

  return out.slice(0, 5);
}

function linksForBorderWait(locale: LinkLocale, copy: Copy, ctx?: RelatedLinksContext): RelatedLink[] {
  const weeklyLocale = locale as WeeklyEmployersLocale;
  const fuelDailyLocale = locale as FuelDailyLocale;
  const borderLocale = locale as BorderWaitLocale;
  const currentCrossing = ctx?.borderCrossing ?? 'chiasso-brogeda';
  const fuelZone = ctx?.fuelZone ?? CROSSING_TO_FUEL_ZONE[currentCrossing];
  const weeklyCity = normalizeWeeklyCity(ctx?.city ?? CROSSING_TO_WEEKLY_CITY[currentCrossing]);

  const out: RelatedLink[] = [];

  // 1) Fuel daily for the closest zone — commuters fill up on the Swiss side.
  out.push({
    href: buildFuelTodayPath(fuelDailyLocale, 'diesel', fuelZone),
    title: copy.fuelToday(fuelLabel(locale, 'diesel'), zoneLabel(fuelZone)),
  });

  // 2) Weekly employers for the closest city.
  out.push({
    href: buildCurrentWeekPath(weeklyLocale, weeklyCity),
    title: copy.weeklyEmployers(
      weeklyCity === 'ticino'
        ? locale === 'de' || locale === 'fr'
          ? 'Tessin'
          : 'Ticino'
        : FUEL_ZONE_DISPLAY[weeklyCity as FuelZone] || weeklyCity,
    ),
  });

  // 3-4) Two sibling crossings — same region traffic alternatives.
  const siblings = pickSiblingCrossings(currentCrossing, 2);
  for (const sib of siblings) {
    out.push({
      href: buildBorderOggiPath(borderLocale, sib),
      title: copy.borderWaitCrossing(BORDER_CROSSING_DISPLAY[sib]),
    });
  }

  // 5) Frontier worker guide (generic evergreen anchor).
  out.push({ href: JOB_LISTING_ROOT[locale], title: copy.frontierGuide });

  return out.slice(0, 5);
}

function linksForWeeklyEmployerCompanyCity(
  locale: LinkLocale,
  copy: Copy,
  ctx?: RelatedLinksContext,
): RelatedLink[] {
  const weeklyLocale = locale as WeeklyEmployersLocale;
  const fuelDailyLocale = locale as FuelDailyLocale;
  const jobMarketLocale = locale as JobMarketSnapshotLocale;
  const city = normalizeWeeklyCity(ctx?.weeklyCity ?? ctx?.city);
  const out: RelatedLink[] = [];

  // 1) Parent F5 city hub.
  out.push({
    href: buildCurrentWeekPath(weeklyLocale, city),
    title: copy.weeklyEmployers(WEEKLY_EMPLOYERS_CITY_DISPLAY_FOR_LINK(city)),
  });

  // 2) Job-market snapshot hub.
  out.push({ href: buildJobMarketHubPath(jobMarketLocale), title: copy.jobMarketSnapshot });

  // 3) Fuel price in same city (diesel — most common commuter fuel).
  const fuelZoneForCity: FuelZone | undefined =
    city === 'lugano'
      || city === 'mendrisio'
      || city === 'chiasso'
      || city === 'bellinzona'
      || city === 'locarno'
      ? (city as FuelZone)
      : undefined;
  out.push({
    href: buildFuelTodayPath(fuelDailyLocale, 'diesel', fuelZoneForCity),
    title: copy.fuelToday(
      fuelLabel(locale, 'diesel'),
      fuelZoneForCity ? zoneLabel(fuelZoneForCity) : undefined,
    ),
  });

  // 4) Sibling city for same company (picks first other company-city city from the canonical list).
  const companySlug = ctx?.companySlug;
  if (companySlug && /^[a-z0-9][a-z0-9-]*$/.test(companySlug)) {
    const sibling = WEEKLY_EMPLOYERS_COMPANY_CITY_LIST.find(
      (c) => c !== city,
    ) as WeeklyEmployersCompanyCity | undefined;
    if (sibling) {
      out.push({
        href: buildCompanyCityCurrentPath(weeklyLocale, sibling, companySlug),
        title: copy.weeklyEmployers(WEEKLY_EMPLOYERS_CITY_DISPLAY_FOR_LINK(sibling)),
      });
    }
  }

  // 5) Border-wait for the closest crossing.
  {
    const borderCrossing = crossingForCityOrZone(city);
    out.push({
      href: buildBorderOggiPath(locale as BorderWaitLocale, borderCrossing),
      title: copy.borderWaitCrossing(BORDER_CROSSING_DISPLAY[borderCrossing]),
    });
  }

  // Guarantee exactly 5 entries (fallbacks to city hub / recency hub if missing).
  while (out.length < 5) {
    out.push({ href: JOB_LISTING_ROOT[locale], title: copy.allJobs });
  }
  return out.slice(0, 5);
}

/**
 * Display label for a weekly-employers city (used inside localized copy
 * templates that render "Companies hiring in {city} this week").
 */
function WEEKLY_EMPLOYERS_CITY_DISPLAY_FOR_LINK(city: WeeklyEmployersCity): string {
  const map: Record<WeeklyEmployersCity, string> = {
    ticino: 'Ticino',
    lugano: 'Lugano',
    mendrisio: 'Mendrisio',
    chiasso: 'Chiasso',
    stabio: 'Stabio',
    bellinzona: 'Bellinzona',
    locarno: 'Locarno',
  };
  return map[city];
}

function linksForJobMarketSnapshot(locale: LinkLocale, copy: Copy, _ctx?: RelatedLinksContext): RelatedLink[] {
  const weeklyLocale = locale as WeeklyEmployersLocale;
  const out: RelatedLink[] = [];

  // 1) Weekly employers Ticino regional.
  out.push({ href: buildCurrentWeekPath(weeklyLocale, 'ticino'), title: copy.weeklyEmployers(locale === 'de' ? 'Tessin' : locale === 'fr' ? 'Tessin' : 'Ticino') });

  // 2-3) City hubs (Lugano, Mendrisio).
  out.push({ href: cityHubPath(locale, 'lugano'), title: copy.cityJobsLugano });
  out.push({ href: cityHubPath(locale, 'mendrisio'), title: copy.cityJobsMendrisio });

  // 4) Recency hub — last 3 days.
  out.push({ href: LAST_3_DAYS_PATH[locale], title: copy.last3Days });

  // 5) Salary benchmarks home (calculator root).
  out.push({ href: SALARY_SIM_ROOT[locale], title: copy.salaryBenchmarks });

  return out.slice(0, 5);
}

function linksForHealthPremiums(locale: LinkLocale, copy: Copy, ctx?: RelatedLinksContext): RelatedLink[] {
  const hpLocale = locale as HealthPremiumLocale;
  const out: RelatedLink[] = [];

  const currentCanton: HealthPremiumCanton = ctx?.cantonSlug ?? 'ticino';
  const currentAge: HealthPremiumAgeBracket | undefined = ctx?.age;

  // 1) Health comparator.
  out.push({ href: HEALTH_PREMIUM_COMPARATOR_PATH[hpLocale], title: copy.healthComparator });

  // 2) Root health-premiums hub (or alternate canton when current IS ticino).
  if (currentCanton === 'ticino') {
    out.push({
      href: buildHealthPremiumsCantonPath(hpLocale, 'grigioni'),
      title: copy.healthPremiumCanton(HEALTH_PREMIUM_CANTON_DISPLAY[hpLocale].grigioni),
    });
  } else {
    out.push({
      href: buildHealthPremiumsCantonPath(hpLocale, 'ticino'),
      title: copy.healthPremiumCanton(HEALTH_PREMIUM_CANTON_DISPLAY[hpLocale].ticino),
    });
  }

  // 3-4) Sibling age brackets (different from current).
  const allAges: HealthPremiumAgeBracket[] = ['0-18', '19-25', '26-30', '31-45', '46-55', '56-plus'];
  const siblings = allAges.filter((a) => a !== currentAge).slice(0, 2);
  for (const s of siblings) {
    out.push({
      href: buildHealthPremiumsLeafPath(hpLocale, currentCanton, s),
      title: copy.healthPremiumAgeBracket(HEALTH_PREMIUM_AGE_LABEL[hpLocale][s]),
    });
  }

  // 5) Salary benchmarks (fiscal-adjacent — net salary drives insurer choice).
  out.push({ href: SALARY_SIM_ROOT[locale], title: copy.salaryBenchmarks });

  return out.slice(0, 5);
}

function linksForOrphanLanding(locale: LinkLocale, copy: Copy, ctx?: RelatedLinksContext): RelatedLink[] {
  const jobMarketLocale = locale as JobMarketSnapshotLocale;
  const weeklyLocale = locale as WeeklyEmployersLocale;
  const weeklyCity = normalizeWeeklyCity(ctx?.city);

  const out: RelatedLink[] = [];

  // 1) Main job listing root.
  out.push({ href: JOB_LISTING_ROOT[locale], title: copy.allJobs });

  // 2) City hub if we infer one from context (else Lugano default).
  if (weeklyCity === 'mendrisio') {
    out.push({ href: cityHubPath(locale, 'mendrisio'), title: copy.cityJobsMendrisio });
  } else if (weeklyCity === 'bellinzona') {
    out.push({ href: cityHubPath(locale, 'bellinzona'), title: copy.cityJobsBellinzona });
  } else {
    out.push({ href: cityHubPath(locale, 'lugano'), title: copy.cityJobsLugano });
  }

  // 3) Job-market snapshot.
  out.push({ href: buildJobMarketHubPath(jobMarketLocale), title: copy.jobMarketSnapshot });

  // 4) Weekly employers (same city or Ticino).
  out.push({
    href: buildCurrentWeekPath(weeklyLocale, weeklyCity),
    title: copy.weeklyEmployers(locale === 'de' || locale === 'fr' ? 'Tessin' : 'Ticino'),
  });

  // 5) "Since yesterday" recency hub.
  out.push({ href: SINCE_YESTERDAY_PATH[locale], title: copy.sinceYesterday });

  return out.slice(0, 5);
}

// ── Public API ──────────────────────────────────────────────────

/**
 * Compute the 5 cross-feature related links for the given page type + locale.
 * Exposed separately from the HTML renderer so tests can assert link targets
 * and labels without parsing HTML.
 */
export function generateRelatedLinks(
  locale: LinkLocale,
  pageType: SeoPageType,
  context?: RelatedLinksContext,
): RelatedLink[] {
  const copy = COPY[locale];
  switch (pageType) {
    case 'fuel_daily':
      return linksForFuelDaily(locale, copy, context);
    case 'weekly_employers':
      return linksForWeeklyEmployers(locale, copy, context);
    case 'weekly_employer_company_city':
      return linksForWeeklyEmployerCompanyCity(locale, copy, context);
    case 'job_market_snapshot':
      return linksForJobMarketSnapshot(locale, copy, context);
    case 'health_premiums':
      return linksForHealthPremiums(locale, copy, context);
    case 'orphan_landing':
      return linksForOrphanLanding(locale, copy, context);
    case 'border_wait':
      return linksForBorderWait(locale, copy, context);
    default: {
      const exhaustive: never = pageType;
      throw new Error(`unknown SeoPageType: ${String(exhaustive)}`);
    }
  }
}

/**
 * Render the related-links block as a complete `<nav>` HTML string ready
 * to be inlined at the end of a page body (before the closing `</main>`).
 *
 * The aria-label reflects the section heading so screen-reader users have a
 * unique landmark even if multiple `<nav>` elements coexist on the page.
 *
 * CSS is inlined via `style=` attributes (consistent with the rest of the
 * plugin HTML) — no Tailwind classes, no `dark:` prefixes.
 */
export function generateRelatedLinksBlock(
  locale: LinkLocale,
  pageType: SeoPageType,
  context?: RelatedLinksContext,
): string {
  const copy = COPY[locale];
  const links = generateRelatedLinks(locale, pageType, context);
  if (links.length === 0) return '';
  const items = links
    .map(
      (l) => `<li style="margin:0;padding:0"><a href="${escHtml(l.href)}" style="display:inline-block;padding:8px 0;color:#1d4ed8;text-decoration:none;font-weight:600;line-height:1.4">${escHtml(l.title)} →</a></li>`,
    )
    .join('');
  const ariaLabel = copy.heading;
  return `<nav id="seoRelatedLinks" aria-label="${escHtml(ariaLabel)}" style="margin:32px 0 0;padding:20px 22px;border-radius:18px;background:#f8fafc;border:1px solid #e2e8f0">
    <h2 style="margin:0 0 12px;font-size:18px;color:#0f172a">${escHtml(copy.heading)}</h2>
    <ul style="margin:0;padding:0;list-style:none;display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:6px 18px">${items}</ul>
  </nav>`;
}
