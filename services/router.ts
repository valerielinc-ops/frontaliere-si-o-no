/**
 * Internationalized Path-based Router Service (SEO-friendly)
 *
 * Uses clean URLs with history.pushState for proper SEO indexing.
 * URLs change based on the active locale (it / en / de / fr).
 * GitHub Pages SPA support via 404.html redirect.
 *
 * Example routes per locale:
 *   IT  /comparatori/cambio-valuta
 *   EN  /en/comparators/currency-exchange
 *   DE  /de/vergleiche/waehrungstausch
 *   FR  /fr/comparateurs/change-devises
 *
 * Italian (default locale) has NO prefix. Other locales use /{lang}/...
 */

import { getLocale, type Locale } from './i18n';

// ── Route types ──────────────────────────────────────────────

type ActiveTab = 'calculator' | 'feedback' | 'stats' | 'pension' | 'guide' | 'comparatori' | 'privacy' | 'data-deletion' | 'api-status';
type ComparatoriSubTab = 'exchange' | 'mobile' | 'transport' | 'health' | 'banks' | 'traffic' | 'jobs';
type SimulatorSubTab = 'calculator' | 'whatif';
type PensionSubTab = 'planner' | 'pillar3';
type GuideSection = 'municipalities' | 'living-ch' | 'living-it' | 'border' | 'costs' | 'calendar' | 'permits' | 'companies' | 'shopping' | 'cost-of-living' | 'places' | 'schools' | 'unemployment';

export interface AppRoute {
  activeTab: ActiveTab;
  comparatoriSubTab?: ComparatoriSubTab;
  simulatorSubTab?: SimulatorSubTab;
  pensionSubTab?: PensionSubTab;
  guideSection?: GuideSection;
}

// ── Internationalized slug maps ──────────────────────────────
// Each locale has its own set of human-readable slugs.
// The internal IDs remain constant regardless of locale.

interface SlugTable {
  // top-level section slugs
  comparatori: string;
  whatif: string;
  pension: string;
  pillar3: string;
  guide: string;
  stats: string;
  feedback: string;
  privacy: string;
  dataDeletion: string;
  apiStatus: string;
  newsletter: string;
  // comparatori sub-tab slugs
  exchange: string;
  mobile: string;
  transport: string;
  health: string;
  banks: string;
  traffic: string;
  jobs: string;
  // guide section slugs
  municipalities: string;
  livingCH: string;
  livingIT: string;
  border: string;
  costs: string;
  calendar: string;
  permits: string;
  companies: string;
  shopping: string;
  costOfLiving: string;
  places: string;
  schools: string;
  unemployment: string;
}

