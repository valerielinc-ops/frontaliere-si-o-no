/**
 * Fuel-station / fuel-cities BROWSEABLE INDEX pages.
 *
 * Why this module exists
 * ----------------------
 * Semrush's 2026-04-28 audit flagged 4 fuel-related sitemaps as having
 * thousands of "orphaned pages in sitemaps" (URLs listed in sitemap-*.xml but
 * not reachable via internal `<a href>` BFS from `/`):
 *
 *   - sitemap-fuel-italian-stations.xml: 424 / 424 = 100 % orphans
 *   - sitemap-fuel-stations.xml:         342 / 488 = 70 %
 *   - sitemap-fuel-italian-cities.xml:    88 /  88 = 100 %
 *   - sitemap-fuel-daily.xml:             24 /  48 = 50 % (DE + FR locales)
 *
 * Per CLAUDE.md non-negotiable rule #5, the fix is to add internal links —
 * never to noindex pages. This module emits 3 paginated browseable indexes
 * per fuel × locale that link every per-station / per-city leaf, plus
 * locale-link tiles on each daily-fuel page that point to the matching DE
 * and FR variants (those are the 24 daily orphans).
 *
 * Indexes emitted (per-fuel × per-locale):
 *
 *   /{section}/stazioni-svizzere/  — Swiss-station index (Ticino zones or
 *                                    national canton groups)
 *   /{section}/stazioni-italia/    — Italian-station index (grouped by city)
 *   /{section}/citta-italiane/     — Italian-city index (alphabetical hub)
 *
 * The IT-station index is emitted per fuel that has station coverage: always
 * benzina, plus diesel once the MIMIT-Gasolio ingestion provides diesel
 * leaves (passed via `italianStationsByFuel`). With no diesel leaves the
 * diesel IT-station index is skipped (no orphans).
 *
 * Each index contains:
 *   - Full <head> with title, description, canonical, hreflang (4 locales +
 *     x-default = IT), and BreadcrumbList JSON-LD
 *   - >=200 words of coherent prose (methodology + frontaliere context + FAQ)
 *   - One <a href> for every leaf in the category (so BFS from `/` reaches
 *     them after the daily-fuel hub picks up these indexes)
 *   - Hub chrome and the same SPA shell as the daily pages (via
 *     buildSeoPageHtml).
 *
 * Counts (steady state, when diesel coverage exists):
 *   Swiss-stations: 4 locales × 2 fuels = 8 indexes
 *   IT-stations:    4 locales × ≤2 fuels = up to 8 indexes (benzina + diesel)
 *   IT-cities:      4 locales × 2 fuels = 8 indexes
 *   Total:          up to 24 indexes
 */

import {
  FUEL_DAILY_LOCALES,
  FUEL_LOCALE_PREFIX,
  FUEL_SECTION_SLUG,
  FUEL_TYPES,
  FUEL_TYPE_LABEL,
  FUEL_ZONES,
  FUEL_ZONE_DISPLAY,
  FUEL_ITALIAN_CITIES,
  buildFuelItalianCityPath,
  buildFuelItalianStationPath,
  buildFuelStationPath,
  buildFuelTodayPath,
  frFuelOf,
  type FuelDailyLocale,
  type FuelType,
  type FuelZone,
  type ItalianCityEntry,
} from './fuelDailyData';
import { BASE_URL } from './constants';
import { FUEL_INDEX_SLUG } from './shared/fuelRouteSlugs.mjs';
import { buildSeoPageHtml } from './shared/seoPageShell';
import { renderHreflangTags } from './shared/hreflang';
import {
  H2_STYLE,
  ICON_FUEL_SVG,
  ICON_MAP_PIN_SVG,
  ICON_NAVIGATION_SVG,
  clampSiteSuffix,
  renderEntityCard,
} from './shared/seoContentTokens';
import { resolveStationBrandLogoUrl } from './shared/fuelBrandLogo';
import { inlineScriptJson } from './shared/inlineJsonScript';
import { paginationRobots } from './shared/paginationIndexPolicy';
import { infeedAdListItemHtml } from './lib/adSlotHtml';
import { shouldPlaceInfeedAd } from '../services/adsenseSlots';

// Index pages use shared semantic-token CSS classes instead of repeating long
// inline declarations in every row and pagination chip.

// Zone-context hint: short locale-aware line that adds geographic flavour
// under each zone header. Keeps the page from feeling like a wall of brand
// names — gives commuters an instant "is this my crossing?" signal.
const FUEL_ZONE_BORDER_HINT: Record<FuelZone, Record<FuelDailyLocale, string>> = {
  chiasso: {
    it: 'Confine: Chiasso · Brogeda · Pedrinate',
    en: 'Border: Chiasso · Brogeda · Pedrinate',
    de: 'Grenze: Chiasso · Brogeda · Pedrinate',
    fr: 'Frontière : Chiasso · Brogeda · Pedrinate',
  },
  mendrisio: {
    it: 'Confine: Stabio · Gaggiolo · Bizzarone',
    en: 'Border: Stabio · Gaggiolo · Bizzarone',
    de: 'Grenze: Stabio · Gaggiolo · Bizzarone',
    fr: 'Frontière : Stabio · Gaggiolo · Bizzarone',
  },
  lugano: {
    it: 'Centro Sottoceneri · A2 Lugano-Sud/Nord',
    en: 'Sottoceneri hub · A2 Lugano-South/North',
    de: 'Sottoceneri-Knoten · A2 Lugano-Süd/Nord',
    fr: 'Pôle Sottoceneri · A2 Lugano-Sud/Nord',
  },
  bellinzona: {
    it: 'Capitale cantonale · biforcazione A2/A13',
    en: 'Cantonal capital · A2/A13 split',
    de: 'Kantonshauptstadt · A2/A13-Verzweigung',
    fr: 'Capitale cantonale · embranchement A2/A13',
  },
  locarno: {
    it: 'Lago Maggiore · valico di Brissago',
    en: 'Lake Maggiore · Brissago crossing',
    de: 'Lago Maggiore · Übergang Brissago',
    fr: 'Lac Majeur · passage de Brissago',
  },
};

// ── Types ─────────────────────────────────────────────────────────

/** One Swiss station leaf (the data the index needs to render its anchor). */
export interface SwissStationLeaf {
  /** Present only when the station has a routeable Ticino detail contract. */
  readonly zone?: FuelZone | null;
  /** Present only when the station has a routeable Ticino detail contract. */
  readonly slug?: string | null;
  /** Derived canton URL group; never used to invent a detail URL. */
  readonly canton?: string | null;
  readonly name: string;
  readonly brand: string;
  readonly address: string;
  /** Coordinates used by the client-side price map on the Swiss index. */
  readonly lat?: number | null;
  readonly lng?: number | null;
  /** Daily per-litre prices, kept together so the map can switch fuel without a new build. */
  readonly benzinaPriceChf?: number | null;
  readonly dieselPriceChf?: number | null;
  readonly updatedAt?: string | null;
  readonly dieselUpdatedAt?: string | null;
  /** Retrieval timestamp; distinct from an unavailable pump-change timestamp. */
  readonly observedAt?: string | null;
  readonly priceStatus?: {
    readonly sp95?: 'available' | 'unavailable' | string;
    readonly diesel?: 'available' | 'unavailable' | string;
  };
}

/**
 * Explicit contract for the national Swiss index source.
 *
 * `stations` is the provider snapshot, not a census. A national station may
 * deliberately have neither a Ticino `zone` nor a `slug`: the index renders
 * it as a data row without manufacturing a URL.
 */
export interface SwissNationalIndexSnapshot {
  readonly scope: 'national';
  readonly provider: string;
  readonly coverageType: 'provider-snapshot' | string;
  readonly inventoryCompleteness: 'not-verified' | string;
  readonly anchorFuel?: 'SP95' | string;
  readonly stationCount?: number;
  readonly observedAt?: string | null;
  readonly source?: {
    readonly inventoryProvider?: string;
    readonly inventoryDataUrl?: string;
    readonly inventoryAttributionUrl?: string;
    readonly inventoryLicense?: string;
    readonly inventoryAttribution?: string;
    readonly inventoryObservedAt?: string | null;
  };
  readonly stations: readonly SwissStationLeaf[];
}

/** One Italian station leaf. */
export interface ItalianStationLeaf {
  readonly citySlug: string;
  readonly cityDisplay: string;
  readonly stationSlug: string;
  readonly name: string;
  readonly brand: string;
  readonly address: string;
}

/** Inputs for the index generator. */
export interface FuelIndexInputs {
  readonly distDir?: string;
  /**
   * Project root (Vite `config.root`). When provided the index pages render
   * real brand logos for each station via `resolveStationBrandLogoUrl`; when
   * omitted the entity-card falls back to the inline fuel-pump icon — keeps
   * the test suite logo-free without extra fixtures.
   */
  readonly rootDir?: string;
  readonly today: Date;
  readonly swissStations: readonly SwissStationLeaf[];
  /**
   * Optional unfiltered national snapshot for the canonical Swiss index.
   * Omitted callers retain the historical five-zone, priced-only behaviour.
   */
  readonly swissNationalSnapshot?: SwissNationalIndexSnapshot;
  /**
   * Benzina Italian-station leaves. Kept as the back-compat default: callers
   * that don't pass `italianStationsByFuel` get benzina-only behaviour.
   */
  readonly italianStations: readonly ItalianStationLeaf[];
  /**
   * Per-fuel Italian-station leaves. When provided, the Italian-stations index
   * is emitted for every fuel that has at least one leaf (diesel appears once
   * MIMIT-Gasolio coverage lands). Absent ⇒ benzina-only (legacy behaviour).
   */
  readonly italianStationsByFuel?: Partial<Record<FuelType, readonly ItalianStationLeaf[]>>;
  /**
   * Full Italian-city entry list (curated + every municipality with priced
   * stations) used for the cities-by-zone index. Absent ⇒ falls back to the
   * curated FUEL_ITALIAN_CITIES (legacy behaviour).
   */
  readonly italianCities?: readonly ItalianCityEntry[];
  /**
   * Canonical paths the build ACTUALLY wrote (post word-gate). When provided,
   * the index emits an anchor only if its href is in this set, so a city-hub /
   * station page skipped for thin content is never linked from the crawlable,
   * sitemap'd index → no broken internal links / soft-404s. Absent ⇒ no gating
   * (legacy / unit-test behaviour).
   */
  readonly emittedPaths?: ReadonlySet<string>;
}


// ── Locale-aware index slugs ──────────────────────────────────────

/** Last-segment slug per locale for the 3 index types. */
export { FUEL_INDEX_SLUG };

export type FuelIndexKind = keyof typeof FUEL_INDEX_SLUG;

/**
 * Maximum number of Italian-station cards per HTML page. The complete leaf
 * set remains linkable through the generated page ladder, while each page
 * stays below the shared 260 KB audit budget with room for upstream growth.
 */
export const ITALIAN_STATIONS_INDEX_PAGE_SIZE = 100;

/** Maximum number of national Swiss station rows rendered per HTML page. */
export const SWISS_STATIONS_INDEX_PAGE_SIZE = 100;

/**
 * Build the canonical path for a fuel-station / fuel-cities index page.
 *
 *   buildFuelIndexPath('it', 'benzina', 'swissStations')
 *     → '/prezzi-benzina/stazioni-svizzere/'
 *   buildFuelIndexPath('en', 'benzina', 'italianCities')
 *     → '/en/gasoline-price-switzerland/italian-cities/'
 */
export function buildFuelIndexPath(
  locale: FuelDailyLocale,
  fuel: FuelType,
  kind: FuelIndexKind,
): string {
  const prefix = FUEL_LOCALE_PREFIX[locale];
  const section = FUEL_SECTION_SLUG[locale][fuel];
  const last = FUEL_INDEX_SLUG[kind][locale];
  const parts = [prefix, section, last]
    .map((p) => String(p).replace(/^\/+|\/+$/g, ''))
    .filter((p) => p.length > 0);
  return `/${parts.join('/')}/`;
}

/**
 * Build the canonical path for one page of a browseable index.
 * Page 1 keeps the established root URL; page 2 onwards use `/page-N/`.
 */
export function buildFuelIndexPaginationPath(
  locale: FuelDailyLocale,
  fuel: FuelType,
  kind: FuelIndexKind,
  page: number,
): string {
  const base = buildFuelIndexPath(locale, fuel, kind);
  const pageNumber = Math.floor(page);
  if (!Number.isFinite(pageNumber) || pageNumber <= 1) return base;
  return `${base.replace(/\/+$/, '')}/page-${pageNumber}/`;
}

// ── Localised copy ────────────────────────────────────────────────

interface IndexCopy {
  readonly breadcrumbHome: string;
  readonly updatedLabel: string;
  readonly groupHeadingByZone: (zone: string) => string;
  readonly groupHeadingByCanton: (canton: string) => string;
  readonly groupHeadingByCity: (city: string) => string;
  /** "Vicino a Chiasso" / "Near Chiasso" — used to group Italian cities by the nearest Ticino zone. */
  readonly groupHeadingNearZone: (zone: string) => string;
  readonly seeStationLink: (label: string) => string;
  readonly faqTitle: string;
  readonly methodologyHeading: string;
  readonly frontaliereHeading: string;
  readonly browseHeading: string;
  readonly relatedHeading: string;
  readonly relatedLinkLabels: {
    readonly swissStations: string;
    readonly italianStations: string;
    readonly italianCities: string;
    readonly dailyHub: string;
  };
  /** Stat tile labels — kept short so the value (number) dominates. */
  readonly statLabels: {
    readonly stations: string;
    readonly cities: string;
    readonly zones: string;
    readonly nationalGroups: string;
    readonly source: string;
    readonly updateFreq: string;
    readonly updateValue: string;
  };
  /** "Consiglio" advice banner content (locale-aware). */
  readonly advice: {
    readonly label: string;
    readonly bodyByKind: (kind: FuelIndexKind, fuelLabel: string) => string;
  };
  /** Primary CTA label that links to the matching daily-hub page. */
  readonly ctaDailyHub: (fuelLabel: string) => string;
  /** Header above the zone-chip quick-jump nav. */
  readonly jumpNavLabel: string;
  /** Header above the national canton/group quick-jump nav. */
  readonly nationalJumpNavLabel: string;
  /** Heading above the national canton/group browse list. */
  readonly nationalBrowseHeading: string;
  /** Singular/plural noun for a station, used in zone count chips. */
  readonly stationsNoun: (count: number) => string;
  /** Singular/plural noun for a city, used in city-grouped indexes. */
  readonly citiesNoun: (count: number) => string;
}

