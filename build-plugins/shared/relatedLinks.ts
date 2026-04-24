/**
 * Cross-feature related-links helper for the SEO landing pages (D-2 Expansion C).
 *
 * Layer 1 internal linking — every feature-specific static page
 * (fuel-daily, fuel-station, weekly-employers, weekly-employer × city × company,
 * job-market-snapshot, health-premiums, orphan-landing, border-wait) calls
 * {@link generateRelatedLinksBlock} once, at the end of its main content, to
 * inject a localized `<nav>` block with **10-12 curated links** organised in
 * three semantic clusters:
 *
 *   1. **Sibling links** (4-6): pages of the same `pageType` but for a
 *      different dimension (sibling zone / sibling city / sibling crossing /
 *      sibling age bracket). Drives "related results" intent.
 *   2. **Parent hubs** (2-3): links that move the crawler one level up the
 *      information hierarchy (per-zone leaf → regional hub → site root).
 *   3. **Cross-category** (3-4): semantically-affine links in OTHER feature
 *      clusters (fuel ↔ border-wait ↔ weekly-employers, health ↔ calculator,
 *      etc.). Distributes link equity across the feature graph so Googlebot
 *      discovers the entire SEO surface from any single landing page.
 *
 * The HTML output is semantic & accessible: one `<nav aria-label="…">`
 * container wrapping three `<section>` cards, each with an `<h3>` heading
 * and an unordered list of `<a>` anchors. Colours use `index.css` semantic
 * tokens (`color-accent`, `color-surface-alt`, `color-edge`, `color-subtle`)
 * — zero hardcoded palette values, zero `dark:` prefixes (enforced by
 * `no-dark-color-classes.test.ts`).
 *
 * Backwards compatibility:
 *   - `generateRelatedLinksBlock(locale, pageType, ctx)` returns the HTML
 *     string — same signature as the pre-D-2C helper, existing plugin call
 *     sites keep working unchanged.
 *   - `generateRelatedLinks(locale, pageType, ctx)` returns the flat list
 *     (for tests that don't care about section grouping).
 *   - `generateRelatedLinksStructured(locale, pageType, ctx)` is the new
 *     entry-point that returns `{ sections, html }` with per-section
 *     metadata useful for granular assertions.
 *
 * Hard caps:
 *   - Max 12 links per page (overflow truncated silently from the tail).
 *   - Min 6 links per page — if we can't produce 6 for a given context we
 *     fall back to the legacy 5-link list to avoid thin link blocks.
 */

import {
  FUEL_ITALIAN_CITIES,
  FUEL_ZONES,
  FUEL_ZONE_DISPLAY,
  buildFuelItalianCityPath,
  buildFuelStationPath as buildLocalizedFuelStationPath,
  buildFuelTodayPath,
  type FuelDailyLocale,
  type FuelType,
  type FuelZone,
} from '../fuelDailyData';
import {
  WEEKLY_EMPLOYERS_CITIES,
  WEEKLY_EMPLOYERS_CITY_DISPLAY,
  buildCurrentWeekPath,
  type WeeklyEmployersCity,
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
  HEALTH_PREMIUM_CANTONS,
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
  buildRegionalHubPath as buildBorderRegionalHubPath,
  BORDER_CROSSING_DISPLAY,
  BORDER_REGION_DISPLAY,
  CROSSING_TO_REGION,
  CROSSING_TO_FUEL_ZONE,
  CROSSING_TO_WEEKLY_CITY,
  TOP_5_CROSSINGS,
  type BorderCrossingSlug,
  type BorderWaitLocale,
} from '../borderWaitData';
import {
  buildCostOfLivingLandingPath,
  COL_CITY_DISPLAY,
  COL_CITY_IDS,
  type ColCityId,
  type ColLocale,
} from '../costOfLivingLandingsData';

// ── Public types ─────────────────────────────────────────────────

export type SeoPageType =
  | 'fuel_daily'
  | 'fuel_station'
  | 'fuel_italian_city'
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
  /** Optional `rel` attribute — e.g. when linking to a commercial comparator. */
  readonly rel?: string;
}

export interface RelatedLinkSection {
  /** Semantic key for the section (sibling / hubs / cross). */
  readonly kind: 'sibling' | 'hubs' | 'cross';
  /** Translation key that identifies the heading copy. */
  readonly titleKey: string;
  /** Localized heading text (pre-rendered for HTML emission). */
  readonly heading: string;
  /** Localized aria-label for the `<section>` landmark. */
  readonly ariaLabel: string;
  /** Ordered links in this section. Already truncated to cluster caps. */
  readonly links: readonly RelatedLink[];
}

export interface RelatedLinksOutput {
  readonly sections: readonly RelatedLinkSection[];
  /** All links flattened, capped at 12 — convenient for count assertions. */
  readonly flat: readonly RelatedLink[];
  /** Rendered HTML block ready to inline in static pages. */
  readonly html: string;
}

/**
 * Context for richer sibling + cross-category lookup. All fields optional —
 * callers pass the subset relevant to the current page.
 */
export interface RelatedLinksContext {
  // Fuel
  readonly fuelType?: FuelType;
  readonly fuelZone?: FuelZone;
  /** NEW — Swiss station slug under `/prezzi-{fuel}/{city}/stazioni/{slug}/`. */
  readonly stationSlug?: string;
  /** Pre-computed sibling Swiss stations (same city) — surfaced in sibling cluster. */
  readonly siblingStations?: ReadonlyArray<{ slug: string; brand: string; zone: FuelZone }>;
  /** NEW — Italian border city slug under `/prezzi-{fuel}/italia/{city}/`. */
  readonly italianCity?: string;
  /** Alias of italianCity (back-compat with D-2A callers). */
  readonly italianCitySlug?: string;
  /** Italian city display name for copy interpolation. */
  readonly italianCityDisplay?: string;

  // Weekly employers
  readonly city?: string;
  readonly weeklyCity?: WeeklyEmployersCity;
  /** NEW — employer slug for per-company × per-city pages. */
  readonly companySlug?: string;
  /** Canonical employer display name for copy interpolation. */
  readonly employer?: string;
  /** Actual sibling cities where the SAME company has a generated page. When
   *  provided, overrides the default `pickSiblingCities` guess so we only
   *  surface links to pages that really exist (avoids broken sibling links). */
  readonly companySiblingCities?: ReadonlyArray<WeeklyEmployersCity>;

  // Health premiums
  readonly cantonSlug?: HealthPremiumCanton;
  readonly age?: HealthPremiumAgeBracket;

  // Border wait
  readonly borderCrossing?: BorderCrossingSlug;

  // Orphan landings
  readonly queryClusterSlug?: string;
}

// ── Backwards-compatible alias kept for external imports. ────────
export type RelatedLinksCtx = RelatedLinksContext;

// ── Evergreen paths (not covered by feature-specific builders) ──

const JOB_LISTING_ROOT: Record<LinkLocale, string> = {
  it: '/cerca-lavoro-ticino/',
  en: '/en/find-jobs-ticino/',
  de: '/de/jobs-im-tessin/',
  fr: '/fr/trouver-emploi-tessin/',
};

const LAST_3_DAYS_PATH: Record<LinkLocale, string> = {
  it: '/cerca-lavoro-ticino/ultimi-3-giorni/',
  en: '/en/find-jobs-ticino/last-3-days/',
  de: '/de/jobs-im-tessin/letzte-3-tage/',
  fr: '/fr/trouver-emploi-tessin/derniers-3-jours/',
};

