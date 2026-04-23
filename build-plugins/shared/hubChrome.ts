/**
 * Shared server-side hub chrome renderer for programmatic SEO landing pages.
 *
 * Why this exists (BUG-2 fix)
 * ---------------------------
 * The 6 programmatic-landing plugins (fuelDaily, weeklyEmployers,
 * jobMarketSnapshot, healthPremiumsLanding, borderWaitPages, orphanQueryLanding)
 * emit pages with `seoContentOutsideRoot: true`. The React SPA hydrates into
 * `#root` but — because parsePath sets `staticOverlay: true` for these URLs —
 * App.tsx suppresses its `<SubTabNav>` in lite-shell mode. The net effect is
 * that production pages render WITHOUT the canonical hub sub-navigation bar
 * users expect on `/confronti/*`, `/statistiche/*`, `/guida/*` hubs.
 *
 * Fix: plugins opt-in to rendering the hub sub-nav chrome in the static HTML
 * they emit (outside `#root`, so the SPA never touches it). The chrome is a
 * 1:1 server-side equivalent of what `<SubTabNav>` renders in the SPA — same
 * tokens, same aria attributes, same sub-tab set, same "active" styling — so
 * the first paint matches what the SPA would hydrate to if it were allowed.
 *
 * Notes
 * -----
 * - Labels are baked in per locale (it/en/de/fr). We don't hit the i18n
 *   runtime because this module runs at build time in a pure-Node context.
 * - Anchor hrefs are constructed from a hub/sub-tab slug table (a subset of
 *   `SLUG_TABLES` from services/router.ts, kept in-sync by hand). Using
 *   build-time `<a href="...">` is intentional — the SPA will perform a full
 *   navigation when users click them, which is fine because the target is
 *   another hub (may itself be a programmatic landing).
 * - Inline SVG icons mirror lucide-react shapes (no runtime React import).
 */

import { esc } from '../htmlTemplate';

// ── Types ──────────────────────────────────────────────────────

export type HubLocale = 'it' | 'en' | 'de' | 'fr';

/** Identifier for a hub — matches the 6 top-level SPA tabs. */
export type HubKey = 'calculator' | 'confronti' | 'fisco' | 'guida' | 'vita' | 'stats' | 'job-board';

/** Hero variants mirror the big coloured hero strips on SPA hubs. */
export type HubHeroVariant = 'green' | 'blue' | 'purple';

export interface HubHero {
  readonly title: string;
  readonly subtitle?: string;
  readonly variant?: HubHeroVariant;
}

export interface RenderHubChromeOpts {
  readonly hubKey: HubKey;
  readonly activeSubTab: string;
  readonly locale: HubLocale;
  readonly hero?: HubHero;
  /** Pre-rendered inner body HTML to wrap (e.g. the page's existing `<main>`). */
  readonly innerHtml: string;
}

// ── Slug tables (mirror of services/router.ts SLUG_TABLES subset) ──

interface HubSlugs {
  readonly calcolatore: string;
  readonly confronti: string;
  readonly fisco: string;
  readonly guida: string;
  readonly vita: string;
  readonly stats: string;
  readonly jobBoard: string;
  // confronti sub-tab slugs
  readonly exchange: string;
  readonly banks: string;
  readonly health: string;
  readonly mobile: string;
  readonly shopping: string;
  readonly costOfLiving: string;
  readonly jobs: string;
  readonly renovation: string;
  // guida sub-tab slugs
  readonly firstDay: string;
  readonly permits: string;
  readonly border: string;
  readonly unemployment: string;
  readonly carTransfer: string;
  readonly carCost: string;
  readonly permitCompare: string;
  readonly borderMap: string;
  // stats sub-tab slugs
  readonly livability: string;
  readonly jobsObservatory: string;
  readonly salaryCompare: string;
  readonly trafficHistory: string;
  readonly unemploymentStats: string;
  readonly mortgageComparison: string;
  readonly fuelPrices: string;
  readonly healthPremiums: string;
}