const COPY_IT: IndexCopy = {
  breadcrumbHome: 'Home',
  updatedLabel: 'Aggiornato',
  groupHeadingByZone: (zone) => `Stazioni di ${zone}`,
  groupHeadingByCanton: (canton) => `Gruppo cantonale ${canton}`,
  groupHeadingByCity: (city) => `Stazioni a ${city}`,
  groupHeadingNearZone: (zone) => `Vicino a ${zone}`,
  seeStationLink: (label) => `Vedi prezzi: ${label}`,
  faqTitle: 'Domande frequenti',
  methodologyHeading: 'Come funziona questo indice',
  frontaliereHeading: 'Perché questo indice è utile per i frontalieri',
  browseHeading: 'Sfoglia per zona',
  relatedHeading: 'Vedi anche',
  relatedLinkLabels: {
    swissStations: 'Indice stazioni svizzere',
    italianStations: 'Indice stazioni italiane',
    italianCities: 'Indice città italiane',
    dailyHub: 'Prezzo carburanti oggi (Ticino)',
  },
  statLabels: {
    stations: 'Stazioni',
    cities: 'Città',
    zones: 'Zone',
    nationalGroups: 'Cantoni/gruppi',
    source: 'Fonte',
    updateFreq: 'Aggiornamento',
    updateValue: 'Giornaliero',
  },
  advice: {
    label: 'Consiglio frontaliere',
    bodyByKind: (kind, fuelLabel) => {
      if (kind === 'swissStations') {
        return `Confronta lo stesso carburante e controlla la data di acquisizione. Valuta il risparmio sul pieno insieme ai costi della deviazione dal tuo percorso.`;
      }
      if (kind === 'italianStations') {
        return `Confronta il prezzo italiano del ${fuelLabel.toLowerCase()} con la stazione svizzera del tuo valico prima di partire: lo spread CHF/EUR cambia ogni giorno e ribalta facilmente la convenienza.`;
      }
      return `Apri prima la pagina della tua città: vedi la media del giorno e la stazione svizzera più vicina per confrontare al volo prima di fare il pieno.`;
    },
  },
  ctaDailyHub: (fuelLabel) => `Vedi il prezzo ${fuelLabel.toLowerCase()} di oggi`,
  jumpNavLabel: 'Salta alla zona',
  nationalJumpNavLabel: 'Salta al cantone o gruppo cantonale',
  nationalBrowseHeading: 'Sfoglia per cantone o gruppo cantonale',
  stationsNoun: (n) => (n === 1 ? 'stazione' : 'stazioni'),
  citiesNoun: (n) => (n === 1 ? 'città' : 'città'),
};

const COPY_EN: IndexCopy = {
  breadcrumbHome: 'Home',
  updatedLabel: 'Updated',
  groupHeadingByZone: (zone) => `Stations in ${zone}`,
  groupHeadingByCanton: (canton) => `Canton group ${canton}`,
  groupHeadingByCity: (city) => `Stations in ${city}`,
  groupHeadingNearZone: (zone) => `Near ${zone}`,
  seeStationLink: (label) => `See prices: ${label}`,
  faqTitle: 'Frequently asked questions',
  methodologyHeading: 'How this index works',
  frontaliereHeading: 'Why this index helps cross-border commuters',
  browseHeading: 'Browse by zone',
  relatedHeading: 'See also',
  relatedLinkLabels: {
    swissStations: 'Swiss stations index',
    italianStations: 'Italian stations index',
    italianCities: 'Italian cities index',
    dailyHub: 'Today\'s fuel price (Ticino)',
  },
  statLabels: {
    stations: 'Stations',
    cities: 'Cities',
    zones: 'Zones',
    nationalGroups: 'Canton groups',
    source: 'Source',
    updateFreq: 'Refresh',
    updateValue: 'Daily',
  },
  advice: {
    label: 'Commuter tip',
    bodyByKind: (kind, fuelLabel) => {
      if (kind === 'swissStations') {
        return `Compare the same fuel and check collection dates. Weigh the saving on your full tank against the cost of any detour from your route.`;
      }
      if (kind === 'italianStations') {
        return `Compare today’s Italian ${fuelLabel.toLowerCase()} with the Swiss station at your usual crossing before driving — the CHF/EUR spread shifts daily and can flip the convenient side.`;
      }
      return `Open your city page first: it shows today’s average plus the closest Swiss station so you can decide where to refuel without leaving the page.`;
    },
  },
  ctaDailyHub: (fuelLabel) => `See today’s ${fuelLabel.toLowerCase()} price`,
  jumpNavLabel: 'Jump to zone',
  nationalJumpNavLabel: 'Jump to canton or canton group',
  nationalBrowseHeading: 'Browse by canton or canton group',
  stationsNoun: (n) => (n === 1 ? 'station' : 'stations'),
  citiesNoun: (n) => (n === 1 ? 'city' : 'cities'),
};

const COPY_DE: IndexCopy = {
  breadcrumbHome: 'Startseite',
  updatedLabel: 'Aktualisiert',
  groupHeadingByZone: (zone) => `Tankstellen in ${zone}`,
  groupHeadingByCanton: (canton) => `Kantonsgruppe ${canton}`,
  groupHeadingByCity: (city) => `Tankstellen in ${city}`,
  groupHeadingNearZone: (zone) => `Nahe ${zone}`,
  seeStationLink: (label) => `Preise ansehen: ${label}`,
  faqTitle: 'Häufige Fragen',
  methodologyHeading: 'So funktioniert dieser Index',
  frontaliereHeading: 'Warum dieser Index Grenzgängern hilft',
  browseHeading: 'Nach Region durchsuchen',
  relatedHeading: 'Siehe auch',
  relatedLinkLabels: {
    swissStations: 'Index Schweizer Tankstellen',
    italianStations: 'Index italienische Tankstellen',
    italianCities: 'Index italienische Städte',
    dailyHub: 'Spritpreis heute (Tessin)',
  },
  statLabels: {
    stations: 'Tankstellen',
    cities: 'Städte',
    zones: 'Regionen',
    nationalGroups: 'Kantonsgruppen',
    source: 'Quelle',
    updateFreq: 'Aktualisierung',
    updateValue: 'Täglich',
  },
  advice: {
    label: 'Grenzgänger-Tipp',
    bodyByKind: (kind, fuelLabel) => {
      if (kind === 'swissStations') {
        return `Vergleiche denselben Kraftstoff und die Abrufdaten. Berücksichtige beim Preisvorteil auch die tatsächlichen Umwegkosten.`;
      }
      if (kind === 'italianStations') {
        return `Vergleiche den italienischen Preis für ${fuelLabel} mit der Schweizer Tankstelle deines Übergangs, bevor du losfährst: der CHF/EUR-Kurs verändert die günstigere Seite täglich.`;
      }
      return `Öffne zuerst die Stadtseite: dort siehst du den Tagesdurchschnitt und die nächstgelegene Schweizer Tankstelle für einen schnellen Vergleich.`;
    },
  },
  ctaDailyHub: (fuelLabel) => `${fuelLabel}-Preis heute ansehen`,
  jumpNavLabel: 'Zur Region springen',
  nationalJumpNavLabel: 'Zu Kanton oder Kantonsgruppe springen',
  nationalBrowseHeading: 'Nach Kanton oder Kantonsgruppe durchsuchen',
  stationsNoun: (n) => (n === 1 ? 'Tankstelle' : 'Tankstellen'),
  citiesNoun: (n) => (n === 1 ? 'Stadt' : 'Städte'),
};

const COPY_FR: IndexCopy = {
  breadcrumbHome: 'Accueil',
  updatedLabel: 'Mis à jour',
  groupHeadingByZone: (zone) => `Stations à ${zone}`,
  groupHeadingByCanton: (canton) => `Groupe cantonal ${canton}`,
  groupHeadingByCity: (city) => `Stations à ${city}`,
  groupHeadingNearZone: (zone) => `Près de ${zone}`,
  seeStationLink: (label) => `Voir les prix : ${label}`,
  faqTitle: 'Questions fréquentes',
  methodologyHeading: 'Comment fonctionne cet index',
  frontaliereHeading: 'Pourquoi cet index aide les frontaliers',
  browseHeading: 'Parcourir par zone',
  relatedHeading: 'Voir aussi',
  relatedLinkLabels: {
    swissStations: 'Index stations suisses',
    italianStations: 'Index stations italiennes',
    italianCities: 'Index villes italiennes',
    dailyHub: 'Prix du carburant aujourd\'hui (Tessin)',
  },
  statLabels: {
    stations: 'Stations',
    cities: 'Villes',
    zones: 'Zones',
    nationalGroups: 'Groupes cantonaux',
    source: 'Source',
    updateFreq: 'Mise à jour',
    updateValue: 'Quotidienne',
  },
  advice: {
    label: 'Astuce frontalier',
    bodyByKind: (kind, fuelLabel) => {
      if (kind === 'swissStations') {
        return `Comparez le même carburant et les dates d’acquisition. Évaluez l’économie sur le plein avec les frais réels du détour.`;
      }
      if (kind === 'italianStations') {
        return `Comparez le prix italien ${frFuelOf(fuelLabel)} avec la station suisse de votre passage avant de partir : le taux CHF/EUR évolue chaque jour et fait basculer le côté avantageux.`;
      }
      return `Ouvrez d’abord la page ville : vous voyez la moyenne du jour et la station suisse la plus proche pour comparer sans changer de page.`;
    },
  },
  ctaDailyHub: (fuelLabel) => `Voir le prix ${fuelLabel.toLowerCase()} du jour`,
  jumpNavLabel: 'Aller à la zone',
  nationalJumpNavLabel: 'Aller au canton ou groupe cantonal',
  nationalBrowseHeading: 'Parcourir par canton ou groupe cantonal',
  stationsNoun: (n) => (n === 1 ? 'station' : 'stations'),
  citiesNoun: (n) => (n === 1 ? 'ville' : 'villes'),
};

const COPY: Record<FuelDailyLocale, IndexCopy> = {
  it: COPY_IT,
  en: COPY_EN,
  de: COPY_DE,
  fr: COPY_FR,
};

// ── Per-index titles + lede + prose blocks ────────────────────────
//
// Three index kinds × four locales × two fuels (with one IT-stations
// exception) = ~20 unique heading sets. Keep copy real and page-specific
// — never hidden filler. Each block is hand-written, addresses methodology
// + frontaliere refuelling habits, and includes the fuel name + index kind
// to keep titles unique.

export interface IndexTitleSet {
  readonly title: string;
  readonly description: string;
  readonly h1: string;
  readonly lede: string;
  readonly methodology: string;
  readonly frontaliereContext: string;
}

export type FuelIndexScope = 'ticino' | 'national';

/** Copy for the national Swiss index. It must describe a combined snapshot
 * plus open inventory, never a complete census. */
