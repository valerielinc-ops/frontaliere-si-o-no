/**
 * Vite build plugin — emits daily-fresh static HTML for fuel price pages
 * (diesel + benzina) in 4 locales × (1 regional + 5 Ticino zones) × 2 fuels.
 *
 * Data source: data/fuel-prices.json (Swiss stations only — Italian stations
 * live on the sibling comparator). Optional history lives in
 * data/fuel-prices-history/YYYY-MM-DD.json and is populated daily by
 * scripts/snapshot-fuel-history.mjs.
 *
 * Page count: 4 × 2 × 6 = 48 "today" pages. Month archives are generated
 * on-demand when history files are present (past months only, never current).
 *
 * Each page:
 *  - ≥250 words of real content (hard-gated at build time)
 *  - JSON-LD: WebPage + BreadcrumbList + FAQPage + Product (price/currency)
 *  - Self-referencing canonical (+ hreflang alternates for the 4 locales)
 *  - Uses WriteCollector.skipExisting for content-hash dedup
 *  - Default-off via SKIP_FUEL_DAILY=1 env var
 *
 * Kept standalone (no dep on jobsSeoPagesPlugin) so parallel SEO worktrees
 * merge cleanly (see memory: worktree_merge_router_duplicates).
 */

import type { Plugin } from 'vite';
import fs from 'node:fs';
import np from 'node:path';
import {
  BASE_URL,
  MIN_INDEXABLE_WORDS,
  countHtmlBodyWords,
} from './constants';
import { buildSeoPageHtml } from './shared/seoPageShell';
import { renderHreflangTags } from './shared/hreflang';
import { WriteCollector } from './batchWrite';
import {
  FUEL_DAILY_LOCALES,
  FUEL_LOCALE_PREFIX,
  FUEL_SECTION_SLUG,
  FUEL_TODAY_SLUG,
  FUEL_TYPES,
  FUEL_TYPE_LABEL,
  FUEL_ZONES,
  FUEL_ZONE_DISPLAY,
  FUEL_ITALIAN_CITIES,
  FUEL_ITALY_SLUG,
  buildFuelArchivePath,
  buildFuelTodayPath,
  buildFuelStationPath,
  buildFuelItalianCityPath,
  buildFuelItalianStationPath,
  buildStationSlug,
  zoneForAddress,
  computeDeltaVsYesterday,
  type FuelDailyLocale,
  type FuelType,
  type FuelZone,
  type ItalianCityEntry,
} from './fuelDailyData';
import { generateRelatedLinksBlock } from './shared/relatedLinks';
import { cleanNamespaces, cleanSitemapFiles } from './shared/distNamespaceCleanup';
import {
  JOB_MARKET_LOCALE_PREFIX,
  JOB_MARKET_SECTION_SLUG,
} from './jobMarketSnapshotData';
import {
  WEEKLY_EMPLOYERS_CURRENT_SLUG,
  WEEKLY_EMPLOYERS_LOCALE_PREFIX,
  WEEKLY_EMPLOYERS_SECTION,
} from './weeklyEmployersData';
import {
  BREADCRUMB_LINK_STYLE,
  BREADCRUMB_STYLE,
  CARD_BODY_STYLE,
  CARD_STYLE,
  H1_STYLE,
  H2_STYLE,
  HERO_EYEBROW_STYLE,
  ICON_FUEL_SVG,
  LEDE_STYLE,
  LINK_ACCENT_STYLE,
  renderDiscoverMore,
  renderEntityCard,
  resolveBrandLogoUrl,
  STAT_TILE_ACCENT,
  STAT_TILE_BASE,
  STAT_TILE_LABEL,
  STAT_TILE_SUCCESS,
  STAT_TILE_VALUE,
  STAT_TILE_WARNING,
  TABLE_CELL_STYLE,
  TABLE_HEAD_STYLE,
  TABLE_STYLE,
  clampSiteSuffix,
} from './shared/seoContentTokens';

// ── Feature-specific "Scopri di più" CTAs ─────────────────────
// Three contextually relevant links per locale for the F6 fuel-daily feature.
// These replace generic/affiliate-feel suggestions with tool-appropriate next steps.
//
// URLs are built from canonical slug constants from weeklyEmployersData and
// jobMarketSnapshotData so they stay in sync with the actual pages emitted.

type FuelDiscoverMoreCta = { title: string; href: string };

const BORDER_WAIT_HUB_PATH: Record<FuelDailyLocale, string> = {
  it: '/traffico-dogane/',
  en: '/en/border-wait/',
  de: '/de/wartezeit-grenze/',
  fr: '/fr/temps-attente-douane/',
};

/**
 * Canonical slug for the cross-border fuel-price stats page per locale. Kept
 * in sync with `services/router.ts` slug tables (`stats` + `fuelPrices`). Used
 * by the "base dati in costruzione" fallback note so users can still reach the
 * long-form history chart while the F6 snapshot series is too young.
 */
const FUEL_STATS_HUB_PATH: Record<FuelDailyLocale, string> = {
  it: '/statistiche/prezzi-benzina-confine/',
  en: '/en/statistics/border-fuel-prices/',
  de: '/de/statistiken/spritpreise-grenze/',
  fr: '/fr/statistiques/prix-essence-frontiere/',
};

function buildFuelDiscoverMoreCtas(
  locale: FuelDailyLocale,
): ReadonlyArray<FuelDiscoverMoreCta> {
  const chiassoHiringHref =
    `${WEEKLY_EMPLOYERS_LOCALE_PREFIX[locale]}/${WEEKLY_EMPLOYERS_SECTION[locale]}/chiasso/${WEEKLY_EMPLOYERS_CURRENT_SLUG[locale]}/`.replace(
      /\/{2,}/g,
      '/',
    );
  const jobMarketHref =
    `${JOB_MARKET_LOCALE_PREFIX[locale]}/${JOB_MARKET_SECTION_SLUG[locale]}/`.replace(
      /\/{2,}/g,
      '/',
    );

  const titles: Record<FuelDailyLocale, { border: string; hiring: string; jobMarket: string }> = {
    it: {
      border: 'Tempi di attesa alle dogane',
      hiring: 'Aziende che assumono a Chiasso',
      jobMarket: 'Mercato del lavoro Ticino',
    },
    en: {
      border: 'Border crossing wait times',
      hiring: 'Companies hiring in Chiasso',
      jobMarket: 'Ticino job market',
    },
    de: {
      border: 'Wartezeiten an der Grenze',
      hiring: 'Unternehmen die in Chiasso einstellen',
      jobMarket: 'Arbeitsmarkt Tessin',
    },
    fr: {
      border: "Temps d'attente aux douanes",
      hiring: 'Entreprises qui recrutent à Chiasso',
      jobMarket: 'Marché du travail Tessin',
    },
  };

  const t = titles[locale];
  return [
    { title: t.border, href: BORDER_WAIT_HUB_PATH[locale] },
    { title: t.hiring, href: chiassoHiringHref },
    { title: t.jobMarket, href: jobMarketHref },
  ];
}

const FUEL_DAILY_DISCOVER_MORE_CTAS: Record<
  FuelDailyLocale,
  ReadonlyArray<FuelDiscoverMoreCta>
> = {
  it: buildFuelDiscoverMoreCtas('it'),
  en: buildFuelDiscoverMoreCtas('en'),
  de: buildFuelDiscoverMoreCtas('de'),
  fr: buildFuelDiscoverMoreCtas('fr'),
};

// ── Types ──────────────────────────────────────────────────────

interface SwissStation {
  id?: string;
  name?: string;
  brand?: string;
  address?: string;
  sp95PriceChf?: number;
  sp95PriceEur?: number;
  /** Real per-station diesel price (CHF/L) populated from the TCS Firestore feed. */
  dieselPriceChf?: number | null;
  dieselPriceEur?: number | null;
  /** `api` | `derived` | `unknown` — see scripts/generate-fuel-prices-dataset.mjs. */
  dieselSource?: 'api' | 'derived' | 'unknown' | 'monthly_average' | 'scraped';
  updatedAt?: string;
  nearestMunicipality?: string | null;
  nearestMunicipalityDistanceKm?: number;
  distanceKm?: number;
  /** Geo coordinates (populated for all TCS feed stations). */
  lat?: number;
  lng?: number;
}

interface MunicipalityRow {
  municipality?: string;
  province?: string;
  swiss?: {
    cheapestStation?: SwissStation | null;
    nearbyStations?: SwissStation[];
  };
}

interface FuelPricesDataset {
  generatedAt?: string;
  municipalities?: MunicipalityRow[];
}

interface HistorySnapshot {
  date: string;
  zones: Record<FuelZone, { diesel?: number | null; benzina?: number | null } | undefined>;
  regional?: { diesel?: number | null; benzina?: number | null };
  /**
   * Italian curated-city averages, populated by scripts/snapshot-fuel-history.mjs.
   * Keyed by city slug (e.g. "como"). Currently only `benzina` is tracked —
   * MIMIT-Gasolio ingestion not yet wired into the data pipeline.
   */
  italianCities?: Record<string, { benzina?: number | null; stationCount?: number } | undefined>;
}

interface ZonePrice {
  avg: number | null;
  minStations: Array<{ name: string; brand: string; address: string; priceChf: number; slug: string }>;
}

// ── Diesel/benzina derivation ─────────────────────────────────
//
// Primary source: `dieselPriceChf` populated by
// scripts/generate-fuel-prices-dataset.mjs from the TCS Firestore feed
// (per-station DIESEL record). When a station is missing a DIESEL price in
// the upstream feed, we fall back to SP95 + observed retail offset (~0.08
// CHF/L as of 2026). The fallback constant is kept as `LEGACY_DIESEL_OFFSET_CHF`
// and documented in scripts/snapshot-fuel-history.mjs as well.
const LEGACY_DIESEL_OFFSET_CHF = 0.08;

function pricesFromStation(station: SwissStation): { diesel: number; benzina: number } | null {
  const sp95 = typeof station.sp95PriceChf === 'number' ? station.sp95PriceChf : null;
  if (sp95 === null || Number.isNaN(sp95)) return null;
  const realDiesel =
    typeof station.dieselPriceChf === 'number' && Number.isFinite(station.dieselPriceChf)
      ? station.dieselPriceChf
      : null;
  return {
    benzina: Number(sp95.toFixed(3)),
    diesel: Number((realDiesel ?? sp95 + LEGACY_DIESEL_OFFSET_CHF).toFixed(3)),
  };
}

// ── Helpers ────────────────────────────────────────────────────

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function mean(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const sum = nums.reduce((a, b) => a + b, 0);
  return Number((sum / nums.length).toFixed(3));
}

function stationBelongsToZone(station: SwissStation, zone: FuelZone): boolean {
  const addr = (station.address || '').toLowerCase();
  const needle = zone.toLowerCase();
  return addr.includes(needle);
}