const SINCE_YESTERDAY_PATH: Record<LinkLocale, string> = {
  it: '/cerca-lavoro-ticino/da-ieri/',
  en: '/en/find-jobs-ticino/since-yesterday/',
  de: '/de/jobs-im-tessin/seit-gestern/',
  fr: '/fr/trouver-emploi-tessin/depuis-hier/',
};

const SALARY_SIM_ROOT: Record<LinkLocale, string> = {
  it: '/',
  en: '/en/',
  de: '/de/',
  fr: '/fr/',
};

/** Salary hub (distinct from home — more content-heavy benchmark page). */
const SALARY_HUB_PATH: Record<LinkLocale, string> = {
  it: '/statistiche/confronta-stipendi/',
  en: '/en/statistics/compare-salaries/',
  de: '/de/statistiken/gehaelter-vergleichen/',
  fr: '/fr/statistiques/comparer-salaires/',
};

/** Frontier-worker guide (permits + tax). */
const FRONTIER_GUIDE_PATH: Record<LinkLocale, string> = {
  it: '/guida-frontaliere/',
  en: '/en/cross-border-guide/',
  de: '/de/grenzgaenger-ratgeber/',
  fr: '/fr/guide-frontalier/',
};

/** City-hub path builder (Lugano / Mendrisio / Bellinzona — editorial landings). */
function cityHubPath(locale: LinkLocale, city: 'lugano' | 'mendrisio' | 'bellinzona'): string {
  return `${JOB_LISTING_ROOT[locale].replace(/\/$/, '')}/${city}/`;
}

/**
 * Only link to Italian fuel-city hubs that are actually emitted in the current
 * build pipeline. Some curated cities exist in the master list for future
 * expansion but do not currently generate static landing pages.
 */
const RELATED_FUEL_ITALIAN_CITY_SLUGS = new Set([
  'como',
  'varese',
  'luino',
  'gallarate',
  'cantu',
  'saronno',
  'menaggio',
  'sondrio',
  'tirano',
  'chiavenna',
  'morbegno',
]);

// ── Fuel station path builder (hub-and-spoke URL pattern) ────────

/**
 * `/prezzi-{fuel}/{city}/stazioni/{slug}/` — shape agreed with D-2A (hub-and-spoke).
 * Defined here so the cross-feature helper can emit placeholder sibling links
 * even before D-2A ships its feature plugin.
 */
function buildFuelStationPath(
  locale: FuelDailyLocale,
  fuel: FuelType,
  zone: FuelZone,
  stationSlug: string,
): string {
  return buildLocalizedFuelStationPath(locale, fuel, zone, stationSlug);
}

/** `/prezzi-{fuel}/italia/{city}/` — IT city landing. */
function buildItalianCityPath(
  locale: FuelDailyLocale,
  fuel: FuelType,
  italianCity: string,
): string {
  return buildFuelItalianCityPath(locale, fuel, italianCity);
}

/** `/aziende-che-assumono/{city}/{company}/settimana-corrente/` — F5 per-company. */
function buildWeeklyCompanyCityPath(
  locale: WeeklyEmployersLocale,
  city: WeeklyEmployersCity,
  companySlug: string,
): string {
  // Use the city current-week path as a spine and splice in the company slug
  // before the trailing "settimana-corrente" segment.
  const current = buildCurrentWeekPath(locale, city);
  // current ends with "/{current-week-slug}/". Inject the company before it.
  return current.replace(/\/([^/]+)\/$/, `/${companySlug}/$1/`);
}

// ── Localised strings ────────────────────────────────────────────

interface SectionHeadings {
  readonly nav: string;
  readonly siblingGeneric: string;
  readonly siblingFuelZones: string;
  readonly siblingFuelStations: string;
  readonly siblingItalianCities: string;
  readonly siblingCities: string;
  readonly siblingCompanyCities: string;
  readonly siblingWeeks: string;
  readonly siblingAges: string;
  readonly siblingCrossings: string;
  readonly siblingClusters: string;
  readonly hubs: string;
  readonly cross: string;
}

interface Copy {
  readonly headings: SectionHeadings;
  readonly fuelToday: (fuelLabel: string, zoneLabel?: string) => string;
  readonly fuelStation: (brandOrStation: string, zoneLabel: string) => string;
  readonly fuelItalianCity: (city: string, fuelLabel: string) => string;
  readonly fuelStatsTab: string;
  readonly weeklyEmployers: (cityLabel: string) => string;
  readonly weeklyEmployerCompany: (company: string, city: string) => string;
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
  readonly salaryHub: string;
  readonly costOfLiving: string;
  readonly costOfLivingCity: (cityLabel: string) => string;
  readonly borderWaitCrossing: (crossing: string) => string;
  readonly borderWaitRegion: (region: string) => string;
  readonly borderWaitHub: string;
  readonly frontierGuide: string;
  readonly salarySim: string;
}

/**
 * Section heading + link-label copy per locale. These strings are inlined in
 * static HTML — the client-facing `i18n` framework also mirrors the section
 * heading keys under `services/locales/{lc}-seo-links.ts` for components that
 * might reference them (footer, banners).
 */
