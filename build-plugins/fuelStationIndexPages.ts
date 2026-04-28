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
 *   /{section}/stazioni-svizzere/  — Swiss-station index (grouped by zone)
 *   /{section}/stazioni-italia/    — Italian-station index (grouped by city)
 *   /{section}/citta-italiane/     — Italian-city index (alphabetical hub)
 *
 * The IT-station dataset is benzina-only (see fuelDailyPagesPlugin.ts comment
 * at generateFuelItalianStationPages) so the IT-station index is only emitted
 * under the benzina section.
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
 * Counts (steady state):
 *   Swiss-stations: 4 locales × 2 fuels = 8 indexes
 *   IT-stations:    4 locales × 1 fuel  = 4 indexes (benzina-only)
 *   IT-cities:      4 locales × 2 fuels = 8 indexes
 *   Total:          20 indexes
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
  type FuelDailyLocale,
  type FuelType,
  type FuelZone,
  type ItalianCityEntry,
} from './fuelDailyData';
import { BASE_URL } from './constants';
import { buildSeoPageHtml } from './shared/seoPageShell';
import { renderHreflangTags } from './shared/hreflang';
import {
  BREADCRUMB_LINK_STYLE,
  BREADCRUMB_STYLE,
  CARD_STYLE,
  H1_STYLE,
  H2_STYLE,
  HERO_EYEBROW_STYLE,
  LEDE_STYLE,
  LINK_ACCENT_STYLE,
  clampSiteSuffix,
} from './shared/seoContentTokens';

// ── Types ─────────────────────────────────────────────────────────

/** One Swiss station leaf (the data the index needs to render its anchor). */
export interface SwissStationLeaf {
  readonly zone: FuelZone;
  readonly slug: string;
  readonly name: string;
  readonly brand: string;
  readonly address: string;
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
  readonly today: Date;
  readonly swissStations: readonly SwissStationLeaf[];
  readonly italianStations: readonly ItalianStationLeaf[];
}

// ── Locale-aware index slugs ──────────────────────────────────────

/** Last-segment slug per locale for the 3 index types. */
export const FUEL_INDEX_SLUG = {
  swissStations: {
    it: 'stazioni-svizzere',
    en: 'swiss-stations',
    de: 'schweizer-tankstellen',
    fr: 'stations-suisses',
  },
  italianStations: {
    it: 'stazioni-italia',
    en: 'italian-stations',
    de: 'italienische-tankstellen',
    fr: 'stations-italiennes',
  },
  italianCities: {
    it: 'citta-italiane',
    en: 'italian-cities',
    de: 'italienische-staedte',
    fr: 'villes-italiennes',
  },
} as const satisfies Record<string, Record<FuelDailyLocale, string>>;

export type FuelIndexKind = keyof typeof FUEL_INDEX_SLUG;

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

// ── Localised copy ────────────────────────────────────────────────

interface IndexCopy {
  readonly breadcrumbHome: string;
  readonly updatedLabel: string;
  readonly groupHeadingByZone: (zone: string) => string;
  readonly groupHeadingByCity: (city: string) => string;
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
}

const COPY_IT: IndexCopy = {
  breadcrumbHome: 'Home',
  updatedLabel: 'Aggiornato',
  groupHeadingByZone: (zone) => `Stazioni di ${zone}`,
  groupHeadingByCity: (city) => `Stazioni a ${city}`,
  seeStationLink: (label) => `Vedi prezzi: ${label}`,
  faqTitle: 'Domande frequenti',
  methodologyHeading: 'Come funziona questo indice',
  frontaliereHeading: 'Perché questo indice è utile per i frontalieri',
  browseHeading: 'Sfoglia tutte le pagine',
  relatedHeading: 'Vedi anche',
  relatedLinkLabels: {
    swissStations: 'Indice stazioni svizzere',
    italianStations: 'Indice stazioni italiane',
    italianCities: 'Indice città italiane',
    dailyHub: 'Prezzo carburanti oggi (Ticino)',
  },
};