function nationalSwissTitleFor(locale: FuelDailyLocale, fuelLabel: string, hasOpenInventory = true): IndexTitleSet {
  const lower = fuelLabel.toLowerCase();
  if (!hasOpenInventory) {
    if (locale === 'it') return {
      title: `Stazioni ${lower} in Svizzera — snapshot nazionale`,
      description: `Snapshot nazionale dei prezzi delle stazioni ${lower}, raggruppato per cantone o gruppo cantonale. Completezza della fonte non verificata; i prezzi mancanti restano visibili.`,
      h1: `Stazioni ${lower} in Svizzera — snapshot nazionale`,
      lede: `Tutte le stazioni restituite dalla fonte nazionale dei prezzi ${lower}, raggruppate per cantone o gruppo cantonale e distribuite su pagine navigabili.`,
      methodology: `Questo indice conserva il provider snapshot nazionale disponibile e mantiene distinti inventario, prezzo e momento di acquisizione. La completezza della fonte non è verificata e l’elenco non è un censimento completo delle pompe svizzere. Benzina e diesel sono campi indipendenti: quando il prezzo ${lower} manca, la stazione resta nell’elenco con lo stato “Prezzo non disponibile per questo carburante”. L’orario di acquisizione indica quando il campione è stato letto; la sorgente può non fornire l’orario della variazione alla pompa. Per le stazioni ticinesi manteniamo i collegamenti alle pagine dettaglio esistenti; le altre restano righe informative finché non esiste un contratto URL nazionale.`,
      frontaliereContext: `Per chi attraversa il confine Italia-Svizzera, il confronto utile dipende dal percorso reale, dal carburante scelto e dalla data del dato. Un prezzo nazionale può essere lontano dal tuo valico e non include automaticamente il costo della deviazione. Confronta lo stesso carburante in una valuta comune con un cambio datato, considera chilometri, pedaggi e tempo aggiuntivi e verifica sempre il prezzo esposto alla pompa. Le pagine Ticino continuano a servire il comparatore frontaliero, mentre questo indice conserva la vista nazionale della fonte disponibile.`,
    };
    if (locale === 'en') return {
      title: `Swiss ${lower} stations — national snapshot`,
      description: `National price snapshot for ${lower} stations grouped by canton or canton group. Source completeness is not verified; missing prices remain visible.`,
      h1: `Swiss ${lower} stations — national snapshot`,
      lede: `Every station returned by the national ${lower} price source, grouped by canton or canton group and split across browseable pages.`,
      methodology: `This index preserves the available national provider snapshot and keeps inventory, price and collection time distinct. Source completeness is not verified and this is not a complete census of Swiss pumps. Petrol and diesel are independent fields: when the ${lower} price is missing, the station remains visible with “Price unavailable for this fuel”. Collection time records when the sample was read; the source may not provide the time when the pump price changed. Existing Ticino station detail links remain available; other stations are informational rows until a national URL contract exists.`,
      frontaliereContext: `For cross-border commuters, a useful comparison depends on the actual route, fuel type and observation date. A national price may be far from your crossing and does not include detour costs. Compare the same fuel in one currency with a dated exchange rate, account for extra kilometres, tolls and time, and check the displayed pump price before refuelling. Ticino pages still serve the border comparator, while this index preserves the national view from the available source.`,
    };
    if (locale === 'de') return {
      title: `Schweizer ${lower}-Tankstellen — nationaler Snapshot`,
      description: `Nationaler Preissnapshot der ${lower}-Tankstellen, nach Kanton oder Kantonsgruppe gruppiert. Vollständigkeit der Quelle nicht verifiziert; fehlende Preise bleiben sichtbar.`,
      h1: `Schweizer ${lower}-Tankstellen — nationaler Snapshot`,
      lede: `Alle Tankstellen aus der nationalen ${lower}-Preisquelle, nach Kanton oder Kantonsgruppe gruppiert und auf navigierbare Seiten verteilt.`,
      methodology: `Dieser Index bewahrt den verfügbaren nationalen provider snapshot und hält Inventar, Preis und Abrufzeit getrennt. Die Vollständigkeit der Quelle ist nicht verifiziert; dies ist keine vollständige Zählung aller Schweizer Zapfsäulen. Benzin und Diesel sind unabhängige Felder: Fehlt der ${lower}-Preis, bleibt die Tankstelle mit „Preis für diesen Kraftstoff nicht verfügbar“ sichtbar. Die Abrufzeit bezeichnet das Lesen des Samples; die Quelle liefert möglicherweise nicht den Zeitpunkt der Preisänderung. Bestehende Tessiner Detail-URLs bleiben erhalten; andere Stationen sind Informationszeilen, bis ein nationaler URL-Vertrag besteht.`,
      frontaliereContext: `Für Grenzgänger hängt ein sinnvoller Vergleich von tatsächlicher Strecke, Kraftstoff und Erhebungsdatum ab. Ein nationaler Preis kann weit vom Übergang entfernt sein und enthält keine Umwegkosten. Vergleichen Sie denselben Kraftstoff in einer Währung mit datiertem Wechselkurs, berücksichtigen Sie zusätzliche Kilometer, Maut und Zeit und prüfen Sie den Preis an der Zapfsäule. Die Tessiner Seiten bleiben der Grenzvergleich, während dieser Index die nationale Sicht der verfügbaren Quelle bewahrt.`,
    };
    return {
      title: `Stations ${lower} en Suisse — snapshot national`,
      description: `Snapshot national des prix des stations ${lower}, groupés par canton ou groupe cantonal. Complétude de la source non vérifiée ; les prix manquants restent visibles.`,
      h1: `Stations ${lower} en Suisse — snapshot national`,
      lede: `Toutes les stations renvoyées par la source nationale de prix ${lower}, groupées par canton ou groupe cantonal et réparties sur des pages navigables.`,
      methodology: `Cet index conserve le provider snapshot national disponible et garde séparés inventaire, observation de prix et date d’acquisition. La complétude de la source n’est pas vérifiée ; il ne s’agit pas d’un recensement complet des pompes suisses. L’essence et le diesel sont des champs indépendants : si le prix ${lower} manque, la station reste visible avec le statut « Prix indisponible pour ce carburant ». La date d’acquisition indique quand l’échantillon a été lu ; la source ne fournit peut-être pas l’heure du changement à la pompe. Les URL de détail tessinoises existantes restent disponibles ; les autres stations sont des lignes informatives jusqu’à un contrat URL national.`,
      frontaliereContext: `Pour les frontaliers, une comparaison utile dépend du trajet réel, du carburant et de la date du relevé. Un prix national peut être éloigné du passage et n’inclut pas les frais du détour. Comparez le même carburant dans une devise avec un taux daté, comptez kilomètres, péages et temps supplémentaires et vérifiez le prix affiché à la pompe. Les pages tessinoises restent dédiées au comparateur, tandis que cet index conserve la vue nationale de la source disponible.`,
    };
  }
  if (locale === 'it') return {
    title: `Stazioni ${lower} in Svizzera — snapshot TCS + OSM`,
    description: `Snapshot nazionale dei prezzi TCS e inventario fisico OpenStreetMap delle stazioni ${lower}, raggruppati per cantone o gruppo cantonale. Completezza inventariale non verificata; i prezzi mancanti restano visibili.`,
    h1: `Stazioni ${lower} in Svizzera — snapshot TCS + OSM`,
    lede: `Tutte le stazioni restituite dal prezzo nazionale TCS o dal registro fisico OpenStreetMap, raggruppate per cantone o gruppo cantonale e distribuite su pagine navigabili.`,
    methodology: `Questo indice unisce il TCS provider snapshot acquisito dalla Cloud Function verificata con il registro fisico OpenStreetMap, mantenendo separati inventario e prezzo. Conserva tutte le righe dopo la deduplicazione stabile. Il contratto espone inventoryCompleteness: not-verified: non è un censimento completo delle pompe svizzere e non implica che ogni punto vendita sia presente. La benzina e il diesel sono campi indipendenti: quando il prezzo ${lower} manca, la stazione resta nell’elenco con lo stato “Prezzo non disponibile per questo carburante”. L’orario di acquisizione indica quando il campione è stato letto; la sorgente TCS non fornisce necessariamente l’orario della variazione alla pompa. Per le stazioni ticinesi manteniamo i collegamenti alle pagine dettaglio esistenti; le altre restano righe informative finché non esiste un contratto URL nazionale.`,
    frontaliereContext: `Per chi attraversa il confine Italia-Svizzera, il confronto utile dipende dal percorso reale, dal carburante scelto e dalla data del dato. Un prezzo nazionale può essere lontano dal tuo valico e non include automaticamente il costo della deviazione. Confronta lo stesso carburante in una valuta comune con un cambio datato, considera chilometri, pedaggi e tempo aggiuntivi e verifica sempre il prezzo esposto alla pompa. Le pagine Ticino continuano a servire il comparatore frontaliero: la sua proiezione resta limitata alle stazioni entro 25 km dai comuni italiani monitorati, mentre questo indice conserva la vista nazionale TCS + OpenStreetMap.`,
  };
  if (locale === 'en') return {
    title: `Swiss ${lower} stations — TCS + OSM snapshot`,
    description: `National TCS price snapshot and OpenStreetMap physical inventory of ${lower} stations grouped by canton or canton group. Inventory completeness is not verified; missing prices remain visible.`,
    h1: `Swiss ${lower} stations — TCS + OSM snapshot`,
    lede: `Every station returned by the national TCS price source or the OpenStreetMap inventory, grouped by canton or canton group and split across browseable pages.`,
    methodology: `This index combines a TCS provider snapshot collected from the verified Cloud Function with the OpenStreetMap physical inventory, keeping inventory and price observations separate. It keeps every row after stable deduplication. Its contract explicitly says inventoryCompleteness: not-verified: this is not a complete census of Swiss pumps and does not imply that every retail site is present. Petrol and diesel are independent fields: when the ${lower} price is missing, the station remains visible with “Price unavailable for this fuel”. Collection time records when the snapshot was read; TCS does not necessarily provide the time when the pump price changed. Existing Ticino station detail links remain available; other stations are informational rows until a national URL contract exists.`,
    frontaliereContext: `For cross-border commuters, a useful comparison depends on the actual route, fuel type and observation date. A national price may be far from your crossing and does not include detour costs. Compare the same fuel in one currency with a dated exchange rate, account for extra kilometres, tolls and time, and check the displayed pump price before refuelling. Ticino pages still serve the border comparator: its projection remains limited to stations within 25 km of the monitored Italian municipalities, while this index preserves the combined TCS + OpenStreetMap national view.`,
  };
  if (locale === 'de') return {
    title: `Schweizer ${lower}-Tankstellen — TCS + OSM`,
    description: `Nationaler TCS-Preissnapshot und physisches OpenStreetMap-Inventar der ${lower}-Tankstellen, nach Kanton oder Kantonsgruppe gruppiert. Vollständigkeit des Inventars nicht verifiziert; fehlende Preise bleiben sichtbar.`,
    h1: `Schweizer ${lower}-Tankstellen — TCS + OSM`,
    lede: `Alle Tankstellen aus der nationalen TCS-Preisquelle oder dem OpenStreetMap-Inventar, nach Kanton oder Kantonsgruppe gruppiert und auf navigierbare Seiten verteilt.`,
    methodology: `Dieser Index kombiniert einen TCS provider snapshot aus der verifizierten Cloud Function mit dem physischen OpenStreetMap-Inventar und hält Inventar und Preisbeobachtung getrennt. Nach stabiler Deduplizierung bleiben alle Zeilen sichtbar. Der Vertrag nennt ausdrücklich inventoryCompleteness: not-verified: Dies ist keine vollständige Zählung aller Schweizer Zapfsäulen und bedeutet nicht, dass jeder Standort enthalten ist. Benzin und Diesel sind unabhängige Felder: Fehlt der ${lower}-Preis, bleibt die Tankstelle mit dem Status „Preis für diesen Kraftstoff nicht verfügbar“ sichtbar. Die Abrufzeit bezeichnet das Lesen des Snapshots; TCS liefert nicht zwingend den Zeitpunkt der Preisänderung an der Zapfsäule. Bestehende Tessiner Detail-URLs bleiben erhalten; andere Stationen sind Informationszeilen, bis ein nationaler URL-Vertrag besteht.`,
    frontaliereContext: `Für Grenzgänger hängt ein sinnvoller Vergleich von tatsächlicher Strecke, Kraftstoff und Erhebungsdatum ab. Ein nationaler Preis kann weit vom Übergang entfernt sein und enthält keine Umwegkosten. Vergleichen Sie denselben Kraftstoff in einer Währung mit datiertem Wechselkurs, berücksichtigen Sie zusätzliche Kilometer, Maut und Zeit und prüfen Sie den Preis an der Zapfsäule. Die Tessiner Seiten bleiben der Grenzvergleich: Ihre Projektion umfasst weiterhin nur Stationen innerhalb von 25 km der überwachten italienischen Gemeinden, während dieser Index die kombinierte nationale Sicht von TCS und OpenStreetMap bewahrt.`,
  };
  return {
    title: `Stations ${lower} en Suisse — snapshot TCS + OSM`,
    description: `Snapshot national des prix TCS et inventaire physique OpenStreetMap des stations ${lower}, groupés par canton ou groupe cantonal. Complétude de l’inventaire non vérifiée ; les prix manquants restent visibles.`,
    h1: `Stations ${lower} en Suisse — snapshot TCS + OSM`,
    lede: `Toutes les stations renvoyées par la source nationale de prix TCS ou l’inventaire OpenStreetMap, groupées par canton ou groupe cantonal et réparties sur des pages navigables.`,
    methodology: `Cet index combine un TCS provider snapshot recueilli par la Cloud Function vérifiée avec l’inventaire physique OpenStreetMap, en gardant séparés inventaire et observation de prix. Toutes les lignes restent visibles après déduplication stable. Le contrat indique explicitement inventoryCompleteness: not-verified : il ne s’agit pas d’un recensement complet des pompes suisses et cela ne signifie pas que chaque site soit présent. L’essence et le diesel sont des champs indépendants : si le prix ${lower} manque, la station reste visible avec le statut « Prix indisponible pour ce carburant ». La date d’acquisition indique quand le snapshot a été lu ; TCS ne fournit pas forcément l’heure du changement à la pompe. Les URL de détail tessinoises existantes restent disponibles ; les autres stations sont des lignes informatives jusqu’à un contrat URL national.`,
    frontaliereContext: `Pour les frontaliers, une comparaison utile dépend du trajet réel, du carburant et de la date du relevé. Un prix national peut être éloigné du passage et n’inclut pas les frais du détour. Comparez le même carburant dans une devise avec un taux daté, comptez kilomètres, péages et temps supplémentaires et vérifiez le prix affiché à la pompe. Les pages tessinoises restent dédiées au comparateur frontalier : sa projection demeure limitée aux stations dans un rayon de 25 km des communes italiennes suivies, tandis que cet index conserve la vue nationale combinée de TCS et OpenStreetMap.`,
  };
}