function collectZoneStations(dataset: FuelPricesDataset, zone: FuelZone): SwissStation[] {
  const seen = new Set<string>();
  const out: SwissStation[] = [];
  for (const row of dataset.municipalities ?? []) {
    const nearby = row.swiss?.nearbyStations ?? [];
    for (const s of nearby) {
      if (!s || typeof s.sp95PriceChf !== 'number') continue;
      if (!stationBelongsToZone(s, zone)) continue;
      const key = `${s.id ?? s.name ?? ''}:${s.address ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(s);
    }
  }
  return out;
}

function collectAllStations(dataset: FuelPricesDataset): SwissStation[] {
  const seen = new Set<string>();
  const out: SwissStation[] = [];
  for (const row of dataset.municipalities ?? []) {
    const nearby = row.swiss?.nearbyStations ?? [];
    for (const s of nearby) {
      if (!s || typeof s.sp95PriceChf !== 'number') continue;
      // Only include stations whose address resolves to a known Ticino zone:
      // the regional /oggi hub is implicitly Ticino, and only Ticino stations
      // have dedicated detail pages (see generateFuelStationPages). Stations
      // outside the zone map (e.g. Müstair, Bever) would render as non-clickable
      // <div> cards and confuse cross-border-worker readers.
      if (!zoneForAddress(s.address)) continue;
      const key = `${s.id ?? s.name ?? ''}:${s.address ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(s);
    }
  }
  return out;
}

function topCheapest(stations: SwissStation[], fuel: FuelType, limit = 3): SwissStation[] {
  const scored = stations
    .map((s) => {
      const p = pricesFromStation(s);
      if (!p) return null;
      return { station: s, price: p[fuel] } as const;
    })
    .filter((v): v is { station: SwissStation; price: number } => v !== null)
    .sort((a, b) => a.price - b.price)
    .slice(0, limit);
  return scored.map((v) => v.station);
}

function computeZonePrice(stations: SwissStation[], fuel: FuelType): ZonePrice {
  const prices: number[] = [];
  const stationPrices: Array<{ name: string; brand: string; address: string; priceChf: number; slug: string }> = [];
  for (const s of stations) {
    const p = pricesFromStation(s);
    if (!p) continue;
    prices.push(p[fuel]);
    stationPrices.push({
      name: String(s.name || s.brand || '—').trim(),
      brand: String(s.brand || '').trim(),
      address: String(s.address || '').trim(),
      priceChf: p[fuel],
      slug: buildStationSlug({ brand: s.brand, name: s.name, address: s.address }),
    });
  }
  const top3 = stationPrices.sort((a, b) => a.priceChf - b.priceChf).slice(0, 3);
  return { avg: mean(prices), minStations: top3 };
}

// ── History ────────────────────────────────────────────────────

function readHistory(rootDir: string): HistorySnapshot[] {
  const historyDir = np.join(rootDir, 'data', 'fuel-prices-history');
  if (!fs.existsSync(historyDir)) return [];
  const files = fs.readdirSync(historyDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
  const snapshots: HistorySnapshot[] = [];
  for (const file of files) {
    try {
      const raw = fs.readFileSync(np.join(historyDir, file), 'utf-8');
      const parsed = JSON.parse(raw) as HistorySnapshot;
      if (parsed && typeof parsed.date === 'string') snapshots.push(parsed);
    } catch {
      // skip malformed snapshot
    }
  }
  snapshots.sort((a, b) => a.date.localeCompare(b.date));
  return snapshots;
}

function lookbackPrice(
  history: HistorySnapshot[],
  zone: FuelZone | null,
  fuel: FuelType,
  daysAgo: number,
  today: Date,
): number | null {
  const target = new Date(today.getTime() - daysAgo * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  // Require exact date match. Previously a ±1 day drift was accepted to tolerate
  // snapshot cron skew, but that silently substituted a 2-day-old snapshot for
  // "yesterday" when yesterday's file was missing — producing a misleading
  // "0,000 CHF vs ieri" when today's price happened to match the older day.
  // Returning null makes the caller render the explicit "dati non disponibili"
  // fallback instead.
  const snap = history.find((h) => h.date === target);
  if (!snap) return null;
  const src = zone ? snap.zones?.[zone] : snap.regional;
  if (!src) return null;
  const val = src[fuel];
  return typeof val === 'number' ? val : null;
}

function formatDelta(delta: number | null, locale: FuelDailyLocale): string {
  if (delta === null || Number.isNaN(delta)) return '—';
  const sign = delta > 0 ? '+' : delta < 0 ? '' : '';
  const val = delta.toFixed(3);
  const sep = locale === 'it' || locale === 'fr' ? ',' : '.';
  return `${sign}${val.replace('.', sep)} CHF`;
}

function formatPrice(price: number | null, locale: FuelDailyLocale): string {
  if (price === null || Number.isNaN(price)) return '—';
  const sep = locale === 'it' || locale === 'fr' ? ',' : '.';
  return `${price.toFixed(3).replace('.', sep)}`;
}

/**
 * Compute the arithmetic mean of all numeric points in a 7-day trend series.
 *
 * Returns `null` when fewer than two numeric points are available — the caller
 * must then render a "not available yet" note instead of a hardcoded value.
 * This is the F2 fix for the "7-day average is always 2,149 CHF" bug: the
 * previous implementation fell back to today's price when history was missing,
 * which produced a static-looking aggregate. Now the aggregate is either real
 * or explicitly absent.
 */
function computePeriodAverage(prices: ReadonlyArray<number | null>): number | null {
  const numeric = prices.filter(
    (p): p is number => typeof p === 'number' && Number.isFinite(p),
  );
  if (numeric.length < 2) return null;
  const sum = numeric.reduce((a, b) => a + b, 0);
  return Number((sum / numeric.length).toFixed(3));
}

// ── Localised copy ─────────────────────────────────────────────

interface FuelCopy {
  regionalH1: (fuelLabel: string) => string;
  zoneH1: (fuelLabel: string, zone: string) => string;
  intro: (fuelLabel: string, zone: string, priceFmt: string, date: string) => string;
  paragraph: (fuelLabel: string, zone: string, price: string, dYest: string, d7: string) => string;
  historySection: string;
  updatedLabel: string;
  avgLabel: string;
  vsYesterday: string;
  vs7d: string;
  top3Label: string;
  trendLabel: string;
  trendEmpty: string;
  faqTitle: string;
  regionalLabel: string;
  archiveLabel: string;
  breadcrumbHome: string;
  currencyLabel: string;
  /** Inline note shown when yesterday/7-day delta cannot be computed. */
  dataUnavailableNote: string;
  /** Anchor copy for the link to the border-fuel-prices stats page. */
  dataUnavailableLinkLabel: string;
  /** Inline note shown when the 7-day period average has <2 data points. */
  periodAvgUnavailableNote: string;
  /** Label for the period-average row ("Media 7 giorni"). */
  periodAvgLabel: string;
  /**
   * Compose the SVG `aria-label` for the trend chart. Receives the localised
   * period description (7d), the formatted period average and the delta
   * (already localised with sign) as inputs.
   */
  chartAriaLabel: (fuelLabel: string, zone: string, avgFmt: string) => string;
  faq: Array<{ q: string; a: (fuelLabel: string, zone: string) => string }>;
}

const COPY: Record<FuelDailyLocale, FuelCopy> = {
  it: {
    regionalH1: (f) => `Prezzo ${f} Svizzera oggi — Ticino`,
    zoneH1: (f, z) => `Prezzo ${f} oggi a ${z}`,
    intro: (f, z, priceFmt, date) =>
      `Aggiornamento del ${date}: il prezzo medio del ${f.toLowerCase()} a ${z} è ${priceFmt} CHF/litro. Dati rilevati dalle stazioni Swiss (TCS Benzinpreis) attive entro 20 km dal confine italiano.`,
    paragraph: (f, z, price, dYest, d7) =>
      `Oggi a ${z} il ${f.toLowerCase()} costa in media ${price} CHF/litro, ${dYest} rispetto a ieri e ${d7} rispetto a 7 giorni fa. La pagina viene rigenerata automaticamente ogni giorno alle prime ore del mattino con i dati più freschi disponibili dalle stazioni di rifornimento della zona. Confronta le tre stazioni più economiche e verifica l'andamento della settimana per pianificare il rifornimento prima del pieno della tua settimana di frontaliere.`,
    historySection:
      "Il grafico qui sotto mostra l'andamento del prezzo nel tempo — utile per capire se conviene rifornirsi oggi o aspettare. Usa i pulsanti per cambiare l'intervallo (1 mese, 3 mesi, 6 mesi, 1 anno, 5 anni). Lo storico si popola giorno per giorno: gli intervalli più lunghi diventano disponibili man mano che raccogliamo nuovi dati.",
    updatedLabel: 'Aggiornamento',
    avgLabel: 'Prezzo medio oggi',
    vsYesterday: 'vs ieri',
    vs7d: 'vs 7 giorni fa',
    top3Label: 'Le 3 stazioni più economiche',
    trendLabel: 'Andamento storico del prezzo',
    trendEmpty: 'Storico in costruzione: il grafico si aggiorna ogni giorno a partire da oggi.',
    faqTitle: 'Domande frequenti',
    regionalLabel: 'Tutto il Ticino',
    archiveLabel: 'Archivio mensile',
    breadcrumbHome: 'Home',
    currencyLabel: 'CHF/litro',
    dataUnavailableNote: 'Base dati in costruzione: il confronto richiede almeno due snapshot giornalieri. ',
    dataUnavailableLinkLabel: 'Consulta lo storico completo dei prezzi al confine',
    periodAvgUnavailableNote: 'Media dei 7 giorni non ancora disponibile: lo storico si popola giorno per giorno.',
    periodAvgLabel: 'Media 7 giorni',
    chartAriaLabel: (f, z, avgFmt) =>
      `Andamento storico del prezzo ${f.toLowerCase()} a ${z}: media ${avgFmt} CHF/litro nell'intervallo selezionato.`,
    faq: [
      {
        q: 'Ogni quanto viene aggiornato il prezzo?',
        a: (f, z) =>
          `Il prezzo del ${f.toLowerCase()} a ${z} viene aggiornato ogni giorno. I dati provengono da TCS Benzinpreis, che raccoglie in tempo reale i listini delle stazioni in Svizzera.`,
      },
      {
        q: 'Conviene rifornirsi in Italia o in Svizzera?',
        a: () =>
          "Dipende dal prezzo del giorno e dal costo del carburante in Italia: confronta il dato odierno con il prezzo italiano del comune di confine nella pagina comparatore carburanti. In genere in Italia il prezzo al litro è più basso, ma la Svizzera offre self-service h24 anche in zone rurali.",
      },
      {
        q: 'Da dove arrivano i prezzi delle stazioni elencate?',
        a: () =>
          "I prezzi sono raccolti da TCS Benzinpreis (Touring Club Svizzero), che aggrega i listini ufficiali delle stazioni di rifornimento in Svizzera. La nostra pipeline li mappa per zona ticinese e li pubblica ogni giorno.",
      },
    ],
  },
  en: {
    regionalH1: (f) => `${f} price Switzerland today — Ticino`,
    zoneH1: (f, z) => `${f} price today in ${z}`,
    intro: (f, z, priceFmt, date) =>
      `Updated ${date}: the average ${f.toLowerCase()} price in ${z} is ${priceFmt} CHF per litre. Data from Swiss stations (TCS Benzinpreis) within 20 km of the Italian border.`,
    paragraph: (f, z, price, dYest, d7) =>
      `Today in ${z} the ${f.toLowerCase()} costs ${price} CHF per litre on average, ${dYest} compared to yesterday and ${d7} compared to 7 days ago. This page is regenerated automatically every morning with the freshest data from stations in the area. Compare the three cheapest stations and check the weekly trend before you fill up during your cross-border commute.`,
    historySection:
      'The chart below shows the price trend over time — handy to decide whether to fill up today or wait. Use the buttons to switch the range (1 month, 3 months, 6 months, 1 year, 5 years). History is built day by day: longer ranges fill in as we collect more snapshots.',
    updatedLabel: 'Updated',
    avgLabel: 'Average price today',
    vsYesterday: 'vs yesterday',
    vs7d: 'vs 7 days ago',
    top3Label: 'Top 3 cheapest stations',
    trendLabel: 'Historical price trend',
    trendEmpty: 'History is being collected: the chart fills in day by day.',
    faqTitle: 'Frequently asked questions',
    regionalLabel: 'All of Ticino',
    archiveLabel: 'Monthly archive',
    breadcrumbHome: 'Home',
    currencyLabel: 'CHF/litre',
    dataUnavailableNote: 'Baseline data still being collected: the comparison needs at least two daily snapshots. ',
    dataUnavailableLinkLabel: 'See the full cross-border fuel price history',
    periodAvgUnavailableNote: 'Seven-day average not available yet: the history fills in day by day.',
    periodAvgLabel: '7-day average',
    chartAriaLabel: (f, z, avgFmt) =>
      `Historical ${f.toLowerCase()} price trend in ${z}: average ${avgFmt} CHF/litre over the selected range.`,
    faq: [
      {
        q: 'How often is the price updated?',
        a: (f, z) =>
          `The ${f.toLowerCase()} price in ${z} is updated daily. Data is sourced from TCS Benzinpreis, which aggregates real-time station listings across Switzerland.`,
      },
      {
        q: 'Is it cheaper to refuel in Italy or in Switzerland?',
        a: () =>
          'It depends on today\'s price and the Italian fuel price: compare this page to the Italian price in our cross-border fuel comparator. Italy is usually cheaper per litre, but Switzerland offers 24/7 self-service even in rural spots.',
      },
      {
        q: 'Where do the listed station prices come from?',
        a: () =>
          'Prices are collected from TCS Benzinpreis (Touring Club Switzerland), which aggregates official fuel station listings across the country. Our pipeline maps them by Ticino zone and publishes them every day.',
      },
    ],
  },
  de: {
    regionalH1: (f) => `${f}preis Schweiz heute — Tessin`,
    zoneH1: (f, z) => `${f}preis heute in ${z}`,
    intro: (f, z, priceFmt, date) =>
      `Aktualisiert am ${date}: der durchschnittliche ${f}preis in ${z} beträgt ${priceFmt} CHF pro Liter. Daten von Schweizer Tankstellen (TCS Benzinpreis) innerhalb von 20 km Grenzdistanz.`,
    paragraph: (f, z, price, dYest, d7) =>
      `Heute kostet ${f} in ${z} durchschnittlich ${price} CHF pro Liter, ${dYest} gegenüber gestern und ${d7} gegenüber vor 7 Tagen. Diese Seite wird jeden Morgen automatisch mit den frischesten Preisdaten der Tankstellen in der Region neu erzeugt. Vergleichen Sie die drei günstigsten Tankstellen und prüfen Sie den Wochentrend, bevor Sie im Rahmen Ihres Grenzgänger-Alltags tanken.`,
    historySection:
      'Das folgende Diagramm zeigt den Preisverlauf über die Zeit — hilfreich, um zu entscheiden, ob Sie heute tanken oder warten. Mit den Buttons wechseln Sie den Zeitraum (1 Monat, 3 Monate, 6 Monate, 1 Jahr, 5 Jahre). Die Historie baut sich Tag für Tag auf: längere Zeiträume werden verfügbar, sobald wir mehr Daten erfassen.',
    updatedLabel: 'Aktualisiert',
    avgLabel: 'Durchschnittspreis heute',
    vsYesterday: 'vs gestern',
    vs7d: 'vs 7 Tage',
    top3Label: 'Top 3 günstigste Tankstellen',
    trendLabel: 'Historischer Preisverlauf',
    trendEmpty: 'Historie wird aufgebaut: das Diagramm füllt sich Tag für Tag.',
    faqTitle: 'Häufige Fragen',
    regionalLabel: 'Ganzes Tessin',
    archiveLabel: 'Monatsarchiv',
    breadcrumbHome: 'Startseite',
    currencyLabel: 'CHF/Liter',
    dataUnavailableNote: 'Basis-Datensatz wird aufgebaut: der Vergleich benötigt mindestens zwei Tagesschnappschüsse. ',
    dataUnavailableLinkLabel: 'Vollständige Treibstoffpreis-Historie an der Grenze ansehen',
    periodAvgUnavailableNote: '7-Tage-Durchschnitt noch nicht verfügbar: die Historie baut sich Tag für Tag auf.',
    periodAvgLabel: '7-Tage-Durchschnitt',
    chartAriaLabel: (f, z, avgFmt) =>
      `Historischer Preisverlauf für ${f} in ${z}: Durchschnitt ${avgFmt} CHF/Liter im ausgewählten Zeitraum.`,
    faq: [
      {
        q: 'Wie oft wird der Preis aktualisiert?',
        a: (f, z) =>
          `Der ${f}preis in ${z} wird täglich aktualisiert. Die Daten stammen von TCS Benzinpreis, das die Preise der Schweizer Tankstellen in Echtzeit aggregiert.`,
      },
      {
        q: 'Ist Tanken in Italien oder in der Schweiz günstiger?',
        a: () =>
          'Das hängt vom aktuellen Preis und vom italienischen Treibstoffpreis ab: Vergleichen Sie diese Seite mit dem italienischen Preis im grenzüberschreitenden Treibstoffvergleich. In Italien ist der Liter meist günstiger, die Schweiz bietet dafür 24/7-Selbstbedienung auch in ländlichen Gegenden.',
      },
      {
        q: 'Woher kommen die aufgeführten Tankstellenpreise?',
        a: () =>
          'Die Preise werden von TCS Benzinpreis (Touring Club Schweiz) erhoben, das offizielle Tankstellendaten in der ganzen Schweiz bündelt. Unsere Pipeline ordnet sie nach Tessiner Zone zu und publiziert sie täglich.',
      },
    ],
  },
  fr: {
    regionalH1: (f) => `Prix du ${f.toLowerCase()} en Suisse aujourd'hui — Tessin`,
    zoneH1: (f, z) => `Prix du ${f.toLowerCase()} aujourd'hui à ${z}`,
    intro: (f, z, priceFmt, date) =>
      `Mis à jour le ${date} : le prix moyen du ${f.toLowerCase()} à ${z} est de ${priceFmt} CHF par litre. Données provenant des stations suisses (TCS Benzinpreis) à moins de 20 km de la frontière italienne.`,
    paragraph: (f, z, price, dYest, d7) =>
      `Aujourd'hui à ${z} le ${f.toLowerCase()} coûte ${price} CHF par litre en moyenne, ${dYest} par rapport à hier et ${d7} par rapport à il y a 7 jours. Cette page est régénérée chaque matin avec les données les plus récentes des stations de la région. Comparez les trois stations les moins chères et consultez la tendance hebdomadaire avant de faire le plein lors de votre trajet frontalier.`,
    historySection:
      "Le graphique ci-dessous montre l'évolution du prix dans le temps — utile pour décider si faire le plein aujourd'hui ou attendre. Utilisez les boutons pour changer la période (1 mois, 3 mois, 6 mois, 1 an, 5 ans). L'historique se construit jour après jour : les périodes plus longues deviennent disponibles au fil du temps.",
    updatedLabel: 'Mis à jour',
    avgLabel: 'Prix moyen aujourd\'hui',
    vsYesterday: 'vs hier',
    vs7d: 'vs 7 jours',
    top3Label: 'Top 3 stations les moins chères',
    trendLabel: 'Tendance historique du prix',
    trendEmpty: 'Historique en cours de construction : le graphique se remplit jour par jour.',
    faqTitle: 'Questions fréquentes',
    regionalLabel: 'Tout le Tessin',
    archiveLabel: 'Archive mensuelle',
    breadcrumbHome: 'Accueil',
    currencyLabel: 'CHF/litre',
    dataUnavailableNote: "Base de données en construction : la comparaison nécessite au moins deux clichés quotidiens. ",
    dataUnavailableLinkLabel: "Voir l'historique complet des prix aux frontières",
    periodAvgUnavailableNote: "Moyenne 7 jours pas encore disponible : l'historique se remplit jour après jour.",
    periodAvgLabel: 'Moyenne 7 jours',
    chartAriaLabel: (f, z, avgFmt) =>
      `Tendance historique du prix du ${f.toLowerCase()} à ${z} : moyenne ${avgFmt} CHF/litre sur la période sélectionnée.`,
    faq: [
      {
        q: 'À quelle fréquence le prix est-il mis à jour ?',
        a: (f, z) =>
          `Le prix du ${f.toLowerCase()} à ${z} est mis à jour chaque jour. Les données proviennent de TCS Benzinpreis, qui agrège en temps réel les tarifs des stations en Suisse.`,
      },
      {
        q: 'Est-il plus avantageux de faire le plein en Italie ou en Suisse ?',
        a: () =>
          "Cela dépend du prix du jour et du prix italien : comparez cette page avec le prix italien dans notre comparateur transfrontalier. L'Italie est généralement moins chère au litre, mais la Suisse propose du self-service 24/7 même en zone rurale.",
      },
      {
        q: 'D\'où proviennent les prix des stations ?',
        a: () =>
          "Les prix proviennent de TCS Benzinpreis (Touring Club Suisse), qui centralise les tarifs officiels des stations de toute la Suisse. Notre pipeline les regroupe par zone tessinoise et les publie chaque jour.",
      },
    ],
  },
};

// ── Page builder ───────────────────────────────────────────────

interface PageInputs {
  locale: FuelDailyLocale;
  fuel: FuelType;
  zone: FuelZone | null;
  /** Dataset for today's prices */
  dataset: FuelPricesDataset;
  /** History snapshots (sorted asc by date) */
  history: HistorySnapshot[];
  /** Canonical URL path (no origin), with trailing slash */
  canonicalPath: string;
  /** Datestamp (UTC YYYY-MM-DD) */
  today: Date;
  /** Precomputed alternates: map from locale → path */
  alternates: Record<FuelDailyLocale, string>;
  /** dist directory for entry-asset resolution (omit in tests). */
  distDir?: string;
  /** Repository root — enables `public/images/brands/*.png` lookup for station logos. */
  rootDir?: string;
}

const LOCALE_OG: Record<FuelDailyLocale, string> = {
  it: 'it_IT',
  en: 'en_US',
  de: 'de_DE',
  fr: 'fr_FR',
};

const FUEL_PRODUCT_IMAGE_URL = `${BASE_URL}/og-image.png`;

function buildFuelOfferSchema(price: number, canonicalUrl: string, today: Date) {
  return {
    '@type': 'Offer',
    priceCurrency: 'CHF',
    price: price.toFixed(3),
    priceValidUntil: new Date(today.getTime() + 24 * 3600 * 1000).toISOString().slice(0, 10),
    availability: 'https://schema.org/InStoreOnly',
    itemCondition: 'https://schema.org/NewCondition',
    url: canonicalUrl,
    shippingDetails: {
      '@type': 'OfferShippingDetails',
      shippingRate: {
        '@type': 'MonetaryAmount',
        value: 0,
        currency: 'CHF',
      },
      shippingDestination: {
        '@type': 'DefinedRegion',
        addressCountry: 'CH',
      },
      // Fuel is sold on-site only, so we model pickup-like same-day fulfillment.
      deliveryTime: {
        '@type': 'ShippingDeliveryTime',
        handlingTime: {
          '@type': 'QuantitativeValue',
          minValue: 0,
          maxValue: 0,
          unitCode: 'DAY',
        },
        transitTime: {
          '@type': 'QuantitativeValue',
          minValue: 0,
          maxValue: 0,
          unitCode: 'DAY',
        },
      },
    },
    hasMerchantReturnPolicy: {
      '@type': 'MerchantReturnPolicy',
      applicableCountry: 'CH',
      returnPolicyCategory: 'https://schema.org/MerchantReturnNotPermitted',
    },
  };
}

function buildFuelCollectionBrand(locale: FuelDailyLocale, zoneLabel: string): string {
  if (locale === 'it') return `Stazioni carburante ${zoneLabel}`;
  if (locale === 'de') return `Tankstellen ${zoneLabel}`;
  if (locale === 'fr') return `Stations-service ${zoneLabel}`;
  return `${zoneLabel} fuel stations`;
}

function clampRating(value: number): number {
  return Number(Math.min(5, Math.max(1, value)).toFixed(1));
}

function formatRatingValue(value: number, locale: FuelDailyLocale): string {
  const base = value.toFixed(1);
  return locale === 'it' || locale === 'fr' ? base.replace('.', ',') : base;
}

interface EditorialAssessment {
  heading: string;
  body: string;
  ratingValue: number;
}

function buildDailyEditorialAssessment(
  locale: FuelDailyLocale,
  fuelLabel: string,
  zoneLabel: string,
  priceFmt: string,
  deltaYest: number | null,
  delta7: number | null,
  cheapestCount: number,
): EditorialAssessment {
  const dayTrend =
    deltaYest === null ? 'unknown' : deltaYest <= 0 ? 'stable_or_down' : 'up';
  const weekTrend =
    delta7 === null ? 'unknown' : delta7 <= 0 ? 'stable_or_down' : 'up';
  const score = clampRating(
    4.2 +
      (dayTrend === 'stable_or_down' ? 0.2 : dayTrend === 'up' ? -0.1 : 0) +
      (weekTrend === 'stable_or_down' ? 0.2 : weekTrend === 'up' ? -0.1 : 0) +
      (cheapestCount >= 3 ? 0.1 : 0),
  );
  const scoreFmt = formatRatingValue(score, locale);

  if (locale === 'it') {
    return {
      heading: 'Valutazione editoriale del prezzo di oggi',
      body: `Frontaliere Ticino assegna ${scoreFmt}/5 al prezzo medio del ${fuelLabel.toLowerCase()} a ${zoneLabel}: oggi il livello è ${dayTrend === 'stable_or_down' ? 'stabile o in calo rispetto a ieri' : dayTrend === 'up' ? 'in aumento rispetto a ieri' : 'ancora senza confronto vs ieri'} e ${weekTrend === 'stable_or_down' ? 'resta competitivo anche sul confronto con 7 giorni fa' : weekTrend === 'up' ? 'risulta meno competitivo rispetto a 7 giorni fa' : 'ha uno storico settimanale ancora limitato'}. La valutazione combina prezzo medio di giornata (${priceFmt} CHF/litro), direzione del trend recente e presenza di stazioni economiche nella short list locale.`,
      ratingValue: score,
    };
  }
  if (locale === 'de') {
    return {
      heading: 'Redaktionelle Bewertung des heutigen Preises',
      body: `Frontaliere Ticino vergibt ${scoreFmt}/5 für den durchschnittlichen ${fuelLabel}preis in ${zoneLabel}: heute ist das Niveau ${dayTrend === 'stable_or_down' ? 'stabil oder niedriger als gestern' : dayTrend === 'up' ? 'höher als gestern' : 'noch nicht mit gestern vergleichbar'} und ${weekTrend === 'stable_or_down' ? 'bleibt auch im 7-Tage-Vergleich wettbewerbsfähig' : weekTrend === 'up' ? 'ist im Vergleich zu vor 7 Tagen weniger attraktiv' : 'hat noch wenig Wochenhistorie'}. Die Bewertung kombiniert Tagesdurchschnitt (${priceFmt} CHF/Liter), kurzfristige Trendrichtung und die Präsenz günstiger Stationen in der lokalen Auswahl.`,
      ratingValue: score,
    };
  }
  if (locale === 'fr') {
    return {
      heading: "Évaluation éditoriale du prix du jour",
      body: `Frontaliere Ticino attribue ${scoreFmt}/5 au prix moyen du ${fuelLabel.toLowerCase()} à ${zoneLabel} : aujourd'hui le niveau est ${dayTrend === 'stable_or_down' ? 'stable ou en baisse par rapport à hier' : dayTrend === 'up' ? "en hausse par rapport à hier" : "encore sans comparaison avec hier"} et ${weekTrend === 'stable_or_down' ? 'reste compétitif sur 7 jours' : weekTrend === 'up' ? 'est moins compétitif qu’il y a 7 jours' : 'dispose encore de peu d’historique hebdomadaire'}. L’évaluation combine le prix moyen du jour (${priceFmt} CHF/litre), la direction récente de la tendance et la présence de stations avantageuses dans la sélection locale.`,
      ratingValue: score,
    };
  }
  return {
    heading: "Editorial assessment for today's price",
    body: `Frontaliere Ticino assigns ${scoreFmt}/5 to the average ${fuelLabel.toLowerCase()} price in ${zoneLabel}: today's level is ${dayTrend === 'stable_or_down' ? 'stable or down vs yesterday' : dayTrend === 'up' ? 'up vs yesterday' : 'not yet comparable with yesterday'} and ${weekTrend === 'stable_or_down' ? 'still competitive against the 7-day comparison' : weekTrend === 'up' ? 'less competitive than 7 days ago' : 'still building weekly history'}. The assessment combines the current daily average (${priceFmt} CHF/litre), recent trend direction and the presence of low-price stations in the local shortlist.`,
    ratingValue: score,
  };
}

function buildStationEditorialAssessment(
  locale: FuelDailyLocale,
  fuelLabel: string,
  brandDisplay: string,
  city: string,
  priceFmt: string,
  zoneAvgFmt: string,
  rankIndex: number,
  total: number,
  deltaZone: number | null,
): EditorialAssessment {
  let score = 4.0;
  if (rankIndex === 0) score += 0.8;
  else if (rankIndex <= 2) score += 0.6;
  else if (rankIndex <= 5) score += 0.3;
  else score += 0.1;
  if (deltaZone !== null) score += deltaZone <= 0 ? 0.2 : -0.2;
  score = clampRating(score);
  const scoreFmt = formatRatingValue(score, locale);
  const rankText = `${rankIndex + 1}/${total}`;

  if (locale === 'it') {
    return {
      heading: 'Recensione editoriale della stazione',
      body: `Frontaliere Ticino assegna ${scoreFmt}/5 a ${brandDisplay} ${city} per il ${fuelLabel.toLowerCase()}: oggi la stazione è in posizione ${rankText} nel ranking locale, con prezzo ${priceFmt} CHF/litro contro una media zona di ${zoneAvgFmt} CHF/litro. Il giudizio riflette competitività di prezzo giornaliera e posizionamento della stazione rispetto alle alternative vicine.`,
      ratingValue: score,
    };
  }
  if (locale === 'de') {
    return {
      heading: 'Redaktionelle Bewertung der Tankstelle',
      body: `Frontaliere Ticino vergibt ${scoreFmt}/5 an ${brandDisplay} ${city} für ${fuelLabel}: heute liegt die Station auf Rang ${rankText} im lokalen Vergleich, mit einem Preis von ${priceFmt} CHF/Liter gegenüber einem Zonendurchschnitt von ${zoneAvgFmt} CHF/Liter. Das Urteil spiegelt die Preiswettbewerbsfähigkeit des Tages und die Position der Station gegenüber nahen Alternativen wider.`,
      ratingValue: score,
    };
  }
  if (locale === 'fr') {
    return {
      heading: 'Évaluation éditoriale de la station',
      body: `Frontaliere Ticino attribue ${scoreFmt}/5 à ${brandDisplay} ${city} pour le ${fuelLabel.toLowerCase()} : aujourd'hui la station occupe la position ${rankText} dans le classement local, avec un prix de ${priceFmt} CHF/litre contre une moyenne de zone de ${zoneAvgFmt} CHF/litre. Cette note reflète la compétitivité du prix du jour et le positionnement de la station face aux alternatives proches.`,
      ratingValue: score,
    };
  }
  return {
    heading: 'Editorial station review',
    body: `Frontaliere Ticino assigns ${scoreFmt}/5 to ${brandDisplay} ${city} for ${fuelLabel.toLowerCase()}: today the station ranks ${rankText} in the local comparison, with a price of ${priceFmt} CHF/litre versus a zone average of ${zoneAvgFmt} CHF/litre. The score reflects day-of-price competitiveness and the station's position against nearby alternatives.`,
    ratingValue: score,
  };
}

// ── Multi-range area chart (Recharts-style, 1M/3M/6M/1Y/5Y selector) ──
//
// Replaces the legacy 7-day sparkline on /oggi pages. Renders 5 chart
// variants (one per range) server-side and toggles visibility via a tiny
// inline IIFE — no external JS bundle needed.

type FuelRangeKey = '1M' | '3M' | '6M' | '1Y' | '5Y';
const FUEL_RANGE_KEYS: ReadonlyArray<FuelRangeKey> = ['1M', '3M', '6M', '1Y', '5Y'];
const FUEL_RANGE_DAYS: Record<FuelRangeKey, number> = {
  '1M': 30,
  '3M': 90,
  '6M': 180,
  '1Y': 365,
  '5Y': 1825,
};
const FUEL_DEFAULT_RANGE: FuelRangeKey = '6M';

const FUEL_RANGE_BUTTON_LABEL: Record<FuelDailyLocale, Record<FuelRangeKey, string>> = {
  it: { '1M': '1M', '3M': '3M', '6M': '6M', '1Y': '1A', '5Y': '5A' },
  en: { '1M': '1M', '3M': '3M', '6M': '6M', '1Y': '1Y', '5Y': '5Y' },
  de: { '1M': '1M', '3M': '3M', '6M': '6M', '1Y': '1J', '5Y': '5J' },
  fr: { '1M': '1M', '3M': '3M', '6M': '6M', '1Y': '1A', '5Y': '5A' },
};

const FUEL_STAT_LABELS: Record<FuelDailyLocale, { min: string; avg: string; max: string }> = {
  it: { min: 'Min', avg: 'Media', max: 'Max' },
  en: { min: 'Min', avg: 'Avg', max: 'Max' },
  de: { min: 'Min', avg: 'Ø', max: 'Max' },
  fr: { min: 'Min', avg: 'Moy.', max: 'Max' },
};

const FUEL_RANGE_EMPTY_MSG: Record<FuelDailyLocale, string> = {
  it: 'Storico non ancora disponibile per questo intervallo. Il grafico si popola giorno per giorno.',
  en: 'No history yet for this range. The chart fills in day by day.',
  de: 'Für diesen Zeitraum noch keine Historie. Das Diagramm baut sich Tag für Tag auf.',
  fr: "Pas encore d'historique pour cette période. Le graphique se construit jour après jour.",
};

interface FuelSeriesPoint {
  readonly date: string; // YYYY-MM-DD
  readonly value: number; // CHF/litre
}

function buildFuelHistorySeries(
  history: HistorySnapshot[],
  zone: FuelZone | null,
  fuel: FuelType,
  rangeDays: number,
  today: Date,
  todayAvg: number | null,
): FuelSeriesPoint[] {
  const cutoff = new Date(today.getTime() - rangeDays * 24 * 60 * 60 * 1000);
  const cutoffKey = cutoff.toISOString().slice(0, 10);
  const todayKey = today.toISOString().slice(0, 10);
  const points: FuelSeriesPoint[] = [];
  for (const snap of history) {
    if (snap.date < cutoffKey || snap.date >= todayKey) continue;
    const src = zone ? snap.zones?.[zone] : snap.regional;
    const v = src?.[fuel];
    if (typeof v === 'number' && Number.isFinite(v)) {
      points.push({ date: snap.date, value: Number(v.toFixed(3)) });
    }
  }
  if (typeof todayAvg === 'number' && Number.isFinite(todayAvg)) {
    points.push({ date: todayKey, value: Number(todayAvg.toFixed(3)) });
  }
  points.sort((a, b) => a.date.localeCompare(b.date));
  return points;
}

function formatFuelDateShort(iso: string, locale: FuelDailyLocale): string {
  // YYYY-MM-DD → DD/MM (it/fr/de) or M/D (en)
  const parts = iso.split('-');
  if (parts.length !== 3) return iso;
  const dn = parseInt(parts[2], 10);
  const mn = parseInt(parts[1], 10);
  if (locale === 'en') return `${mn}/${dn}`;
  return `${dn}/${mn}`;
}

interface FuelChartDims {
  readonly width: number;
  readonly height: number;
  readonly padLeft: number;
  readonly padRight: number;
  readonly padTop: number;
  readonly padBottom: number;
}

const FUEL_CHART_DIMS: FuelChartDims = {
  width: 600,
  height: 360,
  padLeft: 56,
  padRight: 16,
  padTop: 16,
  padBottom: 32,
};

function renderFuelAreaChartSvg(opts: {
  readonly series: ReadonlyArray<FuelSeriesPoint>;
  readonly rangeKey: FuelRangeKey;
  readonly ariaLabel: string;
  readonly locale: FuelDailyLocale;
  readonly formatValue: (v: number) => string;
}): string {
  const { series, rangeKey, ariaLabel, locale, formatValue } = opts;
  const dims = FUEL_CHART_DIMS;
  const plotW = dims.width - dims.padLeft - dims.padRight;
  const plotH = dims.height - dims.padTop - dims.padBottom;

  if (series.length < 2) {
    return `<svg role="img" aria-label="${esc(ariaLabel)}" viewBox="0 0 ${dims.width} ${dims.height}" preserveAspectRatio="xMidYMid meet" style="width:100%;height:auto;display:block">
      <rect x="${dims.padLeft}" y="${dims.padTop}" width="${plotW}" height="${plotH}" fill="var(--color-surface-muted)" rx="8"></rect>
      <text x="${dims.padLeft + plotW / 2}" y="${dims.padTop + plotH / 2}" text-anchor="middle" dominant-baseline="middle"
        style="font:13px system-ui,-apple-system,Segoe UI,Roboto,sans-serif;fill:var(--color-subtle)">${esc(FUEL_RANGE_EMPTY_MSG[locale])}</text>
    </svg>`;
  }

  const values = series.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  const pad = span > 0 ? span * 0.08 : Math.max(0.005, Math.abs(max) * 0.01);
  const yMin = min - pad;
  const yMax = max + pad;
  const yRange = yMax - yMin || 1;

  const n = series.length;
  const xStep = n > 1 ? plotW / (n - 1) : 0;
  const coords = series.map((p, i) => ({
    x: dims.padLeft + i * xStep,
    y: dims.padTop + (1 - (p.value - yMin) / yRange) * plotH,
    value: p.value,
    date: p.date,
  }));

  const linePath = coords
    .map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x.toFixed(1)} ${c.y.toFixed(1)}`)
    .join(' ');
  const baseY = dims.padTop + plotH;
  const areaPath = `${linePath} L${coords[coords.length - 1].x.toFixed(1)} ${baseY.toFixed(1)} L${coords[0].x.toFixed(1)} ${baseY.toFixed(1)} Z`;

  const Y_TICKS = 5;
  const yTicks: Array<{ y: number; v: number }> = [];
  for (let i = 0; i < Y_TICKS; i++) {
    const v = yMin + (yRange * i) / (Y_TICKS - 1);
    const y = dims.padTop + (1 - (v - yMin) / yRange) * plotH;
    yTicks.push({ y, v });
  }

  const X_TICK_COUNT = Math.min(7, Math.max(2, n));
  const xTickIndices = new Set<number>();
  for (let i = 0; i < X_TICK_COUNT; i++) {
    xTickIndices.add(Math.round(((n - 1) * i) / Math.max(1, X_TICK_COUNT - 1)));
  }
  const xTicks = Array.from(xTickIndices)
    .sort((a, b) => a - b)
    .map((idx) => coords[idx]);

  const gradientId = `fuelGradient-${rangeKey}-${zone_safe(rangeKey)}`;
  const tickStyle =
    'font:11px system-ui,-apple-system,Segoe UI,Roboto,sans-serif;fill:var(--color-chart-label);font-variant-numeric:tabular-nums';

  const yGridLines = yTicks
    .map(
      (t) =>
        `<line x1="${dims.padLeft}" x2="${dims.width - dims.padRight}" y1="${t.y.toFixed(1)}" y2="${t.y.toFixed(1)}" stroke="var(--color-chart-grid)" stroke-width="1" stroke-dasharray="3 3" opacity="0.5"></line>`,
    )
    .join('');
  const yLabels = yTicks
    .map(
      (t) =>
        `<text x="${(dims.padLeft - 6).toFixed(0)}" y="${t.y.toFixed(1)}" text-anchor="end" dominant-baseline="middle" style="${tickStyle}">${esc(formatValue(t.v))}</text>`,
    )
    .join('');
  const xGridLines = xTicks
    .map(
      (t) =>
        `<line x1="${t.x.toFixed(1)}" x2="${t.x.toFixed(1)}" y1="${dims.padTop}" y2="${(dims.padTop + plotH).toFixed(1)}" stroke="var(--color-chart-grid)" stroke-width="1" stroke-dasharray="3 3" opacity="0.3"></line>`,
    )
    .join('');
  const xLabels = xTicks
    .map(
      (t) =>
        `<text x="${t.x.toFixed(1)}" y="${(dims.padTop + plotH + 18).toFixed(1)}" text-anchor="middle" style="${tickStyle}">${esc(formatFuelDateShort(t.date, locale))}</text>`,
    )
    .join('');

  return `<svg role="img" aria-label="${esc(ariaLabel)}" viewBox="0 0 ${dims.width} ${dims.height}" preserveAspectRatio="xMidYMid meet" style="width:100%;height:auto;display:block">
    <defs>
      <linearGradient id="${gradientId}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="5%" stop-color="var(--color-chart-area)" stop-opacity="0.35"></stop>
        <stop offset="95%" stop-color="var(--color-chart-area)" stop-opacity="0"></stop>
      </linearGradient>
    </defs>
    ${yGridLines}
    ${xGridLines}
    <path d="${areaPath}" fill="url(#${gradientId})" stroke="none"></path>
    <path d="${linePath}" fill="none" stroke="var(--color-chart-line)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path>
    ${yLabels}
    ${xLabels}
  </svg>`;
}

// Defensive id-suffix sanitiser — guarantees the gradient id stays valid even
// if rangeKey ever drifts (no-op for the current 1M/3M/6M/1Y/5Y set).
function zone_safe(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '');
}

function computeFuelStats(
  series: ReadonlyArray<FuelSeriesPoint>,
): { min: number; avg: number; max: number } | null {
  if (series.length === 0) return null;
  const values = series.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  return { min, avg, max };
}

/**
 * Build a per-range series map for Italian curated cities. Reads the
 * `italianCities[citySlug].benzina` field on each daily snapshot.
 * Mirrors buildFuelHistorySeries but with EUR data and no zone fallback
 * (Italian snapshots are city-keyed, not zone-keyed).
 */
function buildItalianHistorySeries(
  history: HistorySnapshot[],
  citySlug: string,
  rangeDays: number,
  today: Date,
  todayAvg: number | null,
): FuelSeriesPoint[] {
  const cutoff = new Date(today.getTime() - rangeDays * 24 * 60 * 60 * 1000);
  const cutoffKey = cutoff.toISOString().slice(0, 10);
  const todayKey = today.toISOString().slice(0, 10);
  const points: FuelSeriesPoint[] = [];
  for (const snap of history) {
    if (snap.date < cutoffKey || snap.date >= todayKey) continue;
    const v = snap.italianCities?.[citySlug]?.benzina;
    if (typeof v === 'number' && Number.isFinite(v)) {
      points.push({ date: snap.date, value: Number(v.toFixed(3)) });
    }
  }
  if (typeof todayAvg === 'number' && Number.isFinite(todayAvg)) {
    points.push({ date: todayKey, value: Number(todayAvg.toFixed(3)) });
  }
  points.sort((a, b) => a.date.localeCompare(b.date));
  return points;
}

function renderFuelHistoryCard(opts: {
  readonly locale: FuelDailyLocale;
  /** Aria-label for the section's role=tablist wrapper. */
  readonly trendLabel: string;
  /** Per-chart aria-label callback receiving the formatted period average. */
  readonly buildAriaLabel: (avgFmt: string) => string;
  /** Per-range series (caller pre-computes for the appropriate data source). */
  readonly seriesByRange: Record<FuelRangeKey, FuelSeriesPoint[]>;
  /** Currency suffix for the Min/Avg/Max footer. Default 'CHF'. */
  readonly currency?: string;
}): string {
  const { locale, trendLabel, buildAriaLabel, seriesByRange, currency = 'CHF' } = opts;
  const formatValue = (v: number): string => formatPrice(v, locale);
  const stats = FUEL_STAT_LABELS[locale];

  const variants = FUEL_RANGE_KEYS.map((rk) => {
    const series = seriesByRange[rk] ?? [];
    const stat = computeFuelStats(series);
    const avgLabel = stat ? formatValue(stat.avg) : '—';
    const ariaLabel = buildAriaLabel(avgLabel);
    const svg = renderFuelAreaChartSvg({
      series,
      rangeKey: rk,
      ariaLabel,
      locale,
      formatValue,
    });
    return { rangeKey: rk, svg, stat };
  });

  const buttonsHtml = FUEL_RANGE_KEYS.map((rk) => {
    const isActive = rk === FUEL_DEFAULT_RANGE;
    const baseStyle =
      'border:0;cursor:pointer;padding:6px 12px;border-radius:8px;font:600 12px system-ui,-apple-system,Segoe UI,Roboto,sans-serif;transition:background-color 0.15s,color 0.15s';
    const activeStyle = 'background:var(--color-success-strong);color:var(--color-on-accent)';
    const inactiveStyle = 'background:var(--color-surface-raised);color:var(--color-subtle)';
    return `<button type="button" data-range-btn="${rk}" aria-pressed="${isActive ? 'true' : 'false'}" style="${baseStyle};${isActive ? activeStyle : inactiveStyle}">${esc(FUEL_RANGE_BUTTON_LABEL[locale][rk])}</button>`;
  }).join('');

  const variantsHtml = variants
    .map(
      (v) =>
        `<div data-range-content="${v.rangeKey}" style="display:${v.rangeKey === FUEL_DEFAULT_RANGE ? 'block' : 'none'}">${v.svg}</div>`,
    )
    .join('');

  const formatStatVal = (n: number): string => `${formatValue(n)} ${currency}`;
  const statsVariantsHtml = variants
    .map((v) => {
      const visible = v.rangeKey === FUEL_DEFAULT_RANGE;
      const inner = v.stat
        ? `<span><strong>${esc(stats.min)}:</strong> ${esc(formatStatVal(v.stat.min))}</span><span><strong>${esc(stats.avg)}:</strong> ${esc(formatStatVal(v.stat.avg))}</span><span><strong>${esc(stats.max)}:</strong> ${esc(formatStatVal(v.stat.max))}</span>`
        : `<span style="color:var(--color-subtle)">—</span>`;
      return `<div data-range-stats="${v.rangeKey}" style="display:${visible ? 'flex' : 'none'};justify-content:space-between;gap:8px;margin-top:14px;font:500 12px system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:var(--color-subtle);min-height:20px">${inner}</div>`;
    })
    .join('');

  const cardStyle =
    'background:var(--color-surface);border:1px solid var(--color-edge);border-radius:16px;padding:20px;box-shadow:0 1px 2px rgba(0,0,0,0.04);max-width:720px;margin:0 0 14px';
  const headerStyle =
    'display:flex;align-items:center;justify-content:flex-end;flex-wrap:wrap;gap:12px;margin-bottom:14px';
  const buttonsRowStyle = 'display:flex;gap:6px;flex-wrap:wrap';

  // Inline IIFE to wire up the range selector. Reads data-range-btn / data-range-content
  // / data-range-stats attributes; flips visibility + button styling on click.
  const script = `<script>(function(){
    var root = document.currentScript.previousElementSibling;
    if(!root) return;
    var btns = root.querySelectorAll('[data-range-btn]');
    var contents = root.querySelectorAll('[data-range-content]');
    var statsEls = root.querySelectorAll('[data-range-stats]');
    function setActive(r){
      btns.forEach(function(b){
        var on = b.getAttribute('data-range-btn') === r;
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
        if(on){
          b.style.background = 'var(--color-success-strong)';
          b.style.color = 'var(--color-on-accent)';
        } else {
          b.style.background = 'var(--color-surface-raised)';
          b.style.color = 'var(--color-subtle)';
        }
      });
      contents.forEach(function(c){
        c.style.display = c.getAttribute('data-range-content') === r ? 'block' : 'none';
      });
      statsEls.forEach(function(s){
        s.style.display = s.getAttribute('data-range-stats') === r ? 'flex' : 'none';
      });
    }
    btns.forEach(function(b){
      b.addEventListener('click', function(){ setActive(b.getAttribute('data-range-btn')); });
    });
  })();</script>`;

  return `<div data-fuel-history-chart style="${cardStyle}">
    <div style="${headerStyle}">
      <div style="${buttonsRowStyle}" role="tablist" aria-label="${esc(trendLabel)}">${buttonsHtml}</div>
    </div>
    <div data-fuel-history-charts>${variantsHtml}</div>
    ${statsVariantsHtml}
  </div>${script}`;
}

function renderPage(inp: PageInputs): string {
  const { locale, fuel, zone, dataset, history, canonicalPath, today, alternates, distDir, rootDir } = inp;
  const copy = COPY[locale];
  const fuelLabel = FUEL_TYPE_LABEL[locale][fuel];
  const zoneLabel = zone ? FUEL_ZONE_DISPLAY[zone] : copy.regionalLabel;
  const dateStamp = today.toISOString().slice(0, 10);

  // Compute today's price for this zone/region
  const stations = zone ? collectZoneStations(dataset, zone) : collectAllStations(dataset);
  const zonePrice = computeZonePrice(stations, fuel);
  const avg = zonePrice.avg;

  const yesterday = lookbackPrice(history, zone, fuel, 1, today);
  const weekAgo = lookbackPrice(history, zone, fuel, 7, today);

  const deltaYest = computeDeltaVsYesterday(avg, yesterday);
  const delta7 = computeDeltaVsYesterday(avg, weekAgo);

  const priceFmt = formatPrice(avg, locale);
  const deltaYestFmt = formatDelta(deltaYest, locale);
  const delta7Fmt = formatDelta(delta7, locale);

  const h1 = zone ? copy.zoneH1(fuelLabel, zoneLabel) : copy.regionalH1(fuelLabel);
  const intro = copy.intro(fuelLabel, zoneLabel, priceFmt, dateStamp);
  const paragraph = copy.paragraph(fuelLabel, zoneLabel, priceFmt, deltaYestFmt, delta7Fmt);
  const historyCopy = copy.historySection;

  const canonicalUrl = `${BASE_URL}${canonicalPath}`;

  // Top 3 stations
  const top3 = zonePrice.minStations;
  const editorialAssessment = buildDailyEditorialAssessment(
    locale,
    fuelLabel,
    zoneLabel,
    priceFmt,
    deltaYest,
    delta7,
    top3.length,
  );
  const stationsHtml = top3.length > 0
    ? `<ol style="list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:10px">${top3
        .map((s) => {
          // On the regional (no-zone) hub, resolve the station's zone from
          // its address so each card still links to its dedicated page.
          const stationZone = zone ?? zoneForAddress(s.address);
          const stationHref = stationZone && s.slug
            ? buildFuelStationPath(locale, fuel, stationZone, s.slug)
            : undefined;
          const brandSlug = (s.brand || '')
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '');
          const logoUrl = rootDir ? resolveBrandLogoUrl(rootDir, brandSlug) : null;
          const card = renderEntityCard({
            href: stationHref,
            logoUrl: logoUrl ?? undefined,
            logoAlt: s.brand || s.name,
            iconSvg: logoUrl ? undefined : ICON_FUEL_SVG,
            title: s.name,
            subtitle: s.address,
            metric: `${formatPrice(s.priceChf, locale)} ${copy.currencyLabel}`,
            metricTone: 'accent',
          });
          return `<li style="margin:0;padding:0">${card}</li>`;
        })
        .join('')}</ol>`
    : `<p style="padding:12px 16px;border-radius:12px;background:var(--color-warning-subtle);color:var(--color-warning)">${esc(copy.trendEmpty)}</p>`;

  // Trend table: last 7 days from history
  const trendRows: Array<{ date: string; price: number | null }> = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 24 * 60 * 60 * 1000);
    const key = d.toISOString().slice(0, 10);
    if (i === 0) {
      trendRows.push({ date: key, price: avg });
    } else {
      const val = lookbackPrice(history, zone, fuel, i, today);
      trendRows.push({ date: key, price: val });
    }
  }

  // Period (7-day) average. Null when fewer than 2 daily snapshots exist in
  // the window — we render an explicit "not available yet" note instead of a
  // hardcoded number. See F2 fix notes in the CHANGELOG.
  const periodAvg = computePeriodAverage(trendRows.map((r) => r.price));
  const periodAvgFmt = formatPrice(periodAvg, locale);

  // Multi-range area chart card (Recharts-style). Renders 1M/3M/6M/1Y/5Y
  // variants server-side; tiny inline JS toggles visibility on button click.
  // Per-range "no data" fallback is rendered inside each empty variant, so
  // we don't need a separate page-level fallback paragraph anymore.
  const swissSeriesByRange = FUEL_RANGE_KEYS.reduce(
    (acc, rk) => {
      acc[rk] = buildFuelHistorySeries(history, zone, fuel, FUEL_RANGE_DAYS[rk], today, avg);
      return acc;
    },
    {} as Record<FuelRangeKey, FuelSeriesPoint[]>,
  );
  const historyCard = renderFuelHistoryCard({
    locale,
    trendLabel: copy.trendLabel,
    buildAriaLabel: (avgFmt) => copy.chartAriaLabel(fuelLabel, zoneLabel, avgFmt),
    seriesByRange: swissSeriesByRange,
    currency: 'CHF',
  });

  const trendTableHtml = `<table style="${TABLE_STYLE};font-size:14px">
    <thead><tr>
      <th scope="col" style="${TABLE_HEAD_STYLE}">${esc(locale === 'it' ? 'Data' : locale === 'de' ? 'Datum' : 'Date')}</th>
      <th scope="col" style="${TABLE_HEAD_STYLE};text-align:right">${esc(copy.avgLabel)}</th>
    </tr></thead>
    <tbody>${trendRows
      .map((r) => `<tr>
        <td style="${TABLE_CELL_STYLE}">${esc(r.date)}</td>
        <td style="${TABLE_CELL_STYLE};text-align:right;font-variant-numeric:tabular-nums">${r.price === null ? '—' : formatPrice(r.price, locale) + ' CHF'}</td>
      </tr>`)
      .join('')}${
        periodAvg !== null
          ? `<tr>
        <th scope="row" style="${TABLE_CELL_STYLE};font-weight:700">${esc(copy.periodAvgLabel)}</th>
        <td style="${TABLE_CELL_STYLE};text-align:right;font-variant-numeric:tabular-nums;font-weight:700">${esc(
              periodAvgFmt,
            )} CHF</td>
      </tr>`
          : ''
      }</tbody>
  </table>`;

  const periodAvgNoteHtml =
    periodAvg === null
      ? `<p style="margin:12px 0 0;padding:10px 12px;border-radius:10px;background:var(--color-warning-subtle);color:var(--color-warning);font-size:13px">${esc(copy.periodAvgUnavailableNote)}</p>`
      : '';

  // "Base dati in costruzione" fallback note — shown when either delta cannot
  // be computed (no yesterday snapshot, or no 7-day-ago snapshot). Links to
  // the long-form stats page where the full history chart lives.
  const statsHref = FUEL_STATS_HUB_PATH[locale];
  const unavailableNoteHtml =
    deltaYest === null || delta7 === null
      ? `<p style="margin:0 0 16px;padding:10px 14px;border-radius:12px;background:var(--color-warning-subtle);border:1px solid var(--color-warning-border);color:var(--color-body);font-size:14px;line-height:1.55">${esc(
          copy.dataUnavailableNote,
        )}<a href="${esc(statsHref)}" style="${LINK_ACCENT_STYLE};font-weight:600">${esc(copy.dataUnavailableLinkLabel)} →</a></p>`
      : '';

  // FAQ section
  const faqItems = copy.faq;
  const faqHtml = `<section style="margin:32px 0 0" aria-labelledby="fuelDailyFaq">
    <h2 id="fuelDailyFaq" style="${H2_STYLE}">${esc(copy.faqTitle)}</h2>
    ${faqItems
      .map(
        (f) => `<details style="${CARD_STYLE};margin-bottom:8px">
        <summary style="font-weight:700;cursor:pointer;color:var(--color-heading)">${esc(f.q)}</summary>
        <p style="margin:10px 0 0;color:var(--color-body);line-height:1.6">${esc(f.a(fuelLabel, zoneLabel))}</p>
      </details>`,
      )
      .join('')}
  </section>`;

  // Alternates — includes x-default pointing at the IT href (shared helper).
  const alternatesHtml = renderHreflangTags(alternates);

  // JSON-LD
  const breadcrumbLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: copy.breadcrumbHome, item: `${BASE_URL}/` },
      { '@type': 'ListItem', position: 2, name: fuelLabel, item: `${BASE_URL}${FUEL_LOCALE_PREFIX[locale]}/${FUEL_SECTION_SLUG[locale][fuel]}/` },
      { '@type': 'ListItem', position: 3, name: zoneLabel, item: canonicalUrl },
    ],
  });

  const faqLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    inLanguage: locale,
    mainEntity: faqItems.map((f) => ({
      '@type': 'Question',
      name: f.q,
      acceptedAnswer: { '@type': 'Answer', text: f.a(fuelLabel, zoneLabel) },
    })),
  });

  const webPageLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: h1,
    url: canonicalUrl,
    description: intro,
    inLanguage: locale,
    dateModified: today.toISOString(),
    datePublished: today.toISOString(),
  });

  // Product LD is intentionally NOT emitted for daily zone pages.
  // Rationale: Google's "Merchant listing" rich-results validator (mirrored in
  // scripts/validate-structured-data-completeness.mjs) requires Product to
  // carry aggregateRating + review — fake review data violates Google's
  // structured-data guidelines and risks a manual action. A daily aggregate
  // price per zone isn't a merchant product anyway; the WebPage + FAQPage +
  // BreadcrumbList already convey enough structure, and the live price is
  // surfaced in the visible page body.

  // Phase 3A — date suffix is informative for users; brand suffix only
  // appended when it still fits the 60-char SERP budget (Semrush W2).
  const titleWithDate = `${h1} (${dateStamp})`;
  const title = clampSiteSuffix(titleWithDate, 'Frontaliere Ticino');
  const description = intro.slice(0, 180);

  // Main body markup (kept plain + inline-styled so we don't depend on the
  // SPA bundle and the static page ranks on its own).
  const bodyHtml = `<article style="max-width:1100px;margin:0 auto;padding:32px 20px 56px">
  <nav style="${BREADCRUMB_STYLE}">
    <a href="${BASE_URL}/" style="${BREADCRUMB_LINK_STYLE}">${esc(copy.breadcrumbHome)}</a>
    <span> / </span>
    <span>${esc(fuelLabel)}</span>
    <span> / </span>
    <span>${esc(zoneLabel)}</span>
  </nav>
  <header style="margin-bottom:22px">
    <p style="${HERO_EYEBROW_STYLE}">${esc(copy.updatedLabel)} · ${dateStamp}</p>
    <h1 style="${H1_STYLE}">${esc(h1)}</h1>
    <p style="${LEDE_STYLE}">${esc(intro)}</p>
  </header>
  <section style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;margin:0 0 24px">
    <div style="${STAT_TILE_ACCENT}">
      <div style="${STAT_TILE_LABEL}">${esc(copy.avgLabel)}</div>
      <div style="${STAT_TILE_VALUE};font-size:32px">${priceFmt}</div>
      <div style="margin-top:2px;font-size:13px;color:var(--color-subtle)">${esc(copy.currencyLabel)}</div>
    </div>
    <div style="${deltaYest === null ? STAT_TILE_BASE : deltaYest < 0 ? STAT_TILE_SUCCESS : deltaYest > 0 ? STAT_TILE_WARNING : STAT_TILE_BASE}">
      <div style="${STAT_TILE_LABEL}">${esc(copy.vsYesterday)}</div>
      <div style="${STAT_TILE_VALUE};font-size:22px">${esc(deltaYestFmt)}</div>
    </div>
    <div style="${delta7 === null ? STAT_TILE_BASE : delta7 < 0 ? STAT_TILE_SUCCESS : delta7 > 0 ? STAT_TILE_WARNING : STAT_TILE_BASE}">
      <div style="${STAT_TILE_LABEL}">${esc(copy.vs7d)}</div>
      <div style="${STAT_TILE_VALUE};font-size:22px">${esc(delta7Fmt)}</div>
    </div>
  </section>
  ${unavailableNoteHtml}
  <section style="margin:0 0 24px">
    <p style="margin:0 0 14px;color:var(--color-body);line-height:1.7;max-width:860px">${esc(paragraph)}</p>
  </section>
  <section style="margin:0 0 24px;${CARD_STYLE}" aria-labelledby="fuelReview">
    <h2 id="fuelReview" style="${H2_STYLE}">${esc(editorialAssessment.heading)}</h2>
    <p style="margin:0;color:var(--color-body);line-height:1.7;max-width:860px">${esc(editorialAssessment.body)}</p>
  </section>
  <section style="margin:0 0 24px" aria-labelledby="top3">
    <h2 id="top3" style="${H2_STYLE}">${esc(copy.top3Label)}</h2>
    ${stationsHtml}
  </section>
  <section style="margin:0 0 24px" aria-labelledby="trend7">
    <h2 id="trend7" style="${H2_STYLE}">${esc(copy.trendLabel)}</h2>
    <p style="margin:0 0 12px;color:var(--color-subtle);line-height:1.6">${esc(historyCopy)}</p>
    ${historyCard}
    ${trendTableHtml}
    ${periodAvgNoteHtml}
  </section>
  ${faqHtml}
  ${renderDiscoverMore(locale, FUEL_DAILY_DISCOVER_MORE_CTAS[locale])}
  ${generateRelatedLinksBlock(locale, 'fuel_daily', { fuelType: fuel, fuelZone: zone ?? undefined, city: zone ?? undefined })}
</article>`;

  // Extra head: OG image dimensions + twitter card — kept for parity with the
  // pre-shell-wrap emission so social-share previews are unchanged.
  const extraHead = `    <meta property="og:image" content="${BASE_URL}/og-image.png">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${esc(title)}">
    <meta name="twitter:description" content="${esc(description)}">
    <meta name="twitter:site" content="@frontaliereticino">`;

  const jsonLdScripts = [breadcrumbLd, webPageLd, faqLd];

  // Word count sanity check (hard-gated later by the caller)
  const html = buildSeoPageHtml({
    locale,
    title,
    description,
    canonicalUrl,
    robots: 'index,follow',
    ogType: 'website',
    ogLocale: LOCALE_OG[locale],
    hreflangHtml: alternatesHtml,
    extraHeadHtml: extraHead,
    jsonLdScripts,
    bodyHtml,
    distDir,
    hubChrome: { hubKey: 'stats', activeSubTab: 'fuel-prices' },
  });

  return html;
}

// ── Month archives ─────────────────────────────────────────────

interface ArchiveInputs {
  locale: FuelDailyLocale;
  fuel: FuelType;
  zone: FuelZone;
  monthKey: string; // YYYY-MM
  snapshots: HistorySnapshot[]; // filtered to the target month
  canonicalPath: string;
  today: Date;
  /** dist directory for entry-asset resolution (omit in tests). */
  distDir?: string;
}

function renderArchive(inp: ArchiveInputs): string {
  const { locale, fuel, zone, monthKey, snapshots, canonicalPath, today, distDir } = inp;
  const copy = COPY[locale];
  const fuelLabel = FUEL_TYPE_LABEL[locale][fuel];
  const zoneLabel = FUEL_ZONE_DISPLAY[zone];
  const canonicalUrl = `${BASE_URL}${canonicalPath}`;

  const rows = snapshots
    .filter((s) => s.date.startsWith(monthKey))
    .map((s) => ({ date: s.date, price: s.zones?.[zone]?.[fuel] ?? null }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const prices = rows.map((r) => r.price).filter((p): p is number => typeof p === 'number');
  const avg = mean(prices);

  const h1 = locale === 'it'
    ? `Archivio prezzo ${fuelLabel.toLowerCase()} a ${zoneLabel} — ${monthKey}`
    : locale === 'en'
    ? `${fuelLabel} price archive for ${zoneLabel} — ${monthKey}`
    : locale === 'de'
    ? `${fuelLabel}preis-Archiv ${zoneLabel} — ${monthKey}`
    : `Archive du prix du ${fuelLabel.toLowerCase()} à ${zoneLabel} — ${monthKey}`;

  const intro = locale === 'it'
    ? `Questa pagina raccoglie il prezzo medio giornaliero del ${fuelLabel.toLowerCase()} a ${zoneLabel} per il mese ${monthKey}, con prezzo medio mensile di ${formatPrice(avg, locale)} CHF/litro. Utile per verificare l'andamento storico e decidere se il livello attuale è alto o basso rispetto al recente passato. I dati provengono dalle stazioni Svizzere monitorate ogni giorno dalla nostra pipeline basata su TCS Benzinpreis.`
    : locale === 'en'
    ? `This page collects the daily ${fuelLabel.toLowerCase()} price in ${zoneLabel} for month ${monthKey}, with a monthly average of ${formatPrice(avg, locale)} CHF/litre. Use it to check the historical trend and decide whether the current price is high or low. Data comes from Swiss stations monitored daily by our pipeline on top of TCS Benzinpreis.`
    : locale === 'de'
    ? `Diese Seite sammelt den täglichen ${fuelLabel}preis in ${zoneLabel} für den Monat ${monthKey}, mit einem Monatsdurchschnitt von ${formatPrice(avg, locale)} CHF/Liter. Nutzen Sie sie, um den historischen Verlauf einzuordnen und zu beurteilen, ob der aktuelle Preis hoch oder niedrig ist. Die Daten stammen von Schweizer Tankstellen, die täglich von unserer Pipeline auf Basis TCS Benzinpreis erfasst werden.`
    : `Cette page rassemble le prix quotidien du ${fuelLabel.toLowerCase()} à ${zoneLabel} pour le mois ${monthKey}, avec une moyenne mensuelle de ${formatPrice(avg, locale)} CHF/litre. Utile pour évaluer la tendance historique et déterminer si le prix actuel est haut ou bas. Les données viennent des stations suisses surveillées chaque jour par notre pipeline basée sur TCS Benzinpreis.`;

  const tableHtml = `<table style="${TABLE_STYLE};font-size:14px">
    <thead><tr>
      <th style="${TABLE_HEAD_STYLE}">${esc(locale === 'it' ? 'Data' : locale === 'de' ? 'Datum' : 'Date')}</th>
      <th style="${TABLE_HEAD_STYLE};text-align:right">${esc(copy.avgLabel)}</th>
    </tr></thead>
    <tbody>${rows.map((r) => `<tr>
      <td style="${TABLE_CELL_STYLE}">${esc(r.date)}</td>
      <td style="${TABLE_CELL_STYLE};text-align:right;font-variant-numeric:tabular-nums">${r.price === null ? '—' : formatPrice(r.price, locale) + ' CHF'}</td>
    </tr>`).join('')}</tbody>
  </table>`;

  // Single-month area chart visualizing the table data above. No range
  // selector — the page is already scoped to one month.
  const chartSeries: FuelSeriesPoint[] = rows
    .filter((r): r is { date: string; price: number } => typeof r.price === 'number')
    .map((r) => ({ date: r.date, value: Number(r.price.toFixed(3)) }));
  const chartStats = computeFuelStats(chartSeries);
  const chartAriaLabel = copy.chartAriaLabel(fuelLabel, zoneLabel, formatPrice(chartStats?.avg ?? null, locale));
  const chartSvg = renderFuelAreaChartSvg({
    series: chartSeries,
    rangeKey: '1M',
    ariaLabel: chartAriaLabel,
    locale,
    formatValue: (v) => formatPrice(v, locale),
  });
  const archiveStatLabels = FUEL_STAT_LABELS[locale];
  const formatStatVal = (n: number): string => `${formatPrice(n, locale)} CHF`;
  const archiveChartHtml = chartSeries.length >= 2
    ? `<div style="background:var(--color-surface);border:1px solid var(--color-edge);border-radius:16px;padding:20px;box-shadow:0 1px 2px rgba(0,0,0,0.04);max-width:720px;margin:0 0 18px">
      ${chartSvg}
      ${chartStats
        ? `<div style="display:flex;justify-content:space-between;gap:8px;margin-top:14px;font:500 12px system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:var(--color-subtle);min-height:20px">
          <span><strong>${esc(archiveStatLabels.min)}:</strong> ${esc(formatStatVal(chartStats.min))}</span>
          <span><strong>${esc(archiveStatLabels.avg)}:</strong> ${esc(formatStatVal(chartStats.avg))}</span>
          <span><strong>${esc(archiveStatLabels.max)}:</strong> ${esc(formatStatVal(chartStats.max))}</span>
        </div>`
        : ''}
    </div>`
    : '';

  const dateStamp = today.toISOString().slice(0, 10);
  const title = clampSiteSuffix(h1, 'Frontaliere Ticino');
  const description = intro.slice(0, 180);

  const breadcrumbLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: copy.breadcrumbHome, item: `${BASE_URL}/` },
      { '@type': 'ListItem', position: 2, name: fuelLabel, item: `${BASE_URL}${FUEL_LOCALE_PREFIX[locale]}/${FUEL_SECTION_SLUG[locale][fuel]}/` },
      { '@type': 'ListItem', position: 3, name: `${zoneLabel} ${monthKey}`, item: canonicalUrl },
    ],
  });

  const webPageLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: h1,
    url: canonicalUrl,
    description: intro,
    inLanguage: locale,
    dateModified: dateStamp,
  });

  const bodyHtml = `<article style="max-width:1100px;margin:0 auto;padding:32px 20px 56px">
        <nav style="${BREADCRUMB_STYLE}">
          <a href="${BASE_URL}/" style="${BREADCRUMB_LINK_STYLE}">${esc(copy.breadcrumbHome)}</a>
          <span> / </span>
          <a href="${BASE_URL}${buildFuelTodayPath(locale, fuel, zone)}" style="${BREADCRUMB_LINK_STYLE}">${esc(zoneLabel)}</a>
          <span> / </span>
          <span>${esc(monthKey)}</span>
        </nav>
        <header style="margin-bottom:22px">
          <p style="${HERO_EYEBROW_STYLE}">${esc(copy.archiveLabel)} · ${esc(monthKey)}</p>
          <h1 style="${H1_STYLE}">${esc(h1)}</h1>
          <p style="${LEDE_STYLE}">${esc(intro)}</p>
        </header>
        ${archiveChartHtml}
        <section>${tableHtml}</section>
      </article>`;

  return buildSeoPageHtml({
    locale,
    title,
    description,
    canonicalUrl,
    robots: 'index,follow',
    ogType: 'website',
    ogLocale: LOCALE_OG[locale],
    jsonLdScripts: [breadcrumbLd, webPageLd],
    bodyHtml,
    distDir,
    hubChrome: { hubKey: 'stats', activeSubTab: 'fuel-prices' },
  });
}