const SLUG_TABLES: Record<Locale, SlugTable> = {
  it: {
    comparatori: 'comparatori',
    whatif: 'simulatore-what-if',
    pension: 'pianificatore-pensione',
    pillar3: 'terzo-pilastro',
    guide: 'guida-frontalieri',
    stats: 'statistiche',
    feedback: 'supporto',
    privacy: 'privacy',
    dataDeletion: 'eliminazione-dati',
    apiStatus: 'stato-api',
    newsletter: 'newsletter',
    exchange: 'cambio-valuta',
    mobile: 'operatori-mobili',
    transport: 'trasporti',
    health: 'assicurazioni-sanitarie',
    banks: 'banche',
    traffic: 'traffico-valichi',
    jobs: 'offerte-lavoro',
    municipalities: 'comuni-frontiera',
    livingCH: 'vivere-in-svizzera',
    livingIT: 'vivere-in-italia',
    border: 'valichi-frontiera',
    costs: 'costi-pendolarismo',
    calendar: 'calendario-fiscale',
    permits: 'permessi-lavoro',
    companies: 'aziende-ticino',
    shopping: 'spesa-transfrontaliera',
    costOfLiving: 'costo-della-vita',
    places: 'posti-da-visitare',
    schools: 'scuole-ticino',
    unemployment: 'disoccupazione',
  },
  en: {
    comparatori: 'comparators',
    whatif: 'what-if-simulator',
    pension: 'pension-planner',
    pillar3: 'third-pillar',
    guide: 'frontier-guide',
    stats: 'statistics',
    feedback: 'support',
    privacy: 'privacy',
    dataDeletion: 'data-deletion',
    apiStatus: 'api-status',
    newsletter: 'newsletter',
    exchange: 'currency-exchange',
    mobile: 'mobile-operators',
    transport: 'transport',
    health: 'health-insurance',
    banks: 'banks',
    traffic: 'border-traffic',
    jobs: 'job-offers',
    municipalities: 'border-municipalities',
    livingCH: 'living-in-switzerland',
    livingIT: 'living-in-italy',
    border: 'border-crossings',
    costs: 'commuting-costs',
    calendar: 'tax-calendar',
    permits: 'work-permits',
    companies: 'ticino-companies',
    shopping: 'cross-border-shopping',
    costOfLiving: 'cost-of-living',
    places: 'places-to-visit',
    schools: 'schools-ticino',
    unemployment: 'unemployment',
  },
  de: {
    comparatori: 'vergleiche',
    whatif: 'was-waere-wenn',
    pension: 'rentenplaner',
    pillar3: 'dritte-saeule',
    guide: 'grenzgaenger-ratgeber',
    stats: 'statistiken',
    feedback: 'hilfe',
    privacy: 'datenschutz',
    dataDeletion: 'daten-loeschen',
    apiStatus: 'api-status',
    newsletter: 'newsletter',
    exchange: 'waehrungstausch',
    mobile: 'mobilfunkanbieter',
    transport: 'verkehr',
    health: 'krankenversicherung',
    banks: 'banken',
    traffic: 'grenzverkehr',
    jobs: 'stellenangebote',
    municipalities: 'grenzgemeinden',
    livingCH: 'leben-in-der-schweiz',
    livingIT: 'leben-in-italien',
    border: 'grenzuebergaenge',
    costs: 'pendelkosten',
    calendar: 'steuerkalender',
    permits: 'arbeitsbewilligungen',
    companies: 'tessiner-unternehmen',
    shopping: 'grenz-einkauf',
    costOfLiving: 'lebenshaltungskosten',
    places: 'sehenswuerdigkeiten',
    schools: 'schulen-tessin',
    unemployment: 'arbeitslosigkeit',
  },
  fr: {
    comparatori: 'comparateurs',
    whatif: 'simulateur-hypothetique',
    pension: 'planificateur-retraite',
    pillar3: 'troisieme-pilier',
    guide: 'guide-frontalier',
    stats: 'statistiques',
    feedback: 'assistance',
    privacy: 'confidentialite',
    dataDeletion: 'suppression-donnees',
    apiStatus: 'etat-api',
    newsletter: 'newsletter',
    exchange: 'change-devises',
    mobile: 'operateurs-mobiles',
    transport: 'transports',
    health: 'assurance-maladie',
    banks: 'banques',
    traffic: 'trafic-frontiere',
    jobs: 'offres-emploi',
    municipalities: 'communes-frontiere',
    livingCH: 'vivre-en-suisse',
    livingIT: 'vivre-en-italie',
    border: 'postes-frontiere',
    costs: 'couts-pendulaire',
    calendar: 'calendrier-fiscal',
    permits: 'permis-travail',
    companies: 'entreprises-tessin',
    shopping: 'achats-transfrontaliers',
    costOfLiving: 'cout-de-la-vie',
    places: 'lieux-a-visiter',
    schools: 'ecoles-tessin',
    unemployment: 'chomage',
  },
};

// ── Reverse lookup helpers ───────────────────────────────────
// Build reverse maps: slug → internal ID, for every locale

type ComparatoriSlugMap = Record<string, ComparatoriSubTab>;
type GuideSlugMap = Record<string, GuideSection>;
type TopLevelSlugMap = Record<string, { tab: ActiveTab; sub?: string }>;