export function titleFor(
  kind: FuelIndexKind,
  locale: FuelDailyLocale,
  fuel: FuelType,
  scope: FuelIndexScope = 'ticino',
  hasOpenInventory = true,
): IndexTitleSet {
  const fuelLabel = FUEL_TYPE_LABEL[locale][fuel];
  const lower = fuelLabel.toLowerCase();
  if (kind === 'swissStations') {
    if (scope === 'national') return nationalSwissTitleFor(locale, fuelLabel, hasOpenInventory);
    if (locale === 'it') return {
      title: `Tutte le stazioni ${lower} in Ticino — indice per zona`,
      description: `Indice completo delle stazioni di rifornimento ${lower} monitorate in Ticino, raggruppate per zona (Chiasso, Mendrisio, Lugano, Bellinzona, Locarno). Prezzi segnalati dagli utenti TCS.`,
      h1: `Stazioni ${lower} in Ticino — indice completo`,
      lede: `Sfoglia ogni stazione di rifornimento ${lower} che monitoriamo in Ticino, raggruppata per zona di confine. Ogni voce porta alla pagina giornaliera con il prezzo rilevato, posizione nella classifica della zona e contesto frontaliere.`,
      methodology: `I prezzi provengono da TCS Benzinpreis (Touring Club Svizzero), che raccoglie prezzi segnalati dagli utenti delle stazioni di rifornimento in Svizzera. La nostra pipeline li mappa per zona ticinese, dedupla le voci con stesso brand e indirizzo, e pubblica una pagina dedicata per ogni stazione monitorata. L'indice qui sotto raggruppa le stazioni per zona di confine così puoi confrontare a colpo d'occhio le opzioni più vicine al tuo valico abituale. Una stazione senza prezzo disponibile per questo carburante non entra nella lista. La data di acquisizione indica quando il dato è stato letto, non quando il gestore ha cambiato prezzo. Rigenerare la pagina non aggiorna il campione: controlla sempre il prezzo alla pompa.`,
      frontaliereContext: `Per chi attraversa il confine Italia-Svizzera, il carburante è una spesa da confrontare sul percorso reale. Esempio ipotetico: 220 giorni con 60 km al giorno e un consumo di 6 litri ogni 100 km corrispondono a 792 litri annui. Una differenza di 0,10 CHF/litro su quel consumo vale 79,20 CHF, prima di eventuali deviazioni. Non sono medie misurate dei frontalieri né una promessa di risparmio. Per decidere, usa i tuoi chilometri e consumi, confronta lo stesso carburante in una valuta comune con un cambio datato e sottrai carburante, pedaggi e tempo della deviazione. La mappa aiuta a scegliere stazioni vicine al tragitto; indirizzo, modalità di servizio e data del dato restano parte del confronto.`,
    };
    if (locale === 'en') return {
      title: `All Swiss ${lower} stations — Ticino index`,
      description: `Complete browseable index of ${lower} stations we monitor in Ticino, grouped by border zone. User-reported TCS prices.`,
      h1: `Swiss ${lower} stations — full Ticino index`,
      lede: `Browse every Swiss ${lower} station we monitor in Ticino, grouped by border zone. Each entry links to the daily page with the observed price, ranking in the zone, and cross-border commuter context.`,
      methodology: `Prices come from TCS Benzinpreis (Touring Club Suisse), which collects user-reported prices for Swiss stations. Our pipeline maps each station to its Ticino border zone, deduplicates same-brand same-address entries, and publishes one dedicated page per station with the available observations. The index below groups stations by zone so you can compare options near your usual border crossing at a glance. A station without an available price for this fuel is not listed. Collection time indicates when the data was read, not when the operator changed its price. Rebuilding this page does not refresh the sample: always check the price at the pump.`,
      frontaliereContext: `For workers crossing the Italy-Switzerland border, fuel costs should be compared on their actual route. Hypothetical example: 220 days at 60 km per day and 6 litres per 100 km mean 792 litres per year. A CHF 0.10/litre difference over that volume amounts to CHF 79.20 before detour costs. These are assumptions, not measured commuter averages or promised savings. Use your own distance and consumption, compare the same fuel in one currency with a dated exchange rate, and subtract fuel, tolls and time added by the detour. The map helps locate stations along your route; address, service mode and collection date remain part of the comparison.`,
    };
    if (locale === 'de') return {
      title: `Alle ${lower}-Tankstellen — Tessin-Index`,
      description: `Vollständiger Index der von uns überwachten ${lower}-Tankstellen im Tessin, nach Grenzregion gruppiert. Preisangaben von TCS-Nutzern.`,
      h1: `${fuelLabel}-Tankstellen Tessin — vollständiger Index`,
      lede: `Durchsuche jede ${lower}-Tankstelle, die wir im Tessin überwachen, gruppiert nach Grenzregion. Jeder Eintrag verlinkt auf die Seite mit erfasstem Preis, Ranking in der Region und Grenzgänger-Kontext.`,
      methodology: `Die Preise stammen von TCS Benzinpreis (Touring Club Schweiz), der Preisangaben von Nutzern für Schweizer Tankstellen sammelt. Unsere Pipeline ordnet jede Tankstelle ihrer Tessiner Grenzregion zu, entfernt Duplikate mit derselben Marke und Adresse und veröffentlicht für jede überwachte Station eine eigene Seite mit den verfügbaren Angaben. Der Index unten gruppiert die Stationen nach Region, sodass du auf einen Blick die nächstgelegenen Optionen für deinen Grenzübergang vergleichen kannst. Eine Tankstelle ohne verfügbaren Preis für diesen Kraftstoff wird nicht aufgelistet. Die Abrufzeit bezeichnet das Lesen der Daten, nicht die Preisänderung durch den Betreiber. Ein Neuaufbau der Seite erneuert die Stichprobe nicht: prüfen Sie den Preis an der Zapfsäule.`,
      frontaliereContext: `Für Grenzgänger sind Treibstoffkosten anhand der tatsächlichen Strecke zu vergleichen. Hypothetisches Beispiel: 220 Tage mit 60 km täglich und 6 Litern je 100 km ergeben 792 Liter im Jahr. Ein Unterschied von CHF 0,10 pro Liter entspricht dabei CHF 79,20 vor Umwegkosten. Das sind Annahmen, keine gemessenen Durchschnittswerte oder Sparversprechen. Verwenden Sie Ihre eigenen Kilometer und Verbrauchswerte, vergleichen Sie denselben Kraftstoff in einer Währung mit datiertem Wechselkurs und ziehen Sie zusätzliche Kosten für Kraftstoff, Maut und Zeit ab. Die Karte zeigt Stationen am Weg; Adresse, Bedienungsart und Abrufdatum gehören ebenfalls zum Vergleich.`,
    };
    return {
      title: `Toutes les stations ${lower} en Suisse — index Tessin`,
      description: `Index complet des stations ${lower} surveillées au Tessin, groupées par zone frontalière. Prix signalés par les utilisateurs TCS.`,
      h1: `Stations ${lower} au Tessin — index complet`,
      lede: `Parcourez chaque station ${lower} que nous surveillons au Tessin, groupée par zone frontalière. Chaque entrée mène à la page quotidienne avec le prix relevé, le classement dans la zone et le contexte frontalier.`,
      methodology: `Les prix proviennent de TCS Benzinpreis (Touring Club Suisse), qui recueille les prix signalés par les utilisateurs des stations suisses. Notre pipeline associe chaque station à sa zone tessinoise, déduplique les entrées de même marque et adresse, et publie une page dédiée par station avec des données quotidiennes. L'index ci-dessous groupe les stations par zone afin que vous puissiez comparer les options proches de votre passage habituel. Une station sans prix disponible pour ce carburant n’est pas listée. L’acquisition indique quand les données ont été lues, pas quand le gestionnaire a modifié son tarif. La régénération de la page ne renouvelle pas l’échantillon : vérifiez le prix à la pompe.`,
      frontaliereContext: `Pour les frontaliers, le carburant se compare sur le trajet réel. Exemple hypothétique : 220 jours à 60 km par jour et 6 litres aux 100 km donnent 792 litres par an. Un écart de 0,10 CHF/litre sur ce volume représente 79,20 CHF avant les frais du détour. Ce sont des hypothèses, pas des moyennes mesurées ni une promesse d’économie. Utilisez vos kilomètres et consommations, comparez le même carburant dans une devise commune avec un taux de change daté, puis déduisez le carburant, les péages et le temps supplémentaires. La carte aide à repérer des stations sur le trajet ; adresse, mode de service et date du relevé complètent le calcul.`,
    };
  }
  if (kind === 'italianStations') {
    if (locale === 'it') return {
      title: `Tutte le stazioni ${lower} in Italia (confine) — indice`,
      description: `Indice delle stazioni italiane ${lower} delle città di confine (Como, Varese, Luino, Lavena Ponte Tresa…) con prezzi MIMIT aggiornati ogni giorno.`,
      h1: `Stazioni ${lower} Italia confine — indice completo`,
      lede: `Indice di ogni stazione di rifornimento italiana ${lower} delle città di confine che monitoriamo. Raggruppato per comune così puoi confrontare prima di passare il valico.`,
      methodology: `I prezzi delle stazioni italiane provengono dal portale "Osservaprezzi Carburanti" del MIMIT (Ministero delle Imprese e del Made in Italy), aggiornato ogni giorno dai gestori. La nostra pipeline filtra le stazioni dei 15 comuni di confine, dedupla per id e pubblica una pagina dedicata per ognuna. La benzina è il taglio carburante con copertura più completa; per il diesel italiano (Gasolio) pubblichiamo le stazioni che riportano un prezzo Gasolio nel feed MIMIT del giorno.`,
      frontaliereContext: `Se vivi in Italia e lavori in Ticino, scegliere se fare il pieno prima del confine o dopo dipende dallo spread CHF/EUR del giorno. Storicamente il ${lower} svizzero costa di più al litro nominale ma, con il franco forte e i prezzi italiani in linea con la media UE, lo spread si è ristretto. Questo indice ti dà tutte le opzioni delle città di confine in un colpo d'occhio: dalle stazioni vicino al casello di Como Centro alle pompe self-service di Lavena Ponte Tresa che molti frontalieri usano nel ritorno serale.`,
    };
    if (locale === 'en') return {
      title: `All Italian ${lower} stations near the border — index`,
      description: `Index of Italian ${lower} stations across border-zone cities (Como, Varese, Luino, Lavena Ponte Tresa…). Daily MIMIT prices.`,
      h1: `Italian ${lower} border stations — full index`,
      lede: `Browse every Italian ${lower} station we track across border-zone cities. Grouped by municipality so you can compare before you cross.`,
      methodology: `Italian station prices come from the MIMIT "Osservaprezzi Carburanti" portal (Italian Ministry of Enterprises), updated daily by station operators. Our pipeline filters stations across 15 border-zone municipalities, deduplicates by station id, and publishes one dedicated page per station. Petrol (Benzina) has the most complete coverage; for Italian diesel (Gasolio) we publish the stations that report a Gasolio price in the day's MIMIT feed.`,
      frontaliereContext: `If you live in Italy and work in Ticino, deciding whether to fill up before crossing or after depends on the daily CHF/EUR spread. Swiss ${lower} historically costs more per litre nominally, but with a strong franc and Italian prices tracking the EU average, the spread has tightened. This index lays out every border-city option: stations near the Como Centro toll, self-service pumps in Lavena Ponte Tresa that many commuters use on the evening leg, and everything in between.`,
    };
    if (locale === 'de') return {
      // ≤66 chars incl. "— Seite N" (tests/seo/fuel-title-budget.test.ts).
      title: `Alle italienischen ${lower}-Tankstellen im Grenzgebiet — Index`,
      description: `Index der italienischen ${lower}-Tankstellen in Grenzstädten (Como, Varese, Luino, Lavena Ponte Tresa…). Tägliche MIMIT-Daten.`,
      h1: `Italienische ${lower}-Tankstellen am Grenzgebiet — Index`,
      lede: `Durchsuche jede italienische ${lower}-Tankstelle, die wir in den Grenzstädten erfassen. Nach Gemeinde gruppiert, damit du vor dem Übergang vergleichen kannst.`,
      methodology: `Die italienischen Stationspreise stammen vom Portal "Osservaprezzi Carburanti" des MIMIT (italienisches Ministerium für Unternehmen), das die Betreiber täglich aktualisieren. Unsere Pipeline filtert die Stationen der 15 Grenzgemeinden, dedupliziert nach Station-ID und veröffentlicht eine eigene Seite pro Station. Benzin (Benzina) hat die umfassendste Abdeckung; für italienischen Diesel (Gasolio) veröffentlichen wir die Stationen, die im heutigen MIMIT-Feed einen Gasolio-Preis melden.`,
      frontaliereContext: `Wenn du in Italien wohnst und im Tessin arbeitest, hängt die Entscheidung, vor oder nach der Grenze zu tanken, vom täglichen CHF/EUR-Kurs ab. Schweizer ${lower} kostet pro Liter nominal mehr, aber bei starkem Franken und EU-konformen italienischen Preisen ist der Abstand kleiner geworden. Dieser Index zeigt alle Grenzstadt-Optionen auf einen Blick: von den Stationen am Mautknoten Como Centro bis zu den Self-Service-Pumpen in Lavena Ponte Tresa, die viele Pendler am Abend nutzen.`,
    };
    return {
      title: `Toutes les stations ${lower} italiennes (frontière) — index`,
      description: `Index des stations ${lower} italiennes des villes frontalières (Como, Varese, Luino, Lavena Ponte Tresa…). Données MIMIT quotidiennes.`,
      h1: `Stations ${lower} italiennes frontalières — index complet`,
      lede: `Parcourez chaque station ${lower} italienne suivie dans les villes frontalières. Groupée par commune pour comparer avant de passer la frontière.`,
      methodology: `Les prix des stations italiennes proviennent du portail "Osservaprezzi Carburanti" du MIMIT (Ministère italien des Entreprises), mis à jour quotidiennement par les exploitants. Notre pipeline filtre les stations de 15 communes frontalières, déduplique par identifiant et publie une page dédiée par station. L'essence (Benzina) a la couverture la plus complète ; pour le gazole italien (Gasolio) nous publions les stations qui indiquent un prix Gasolio dans le flux MIMIT du jour.`,
      frontaliereContext: `Si vous vivez en Italie et travaillez au Tessin, le choix de faire le plein avant ou après la frontière dépend de l'écart CHF/EUR du jour. Le ${lower} suisse coûte historiquement plus par litre nominal, mais avec un franc fort et des prix italiens alignés sur la moyenne UE, l'écart s'est réduit. Cet index présente toutes les options des villes frontalières en un coup d'œil : des stations près du péage de Como Centro aux pompes en self-service de Lavena Ponte Tresa que beaucoup de frontaliers utilisent au retour.`,
    };
  }
  // italianCities
  if (locale === 'it') return {
    title: `Prezzo ${lower} città italiane di confine — indice`,
    description: `Indice delle pagine giornaliere ${lower} per le città italiane di confine (Como, Varese, Luino, Lavena Ponte Tresa…).`,
    h1: `${fuelLabel} città italiane confine — indice giornaliero`,
    lede: `Le pagine "oggi" del prezzo ${lower} per ogni città italiana di confine. Aggiornate ogni giorno con i dati MIMIT.`,
    methodology: `Per ognuna delle 15 città italiane di confine pubblichiamo una pagina giornaliera con il prezzo medio del ${lower} dalle stazioni del comune, la classifica delle pompe più economiche e l'indicazione del prezzo svizzero più vicino. I dati provengono dal portale "Osservaprezzi Carburanti" del MIMIT, aggiornato direttamente dai gestori. La pagina della città è il punto di ingresso pratico per chi vuole una vista d'insieme prima di scegliere la singola stazione.`,
    frontaliereContext: `Per il frontaliere che torna da Lugano la sera, la scelta tra fare il pieno a Mendrisio prima del valico oppure a Como dopo cambia ogni giorno con il cambio CHF/EUR e con i listini locali. Questo indice è la mappa rapida per il lato italiano: clicca sulla città del tuo tragitto, leggi il prezzo medio di oggi e confrontalo con la zona ticinese più vicina (Como ↔ Chiasso, Varese ↔ Mendrisio, Luino ↔ Locarno). Le pagine città linkano sempre al loro indice di stazioni così puoi scendere al dettaglio quando ti serve.`,
  };
  if (locale === 'en') return {
    title: `${fuelLabel} prices in Italian border cities — index`,
    description: `Index of daily ${lower} pages for Italian border cities (Como, Varese, Luino, Lavena Ponte Tresa…). Updated every day from MIMIT.`,
    h1: `Italian border cities ${lower} — daily index`,
    lede: `The "today" ${lower}-price pages for every Italian border city we cover. Refreshed every day with MIMIT data.`,
    methodology: `For each of the 15 Italian border cities we publish a daily page with the average ${lower} price across municipal stations, the cheapest pumps ranked, and the closest Swiss price for context. Data comes from the Italian Ministry's "Osservaprezzi Carburanti" portal, updated directly by station operators. The city page is the practical entry point for an at-a-glance view before drilling into a specific station.`,
    frontaliereContext: `For a cross-border worker driving home from Lugano, the choice between filling up in Mendrisio before the crossing or in Como after shifts every day with the CHF/EUR rate and local pricing. This index is the quick map of the Italian side: click your city, read today's average, and compare it against the nearest Ticino zone (Como ↔ Chiasso, Varese ↔ Mendrisio, Luino ↔ Locarno). City pages link straight into their stations index when you need the per-pump detail.`,
  };
  if (locale === 'de') return {
    title: `${fuelLabel}-Preise italienische Grenzstädte — Index`,
    description: `Index der täglichen ${lower}-Seiten für italienische Grenzstädte (Como, Varese, Luino, Lavena Ponte Tresa…). Tägliche MIMIT-Daten.`,
    h1: `Italienische Grenzstädte ${lower} — Tagesindex`,
    lede: `Die täglichen ${lower}-Preisseiten für jede italienische Grenzstadt, die wir abdecken. Tägliche Aktualisierung mit MIMIT-Daten.`,
    methodology: `Für jede der 15 italienischen Grenzstädte veröffentlichen wir eine Tagesseite mit dem Durchschnittspreis ${lower} der städtischen Stationen, einer Rangliste der günstigsten Pumpen und dem nächstgelegenen Schweizer Preis als Kontext. Die Daten stammen vom Portal "Osservaprezzi Carburanti" des italienischen Ministeriums und werden direkt von den Betreibern gepflegt. Die Stadtseite ist der praktische Einstieg für einen schnellen Überblick, bevor du in eine einzelne Station eintauchst.`,
    frontaliereContext: `Für einen Grenzgänger, der abends von Lugano nach Hause fährt, ändert sich die Wahl zwischen Tanken in Mendrisio vor der Grenze oder in Como danach jeden Tag mit dem CHF/EUR-Kurs und den lokalen Preisen. Dieser Index ist die schnelle Karte der italienischen Seite: klicke deine Stadt an, lies den heutigen Durchschnitt und vergleiche ihn mit der nächstgelegenen Tessiner Region (Como ↔ Chiasso, Varese ↔ Mendrisio, Luino ↔ Locarno). Stadtseiten verlinken direkt in den jeweiligen Stations-Index, wenn du die Pumpen-Details brauchst.`,
  };
  return {
    title: `Prix ${lower} villes italiennes frontalières — index`,
    description: `Index des pages quotidiennes ${lower} pour les villes italiennes frontalières (Como, Varese, Luino, Lavena Ponte Tresa…). Données MIMIT quotidiennes.`,
    h1: `Villes italiennes frontalières ${lower} — index quotidien`,
    lede: `Les pages "aujourd'hui" du prix ${lower} pour chaque ville italienne frontalière. Actualisées chaque jour avec les données MIMIT.`,
    methodology: `Pour chacune des 15 villes italiennes frontalières, nous publions une page quotidienne avec le prix moyen ${frFuelOf(lower)} des stations communales, le classement des pompes les moins chères et le prix suisse le plus proche pour contexte. Les données viennent du portail "Osservaprezzi Carburanti" du Ministère italien, mis à jour directement par les exploitants. La page ville est le point d'entrée pratique pour une vue d'ensemble avant d'examiner une station précise.`,
    frontaliereContext: `Pour un frontalier qui rentre de Lugano le soir, le choix de faire le plein à Mendrisio avant le passage ou à Como après change chaque jour selon le taux CHF/EUR et les prix locaux. Cet index est la carte rapide du côté italien : cliquez sur votre ville, lisez la moyenne du jour et comparez-la à la zone tessinoise la plus proche (Como ↔ Chiasso, Varese ↔ Mendrisio, Luino ↔ Locarno). Les pages ville renvoient directement à leur index de stations quand vous avez besoin du détail par pompe.`,
  };
}