// ── D-2A: Per-station + Italian-city generation ────────────────
//
// Extends F6 from "regional + 5 zones" to:
//  - one page per Swiss station in a known Ticino zone
//  - one per-city hub for curated Italian border cities
//
// Safety: the hard cap MAX_FUEL_STATION_PAGES_PER_BUILD stops runaway emission
// if the dataset unexpectedly balloons. Stations with no price AND no brand AND
// no name are skipped.

/** Per-station rendering target with all computed metadata. */
interface StationContext {
  station: SwissStation;
  zone: FuelZone;
  city: string; // display-case, from address
  slug: string;
  brandDisplay: string;
  streetDisplay: string;
  prices: { diesel: number; benzina: number };
}

// Defensive twin of the crawler-side dedup (`scripts/lib/fuel-station-dedup.mjs`):
// catches lingering duplicates in `data/fuel-prices.json` from pre-fix cron runs
// where the same physical station has distinct ids but identical brand+name+address.
function stationPluginDedupKey(s: SwissStation): string {
  const norm = (value: unknown): string =>
    String(value ?? '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  return `${norm(s.brand)}|${norm(s.name)}|${norm(s.address)}`;
}

/** Collect every Swiss station with a known Ticino zone + compute its slug. */
function collectSwissStationContexts(dataset: FuelPricesDataset): StationContext[] {
  const seen = new Set<string>();
  const out: StationContext[] = [];
  const slugSeen = new Set<string>();
  for (const row of dataset.municipalities ?? []) {
    const nearby = row.swiss?.nearbyStations ?? [];
    for (const s of nearby) {
      if (!s || typeof s.sp95PriceChf !== 'number') continue;
      // Skip totally-empty stations (no brand + no name = unidentifiable)
      if (!s.brand && !s.name) continue;
      const dedupKey = stationPluginDedupKey(s);
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);
      const zone = zoneForAddress(s.address);
      if (!zone) continue; // outside the 5 Ticino zones
      const prices = pricesFromStation(s);
      if (!prices) continue;
      const baseSlug = buildStationSlug({ brand: s.brand, name: s.name, address: s.address });
      if (!baseSlug) continue;
      // Ensure slug uniqueness across the full set (rare collision possible)
      let slug = baseSlug;
      let suffix = 2;
      while (slugSeen.has(`${zone}/${slug}`)) {
        slug = `${baseSlug}-${suffix++}`;
      }
      slugSeen.add(`${zone}/${slug}`);
      // Derive display strings. The last comma-separated segment typically
      // reads "6830 Chiasso" — strip the 4-5 digit postal code to keep only
      // the proper-noun city name.
      const rawLast = (s.address ?? '').split(',').pop()?.trim() ?? '';
      const cityFromAddr = rawLast.replace(/^\d{4,5}\s+/, '').trim() || FUEL_ZONE_DISPLAY[zone];
      const street = (s.address ?? '').split(',')[0]?.trim() ?? '';
      const brandDisplay = s.brand && s.brand.toUpperCase() !== 'UNDEFINED' ? titleCase(s.brand) : (s.name ? titleCase(s.name.split(/\s+/)[0] ?? 'Stazione') : 'Stazione');
      out.push({
        station: s,
        zone,
        city: cityFromAddr,
        slug,
        brandDisplay,
        streetDisplay: street,
        prices,
      });
    }
  }
  return out;
}

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .split(/\s+/)
    .map((w) => (w.length > 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(' ');
}

/** Group station contexts by zone (for sibling picking). */
function groupByZone(contexts: StationContext[]): Map<FuelZone, StationContext[]> {
  const out = new Map<FuelZone, StationContext[]>();
  for (const c of contexts) {
    const arr = out.get(c.zone) ?? [];
    arr.push(c);
    out.set(c.zone, arr);
  }
  return out;
}

// ── Localised station copy ─────────────────────────────────────

interface StationCopy {
  h1: (brand: string, street: string, city: string, fuelLabel: string) => string;
  intro: (brand: string, city: string, price: string, fuelLabel: string) => string;
  paragraph: (brand: string, city: string, price: string, zoneAvg: string, fuelLabel: string) => string;
  ranking: (rank: string, total: number, city: string) => string;
  infoHeading: string;
  infoBrand: string;
  infoAddress: string;
  infoUpdated: string;
  currency: string;
  backToZone: (zone: string) => string;
  rankCheapest: string;
  rankMedian: string;
  rankPremium: string;
  deltaVsZone: string;
  deltaVsCity: string;
  priceDiesel: string;
  priceBenzina: string;
  /** Extended commuter-context section (Sprint 2). */
  contextHeading: string;
  /** 2 paragraphs of contextual copy. May contain inline HTML (<a>). */
  contextParagraphs: (brand: string, city: string, zone: string, fuelLabel: string) => string[];
}

const STATION_COPY: Record<FuelDailyLocale, StationCopy> = {
  it: {
    h1: (b, st, c, f) => `Prezzo ${f.toLowerCase()} ${b} ${st} a ${c}`,
    intro: (b, c, p, f) => `La stazione ${b} di ${c} offre oggi ${f.toLowerCase()} a ${p} CHF/litro. I prezzi sono aggiornati ogni giorno dalle rilevazioni TCS Benzinpreis sulle stazioni entro 20 km dal confine italiano — utili per pianificare il rifornimento prima o dopo il passaggio frontaliero.`,
    paragraph: (b, c, p, zAvg, f) => `Alla stazione ${b} di ${c} il prezzo del ${f.toLowerCase()} è ${p} CHF/litro rispetto alla media di zona di ${zAvg} CHF/litro. Questo dato ti aiuta a capire se conviene fare rifornimento qui oppure in una stazione vicina. Incrocia il valore con lo storico settimanale del prezzo in zona per decidere se aspettare o pieno subito. Usa la mappa dei valichi doganali per verificare la fila prima di spostarti e la guida frontaliere per capire costi e tempi complessivi del tragitto casa-lavoro.`,
    ranking: (r, t, c) => `Posizione nella classifica di ${c}: ${r} (${t} stazioni rilevate).`,
    infoHeading: 'Informazioni stazione',
    infoBrand: 'Brand',
    infoAddress: 'Indirizzo',
    infoUpdated: 'Ultimo aggiornamento prezzo',
    currency: 'CHF/litro',
    backToZone: (z) => `Torna al prezzo medio zona ${z}`,
    rankCheapest: 'più economica',
    rankMedian: 'mediana',
    rankPremium: 'premium',
    deltaVsZone: 'vs media zona',
    deltaVsCity: 'vs media città',
    priceDiesel: 'Prezzo diesel',
    priceBenzina: 'Prezzo benzina',
    contextHeading: 'Conviene rifornirsi qui come frontaliere?',
    contextParagraphs: (b, c, z, _f) => [
      `La stazione ${b} a ${c} (zona ${z}) si valuta rispetto a tre parametri: posizione rispetto al valico più vicino, differenza di prezzo rispetto al lato italiano e orario di apertura. Un frontaliere lombardo che rientra la sera trova conveniente rifornirsi in Ticino solo se il prezzo qui è almeno 0,05 CHF/litro inferiore al prezzo italiano medio a Como, Varese o Chiasso: sotto questa soglia il tempo perso in coda al valico o la deviazione di 1-2 km riducono il vantaggio netto.`,
      `Se usi la vettura per il pendolarismo quotidiano (40-120 km/giorno) il rifornimento in Svizzera va pianificato in base alla tariffa CO₂ applicata sul carburante e all'eventuale sovrattassa dei distributori di frontiera. Per una stima aggiornata del costo globale del tragitto consulta la panoramica carburanti Ticino e il <a href="/calcola-stipendio/" style="color:var(--color-link)">calcolatore stipendio</a>.`,
    ],
  },
  en: {
    h1: (b, st, c, f) => `${f} price ${b} ${st} in ${c}`,
    intro: (b, c, p, f) => `The ${b} station in ${c} currently sells ${f.toLowerCase()} at ${p} CHF per litre. Prices are refreshed daily from TCS Benzinpreis observations of stations within 20 km of the Italian border — useful to plan your fill-up before or after your cross-border commute.`,
    paragraph: (b, c, p, zAvg, f) => `At the ${b} station in ${c} the ${f.toLowerCase()} price is ${p} CHF per litre vs the zone average of ${zAvg} CHF per litre. Use this gap to decide whether to fill up here or at a nearby station. Cross-check with the weekly zone trend to plan your refuel, check the border crossing queue before you drive, and use the cross-border commuter guide for the full commute picture.`,
    ranking: (r, t, c) => `Rank in ${c}: ${r} (${t} stations observed).`,
    infoHeading: 'Station info',
    infoBrand: 'Brand',
    infoAddress: 'Address',
    infoUpdated: 'Last price update',
    currency: 'CHF/litre',
    backToZone: (z) => `Back to ${z} zone average`,
    rankCheapest: 'cheapest',
    rankMedian: 'median',
    rankPremium: 'premium',
    deltaVsZone: 'vs zone avg',
    deltaVsCity: 'vs city avg',
    priceDiesel: 'Diesel price',
    priceBenzina: 'Gasoline price',
    contextHeading: 'Is it worth refueling here as a cross-border commuter?',
    contextParagraphs: (b, c, z, _f) => [
      `The ${b} station in ${c} (${z} zone) should be evaluated against three factors: distance from the nearest border crossing, price gap with the Italian side, and opening hours. An Italian frontaliere driving home in the evening benefits only if the price here is at least 0.05 CHF/litre lower than the average Italian price in Como, Varese or Chiasso; below that gap, the border queue or a 1-2 km detour eats into the net saving.`,
      `If you use the car for daily commuting (40-120 km/day) refueling in Switzerland should account for the CO₂ levy and the possible border-station premium. For a full view of commuting costs see the Ticino fuel overview and the <a href="/en/calculate-salary/" style="color:var(--color-link)">salary calculator</a>.`,
    ],
  },
  de: {
    h1: (b, st, c, f) => `${f}preis ${b} ${st} in ${c}`,
    intro: (b, c, p, f) => `Die Tankstelle ${b} in ${c} verkauft heute ${f} zum Preis von ${p} CHF pro Liter. Die Preise werden täglich aus den TCS-Benzinpreis-Beobachtungen der Tankstellen im 20-km-Umkreis zur italienischen Grenze aktualisiert — praktisch, um das Tanken vor oder nach dem Grenzübertritt zu planen.`,
    paragraph: (b, c, p, zAvg, f) => `An der Tankstelle ${b} in ${c} liegt der ${f}preis bei ${p} CHF pro Liter gegenüber dem Zonendurchschnitt von ${zAvg} CHF pro Liter. Nutze die Differenz, um zu entscheiden, ob du hier oder an einer benachbarten Tankstelle tankst. Die Seite wird jeden Tag frisch aufgebaut und enthält die aktuellen Marktvergleichswerte. Vergleiche mit dem Wochenverlauf der Zone, prüfe die Wartezeit am nächsten Grenzübergang und konsultiere den Grenzgänger-Leitfaden für die gesamte Pendel-Kostenrechnung. So planst du deinen Tankstopp optimal: vor oder nach der Grenze, mit oder ohne Umweg, je nach Tagesdifferenz zwischen Italien und der Schweiz.`,
    ranking: (r, t, c) => `Rang in ${c}: ${r} (${t} erfasste Tankstellen).`,
    infoHeading: 'Tankstellen-Infos',
    infoBrand: 'Marke',
    infoAddress: 'Adresse',
    infoUpdated: 'Letzte Preisaktualisierung',
    currency: 'CHF/Liter',
    backToZone: (z) => `Zurück zum Zonendurchschnitt ${z}`,
    rankCheapest: 'günstigste',
    rankMedian: 'Median',
    rankPremium: 'Premium',
    deltaVsZone: 'vs Zonen-Ø',
    deltaVsCity: 'vs Stadt-Ø',
    priceDiesel: 'Dieselpreis',
    priceBenzina: 'Benzinpreis',
    contextHeading: 'Lohnt sich das Tanken hier als Grenzgänger?',
    contextParagraphs: (b, c, z, _f) => [
      `Die Tankstelle ${b} in ${c} (Zone ${z}) bewertet sich nach drei Faktoren: Distanz zum nächsten Grenzübergang, Preisdifferenz zur italienischen Seite und Öffnungszeiten. Ein italienischer Grenzgänger, der abends heimfährt, profitiert nur, wenn der Preis hier mindestens 0,05 CHF/Liter unter dem italienischen Durchschnitt in Como, Varese oder Chiasso liegt; darunter zehrt die Grenzwartezeit oder ein 1-2 km-Umweg den Nettovorteil auf.`,
      `Wer das Auto täglich für 40-120 km pendeln nutzt, sollte die CO₂-Abgabe und den möglichen Zuschlag der Grenztankstellen mitrechnen. Für eine vollständige Kostenübersicht siehe den Tessin-Überblick und den <a href="/de/gehalt-berechnen/" style="color:var(--color-link)">Gehaltsrechner</a>.`,
    ],
  },
  fr: {
    h1: (b, st, c, f) => `Prix du ${f.toLowerCase()} ${b} ${st} à ${c}`,
    intro: (b, c, p, f) => `La station ${b} à ${c} vend aujourd'hui du ${f.toLowerCase()} à ${p} CHF le litre. Les prix sont mis à jour chaque jour à partir des relevés TCS Benzinpreis des stations à moins de 20 km de la frontière italienne — utile pour planifier le plein avant ou après votre trajet frontalier.`,
    paragraph: (b, c, p, zAvg, f) => `À la station ${b} de ${c}, le prix du ${f.toLowerCase()} est de ${p} CHF le litre contre une moyenne de zone de ${zAvg} CHF le litre. Utilisez cet écart pour choisir si faire le plein ici ou dans une station voisine. Croisez avec la tendance hebdomadaire de la zone, vérifiez le temps d'attente au poste-frontière le plus proche et consultez le guide frontalier pour l'ensemble du calcul du trajet.`,
    ranking: (r, t, c) => `Classement à ${c} : ${r} (${t} stations observées).`,
    infoHeading: 'Infos station',
    infoBrand: 'Marque',
    infoAddress: 'Adresse',
    infoUpdated: 'Dernière mise à jour du prix',
    currency: 'CHF/litre',
    backToZone: (z) => `Retour à la moyenne de zone ${z}`,
    rankCheapest: 'la moins chère',
    rankMedian: 'médiane',
    rankPremium: 'premium',
    deltaVsZone: 'vs moy. zone',
    deltaVsCity: 'vs moy. ville',
    priceDiesel: 'Prix du gasoil',
    priceBenzina: 'Prix de l\'essence',
    contextHeading: 'Faire le plein ici vaut-il la peine pour un frontalier ?',
    contextParagraphs: (b, c, z, _f) => [
      `La station ${b} à ${c} (zone ${z}) s'évalue selon trois facteurs : distance du poste-frontière le plus proche, écart de prix avec le côté italien et horaires d'ouverture. Un frontalier italien qui rentre le soir n'y gagne que si le prix y est inférieur d'au moins 0,05 CHF/litre à la moyenne italienne à Côme, Varèse ou Chiasso ; en deçà, l'attente à la frontière ou un détour d'1-2 km grignote l'économie nette.`,
      `Pour un usage quotidien de la voiture (40-120 km/jour), le plein en Suisse doit tenir compte de la taxe CO₂ et d'un éventuel supplément des stations de frontière. Pour une vue d'ensemble voir l'aperçu Tessin et le <a href="/fr/calculer-salaire/" style="color:var(--color-link)">calculateur de salaire</a>.`,
    ],
  },
};

/**
 * Compose a per-station signature paragraph injected into the "station
 * context" section. Stations that share (brand, city, zone, fuel) — which
 * previously produced an identical contextParagraphs block — still receive a
 * distinguishing sentence here because this paragraph references the street,
 * station-id, slug, lat/lng coordinates when available, ranking slot, price
 * and delta-vs-zone-average. Those fields are always per-station, so no two
 * pages can collide on body hash.
 */
interface StationSignatureInput {
  locale: FuelDailyLocale;
  brand: string;
  street: string;
  city: string;
  zone: string;
  fuelLabel: string;
  priceFmt: string;
  zoneAvgFmt: string;
  rankIndex: number;
  total: number;
  station: SwissStation;
  slug: string;
}

function buildStationSignaturePargaraph(inp: StationSignatureInput): string {
  const { locale, brand, street, city, zone, fuelLabel, priceFmt, zoneAvgFmt, rankIndex, total, station, slug } = inp;
  const rankText = total > 0 ? `${rankIndex + 1}/${total}` : '—';
  const streetText = street && street.length > 0 ? street : (station.address ?? '');
  const updatedText = station.updatedAt ? String(station.updatedAt).slice(0, 10) : '';
  const coords =
    typeof station.lat === 'number' && typeof station.lng === 'number'
      ? `${station.lat.toFixed(4)}, ${station.lng.toFixed(4)}`
      : '';
  const neighbour = station.nearestMunicipality && station.nearestMunicipality.length > 0
    ? station.nearestMunicipality
    : '';
  const distanceKm =
    typeof station.nearestMunicipalityDistanceKm === 'number' && station.nearestMunicipalityDistanceKm > 0
      ? station.nearestMunicipalityDistanceKm.toFixed(1)
      : '';

  if (locale === 'it') {
    const parts = [
      `Questa scheda fa riferimento specifico alla stazione ${brand} ${streetText || slug} a ${city} (zona ${zone})`,
      `oggi quotata ${priceFmt} CHF/litro per ${fuelLabel.toLowerCase()} contro una media zona di ${zoneAvgFmt} CHF/litro, posizione ${rankText} nella classifica locale`,
    ];
    if (coords) parts.push(`coordinate ${coords}`);
    if (neighbour) parts.push(`comune italiano più vicino: ${neighbour}${distanceKm ? ` (${distanceKm} km)` : ''}`);
    if (updatedText) parts.push(`ultimo aggiornamento prezzo: ${updatedText}`);
    return `${parts.join('. ')}. Usa questa pagina come riferimento puntuale per la tua routine di rifornimento: il confronto con il prezzo italiano vicino e con le altre stazioni della zona ${zone} cambia di giorno in giorno.`;
  }
  if (locale === 'de') {
    const parts = [
      `Dieses Datenblatt bezieht sich speziell auf die Tankstelle ${brand} ${streetText || slug} in ${city} (Zone ${zone})`,
      `heute notiert zu ${priceFmt} CHF/Liter für ${fuelLabel} gegenüber einem Zonendurchschnitt von ${zoneAvgFmt} CHF/Liter, Rang ${rankText} in der lokalen Rangliste`,
    ];
    if (coords) parts.push(`Koordinaten ${coords}`);
    if (neighbour) parts.push(`nächstgelegener italienischer Ort: ${neighbour}${distanceKm ? ` (${distanceKm} km)` : ''}`);
    if (updatedText) parts.push(`letzte Preisaktualisierung: ${updatedText}`);
    return `${parts.join('. ')}. Nutze diese Seite als präzise Referenz für deine Tankroutine: der Vergleich mit dem nächsten italienischen Preis und mit den übrigen Tankstellen der Zone ${zone} ändert sich täglich.`;
  }
  if (locale === 'fr') {
    const parts = [
      `Cette fiche se réfère spécifiquement à la station ${brand} ${streetText || slug} à ${city} (zone ${zone})`,
      `aujourd'hui cotée ${priceFmt} CHF/litre pour le ${fuelLabel.toLowerCase()} contre une moyenne de zone de ${zoneAvgFmt} CHF/litre, position ${rankText} dans le classement local`,
    ];
    if (coords) parts.push(`coordonnées ${coords}`);
    if (neighbour) parts.push(`commune italienne la plus proche : ${neighbour}${distanceKm ? ` (${distanceKm} km)` : ''}`);
    if (updatedText) parts.push(`dernière mise à jour du prix : ${updatedText}`);
    return `${parts.join('. ')}. Utilisez cette page comme référence précise pour votre routine de plein : la comparaison avec le prix italien voisin et avec les autres stations de la zone ${zone} change chaque jour.`;
  }
  // en
  const parts = [
    `This page refers specifically to the ${brand} ${streetText || slug} station in ${city} (${zone} zone)`,
    `quoted today at ${priceFmt} CHF/litre for ${fuelLabel.toLowerCase()} vs a zone average of ${zoneAvgFmt} CHF/litre, rank ${rankText} in the local leaderboard`,
  ];
  if (coords) parts.push(`coordinates ${coords}`);
  if (neighbour) parts.push(`nearest Italian municipality: ${neighbour}${distanceKm ? ` (${distanceKm} km)` : ''}`);
  if (updatedText) parts.push(`last price update: ${updatedText}`);
  return `${parts.join('. ')}. Use this page as a precise reference for your refuelling routine: the comparison with the closest Italian price and with the other stations in the ${zone} zone shifts day by day.`;
}

/** Render a Swiss per-station HTML page for a single fuel. */
function renderStationPage(opts: {
  ctx: StationContext;
  locale: FuelDailyLocale;
  fuel: FuelType;
  zoneAvg: number | null;
  zoneStations: StationContext[];
  today: Date;
  canonicalPath: string;
  alternates: Record<FuelDailyLocale, string>;
  distDir?: string;
}): string {
  const { ctx, locale, fuel, zoneAvg, zoneStations, today, canonicalPath, alternates, distDir } = opts;
  const copy = STATION_COPY[locale];
  const fuelLabel = FUEL_TYPE_LABEL[locale][fuel];
  const zoneLabel = FUEL_ZONE_DISPLAY[ctx.zone];
  const dateStamp = today.toISOString().slice(0, 10);
  const canonicalUrl = `${BASE_URL}${canonicalPath}`;

  const price = ctx.prices[fuel];
  const priceFmt = formatPrice(price, locale);
  const zoneAvgFmt = formatPrice(zoneAvg, locale);

  // Rank within zone (for the chosen fuel)
  const sortedByFuel = [...zoneStations]
    .map((c) => ({ slug: c.slug, price: c.prices[fuel] }))
    .sort((a, b) => a.price - b.price);
  const rankIdx = sortedByFuel.findIndex((c) => c.slug === ctx.slug);
  const total = sortedByFuel.length;
  const rankLabel =
    rankIdx < total / 3
      ? copy.rankCheapest
      : rankIdx < (2 * total) / 3
      ? copy.rankMedian
      : copy.rankPremium;

  // Delta vs zone average
  const deltaZone = zoneAvg !== null ? Number((price - zoneAvg).toFixed(3)) : null;
  const deltaZoneFmt = formatDelta(deltaZone, locale);

  const h1 = copy.h1(ctx.brandDisplay, ctx.streetDisplay, ctx.city, fuelLabel);
  const intro = copy.intro(ctx.brandDisplay, ctx.city, priceFmt, fuelLabel);
  const paragraph = copy.paragraph(ctx.brandDisplay, ctx.city, priceFmt, zoneAvgFmt, fuelLabel);
  const rankingLine = copy.ranking(rankLabel, total, ctx.city);
  const editorialAssessment = buildStationEditorialAssessment(
    locale,
    fuelLabel,
    ctx.brandDisplay,
    ctx.city,
    priceFmt,
    zoneAvgFmt,
    Math.max(rankIdx, 0),
    total,
    deltaZone,
  );

  // Alternates — shared helper guarantees x-default + canonical host.
  const alternatesHtml = renderHreflangTags(alternates);

  // Sibling stations for related-links block
  const siblingStations = zoneStations
    .filter((s) => s.slug !== ctx.slug)
    .slice(0, 6)
    .map((s) => ({ slug: s.slug, brand: s.brandDisplay, zone: s.zone }));

  // JSON-LD
  const breadcrumbLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: locale === 'it' ? 'Home' : locale === 'de' ? 'Startseite' : locale === 'fr' ? 'Accueil' : 'Home', item: `${BASE_URL}/` },
      { '@type': 'ListItem', position: 2, name: fuelLabel, item: `${BASE_URL}${FUEL_LOCALE_PREFIX[locale]}/${FUEL_SECTION_SLUG[locale][fuel]}/` },
      { '@type': 'ListItem', position: 3, name: zoneLabel, item: `${BASE_URL}${buildFuelTodayPath(locale, fuel, ctx.zone)}` },
      { '@type': 'ListItem', position: 4, name: ctx.brandDisplay + ' ' + ctx.streetDisplay, item: canonicalUrl },
    ],
  });

  const webPageLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: h1,
    url: canonicalUrl,
    description: intro,
    inLanguage: locale,
    dateModified: today.toISOString(),
    datePublished: today.toISOString(),
  });

  // GasStation + Place (geo)
  const gasStationLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'GasStation',
    name: `${ctx.brandDisplay} ${ctx.streetDisplay}`.trim(),
    address: {
      '@type': 'PostalAddress',
      streetAddress: ctx.streetDisplay,
      addressLocality: ctx.city,
      addressCountry: 'CH',
    },
    ...(typeof ctx.station.lat === 'number' && typeof ctx.station.lng === 'number'
      ? {
          geo: {
            '@type': 'GeoCoordinates',
            latitude: ctx.station.lat,
            longitude: ctx.station.lng,
          },
        }
      : {}),
    brand: ctx.brandDisplay,
    url: canonicalUrl,
  });

  // Product LD intentionally omitted — GasStation is the canonical Schema.org
  // type for a fuel-dispensing business and doesn't require aggregateRating +
  // review (which Google demands for Product merchant listings). Faking those
  // fields would violate Google's structured-data guidelines.

  // Keep the title compact: the full h1 + date + brand suffix can balloon past
  // 80 chars and get truncated in SERPs. Trim the h1 on a word boundary to
  // ~60 chars, strip trailing punctuation, then append the dated brand suffix.
  //
  // Uniqueness guard (2026-04-24): after trimming, ensure the city name AND a
  // street-level disambiguator are both preserved in the final <title>. Two
  // stations with the same brand + same street prefix but different cities
  // (e.g. "Coop Pronto Via Roma" in Chiasso vs Lugano) would otherwise
  // collide when h1 is sliced before the city segment.
  // Phase 3A — total <title> ≤60 char (Semrush W2). The H1 is already
  // trimmed to ~60 elsewhere; the dated suffix and brand suffix are clamped
  // separately so the date-stamp survives even when the brand has to drop.
  const titleBudget = 60;
  const dateBadge = ` (${dateStamp})`;
  const trimmedH1 = h1.length <= titleBudget
    ? h1
    : (() => {
        const slice = h1.slice(0, titleBudget);
        const lastSpace = slice.lastIndexOf(' ');
        const base = lastSpace > 30 ? slice.slice(0, lastSpace) : slice;
        return base.replace(/[\s.,;:\-–—|]+$/u, '');
      })();
  const hasCity = ctx.city.length > 0 && trimmedH1.toLowerCase().includes(ctx.city.toLowerCase());
  const streetTail = ctx.streetDisplay || ctx.slug;
  const hasStreet = streetTail.length === 0 || trimmedH1.toLowerCase().includes(streetTail.toLowerCase());
  const safeBase = hasCity && hasStreet
    ? trimmedH1
    : `${ctx.brandDisplay} ${streetTail} — ${ctx.city} ${fuelLabel}`
        .replace(/\s+/g, ' ')
        .trim();
  // Drop the date suffix if appending it would already exceed the budget;
  // then optionally add the brand suffix only when room remains.
  const withDate = (safeBase + dateBadge).length <= titleBudget ? safeBase + dateBadge : safeBase;
  const title = clampSiteSuffix(withDate, 'Frontaliere Ticino', titleBudget);
  const description = intro.slice(0, 180);

  const bodyHtml = `<article style="max-width:1100px;margin:0 auto;padding:32px 20px 56px">
  <nav aria-label="Breadcrumb" style="${BREADCRUMB_STYLE}">
    <a href="${BASE_URL}/" style="${BREADCRUMB_LINK_STYLE}">Home</a>
    <span> / </span>
    <a href="${BASE_URL}${FUEL_LOCALE_PREFIX[locale]}/${FUEL_SECTION_SLUG[locale][fuel]}/${FUEL_TODAY_SLUG[locale]}/" style="${BREADCRUMB_LINK_STYLE}">${esc(fuelLabel)}</a>
    <span> / </span>
    <a href="${BASE_URL}${buildFuelTodayPath(locale, fuel, ctx.zone)}" style="${BREADCRUMB_LINK_STYLE}">${esc(zoneLabel)}</a>
    <span> / </span>
    <span>${esc(ctx.brandDisplay)} ${esc(ctx.streetDisplay)}</span>
  </nav>
  <header style="margin-bottom:22px">
    <p style="${HERO_EYEBROW_STYLE}">${esc(dateStamp)}</p>
    <h1 style="${H1_STYLE}">${esc(h1)}</h1>
    <p style="${LEDE_STYLE}">${esc(intro)}</p>
  </header>
  <section style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;margin:0 0 24px">
    <div style="${STAT_TILE_ACCENT}">
      <div style="${STAT_TILE_LABEL}">${esc(fuel === 'diesel' ? copy.priceDiesel : copy.priceBenzina)}</div>
      <div style="${STAT_TILE_VALUE};font-size:32px">${priceFmt}</div>
      <div style="margin-top:2px;font-size:13px;color:var(--color-subtle)">${esc(copy.currency)}</div>
    </div>
    <div style="${STAT_TILE_WARNING}">
      <div style="${STAT_TILE_LABEL}">${esc(copy.deltaVsZone)}</div>
      <div style="${STAT_TILE_VALUE};font-size:22px">${esc(deltaZoneFmt)}</div>
    </div>
    <div style="${STAT_TILE_SUCCESS}">
      <div style="${STAT_TILE_LABEL}">${esc(rankLabel)}</div>
      <div style="${STAT_TILE_VALUE};font-size:18px">${esc(rankingLine)}</div>
    </div>
  </section>
  <section style="margin:0 0 24px">
    <p style="margin:0 0 14px;color:var(--color-body);line-height:1.7;max-width:860px">${esc(paragraph)}</p>
  </section>
  <section style="margin:0 0 24px;${CARD_STYLE}" aria-labelledby="stationReview">
    <h2 id="stationReview" style="${H2_STYLE}">${esc(editorialAssessment.heading)}</h2>
    <p style="margin:0;color:var(--color-body);line-height:1.7;max-width:860px">${esc(editorialAssessment.body)}</p>
  </section>
  <section style="margin:0 0 24px;${CARD_STYLE}" aria-labelledby="stationInfo">
    <h2 id="stationInfo" style="${H2_STYLE}">${esc(copy.infoHeading)}</h2>
    <dl style="margin:0;display:grid;grid-template-columns:max-content 1fr;column-gap:16px;row-gap:8px;font-size:14px;color:var(--color-body)">
      <dt style="font-weight:600">${esc(copy.infoBrand)}</dt><dd style="margin:0">${esc(ctx.brandDisplay)}</dd>
      <dt style="font-weight:600">${esc(copy.infoAddress)}</dt><dd style="margin:0">${esc(ctx.station.address ?? '—')}</dd>
      ${ctx.station.updatedAt ? `<dt style="font-weight:600">${esc(copy.infoUpdated)}</dt><dd style="margin:0">${esc(String(ctx.station.updatedAt).slice(0, 10))}</dd>` : ''}
    </dl>
  </section>
  <section style="margin:0 0 24px" aria-labelledby="stationContext">
    <h2 id="stationContext" style="${H2_STYLE}">${esc(copy.contextHeading)}</h2>
    ${copy.contextParagraphs(ctx.brandDisplay, ctx.city, zoneLabel, fuelLabel)
      .map((p) => `<p style="margin:0 0 12px;color:var(--color-body);line-height:1.7;max-width:860px">${p}</p>`)
      .join('')}
    <p style="margin:0 0 12px;color:var(--color-body);line-height:1.7;max-width:860px">${esc(
      buildStationSignaturePargaraph({
        locale,
        brand: ctx.brandDisplay,
        street: ctx.streetDisplay,
        city: ctx.city,
        zone: zoneLabel,
        fuelLabel,
        priceFmt,
        zoneAvgFmt,
        rankIndex: Math.max(rankIdx, 0),
        total,
        station: ctx.station,
        slug: ctx.slug,
      }),
    )}</p>
  </section>
  <p style="margin:0 0 22px"><a href="${BASE_URL}${buildFuelTodayPath(locale, fuel, ctx.zone)}" style="${LINK_ACCENT_STYLE};font-weight:600">← ${esc(copy.backToZone(zoneLabel))}</a></p>
  ${generateRelatedLinksBlock(locale, 'fuel_station', {
    fuelType: fuel,
    fuelZone: ctx.zone,
    stationSlug: ctx.slug,
    siblingStations,
  })}
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
    ogLocale: LOCALE_OG[locale],
    hreflangHtml: alternatesHtml,
    extraHeadHtml: extraHead,
    jsonLdScripts: [breadcrumbLd, webPageLd, gasStationLd],
    bodyHtml,
    distDir,
    hubChrome: { hubKey: 'stats', activeSubTab: 'fuel-prices' },
  });
}

// ── Italian-city hub rendering ──────────────────────────────────

/** Localized title for the Italian-pages chart section. */
const IT_TREND_LABEL: Record<FuelDailyLocale, string> = {
  it: 'Andamento storico del prezzo',
  en: 'Historical price trend',
  de: 'Historischer Preisverlauf',
  fr: 'Tendance historique du prix',
};

/** Localized intro paragraph for the chart on Italian pages. */
const IT_TREND_INTRO: Record<FuelDailyLocale, string> = {
  it: "Il grafico mostra l'andamento del prezzo benzina nel tempo. Usa i pulsanti per cambiare l'intervallo. Lo storico si popola giorno per giorno: gli intervalli più lunghi diventano disponibili man mano che raccogliamo nuovi dati MIMIT.",
  en: 'The chart below shows the gasoline price trend over time. Use the buttons to switch the range. History is built day by day: longer ranges fill in as we collect more MIMIT snapshots.',
  de: 'Das Diagramm unten zeigt den Benzinpreisverlauf über die Zeit. Mit den Buttons wechselst du den Zeitraum. Die Historie baut sich Tag für Tag auf: längere Zeiträume werden verfügbar, sobald wir mehr MIMIT-Daten erfassen.',
  fr: "Le graphique ci-dessous montre l'évolution du prix de l'essence dans le temps. Utilisez les boutons pour changer la période. L'historique se construit jour après jour : les périodes plus longues deviennent disponibles au fil du temps.",
};

/** Localized aria-label for the chart SVG on Italian pages. */
const IT_CHART_ARIA: Record<FuelDailyLocale, (city: string, avgFmt: string) => string> = {
  it: (c, a) => `Andamento storico del prezzo benzina a ${c}: media ${a} EUR/litro nell'intervallo selezionato.`,
  en: (c, a) => `Historical gasoline price trend in ${c}: average ${a} EUR/litre over the selected range.`,
  de: (c, a) => `Historischer Benzinpreisverlauf in ${c}: Durchschnitt ${a} EUR/Liter im ausgewählten Zeitraum.`,
  fr: (c, a) => `Tendance historique du prix de l'essence à ${c} : moyenne ${a} EUR/litre sur la période sélectionnée.`,
};