const COMPARATORI_KEYS: (keyof SlugTable & string)[] = ['exchange', 'mobile', 'transport', 'health', 'banks', 'traffic', 'jobs'];
const GUIDE_KEYS: { key: keyof SlugTable; id: GuideSection }[] = [
  { key: 'municipalities', id: 'municipalities' },
  { key: 'livingCH', id: 'living-ch' },
  { key: 'livingIT', id: 'living-it' },
  { key: 'border', id: 'border' },
  { key: 'costs', id: 'costs' },
  { key: 'calendar', id: 'calendar' },
  { key: 'permits', id: 'permits' },
  { key: 'companies', id: 'companies' },
  { key: 'shopping', id: 'shopping' },
  { key: 'costOfLiving', id: 'cost-of-living' },
  { key: 'places', id: 'places' },
  { key: 'schools', id: 'schools' },
  { key: 'unemployment', id: 'unemployment' },
];

// Builds a single-locale reverse map for comparatori slugs
function buildComparatoriReverse(table: SlugTable): ComparatoriSlugMap {
  const map: ComparatoriSlugMap = {};
  for (const k of COMPARATORI_KEYS) {
    map[table[k]] = k as ComparatoriSubTab;
  }
  return map;
}

// Builds a single-locale reverse map for guide slugs
function buildGuideReverse(table: SlugTable): GuideSlugMap {
  const map: GuideSlugMap = {};
  for (const { key, id } of GUIDE_KEYS) {
    map[table[key]] = id;
  }
  return map;
}

// Pre-build reverse maps for every locale (perf: avoids re-creating on each route)
const REVERSE_COMPARATORI: Record<Locale, ComparatoriSlugMap> = {
  it: buildComparatoriReverse(SLUG_TABLES.it),
  en: buildComparatoriReverse(SLUG_TABLES.en),
  de: buildComparatoriReverse(SLUG_TABLES.de),
  fr: buildComparatoriReverse(SLUG_TABLES.fr),
};

const REVERSE_GUIDE: Record<Locale, GuideSlugMap> = {
  it: buildGuideReverse(SLUG_TABLES.it),
  en: buildGuideReverse(SLUG_TABLES.en),
  de: buildGuideReverse(SLUG_TABLES.de),
  fr: buildGuideReverse(SLUG_TABLES.fr),
};

// Build top-level slug → tab mapping for each locale
function buildTopLevelReverse(table: SlugTable): TopLevelSlugMap {
  return {
    [table.comparatori]: { tab: 'comparatori' },
    [table.whatif]: { tab: 'calculator', sub: 'whatif' },
    [table.pension]: { tab: 'pension' },
    [table.guide]: { tab: 'guide' },
    [table.stats]: { tab: 'stats' },
    [table.feedback]: { tab: 'feedback' },
    [table.privacy]: { tab: 'privacy' },
    [table.dataDeletion]: { tab: 'data-deletion' },
    [table.apiStatus]: { tab: 'api-status' },
    [table.newsletter]: { tab: 'feedback' },
  };
}

const REVERSE_TOP: Record<Locale, TopLevelSlugMap> = {
  it: buildTopLevelReverse(SLUG_TABLES.it),
  en: buildTopLevelReverse(SLUG_TABLES.en),
  de: buildTopLevelReverse(SLUG_TABLES.de),
  fr: buildTopLevelReverse(SLUG_TABLES.fr),
};

// ── Locale detection from path ───────────────────────────────

/** Detect locale from the first path segment. Returns [locale, restParts]. */
function detectLocaleFromPath(parts: string[]): [Locale, string[]] {
  if (parts.length > 0 && ['en', 'de', 'fr'].includes(parts[0])) {
    return [parts[0] as Locale, parts.slice(1)];
  }
  return ['it', parts]; // Italian is default (no prefix)
}

/** Get the locale prefix for building paths. Empty string for Italian. */
function localePrefix(locale: Locale): string {
  return locale === 'it' ? '' : `/${locale}`;
}

// ── Public API ───────────────────────────────────────────────

export interface ParseResult {
  route: AppRoute;
  locale: Locale;
}

/**
 * Parse the current pathname into a route + detected locale.
 */