// ── HTML escaping (kept local — short helper, used everywhere) ────

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Anchor list rendering ─────────────────────────────────────────

export interface GroupedAnchors {
  readonly heading: string;
  readonly anchors: ReadonlyArray<{
    /** Absent for national rows without an approved detail URL. */
    readonly href?: string | null;
    readonly label: string;
    readonly subtitle: string;
    /** Resolved brand logo URL, or null when the entity-card should fall back to the icon. */
    readonly logoUrl?: string | null;
    /** Alt text for the logo `<img>` (typically the brand or station name). */
    readonly logoAlt?: string;
    readonly collectedAt?: string | null;
    /** Optional station payload for the interactive Swiss price map. */
    readonly mapStation?: {
      readonly id: string;
      readonly zone: FuelZone;
      readonly slug: string;
      readonly name: string;
      readonly brand: string;
      readonly address: string;
      readonly href: string;
      readonly lat: number;
      readonly lng: number;
      readonly benzinaPriceChf: number | null;
      readonly dieselPriceChf: number | null;
      readonly collectedAt: string | null;
    };
  }>;
  /** Stable id for the zone-chip jump nav and the H3 anchor target. */
  readonly slug: string;
  /** When set, FUEL_ZONE_BORDER_HINT is rendered as a 2nd line under the zone header. */
  readonly zoneKey?: FuelZone;
}

/**
 * Split a grouped anchor list into bounded pages without dropping or
 * reordering any anchor. A large city may span two pages; its heading is
 * repeated on the second page so every card retains a meaningful context.
 */
function paginateGroupedAnchors(
  groups: ReadonlyArray<GroupedAnchors>,
  pageSize: number,
): GroupedAnchors[][] {
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new Error(`fuel index page size must be a positive integer, got ${pageSize}`);
  }

  const pages: GroupedAnchors[][] = [];
  let current: GroupedAnchors[] = [];
  let remaining = pageSize;

  const flush = (): void => {
    if (current.length > 0) pages.push(current);
    current = [];
    remaining = pageSize;
  };

  for (const group of groups) {
    let offset = 0;
    while (offset < group.anchors.length) {
      const take = Math.min(remaining, group.anchors.length - offset);
      current.push({
        ...group,
        anchors: group.anchors.slice(offset, offset + take),
      });
      offset += take;
      remaining -= take;
      if (remaining === 0) flush();
    }
  }
  flush();
  return pages;
}

/**
 * Render fuel-index groups with a compact semantic list. These indexes can
 * contain dozens of city/zone groups and hundreds of links; repeating a large
 * inline-style card and decorative SVG for every row inflated HTML without
 * adding information, pushing generated pages below the existing text/HTML
 * quality floor.
 */
function renderCompactStationGroup(
  group: GroupedAnchors,
  copy: IndexCopy,
  locale: FuelDailyLocale,
  countKind: 'stations' | 'cities' = 'stations',
  startPosition = 0,
  totalItems = group.anchors.length,
): string {
  const count = group.anchors.length;
  const noun = countKind === 'cities' ? copy.citiesNoun(count) : copy.stationsNoun(count);
  const borderHint = group.zoneKey ? FUEL_ZONE_BORDER_HINT[group.zoneKey][locale] : '';
  let position = startPosition;
  const rows: string[] = [];
  for (const anchor of group.anchors) {
    const logo = anchor.logoUrl
      ? `<img src="${esc(anchor.logoUrl)}" alt="${esc(anchor.label)}" width="32" height="32" loading="lazy" decoding="async">`
      : '';
    const subtitle = anchor.subtitle
      ? `<small>${esc(anchor.subtitle)}</small>`
      : '';
    const content = `${logo}<strong>${esc(anchor.label)}</strong>${subtitle}`;
    rows.push(anchor.href
      ? `<li><a href="${esc(anchor.href)}">${content}</a></li>`
      : `<li><div class="fuel-index-compact-group__row">${content}</div></li>`);
    position += 1;
    // The position is global to the current page, not reset per canton/zone.
    // Never append an ad after the final station on that page.
    if (position < totalItems && shouldPlaceInfeedAd(position)) {
      rows.push(infeedAdListItemHtml({ spanFull: true }));
    }
  }

  return `<section class="fuel-index-compact-group" aria-labelledby="zone-${esc(group.slug)}">
    <h3 class="fuel-index-compact-group__title" id="zone-${esc(group.slug)}">${esc(group.heading)} <small class="fuel-index-compact-group__count">(${count} ${esc(noun)})</small></h3>
    ${borderHint ? `<p class="fuel-index-compact-group__hint">${esc(borderHint)}</p>` : ''}
    <ul class="fuel-index-compact-group__list">${rows.join('')}</ul>
  </section>`;
}

/** Build the locale-aware short tagline shown directly under the H1. */
function buildTagline(
  kind: FuelIndexKind,
  locale: FuelDailyLocale,
  fuel: FuelType,
  totalAnchors: number,
  totalGroups: number,
  scope: FuelIndexScope = 'ticino',
  hasOpenInventory = true,
): string {
  const fuelLabel = FUEL_TYPE_LABEL[locale][fuel].toLowerCase();
  const n = totalAnchors;
  if (locale === 'it') {
    if (kind === 'swissStations') return scope === 'national'
      ? `${n} stazioni ${fuelLabel} nello snapshot nazionale${hasOpenInventory ? ' prezzi TCS + inventario OpenStreetMap' : ''}, ${totalGroups} gruppi cantonali. Completezza non verificata.`
      : `${n} stazioni ${fuelLabel} in Ticino, ${totalGroups} zone di confine. Campione TCS.`;
    if (kind === 'italianStations') return `${n} stazioni ${fuelLabel} nelle città italiane di confine. Prezzi MIMIT aggiornati ogni giorno.`;
    return `${n} città italiane di confine seguite ogni giorno con il prezzo medio ${fuelLabel}.`;
  }
  if (locale === 'en') {
    if (kind === 'swissStations') return scope === 'national'
      ? `${n} Swiss ${fuelLabel} stations in the national snapshot${hasOpenInventory ? ' with TCS prices + OpenStreetMap inventory' : ''}, ${totalGroups} canton groups. Completeness not verified.`
      : `${n} Swiss ${fuelLabel} stations across ${totalGroups} border zones. TCS sample.`;
    if (kind === 'italianStations') return `${n} Italian ${fuelLabel} stations across the border-zone cities. MIMIT prices refreshed daily.`;
    return `${n} Italian border cities tracked daily with the average ${fuelLabel} price.`;
  }
  if (locale === 'de') {
    if (kind === 'swissStations') return scope === 'national'
      ? `${n} Schweizer ${fuelLabel}-Tankstellen im nationalen Snapshot${hasOpenInventory ? ' mit TCS-Preissnapshot + OpenStreetMap-Inventar' : ''}, ${totalGroups} Kantonsgruppen. Vollständigkeit nicht verifiziert.`
      : `${n} Schweizer ${fuelLabel}-Tankstellen in ${totalGroups} Grenzregionen. TCS-Stichprobe.`;
    if (kind === 'italianStations') return `${n} italienische ${fuelLabel}-Tankstellen in den Grenzstädten. MIMIT-Preise, täglich aktualisiert.`;
    return `${n} italienische Grenzstädte mit täglichem Durchschnittspreis für ${fuelLabel}.`;
  }
  if (kind === 'swissStations') return scope === 'national'
    ? `${n} stations ${fuelLabel} dans le snapshot national${hasOpenInventory ? ' avec les prix TCS et l’inventaire OpenStreetMap' : ''}, ${totalGroups} groupes cantonaux. Complétude non vérifiée.`
    : `${n} stations ${fuelLabel} en Suisse sur ${totalGroups} zones frontalières. Échantillon TCS.`;
  if (kind === 'italianStations') return `${n} stations italiennes ${fuelLabel} dans les villes frontalières. Prix MIMIT, mise à jour quotidienne.`;
  return `${n} villes italiennes frontalières suivies chaque jour avec le prix moyen ${frFuelOf(fuelLabel)}.`;
}

/** Render the 4 header stat tiles (totals + source + refresh frequency). */
function renderStatBar(
  kind: FuelIndexKind,
  copy: IndexCopy,
  totalAnchors: number,
  totalGroups: number,
  scope: FuelIndexScope = 'ticino',
  hasOpenInventory = true,
): string {
  const source = kind === 'swissStations'
    ? (scope === 'national' ? (hasOpenInventory ? 'TCS + OpenStreetMap' : 'TCS Benzinpreis') : 'TCS Benzinpreis')
    : 'MIMIT';
  const isCityIndex = kind === 'italianCities';
  const primaryLabel = isCityIndex ? copy.statLabels.cities : copy.statLabels.stations;
  const secondaryLabel = scope === 'national' ? copy.statLabels.nationalGroups : copy.statLabels.zones;
  const tile = (tone: string, label: string, value: string) =>
    `<div class="fuel-index-stat-tile ${tone}"><div class="s-tlbl">${esc(label)}</div><div class="s-tval">${esc(value)}</div></div>`;
  return `<div class="fuel-index-stat-grid">
    ${tile('s-tacc', primaryLabel, String(totalAnchors))}
    ${tile('s-tok', secondaryLabel, String(totalGroups))}
    ${tile('s-tbase', copy.statLabels.source, source)}
    ${tile('s-tbase', copy.statLabels.updateFreq, copy.statLabels.updateValue)}
  </div>`;
}