const HUB_SLUGS: Record<HubLocale, HubSlugs> = {
  it: {
    calcolatore: 'calcola-stipendio',
    confronti: 'compara-servizi',
    fisco: 'tasse-e-pensione',
    guida: 'guida-frontaliere',
    vita: 'vivere-in-ticino',
    stats: 'statistiche',
    jobBoard: 'cerca-lavoro-ticino',
    exchange: 'cambio-franco-euro',
    banks: 'confronta-banche',
    health: 'confronta-casse-malati',
    mobile: 'confronta-operatori-mobili',
    shopping: 'confronta-prezzi-spesa',
    costOfLiving: 'costo-della-vita',
    jobs: 'confronta-offerte-lavoro',
    renovation: 'calcola-bonus-ristrutturazione',
    firstDay: 'primo-giorno-lavoro',
    permits: 'permessi-di-lavoro',
    border: 'tempi-attesa-dogana',
    unemployment: 'disoccupazione-transfrontaliera',
    carTransfer: 'trasferire-auto-svizzera',
    carCost: 'costo-auto-pendolare',
    permitCompare: 'confronta-permesso-g-vs-b',
    borderMap: 'mappa-confine',
    livability: 'migliori-comuni-frontiera',
    jobsObservatory: 'osservatorio-stipendi-lavori-ticino',
    salaryCompare: 'confronta-stipendi',
    trafficHistory: 'storico-traffico-dogane',
    unemploymentStats: 'disoccupazione-svizzera',
    mortgageComparison: 'confronto-mutui',
    fuelPrices: 'prezzi-benzina-confine',
    healthPremiums: 'premi-malattia-comuni',
  },
  en: {
    calcolatore: 'calculate-salary',
    confronti: 'service-comparison',
    fisco: 'taxes-and-pension',
    guida: 'cross-border-guide',
    vita: 'living-in-ticino',
    stats: 'statistics',
    jobBoard: 'find-jobs-ticino',
    exchange: 'chf-eur-exchange-rate',
    banks: 'compare-banks',
    health: 'compare-health-insurance',
    mobile: 'compare-mobile-plans',
    shopping: 'compare-grocery-prices',
    costOfLiving: 'cost-of-living',
    jobs: 'compare-job-offers',
    renovation: 'calculate-renovation-bonus',
    firstDay: 'first-day-at-work',
    permits: 'work-permits-guide',
    border: 'border-waiting-times',
    unemployment: 'unemployment-benefits',
    carTransfer: 'transfer-car-to-switzerland',
    carCost: 'commuting-car-costs',
    permitCompare: 'compare-permit-g-vs-b',
    borderMap: 'border-map',
    livability: 'best-border-towns',
    jobsObservatory: 'ticino-jobs-salary-observatory',
    salaryCompare: 'compare-salaries',
    trafficHistory: 'border-traffic-history',
    unemploymentStats: 'unemployment-switzerland',
    mortgageComparison: 'mortgage-comparison',
    fuelPrices: 'border-fuel-prices',
    healthPremiums: 'health-insurance-premiums-by-commune',
  },
  de: {
    calcolatore: 'gehalt-berechnen',
    confronti: 'service-vergleich',
    fisco: 'steuern-und-vorsorge',
    guida: 'grenzgaenger-ratgeber',
    vita: 'leben-im-tessin',
    stats: 'statistiken',
    jobBoard: 'jobs-im-tessin',
    exchange: 'chf-eur-wechselkurs',
    banks: 'banken-vergleichen',
    health: 'krankenkassen-vergleichen',
    mobile: 'mobilfunk-vergleichen',
    shopping: 'einkaufspreise-vergleichen',
    costOfLiving: 'lebenshaltungskosten',
    jobs: 'stellenangebote-vergleichen',
    renovation: 'renovierungs-bonus-berechnen',
    firstDay: 'erster-arbeitstag',
    permits: 'arbeitsbewilligungen',
    border: 'wartezeiten-grenze',
    unemployment: 'arbeitslosengeld',
    carTransfer: 'auto-in-schweiz-ummelden',
    carCost: 'pendler-autokosten',
    permitCompare: 'bewilligung-g-vs-b',
    borderMap: 'grenzkarte',
    livability: 'beste-grenzgemeinden',
    jobsObservatory: 'stellen-und-lohn-observatorium-tessin',
    salaryCompare: 'gehaelter-vergleichen',
    trafficHistory: 'grenzverkehr-verlauf',
    unemploymentStats: 'arbeitslosigkeit-schweiz',
    mortgageComparison: 'hypotheken-vergleich',
    fuelPrices: 'spritpreise-grenze',
    healthPremiums: 'krankenkassentraemien-nach-gemeinde',
  },
  fr: {
    calcolatore: 'calculer-salaire',
    confronti: 'comparaison-services',
    fisco: 'impots-et-retraite',
    guida: 'guide-frontalier',
    vita: 'vivre-au-tessin',
    stats: 'statistiques',
    jobBoard: 'trouver-emploi-tessin',
    exchange: 'taux-change-chf-eur',
    banks: 'comparer-banques',
    health: 'comparer-caisses-maladie',
    mobile: 'comparer-forfaits-mobiles',
    shopping: 'comparer-prix-courses',
    costOfLiving: 'cout-de-la-vie',
    jobs: 'comparer-offres-emploi',
    renovation: 'calculer-bonus-renovation',
    firstDay: 'premier-jour-travail',
    permits: 'permis-de-travail',
    border: 'temps-attente-douane',
    unemployment: 'allocations-chomage',
    carTransfer: 'transferer-voiture-suisse',
    carCost: 'cout-voiture-pendulaire',
    permitCompare: 'comparer-permis-g-vs-b',
    borderMap: 'carte-frontiere',
    livability: 'meilleures-communes-frontiere',
    jobsObservatory: 'observatoire-emplois-salaires-tessin',
    salaryCompare: 'comparer-salaires',
    trafficHistory: 'historique-trafic-frontiere',
    unemploymentStats: 'chomage-suisse',
    mortgageComparison: 'comparaison-hypotheques',
    fuelPrices: 'prix-essence-frontiere',
    healthPremiums: 'primes-assurance-maladie-communes',
  },
};