const COPY_EN: IndexCopy = {
  breadcrumbHome: 'Home',
  updatedLabel: 'Updated',
  groupHeadingByZone: (zone) => `Stations in ${zone}`,
  groupHeadingByCity: (city) => `Stations in ${city}`,
  seeStationLink: (label) => `See prices: ${label}`,
  faqTitle: 'Frequently asked questions',
  methodologyHeading: 'How this index works',
  frontaliereHeading: 'Why this index helps cross-border commuters',
  browseHeading: 'Browse every page',
  relatedHeading: 'See also',
  relatedLinkLabels: {
    swissStations: 'Swiss stations index',
    italianStations: 'Italian stations index',
    italianCities: 'Italian cities index',
    dailyHub: 'Today\'s fuel price (Ticino)',
  },
};

const COPY_DE: IndexCopy = {
  breadcrumbHome: 'Startseite',
  updatedLabel: 'Aktualisiert',
  groupHeadingByZone: (zone) => `Tankstellen in ${zone}`,
  groupHeadingByCity: (city) => `Tankstellen in ${city}`,
  seeStationLink: (label) => `Preise ansehen: ${label}`,
  faqTitle: 'Häufige Fragen',
  methodologyHeading: 'So funktioniert dieser Index',
  frontaliereHeading: 'Warum dieser Index Grenzgängern hilft',
  browseHeading: 'Alle Seiten durchsuchen',
  relatedHeading: 'Siehe auch',
  relatedLinkLabels: {
    swissStations: 'Index Schweizer Tankstellen',
    italianStations: 'Index italienische Tankstellen',
    italianCities: 'Index italienische Städte',
    dailyHub: 'Spritpreis heute (Tessin)',
  },
};