function renderNationalSnapshotNote(
  locale: FuelDailyLocale,
  snapshot: SwissNationalIndexSnapshot,
): string {
  const stationCount = snapshot.stationCount ?? snapshot.stations.length;
  const status = `${snapshot.provider} · ${snapshot.coverageType} · inventoryCompleteness: ${snapshot.inventoryCompleteness}`;
  const observedAt = validCollectionTime(snapshot.observedAt);
  const acquisitionNote = observedAt
    ? ` ${({
      it: `Acquisizione snapshot: ${formatCollectionDate(locale, observedAt)}`,
      en: `Snapshot collected: ${formatCollectionDate(locale, observedAt)}`,
      de: `Snapshot abgerufen: ${formatCollectionDate(locale, observedAt)}`,
      fr: `Snapshot acquis : ${formatCollectionDate(locale, observedAt)}`,
    })[locale]}.`
    : '';
  const inventoryObservedAt = validCollectionTime(snapshot.source?.inventoryObservedAt);
  const inventoryAcquisitionNote = inventoryObservedAt
    ? ` ${({
      it: `Inventario OpenStreetMap acquisito: ${formatCollectionDate(locale, inventoryObservedAt)}`,
      en: `OpenStreetMap inventory collected: ${formatCollectionDate(locale, inventoryObservedAt)}`,
      de: `OpenStreetMap-Inventar abgerufen: ${formatCollectionDate(locale, inventoryObservedAt)}`,
      fr: `Inventaire OpenStreetMap acquis : ${formatCollectionDate(locale, inventoryObservedAt)}`,
    })[locale]}.`
    : '';
  const inventoryAttribution = snapshot.source?.inventoryAttributionUrl
    ? ` <a href="${esc(snapshot.source.inventoryAttributionUrl)}" rel="noopener noreferrer" target="_blank">${esc(snapshot.source.inventoryAttribution || snapshot.source.inventoryProvider || 'OpenStreetMap contributors')}</a>${snapshot.source.inventoryLicense ? ` · ${esc(snapshot.source.inventoryLicense)}` : ''}.`
    : '';
  const text = {
    it: `Fonte: ${status}. ${stationCount} righe dello snapshot nazionale; non è un censimento completo.${acquisitionNote}${inventoryAcquisitionNote} Le stazioni senza prezzo per questo carburante restano visibili come non disponibili.${inventoryAttribution}`,
    en: `Source: ${status}. ${stationCount} rows from the national snapshot; this is not a complete census.${acquisitionNote}${inventoryAcquisitionNote} Stations without this fuel price remain visible as unavailable.${inventoryAttribution}`,
    de: `Quelle: ${status}. ${stationCount} Zeilen aus dem nationalen Snapshot; dies ist keine vollständige Erhebung.${acquisitionNote}${inventoryAcquisitionNote} Tankstellen ohne diesen Kraftstoffpreis bleiben als nicht verfügbar sichtbar.${inventoryAttribution}`,
    fr: `Source : ${status}. ${stationCount} lignes du snapshot national ; il ne s’agit pas d’un recensement complet.${acquisitionNote}${inventoryAcquisitionNote} Les stations sans prix pour ce carburant restent visibles comme indisponibles.${inventoryAttribution}`,
  }[locale];
  const attributionHtml = snapshot.source?.inventoryAttributionUrl ? inventoryAttribution : '';
  const cleanText = attributionHtml ? text.replace(inventoryAttribution, '') : text;
  return `<aside class="fuel-index-source-note" data-fuel-national-source data-inventory-completeness="${esc(snapshot.inventoryCompleteness)}" aria-label="${esc(status)}"><strong>${esc(cleanText)}</strong>${attributionHtml}</aside>`;
}

/** Render the "Consiglio frontaliere" advice banner (always present). */
function renderAdviceBanner(copy: IndexCopy, kind: FuelIndexKind, fuelLabel: string): string {
  const body = copy.advice.bodyByKind(kind, fuelLabel);
  return `<aside class="fuel-index-advice" aria-label="${esc(copy.advice.label)}">
    <span class="fuel-index-advice__icon" aria-hidden="true">${ICON_NAVIGATION_SVG}</span>
    <div>
      <span class="fuel-index-advice__label">${esc(copy.advice.label)}</span>
      <p class="fuel-index-advice__body">${esc(body)}</p>
    </div>
  </aside>`;
}

/** Render the primary CTA row (link to the matching daily-hub page). */
function renderCtaRow(href: string, label: string): string {
  return `<div class="fuel-index-cta-row"><a href="${esc(href)}" class="s-cta">${esc(label)} →</a></div>`;
}

/** Render the horizontally-scrollable zone-chip quick-jump nav. */
function renderZoneNav(
  groups: ReadonlyArray<GroupedAnchors>,
  copy: IndexCopy,
  label = copy.jumpNavLabel,
): string {
  if (groups.length < 2 || groups.length > 8) return '';
  const chips = groups
    .map((g) =>
      `<a class="fuel-index-zone-chip" href="#zone-${esc(g.slug)}">${esc(g.heading)}<span class="fuel-index-zone-chip__count">${g.anchors.length}</span></a>`,
    )
    .join('');
  return `<nav class="fuel-index-zone-nav" aria-label="${esc(label)}">${chips}</nav>`;
}

function paginationCopy(locale: FuelDailyLocale): {
  readonly nav: string;
  readonly page: string;
} {
  if (locale === 'it') return { nav: 'Paginazione indice', page: 'Pagina' };
  if (locale === 'en') return { nav: 'Index pagination', page: 'Page' };
  if (locale === 'de') return { nav: 'Index-Seitennavigation', page: 'Seite' };
  return { nav: 'Pagination de l’index', page: 'Page' };
}

function paginationItems(page: number, totalPages: number): Array<number | 'ellipsis'> {
  if (totalPages <= 8) return Array.from({ length: totalPages }, (_, index) => index + 1);

  const candidates = new Set([1, totalPages, page - 1, page, page + 1]);
  const numbers = [...candidates]
    .filter((value) => value >= 1 && value <= totalPages)
    .sort((a, b) => a - b);
  const items: Array<number | 'ellipsis'> = [];
  for (const value of numbers) {
    const previous = items[items.length - 1];
    if (typeof previous === 'number' && value - previous > 1) items.push('ellipsis');
    items.push(value);
  }
  return items;
}

function renderIndexPagination(
  locale: FuelDailyLocale,
  page: number,
  totalPages: number,
  pagePathFor: (page: number) => string,
): string {
  if (totalPages <= 1) return '';
  const copy = paginationCopy(locale);
  const items = paginationItems(page, totalPages);
  const links = items
    .map((item) => {
      if (item === 'ellipsis') return '<span class="fuel-index-pagination__ellipsis" aria-hidden="true">…</span>';
      const rel = item === page - 1 ? ' rel="prev"' : item === page + 1 ? ' rel="next"' : '';
      const current = item === page ? ' aria-current="page"' : '';
      return `<a class="fuel-index-pagination__link" href="${esc(pagePathFor(item))}" aria-label="${esc(`${copy.page} ${item}`)}"${current}${rel}>${item}</a>`;
    })
    .join('');
  return `<nav class="fuel-index-pagination" aria-label="${esc(copy.nav)}">${links}</nav>`;
}

function pageSuffix(locale: FuelDailyLocale, page: number): string {
  if (locale === 'it') return `pagina ${page}`;
  if (locale === 'en') return `page ${page}`;
  if (locale === 'de') return `Seite ${page}`;
  return `page ${page}`;
}

/**
 * The emitted `<title>` of one index page. Page 1 uses the copy title; page
 * N keeps the keyword prefix (text before " — ") plus "— <page N>". The
 * renderer and `tests/seo/fuel-title-budget.test.ts` both call this, so the
 * budget test measures the exact rule the generator applies.
 */
export function indexTitleFor(
  kind: FuelIndexKind,
  locale: FuelDailyLocale,
  fuel: FuelType,
  page: number,
  scope: FuelIndexScope = 'ticino',
  hasOpenInventory = true,
): string {
  const { title } = titleFor(kind, locale, fuel, scope, hasOpenInventory);
  const titleBase = page > 1
    ? `${title.split(' — ')[0]} — ${pageSuffix(locale, page)}`
    : title;
  return clampSiteSuffix(titleBase, 'Frontaliere Ticino', 60);
}

interface FuelMapCopy {
  readonly title: string;
  readonly description: string;
  readonly noScript: string;
  readonly updatedLabel: string;
  readonly stationNoun: (count: number) => string;
}

const FUEL_MAP_COPY: Record<FuelDailyLocale, FuelMapCopy> = {
  it: {
    title: 'Mappa prezzi carburante in Ticino',
    description: 'Stazioni del campione TCS sulla mappa. Controlla la data di acquisizione e verifica il prezzo alla pompa.',
    noScript: 'La mappa interattiva richiede JavaScript. L’elenco completo delle stazioni e dei relativi link resta disponibile qui sotto.',
    updatedLabel: 'Acquisizione dati',
    stationNoun: (count) => (count === 1 ? 'stazione mappata' : 'stazioni mappate'),
  },
  en: {
    title: 'Ticino fuel-price map',
    description: 'Stations from the TCS sample on one map. Check the collection date and confirm the price at the pump.',
    noScript: 'The interactive map requires JavaScript. The complete station list and its detail links remain available below.',
    updatedLabel: 'Data collection',
    stationNoun: (count) => (count === 1 ? 'station mapped' : 'stations mapped'),
  },
  de: {
    title: 'Karte der Treibstoffpreise im Tessin',
    description: 'Tankstellen der TCS-Stichprobe auf einer Karte. Prüfen Sie die Abrufzeit und den Preis an der Zapfsäule.',
    noScript: 'Die interaktive Karte benötigt JavaScript. Die vollständige Tankstellenliste und ihre Detailseiten bleiben unten verfügbar.',
    updatedLabel: 'Datenabruf',
    stationNoun: (count) => (count === 1 ? 'Tankstelle auf der Karte' : 'Tankstellen auf der Karte'),
  },
  fr: {
    title: 'Carte des prix du carburant au Tessin',
    description: 'Stations de l’échantillon TCS sur une carte. Vérifiez la date d’acquisition et le prix à la pompe.',
    noScript: 'La carte interactive nécessite JavaScript. La liste complète des stations et leurs pages de détail restent disponibles ci-dessous.',
    updatedLabel: 'Acquisition des données',
    stationNoun: (count) => (count === 1 ? 'station cartographiée' : 'stations cartographiées'),
  },
};

/**
 * Static mount point for the client map. The heading and no-JS note are real
 * HTML so crawlers and users with JavaScript disabled still get a useful
 * section; App.tsx portals the interactive map into the empty mount point.
 */
function validCollectionTime(value: string | null | undefined): string | null {
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}

function lastCompleteCollection(values: ReadonlyArray<string | null | undefined>): string | null {
  const dates = values.map(validCollectionTime);
  if (dates.length === 0 || dates.some((value) => value === null)) return null;
  return new Date(Math.max(...dates.map((value) => Date.parse(value!)))).toISOString();
}

function collectionLabel(locale: FuelDailyLocale, timestamp: string | null): string {
  if (!timestamp) return ({ it: 'Data di acquisizione non disponibile', en: 'Collection time unavailable', de: 'Abrufzeit nicht verfügbar', fr: 'Date d’acquisition indisponible' })[locale];
  const date = formatCollectionDate(locale, timestamp);
  return `${({ it: 'Ultima acquisizione nel campione', en: 'Latest collection in the sample', de: 'Letzter Abruf in der Stichprobe', fr: 'Dernière acquisition dans l’échantillon' })[locale]}: ${date}`;
}