export function parsePath(pathname: string): ParseResult {
  const path = pathname.replace(/\/$/, '').toLowerCase() || '/';
  const allParts = path.split('/').filter(Boolean);
  const [locale, parts] = detectLocaleFromPath(allParts);

  const table = SLUG_TABLES[locale];
  const revTop = REVERSE_TOP[locale];
  const revComp = REVERSE_COMPARATORI[locale];
  const revGuide = REVERSE_GUIDE[locale];

  if (parts.length === 0) {
    return { route: { activeTab: 'calculator', simulatorSubTab: 'calculator' }, locale };
  }

  const first = parts[0];

  // Check top-level slug
  const topMatch = revTop[first];
  if (topMatch) {
    // What-if simulator
    if (topMatch.sub === 'whatif') {
      return { route: { activeTab: 'calculator', simulatorSubTab: 'whatif' }, locale };
    }

    // Comparatori
    if (topMatch.tab === 'comparatori') {
      const sub = parts[1] ? (revComp[parts[1]] || 'exchange') : 'exchange';
      return { route: { activeTab: 'comparatori', comparatoriSubTab: sub }, locale };
    }

    // Pension
    if (topMatch.tab === 'pension') {
      const sub = parts[1] === table.pillar3 ? 'pillar3' : 'planner';
      return { route: { activeTab: 'pension', pensionSubTab: sub }, locale };
    }

    // Guide
    if (topMatch.tab === 'guide') {
      const section = parts[1] ? (revGuide[parts[1]] || 'municipalities') : 'municipalities';
      return { route: { activeTab: 'guide', guideSection: section }, locale };
    }

    // Other simple tabs
    return { route: { activeTab: topMatch.tab as ActiveTab }, locale };
  }

  // Fallback: try all locales (for bookmarked URLs in wrong locale)
  for (const tryLocale of (['it', 'en', 'de', 'fr'] as Locale[])) {
    if (tryLocale === locale) continue;
    const tryTop = REVERSE_TOP[tryLocale];
    const tryMatch = tryTop[first];
    if (tryMatch) {
      // Recursively parse with detected locale parts
      const rebuilt = `/${tryLocale === 'it' ? '' : tryLocale + '/'}${parts.join('/')}`;
      // We found a match in another locale — redirect to current locale version
      return parsePath(rebuilt);
    }
  }

  return { route: { activeTab: 'calculator', simulatorSubTab: 'calculator' }, locale };
}

/**
 * Parse legacy hash-based URL into new pathname for migration.
 * Uses current locale for the output path.
 */