// ── Labels (baked-in per locale) ───────────────────────────────

interface HubLabels {
  // confronti
  readonly exchange: string;
  readonly banks: string;
  readonly health: string;
  readonly mobile: string;
  readonly shopping: string;
  readonly costOfLiving: string;
  readonly jobs: string;
  readonly renovation: string;
  // guida
  readonly firstDay: string;
  readonly permits: string;
  readonly border: string;
  readonly unemployment: string;
  readonly carTransfer: string;
  readonly carCost: string;
  readonly permitCompare: string;
  readonly borderMap: string;
  // stats
  readonly statsOverview: string;
  readonly livability: string;
  readonly jobsObservatory: string;
  readonly salaryCompare: string;
  readonly trafficHistory: string;
  readonly unemploymentStats: string;
  readonly mortgageComparison: string;
  readonly fuelPrices: string;
}

const HUB_LABELS: Record<HubLocale, HubLabels> = {
  it: {
    exchange: 'Cambio Valuta',
    banks: 'Conti Correnti',
    health: 'Assicurazione Sanitaria',
    mobile: 'Telefonia Mobile',
    shopping: 'Spesa Transfrontaliera',
    costOfLiving: 'Costo della Vita',
    jobs: 'Offerte Lavoro',
    renovation: 'Ristrutturazione',
    firstDay: 'Primo Giorno',
    permits: 'Permessi Lavoro',
    border: 'Dogane & Tempi',
    unemployment: 'Disoccupazione',
    carTransfer: 'Auto in CH',
    carCost: 'Costo Auto',
    permitCompare: 'G vs B',
    borderMap: 'Mappa Comuni',
    statsOverview: 'Panoramica',
    livability: 'Vivibilità',
    jobsObservatory: 'Osservatorio lavoro',
    salaryCompare: 'Stipendi',
    trafficHistory: 'Storico Traffico',
    unemploymentStats: 'Disoccupazione',
    mortgageComparison: 'Mutui',
    fuelPrices: 'Carburanti',
  },
  en: {
    exchange: 'Currency Exchange',
    banks: 'Bank Accounts',
    health: 'Health Insurance',
    mobile: 'Mobile Plans',
    shopping: 'Cross-Border Shopping',
    costOfLiving: 'Cost of Living',
    jobs: 'Job Offers',
    renovation: 'Renovation',
    firstDay: 'First Day',
    permits: 'Work Permits',
    border: 'Customs & Times',
    unemployment: 'Unemployment',
    carTransfer: 'Car Transfer',
    carCost: 'Car Costs',
    permitCompare: 'G vs B',
    borderMap: 'Border Map',
    statsOverview: 'Overview',
    livability: 'Livability',
    jobsObservatory: 'Jobs observatory',
    salaryCompare: 'Salaries',
    trafficHistory: 'Traffic History',
    unemploymentStats: 'Unemployment',
    mortgageComparison: 'Mortgages',
    fuelPrices: 'Fuel prices',
  },
  de: {
    exchange: 'Währungstausch',
    banks: 'Bankkonten',
    health: 'Krankenversicherung',
    mobile: 'Mobilfunk',
    shopping: 'Grenzgänger-Einkauf',
    costOfLiving: 'Lebenshaltungskosten',
    jobs: 'Stellenangebote',
    renovation: 'Renovierung',
    firstDay: 'Erster Tag',
    permits: 'Arbeitsbewilligungen',
    border: 'Zoll & Zeiten',
    unemployment: 'Arbeitslosigkeit',
    carTransfer: 'Auto ummelden',
    carCost: 'Autokosten',
    permitCompare: 'G vs B',
    borderMap: 'Grenzkarte',
    statsOverview: 'Übersicht',
    livability: 'Lebensqualität',
    jobsObservatory: 'Job-Observatorium',
    salaryCompare: 'Gehälter',
    trafficHistory: 'Verkehrshistorie',
    unemploymentStats: 'Arbeitslosigkeit',
    mortgageComparison: 'Hypotheken',
    fuelPrices: 'Spritpreise',
  },
  fr: {
    exchange: 'Change Devise',
    banks: 'Comptes Bancaires',
    health: 'Assurance Maladie',
    mobile: 'Téléphonie Mobile',
    shopping: 'Courses transfrontalières',
    costOfLiving: 'Coût de la vie',
    jobs: "Offres d'Emploi",
    renovation: 'Rénovation',
    firstDay: 'Premier Jour',
    permits: 'Permis de travail',
    border: 'Douane & Temps',
    unemployment: 'Chômage',
    carTransfer: 'Transfert auto',
    carCost: 'Coût auto',
    permitCompare: 'G vs B',
    borderMap: 'Carte Frontière',
    statsOverview: 'Aperçu',
    livability: 'Habitabilité',
    jobsObservatory: 'Observatoire emploi',
    salaryCompare: 'Salaires',
    trafficHistory: 'Historique Trafic',
    unemploymentStats: 'Chômage',
    mortgageComparison: 'Hypothèques',
    fuelPrices: 'Carburants',
  },
};