const COPY: Record<LinkLocale, Copy> = {
  it: {
    headings: {
      nav: 'Correlati',
      siblingGeneric: 'Pagine correlate',
      siblingFuelZones: 'Altre zone del Ticino',
      siblingFuelStations: 'Altre stazioni nella zona',
      siblingItalianCities: 'Altre città italiane al confine',
      siblingCities: 'Altre città del Ticino',
      siblingCompanyCities: 'Stessa azienda in altre città',
      siblingWeeks: 'Settimane precedenti',
      siblingAges: 'Altre fasce d\'età',
      siblingCrossings: 'Altri valichi della stessa zona',
      siblingClusters: 'Ricerche correlate',
      hubs: 'Hub principali',
      cross: 'Altri strumenti per il frontaliere',
    },
    fuelToday: (f, z) => (z ? `Prezzo ${f.toLowerCase()} oggi a ${z}` : `Prezzo ${f.toLowerCase()} oggi in Ticino`),
    fuelStation: (s, z) => `Stazione ${s} a ${z}`,
    fuelItalianCity: (c, f) => `Prezzo ${f.toLowerCase()} a ${c} (IT)`,
    fuelStatsTab: 'Statistiche prezzi carburanti',
    weeklyEmployers: (c) => `Aziende che assumono a ${c} questa settimana`,
    weeklyEmployerCompany: (co, ci) => `${co} che assume a ${ci}`,
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
    salaryHub: 'Stipendi frontalieri Ticino',
    costOfLiving: 'Costo della vita Svizzera vs Italia',
    costOfLivingCity: (c) => `Costo della vita a ${c}: affitti, spesa, trasporti`,
    borderWaitCrossing: (c) => `Coda dogana ${c} adesso`,
    borderWaitRegion: (r) => `Tempi attesa ${r}`,
    borderWaitHub: 'Tempi attesa dogane Ticino — live',
    frontierGuide: 'Guida frontaliere: permessi e fisco',
    salarySim: 'Calcola lo stipendio frontaliere',
  },
  en: {
    headings: {
      nav: 'Related',
      siblingGeneric: 'Related pages',
      siblingFuelZones: 'Other Ticino areas',
      siblingFuelStations: 'Other stations in the area',
      siblingItalianCities: 'Other Italian border cities',
      siblingCities: 'Other Ticino cities',
      siblingCompanyCities: 'Same employer in other cities',
      siblingWeeks: 'Previous weeks',
      siblingAges: 'Other age brackets',
      siblingCrossings: 'Other crossings in the same region',
      siblingClusters: 'Related searches',
      hubs: 'Main hubs',
      cross: 'Other cross-border worker tools',
    },
    fuelToday: (f, z) => (z ? `${f} price today in ${z}` : `${f} price today in Ticino`),
    fuelStation: (s, z) => `${s} station in ${z}`,
    fuelItalianCity: (c, f) => `${f} price in ${c} (IT)`,
    fuelStatsTab: 'Fuel price statistics',
    weeklyEmployers: (c) => `Companies hiring in ${c} this week`,
    weeklyEmployerCompany: (co, ci) => `${co} hiring in ${ci}`,
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
    salaryHub: 'Cross-border salaries Ticino',
    costOfLiving: 'Cost of living Switzerland vs Italy',
    costOfLivingCity: (c) => `Cost of living in ${c}: rents, groceries, transport`,
    borderWaitCrossing: (c) => `${c} border wait right now`,
    borderWaitRegion: (r) => `${r} border wait times`,
    borderWaitHub: 'Ticino border wait times — live',
    frontierGuide: 'Cross-border worker guide: permits & tax',
    salarySim: 'Salary calculator',
  },
  de: {
    headings: {
      nav: 'Verwandt',
      siblingGeneric: 'Verwandte Seiten',
      siblingFuelZones: 'Weitere Tessin-Regionen',
      siblingFuelStations: 'Weitere Tankstellen in der Region',
      siblingItalianCities: 'Weitere italienische Grenzstädte',
      siblingCities: 'Weitere Tessiner Städte',
      siblingCompanyCities: 'Gleicher Arbeitgeber in anderen Städten',
      siblingWeeks: 'Vorherige Wochen',
      siblingAges: 'Weitere Altersgruppen',
      siblingCrossings: 'Weitere Übergänge derselben Region',
      siblingClusters: 'Ähnliche Suchanfragen',
      hubs: 'Hauptseiten',
      cross: 'Weitere Grenzgänger-Werkzeuge',
    },
    fuelToday: (f, z) => (z ? `${f}preis heute in ${z}` : `${f}preis heute im Tessin`),
    fuelStation: (s, z) => `Tankstelle ${s} in ${z}`,
    fuelItalianCity: (c, f) => `${f}preis in ${c} (IT)`,
    fuelStatsTab: 'Treibstoffpreis-Statistiken',
    weeklyEmployers: (c) => `Arbeitgeber, die in ${c} diese Woche einstellen`,
    weeklyEmployerCompany: (co, ci) => `${co} stellt in ${ci} ein`,
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
    salaryHub: 'Grenzgänger-Löhne Tessin',
    costOfLiving: 'Lebenshaltungskosten Schweiz vs. Italien',
    costOfLivingCity: (c) => `Lebenshaltungskosten in ${c}: Mieten, Einkauf, Verkehr`,
    borderWaitCrossing: (c) => `Wartezeit ${c} jetzt`,
    borderWaitRegion: (r) => `Wartezeit ${r}`,
    borderWaitHub: 'Tessin-Wartezeiten an den Grenzen — live',
    frontierGuide: 'Grenzgänger-Leitfaden: Bewilligungen & Steuern',
    salarySim: 'Lohnrechner',
  },
  fr: {
    headings: {
      nav: 'Liens utiles',
      siblingGeneric: 'Pages similaires',
      siblingFuelZones: 'Autres zones du Tessin',
      siblingFuelStations: 'Autres stations dans la zone',
      siblingItalianCities: 'Autres villes italiennes frontalières',
      siblingCities: 'Autres villes du Tessin',
      siblingCompanyCities: 'Même employeur dans d\'autres villes',
      siblingWeeks: 'Semaines précédentes',
      siblingAges: 'Autres tranches d\'âge',
      siblingCrossings: 'Autres passages de la même région',
      siblingClusters: 'Recherches associées',
      hubs: 'Pages principales',
      cross: 'Autres outils pour le frontalier',
    },
    fuelToday: (f, z) => (z ? `Prix du ${f.toLowerCase()} aujourd'hui à ${z}` : `Prix du ${f.toLowerCase()} aujourd'hui au Tessin`),
    fuelStation: (s, z) => `Station ${s} à ${z}`,
    fuelItalianCity: (c, f) => `Prix du ${f.toLowerCase()} à ${c} (IT)`,
    fuelStatsTab: 'Statistiques prix carburants',
    weeklyEmployers: (c) => `Entreprises qui recrutent à ${c} cette semaine`,
    weeklyEmployerCompany: (co, ci) => `${co} recrute à ${ci}`,
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
    salaryHub: 'Salaires frontaliers Tessin',
    costOfLiving: 'Coût de la vie Suisse vs Italie',
    costOfLivingCity: (c) => `Coût de la vie à ${c} : loyers, courses, transports`,
    borderWaitCrossing: (c) => `File à ${c} en ce moment`,
    borderWaitRegion: (r) => `Temps d'attente ${r}`,
    borderWaitHub: 'Temps d\'attente aux douanes du Tessin — direct',
    frontierGuide: 'Guide frontalier : permis & fiscalité',
    salarySim: 'Calculateur de salaire',
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

function humanizeSlug(slug: string): string {
  return slug
    .split('-')
    .map((p) => (p.length ? p[0].toUpperCase() + p.slice(1) : p))
    .join(' ')
    .trim();
}

function zoneLabel(zone: FuelZone): string {
  return FUEL_ZONE_DISPLAY[zone];
}

function fuelLabel(locale: LinkLocale, fuel: FuelType): string {
  if (fuel === 'diesel') return locale === 'fr' ? 'Gasoil' : 'Diesel';
  if (locale === 'it') return 'Benzina';
  if (locale === 'en') return 'Gasoline';
  if (locale === 'de') return 'Benzin';
  return 'Essence';
}

/** Pick N sibling fuel zones (not the one passed). */
function pickSiblingFuelZones(current: FuelZone | undefined, count: number): FuelZone[] {
  const out: FuelZone[] = [];
  for (const z of FUEL_ZONES) {
    if (z === current) continue;
    out.push(z);
    if (out.length >= count) break;
  }
  return out;
}

/** Normalize a free-form string to a weekly-employers city key. */
function normalizeWeeklyCity(raw: string | undefined): WeeklyEmployersCity {
  if (!raw) return 'ticino';
  const lc = raw.toLowerCase();
  for (const city of WEEKLY_EMPLOYERS_CITIES) {
    if (lc === city) return city;
  }
  return 'ticino';
}

/** City → nearest crossing (for fuel ↔ border cross-links). */
function crossingForCityOrZone(cityOrZone: string | undefined): BorderCrossingSlug {
  if (!cityOrZone) return 'chiasso-brogeda';
  const lc = cityOrZone.toLowerCase();
  if (lc === 'mendrisio' || lc === 'stabio') return 'gaggiolo';
  if (lc === 'lugano' || lc === 'bellinzona' || lc === 'locarno') return 'ponte-tresa';
  return 'chiasso-brogeda';
}

/** Pick sibling crossings (same region preferred). */
function pickSiblingCrossings(
  current: BorderCrossingSlug,
  count: number,
): BorderCrossingSlug[] {
  const currentRegion = CROSSING_TO_REGION[current];
  const sameRegion: BorderCrossingSlug[] = [];
  for (const c of TOP_5_CROSSINGS) {
    if (c === current) continue;
    if (CROSSING_TO_REGION[c] === currentRegion) sameRegion.push(c);
  }
  const otherRegion: BorderCrossingSlug[] = [];
  for (const c of TOP_5_CROSSINGS) {
    if (c === current) continue;
    if (CROSSING_TO_REGION[c] !== currentRegion) otherRegion.push(c);
  }
  return [...sameRegion, ...otherRegion].slice(0, count);
}

/** Pick N sibling cities for F5 hub. */
function pickSiblingCities(
  current: WeeklyEmployersCity | undefined,
  count: number,
): WeeklyEmployersCity[] {
  const out: WeeklyEmployersCity[] = [];
  for (const c of WEEKLY_EMPLOYERS_CITIES) {
    if (c === current) continue;
    if (c === 'ticino') continue; // regional = parent hub, emitted separately
    out.push(c);
    if (out.length >= count) break;
  }
  return out;
}

/** Pick N sibling age brackets. */
function pickSiblingAges(
  current: HealthPremiumAgeBracket | undefined,
  count: number,
): HealthPremiumAgeBracket[] {
  const all: HealthPremiumAgeBracket[] = ['0-18', '19-25', '26-30', '31-45', '46-55', '56-plus'];
  const out: HealthPremiumAgeBracket[] = [];
  for (const a of all) {
    if (a === current) continue;
    out.push(a);
    if (out.length >= count) break;
  }
  return out;
}

/** Pick N sibling cantons. */
function pickSiblingCantons(
  current: HealthPremiumCanton | undefined,
  count: number,
): HealthPremiumCanton[] {
  const out: HealthPremiumCanton[] = [];
  for (const c of HEALTH_PREMIUM_CANTONS) {
    if (c === current) continue;
    out.push(c);
    if (out.length >= count) break;
  }
  return out;
}

/** Deduplicate by href, preserving order. */
function dedupe(links: RelatedLink[]): RelatedLink[] {
  const seen = new Set<string>();
  const out: RelatedLink[] = [];
  for (const l of links) {
    if (seen.has(l.href)) continue;
    seen.add(l.href);
    out.push(l);
  }
  return out;
}

function cityDisplay(city: WeeklyEmployersCity, locale: LinkLocale): string {
  if (city === 'ticino') return locale === 'de' || locale === 'fr' ? 'Tessin' : 'Ticino';
  return WEEKLY_EMPLOYERS_CITY_DISPLAY[city];
}

// ── Cluster builders per page type ───────────────────────────────

type ClusterResult = {
  sibling: RelatedLink[];
  hubs: RelatedLink[];
  cross: RelatedLink[];
  /** Which sibling-heading to use for this page type. */
  siblingHeadingKey: keyof SectionHeadings;
};

function clustersForFuelDaily(
  locale: LinkLocale,
  copy: Copy,
  ctx: RelatedLinksContext,
): ClusterResult {
  const fuel: FuelType = ctx.fuelType ?? 'diesel';
  const zone = ctx.fuelZone;
  const fuelDailyLocale = locale as FuelDailyLocale;
  const fuelL = fuelLabel(locale, fuel);

  // Sibling: 4 other fuel zones in Ticino.
  const sibling: RelatedLink[] = pickSiblingFuelZones(zone, 4).map((sib) => ({
    href: buildFuelTodayPath(fuelDailyLocale, fuel, sib),
    title: copy.fuelToday(fuelL, zoneLabel(sib)),
  }));

  // Hubs: regional fuel + alternate fuel type.
  const altFuel: FuelType = fuel === 'diesel' ? 'benzina' : 'diesel';
  const hubs: RelatedLink[] = [
    {
      href: buildFuelTodayPath(fuelDailyLocale, fuel, undefined),
      title: copy.fuelToday(fuelL),
    },
    {
      href: buildFuelTodayPath(fuelDailyLocale, altFuel, zone),
      title: copy.fuelToday(fuelLabel(locale, altFuel), zone ? zoneLabel(zone) : undefined),
    },
  ];

  // Cross-category: border wait (nearest) + weekly employers (same city) +
  // job-market snapshot.
  const nearestCrossing = crossingForCityOrZone(zone ?? ctx.city);
  const weeklyCity = normalizeWeeklyCity(ctx.city ?? zone);
  const cross: RelatedLink[] = [
    {
      href: buildBorderOggiPath(locale as BorderWaitLocale, nearestCrossing),
      title: copy.borderWaitCrossing(BORDER_CROSSING_DISPLAY[nearestCrossing]),
    },
    {
      href: buildCurrentWeekPath(locale as WeeklyEmployersLocale, weeklyCity),
      title: copy.weeklyEmployers(cityDisplay(weeklyCity, locale)),
    },
    {
      href: buildJobMarketHubPath(locale as JobMarketSnapshotLocale),
      title: copy.jobMarketSnapshot,
    },
  ];

  return { sibling, hubs, cross, siblingHeadingKey: 'siblingFuelZones' };
}

function clustersForFuelStation(
  locale: LinkLocale,
  copy: Copy,
  ctx: RelatedLinksContext,
): ClusterResult {
  const fuel: FuelType = ctx.fuelType ?? 'diesel';
  const zone = ctx.fuelZone ?? 'chiasso';
  const fuelDailyLocale = locale as FuelDailyLocale;
  const stationSlug = ctx.stationSlug ?? 'stazione';

  // Prefer real sibling station slugs provided by the page generator. When the
  // richer context is unavailable, fall back to placeholder siblings so callers
  // outside the fuel build pipeline still get a populated section.
  const sibling: RelatedLink[] = (ctx.siblingStations?.length
    ? ctx.siblingStations
        .filter((station) => station.slug !== stationSlug)
        .slice(0, 5)
        .map((station) => ({
          href: buildFuelStationPath(fuelDailyLocale, fuel, zone, station.slug),
          title: copy.fuelStation(station.brand, zoneLabel(zone)),
        }))
    : ['eni', 'agip', 'tamoil', 'shell', 'migrol']
        .filter((brand) => `${zone}-${brand}` !== stationSlug)
        .slice(0, 5)
        .map((brand) => ({
          href: buildFuelStationPath(fuelDailyLocale, fuel, zone, `${zone}-${brand}`),
          title: copy.fuelStation(humanizeSlug(brand), zoneLabel(zone)),
        })));

  // Hubs: zone hub + regional hub.
  const hubs: RelatedLink[] = [
    {
      href: buildFuelTodayPath(fuelDailyLocale, fuel, zone),
      title: copy.fuelToday(fuelLabel(locale, fuel), zoneLabel(zone)),
    },
    {
      href: buildFuelTodayPath(fuelDailyLocale, fuel, undefined),
      title: copy.fuelToday(fuelLabel(locale, fuel)),
    },
  ];

  // Cross-category.
  const nearestCrossing = crossingForCityOrZone(zone);
  const weeklyCity = normalizeWeeklyCity(zone);
  const cross: RelatedLink[] = [
    {
      href: buildBorderOggiPath(locale as BorderWaitLocale, nearestCrossing),
      title: copy.borderWaitCrossing(BORDER_CROSSING_DISPLAY[nearestCrossing]),
    },
    {
      href: buildCurrentWeekPath(locale as WeeklyEmployersLocale, weeklyCity),
      title: copy.weeklyEmployers(cityDisplay(weeklyCity, locale)),
    },
    { href: SALARY_SIM_ROOT[locale], title: copy.salarySim },
  ];

  return { sibling, hubs, cross, siblingHeadingKey: 'siblingFuelStations' };
}

function clustersForFuelItalianCity(
  locale: LinkLocale,
  copy: Copy,
  ctx: RelatedLinksContext,
): ClusterResult {
  const fuel: FuelType = ctx.fuelType ?? 'diesel';
  const italianCity = ctx.italianCity ?? ctx.italianCitySlug ?? 'como';
  const fuelDailyLocale = locale as FuelDailyLocale;
  const fuelL = fuelLabel(locale, fuel);

  // Sibling: 4 other Italian cities near the border.
  const otherItCities = FUEL_ITALIAN_CITIES
    .map((city) => city.slug)
    .filter((slug) => RELATED_FUEL_ITALIAN_CITY_SLUGS.has(slug))
    .filter((slug) => slug !== italianCity)
    .slice(0, 4);
  const sibling: RelatedLink[] = otherItCities.map((c) => ({
    href: buildItalianCityPath(fuelDailyLocale, fuel, c),
    title: copy.fuelItalianCity(humanizeSlug(c), fuelL),
  }));

  // Hubs: regional fuel (Ticino) + nearest CH zone.
  const nearestZone: FuelZone = italianCity === 'como' ? 'chiasso' : italianCity === 'varese' ? 'mendrisio' : 'lugano';
  const hubs: RelatedLink[] = [
    {
      href: buildFuelTodayPath(fuelDailyLocale, fuel, undefined),
      title: copy.fuelToday(fuelL),
    },
    {
      href: buildFuelTodayPath(fuelDailyLocale, fuel, nearestZone),
      title: copy.fuelToday(fuelL, zoneLabel(nearestZone)),
    },
  ];

  // Cross-category.
  const nearestCrossing = crossingForCityOrZone(nearestZone);
  const cross: RelatedLink[] = [
    {
      href: buildBorderOggiPath(locale as BorderWaitLocale, nearestCrossing),
      title: copy.borderWaitCrossing(BORDER_CROSSING_DISPLAY[nearestCrossing]),
    },
    { href: FRONTIER_GUIDE_PATH[locale], title: copy.frontierGuide },
    { href: SALARY_HUB_PATH[locale], title: copy.salaryHub },
  ];

  return { sibling, hubs, cross, siblingHeadingKey: 'siblingItalianCities' };
}

function clustersForWeeklyEmployers(
  locale: LinkLocale,
  copy: Copy,
  ctx: RelatedLinksContext,
): ClusterResult {
  const weeklyCity = normalizeWeeklyCity(ctx.weeklyCity ?? ctx.city);
  const weeklyLocale = locale as WeeklyEmployersLocale;

  // Sibling: 4 other cities.
  const sibling: RelatedLink[] = pickSiblingCities(weeklyCity, 4).map((c) => ({
    href: buildCurrentWeekPath(weeklyLocale, c),
    title: copy.weeklyEmployers(cityDisplay(c, locale)),
  }));

  // Hubs: regional Ticino + editorial city hub if match.
  const hubs: RelatedLink[] = [
    {
      href: buildCurrentWeekPath(weeklyLocale, 'ticino'),
      title: copy.weeklyEmployers(cityDisplay('ticino', locale)),
    },
  ];
  if (weeklyCity === 'lugano') hubs.push({ href: cityHubPath(locale, 'lugano'), title: copy.cityJobsLugano });
  else if (weeklyCity === 'mendrisio') hubs.push({ href: cityHubPath(locale, 'mendrisio'), title: copy.cityJobsMendrisio });
  else if (weeklyCity === 'bellinzona') hubs.push({ href: cityHubPath(locale, 'bellinzona'), title: copy.cityJobsBellinzona });
  else hubs.push({ href: cityHubPath(locale, 'lugano'), title: copy.cityJobsLugano });

  // Cross-category: F4 snapshot + F6 fuel (same city) + F8 border + last-3-days.
  const nearestCrossing = crossingForCityOrZone(weeklyCity);
  const fuelZoneForCity: FuelZone | undefined =
    weeklyCity === 'lugano' || weeklyCity === 'mendrisio' || weeklyCity === 'chiasso'
      || weeklyCity === 'bellinzona' || weeklyCity === 'locarno'
      ? weeklyCity as FuelZone
      : undefined;
  const cross: RelatedLink[] = [
    {
      href: buildJobMarketHubPath(locale as JobMarketSnapshotLocale),
      title: copy.jobMarketSnapshot,
    },
    {
      href: buildFuelTodayPath(locale as FuelDailyLocale, 'diesel', fuelZoneForCity),
      title: copy.fuelToday(fuelLabel(locale, 'diesel'), fuelZoneForCity ? zoneLabel(fuelZoneForCity) : undefined),
    },
    {
      href: buildBorderOggiPath(locale as BorderWaitLocale, nearestCrossing),
      title: copy.borderWaitCrossing(BORDER_CROSSING_DISPLAY[nearestCrossing]),
    },
    { href: LAST_3_DAYS_PATH[locale], title: copy.last3Days },
  ];

  return { sibling, hubs, cross, siblingHeadingKey: 'siblingCities' };
}

function clustersForWeeklyEmployerCompanyCity(
  locale: LinkLocale,
  copy: Copy,
  ctx: RelatedLinksContext,
): ClusterResult {
  const weeklyCity = normalizeWeeklyCity(ctx.weeklyCity ?? ctx.city);
  const weeklyLocale = locale as WeeklyEmployersLocale;
  const companySlug = ctx.companySlug ?? 'company';
  const companyLabel = humanizeSlug(companySlug);

  // Sibling: same company in 3-4 other cities.
  // When the generator passes `companySiblingCities`, trust that list — it
  // reflects the cities where the company actually has a generated page for
  // this locale. Otherwise fall back to the heuristic city picker.
  const siblingCities: ReadonlyArray<WeeklyEmployersCity> = ctx.companySiblingCities
    ? ctx.companySiblingCities.filter((c) => c !== weeklyCity).slice(0, 4)
    : pickSiblingCities(weeklyCity, 4);
  const sibling: RelatedLink[] = siblingCities.map((c) => ({
    href: buildWeeklyCompanyCityPath(weeklyLocale, c, companySlug),
    title: copy.weeklyEmployerCompany(companyLabel, cityDisplay(c, locale)),
  }));

  // Hubs: same-city F5 hub + regional Ticino F5 hub.
  const hubs: RelatedLink[] = [
    {
      href: buildCurrentWeekPath(weeklyLocale, weeklyCity),
      title: copy.weeklyEmployers(cityDisplay(weeklyCity, locale)),
    },
    {
      href: buildCurrentWeekPath(weeklyLocale, 'ticino'),
      title: copy.weeklyEmployers(cityDisplay('ticino', locale)),
    },
  ];

  // Cross-category.
  const nearestCrossing = crossingForCityOrZone(weeklyCity);
  const cross: RelatedLink[] = [
    {
      href: buildJobMarketHubPath(locale as JobMarketSnapshotLocale),
      title: copy.jobMarketSnapshot,
    },
    {
      href: buildBorderOggiPath(locale as BorderWaitLocale, nearestCrossing),
      title: copy.borderWaitCrossing(BORDER_CROSSING_DISPLAY[nearestCrossing]),
    },
    { href: LAST_3_DAYS_PATH[locale], title: copy.last3Days },
  ];

  return { sibling, hubs, cross, siblingHeadingKey: 'siblingCompanyCities' };
}

function clustersForJobMarketSnapshot(
  locale: LinkLocale,
  copy: Copy,
  _ctx: RelatedLinksContext,
): ClusterResult {
  const weeklyLocale = locale as WeeklyEmployersLocale;

  // Sibling: 4 city F5 hubs.
  const sibling: RelatedLink[] = (['lugano', 'mendrisio', 'chiasso', 'bellinzona'] as const).map((c) => ({
    href: buildCurrentWeekPath(weeklyLocale, c),
    title: copy.weeklyEmployers(cityDisplay(c, locale)),
  }));

  // Hubs: regional F5 + main listing root.
  const hubs: RelatedLink[] = [
    {
      href: buildCurrentWeekPath(weeklyLocale, 'ticino'),
      title: copy.weeklyEmployers(cityDisplay('ticino', locale)),
    },
    { href: JOB_LISTING_ROOT[locale], title: copy.allJobs },
  ];

  // Cross-category: city hubs + recency hub + salary benchmarks.
  const cross: RelatedLink[] = [
    { href: cityHubPath(locale, 'lugano'), title: copy.cityJobsLugano },
    { href: cityHubPath(locale, 'mendrisio'), title: copy.cityJobsMendrisio },
    { href: LAST_3_DAYS_PATH[locale], title: copy.last3Days },
    { href: SALARY_HUB_PATH[locale], title: copy.salaryBenchmarks },
  ];

  return { sibling, hubs, cross, siblingHeadingKey: 'siblingCities' };
}

function clustersForHealthPremiums(
  locale: LinkLocale,
  copy: Copy,
  ctx: RelatedLinksContext,
): ClusterResult {
  const hpLocale = locale as HealthPremiumLocale;
  const currentCanton: HealthPremiumCanton = ctx.cantonSlug ?? 'ticino';
  const currentAge: HealthPremiumAgeBracket | undefined = ctx.age;

  // Sibling: either 4 other ages (if we're on a leaf) or 4 other cantons.
  const sibling: RelatedLink[] = currentAge
    ? pickSiblingAges(currentAge, 4).map((a) => ({
      href: buildHealthPremiumsLeafPath(hpLocale, currentCanton, a),
      title: copy.healthPremiumAgeBracket(HEALTH_PREMIUM_AGE_LABEL[hpLocale][a]),
    }))
    : pickSiblingCantons(currentCanton, 4).map((c) => ({
      href: buildHealthPremiumsCantonPath(hpLocale, c),
      title: copy.healthPremiumCanton(HEALTH_PREMIUM_CANTON_DISPLAY[hpLocale][c]),
    }));

  // Hubs: canton hub + root hub (or root + alt canton if we're already on canton).
  const hubs: RelatedLink[] = [];
  if (currentAge) {
    hubs.push({
      href: buildHealthPremiumsCantonPath(hpLocale, currentCanton),
      title: copy.healthPremiumCanton(HEALTH_PREMIUM_CANTON_DISPLAY[hpLocale][currentCanton]),
    });
  }
  hubs.push({ href: buildHealthPremiumsRootPath(hpLocale), title: copy.healthPremiums });

  // Cross-category: comparator + salary sim + cost of living (guide) +
  // frontier guide.
  // All cross-links are internal — no rel="nofollow" so we don't leak
  // internal link equity (Semrush audit: "nofollow on internal links").
  const cross: RelatedLink[] = [
    {
      href: HEALTH_PREMIUM_COMPARATOR_PATH[hpLocale],
      title: copy.healthComparator,
    },
    { href: SALARY_SIM_ROOT[locale], title: copy.salarySim },
    { href: SALARY_HUB_PATH[locale], title: copy.salaryBenchmarks },
    { href: FRONTIER_GUIDE_PATH[locale], title: copy.frontierGuide },
  ];

  return {
    sibling,
    hubs,
    cross,
    siblingHeadingKey: currentAge ? 'siblingAges' : 'siblingGeneric',
  };
}

function clustersForBorderWait(
  locale: LinkLocale,
  copy: Copy,
  ctx: RelatedLinksContext,
): ClusterResult {
  const borderLocale = locale as BorderWaitLocale;
  const currentCrossing: BorderCrossingSlug = ctx.borderCrossing ?? 'chiasso-brogeda';
  const region = CROSSING_TO_REGION[currentCrossing];

  // Sibling: 4 other crossings (same region first, then other).
  const sibling: RelatedLink[] = pickSiblingCrossings(currentCrossing, 4).map((c) => ({
    href: buildBorderOggiPath(borderLocale, c),
    title: copy.borderWaitCrossing(BORDER_CROSSING_DISPLAY[c]),
  }));

  // Hubs: regional + root hub.
  const hubs: RelatedLink[] = [
    {
      href: buildBorderRegionalHubPath(borderLocale, region),
      title: copy.borderWaitRegion(BORDER_REGION_DISPLAY[region]),
    },
    { href: buildBorderRootHubPath(borderLocale), title: copy.borderWaitHub },
  ];

  // Cross-category: fuel (nearest zone) + weekly employers (nearest city) +
  // cost-of-living (AE-4 nearest city) + job-market hub + frontier guide.
  const fuelZone = CROSSING_TO_FUEL_ZONE[currentCrossing];
  const weeklyCity = CROSSING_TO_WEEKLY_CITY[currentCrossing] as WeeklyEmployersCity;
  const colCity = mapWeeklyCityToColCity(weeklyCity);
  const cross: RelatedLink[] = [
    {
      href: buildFuelTodayPath(locale as FuelDailyLocale, 'diesel', fuelZone),
      title: copy.fuelToday(fuelLabel(locale, 'diesel'), zoneLabel(fuelZone)),
    },
    {
      href: buildCurrentWeekPath(locale as WeeklyEmployersLocale, weeklyCity),
      title: copy.weeklyEmployers(cityDisplay(weeklyCity, locale)),
    },
    {
      href: buildCostOfLivingLandingPath(locale as ColLocale, colCity),
      title: copy.costOfLivingCity(COL_CITY_DISPLAY[colCity][locale as ColLocale]),
    },
    {
      href: buildJobMarketHubPath(locale as JobMarketSnapshotLocale),
      title: copy.jobMarketSnapshot,
    },
    { href: FRONTIER_GUIDE_PATH[locale], title: copy.frontierGuide },
  ];

  return { sibling, hubs, cross, siblingHeadingKey: 'siblingCrossings' };
}

/**
 * Map a weekly-employers city slug to the nearest AE-4 cost-of-living
 * landing city. Most weekly-employers cities are direct hits; those that
 * are not (e.g. `stabio`, `agno`) resolve to the closest commuter city.
 */
function mapWeeklyCityToColCity(weeklyCity: WeeklyEmployersCity): ColCityId {
  const normalized = String(weeklyCity).toLowerCase();
  for (const id of COL_CITY_IDS) {
    if (normalized === id) return id;
  }
  // Fallback: Lugano (largest Ticino city, safest default for unmapped slugs).
  return 'lugano';
}

function clustersForOrphanLanding(
  locale: LinkLocale,
  copy: Copy,
  ctx: RelatedLinksContext,
): ClusterResult {
  const weeklyCity = normalizeWeeklyCity(ctx.city);
  const weeklyLocale = locale as WeeklyEmployersLocale;

  // Sibling: 4 "related search" clusters. When we have the orphan slug
  // we synthesise a few sibling slug variants; otherwise fall back to
  // high-value listing variants.
  const sibling: RelatedLink[] = [
    { href: SINCE_YESTERDAY_PATH[locale], title: copy.sinceYesterday },
    { href: LAST_3_DAYS_PATH[locale], title: copy.last3Days },
    { href: cityHubPath(locale, 'lugano'), title: copy.cityJobsLugano },
    { href: cityHubPath(locale, 'mendrisio'), title: copy.cityJobsMendrisio },
  ];

  // Hubs: main listing + city hub (contextual).
  const hubs: RelatedLink[] = [{ href: JOB_LISTING_ROOT[locale], title: copy.allJobs }];
  if (weeklyCity === 'mendrisio') {
    hubs.push({ href: cityHubPath(locale, 'mendrisio'), title: copy.cityJobsMendrisio });
  } else if (weeklyCity === 'bellinzona') {
    hubs.push({ href: cityHubPath(locale, 'bellinzona'), title: copy.cityJobsBellinzona });
  } else {
    hubs.push({ href: cityHubPath(locale, 'lugano'), title: copy.cityJobsLugano });
  }

  // Cross-category.
  const cross: RelatedLink[] = [
    {
      href: buildJobMarketHubPath(locale as JobMarketSnapshotLocale),
      title: copy.jobMarketSnapshot,
    },
    {
      href: buildCurrentWeekPath(weeklyLocale, weeklyCity),
      title: copy.weeklyEmployers(cityDisplay(weeklyCity, locale)),
    },
    { href: SALARY_HUB_PATH[locale], title: copy.salaryBenchmarks },
  ];

  return { sibling, hubs, cross, siblingHeadingKey: 'siblingClusters' };
}

function clustersFor(
  locale: LinkLocale,
  pageType: SeoPageType,
  ctx: RelatedLinksContext,
  copy: Copy,
): ClusterResult {
  switch (pageType) {
    case 'fuel_daily':
      return clustersForFuelDaily(locale, copy, ctx);
    case 'fuel_station':
      return clustersForFuelStation(locale, copy, ctx);
    case 'fuel_italian_city':
      return clustersForFuelItalianCity(locale, copy, ctx);
    case 'weekly_employers':
      return clustersForWeeklyEmployers(locale, copy, ctx);
    case 'weekly_employer_company_city':
      return clustersForWeeklyEmployerCompanyCity(locale, copy, ctx);
    case 'job_market_snapshot':
      return clustersForJobMarketSnapshot(locale, copy, ctx);
    case 'health_premiums':
      return clustersForHealthPremiums(locale, copy, ctx);
    case 'orphan_landing':
      return clustersForOrphanLanding(locale, copy, ctx);
    case 'border_wait':
      return clustersForBorderWait(locale, copy, ctx);
    default: {
      const exhaustive: never = pageType;
      throw new Error(`unknown SeoPageType: ${String(exhaustive)}`);
    }
  }
}

// ── Caps / normalisation ────────────────────────────────────────

const MAX_LINKS_PER_PAGE = 12;
const MIN_LINKS_PER_PAGE = 6;
const MAX_SIBLING = 6;
const MAX_HUBS = 3;
const MAX_CROSS = 4;

/**
 * Apply per-cluster caps + global cap + dedup. Preserves the sibling → hubs →
 * cross ordering so the flattened list matches what's rendered.
 */
function capClusters(clusters: ClusterResult): ClusterResult {
  const sibling = dedupe(clusters.sibling).slice(0, MAX_SIBLING);
  const hubsAfterSibling = dedupe([...sibling, ...clusters.hubs]).slice(sibling.length);
  const hubs = hubsAfterSibling.slice(0, MAX_HUBS);
  const crossAfter = dedupe([...sibling, ...hubs, ...clusters.cross]).slice(sibling.length + hubs.length);
  const cross = crossAfter.slice(0, MAX_CROSS);

  // Global cap of 12 — trim crosscategory first, then hubs.
  let total = sibling.length + hubs.length + cross.length;
  let cappedCross = cross;
  let cappedHubs = hubs;
  if (total > MAX_LINKS_PER_PAGE) {
    const over = total - MAX_LINKS_PER_PAGE;
    if (cappedCross.length >= over) {
      cappedCross = cappedCross.slice(0, cappedCross.length - over);
    } else {
      const crossRemoved = cappedCross.length;
      cappedCross = [];
      cappedHubs = cappedHubs.slice(0, cappedHubs.length - (over - crossRemoved));
    }
  }

  return {
    sibling,
    hubs: cappedHubs,
    cross: cappedCross,
    siblingHeadingKey: clusters.siblingHeadingKey,
  };
}

// ── Public API ──────────────────────────────────────────────────

/**
 * Build the structured 3-cluster output. Primary API for tests and advanced
 * consumers that want per-section metadata (heading, aria-label, link count).
 *
 * Falls back to the legacy 5-link flat list when the 3-cluster build produces
 * fewer than {@link MIN_LINKS_PER_PAGE} links — guarantees every page has at
 * least some link equity below the fold.
 */
export function generateRelatedLinksStructured(
  locale: LinkLocale,
  pageType: SeoPageType,
  context: RelatedLinksContext = {},
): RelatedLinksOutput {
  const copy = COPY[locale];
  const raw = clustersFor(locale, pageType, context, copy);
  const capped = capClusters(raw);
  const total = capped.sibling.length + capped.hubs.length + capped.cross.length;

  // Fallback: if the 3-cluster output is thin, fall back to the legacy
  // 5-link flat render. This only trips when context is missing to the
  // point where sibling builders produce no data.
  if (total < MIN_LINKS_PER_PAGE) {
    const legacy = legacyFlatLinks(locale, pageType, context);
    const flat = dedupe(legacy).slice(0, MAX_LINKS_PER_PAGE);
    const sections: RelatedLinkSection[] = [
      {
        kind: 'sibling',
        titleKey: `related.section.sibling.${pageType}`,
        heading: copy.headings.siblingGeneric,
        ariaLabel: copy.headings.siblingGeneric,
        links: flat,
      },
    ];
    return { sections, flat, html: renderHtml(copy, sections) };
  }

  const allSections: RelatedLinkSection[] = [
    {
      kind: 'sibling',
      titleKey: `related.section.sibling.${pageType}`,
      heading: copy.headings[capped.siblingHeadingKey],
      ariaLabel: copy.headings[capped.siblingHeadingKey],
      links: capped.sibling,
    },
    {
      kind: 'hubs',
      titleKey: 'related.section.hubs',
      heading: copy.headings.hubs,
      ariaLabel: copy.headings.hubs,
      links: capped.hubs,
    },
    {
      kind: 'cross',
      titleKey: 'related.section.cross',
      heading: copy.headings.cross,
      ariaLabel: copy.headings.cross,
      links: capped.cross,
    },
  ];
  const sections: RelatedLinkSection[] = allSections.filter((s) => s.links.length > 0);

  const flat: RelatedLink[] = sections.flatMap((s) => s.links as RelatedLink[]);
  return { sections, flat, html: renderHtml(copy, sections) };
}

/**
 * Flat list of related links (backwards-compatible API). Returns the union
 * of all sections from the 3-cluster builder, capped at 12.
 */
export function generateRelatedLinks(
  locale: LinkLocale,
  pageType: SeoPageType,
  context: RelatedLinksContext = {},
): RelatedLink[] {
  return [...generateRelatedLinksStructured(locale, pageType, context).flat];
}

/**
 * Render the related-links block as a full `<nav>` HTML string. Backwards
 * compatible with the pre-D-2C helper — all existing plugin call sites
 * (~6 plugins) continue to work without changes and now emit the richer
 * 3-cluster markup automatically.
 */
export function generateRelatedLinksBlock(
  locale: LinkLocale,
  pageType: SeoPageType,
  context: RelatedLinksContext = {},
): string {
  return generateRelatedLinksStructured(locale, pageType, context).html;
}

// ── HTML rendering ──────────────────────────────────────────────

/**
 * Render the 3-cluster sections as semantic HTML. Uses the same Tailwind
 * utility classes + semantic tokens (`border-edge`, `bg-surface-alt`,
 * `text-accent`, `text-subtle`) as the rest of the site so the block
 * visually matches the SPA chrome and auto-adapts to dark mode without
 * any `dark:` prefix.
 */
function renderHtml(copy: Copy, sections: readonly RelatedLinkSection[]): string {
  if (sections.length === 0) return '';

  const sectionHtml = sections
    .map((sec) => {
      const items = sec.links
        .map(
          (l) =>
            `<li class="m-0 p-0"><a href="${escHtml(l.href)}"${l.rel ? ` rel="${escHtml(l.rel)}"` : ''} class="inline-block py-1.5 text-sm font-medium leading-snug text-accent no-underline hover:underline">${escHtml(l.title)}</a></li>`,
        )
        .join('');
      return `<section aria-label="${escHtml(sec.ariaLabel)}" data-cluster="${escHtml(sec.kind)}" class="min-w-0">
  <h3 class="mb-2.5 text-xs font-bold uppercase tracking-wider text-subtle">${escHtml(sec.heading)}</h3>
  <ul class="m-0 flex list-none flex-col gap-1 p-0">${items}</ul>
</section>`;
    })
    .join('\n  ');

  return `<nav id="seoRelatedLinks" aria-label="${escHtml(copy.headings.nav)}" class="mt-10 grid gap-6 rounded-3xl border border-edge bg-surface-alt p-6 sm:grid-cols-2 lg:grid-cols-3">
  ${sectionHtml}
</nav>`;
}

// ── Legacy 5-link fallback (kept for safety net) ─────────────────

/**
 * The pre-D-2C builder produced 5 flat links per page. We keep it as a
 * "thin-result" fallback to guarantee every page ships with at least
 * {@link MIN_LINKS_PER_PAGE} related links even when context is sparse.
 */
function legacyFlatLinks(
  locale: LinkLocale,
  pageType: SeoPageType,
  context: RelatedLinksContext,
): RelatedLink[] {
  const copy = COPY[locale];
  const weeklyLocale = locale as WeeklyEmployersLocale;
  const fuelDailyLocale = locale as FuelDailyLocale;
  const jobMarketLocale = locale as JobMarketSnapshotLocale;
  const borderLocale = locale as BorderWaitLocale;
  const weeklyCity = normalizeWeeklyCity(context.city);
  switch (pageType) {
    case 'fuel_daily':
    case 'fuel_station':
    case 'fuel_italian_city':
      return [
        { href: buildFuelTodayPath(fuelDailyLocale, context.fuelType ?? 'diesel', undefined), title: copy.fuelToday(fuelLabel(locale, context.fuelType ?? 'diesel')) },
        { href: buildCurrentWeekPath(weeklyLocale, weeklyCity), title: copy.weeklyEmployers(cityDisplay(weeklyCity, locale)) },
        { href: buildJobMarketHubPath(jobMarketLocale), title: copy.jobMarketSnapshot },
        { href: buildBorderOggiPath(borderLocale, 'chiasso-brogeda'), title: copy.borderWaitCrossing(BORDER_CROSSING_DISPLAY['chiasso-brogeda']) },
        { href: JOB_LISTING_ROOT[locale], title: copy.allJobs },
      ];
    case 'weekly_employers':
    case 'weekly_employer_company_city':
      return [
        { href: buildJobMarketHubPath(jobMarketLocale), title: copy.jobMarketSnapshot },
        { href: cityHubPath(locale, 'lugano'), title: copy.cityJobsLugano },
        { href: LAST_3_DAYS_PATH[locale], title: copy.last3Days },
        { href: buildFuelTodayPath(fuelDailyLocale, 'diesel', undefined), title: copy.fuelToday(fuelLabel(locale, 'diesel')) },
        { href: buildBorderOggiPath(borderLocale, 'chiasso-brogeda'), title: copy.borderWaitCrossing(BORDER_CROSSING_DISPLAY['chiasso-brogeda']) },
      ];
    case 'job_market_snapshot':
      return [
        { href: buildCurrentWeekPath(weeklyLocale, 'ticino'), title: copy.weeklyEmployers(cityDisplay('ticino', locale)) },
        { href: cityHubPath(locale, 'lugano'), title: copy.cityJobsLugano },
        { href: cityHubPath(locale, 'mendrisio'), title: copy.cityJobsMendrisio },
        { href: LAST_3_DAYS_PATH[locale], title: copy.last3Days },
        { href: SALARY_SIM_ROOT[locale], title: copy.salaryBenchmarks },
      ];
    case 'health_premiums': {
      const canton = context.cantonSlug ?? 'ticino';
      const hpLocale = locale as HealthPremiumLocale;
      return [
        { href: HEALTH_PREMIUM_COMPARATOR_PATH[hpLocale], title: copy.healthComparator },
        { href: buildHealthPremiumsCantonPath(hpLocale, canton === 'ticino' ? 'grigioni' : 'ticino'), title: copy.healthPremiumCanton(HEALTH_PREMIUM_CANTON_DISPLAY[hpLocale][canton === 'ticino' ? 'grigioni' : 'ticino']) },
        { href: buildHealthPremiumsLeafPath(hpLocale, canton, '19-25'), title: copy.healthPremiumAgeBracket(HEALTH_PREMIUM_AGE_LABEL[hpLocale]['19-25']) },
        { href: buildHealthPremiumsLeafPath(hpLocale, canton, '31-45'), title: copy.healthPremiumAgeBracket(HEALTH_PREMIUM_AGE_LABEL[hpLocale]['31-45']) },
        { href: SALARY_SIM_ROOT[locale], title: copy.salaryBenchmarks },
      ];
    }
    case 'orphan_landing':
      return [
        { href: JOB_LISTING_ROOT[locale], title: copy.allJobs },
        { href: cityHubPath(locale, 'lugano'), title: copy.cityJobsLugano },
        { href: buildJobMarketHubPath(jobMarketLocale), title: copy.jobMarketSnapshot },
        { href: buildCurrentWeekPath(weeklyLocale, weeklyCity), title: copy.weeklyEmployers(cityDisplay(weeklyCity, locale)) },
        { href: SINCE_YESTERDAY_PATH[locale], title: copy.sinceYesterday },
      ];
    case 'border_wait': {
      const crossing = context.borderCrossing ?? 'chiasso-brogeda';
      const fuelZone = CROSSING_TO_FUEL_ZONE[crossing];
      const nearCity = CROSSING_TO_WEEKLY_CITY[crossing] as WeeklyEmployersCity;
      return [
        { href: buildFuelTodayPath(fuelDailyLocale, 'diesel', fuelZone), title: copy.fuelToday(fuelLabel(locale, 'diesel'), zoneLabel(fuelZone)) },
        { href: buildCurrentWeekPath(weeklyLocale, nearCity), title: copy.weeklyEmployers(cityDisplay(nearCity, locale)) },
        { href: buildBorderOggiPath(borderLocale, pickSiblingCrossings(crossing, 1)[0]), title: copy.borderWaitCrossing(BORDER_CROSSING_DISPLAY[pickSiblingCrossings(crossing, 1)[0]]) },
        { href: buildBorderOggiPath(borderLocale, pickSiblingCrossings(crossing, 2)[1]), title: copy.borderWaitCrossing(BORDER_CROSSING_DISPLAY[pickSiblingCrossings(crossing, 2)[1]]) },
        { href: FRONTIER_GUIDE_PATH[locale], title: copy.frontierGuide },
      ];
    }
  }
}