interface ItalianCityStation {
  id?: string;
  stationName?: string;
  brand?: string;
  address?: string;
  priceEur?: number;
  isSelf?: boolean;
  lat?: number;
  lng?: number;
  updatedAt?: string;
}

/** Collect Italian stations per curated city.
 *
 * The dataset shape is `municipality.italy.stations` (per
 * scripts/generate-fuel-prices-dataset.mjs `summarizeItalyStations`). Each
 * station appears twice (once `isSelf:true`, once `isSelf:false`) — dedup
 * is performed downstream by station id. We accept the legacy
 * `nearbyStations` key as a fallback in case the dataset shape ever drifts
 * back, and `cheapestStation` as a last resort. */
function collectItalianCityStations(
  dataset: FuelPricesDataset,
  entry: ItalianCityEntry,
): ItalianCityStation[] {
  const out: ItalianCityStation[] = [];
  for (const row of dataset.municipalities ?? []) {
    if (!row.municipality) continue;
    if (row.municipality.toLowerCase() !== entry.matchKey) continue;
    const raw = (row as unknown as {
      italy?: {
        cheapestStation?: ItalianCityStation;
        stations?: ItalianCityStation[];
        nearbyStations?: ItalianCityStation[];
      };
    }).italy;
    if (!raw) continue;
    const list = Array.isArray(raw.stations) && raw.stations.length > 0
      ? raw.stations
      : Array.isArray(raw.nearbyStations) && raw.nearbyStations.length > 0
        ? raw.nearbyStations
        : null;
    if (list) {
      for (const s of list) {
        if (s && typeof s.priceEur === 'number') out.push(s);
      }
    } else if (raw.cheapestStation && typeof raw.cheapestStation.priceEur === 'number') {
      out.push(raw.cheapestStation);
    }
  }
  return out;
}