// ── Inline SVG icons (mirror lucide-react) ─────────────────────

/**
 * Minimal inline SVG icons that visually match the lucide-react icons used by
 * `<SubTabNav>` in App.tsx. Each returns a stringified `<svg>` element sized
 * 16×16 on mobile and 18×18 on desktop (via CSS classes).
 */
const ICON_SVG: Record<string, string> = {
  // comparators
  exchange: '<path d="M16 3l4 4-4 4"/><path d="M20 7H4"/><path d="M8 21l-4-4 4-4"/><path d="M4 17h16"/>',
  banks: '<path d="M3 21h18"/><path d="M3 10h18"/><path d="M5 6l7-3 7 3"/><path d="M4 10v11"/><path d="M20 10v11"/><path d="M8 14v3"/><path d="M12 14v3"/><path d="M16 14v3"/>',
  health: '<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>',
  mobile: '<rect x="5" y="2" width="14" height="20" rx="2" ry="2"/><line x1="12" y1="18" x2="12" y2="18"/>',
  shopping: '<circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/>',
  costOfLiving: '<path d="M4 10h12"/><path d="M4 14h9"/><path d="M19 6a4 4 0 0 0-4-4H4v20h11a4 4 0 0 0 0-8"/>',
  jobs: '<rect x="2" y="7" width="20" height="14" rx="2" ry="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>',
  renovation: '<path d="M15 12l-8.5 8.5a2.12 2.12 0 1 1-3-3L12 9"/><path d="M17.64 15L22 10.64"/><path d="M20.91 11.7l-1.25-1.25c-.6-.6-.93-1.4-.93-2.25v-.86L16.01 4.6a5.56 5.56 0 0 0-3.94-1.64H9l.92.82A6.18 6.18 0 0 1 12 8.4v1.56l2 2h2.47l2.26 1.91"/>',
  // guida
  firstDay: '<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>',
  permits: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  border: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  unemployment: '<path d="M11 17.25C11 17.25 10.5 15.25 8 15.25s-3 2-3 3.75C5 20.75 6.5 22 8 22s3-1.25 3-2.75c0-.5-.22-1-.46-1.41"/><path d="M13 6.75c0 .5.22 1 .46 1.41"/><path d="M16 15.25c-2.5 0-3 2-3 3.75C13 20.75 14.5 22 16 22s3-1.25 3-2.75-1-3.75-3-4z"/><path d="M8 8.75s-.5 2-3 2-3-2-3-3.75S3.5 4 5 4s3 1.25 3 2.75c0 .5-.22 1-.46 1.41"/>',
  carTransfer: '<circle cx="7" cy="17" r="2"/><circle cx="17" cy="17" r="2"/><path d="M5 17H3v-6l2-5h9l4 5h1a2 2 0 0 1 2 2v4h-2"/><path d="M9 17h6"/>',
  carCost: '<circle cx="7" cy="17" r="2"/><circle cx="17" cy="17" r="2"/><path d="M5 17H3v-6l2-5h9l4 5h1a2 2 0 0 1 2 2v4h-2"/><path d="M9 17h6"/>',
  permitCompare: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  borderMap: '<polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/>',
  // stats
  statsOverview: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/>',
  livability: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/>',
  jobsObservatory: '<rect x="2" y="7" width="20" height="14" rx="2" ry="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>',
  salaryCompare: '<polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/>',
  trafficHistory: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  unemploymentStats: '<line x1="3" y1="3" x2="3" y2="21"/><line x1="3" y1="21" x2="21" y2="21"/><rect x="7" y="13" width="3" height="6"/><rect x="13" y="9" width="3" height="10"/><rect x="19" y="5" width="3" height="14"/>',
  mortgageComparison: '<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>',
  fuelPrices: '<line x1="3" y1="22" x2="15" y2="22"/><line x1="4" y1="9" x2="14" y2="9"/><path d="M14 22V4a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v18"/><path d="M14 13h2a2 2 0 0 1 2 2v2a2 2 0 0 0 2 2h0a2 2 0 0 0 2-2V9.83a2 2 0 0 0-.59-1.42L18 5"/>',
};