function formatCollectionDate(locale: FuelDailyLocale, timestamp: string): string {
  return new Intl.DateTimeFormat(`${locale}-CH`, {
    timeZone: 'Europe/Zurich',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(timestamp));
}

function stationPriceSummary(
  locale: FuelDailyLocale,
  priceChf: number,
  collectedAt: string | null,
): string {
  const amount = new Intl.NumberFormat(`${locale}-CH`, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 3,
  }).format(priceChf);
  const priceLabel = ({ it: 'Prezzo', en: 'Price', de: 'Preis', fr: 'Prix' })[locale];
  if (!collectedAt) return `${priceLabel} ${amount} CHF/l`;

  const observedAt = new Intl.DateTimeFormat(`${locale}-CH`, {
    timeZone: 'Europe/Zurich',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(collectedAt));
  const observedLabel = ({ it: 'rilevato', en: 'checked', de: 'abgerufen', fr: 'relevé' })[locale];
  return `${priceLabel} ${amount} CHF/l · ${observedLabel} ${observedAt}`;
}

function priceUnavailableLabel(locale: FuelDailyLocale): string {
  return ({
    it: 'Prezzo non disponibile per questo carburante',
    en: 'Price unavailable for this fuel',
    de: 'Preis für diesen Kraftstoff nicht verfügbar',
    fr: 'Prix indisponible pour ce carburant',
  })[locale];
}

function renderFuelMapSection(
  locale: FuelDailyLocale,
  fuel: FuelType,
  collectedAt: string | null,
  stations: ReadonlyArray<NonNullable<GroupedAnchors['anchors'][number]['mapStation']>>,
): string {
  const mappedStations = stations.filter((station) => {
    const price = fuel === 'benzina' ? station.benzinaPriceChf : station.dieselPriceChf;
    return typeof price === 'number' && Number.isFinite(price) && price > 0;
  });
  if (mappedStations.length === 0) return '';
  const copy = FUEL_MAP_COPY[locale];
  const payload = inlineScriptJson({
    locale,
    fuel,
    updatedAt: collectedAt,
    stations: mappedStations,
  });
  const stationCount = `${mappedStations.length} ${copy.stationNoun(mappedStations.length)}`;
  return `<section class="fuel-map-section" aria-labelledby="fuel-map-title" data-fuel-map-section>
    <div class="fuel-map-ssr-header">
      <div>
        <h2 id="fuel-map-title" class="fuel-map-ssr-title">${esc(copy.title)}</h2>
        <p class="fuel-map-ssr-description">${esc(copy.description)}</p>
      </div>
      <div class="fuel-map-ssr-meta" aria-label="${esc(stationCount)}">
        <strong>${mappedStations.length}</strong>
        <span>${esc(copy.stationNoun(mappedStations.length))}</span>
        ${collectedAt ? `<time dateTime="${esc(collectedAt)}">${esc(collectionLabel(locale, collectedAt))}</time>` : `<span>${esc(collectionLabel(locale, null))}</span>`}
      </div>
    </div>
    <div id="fuel-station-map-root" class="fuel-map-mount" data-fuel-map-root></div>
    <script id="fuel-station-map-data" type="application/json">${payload}</script>
    <noscript><p class="fuel-map-noscript">${esc(copy.noScript)}</p></noscript>
   </section>`;
}

// ── Page assembly ─────────────────────────────────────────────────

interface RenderIndexOpts {
  readonly locale: FuelDailyLocale;
  readonly fuel: FuelType;
  readonly kind: FuelIndexKind;
  readonly canonicalPath: string;
  readonly alternates: Record<FuelDailyLocale, string>;
  readonly groups: ReadonlyArray<GroupedAnchors>;
  readonly today: Date;
  readonly distDir?: string;
  /** Cross-links to the other 2 indexes + the daily hub. */
  readonly relatedLinks: ReadonlyArray<{ readonly href: string; readonly label: string }>;
  readonly nationalSnapshot?: SwissNationalIndexSnapshot;
  readonly page: number;
  readonly totalPages: number;
  readonly pagePathFor: (page: number) => string;
}

function renderIndexPage(opts: RenderIndexOpts): string {
  const {
    locale,
    fuel,
    kind,
    canonicalPath,
    alternates,
    groups,
    distDir,
    relatedLinks,
    nationalSnapshot,
    page,
    totalPages,
    pagePathFor,
  } = opts;
  const copy = COPY[locale];
  const scope: FuelIndexScope = kind === 'swissStations' && nationalSnapshot ? 'national' : 'ticino';
  const hasOpenInventory = Boolean(
    nationalSnapshot?.source?.inventoryProvider
      || nationalSnapshot?.coverageType === 'registry-plus-price-snapshot',
  );
  const titles = titleFor(kind, locale, fuel, scope, hasOpenInventory);
  const pageTitleSuffix = page > 1 ? pageSuffix(locale, page) : '';
  const pageH1 = pageTitleSuffix ? `${titles.h1} — ${pageTitleSuffix}` : titles.h1;
  // Keep the page number in the SERP title while retaining the most useful
  // keyword prefix inside the 66-character title budget.
  const title = indexTitleFor(kind, locale, fuel, page, scope, hasOpenInventory);
  const fuelLabel = FUEL_TYPE_LABEL[locale][fuel];
  const collectedAt = scope === 'national'
    ? validCollectionTime(nationalSnapshot?.observedAt) ?? lastCompleteCollection(groups.flatMap((group) => group.anchors.map((anchor) => anchor.collectedAt)))
    : lastCompleteCollection(groups.flatMap((group) => group.anchors.map((anchor) => anchor.collectedAt)));
  const canonicalUrl = `${BASE_URL}${canonicalPath}`;

  const totalAnchors = groups.reduce((acc, g) => acc + g.anchors.length, 0);
  const totalGroups = groups.filter((g) => g.anchors.length > 0).length;

  const mapStations = kind === 'swissStations' && scope !== 'national'
    ? groups.flatMap((group) => group.anchors.flatMap((anchor) => anchor.mapStation ? [anchor.mapStation] : []))
    : [];

  // Browse blocks (the load-bearing internal-link section — these anchors are
  // what BFS from the homepage follows to reach the per-station / per-city
  // leaves and lift them out of the orphans bucket).
  let groupStartPosition = 0;
  const groupsHtml =
    totalAnchors > 0
      ? groups.map((g) => {
        const html = renderCompactStationGroup(
          g,
          copy,
          locale,
          kind === 'italianCities' ? 'cities' : 'stations',
          groupStartPosition,
          totalAnchors,
        );
        groupStartPosition += g.anchors.length;
        return html;
      }).join('')
      : `<p class="s-2n4DG5">${esc(locale === 'it' ? 'Nessuna stazione monitorata oggi.' : locale === 'de' ? 'Heute keine Stationen erfasst.' : locale === 'fr' ? 'Aucune station suivie aujourd\'hui.' : 'No stations tracked today.')}</p>`;

  // Cross-links to sibling indexes + daily hub.
  const relatedHtml = relatedLinks.length > 0
    ? `<aside class="s-card fuel-index-related"><h2 class="fuel-index-related__title">${esc(copy.relatedHeading)}</h2><ul class="s-UdsQkK">${relatedLinks
        .map(
          (rl) => `<li class="s-q3nqK4"><a class="fuel-index-related__link" href="${esc(rl.href)}">${esc(rl.label)} →</a></li>`,
        )
        .join('')}</ul></aside>`
    : '';

  // Hreflang.
  const alternatesHtml = renderHreflangTags(alternates);
  const prevNextHtml = [
    page > 1 ? `<link rel="prev" href="${BASE_URL}${pagePathFor(page - 1)}">` : '',
    page < totalPages ? `<link rel="next" href="${BASE_URL}${pagePathFor(page + 1)}">` : '',
  ].filter(Boolean).join('\n');

  // BreadcrumbList JSON-LD.
  const breadcrumbLd = inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: copy.breadcrumbHome, item: `${BASE_URL}/` },
      {
        '@type': 'ListItem',
        position: 2,
        name: fuelLabel,
        item: `${BASE_URL}${buildFuelTodayPath(locale, fuel)}`,
      },
      { '@type': 'ListItem', position: 3, name: pageH1, item: canonicalUrl },
    ],
  });

  // CollectionPage + mainEntity ItemList — gives Google a structured view
  // of every station/city the page links to. Position is global (1..N)
  // across all groups so the list reads top-to-bottom on the rendered page.
  //
  // Cap at 50 to keep the inline JSON-LD ≤ ~10 KB. With 400+ Italian stations
  // the un-capped list inflates the inline payload past the shared
  // `audit:page-weight` budget. Mirrors the PR #183 cap on the master jobs
  // hub. The visible anchors below ARE the full set — only the structured
  // ItemList is sampled.
  const ITEM_LIST_CAP = 50;
  const flatListItems: Array<{ name: string; href?: string | null }> = [];
  for (const g of groups) {
    for (const a of g.anchors) flatListItems.push({ name: a.label, href: a.href });
  }
  const itemListElements = flatListItems.slice(0, ITEM_LIST_CAP).map((item, i) => ({
    '@type': 'ListItem',
    position: i + 1,
    name: item.name,
    ...(item.href ? { url: `${BASE_URL}${item.href}` } : {}),
  }));

  const webPageLd = inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: pageH1,
    url: canonicalUrl,
    description: titles.description,
    inLanguage: locale,
    ...(collectedAt ? { dateModified: collectedAt } : {}),
    isPartOf: {
      '@type': 'WebSite',
      url: `${BASE_URL}/`,
      name: 'Frontaliere Ticino',
    },
    mainEntity: {
      '@type': 'ItemList',
      name: pageH1,
      numberOfItems: flatListItems.length,
      itemListOrder: 'https://schema.org/ItemListOrderAscending',
      itemListElement: itemListElements,
    },
  });

  // Pre-cut removed: clampMetaDescription (150) runs downstream and is
  // word-aware. Slicing first only handed it a string already broken
  // mid-word, which is what reached the SERP snippet.
  const description = titles.description;

  // Header is intentionally short (eyebrow + H1 + ≤140-char tagline); the
  // long methodology + frontaliere-context prose moves to the BOTTOM of the
  // page per CLAUDE.md rules #16/#17 (SEO filler must never push real
  // content below the mobile fold).
  const tagline = buildTagline(kind, locale, fuel, totalAnchors, totalGroups, scope, hasOpenInventory);
  const statBar = renderStatBar(kind, copy, totalAnchors, totalGroups, scope, hasOpenInventory);
  const nationalSourceNote = scope === 'national' && nationalSnapshot
    ? renderNationalSnapshotNote(locale, nationalSnapshot)
    : '';
  const advice = totalAnchors > 0 ? renderAdviceBanner(copy, kind, fuelLabel) : '';
  const ctaHref = buildFuelTodayPath(locale, fuel);
  const ctaRow = renderCtaRow(ctaHref, copy.ctaDailyHub(fuelLabel));
  const zoneNav = totalAnchors > 0 ? renderZoneNav(
    groups,
    copy,
    scope === 'national' ? copy.nationalJumpNavLabel : copy.jumpNavLabel,
  ) : '';
  const pagination = renderIndexPagination(locale, page, totalPages, pagePathFor);
  // The national index intentionally has no map until its map payload covers
  // the full provider snapshot. A Ticino-only map would make the national
  // page look incomplete while the list below is national.
  const fuelMap = scope === 'national'
    ? ''
    : renderFuelMapSection(locale, fuel, lastCompleteCollection(mapStations.map((station) => station.collectedAt)), mapStations);

  const proseBlock = `<section class="fuel-index-methodology" aria-label="${esc(copy.methodologyHeading)}">
    <h2 class="fuel-index-methodology__heading">${esc(copy.methodologyHeading)}</h2>
    <p class="fuel-index-methodology__body">${esc(titles.methodology)}</p>
    <h2 class="fuel-index-methodology__heading">${esc(copy.frontaliereHeading)}</h2>
    <p class="fuel-index-methodology__body fuel-index-methodology__body--last">${esc(titles.frontaliereContext)}</p>
  </section>`;

  const bodyHtml = `<article class="s-xzWvwM">
  <nav class="s-bcr">
    <a href="/" class="s-bcl">${esc(copy.breadcrumbHome)}</a>
    <span> / </span>
    <a href="${buildFuelTodayPath(locale, fuel)}" class="s-bcl">${esc(fuelLabel)}</a>
    <span> / </span>
    <span>${esc(pageH1)}</span>
  </nav>
  <header class="s-S1RSUf">
    <p class="s-eyb">${esc(collectionLabel(locale, collectedAt))}</p>
    <h1 class="s-h1">${esc(pageH1)}</h1>
    <p class="fuel-index-tagline">${esc(tagline)}</p>
  </header>
  ${nationalSourceNote}
  ${statBar}
  ${advice}
  ${ctaRow}
  ${pagination}
  ${fuelMap}
  ${zoneNav}
  <section aria-labelledby="browseAll">
    <h2 id="browseAll" class="fuel-index-browse-title">${esc(scope === 'national' ? copy.nationalBrowseHeading : copy.browseHeading)}</h2>
    ${groupsHtml}
  </section>
  ${relatedHtml}
  ${proseBlock}
</article>`;

  return buildSeoPageHtml({
    locale,
    title,
    description,
    canonicalUrl,
    // P1 noindex plan (paginationIndexPolicy): page 11+ stays 200 + linked, leaves the index.
    robots: paginationRobots(page),
    ogType: 'website',
    hreflangHtml: alternatesHtml,
    extraHeadHtml: prevNextHtml,
    jsonLdScripts: [breadcrumbLd, webPageLd],
    bodyHtml,
    distDir,
    hubChrome: { hubKey: 'stats', activeSubTab: 'fuel-prices' },
  });
}

// ── Public generators ─────────────────────────────────────────────

/** Group Swiss-station leaves by zone, preserving FUEL_ZONES order. */
function groupSwissByZone(stations: readonly SwissStationLeaf[]): Map<FuelZone, SwissStationLeaf[]> {
  const out = new Map<FuelZone, SwissStationLeaf[]>();
  for (const z of FUEL_ZONES) out.set(z, []);
  for (const s of stations) {
    if (!s.zone) continue;
    const list = out.get(s.zone);
    if (list) list.push(s);
  }
  // Sort each zone's list by brand then street for stable output.
  for (const list of out.values()) {
    list.sort((a, b) => {
      const k = (a.brand || a.name).localeCompare(b.brand || b.name);
      if (k !== 0) return k;
      return (a.address || '').localeCompare(b.address || '');
    });
  }
  return out;
}

function nationalCantonKey(value: string | null | undefined): string {
  const normalized = String(value ?? '').trim().toUpperCase();
  return normalized || 'UNRESOLVED';
}

/** Group the unfiltered national snapshot by the resolver's canton group. */
function groupSwissByCanton(stations: readonly SwissStationLeaf[]): Map<string, SwissStationLeaf[]> {
  const out = new Map<string, SwissStationLeaf[]>();
  for (const station of stations) {
    const canton = nationalCantonKey(station.canton);
    const list = out.get(canton) ?? [];
    list.push(station);
    out.set(canton, list);
  }
  for (const list of out.values()) {
    list.sort((a, b) => {
      const k = (a.brand || a.name).localeCompare(b.brand || b.name);
      if (k !== 0) return k;
      const addressOrder = (a.address || '').localeCompare(b.address || '');
      if (addressOrder !== 0) return addressOrder;
      return (a.name || '').localeCompare(b.name || '');
    });
  }
  return new Map(
    [...out.entries()].sort(([a], [b]) => {
      if (a === 'UNRESOLVED') return 1;
      if (b === 'UNRESOLVED') return -1;
      return a.localeCompare(b);
    }),
  );
}