const COPY_FR: IndexCopy = {
  breadcrumbHome: 'Accueil',
  updatedLabel: 'Mis à jour',
  groupHeadingByZone: (zone) => `Stations à ${zone}`,
  groupHeadingByCity: (city) => `Stations à ${city}`,
  seeStationLink: (label) => `Voir les prix : ${label}`,
  faqTitle: 'Questions fréquentes',
  methodologyHeading: 'Comment fonctionne cet index',
  frontaliereHeading: 'Pourquoi cet index aide les frontaliers',
  browseHeading: 'Parcourir toutes les pages',
  relatedHeading: 'Voir aussi',
  relatedLinkLabels: {
    swissStations: 'Index stations suisses',
    italianStations: 'Index stations italiennes',
    italianCities: 'Index villes italiennes',
    dailyHub: 'Prix du carburant aujourd\'hui (Tessin)',
  },
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

interface IndexTitleSet {
  readonly title: string;
  readonly description: string;
  readonly h1: string;
  readonly lede: string;
  readonly methodology: string;
  readonly frontaliereContext: string;
}

function titleFor(
  kind: FuelIndexKind,
  locale: FuelDailyLocale,
  fuel: FuelType,
): IndexTitleSet {
  const fuelLabel = FUEL_TYPE_LABEL[locale][fuel];
  const lower = fuelLabel.toLowerCase();
  if (kind === 'swissStations') {
    if (locale === 'it') return {
      title: `Tutte le stazioni ${lower} in Ticino — indice per zona`,
      description: `Indice completo delle stazioni di rifornimento ${lower} monitorate in Ticino, raggruppate per zona (Chiasso, Mendrisio, Lugano, Bellinzona, Locarno). Aggiornamento giornaliero.`,
      h1: `Stazioni ${lower} in Ticino — indice completo`,
      lede: `Sfoglia ogni stazione di rifornimento ${lower} che monitoriamo in Ticino, raggruppata per zona di confine. Ogni voce porta alla pagina giornaliera con prezzo aggiornato, posizione nella classifica della zona e contesto frontaliere.`,
      methodology: `I prezzi provengono da TCS Benzinpreis (Touring Club Svizzero), che aggrega i listini ufficiali delle stazioni di rifornimento in Svizzera. La nostra pipeline li mappa per zona ticinese, dedupla le voci con stesso brand e indirizzo, e pubblica una pagina dedicata per ogni stazione monitorata. L'indice qui sotto raggruppa le stazioni per zona di confine così puoi confrontare a colpo d'occhio le opzioni più vicine al tuo valico abituale. Se la stazione che cerchi non compare, è possibile che TCS non l'abbia ancora rilevata oggi: torna domani — la lista viene rigenerata ogni notte.`,
      frontaliereContext: `Per chi attraversa ogni giorno il confine Italia-Svizzera, il prezzo del ${lower} è una voce di spesa ricorrente. Confrontare le stazioni vicine al tuo valico — Chiasso, Brogeda, Gaggiolo, Stabio, Bizzarone — può far risparmiare 5-10 centesimi al litro: su un pieno da 50 litri sono 2,50-5 CHF, e su 200 pieni l'anno (lavoro 5 giorni a settimana) la differenza arriva a 500-1000 CHF. Questa pagina rende facile mappare il "tuo" set di stazioni: scegli la zona del tuo valico abituale e confronta le opzioni in base al brand, all'indirizzo e al prezzo del giorno.`,
    };
    if (locale === 'en') return {
      title: `All Swiss ${lower} stations — Ticino index`,
      description: `Complete browseable index of ${lower} stations we monitor in Ticino, grouped by border zone. Updated daily from TCS Benzinpreis.`,
      h1: `Swiss ${lower} stations — full Ticino index`,
      lede: `Browse every Swiss ${lower} station we monitor in Ticino, grouped by border zone. Each entry links to the daily page with the latest price, ranking in the zone, and cross-border commuter context.`,
      methodology: `Prices come from TCS Benzinpreis (Touring Club Suisse), which aggregates official listings from Swiss stations. Our pipeline maps each station to its Ticino border zone, deduplicates same-brand same-address entries, and publishes one dedicated page per station with daily-fresh data. The index below groups stations by zone so you can compare options near your usual border crossing at a glance. If the station you are looking for is missing, TCS may not have observed it today — the list is regenerated every night.`,
      frontaliereContext: `For Italian-resident workers crossing into Switzerland every day, the ${lower} price is a recurring expense. Comparing stations near your crossing — Chiasso, Brogeda, Gaggiolo, Stabio, Bizzarone — can save CHF 0.05-0.10 per litre: on a 50-litre tank that is CHF 2.50-5, and across 200 fill-ups per year (5-day commute) the gap grows to CHF 500-1000. This page makes it easy to map your personal station set: pick the zone of your usual border crossing and compare options by brand, address, and today's price.`,
    };
    if (locale === 'de') return {
      title: `Alle ${lower}-Tankstellen — Tessin-Index`,
      description: `Vollständiger Index der von uns überwachten ${lower}-Tankstellen im Tessin, nach Grenzregion gruppiert. Tägliche Aktualisierung über TCS Benzinpreis.`,
      h1: `${fuelLabel}-Tankstellen Tessin — vollständiger Index`,
      lede: `Durchsuche jede ${lower}-Tankstelle, die wir im Tessin überwachen, gruppiert nach Grenzregion. Jeder Eintrag verlinkt auf die tagesaktuelle Seite mit Preis, Ranking in der Region und Grenzgänger-Kontext.`,
      methodology: `Die Preise stammen von TCS Benzinpreis (Touring Club Schweiz), der die offiziellen Listen der Schweizer Tankstellen bündelt. Unsere Pipeline ordnet jede Tankstelle ihrer Tessiner Grenzregion zu, entfernt Duplikate mit derselben Marke und Adresse und veröffentlicht für jede überwachte Station eine eigene Seite mit tagesaktuellen Daten. Der Index unten gruppiert die Stationen nach Region, sodass du auf einen Blick die nächstgelegenen Optionen für deinen Grenzübergang vergleichen kannst. Fehlt eine Station, hat TCS sie heute noch nicht erfasst — die Liste wird jede Nacht neu erstellt.`,
      frontaliereContext: `Für italienische Grenzgänger, die täglich in die Schweiz pendeln, ist der ${lower}-Preis eine wiederkehrende Ausgabe. Der Vergleich der Stationen in der Nähe deines Übergangs — Chiasso, Brogeda, Gaggiolo, Stabio, Bizzarone — kann CHF 0.05-0.10 pro Liter sparen: bei 50 Litern sind das CHF 2.50-5, und auf 200 Tankfüllungen pro Jahr summiert sich die Lücke auf CHF 500-1000. Diese Seite hilft dir, dein persönliches Stations-Set zusammenzustellen: wähle die Region deines üblichen Grenzübergangs und vergleiche Optionen nach Marke, Adresse und heutigem Preis.`,
    };
    return {
      title: `Toutes les stations ${lower} en Suisse — index Tessin`,
      description: `Index complet des stations ${lower} surveillées au Tessin, groupées par zone frontalière. Mise à jour quotidienne via TCS Benzinpreis.`,
      h1: `Stations ${lower} au Tessin — index complet`,
      lede: `Parcourez chaque station ${lower} que nous surveillons au Tessin, groupée par zone frontalière. Chaque entrée mène à la page quotidienne avec le prix du jour, le classement dans la zone et le contexte frontalier.`,
      methodology: `Les prix proviennent de TCS Benzinpreis (Touring Club Suisse), qui rassemble les tarifs officiels des stations suisses. Notre pipeline associe chaque station à sa zone tessinoise, déduplique les entrées de même marque et adresse, et publie une page dédiée par station avec des données quotidiennes. L'index ci-dessous groupe les stations par zone afin que vous puissiez comparer les options proches de votre passage habituel. Si la station recherchée manque, TCS ne l'a peut-être pas relevée aujourd'hui — la liste est régénérée chaque nuit.`,
      frontaliereContext: `Pour les frontaliers italiens qui passent chaque jour en Suisse, le prix du ${lower} est une dépense récurrente. Comparer les stations proches de votre passage — Chiasso, Brogeda, Gaggiolo, Stabio, Bizzarone — peut faire économiser CHF 0.05-0.10 le litre : sur un plein de 50 litres, c'est CHF 2.50-5, et sur 200 pleins par an, l'écart atteint CHF 500-1000. Cette page facilite la cartographie de votre ensemble personnel : choisissez la zone de votre passage habituel et comparez les options par marque, adresse et prix du jour.`,
    };
  }
  if (kind === 'italianStations') {
    if (locale === 'it') return {
      title: `Tutte le stazioni ${lower} in Italia (confine) — indice`,
      description: `Indice delle stazioni italiane ${lower} delle città di confine (Como, Varese, Luino, Lavena Ponte Tresa…) con prezzi MIMIT aggiornati ogni giorno.`,
      h1: `Stazioni ${lower} Italia confine — indice completo`,
      lede: `Indice di ogni stazione di rifornimento italiana ${lower} delle città di confine che monitoriamo. Raggruppato per comune così puoi confrontare prima di passare il valico.`,
      methodology: `I prezzi delle stazioni italiane provengono dal portale "Osservaprezzi Carburanti" del MIMIT (Ministero delle Imprese e del Made in Italy), aggiornato ogni giorno dai gestori. La nostra pipeline filtra le stazioni dei 15 comuni di confine, dedupla per id e pubblica una pagina dedicata per ognuna. La benzina è il taglio carburante con copertura più completa: per il diesel italiano (Gasolio) la disponibilità è parziale, motivo per cui questo indice esiste solo nella sezione benzina.`,
      frontaliereContext: `Se vivi in Italia e lavori in Ticino, scegliere se fare il pieno prima del confine o dopo dipende dallo spread CHF/EUR del giorno. Storicamente il ${lower} svizzero costa di più al litro nominale ma, con il franco forte e i prezzi italiani in linea con la media UE, lo spread si è ristretto. Questo indice ti dà tutte le opzioni delle città di confine in un colpo d'occhio: dalle stazioni vicino al casello di Como Centro alle pompe self-service di Lavena Ponte Tresa che molti frontalieri usano nel ritorno serale.`,
    };
    if (locale === 'en') return {
      title: `All Italian ${lower} stations near the border — index`,
      description: `Index of Italian ${lower} stations across border-zone cities (Como, Varese, Luino, Lavena Ponte Tresa…). Daily MIMIT prices.`,
      h1: `Italian ${lower} border stations — full index`,
      lede: `Browse every Italian ${lower} station we track across border-zone cities. Grouped by municipality so you can compare before you cross.`,
      methodology: `Italian station prices come from the MIMIT "Osservaprezzi Carburanti" portal (Italian Ministry of Enterprises), updated daily by station operators. Our pipeline filters stations across 15 border-zone municipalities, deduplicates by station id, and publishes one dedicated page per station. Petrol (Benzina) has the most complete coverage; Italian diesel (Gasolio) has partial availability, which is why this index only exists in the petrol section.`,
      frontaliereContext: `If you live in Italy and work in Ticino, deciding whether to fill up before crossing or after depends on the daily CHF/EUR spread. Swiss ${lower} historically costs more per litre nominally, but with a strong franc and Italian prices tracking the EU average, the spread has tightened. This index lays out every border-city option: stations near the Como Centro toll, self-service pumps in Lavena Ponte Tresa that many commuters use on the evening leg, and everything in between.`,
    };
    if (locale === 'de') return {
      title: `Alle italienischen ${lower}-Tankstellen am Tessiner Grenzgebiet — Index`,
      description: `Index der italienischen ${lower}-Tankstellen in Grenzstädten (Como, Varese, Luino, Lavena Ponte Tresa…). Tägliche MIMIT-Daten.`,
      h1: `Italienische ${lower}-Tankstellen am Grenzgebiet — Index`,
      lede: `Durchsuche jede italienische ${lower}-Tankstelle, die wir in den Grenzstädten erfassen. Nach Gemeinde gruppiert, damit du vor dem Übergang vergleichen kannst.`,
      methodology: `Die italienischen Stationspreise stammen vom Portal "Osservaprezzi Carburanti" des MIMIT (italienisches Ministerium für Unternehmen), das die Betreiber täglich aktualisieren. Unsere Pipeline filtert die Stationen der 15 Grenzgemeinden, dedupliziert nach Station-ID und veröffentlicht eine eigene Seite pro Station. Benzin (Benzina) hat die umfassendste Abdeckung; der italienische Diesel (Gasolio) ist nur teilweise verfügbar, weshalb dieser Index nur in der Benzin-Sektion existiert.`,
      frontaliereContext: `Wenn du in Italien wohnst und im Tessin arbeitest, hängt die Entscheidung, vor oder nach der Grenze zu tanken, vom täglichen CHF/EUR-Kurs ab. Schweizer ${lower} kostet pro Liter nominal mehr, aber bei starkem Franken und EU-konformen italienischen Preisen ist der Abstand kleiner geworden. Dieser Index zeigt alle Grenzstadt-Optionen auf einen Blick: von den Stationen am Mautknoten Como Centro bis zu den Self-Service-Pumpen in Lavena Ponte Tresa, die viele Pendler am Abend nutzen.`,
    };
    return {
      title: `Toutes les stations ${lower} italiennes (frontière) — index`,
      description: `Index des stations ${lower} italiennes des villes frontalières (Como, Varese, Luino, Lavena Ponte Tresa…). Données MIMIT quotidiennes.`,
      h1: `Stations ${lower} italiennes frontalières — index complet`,
      lede: `Parcourez chaque station ${lower} italienne suivie dans les villes frontalières. Groupée par commune pour comparer avant de passer la frontière.`,
      methodology: `Les prix des stations italiennes proviennent du portail "Osservaprezzi Carburanti" du MIMIT (Ministère italien des Entreprises), mis à jour quotidiennement par les exploitants. Notre pipeline filtre les stations de 15 communes frontalières, déduplique par identifiant et publie une page dédiée par station. L'essence (Benzina) a la couverture la plus complète ; le gazole italien (Gasolio) est partiellement disponible, raison pour laquelle cet index n'existe que dans la section essence.`,
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
    methodology: `Pour chacune des 15 villes italiennes frontalières, nous publions une page quotidienne avec le prix moyen du ${lower} des stations communales, le classement des pompes les moins chères et le prix suisse le plus proche pour contexte. Les données viennent du portail "Osservaprezzi Carburanti" du Ministère italien, mis à jour directement par les exploitants. La page ville est le point d'entrée pratique pour une vue d'ensemble avant d'examiner une station précise.`,
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

interface GroupedAnchors {
  readonly heading: string;
  readonly anchors: ReadonlyArray<{ readonly href: string; readonly label: string; readonly subtitle: string }>;
}

function renderGroup(group: GroupedAnchors, copy: IndexCopy): string {
  const lis = group.anchors
    .map(
      (a) =>
        `<li style="margin:0;padding:8px 0;border-bottom:1px solid var(--color-edge,rgba(0,0,0,0.08))"><a href="${esc(a.href)}" style="${LINK_ACCENT_STYLE};font-weight:600">${esc(a.label)}</a><div style="font-size:13px;color:var(--color-subtle);margin-top:2px">${esc(a.subtitle)}</div></li>`,
    )
    .join('');
  return `<section style="margin:0 0 28px"><h3 style="font-size:18px;margin:0 0 12px;color:var(--color-heading)">${esc(group.heading)}</h3><ul style="list-style:none;padding:0;margin:0">${lis}</ul></section>`;
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
}

function renderIndexPage(opts: RenderIndexOpts): string {
  const { locale, fuel, kind, canonicalPath, alternates, groups, today, distDir, relatedLinks } = opts;
  const copy = COPY[locale];
  const titles = titleFor(kind, locale, fuel);
  const fuelLabel = FUEL_TYPE_LABEL[locale][fuel];
  const dateStamp = today.toISOString().slice(0, 10);
  const canonicalUrl = `${BASE_URL}${canonicalPath}`;

  const totalAnchors = groups.reduce((acc, g) => acc + g.anchors.length, 0);

  // Browse list (the load-bearing internal-link block — these are the anchors
  // that BFS from the homepage will follow to reach the per-station / per-city
  // leaves and lift them out of the orphans bucket).
  const groupsHtml =
    totalAnchors > 0
      ? groups.map((g) => renderGroup(g, copy)).join('')
      : `<p style="padding:14px 16px;border-radius:12px;background:var(--color-warning-subtle,#fff7ed);color:var(--color-warning,#9a3412)">${esc(locale === 'it' ? 'Nessuna stazione monitorata oggi.' : locale === 'de' ? 'Heute keine Stationen erfasst.' : locale === 'fr' ? 'Aucune station suivie aujourd\'hui.' : 'No stations tracked today.')}</p>`;

  // Cross-links to sibling indexes + daily hub.
  const relatedHtml = relatedLinks.length > 0
    ? `<aside style="${CARD_STYLE};margin:24px 0;padding:18px 20px"><h2 style="${H2_STYLE};margin:0 0 12px;font-size:18px">${esc(copy.relatedHeading)}</h2><ul style="list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:8px">${relatedLinks
        .map(
          (rl) => `<li style="margin:0"><a href="${esc(rl.href)}" style="${LINK_ACCENT_STYLE};font-weight:600">${esc(rl.label)} →</a></li>`,
        )
        .join('')}</ul></aside>`
    : '';

  // Hreflang.
  const alternatesHtml = renderHreflangTags(alternates);

  // BreadcrumbList JSON-LD.
  const breadcrumbLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: copy.breadcrumbHome, item: `${BASE_URL}/` },
      {
        '@type': 'ListItem',
        position: 2,
        name: fuelLabel,
        item: `${BASE_URL}${FUEL_LOCALE_PREFIX[locale]}/${FUEL_SECTION_SLUG[locale][fuel]}/`,
      },
      { '@type': 'ListItem', position: 3, name: titles.h1, item: canonicalUrl },
    ],
  });

  const webPageLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: titles.h1,
    url: canonicalUrl,
    description: titles.description,
    inLanguage: locale,
    dateModified: today.toISOString(),
    datePublished: today.toISOString(),
    isPartOf: {
      '@type': 'WebSite',
      url: BASE_URL,
      name: 'Frontaliere Ticino',
    },
  });

  const title = clampSiteSuffix(titles.title, 'Frontaliere Ticino');
  const description = titles.description.slice(0, 180);

  const bodyHtml = `<article style="max-width:1100px;margin:0 auto;padding:32px 20px 56px">
  <nav style="${BREADCRUMB_STYLE}">
    <a href="${BASE_URL}/" style="${BREADCRUMB_LINK_STYLE}">${esc(copy.breadcrumbHome)}</a>
    <span> / </span>
    <a href="${BASE_URL}${FUEL_LOCALE_PREFIX[locale]}/${FUEL_SECTION_SLUG[locale][fuel]}/" style="${BREADCRUMB_LINK_STYLE}">${esc(fuelLabel)}</a>
    <span> / </span>
    <span>${esc(titles.h1)}</span>
  </nav>
  <header style="margin-bottom:22px">
    <p style="${HERO_EYEBROW_STYLE}">${esc(copy.updatedLabel)} · ${dateStamp}</p>
    <h1 style="${H1_STYLE}">${esc(titles.h1)}</h1>
    <p style="${LEDE_STYLE}">${esc(titles.lede)}</p>
  </header>
  <section style="${CARD_STYLE};margin:0 0 22px;padding:18px 20px">
    <h2 style="${H2_STYLE};margin:0 0 10px;font-size:18px">${esc(copy.methodologyHeading)}</h2>
    <p style="margin:0;color:var(--color-body);line-height:1.7;max-width:860px">${esc(titles.methodology)}</p>
  </section>
  <section style="${CARD_STYLE};margin:0 0 28px;padding:18px 20px">
    <h2 style="${H2_STYLE};margin:0 0 10px;font-size:18px">${esc(copy.frontaliereHeading)}</h2>
    <p style="margin:0;color:var(--color-body);line-height:1.7;max-width:860px">${esc(titles.frontaliereContext)}</p>
  </section>
  <section aria-labelledby="browseAll">
    <h2 id="browseAll" style="${H2_STYLE}">${esc(copy.browseHeading)}</h2>
    ${groupsHtml}
  </section>
  ${relatedHtml}
</article>`;

  const extraHead = `    <meta property="og:image" content="${BASE_URL}/og-image.png">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${esc(title)}">
    <meta name="twitter:description" content="${esc(description)}">
    <meta name="twitter:site" content="@frontaliereticino">`;

  return buildSeoPageHtml({
    locale,
    title,
    description,
    canonicalUrl,
    robots: 'index,follow',
    ogType: 'website',
    hreflangHtml: alternatesHtml,
    extraHeadHtml: extraHead,
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

/** Group Italian-station leaves by city slug, in FUEL_ITALIAN_CITIES order. */
function groupItalianByCity(stations: readonly ItalianStationLeaf[]): Map<string, ItalianStationLeaf[]> {
  const out = new Map<string, ItalianStationLeaf[]>();
  for (const c of FUEL_ITALIAN_CITIES) out.set(c.slug, []);
  for (const s of stations) {
    const list = out.get(s.citySlug);
    if (list) list.push(s);
  }
  for (const list of out.values()) {
    list.sort((a, b) => {
      const k = (a.brand || a.name).localeCompare(b.brand || b.name);
      if (k !== 0) return k;
      return (a.address || '').localeCompare(b.address || '');
    });
  }
  return out;
}

/**
 * Generate the 3 indexes × locale × fuel.
 *
 * Returns Record<canonicalPath, html> ready to be written to dist/.
 */
export function generateFuelIndexPages(inp: FuelIndexInputs): Record<string, string> {
  const { swissStations, italianStations, today, distDir } = inp;
  const out: Record<string, string> = {};

  const swissByZone = groupSwissByZone(swissStations);
  const italianByCity = groupItalianByCity(italianStations);

  for (const fuel of FUEL_TYPES) {
    for (const locale of FUEL_DAILY_LOCALES) {
      const copy = COPY[locale];

      // Common alternates+related-links computation per kind.
      const buildAlternates = (kind: FuelIndexKind): Record<FuelDailyLocale, string> => {
        const alts: Record<FuelDailyLocale, string> = { it: '', en: '', de: '', fr: '' };
        for (const alt of FUEL_DAILY_LOCALES) {
          alts[alt] = buildFuelIndexPath(alt, fuel, kind);
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
        // IT-stations index only exists for benzina; only cross-link when the
        // current page is benzina.
        if (kind !== 'italianStations' && fuel === 'benzina') {
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
        const groups: GroupedAnchors[] = [];
        for (const zone of FUEL_ZONES) {
          const list = swissByZone.get(zone) ?? [];
          if (list.length === 0) continue;
          groups.push({
            heading: copy.groupHeadingByZone(FUEL_ZONE_DISPLAY[zone]),
            anchors: list.map((s) => ({
              href: buildFuelStationPath(locale, fuel, zone, s.slug),
              label: s.brand ? `${s.brand}${s.name && s.name !== s.brand ? ` — ${s.name}` : ''}` : s.name,
              subtitle: s.address,
            })),
          });
        }
        const canonicalPath = buildFuelIndexPath(locale, fuel, 'swissStations');
        out[canonicalPath] = renderIndexPage({
          locale,
          fuel,
          kind: 'swissStations',
          canonicalPath,
          alternates: buildAlternates('swissStations'),
          groups,
          today,
          distDir,
          relatedLinks: buildRelated('swissStations'),
        });
      }

      // ── Italian-cities index ───────────────────────────────────
      {
        const cityGroups: GroupedAnchors[] = [];
        // Group by nearest Ticino zone — keeps the page semantically organised
        // (the city-zone mapping is geographic, not arbitrary).
        const byZone = new Map<FuelZone, ItalianCityEntry[]>();
        for (const z of FUEL_ZONES) byZone.set(z, []);
        for (const c of FUEL_ITALIAN_CITIES) {
          const arr = byZone.get(c.nearestZone);
          if (arr) arr.push(c);
        }
        for (const z of FUEL_ZONES) {
          const cities = byZone.get(z) ?? [];
          if (cities.length === 0) continue;
          cityGroups.push({
            heading: copy.groupHeadingByZone(FUEL_ZONE_DISPLAY[z]),
            anchors: cities.map((c) => ({
              href: buildFuelItalianCityPath(locale, fuel, c.slug),
              label: c.display,
              subtitle: `${c.province} · ${FUEL_ZONE_DISPLAY[z]}`,
            })),
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
        });
      }

      // ── Italian-stations index (benzina only) ──────────────────
      if (fuel === 'benzina') {
        const groups: GroupedAnchors[] = [];
        for (const c of FUEL_ITALIAN_CITIES) {
          const list = italianByCity.get(c.slug) ?? [];
          if (list.length === 0) continue;
          groups.push({
            heading: copy.groupHeadingByCity(c.display),
            anchors: list.map((s) => ({
              href: buildFuelItalianStationPath(locale, fuel, s.citySlug, s.stationSlug),
              label: s.brand ? `${s.brand}${s.name && s.name !== s.brand ? ` — ${s.name}` : ''}` : s.name,
              subtitle: s.address || c.display,
            })),
          });
        }
        const canonicalPath = buildFuelIndexPath(locale, fuel, 'italianStations');
        out[canonicalPath] = renderIndexPage({
          locale,
          fuel,
          kind: 'italianStations',
          canonicalPath,
          alternates: buildAlternates('italianStations'),
          groups,
          today,
          distDir,
          relatedLinks: buildRelated('italianStations'),
        });
      }
    }
  }

  return out;
}

// ── Helpers exposed for tests + plugin reuse ─────────────────────

/**
 * Compact "see also" link tile: links the daily hub to the 3 indexes.
 * Returns a bare HTML <aside> string ready to be concatenated into the
 * daily-fuel page body. Includes a self-locale link to each sibling locale's
 * daily hub (closes the F6 daily-fuel orphan gap for DE + FR).
 */
export function renderFuelIndexHubLinks(opts: {
  readonly locale: FuelDailyLocale;
  readonly fuel: FuelType;
}): string {
  const { locale, fuel } = opts;
  const copy = COPY[locale];
  const items: Array<{ href: string; label: string }> = [
    {
      href: buildFuelIndexPath(locale, fuel, 'swissStations'),
      label: copy.relatedLinkLabels.swissStations,
    },
    {
      href: buildFuelIndexPath(locale, fuel, 'italianCities'),
      label: copy.relatedLinkLabels.italianCities,
    },
  ];
  if (fuel === 'benzina') {
    items.splice(1, 0, {
      href: buildFuelIndexPath(locale, fuel, 'italianStations'),
      label: copy.relatedLinkLabels.italianStations,
    });
  }
  // Cross-locale links to sibling daily hubs (DE/FR previously orphan).
  const otherLocales = FUEL_DAILY_LOCALES.filter((l) => l !== locale);
  for (const alt of otherLocales) {
    items.push({
      href: buildFuelTodayPath(alt, fuel),
      label: `${alt.toUpperCase()} · ${labelForLocale(alt, fuel)}`,
    });
  }
  const lis = items
    .map(
      (it) => `<li style="margin:0"><a href="${esc(it.href)}" style="${LINK_ACCENT_STYLE};font-weight:600">${esc(it.label)} →</a></li>`,
    )
    .join('');
  return `<aside style="${CARD_STYLE};margin:24px 0;padding:18px 20px" aria-labelledby="fuelIndexHub"><h2 id="fuelIndexHub" style="${H2_STYLE};margin:0 0 12px;font-size:18px">${esc(copy.relatedHeading)}</h2><ul style="list-style:none;padding:0;margin:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px">${lis}</ul></aside>`;
}

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