interface ItalianCityCopy {
  h1: (fuelLabel: string, city: string) => string;
  intro: (fuelLabel: string, city: string, minPrice: string) => string;
  paragraph: (fuelLabel: string, city: string, minPrice: string, nearestZoneLabel: string) => string;
  tableTitle: (city: string) => string;
  tableStation: string;
  tableAddress: string;
  tablePrice: string;
  crossBorderTip: string;
  currency: string;
  backLink: string;
  noData: string;
  /** Heading for the extended commuter-context section (Sprint 2). */
  contextHeading: string;
  /** 2-3 paragraphs of contextual copy. May contain inline HTML (<a>). */
  contextParagraphs: (fuelLabel: string, city: string, nearestZoneLabel: string) => string[];
  /** Heading for the practical tips list. */
  tipsHeading: string;
  tipsItems: string[];
}

const IT_CITY_COPY: Record<FuelDailyLocale, ItalianCityCopy> = {
  it: {
    h1: (f, c) => `Prezzo ${f.toLowerCase()} a ${c} — stazioni più economiche`,
    intro: (f, c, p) => `A ${c} il prezzo più basso del ${f.toLowerCase()} rilevato oggi è ${p} EUR/litro. Dati MIMIT aggiornati dalle stazioni italiane del comune. Utile se sei frontaliere e valuti se fare il pieno in Italia o in Svizzera prima del confine.`,
    paragraph: (f, c, p, nz) => `Il prezzo minimo del ${f.toLowerCase()} a ${c} è ${p} EUR/litro. La tabella qui sotto elenca le stazioni attive ordinate per prezzo crescente. Confronta con il prezzo medio ${f.toLowerCase()} in zona ${nz}, la Ticino più vicina, per capire da che lato del confine conviene rifornirsi oggi. Ricorda che la differenza di 0,10-0,20 EUR/litro compensa spesso il piccolo disagio di una deviazione al valico. Per stime complessive di costo del tragitto giornaliero consulta la guida frontalieri.`,
    tableTitle: (c) => `Stazioni a ${c} — prezzi di oggi`,
    tableStation: 'Stazione',
    tableAddress: 'Indirizzo',
    tablePrice: 'Prezzo',
    crossBorderTip: `Controlla sempre il tempo d'attesa alla dogana prima di attraversare: una coda di 30 minuti può annullare il risparmio al litro.`,
    currency: 'EUR/litro',
    backLink: 'Vedi il prezzo medio in Ticino',
    noData: 'Nessuna stazione disponibile per oggi — dati in aggiornamento.',
    contextHeading: 'Come leggere i prezzi carburante per un frontaliere',
    contextParagraphs: (f, c, nz) => [
      `Il prezzo del ${f.toLowerCase()} in Italia dipende da tre componenti: prezzo industriale (legato al Brent e al cambio EUR/USD), accisa fissa (circa 0,617 EUR/litro dopo l'allineamento 2024) e IVA al 22 %. In Svizzera la tassazione è strutturalmente diversa: accisa più bassa ma tassa CO₂ e sovrattassa sui carburanti importati portano il prezzo finale a oscillare in un intervallo diverso da quello italiano. Per un frontaliere che percorre 80-120 km al giorno, fare il pieno dal lato giusto del confine può valere 15-35 EUR al mese.`,
      `A ${c} il confronto corretto è con la zona Ticino di ${nz}, il punto di ingresso svizzero più vicino. Se il prezzo italiano qui è inferiore di almeno 0,10-0,15 EUR/litro alla media di zona svizzera, conviene rifornirsi prima del valico; se invece il Ticino è più basso, è più efficiente fare il pieno al ritorno. Considera anche la capacità del serbatoio: con 50 litri un gap di 0,20 EUR/litro vale 10 EUR a pieno, con 70 litri arriva a 14 EUR.`,
      `Il costo reale del pendolarismo non si esaurisce nel carburante. Un frontaliere sostiene anche bollo auto, assicurazione, manutenzione, pneumatici e il costo opportunità del tempo. La guida frontalieri e il <a href="/calcola-stipendio/" style="color:var(--color-link)">simulatore busta paga</a> integrano questi costi con lo stipendio netto per calcolare il guadagno reale del lavoro in Svizzera.`,
    ],
    tipsHeading: 'Consigli pratici per il rifornimento',
    tipsItems: [
      'Usa sempre app ufficiali MIMIT Osservaprezzi o il tracker interno per vedere il prezzo aggiornato prima di fermarti.',
      'Evita le stazioni self-service nelle ore di punta del mattino: il prezzo è uguale ma l\'attesa aumenta.',
      'In prossimità del valico i distributori applicano spesso un premio frontaliero di 0,03-0,07 EUR/litro — fai il pieno 5-10 km prima.',
      'Conserva le ricevute del carburante: se usi l\'auto per trasferte di lavoro documentabili sono deducibili nella dichiarazione dei redditi italiana.',
    ],
  },
  en: {
    h1: (f, c) => `${f} price in ${c} — cheapest stations`,
    intro: (f, c, p) => `In ${c} the cheapest ${f.toLowerCase()} price observed today is ${p} EUR per litre. MIMIT data refreshed daily from Italian stations in this municipality. Useful for cross-border commuters deciding whether to refuel in Italy or Switzerland.`,
    paragraph: (f, c, p, nz) => `The minimum ${f.toLowerCase()} price in ${c} is ${p} EUR per litre. The table below lists active stations sorted by price. Compare with the ${f.toLowerCase()} average in the ${nz} Ticino zone — the closest Swiss side — to understand which side of the border is cheapest today. A gap of 0.10-0.20 EUR per litre often offsets a small detour at the border crossing. For full trip cost estimates see the cross-border commuter guide.`,
    tableTitle: (c) => `${c} stations — today's prices`,
    tableStation: 'Station',
    tableAddress: 'Address',
    tablePrice: 'Price',
    crossBorderTip: `Always check the border crossing wait time before you drive: a 30-minute queue can wipe out per-litre savings.`,
    currency: 'EUR/litre',
    backLink: 'See the Ticino average price',
    noData: 'No station data for today — refresh pending.',
    contextHeading: 'How to read fuel prices as a cross-border commuter',
    contextParagraphs: (f, c, nz) => [
      `${f} prices in Italy depend on three components: industrial price (linked to Brent and EUR/USD), fixed excise duty (around 0.617 EUR/litre after the 2024 alignment) and 22% VAT. In Switzerland the tax structure is different: lower excise, but CO₂ tax and import surcharges push the final price into a distinct band. For a frontaliere driving 80-120 km per day, refueling on the right side of the border can be worth 15-35 EUR per month.`,
      `In ${c} the meaningful comparison is with the ${nz} Ticino zone, the closest Swiss entry point. If the Italian price here is at least 0.10-0.15 EUR/litre lower than the Swiss zone average, refuel before crossing; if Ticino is cheaper, fill up on the way back. Tank size matters: 50 litres at a 0.20 EUR/litre gap is worth 10 EUR per fill-up, 70 litres is 14 EUR.`,
      `The real cost of cross-border commuting goes beyond fuel. A frontaliere also pays road tax, insurance, maintenance, tyres, and the opportunity cost of time. The <a href="/en/calculate-salary/" style="color:var(--color-link)">salary calculator</a> integrates these costs with net pay to show the real gain of a Swiss job versus an equivalent Italian role.`,
    ],
    tipsHeading: 'Practical refueling tips',
    tipsItems: [
      'Check the official MIMIT Osservaprezzi app or our tracker for the live price before you stop.',
      'Avoid self-service stations during the morning rush: same price, longer queues.',
      'Stations right at the border often charge a 0.03-0.07 EUR/litre premium — fill up 5-10 km earlier.',
      'Keep fuel receipts: if you use the car for documented business travel, they are deductible on the Italian tax return.',
    ],
  },
  de: {
    h1: (f, c) => `${f}preis in ${c} — günstigste Tankstellen`,
    intro: (f, c, p) => `In ${c} liegt der günstigste heute beobachtete ${f}preis bei ${p} EUR pro Liter. MIMIT-Daten, täglich von den italienischen Tankstellen dieser Gemeinde aktualisiert. Praktisch für Grenzgänger, die entscheiden, ob sie in Italien oder in der Schweiz tanken.`,
    paragraph: (f, c, p, nz) => `Der Mindestpreis für ${f} in ${c} beträgt ${p} EUR pro Liter. Die Tabelle listet die aktiven Tankstellen nach Preis sortiert. Vergleiche mit dem ${f}-Durchschnitt der Tessiner Zone ${nz} — der nächsten Schweizer Seite — um zu erkennen, welche Seite der Grenze heute günstiger ist. Ein Unterschied von 0,10-0,20 EUR pro Liter rechtfertigt oft einen kleinen Umweg über den Grenzübergang. Für eine Gesamtkostenkalkulation der Pendelstrecke konsultiere den Grenzgänger-Leitfaden.`,
    tableTitle: (c) => `Tankstellen ${c} — heutige Preise`,
    tableStation: 'Tankstelle',
    tableAddress: 'Adresse',
    tablePrice: 'Preis',
    crossBorderTip: `Prüfe immer die Wartezeit am Grenzübergang bevor du losfährst: eine 30-minütige Wartezeit frisst die Ersparnis pro Liter auf.`,
    currency: 'EUR/Liter',
    backLink: 'Tessiner Durchschnittspreis anzeigen',
    noData: 'Keine Tankstellendaten für heute — Aktualisierung ausstehend.',
    contextHeading: 'Kraftstoffpreise als Grenzgänger richtig lesen',
    contextParagraphs: (f, c, nz) => [
      `Der ${f}-Preis in Italien hängt von drei Komponenten ab: Industriepreis (gekoppelt an Brent und EUR/USD-Kurs), feste Verbrauchsteuer (rund 0,617 EUR/Liter nach der Angleichung 2024) und 22 % MwSt. In der Schweiz ist die Steuerstruktur anders: tiefere Verbrauchsteuer, aber CO₂-Abgabe und Zuschläge auf importierte Kraftstoffe führen zu einem anderen Endpreisniveau. Für einen Grenzgänger mit 80-120 km pro Tag kann das Tanken auf der richtigen Seite 15-35 EUR pro Monat wert sein.`,
      `In ${c} ist der richtige Vergleich mit der Tessiner Zone ${nz}, dem nächsten Schweizer Grenzübergang. Liegt der italienische Preis hier mindestens 0,10-0,15 EUR/Liter unter dem Schweizer Zonendurchschnitt, lohnt sich das Tanken vor der Grenze; ist das Tessin günstiger, auf der Rückfahrt tanken. Tankgrösse zählt: 50 Liter bei 0,20 EUR/Liter Differenz ergeben 10 EUR pro Füllung, 70 Liter ergeben 14 EUR.`,
      `Die tatsächlichen Pendelkosten reichen über den Treibstoff hinaus: Autosteuer, Versicherung, Wartung, Reifen und Opportunitätskosten der Zeit. Der <a href="/de/gehalt-berechnen/" style="color:var(--color-link)">Gehaltsrechner</a> kombiniert diese Kosten mit dem Nettolohn, um den tatsächlichen Gewinn einer Schweizer Stelle zu zeigen.`,
    ],
    tipsHeading: 'Praktische Tipps zum Tanken',
    tipsItems: [
      'Nutze die offizielle MIMIT-App Osservaprezzi oder unseren Tracker für den aktuellen Preis vor dem Stopp.',
      'Vermeide Selbstbedienungstankstellen in der morgendlichen Stosszeit: gleicher Preis, längere Wartezeit.',
      'Tankstellen direkt an der Grenze verlangen oft einen Aufschlag von 0,03-0,07 EUR/Liter — lieber 5-10 km früher tanken.',
      'Bewahre die Quittungen auf: bei dokumentierten Dienstfahrten sind sie in der italienischen Steuererklärung absetzbar.',
    ],
  },
  fr: {
    h1: (f, c) => `Prix du ${f.toLowerCase()} à ${c} — stations les moins chères`,
    intro: (f, c, p) => `À ${c} le prix le plus bas du ${f.toLowerCase()} observé aujourd'hui est de ${p} EUR par litre. Données MIMIT mises à jour quotidiennement depuis les stations italiennes de la commune. Utile pour les frontaliers qui arbitrent entre faire le plein en Italie ou en Suisse.`,
    paragraph: (f, c, p, nz) => `Le prix minimum du ${f.toLowerCase()} à ${c} est de ${p} EUR par litre. Le tableau ci-dessous liste les stations actives triées par prix. Comparez avec la moyenne du ${f.toLowerCase()} dans la zone tessinoise ${nz} — le côté suisse le plus proche — pour savoir de quel côté de la frontière il est plus avantageux de faire le plein aujourd'hui. Un écart de 0,10-0,20 EUR par litre compense souvent un petit détour au poste-frontière. Pour une estimation du coût global du trajet quotidien, consultez le guide frontalier.`,
    tableTitle: (c) => `Stations à ${c} — prix du jour`,
    tableStation: 'Station',
    tableAddress: 'Adresse',
    tablePrice: 'Prix',
    crossBorderTip: `Vérifiez toujours le temps d'attente au poste-frontière avant de partir : 30 minutes d'attente annulent souvent l'économie au litre.`,
    currency: 'EUR/litre',
    backLink: 'Voir le prix moyen au Tessin',
    noData: 'Aucune donnée de station disponible aujourd\'hui — mise à jour en attente.',
    contextHeading: 'Comment lire les prix du carburant en tant que frontalier',
    contextParagraphs: (f, c, nz) => [
      `Le prix du ${f.toLowerCase()} en Italie dépend de trois composantes : prix industriel (lié au Brent et au taux EUR/USD), accise fixe (environ 0,617 EUR/litre après l'alignement 2024) et TVA à 22 %. En Suisse la structure fiscale est différente : accise plus basse, mais taxe CO₂ et surtaxe sur les carburants importés portent le prix final dans une fourchette distincte. Pour un frontalier parcourant 80-120 km par jour, faire le plein du bon côté de la frontière peut valoir 15-35 EUR par mois.`,
      `À ${c} la bonne comparaison est avec la zone tessinoise ${nz}, le poste-frontière suisse le plus proche. Si le prix italien y est inférieur d'au moins 0,10-0,15 EUR/litre à la moyenne de zone suisse, il vaut mieux faire le plein avant la frontière ; si le Tessin est moins cher, mieux vaut attendre le retour. Capacité du réservoir : 50 litres à 0,20 EUR/litre d'écart valent 10 EUR par plein, 70 litres 14 EUR.`,
      `Le coût réel du trajet quotidien ne se limite pas au carburant : taxe auto, assurance, entretien, pneus et coût d'opportunité du temps comptent aussi. Le <a href="/fr/calculer-salaire/" style="color:var(--color-link)">calculateur salarial</a> intègre ces coûts avec le salaire net pour montrer le gain réel d'un emploi suisse.`,
    ],
    tipsHeading: 'Conseils pratiques pour faire le plein',
    tipsItems: [
      'Consultez l\'appli officielle MIMIT Osservaprezzi ou notre tracker pour le prix en direct avant de vous arrêter.',
      'Évitez les stations self-service aux heures de pointe du matin : prix identique mais file plus longue.',
      'Les stations en bordure de frontière appliquent souvent un supplément de 0,03-0,07 EUR/litre — faites le plein 5-10 km plus tôt.',
      'Conservez les reçus : en cas de déplacements professionnels documentables, ils sont déductibles dans la déclaration fiscale italienne.',
    ],
  },
};