function nationalCantonSlug(canton: string): string {
  return `canton-${canton.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}

/**
 * Group Italian-station leaves by city slug. Leaf-driven (covers every
 * municipality present in the leaves, not just the curated list), cities
 * ordered alphabetically by display name for a stable index.
 */
function groupItalianByCity(stations: readonly ItalianStationLeaf[]): Map<string, ItalianStationLeaf[]> {
  const out = new Map<string, ItalianStationLeaf[]>();
  const displayBySlug = new Map<string, string>();
  for (const s of stations) {
    if (!out.has(s.citySlug)) out.set(s.citySlug, []);
    out.get(s.citySlug)!.push(s);
    displayBySlug.set(s.citySlug, s.cityDisplay);
  }
  for (const list of out.values()) {
    list.sort((a, b) => {
      const k = (a.brand || a.name).localeCompare(b.brand || b.name);
      if (k !== 0) return k;
      return (a.address || '').localeCompare(b.address || '');
    });
  }
  return new Map(
    [...out.entries()].sort((a, b) =>
      (displayBySlug.get(a[0]) || a[0]).localeCompare(displayBySlug.get(b[0]) || b[0]),
    ),
  );
}

/**
 * Generate the 3 indexes × locale × fuel.
 *
 * Returns Record<canonicalPath, html> ready to be written to dist/.
 */
export function generateFuelIndexPages(inp: FuelIndexInputs): Record<string, string> {
  const { swissStations, italianStations, italianStationsByFuel, today, distDir, rootDir } = inp;
  const italianCities = inp.italianCities ?? FUEL_ITALIAN_CITIES;
  // Anchor gate: link only pages the build actually emitted (post word-gate).
  const isEmitted = (href: string): boolean => !inp.emittedPaths || inp.emittedPaths.has(href);
  const out: Record<string, string> = {};

  const swissByZone = groupSwissByZone(swissStations);

  for (const fuel of FUEL_TYPES) {
    // Per-fuel Italian leaves: prefer the explicit map; fall back to the legacy
    // benzina-only `italianStations` so existing callers keep working.
    const italianLeavesForFuel: readonly ItalianStationLeaf[] =
      italianStationsByFuel?.[fuel] ?? (fuel === 'benzina' ? italianStations : []);
    const italianByCity = groupItalianByCity(italianLeavesForFuel);
    const hasItalianStationIndex = italianLeavesForFuel.length > 0;

    for (const locale of FUEL_DAILY_LOCALES) {
      const copy = COPY[locale];

      // Common alternates+related-links computation per kind.
      const buildAlternates = (kind: FuelIndexKind, page = 1): Record<FuelDailyLocale, string> => {
        const alts: Record<FuelDailyLocale, string> = { it: '', en: '', de: '', fr: '' };
        for (const alt of FUEL_DAILY_LOCALES) {
          alts[alt] = buildFuelIndexPaginationPath(alt, fuel, kind, page);
        }
        return alts;
      };

      const buildRelated = (kind: FuelIndexKind): Array<{ href: string; label: string }> => {
        const links: Array<{ href: string; label: string }> = [];
        const dailyHubHref = buildFuelTodayPath(locale, fuel);
        if (kind !== 'swissStations') {
          links.push({
            href: buildFuelIndexPath(locale, fuel, 'swissStations'),
            label: copy.relatedLinkLabels.swissStations,
          });
        }
        // IT-stations index exists per-fuel only when that fuel has station
        // coverage; only cross-link when the index is actually emitted.
        if (kind !== 'italianStations' && hasItalianStationIndex) {
          links.push({
            href: buildFuelIndexPath(locale, fuel, 'italianStations'),
            label: copy.relatedLinkLabels.italianStations,
          });
        }
        if (kind !== 'italianCities') {
          links.push({
            href: buildFuelIndexPath(locale, fuel, 'italianCities'),
            label: copy.relatedLinkLabels.italianCities,
          });
        }
        links.push({ href: dailyHubHref, label: copy.relatedLinkLabels.dailyHub });
        return links;
      };

      // ── Swiss-stations index ───────────────────────────────────
      {
        const isNational = Boolean(inp.swissNationalSnapshot);
        const sourceStations = isNational
          ? (inp.swissNationalSnapshot?.stations ?? [])
          : swissStations;
        const groupedSource = isNational
          ? groupSwissByCanton(sourceStations)
          : swissByZone;
        const groups: GroupedAnchors[] = [];

        for (const [groupKey, rawList] of groupedSource) {
          const list = isNational
            ? rawList
            : rawList.filter((station) => {
              const price = fuel === 'benzina' ? station.benzinaPriceChf : station.dieselPriceChf;
              return typeof price === 'number' && Number.isFinite(price) && price > 0;
            });
          if (list.length === 0) continue;

          const anchors = list.map((s) => {
            const collectedAt = validCollectionTime(fuel === 'diesel'
              ? s.dieselUpdatedAt ?? s.updatedAt ?? s.observedAt
              : s.updatedAt ?? s.observedAt);
            const price = fuel === 'benzina' ? s.benzinaPriceChf : s.dieselPriceChf;
            const candidateHref = s.zone && s.slug
              ? buildFuelStationPath(locale, fuel, s.zone, s.slug)
              : null;
            // A routeable row gets a link only when its detail page was
            // actually emitted. National rows outside Ticino intentionally
            // remain data-only: no speculative URL is created.
            const href = candidateHref && isEmitted(candidateHref) ? candidateHref : null;
            const subtitle = [
              s.address,
              typeof price === 'number' && Number.isFinite(price) && price > 0
                ? stationPriceSummary(locale, price, collectedAt)
                : priceUnavailableLabel(locale),
            ].filter(Boolean).join(' · ');
            const anchor = {
              ...(href ? { href } : {}),
              label: s.brand ? `${s.brand}${s.name && s.name !== s.brand ? ` — ${s.name}` : ''}` : s.name,
              subtitle,
              logoUrl: resolveStationBrandLogoUrl(rootDir, s.brand),
              logoAlt: s.brand || s.name,
              collectedAt,
            };

            if (
              href && s.zone && s.slug
              && typeof s.lat === 'number' && Number.isFinite(s.lat)
              && typeof s.lng === 'number' && Number.isFinite(s.lng)
            ) {
              return {
                ...anchor,
                mapStation: {
                  id: `${s.zone}-${s.slug}`,
                  zone: s.zone,
                  slug: s.slug,
                  name: s.name,
                  brand: s.brand,
                  address: s.address,
                  href,
                  lat: s.lat,
                  lng: s.lng,
                  benzinaPriceChf: typeof s.benzinaPriceChf === 'number' && Number.isFinite(s.benzinaPriceChf) ? s.benzinaPriceChf : null,
                  collectedAt,
                  dieselPriceChf: typeof s.dieselPriceChf === 'number' && Number.isFinite(s.dieselPriceChf) ? s.dieselPriceChf : null,
                },
              };
            }
            return anchor;
          });

          groups.push({
            heading: isNational
              ? copy.groupHeadingByCanton(groupKey)
              : copy.groupHeadingByZone(FUEL_ZONE_DISPLAY[groupKey as FuelZone]),
            slug: isNational ? nationalCantonSlug(groupKey) : groupKey,
            ...(isNational ? {} : { zoneKey: groupKey as FuelZone }),
            anchors,
          });
        }

        const pages = isNational
          ? paginateGroupedAnchors(groups, SWISS_STATIONS_INDEX_PAGE_SIZE)
          : [groups];
        const totalPages = Math.max(1, pages.length);
        const pagePathFor = (page: number): string =>
          buildFuelIndexPaginationPath(locale, fuel, 'swissStations', page);
        for (let page = 1; page <= totalPages; page++) {
          const canonicalPath = pagePathFor(page);
          out[canonicalPath] = renderIndexPage({
            locale,
            fuel,
            kind: 'swissStations',
            canonicalPath,
            alternates: buildAlternates('swissStations', page),
            groups: pages[page - 1] ?? [],
            today,
            distDir,
            relatedLinks: buildRelated('swissStations'),
            nationalSnapshot: isNational ? inp.swissNationalSnapshot : undefined,
            page,
            totalPages,
            pagePathFor,
          });
        }
      }

      // ── Italian-cities index ───────────────────────────────────
      {
        const cityGroups: GroupedAnchors[] = [];
        // Group by nearest Ticino zone — keeps the page semantically organised
        // (the city-zone mapping is geographic, not arbitrary).
        const byZone = new Map<FuelZone, ItalianCityEntry[]>();
        for (const z of FUEL_ZONES) byZone.set(z, []);
        // Leaf-driven (same as the swiss-stations and italian-stations indexes):
        // only link a city-hub that actually has an emitted station leaf for THIS
        // fuel. Iterating the raw entry list would link diesel hubs that don't
        // exist (most comuni have no diesel-priced station) and any hub the
        // word-gate skipped → indexed 404s on a crawlable sitemap page.
        for (const c of italianCities) {
          if (!italianByCity.has(c.slug)) continue;
          const arr = byZone.get(c.nearestZone);
          if (arr) arr.push(c);
        }
        for (const arr of byZone.values()) arr.sort((a, b) => a.display.localeCompare(b.display));
        for (const z of FUEL_ZONES) {
          const cities = byZone.get(z) ?? [];
          if (cities.length === 0) continue;
          const anchors = cities
            .map((c) => ({
              href: buildFuelItalianCityPath(locale, fuel, c.slug),
              label: c.display,
              subtitle: `${c.province} · ${FUEL_ZONE_DISPLAY[z]}`,
            }))
            .filter((a) => isEmitted(a.href));
          if (anchors.length === 0) continue;
          cityGroups.push({
            heading: copy.groupHeadingNearZone(FUEL_ZONE_DISPLAY[z]),
            slug: z,
            zoneKey: z,
            anchors,
          });
        }
        const canonicalPath = buildFuelIndexPath(locale, fuel, 'italianCities');
        out[canonicalPath] = renderIndexPage({
          locale,
          fuel,
          kind: 'italianCities',
          canonicalPath,
          alternates: buildAlternates('italianCities'),
          groups: cityGroups,
          today,
          distDir,
          relatedLinks: buildRelated('italianCities'),
          page: 1,
          totalPages: 1,
          pagePathFor: (page) => buildFuelIndexPaginationPath(locale, fuel, 'italianCities', page),
        });
      }

      // ── Italian-stations index (per-fuel, when coverage exists) ─
      if (hasItalianStationIndex) {
        const groups: GroupedAnchors[] = [];
        for (const [citySlug, list] of italianByCity) {
          if (list.length === 0) continue;
          const cityDisplay = list[0]?.cityDisplay ?? citySlug;
          const anchors = list
            .map((s) => ({
              href: buildFuelItalianStationPath(locale, fuel, s.citySlug, s.stationSlug),
              label: s.brand ? `${s.brand}${s.name && s.name !== s.brand ? ` — ${s.name}` : ''}` : s.name,
              subtitle: s.address || cityDisplay,
              logoUrl: resolveStationBrandLogoUrl(rootDir, s.brand),
              logoAlt: s.brand || s.name,
            }))
            .filter((a) => isEmitted(a.href));
          if (anchors.length === 0) continue;
          groups.push({
            heading: copy.groupHeadingByCity(cityDisplay),
            slug: citySlug,
            anchors,
          });
        }
        const pages = paginateGroupedAnchors(groups, ITALIAN_STATIONS_INDEX_PAGE_SIZE);
        const totalPages = Math.max(1, pages.length);
        const pagePathFor = (page: number): string =>
          buildFuelIndexPaginationPath(locale, fuel, 'italianStations', page);
        for (let page = 1; page <= totalPages; page++) {
          const canonicalPath = pagePathFor(page);
          out[canonicalPath] = renderIndexPage({
            locale,
            fuel,
            kind: 'italianStations',
            canonicalPath,
            alternates: buildAlternates('italianStations', page),
            groups: pages[page - 1] ?? [],
            today,
            distDir,
            relatedLinks: buildRelated('italianStations'),
            page,
            totalPages,
            pagePathFor,
          });
        }
      }
    }
  }

  return out;
}

// ── Helpers exposed for tests + plugin reuse ─────────────────────

/**
 * "See also" hub-links block appended to each daily-fuel page.
 *
 * Renders the 3 (or 2, for diesel) browseable indexes plus the matching
 * daily-hub of every sibling locale. Uses the same entity-card visual
 * language as the index pages themselves (lucide icon + label + subtitle
 * in a responsive grid) so the daily page and its hub-links read as one
 * design system instead of a stray bulleted aside.
 *
 * The output keeps every original anchor so the orphan-elimination contract
 * (tests/seo/fuel-station-orphans-eliminated.test.ts) stays green.
 */
export function renderFuelIndexHubLinks(opts: {
  readonly locale: FuelDailyLocale;
  readonly fuel: FuelType;
}): string {
  const { locale, fuel } = opts;
  const copy = COPY[locale];
  const fuelLabel = FUEL_TYPE_LABEL[locale][fuel];

  type HubItem = {
    readonly href: string;
    readonly title: string;
    readonly subtitle: string;
    readonly iconSvg: string;
  };

  const indexSubtitle = INDEX_HUB_SUBTITLE[locale];
  const localeSubtitle = LOCALE_HUB_SUBTITLE[locale];

  const items: HubItem[] = [
    {
      href: buildFuelIndexPath(locale, fuel, 'swissStations'),
      title: copy.relatedLinkLabels.swissStations,
      subtitle: indexSubtitle.swiss,
      iconSvg: ICON_FUEL_SVG,
    },
    {
      href: buildFuelIndexPath(locale, fuel, 'italianCities'),
      title: copy.relatedLinkLabels.italianCities,
      subtitle: indexSubtitle.cities,
      iconSvg: ICON_MAP_PIN_SVG,
    },
  ];
  if (fuel === 'benzina') {
    items.splice(1, 0, {
      href: buildFuelIndexPath(locale, fuel, 'italianStations'),
      title: copy.relatedLinkLabels.italianStations,
      subtitle: indexSubtitle.italian,
      iconSvg: ICON_FUEL_SVG,
    });
  }
  // Cross-locale links to sibling daily hubs (DE/FR previously orphan).
  const otherLocales = FUEL_DAILY_LOCALES.filter((l) => l !== locale);
  for (const alt of otherLocales) {
    items.push({
      href: buildFuelTodayPath(alt, fuel),
      title: `${alt.toUpperCase()} · ${labelForLocale(alt, fuel)}`,
      subtitle: localeSubtitle(alt),
      iconSvg: ICON_NAVIGATION_SVG,
    });
  }

  const cards = items
    .map((it) =>
      renderEntityCard({
        href: it.href,
        iconSvg: it.iconSvg,
        title: it.title,
        subtitle: it.subtitle,
      }),
    )
    .join('');

  const headingId = `fuelIndexHub-${fuel}`;
  return `<aside class="s-H1qo5-" aria-labelledby="${headingId}" data-fuel="${esc(fuelLabel)}">
    <h2 id="${headingId}" style="${H2_STYLE};margin:0 0 12px;font-size:18px">${esc(copy.relatedHeading)}</h2>
    <div class="s-aL88xh">${cards}</div>
  </aside>`;
}

/** Locale-aware one-line descriptors used as entity-card subtitles. */
const INDEX_HUB_SUBTITLE: Record<FuelDailyLocale, { swiss: string; italian: string; cities: string }> = {
  it: {
    swiss: 'Per zona di confine, aggiornato ogni giorno',
    italian: 'Stazioni MIMIT nelle città di confine',
    cities: 'Prezzo medio per città italiana di confine',
  },
  en: {
    swiss: 'Grouped by border zone, refreshed daily',
    italian: 'MIMIT stations in the border-zone cities',
    cities: 'Average price per Italian border city',
  },
  de: {
    swiss: 'Nach Grenzregion gruppiert, täglich aktualisiert',
    italian: 'MIMIT-Tankstellen in den Grenzstädten',
    cities: 'Durchschnittspreis pro italienischer Grenzstadt',
  },
  fr: {
    swiss: 'Groupé par zone frontalière, mise à jour quotidienne',
    italian: 'Stations MIMIT dans les villes frontalières',
    cities: 'Prix moyen par ville italienne frontalière',
  },
};

const LOCALE_HUB_SUBTITLE: Record<FuelDailyLocale, (alt: FuelDailyLocale) => string> = {
  it: (alt) => `Versione ${alt.toUpperCase()} della pagina di oggi`,
  en: (alt) => `${alt.toUpperCase()} version of today's page`,
  de: (alt) => `${alt.toUpperCase()}-Version der heutigen Seite`,
  fr: (alt) => `Version ${alt.toUpperCase()} de la page du jour`,
};

function labelForLocale(loc: FuelDailyLocale, fuel: FuelType): string {
  const fuelLabel = FUEL_TYPE_LABEL[loc][fuel];
  switch (loc) {
    case 'it':
      return `${fuelLabel} oggi`;
    case 'en':
      return `${fuelLabel} today`;
    case 'de':
      return `${fuelLabel} heute`;
    case 'fr':
      return `${fuelLabel} aujourd'hui`;
  }
}