function renderIcon(key: string): string {
  const paths = ICON_SVG[key] ?? '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="shrink-0 md:w-[18px] md:h-[18px]">${paths}</svg>`;
}

// ── Sub-tab config per hub ─────────────────────────────────────

interface SubTabSpec {
  readonly key: string;
  readonly iconKey: string;
  readonly labelKey: keyof HubLabels;
  readonly slugKey: keyof HubSlugs;
}

/** Maps each SPA hub to its canonical 8 sub-tabs. Mirrors App.tsx lines ~1935-2055. */
const HUB_SUB_TABS: Record<HubKey, readonly SubTabSpec[]> = {
  calculator: [],
  fisco: [],
  confronti: [
    { key: 'exchange', iconKey: 'exchange', labelKey: 'exchange', slugKey: 'exchange' },
    { key: 'banks', iconKey: 'banks', labelKey: 'banks', slugKey: 'banks' },
    { key: 'health', iconKey: 'health', labelKey: 'health', slugKey: 'health' },
    { key: 'mobile', iconKey: 'mobile', labelKey: 'mobile', slugKey: 'mobile' },
    { key: 'shopping', iconKey: 'shopping', labelKey: 'shopping', slugKey: 'shopping' },
    { key: 'cost-of-living', iconKey: 'costOfLiving', labelKey: 'costOfLiving', slugKey: 'costOfLiving' },
    { key: 'jobs', iconKey: 'jobs', labelKey: 'jobs', slugKey: 'jobs' },
    { key: 'renovation', iconKey: 'renovation', labelKey: 'renovation', slugKey: 'renovation' },
  ],
  guida: [
    { key: 'first-day', iconKey: 'firstDay', labelKey: 'firstDay', slugKey: 'firstDay' },
    { key: 'permits', iconKey: 'permits', labelKey: 'permits', slugKey: 'permits' },
    { key: 'border', iconKey: 'border', labelKey: 'border', slugKey: 'border' },
    { key: 'unemployment', iconKey: 'unemployment', labelKey: 'unemployment', slugKey: 'unemployment' },
    { key: 'car-transfer', iconKey: 'carTransfer', labelKey: 'carTransfer', slugKey: 'carTransfer' },
    { key: 'car-cost', iconKey: 'carCost', labelKey: 'carCost', slugKey: 'carCost' },
    { key: 'permit-compare', iconKey: 'permitCompare', labelKey: 'permitCompare', slugKey: 'permitCompare' },
    { key: 'border-map', iconKey: 'borderMap', labelKey: 'borderMap', slugKey: 'borderMap' },
  ],
  vita: [],
  stats: [
    { key: 'overview', iconKey: 'statsOverview', labelKey: 'statsOverview', slugKey: 'stats' },
    { key: 'livability', iconKey: 'livability', labelKey: 'livability', slugKey: 'livability' },
    { key: 'jobs-observatory', iconKey: 'jobsObservatory', labelKey: 'jobsObservatory', slugKey: 'jobsObservatory' },
    { key: 'salary-compare', iconKey: 'salaryCompare', labelKey: 'salaryCompare', slugKey: 'salaryCompare' },
    { key: 'traffic-history', iconKey: 'trafficHistory', labelKey: 'trafficHistory', slugKey: 'trafficHistory' },
    { key: 'unemployment', iconKey: 'unemploymentStats', labelKey: 'unemploymentStats', slugKey: 'unemploymentStats' },
    { key: 'mortgage', iconKey: 'mortgageComparison', labelKey: 'mortgageComparison', slugKey: 'mortgageComparison' },
    { key: 'fuel-prices', iconKey: 'fuelPrices', labelKey: 'fuelPrices', slugKey: 'fuelPrices' },
  ],
  // `job-board` has no sub-nav in the SPA (it is not one of the 6 top tabs
  // that render a SubTabNav). Plugins mapped here (weeklyEmployers,
  // orphanQueryLanding) render the `confronti` sub-nav with `jobs` active,
  // so users retain a consistent navigational anchor back into the hub tree.
  'job-board': [],
};