export function parseHashToPath(hash: string): string | null {
  if (!hash || hash === '#' || hash === '#/') return null;
  const path = hash.replace(/^#\/?/, '').toLowerCase();
  const parts = path.split('/').filter(Boolean);
  if (parts.length === 0) return null;

  const locale = getLocale();
  const table = SLUG_TABLES[locale];
  const prefix = localePrefix(locale);

  if (parts[0] === 'calculator') {
    return parts[1] === 'whatif' ? `${prefix}/${table.whatif}` : '/';
  }
  if (parts[0] === 'comparatori') {
    const subKey = parts[1] as ComparatoriSubTab;
    const slug = COMPARATORI_KEYS.includes(subKey as any) ? table[subKey as keyof SlugTable] : table.exchange;
    return `${prefix}/${table.comparatori}/${slug}`;
  }
  if (parts[0] === 'pensione') {
    return parts[1] === 'pillar3'
      ? `${prefix}/${table.pension}/${table.pillar3}`
      : `${prefix}/${table.pension}`;
  }
  if (parts[0] === 'guida') {
    const guideEntry = GUIDE_KEYS.find(g => g.id === parts[1]);
    const slug = guideEntry ? table[guideEntry.key] : null;
    return slug ? `${prefix}/${table.guide}/${slug}` : `${prefix}/${table.guide}`;
  }
  if (parts[0] === 'statistiche') return `${prefix}/${table.stats}`;
  if (parts[0] === 'supporto') return `${prefix}/${table.feedback}`;
  if (parts[0] === 'privacy') return `${prefix}/${table.privacy}`;
  if (parts[0] === 'data-deletion') return `${prefix}/${table.dataDeletion}`;
  if (parts[0] === 'api-status') return `${prefix}/${table.apiStatus}`;

  return null;
}

/**
 * Build a clean URL path from route state.
 * Uses the provided locale (or current locale if omitted).
 */
export function buildPath(route: AppRoute, locale?: Locale): string {
  const lang = locale || getLocale();
  const table = SLUG_TABLES[lang];
  const prefix = localePrefix(lang);

  switch (route.activeTab) {
    case 'calculator':
      return route.simulatorSubTab === 'whatif' ? `${prefix}/${table.whatif}` : (prefix || '/');
    case 'comparatori': {
      const subKey = route.comparatoriSubTab || 'exchange';
      return `${prefix}/${table.comparatori}/${table[subKey]}`;
    }
    case 'pension': {
      return route.pensionSubTab === 'pillar3'
        ? `${prefix}/${table.pension}/${table.pillar3}`
        : `${prefix}/${table.pension}`;
    }
    case 'guide': {
      const section = route.guideSection || 'municipalities';
      const guideEntry = GUIDE_KEYS.find(g => g.id === section);
      const slug = guideEntry ? table[guideEntry.key] : table.municipalities;
      return section === 'municipalities'
        ? `${prefix}/${table.guide}`
        : `${prefix}/${table.guide}/${slug}`;
    }
    case 'stats':
      return `${prefix}/${table.stats}`;
    case 'feedback':
      return `${prefix}/${table.feedback}`;
    case 'privacy':
      return `${prefix}/${table.privacy}`;
    case 'data-deletion':
      return `${prefix}/${table.dataDeletion}`;
    case 'api-status':
      return `${prefix}/${table.apiStatus}`;
    default:
      return prefix || '/';
  }
}

/**
 * Build paths for all locales (used for hreflang tags).
 */
export function buildAllLocalePaths(route: AppRoute): Record<Locale, string> {
  return {
    it: buildPath(route, 'it'),
    en: buildPath(route, 'en'),
    de: buildPath(route, 'de'),
    fr: buildPath(route, 'fr'),
  };
}

/**
 * Get the SEO section key for updating meta tags.
 */
export function getSeoSection(route: AppRoute): string {
  switch (route.activeTab) {
    case 'calculator':
      return route.simulatorSubTab === 'whatif' ? 'whatif' : 'calculator';
    case 'comparatori':
      return route.comparatoriSubTab || 'exchange';
    case 'pension':
      return route.pensionSubTab === 'pillar3' ? 'pillar3' : 'pension';
    case 'guide': {
      const section = route.guideSection || 'municipalities';
      const seoMap: Record<string, string> = {
        calendar: 'calendar',
        permits: 'permits',
        shopping: 'shopping',
        'cost-of-living': 'costOfLiving',
        companies: 'companies',
        municipalities: 'guide',
        'living-ch': 'livingCH',
        'living-it': 'livingIT',
        border: 'border',
        costs: 'costs',
        places: 'places',
        schools: 'schools',
        unemployment: 'unemployment',
      };
      return seoMap[section] || 'guide';
    }
    case 'stats':
      return 'stats';
    case 'feedback':
      return 'feedback';
    default:
      return route.activeTab;
  }
}

/**
 * Push a new route to the browser history (creates new history entry).
 */
export function pushRoute(route: AppRoute): void {
  const newPath = buildPath(route);
  if (window.location.pathname !== newPath) {
    history.pushState({ route }, '', newPath);
  }
}

/**
 * Replace current route (no new history entry).
 */
export function replaceRoute(route: AppRoute): void {
  const newPath = buildPath(route);
  if (window.location.pathname !== newPath) {
    history.replaceState({ route }, '', newPath);
  }
}

/**
 * When locale changes, rewrite the current URL with the new locale's slugs.
 * Uses replaceState so no extra history entry is created.
 */
export function updatePathForLocale(newLocale: Locale): void {
  const { route } = parsePath(window.location.pathname);
  const newPath = buildPath(route, newLocale);
  if (window.location.pathname !== newPath) {
    history.replaceState({ route }, '', newPath);
  }
}