function renderItalianCityPage(opts: {
  entry: ItalianCityEntry;
  locale: FuelDailyLocale;
  fuel: FuelType;
  stations: ItalianCityStation[];
  /**
   * Per-station contexts (with slugs) used to render clickable cards linking
   * to /italia/{city}/stazioni/{slug}/ detail pages. When empty, the page
   * falls back to the legacy non-clickable table — used for fuels where we
   * don't yet generate per-station pages (currently anything but benzina).
   */
  stationContexts?: ItalianStationContext[];
  /**
   * Daily snapshot history. When provided AND fuel === 'benzina', the
   * multi-range area chart card is rendered using italianCities[citySlug].
   * Diesel pages always skip the chart (no IT history for diesel).
   */
  history?: HistorySnapshot[];
  canonicalPath: string;
  alternates: Record<FuelDailyLocale, string>;
  today: Date;
  distDir?: string;
}): string {
  const { entry, locale, fuel, stations, history, canonicalPath, alternates, today, distDir } = opts;
  const copy = IT_CITY_COPY[locale];
  const fuelLabel = FUEL_TYPE_LABEL[locale][fuel];
  const canonicalUrl = `${BASE_URL}${canonicalPath}`;
  const dateStamp = today.toISOString().slice(0, 10);

  const sortedStations = [...stations]
    .filter((s) => typeof s.priceEur === 'number')
    .sort((a, b) => (a.priceEur ?? Infinity) - (b.priceEur ?? Infinity))
    .slice(0, 10);
  const minPrice = sortedStations[0]?.priceEur ?? null;
  const minPriceFmt = minPrice !== null ? formatPrice(minPrice, locale) : '—';
  const nearestZoneLabel = FUEL_ZONE_DISPLAY[entry.nearestZone];

  // Today's city-average price (used as the chart's most-recent point)
  const numericPrices = sortedStations
    .map((s) => s.priceEur)
    .filter((p): p is number => typeof p === 'number');
  const cityAvgToday = mean(numericPrices);

  const h1 = copy.h1(fuelLabel, entry.display);
  const intro = copy.intro(fuelLabel, entry.display, minPriceFmt);
  const paragraph = copy.paragraph(fuelLabel, entry.display, minPriceFmt, nearestZoneLabel);

  const alternatesHtml = renderHreflangTags(alternates);

  // Chart card: only for benzina (the only IT fuel with history coverage today)
  // and only when history snapshots are provided.
  const historyCard = history && fuel === 'benzina'
    ? (() => {
        const seriesByRange = FUEL_RANGE_KEYS.reduce(
          (acc, rk) => {
            acc[rk] = buildItalianHistorySeries(history, entry.slug, FUEL_RANGE_DAYS[rk], today, cityAvgToday);
            return acc;
          },
          {} as Record<FuelRangeKey, FuelSeriesPoint[]>,
        );
        return renderFuelHistoryCard({
          locale,
          trendLabel: IT_TREND_LABEL[locale],
          buildAriaLabel: (avgFmt) => IT_CHART_ARIA[locale](entry.display, avgFmt),
          seriesByRange,
          currency: 'EUR',
        });
      })()
    : '';

  // Top-station listing. When per-station detail pages exist for this fuel
  // (currently benzina only — see ItalianStationContext block), render a
  // clickable card list so users can drill into each station; otherwise fall
  // back to a static table.
  const stationContexts = opts.stationContexts ?? [];
  const ctxBySlug = new Map(stationContexts.map((c) => [c.station.id ?? '', c]));
  const stationListHtml = sortedStations.length === 0
    ? `<p style="padding:12px 16px;border-radius:12px;background:var(--color-warning-subtle);color:var(--color-warning)">${esc(copy.noData)}</p>`
    : stationContexts.length > 0
      ? `<ol style="list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:10px">${sortedStations
          .map((s) => {
            const matched = s.id ? ctxBySlug.get(s.id) : undefined;
            const href = matched ? buildFuelItalianStationPath(locale, fuel, entry.slug, matched.slug) : undefined;
            const card = renderEntityCard({
              href,
              iconSvg: ICON_FUEL_SVG,
              title: s.stationName || s.brand || '—',
              subtitle: s.address || '—',
              metric: `${typeof s.priceEur === 'number' ? formatPrice(s.priceEur, locale) : '—'} ${copy.currency}`,
              metricTone: 'accent',
            });
            return `<li style="margin:0;padding:0">${card}</li>`;
          })
          .join('')}</ol>`
      : `<table style="${TABLE_STYLE};font-size:14px">
        <thead><tr>
          <th scope="col" style="${TABLE_HEAD_STYLE}">${esc(copy.tableStation)}</th>
          <th scope="col" style="${TABLE_HEAD_STYLE}">${esc(copy.tableAddress)}</th>
          <th scope="col" style="${TABLE_HEAD_STYLE};text-align:right">${esc(copy.tablePrice)}</th>
        </tr></thead>
        <tbody>${sortedStations
          .map((s) => `<tr>
            <td style="${TABLE_CELL_STYLE}">${esc(s.stationName || s.brand || '—')}</td>
            <td style="${TABLE_CELL_STYLE};color:var(--color-subtle)">${esc(s.address || '—')}</td>
            <td style="${TABLE_CELL_STYLE};text-align:right;font-variant-numeric:tabular-nums">${typeof s.priceEur === 'number' ? formatPrice(s.priceEur, locale) + ' EUR' : '—'}</td>
          </tr>`)
          .join('')}</tbody>
      </table>`;

  // JSON-LD
  const breadcrumbLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: locale === 'it' ? 'Home' : locale === 'de' ? 'Startseite' : locale === 'fr' ? 'Accueil' : 'Home', item: `${BASE_URL}/` },
      { '@type': 'ListItem', position: 2, name: fuelLabel, item: `${BASE_URL}${FUEL_LOCALE_PREFIX[locale]}/${FUEL_SECTION_SLUG[locale][fuel]}/` },
      { '@type': 'ListItem', position: 3, name: locale === 'it' ? 'Italia' : locale === 'de' ? 'Italien' : locale === 'fr' ? 'Italie' : 'Italy', item: `${BASE_URL}${FUEL_LOCALE_PREFIX[locale]}/${FUEL_SECTION_SLUG[locale][fuel]}/${FUEL_ITALY_SLUG[locale]}/` },
      { '@type': 'ListItem', position: 4, name: entry.display, item: canonicalUrl },
    ],
  });

  const webPageLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: h1,
    url: canonicalUrl,
    description: intro,
    inLanguage: locale,
    dateModified: today.toISOString(),
    datePublished: today.toISOString(),
  });

  const itemListLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: h1,
    numberOfItems: sortedStations.length,
    itemListElement: sortedStations.map((s, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      item: {
        '@type': 'GasStation',
        name: s.stationName || s.brand || `Stazione ${i + 1}`,
        address: s.address,
        ...(typeof s.lat === 'number' && typeof s.lng === 'number'
          ? { geo: { '@type': 'GeoCoordinates', latitude: s.lat, longitude: s.lng } }
          : {}),
      },
    })),
  });

  // Phase 3A — clamp combined title to 60 chars; drop brand first, then
  // dated suffix if even with the date alone the budget overflows.
  const titleWithDate60 = (() => {
    const dated = `${h1} (${dateStamp})`;
    return dated.length <= 60 ? dated : h1;
  })();
  const title = clampSiteSuffix(titleWithDate60, 'Frontaliere Ticino');
  const description = intro.slice(0, 180);

  const bodyHtml = `<article style="max-width:1100px;margin:0 auto;padding:32px 20px 56px">
  <nav aria-label="Breadcrumb" style="${BREADCRUMB_STYLE}">
    <a href="${BASE_URL}/" style="${BREADCRUMB_LINK_STYLE}">Home</a>
    <span> / </span>
    <a href="${BASE_URL}${FUEL_LOCALE_PREFIX[locale]}/${FUEL_SECTION_SLUG[locale][fuel]}/${FUEL_TODAY_SLUG[locale]}/" style="${BREADCRUMB_LINK_STYLE}">${esc(fuelLabel)}</a>
    <span> / </span>
    <span>${esc(entry.display)}</span>
  </nav>
  <header style="margin-bottom:22px">
    <p style="${HERO_EYEBROW_STYLE}">${esc(dateStamp)}</p>
    <h1 style="${H1_STYLE}">${esc(h1)}</h1>
    <p style="${LEDE_STYLE}">${esc(intro)}</p>
  </header>
  <section style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px;margin:0 0 24px">
    <div style="${STAT_TILE_ACCENT}">
      <div style="${STAT_TILE_LABEL}">${esc(locale === 'it' ? 'Prezzo minimo' : locale === 'de' ? 'Mindestpreis' : locale === 'fr' ? 'Prix minimum' : 'Minimum price')}</div>
      <div style="${STAT_TILE_VALUE};font-size:32px">${esc(minPriceFmt)}</div>
      <div style="margin-top:2px;font-size:13px;color:var(--color-subtle)">${esc(copy.currency)}</div>
    </div>
    <div style="${STAT_TILE_SUCCESS}">
      <div style="${STAT_TILE_LABEL}">${esc(locale === 'it' ? 'Zona Ticino più vicina' : locale === 'de' ? 'Nächste Tessiner Zone' : locale === 'fr' ? 'Zone tessinoise la plus proche' : 'Nearest Ticino zone')}</div>
      <div style="${STAT_TILE_VALUE};font-size:22px"><a href="${BASE_URL}${buildFuelTodayPath(locale, fuel, entry.nearestZone)}" style="color:inherit;text-decoration:underline">${esc(nearestZoneLabel)}</a></div>
    </div>
  </section>
  <section style="margin:0 0 24px">
    <p style="margin:0 0 14px;color:var(--color-body);line-height:1.7;max-width:860px">${esc(paragraph)}</p>
  </section>
  <section style="margin:0 0 24px" aria-labelledby="itCityTable">
    <h2 id="itCityTable" style="${H2_STYLE}">${esc(copy.tableTitle(entry.display))}</h2>
    ${stationListHtml}
  </section>
  ${historyCard
    ? `<section style="margin:0 0 24px" aria-labelledby="itCityTrend">
        <h2 id="itCityTrend" style="${H2_STYLE}">${esc(IT_TREND_LABEL[locale])}</h2>
        <p style="margin:0 0 12px;color:var(--color-subtle);line-height:1.6">${esc(IT_TREND_INTRO[locale])}</p>
        ${historyCard}
      </section>`
    : ''}
  <section style="margin:0 0 24px;padding:16px 18px;border-radius:14px;background:var(--color-warning-subtle);border:1px solid var(--color-warning-border);color:var(--color-warning)">
    <p style="margin:0;line-height:1.6">${esc(copy.crossBorderTip)}</p>
  </section>
  <section style="margin:0 0 24px" aria-labelledby="itCityContext">
    <h2 id="itCityContext" style="${H2_STYLE}">${esc(copy.contextHeading)}</h2>
    ${copy.contextParagraphs(fuelLabel, entry.display, nearestZoneLabel)
      .map((p) => `<p style="margin:0 0 12px;color:var(--color-body);line-height:1.7;max-width:860px">${p}</p>`)
      .join('')}
  </section>
  <section style="margin:0 0 24px" aria-labelledby="itCityTips">
    <h2 id="itCityTips" style="${H2_STYLE}">${esc(copy.tipsHeading)}</h2>
    <ul style="margin:0;padding-left:22px;color:var(--color-body);line-height:1.7;max-width:860px">
      ${copy.tipsItems.map((t) => `<li style="margin:0 0 8px">${esc(t)}</li>`).join('')}
    </ul>
  </section>
  <p style="margin:0 0 22px"><a href="${BASE_URL}${buildFuelTodayPath(locale, fuel, entry.nearestZone)}" style="${LINK_ACCENT_STYLE};font-weight:600">→ ${esc(copy.backLink)} (${esc(nearestZoneLabel)})</a></p>
  ${generateRelatedLinksBlock(locale, 'fuel_italian_city', {
    fuelType: fuel,
    italianCitySlug: entry.slug,
    italianCityDisplay: entry.display,
    fuelZone: entry.nearestZone,
  })}
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
    ogLocale: LOCALE_OG[locale],
    hreflangHtml: alternatesHtml,
    extraHeadHtml: extraHead,
    jsonLdScripts: [breadcrumbLd, webPageLd, itemListLd],
    bodyHtml,
    distDir,
    hubChrome: { hubKey: 'stats', activeSubTab: 'fuel-prices' },
  });
}

// ── Exported generators for station + IT-city pages ────────────

/**
 * Generate per-station HTML pages for every (Ticino station × fuel × locale).
 * Returns a map of canonical path → HTML string.
 *
 * Safety cap: MAX_FUEL_STATION_PAGES_PER_BUILD (env var). When exceeded the
 * generator stops emitting and logs a warning.
 */
export function generateFuelStationPages(opts: {
  dataset: FuelPricesDataset;
  today?: Date;
  distDir?: string;
  maxPages?: number;
}): Record<string, string> {
  const dataset = opts.dataset;
  const today = opts.today ?? new Date();
  const distDir = opts.distDir;
  const maxPages = opts.maxPages ?? Number(process.env.MAX_FUEL_STATION_PAGES_PER_BUILD || 1500);
  const pages: Record<string, string> = {};

  const contexts = collectSwissStationContexts(dataset);
  if (contexts.length === 0) return pages;

  const zoneGroups = groupByZone(contexts);

  // Precompute zone averages per fuel
  const zoneAvg: Record<FuelZone, Record<FuelType, number | null>> = {
    chiasso: { diesel: null, benzina: null },
    mendrisio: { diesel: null, benzina: null },
    lugano: { diesel: null, benzina: null },
    bellinzona: { diesel: null, benzina: null },
    locarno: { diesel: null, benzina: null },
  };
  for (const zone of FUEL_ZONES) {
    const ctxList = zoneGroups.get(zone) ?? [];
    for (const fuel of FUEL_TYPES) {
      const prices = ctxList.map((c) => c.prices[fuel]);
      zoneAvg[zone][fuel] = mean(prices);
    }
  }

  let emitted = 0;
  outer: for (const fuel of FUEL_TYPES) {
    for (const locale of FUEL_DAILY_LOCALES) {
      for (const ctx of contexts) {
        const canonicalPath = buildFuelStationPath(locale, fuel, ctx.zone, ctx.slug);
        // Precompute alternates for all 4 locales
        const alternates: Record<FuelDailyLocale, string> = { it: '', en: '', de: '', fr: '' };
        for (const alt of FUEL_DAILY_LOCALES) {
          alternates[alt] = buildFuelStationPath(alt, fuel, ctx.zone, ctx.slug);
        }
        const zoneStations = zoneGroups.get(ctx.zone) ?? [];
        const html = renderStationPage({
          ctx,
          locale,
          fuel,
          zoneAvg: zoneAvg[ctx.zone][fuel],
          zoneStations,
          today,
          canonicalPath,
          alternates,
          distDir,
        });
        pages[canonicalPath] = html;
        emitted++;
        if (emitted >= maxPages) {
          console.warn(`[fuel-daily-pages] MAX_FUEL_STATION_PAGES_PER_BUILD=${maxPages} reached — halting station page emission`);
          break outer;
        }
      }
    }
  }
  return pages;
}

/**
 * Generate Italian per-city hub pages for the curated list of border cities.
 */
export function generateFuelItalianCityPages(opts: {
  dataset: FuelPricesDataset;
  history?: HistorySnapshot[];
  today?: Date;
  distDir?: string;
}): Record<string, string> {
  const dataset = opts.dataset;
  const history = opts.history ?? [];
  const today = opts.today ?? new Date();
  const distDir = opts.distDir;
  const pages: Record<string, string> = {};

  // Precompute Italian per-station contexts once. Cards on the city pages
  // link to per-station detail pages (which only exist for benzina today).
  const allItalianContexts = collectItalianStationContexts(dataset);
  const contextsByCity = groupItalianContextsByCity(allItalianContexts);

  for (const entry of FUEL_ITALIAN_CITIES) {
    const stations = collectItalianCityStations(dataset, entry);
    if (stations.length === 0) continue; // skip if no station data
    const cityContexts = contextsByCity.get(entry.slug) ?? [];
    for (const fuel of FUEL_TYPES) {
      for (const locale of FUEL_DAILY_LOCALES) {
        const canonicalPath = buildFuelItalianCityPath(locale, fuel, entry.slug);
        const alternates: Record<FuelDailyLocale, string> = { it: '', en: '', de: '', fr: '' };
        for (const alt of FUEL_DAILY_LOCALES) {
          alternates[alt] = buildFuelItalianCityPath(alt, fuel, entry.slug);
        }
        // Per-station detail pages only exist for benzina (see
        // generateFuelItalianStationPages comment block). On diesel city
        // pages we omit stationContexts so the renderer falls back to a
        // non-clickable table — avoids broken /prezzi-diesel/.../stazioni/...
        // links until MIMIT-Gasolio ingestion lands.
        const stationContexts = fuel === 'benzina' ? cityContexts : undefined;
        const html = renderItalianCityPage({
          entry,
          locale,
          fuel,
          stations,
          stationContexts,
          history,
          canonicalPath,
          alternates,
          today,
          distDir,
        });
        pages[canonicalPath] = html;
      }
    }
  }
  return pages;
}

// ── Italian per-station rendering ──────────────────────────────
//
// Mirror of the Swiss per-station pipeline (collectSwissStationContexts +
// renderStationPage + generateFuelStationPages) but for Italian curated
// border cities. The MIMIT dataset gives us per-station identity (id,
// stationName, brand, address, lat/lng, priceEur) so we can emit one
// page per station with editorial copy + structured data.
//
// Caveat: scripts/generate-fuel-prices-dataset.mjs currently only ingests
// MIMIT records with descCarburante === 'Benzina'. Diesel (Gasolio) is
// available in the upstream CSV but not yet pulled into our dataset, so
// we only emit /prezzi-benzina/italia/{city}/stazioni/{slug}/ — never the
// diesel variant. When the ingestion script is extended, this block can
// drop the fuel filter.

interface ItalianStationContext {
  readonly station: ItalianCityStation;
  readonly cityEntry: ItalianCityEntry;
  readonly slug: string;
  readonly brandDisplay: string;
  readonly streetDisplay: string;
  readonly priceEur: number;
}

/**
 * Collect Italian per-station contexts grouped by curated city. Dedupes
 * by station id (each station appears twice in the dataset — once for
 * `isSelf:true` and once for `isSelf:false`) keeping the cheaper variant.
 */
function collectItalianStationContexts(
  dataset: FuelPricesDataset,
): ItalianStationContext[] {
  const out: ItalianStationContext[] = [];
  const slugSeen = new Set<string>();

  for (const entry of FUEL_ITALIAN_CITIES) {
    const rawStations = collectItalianCityStations(dataset, entry);
    // Dedupe by id, prefer the cheapest variant (typically self-service).
    const byId = new Map<string, ItalianCityStation>();
    for (const s of rawStations) {
      if (!s.id) continue;
      if (typeof s.priceEur !== 'number' || !Number.isFinite(s.priceEur)) continue;
      const existing = byId.get(s.id);
      if (!existing || (existing.priceEur ?? Infinity) > s.priceEur) {
        byId.set(s.id, s);
      }
    }

    for (const s of byId.values()) {
      if (!s.brand && !s.stationName) continue;
      const baseSlug = buildStationSlug({
        brand: s.brand,
        name: s.stationName,
        address: s.address,
      });
      if (!baseSlug) continue;

      // Ensure slug uniqueness within this city
      let slug = baseSlug;
      let suffix = 2;
      while (slugSeen.has(`${entry.slug}/${slug}`)) {
        slug = `${baseSlug}-${suffix++}`;
      }
      slugSeen.add(`${entry.slug}/${slug}`);

      // Strip postal-code suffix from address tail to get a clean street label
      const rawAddr = (s.address ?? '').trim();
      const street = rawAddr.replace(/\s+\d{5}\s*$/, '').trim() || rawAddr;
      const brandDisplay =
        s.brand && s.brand.toUpperCase() !== 'UNDEFINED'
          ? titleCase(s.brand)
          : s.stationName
            ? titleCase(s.stationName.split(/\s+/)[0] ?? 'Stazione')
            : 'Stazione';

      out.push({
        station: s,
        cityEntry: entry,
        slug,
        brandDisplay,
        streetDisplay: street,
        priceEur: s.priceEur as number,
      });
    }
  }
  return out;
}

function groupItalianContextsByCity(
  contexts: ItalianStationContext[],
): Map<string, ItalianStationContext[]> {
  const out = new Map<string, ItalianStationContext[]>();
  for (const c of contexts) {
    const arr = out.get(c.cityEntry.slug) ?? [];
    arr.push(c);
    out.set(c.cityEntry.slug, arr);
  }
  return out;
}

interface ItalianStationCopy {
  readonly h1: (brand: string, street: string, city: string, fuelLabel: string) => string;
  readonly intro: (brand: string, city: string, price: string, fuelLabel: string) => string;
  readonly paragraph: (brand: string, city: string, price: string, cityAvg: string, fuelLabel: string) => string;
  readonly ranking: (rank: string, total: number, city: string) => string;
  readonly infoHeading: string;
  readonly infoBrand: string;
  readonly infoAddress: string;
  readonly infoUpdated: string;
  readonly infoSelfService: string;
  readonly currency: string;
  readonly backToCity: (city: string) => string;
  readonly rankCheapest: string;
  readonly rankMedian: string;
  readonly rankPremium: string;
  readonly deltaVsCity: string;
  readonly priceLabel: string;
  readonly contextHeading: string;
  readonly contextParagraphs: (brand: string, city: string, nearestZoneLabel: string) => string[];
  readonly siblingsHeading: string;
  readonly breadcrumbHome: string;
  readonly italyLabel: string;
}

const IT_STATION_COPY: Record<FuelDailyLocale, ItalianStationCopy> = {
  it: {
    h1: (b, st, c, f) => `Prezzo ${f.toLowerCase()} ${b} ${st} a ${c}`,
    intro: (b, c, p, f) =>
      `La stazione ${b} a ${c} oggi vende ${f.toLowerCase()} a ${p} EUR/litro. I prezzi vengono aggiornati ogni mattina dalle rilevazioni MIMIT delle stazioni italiane attive — utili per pianificare il rifornimento prima del valico.`,
    paragraph: (b, c, p, cAvg, f) =>
      `Alla stazione ${b} di ${c} il prezzo del ${f.toLowerCase()} è ${p} EUR/litro contro una media città di ${cAvg} EUR/litro. Confronta questo dato con la media svizzera della zona Ticino più vicina per decidere da che lato del confine conviene fare il pieno oggi. La differenza tipica fra Italia e Ticino è di 0,10-0,30 EUR/litro a favore dell'Italia, ma controlla sempre la coda al valico: 30 minuti di attesa possono annullare il vantaggio.`,
    ranking: (r, t, c) => `Posizione nella classifica di ${c}: ${r} (${t} stazioni rilevate).`,
    infoHeading: 'Informazioni stazione',
    infoBrand: 'Marchio',
    infoAddress: 'Indirizzo',
    infoUpdated: 'Ultimo aggiornamento prezzo',
    infoSelfService: 'Modalità rifornimento',
    currency: 'EUR/litro',
    backToCity: (c) => `Torna al prezzo medio a ${c}`,
    rankCheapest: 'più economica',
    rankMedian: 'mediana',
    rankPremium: 'premium',
    deltaVsCity: 'vs media città',
    priceLabel: 'Prezzo oggi',
    contextHeading: 'Conviene fare il pieno qui prima del valico?',
    contextParagraphs: (_b, c, nz) => [
      `${c} è uno dei comuni di confine più frequentati dai frontalieri ticinesi. La stazione qui sotto si valuta rispetto a tre parametri: distanza dal valico più vicino, differenza di prezzo rispetto alla zona Ticino di ${nz}, modalità di rifornimento (self-service è in genere 0,10-0,15 EUR/litro più conveniente). Se rientri la sera dopo il lavoro in Ticino, fare il pieno qui è quasi sempre vantaggioso quando il prezzo svizzero supera di 0,10 EUR/litro quello italiano.`,
      `Considera però il tempo: una coda di 30 minuti al valico al rientro vale circa 5-8 EUR di costo opportunità. Per un pieno da 50 litri il vantaggio massimo italiano (0,30 EUR/litro = 15 EUR) si dimezza. Controlla sempre i tempi di attesa alla dogana prima di programmare la deviazione, e leggi la guida frontalieri per stimare il costo complessivo del tragitto giornaliero.`,
    ],
    siblingsHeading: 'Altre stazioni in città',
    breadcrumbHome: 'Home',
    italyLabel: 'Italia',
  },
  en: {
    h1: (b, st, c, f) => `${f} price ${b} ${st} in ${c}`,
    intro: (b, c, p, f) =>
      `The ${b} station in ${c} currently sells ${f.toLowerCase()} at ${p} EUR per litre. Prices are refreshed daily from the Italian Ministry (MIMIT) station feed — useful to plan your fill-up before the border crossing.`,
    paragraph: (b, c, p, cAvg, f) =>
      `At the ${b} station in ${c} the ${f.toLowerCase()} price is ${p} EUR per litre vs the city average of ${cAvg} EUR per litre. Compare this figure with the Swiss Ticino zone average to decide which side of the border to fill up on today. The typical Italy-vs-Ticino gap is 0.10-0.30 EUR/litre in Italy's favour, but always check the border queue: a 30-minute wait can wipe out the saving.`,
    ranking: (r, t, c) => `Rank in ${c}: ${r} (${t} stations observed).`,
    infoHeading: 'Station info',
    infoBrand: 'Brand',
    infoAddress: 'Address',
    infoUpdated: 'Last price update',
    infoSelfService: 'Service mode',
    currency: 'EUR/litre',
    backToCity: (c) => `Back to ${c} city average`,
    rankCheapest: 'cheapest',
    rankMedian: 'median',
    rankPremium: 'premium',
    deltaVsCity: 'vs city avg',
    priceLabel: 'Price today',
    contextHeading: 'Worth filling up here before crossing?',
    contextParagraphs: (_b, c, nz) => [
      `${c} is one of the busiest border towns for Ticino cross-border commuters. This station is evaluated against three factors: distance from the nearest crossing, price gap with the Ticino ${nz} zone, and service mode (self-service is typically 0.10-0.15 EUR/litre cheaper). If you drive home in the evening after work in Ticino, filling up here is almost always worth it when the Swiss price is more than 0.10 EUR/litre above the Italian one.`,
      `Factor in time though: a 30-minute border queue costs ~5-8 EUR in opportunity. For a 50-litre tank the max Italian advantage (0.30 EUR/litre = 15 EUR) is halved. Always check live border wait times before planning the detour, and read the cross-border commuter guide to estimate total daily commute costs.`,
    ],
    siblingsHeading: 'Other stations in town',
    breadcrumbHome: 'Home',
    italyLabel: 'Italy',
  },
  de: {
    h1: (b, st, c, f) => `${f}preis ${b} ${st} in ${c}`,
    intro: (b, c, p, f) =>
      `Die Tankstelle ${b} in ${c} verkauft heute ${f} zum Preis von ${p} EUR pro Liter. Die Preise werden täglich aus den MIMIT-Daten aktiver italienischer Tankstellen aktualisiert — nützlich, um das Tanken vor dem Grenzübertritt zu planen.`,
    paragraph: (b, c, p, cAvg, f) =>
      `An der Tankstelle ${b} in ${c} liegt der ${f}preis bei ${p} EUR pro Liter gegenüber einem Stadtdurchschnitt von ${cAvg} EUR pro Liter. Vergleiche den Wert mit dem Tessiner Zonendurchschnitt, um zu entscheiden, auf welcher Grenzseite du heute tanken solltest. Der typische Vorteil Italiens gegenüber dem Tessin liegt bei 0,10-0,30 EUR/Liter, aber prüfe immer die Wartezeit am Grenzübergang: 30 Minuten zehren den Vorteil auf.`,
    ranking: (r, t, c) => `Rang in ${c}: ${r} (${t} erfasste Tankstellen).`,
    infoHeading: 'Tankstellen-Infos',
    infoBrand: 'Marke',
    infoAddress: 'Adresse',
    infoUpdated: 'Letzte Preisaktualisierung',
    infoSelfService: 'Bedienmodus',
    currency: 'EUR/Liter',
    backToCity: (c) => `Zurück zum Stadtdurchschnitt ${c}`,
    rankCheapest: 'günstigste',
    rankMedian: 'Median',
    rankPremium: 'Premium',
    deltaVsCity: 'vs Stadt-Ø',
    priceLabel: 'Preis heute',
    contextHeading: 'Lohnt sich das Tanken hier vor dem Grenzübergang?',
    contextParagraphs: (_b, c, nz) => [
      `${c} ist einer der meistgenutzten Grenzorte der Tessiner Grenzgänger. Die Tankstelle hier bewertet sich nach drei Faktoren: Distanz zum nächsten Grenzübergang, Preisdifferenz zur Tessiner Zone ${nz} und Bedienmodus (Self-Service ist typischerweise 0,10-0,15 EUR/Liter günstiger). Wenn du abends nach der Arbeit im Tessin nach Hause fährst, lohnt sich das Tanken hier fast immer, sobald der Schweizer Preis mehr als 0,10 EUR/Liter über dem italienischen liegt.`,
      `Berücksichtige aber die Zeit: 30 Minuten Grenzwartezeit kosten etwa 5-8 EUR an Opportunitätskosten. Bei 50 Liter halbiert das den maximalen italienischen Vorteil (0,30 EUR/Liter = 15 EUR). Prüfe stets die aktuellen Grenzwartezeiten und lies den Grenzgänger-Leitfaden für die gesamte Pendel-Kostenrechnung.`,
    ],
    siblingsHeading: 'Andere Tankstellen in der Stadt',
    breadcrumbHome: 'Startseite',
    italyLabel: 'Italien',
  },
  fr: {
    h1: (b, st, c, f) => `Prix du ${f.toLowerCase()} ${b} ${st} à ${c}`,
    intro: (b, c, p, f) =>
      `La station ${b} à ${c} vend aujourd'hui du ${f.toLowerCase()} à ${p} EUR le litre. Les prix sont mis à jour chaque jour à partir des données MIMIT des stations italiennes actives — utile pour planifier le plein avant le passage à la frontière.`,
    paragraph: (b, c, p, cAvg, f) =>
      `À la station ${b} de ${c} le prix du ${f.toLowerCase()} est de ${p} EUR le litre contre une moyenne ville de ${cAvg} EUR le litre. Comparez cet écart avec la moyenne tessinoise la plus proche pour choisir de quel côté de la frontière faire le plein aujourd'hui. L'écart typique Italie/Tessin est de 0,10-0,30 EUR/litre en faveur de l'Italie, mais vérifiez toujours la file au passage frontalier : 30 minutes d'attente peuvent annuler l'économie.`,
    ranking: (r, t, c) => `Classement à ${c} : ${r} (${t} stations observées).`,
    infoHeading: 'Infos station',
    infoBrand: 'Marque',
    infoAddress: 'Adresse',
    infoUpdated: 'Dernière mise à jour du prix',
    infoSelfService: 'Mode de service',
    currency: 'EUR/litre',
    backToCity: (c) => `Retour à la moyenne ville ${c}`,
    rankCheapest: 'la moins chère',
    rankMedian: 'médiane',
    rankPremium: 'premium',
    deltaVsCity: 'vs moy. ville',
    priceLabel: 'Prix aujourd\'hui',
    contextHeading: 'Faire le plein ici avant la frontière en vaut-il la peine ?',
    contextParagraphs: (_b, c, nz) => [
      `${c} est l'une des villes-frontière les plus fréquentées par les frontaliers tessinois. Cette station s'évalue selon trois facteurs : distance du poste-frontière le plus proche, écart de prix avec la zone tessinoise de ${nz}, et mode de service (le self-service est typiquement 0,10-0,15 EUR/litre moins cher). Si vous rentrez le soir après le travail au Tessin, faire le plein ici est presque toujours rentable lorsque le prix suisse dépasse de plus de 0,10 EUR/litre le prix italien.`,
      `Tenez compte du temps : 30 minutes d'attente à la frontière coûtent ~5-8 EUR en coût d'opportunité. Pour un plein de 50 litres, l'avantage italien maximal (0,30 EUR/litre = 15 EUR) est divisé par deux. Vérifiez toujours les temps d'attente en direct avant de planifier le détour et lisez le guide frontalier pour estimer le coût total du trajet quotidien.`,
    ],
    siblingsHeading: 'Autres stations en ville',
    breadcrumbHome: 'Accueil',
    italyLabel: 'Italie',
  },
};