/** Fallback hub → SPA hub for sub-nav purposes (`job-board` borrows confronti). */
const HUB_FALLBACK: Record<HubKey, HubKey> = {
  calculator: 'calculator',
  confronti: 'confronti',
  fisco: 'fisco',
  guida: 'guida',
  vita: 'vita',
  stats: 'stats',
  'job-board': 'confronti',
};

// ── URL builders ───────────────────────────────────────────────

function localePrefix(locale: HubLocale): string {
  return locale === 'it' ? '' : `/${locale}`;
}

function hubBaseKey(hub: HubKey): keyof HubSlugs {
  switch (hub) {
    case 'calculator':
      return 'calcolatore';
    case 'confronti':
      return 'confronti';
    case 'fisco':
      return 'fisco';
    case 'guida':
      return 'guida';
    case 'vita':
      return 'vita';
    case 'stats':
      return 'stats';
    case 'job-board':
      return 'jobBoard';
  }
}

function buildSubTabHref(hub: HubKey, spec: SubTabSpec, locale: HubLocale): string {
  const slugs = HUB_SLUGS[locale];
  const prefix = localePrefix(locale);
  const hubSlug = slugs[hubBaseKey(hub)];
  // Stats overview is the section root — no sub-slug.
  if (hub === 'stats' && spec.key === 'overview') {
    return `${prefix}/${hubSlug}/`;
  }
  const subSlug = slugs[spec.slugKey];
  return `${prefix}/${hubSlug}/${subSlug}/`;
}

// ── Hero ───────────────────────────────────────────────────────

const HERO_GRADIENT: Record<HubHeroVariant, string> = {
  green: 'background:linear-gradient(135deg,#10b981 0%,#059669 100%);color:#fff',
  blue: 'background:linear-gradient(135deg,#2563eb 0%,#1d4ed8 100%);color:#fff',
  purple: 'background:linear-gradient(135deg,#7c3aed 0%,#6d28d9 100%);color:#fff',
};