function renderItalianStationPage(opts: {
  readonly ctx: ItalianStationContext;
  readonly locale: FuelDailyLocale;
  readonly fuel: FuelType;
  readonly cityAvg: number | null;
  readonly cityStations: ItalianStationContext[];
  readonly history?: HistorySnapshot[];
  readonly today: Date;
  readonly canonicalPath: string;
  readonly alternates: Record<FuelDailyLocale, string>;
  readonly distDir?: string;
}): string {
  const { ctx, locale, fuel, cityAvg, cityStations, history, today, canonicalPath, alternates, distDir } = opts;
  const copy = IT_STATION_COPY[locale];
  const fuelLabel = FUEL_TYPE_LABEL[locale][fuel];
  const cityName = ctx.cityEntry.display;
  const dateStamp = today.toISOString().slice(0, 10);
  const canonicalUrl = `${BASE_URL}${canonicalPath}`;

  const price = ctx.priceEur;
  const priceFmt = formatPrice(price, locale);
  const cityAvgFmt = formatPrice(cityAvg, locale);

  // Rank within city by price
  const sortedByPrice = [...cityStations].sort((a, b) => a.priceEur - b.priceEur);
  const rankIdx = sortedByPrice.findIndex((c) => c.slug === ctx.slug);
  const total = sortedByPrice.length;
  const rankLabel =
    rankIdx < total / 3
      ? copy.rankCheapest
      : rankIdx < (2 * total) / 3
        ? copy.rankMedian
        : copy.rankPremium;

  const deltaCity = cityAvg !== null ? Number((price - cityAvg).toFixed(3)) : null;
  const deltaCityFmt = formatDelta(deltaCity, locale).replace('CHF', 'EUR');

  const h1 = copy.h1(ctx.brandDisplay, ctx.streetDisplay, cityName, fuelLabel);
  const intro = copy.intro(ctx.brandDisplay, cityName, priceFmt, fuelLabel);
  const paragraph = copy.paragraph(ctx.brandDisplay, cityName, priceFmt, cityAvgFmt, fuelLabel);
  const rankingLine = copy.ranking(rankLabel, total, cityName);

  const alternatesHtml = renderHreflangTags(alternates);

  // Sibling stations for related-links (max 6, exclude self)
  const siblingStations = cityStations
    .filter((s) => s.slug !== ctx.slug)
    .slice(0, 6);

  // JSON-LD
  const breadcrumbLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: copy.breadcrumbHome, item: `${BASE_URL}/` },
      { '@type': 'ListItem', position: 2, name: fuelLabel, item: `${BASE_URL}${FUEL_LOCALE_PREFIX[locale]}/${FUEL_SECTION_SLUG[locale][fuel]}/` },
      { '@type': 'ListItem', position: 3, name: copy.italyLabel, item: `${BASE_URL}${FUEL_LOCALE_PREFIX[locale]}/${FUEL_SECTION_SLUG[locale][fuel]}/${FUEL_ITALY_SLUG[locale]}/` },
      { '@type': 'ListItem', position: 4, name: cityName, item: `${BASE_URL}${buildFuelItalianCityPath(locale, fuel, ctx.cityEntry.slug)}` },
      { '@type': 'ListItem', position: 5, name: `${ctx.brandDisplay} ${ctx.streetDisplay}`.trim(), item: canonicalUrl },
    ],
  });

  const webPageLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: h1,
    url: canonicalUrl,
    description: intro,
    inLanguage: locale,
    dateModified: today.toISOString(),
    datePublished: today.toISOString(),
  });

  const gasStationLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'GasStation',
    name: `${ctx.brandDisplay} ${ctx.streetDisplay}`.trim(),
    address: {
      '@type': 'PostalAddress',
      streetAddress: ctx.streetDisplay,
      addressLocality: cityName,
      addressRegion: ctx.cityEntry.province,
      addressCountry: 'IT',
    },
    ...(typeof ctx.station.lat === 'number' && typeof ctx.station.lng === 'number'
      ? {
          geo: {
            '@type': 'GeoCoordinates',
            latitude: ctx.station.lat,
            longitude: ctx.station.lng,
          },
        }
      : {}),
    brand: ctx.brandDisplay,
    url: canonicalUrl,
  });

  // Phase 3A — total <title> ≤60 char (Semrush W2): trim H1 to fit, then
  // optionally append the dated badge + brand suffix as long as room remains.
  const titleBudget = 60;
  const trimmedH1 = h1.length <= titleBudget
    ? h1
    : (() => {
        const slice = h1.slice(0, titleBudget);
        const lastSpace = slice.lastIndexOf(' ');
        const base = lastSpace > 30 ? slice.slice(0, lastSpace) : slice;
        return base.replace(/[\s.,;:\-–—|]+$/u, '');
      })();
  const dated = `${trimmedH1} (${dateStamp})`;
  const withDate = dated.length <= titleBudget ? dated : trimmedH1;
  const title = clampSiteSuffix(withDate, 'Frontaliere Ticino', titleBudget);
  const description = intro.slice(0, 180);

  const nearestZoneLabel = FUEL_ZONE_DISPLAY[ctx.cityEntry.nearestZone];
  const cityHubPath = buildFuelItalianCityPath(locale, fuel, ctx.cityEntry.slug);

  // Chart card: re-uses the city-level history (per-station history isn't
  // tracked). Frames the chart as the city trend so users understand the
  // data source. Only emitted when history is provided + benzina (the only
  // fuel currently in the IT pipeline).
  const historyCard = history && fuel === 'benzina'
    ? (() => {
        const seriesByRange = FUEL_RANGE_KEYS.reduce(
          (acc, rk) => {
            acc[rk] = buildItalianHistorySeries(history, ctx.cityEntry.slug, FUEL_RANGE_DAYS[rk], today, cityAvg);
            return acc;
          },
          {} as Record<FuelRangeKey, FuelSeriesPoint[]>,
        );
        return renderFuelHistoryCard({
          locale,
          trendLabel: IT_TREND_LABEL[locale],
          buildAriaLabel: (avgFmt) => IT_CHART_ARIA[locale](cityName, avgFmt),
          seriesByRange,
          currency: 'EUR',
        });
      })()
    : '';

  const siblingsHtml = siblingStations.length > 0
    ? `<section style="margin:32px 0 0" aria-labelledby="itStationSiblings">
        <h2 id="itStationSiblings" style="${H2_STYLE}">${esc(copy.siblingsHeading)}</h2>
        <ul style="list-style:none;padding:0;margin:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px">
          ${siblingStations
            .map((s) => {
              const href = buildFuelItalianStationPath(locale, fuel, s.cityEntry.slug, s.slug);
              return `<li style="margin:0"><a href="${esc(href)}" style="${LINK_ACCENT_STYLE};font-weight:600;display:block;padding:10px 12px;border-radius:10px;background:var(--color-surface);border:1px solid var(--color-edge);text-decoration:none">${esc(s.brandDisplay)} ${esc(s.streetDisplay)}</a></li>`;
            })
            .join('')}
        </ul>
      </section>`
    : '';

  const bodyHtml = `<article style="max-width:1100px;margin:0 auto;padding:32px 20px 56px">
  <nav aria-label="Breadcrumb" style="${BREADCRUMB_STYLE}">
    <a href="${BASE_URL}/" style="${BREADCRUMB_LINK_STYLE}">${esc(copy.breadcrumbHome)}</a>
    <span> / </span>
    <a href="${BASE_URL}${FUEL_LOCALE_PREFIX[locale]}/${FUEL_SECTION_SLUG[locale][fuel]}/${FUEL_TODAY_SLUG[locale]}/" style="${BREADCRUMB_LINK_STYLE}">${esc(fuelLabel)}</a>
    <span> / </span>
    <a href="${BASE_URL}${cityHubPath}" style="${BREADCRUMB_LINK_STYLE}">${esc(cityName)}</a>
    <span> / </span>
    <span>${esc(ctx.brandDisplay)} ${esc(ctx.streetDisplay)}</span>
  </nav>
  <header style="margin-bottom:22px">
    <p style="${HERO_EYEBROW_STYLE}">${esc(dateStamp)}</p>
    <h1 style="${H1_STYLE}">${esc(h1)}</h1>
    <p style="${LEDE_STYLE}">${esc(intro)}</p>
  </header>
  <section style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;margin:0 0 24px">
    <div style="${STAT_TILE_ACCENT}">
      <div style="${STAT_TILE_LABEL}">${esc(copy.priceLabel)}</div>
      <div style="${STAT_TILE_VALUE};font-size:32px">${priceFmt}</div>
      <div style="margin-top:2px;font-size:13px;color:var(--color-subtle)">${esc(copy.currency)}</div>
    </div>
    <div style="${deltaCity === null ? STAT_TILE_BASE : deltaCity < 0 ? STAT_TILE_SUCCESS : STAT_TILE_WARNING}">
      <div style="${STAT_TILE_LABEL}">${esc(copy.deltaVsCity)}</div>
      <div style="${STAT_TILE_VALUE};font-size:22px">${esc(deltaCityFmt)}</div>
    </div>
    <div style="${STAT_TILE_SUCCESS}">
      <div style="${STAT_TILE_LABEL}">${esc(rankLabel)}</div>
      <div style="${STAT_TILE_VALUE};font-size:18px">${esc(rankingLine)}</div>
    </div>
  </section>
  <section style="margin:0 0 24px">
    <p style="margin:0 0 14px;color:var(--color-body);line-height:1.7;max-width:860px">${esc(paragraph)}</p>
  </section>
  <section style="margin:0 0 24px;${CARD_STYLE}" aria-labelledby="itStationInfo">
    <h2 id="itStationInfo" style="${H2_STYLE}">${esc(copy.infoHeading)}</h2>
    <dl style="margin:0;display:grid;grid-template-columns:max-content 1fr;column-gap:16px;row-gap:8px;font-size:14px;color:var(--color-body)">
      <dt style="font-weight:600">${esc(copy.infoBrand)}</dt><dd style="margin:0">${esc(ctx.brandDisplay)}</dd>
      <dt style="font-weight:600">${esc(copy.infoAddress)}</dt><dd style="margin:0">${esc(ctx.station.address ?? '—')}, ${esc(cityName)} (${esc(ctx.cityEntry.province)})</dd>
      ${typeof ctx.station.isSelf === 'boolean' ? `<dt style="font-weight:600">${esc(copy.infoSelfService)}</dt><dd style="margin:0">${ctx.station.isSelf ? 'Self-service' : (locale === 'it' ? 'Servito' : locale === 'de' ? 'Bedient' : locale === 'fr' ? 'Servi' : 'Served')}</dd>` : ''}
      ${ctx.station.updatedAt ? `<dt style="font-weight:600">${esc(copy.infoUpdated)}</dt><dd style="margin:0">${esc(String(ctx.station.updatedAt).slice(0, 10))}</dd>` : ''}
    </dl>
  </section>
  <section style="margin:0 0 24px" aria-labelledby="itStationContext">
    <h2 id="itStationContext" style="${H2_STYLE}">${esc(copy.contextHeading)}</h2>
    ${copy.contextParagraphs(ctx.brandDisplay, cityName, nearestZoneLabel)
      .map((p) => `<p style="margin:0 0 12px;color:var(--color-body);line-height:1.7;max-width:860px">${p}</p>`)
      .join('')}
  </section>
  ${historyCard
    ? `<section style="margin:0 0 24px" aria-labelledby="itStationTrend">
        <h2 id="itStationTrend" style="${H2_STYLE}">${esc(IT_TREND_LABEL[locale])}</h2>
        <p style="margin:0 0 12px;color:var(--color-subtle);line-height:1.6">${esc(IT_TREND_INTRO[locale])}</p>
        ${historyCard}
      </section>`
    : ''}
  <p style="margin:0 0 22px"><a href="${BASE_URL}${cityHubPath}" style="${LINK_ACCENT_STYLE};font-weight:600">← ${esc(copy.backToCity(cityName))}</a></p>
  ${siblingsHtml}
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
    ogLocale: LOCALE_OG[locale],
    hreflangHtml: alternatesHtml,
    extraHeadHtml: extraHead,
    jsonLdScripts: [breadcrumbLd, webPageLd, gasStationLd],
    bodyHtml,
    distDir,
    hubChrome: { hubKey: 'stats', activeSubTab: 'fuel-prices' },
  });
}

/**
 * Generate Italian per-station detail pages for all curated cities.
 * Currently emits only for benzina (the only fuel in our IT dataset).
 */
export function generateFuelItalianStationPages(opts: {
  dataset: FuelPricesDataset;
  history?: HistorySnapshot[];
  today?: Date;
  distDir?: string;
}): Record<string, string> {
  const dataset = opts.dataset;
  const history = opts.history ?? [];
  const today = opts.today ?? new Date();
  const distDir = opts.distDir;
  const pages: Record<string, string> = {};

  const contexts = collectItalianStationContexts(dataset);
  if (contexts.length === 0) return pages;

  const cityGroups = groupItalianContextsByCity(contexts);

  // Precompute per-city averages
  const cityAvg = new Map<string, number>();
  for (const [citySlug, list] of cityGroups) {
    const avg = mean(list.map((c) => c.priceEur));
    if (avg !== null) cityAvg.set(citySlug, avg);
  }

  // ⚠️ Benzina-only: see comment block above. When MIMIT-Gasolio
  // ingestion lands in scripts/generate-fuel-prices-dataset.mjs, replace
  // the literal with FUEL_TYPES.
  const fuelsToEmit: FuelType[] = ['benzina'];

  for (const fuel of fuelsToEmit) {
    for (const locale of FUEL_DAILY_LOCALES) {
      for (const ctx of contexts) {
        const canonicalPath = buildFuelItalianStationPath(locale, fuel, ctx.cityEntry.slug, ctx.slug);
        const alternates: Record<FuelDailyLocale, string> = { it: '', en: '', de: '', fr: '' };
        for (const alt of FUEL_DAILY_LOCALES) {
          alternates[alt] = buildFuelItalianStationPath(alt, fuel, ctx.cityEntry.slug, ctx.slug);
        }
        const cityStations = cityGroups.get(ctx.cityEntry.slug) ?? [];
        const html = renderItalianStationPage({
          ctx,
          locale,
          fuel,
          cityAvg: cityAvg.get(ctx.cityEntry.slug) ?? null,
          cityStations,
          history,
          today,
          canonicalPath,
          alternates,
          distDir,
        });
        pages[canonicalPath] = html;
      }
    }
  }

  return pages;
}

// ── Plugin ─────────────────────────────────────────────────────

interface PluginResult {
  pagesWritten: number;
  archivesWritten: number;
  skippedForWordCount: number;
  stationPagesWritten?: number;
  italianCityPagesWritten?: number;
  italianStationPagesWritten?: number;
}

/**
 * Pure generator — used by both the Vite plugin (closeBundle) and tests.
 * Produces a map of canonical path → HTML string.
 */
export function generateFuelDailyPages(opts: {
  rootDir: string;
  dataset: FuelPricesDataset;
  history?: HistorySnapshot[];
  today?: Date;
  /** dist directory; when provided the page renders with hydration tags. */
  distDir?: string;
}): Record<string, string> {
  const dataset = opts.dataset;
  const history = opts.history ?? [];
  const today = opts.today ?? new Date();
  const distDir = opts.distDir;
  const rootDir = opts.rootDir;

  const pages: Record<string, string> = {};

  for (const fuel of FUEL_TYPES) {
    for (const locale of FUEL_DAILY_LOCALES) {
      // Precompute alternates for this fuel & zone combination
      const buildAlternates = (zone: FuelZone | null): Record<FuelDailyLocale, string> => {
        const out: Record<FuelDailyLocale, string> = { it: '', en: '', de: '', fr: '' };
        for (const alt of FUEL_DAILY_LOCALES) {
          out[alt] = zone ? buildFuelTodayPath(alt, fuel, zone) : buildFuelTodayPath(alt, fuel);
        }
        return out;
      };

      // Regional page
      const regionalPath = buildFuelTodayPath(locale, fuel);
      pages[regionalPath] = renderPage({
        locale,
        fuel,
        zone: null,
        dataset,
        history,
        canonicalPath: regionalPath,
        today,
        alternates: buildAlternates(null),
        distDir,
        rootDir,
      });

      // Per-zone pages
      for (const zone of FUEL_ZONES) {
        const zonePath = buildFuelTodayPath(locale, fuel, zone);
        pages[zonePath] = renderPage({
          locale,
          fuel,
          zone,
          dataset,
          history,
          canonicalPath: zonePath,
          today,
          alternates: buildAlternates(zone),
          distDir,
          rootDir,
        });
      }
    }
  }

  return pages;
}

/**
 * Enumerate archive pages from available history snapshots.
 * Only past months are emitted — the current month remains served by the
 * /oggi / /today pages.
 */
export function generateFuelArchivePages(opts: {
  history: HistorySnapshot[];
  today?: Date;
  distDir?: string;
}): Record<string, string> {
  const history = opts.history;
  const today = opts.today ?? new Date();
  const distDir = opts.distDir;
  const currentMonth = today.toISOString().slice(0, 7);

  const pages: Record<string, string> = {};
  const monthsInHistory = new Set<string>();
  for (const snap of history) {
    if (typeof snap.date === 'string' && snap.date.length >= 7) {
      monthsInHistory.add(snap.date.slice(0, 7));
    }
  }

  for (const monthKey of monthsInHistory) {
    if (monthKey >= currentMonth) continue; // skip current/future months
    for (const locale of FUEL_DAILY_LOCALES) {
      for (const fuel of FUEL_TYPES) {
        for (const zone of FUEL_ZONES) {
          const path = buildFuelArchivePath(locale, fuel, zone, monthKey);
          pages[path] = renderArchive({
            locale,
            fuel,
            zone,
            monthKey,
            snapshots: history,
            canonicalPath: path,
            today,
            distDir,
          });
        }
      }
    }
  }
  return pages;
}

export function fuelDailyPagesPlugin(rootDir: string): Plugin {
  return {
    name: 'fuel-daily-pages',
    apply: 'build',
    async closeBundle() {
      if (process.env.SKIP_FUEL_DAILY === '1') {
        console.log('\x1b[33m[fuel-daily-pages]\x1b[0m Skipped (SKIP_FUEL_DAILY=1)');
        return;
      }
      const distDir = np.resolve(rootDir, 'dist');
      const dataPath = np.resolve(rootDir, 'data', 'fuel-prices.json');

      // Ext3 task 3 — wipe owned namespaces before regen so stations/cities
      // that drop out of today's dataset don't leave stale index.html files.
      cleanNamespaces(distDir, [
        'prezzi-diesel', 'prezzi-benzina',
        'en/diesel-price-switzerland', 'en/gasoline-price-switzerland',
        'de/dieselpreis-schweiz', 'de/benzinpreis-schweiz',
        'fr/prix-gasoil-suisse', 'fr/prix-essence-suisse',
      ]);
      cleanSitemapFiles(distDir, [
        'sitemap-fuel-daily.xml',
        'sitemap-fuel-stations.xml',
        'sitemap-fuel-italian-cities.xml',
        'sitemap-fuel-italian-stations.xml',
      ]);

      // Read fuel-prices.json — soft-fail to keep the build green on worktrees
      // where the data file is absent.
      let dataset: FuelPricesDataset = {};
      try {
        if (fs.existsSync(dataPath)) {
          dataset = JSON.parse(fs.readFileSync(dataPath, 'utf-8')) as FuelPricesDataset;
        }
      } catch (err) {
        console.warn('[fuel-daily-pages] failed to read data/fuel-prices.json', err);
      }

      const history = readHistory(rootDir);
      const today = new Date();

      const pages = generateFuelDailyPages({ rootDir, dataset, history, today, distDir });
      const archives = generateFuelArchivePages({ history, today, distDir });
      const stationPages = generateFuelStationPages({ dataset, today, distDir });
      const italianCityPages = generateFuelItalianCityPages({ dataset, history, today, distDir });
      const italianStationPages = generateFuelItalianStationPages({ dataset, history, today, distDir });

      const collector = new WriteCollector({ distDir });

      let pagesWritten = 0;
      let skipped = 0;
      const sitemapPaths: string[] = [];
      for (const [path, html] of Object.entries(pages)) {
        const words = countHtmlBodyWords(html);
        if (words < MIN_INDEXABLE_WORDS) {
          skipped++;
          console.warn(`[fuel-daily-pages] thin content (${words} words) for ${path} — skipping`);
          continue;
        }
        const outDir = np.join(distDir, path.replace(/^\/+/, ''));
        collector.add(np.join(outDir, 'index.html'), html);
        sitemapPaths.push(path);
        pagesWritten++;
      }

      let archivesWritten = 0;
      for (const [path, html] of Object.entries(archives)) {
        const words = countHtmlBodyWords(html);
        if (words < MIN_INDEXABLE_WORDS) {
          skipped++;
          continue;
        }
        const outDir = np.join(distDir, path.replace(/^\/+/, ''));
        collector.add(np.join(outDir, 'index.html'), html);
        sitemapPaths.push(path);
        archivesWritten++;
      }

      // ── D-2A: Per-station + Italian-city emission ───────────────
      // Separate sitemap files so they can be refreshed independently and
      // the master index (sitemapAliasPlugin) picks them up automatically.
      const STATION_MIN_WORDS = 250;
      const stationSitemapPaths: string[] = [];
      let stationPagesWritten = 0;
      for (const [path, html] of Object.entries(stationPages)) {
        const words = countHtmlBodyWords(html);
        if (words < STATION_MIN_WORDS) {
          skipped++;
          console.warn(`[fuel-daily-pages] station thin content (${words} words) for ${path} — skipping`);
          continue;
        }
        const outDir = np.join(distDir, path.replace(/^\/+/, ''));
        collector.add(np.join(outDir, 'index.html'), html);
        stationSitemapPaths.push(path);
        stationPagesWritten++;
      }

      const italianCitySitemapPaths: string[] = [];
      let italianCityPagesWritten = 0;
      for (const [path, html] of Object.entries(italianCityPages)) {
        const words = countHtmlBodyWords(html);
        if (words < STATION_MIN_WORDS) {
          skipped++;
          console.warn(`[fuel-daily-pages] IT-city thin content (${words} words) for ${path} — skipping`);
          continue;
        }
        const outDir = np.join(distDir, path.replace(/^\/+/, ''));
        collector.add(np.join(outDir, 'index.html'), html);
        italianCitySitemapPaths.push(path);
        italianCityPagesWritten++;
      }

      const italianStationSitemapPaths: string[] = [];
      let italianStationPagesWritten = 0;
      for (const [path, html] of Object.entries(italianStationPages)) {
        const words = countHtmlBodyWords(html);
        if (words < STATION_MIN_WORDS) {
          skipped++;
          console.warn(`[fuel-daily-pages] IT-station thin content (${words} words) for ${path} — skipping`);
          continue;
        }
        const outDir = np.join(distDir, path.replace(/^\/+/, ''));
        collector.add(np.join(outDir, 'index.html'), html);
        italianStationSitemapPaths.push(path);
        italianStationPagesWritten++;
      }

      await collector.flush();

      // ── Emit sitemap-fuel-daily.xml ─────────────────────────────
      // The sitemapAliasPlugin auto-discovers every `sitemap-*.xml` in dist/
      // and weaves it into the master sitemap index, so no manual patching
      // of `dist/sitemap.xml` is needed here.
      const writeSitemap = (paths: string[], filename: string, changefreq: string): void => {
        if (paths.length === 0) return;
        try {
          const dateStamp = today.toISOString().slice(0, 10);
          const urlEntries = paths
            .map((p) => {
              return `  <url>\n    <loc>${BASE_URL}${p}</loc>\n    <lastmod>${dateStamp}</lastmod>\n    <changefreq>${changefreq}</changefreq>\n    <priority>0.6</priority>\n  </url>`;
            })
            .join('\n');
          const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urlEntries}
</urlset>
`;
          fs.writeFileSync(np.join(distDir, filename), sitemapXml, 'utf-8');
          console.log(
            `\x1b[36m[fuel-daily-pages]\x1b[0m Wrote ${filename} (${paths.length} URLs)`,
          );
        } catch (err) {
          console.warn(`[fuel-daily-pages] failed to write ${filename}`, err);
        }
      };

      writeSitemap(sitemapPaths, 'sitemap-fuel-daily.xml', 'daily');
      writeSitemap(stationSitemapPaths, 'sitemap-fuel-stations.xml', 'daily');
      writeSitemap(italianCitySitemapPaths, 'sitemap-fuel-italian-cities.xml', 'daily');
      writeSitemap(italianStationSitemapPaths, 'sitemap-fuel-italian-stations.xml', 'daily');

      const result: PluginResult = {
        pagesWritten,
        archivesWritten,
        skippedForWordCount: skipped,
        stationPagesWritten,
        italianCityPagesWritten,
        italianStationPagesWritten,
      };
      console.log(
        `\x1b[36m[fuel-daily-pages]\x1b[0m Generated ${result.pagesWritten} daily + ${result.archivesWritten} archives + ${stationPagesWritten} CH-station + ${italianCityPagesWritten} IT-city + ${italianStationPagesWritten} IT-station pages (skipped ${result.skippedForWordCount})`,
      );
    },
  };
}

/**
 * Exported for duplicate-body tests. The signature paragraph is the key
 * per-entity differentiator for stations that share (brand, city, zone,
 * fuel) — it references the street, slug, coordinates, last-update date and
 * ranking slot, all of which are always per-station.
 */
export { buildStationSignaturePargaraph };
export type { StationSignatureInput };