function renderHero(hero: HubHero): string {
  const variant = hero.variant ?? 'green';
  const style = HERO_GRADIENT[variant];
  const subtitle = hero.subtitle
    ? `<p style="margin:8px 0 0;font-size:1rem;line-height:1.55;opacity:.92">${esc(hero.subtitle)}</p>`
    : '';
  return `<section class="seo-hub-hero" style="${style};padding:24px 0;margin:0 0 16px">
  <div style="max-width:80rem;margin:0 auto;padding:0 1rem">
    <h1 style="margin:0;font-size:clamp(1.5rem,3.5vw,2rem);font-weight:800;letter-spacing:-.01em">${esc(hero.title)}</h1>
    ${subtitle}
  </div>
</section>`;
}

// ── SubTabNav server renderer ──────────────────────────────────

function renderSubTabNav(hub: HubKey, activeKey: string, locale: HubLocale): string {
  const effectiveHub = HUB_FALLBACK[hub];
  const items = HUB_SUB_TABS[effectiveHub];
  if (!items || items.length === 0) return '';

  const labels = HUB_LABELS[locale];
  const tabsHtml = items
    .map((spec) => {
      const isActive = spec.key === activeKey;
      const href = buildSubTabHref(effectiveHub, spec, locale);
      const label = labels[spec.labelKey];
      const activeClasses = isActive
        ? 'bg-tab-active-bg text-tab-active-text ring-2 ring-tab-active-border'
        : 'text-tab-inactive-text hover:bg-tab-hover-bg';
      const cls = `flex items-center md:flex-col gap-2 md:gap-0.5 px-3 md:px-1 py-2 md:py-1.5 min-h-[44px] md:min-h-0 rounded-xl text-sm font-semibold transition-[color,background-color,border-color,box-shadow] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 shrink-0 md:shrink ${activeClasses}`;
      const activeAttrs = isActive
        ? 'aria-selected="true" data-subtab-active="true" aria-current="page" tabindex="0"'
        : 'aria-selected="false" tabindex="-1"';
      return `<a href="${esc(href)}" role="tab" ${activeAttrs} class="${cls}" data-subtab-key="${esc(spec.key)}">
  ${renderIcon(spec.iconKey)}
  <span class="leading-tight text-center whitespace-nowrap md:whitespace-normal md:w-full md:line-clamp-2">${esc(label)}</span>
</a>`;
    })
    .join('\n  ');

  return `<nav class="seo-hub-subnav border-t border-edge bg-surface" aria-label="Hub navigation" data-hub="${esc(hub)}">
  <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-2 md:py-3">
    <div class="relative md:static">
      <div role="tablist" class="flex md:grid md:grid-cols-8 gap-1.5 overflow-x-auto md:overflow-x-visible scrollbar-hide pr-8 md:pr-0 py-1">
        ${tabsHtml}
      </div>
      <div aria-hidden="true" class="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-surface to-transparent md:hidden"></div>
    </div>
  </div>
</nav>`;
}

// ── Public API ─────────────────────────────────────────────────

/**
 * Wrap static SEO page content in a server-rendered hub chrome (sub-nav + hero).
 *
 * The returned HTML is intended to be passed as `bodyHtml` to
 * `buildSeoPageHtml`. It wraps `innerHtml` with:
 *   - `<nav class="seo-hub-subnav">` — 1:1 parity with `<SubTabNav>` in the SPA
 *   - optional `<section class="seo-hub-hero">`
 *
 * When `hubKey` has no sub-tabs in the SPA (e.g. `job-board`), a sensible
 * fallback hub is used (see {@link HUB_FALLBACK}).
 */
export function renderHubChrome(opts: RenderHubChromeOpts): string {
  const { hubKey, activeSubTab, locale, hero, innerHtml } = opts;
  const subnav = renderSubTabNav(hubKey, activeSubTab, locale);
  const heroHtml = hero ? renderHero(hero) : '';
  return `${subnav}
${heroHtml}
${innerHtml}`;
}

/** Exported for tests — canonical sub-tab URL builder. */
export function hubSubTabHref(hub: HubKey, subKey: string, locale: HubLocale): string | null {
  const effectiveHub = HUB_FALLBACK[hub];
  const spec = HUB_SUB_TABS[effectiveHub].find((s) => s.key === subKey);
  if (!spec) return null;
  return buildSubTabHref(effectiveHub, spec, locale);
}
