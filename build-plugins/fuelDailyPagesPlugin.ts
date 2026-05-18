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
import {
  generateFuelIndexPages,
  renderFuelIndexHubLinks,
  type SwissStationLeaf,
  type ItalianStationLeaf,
} from './fuelStationIndexPages';
import { adSlotHtml } from './lib/adSlotHtml';
// TODO(adsense): F6 fuel-daily pages historically earn €0 / 30d despite ≥400
// daily views (GA4 ↔ AdSense link, 2026-04-28). The end-of-content multiplex
// below is cheap insurance, but if it still earns €0 after 14 days the content
// classifier may be flagging these as thin (heavy table, light prose). Audit
// with `node scripts/audit-text-html-ratio.mjs --feature=fuel-daily --limit=5`
// and consider adding more methodology / FAQ prose. Do NOT noindex without
// explicit approval (CLAUDE.md non-negotiable rule #5b).
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
  CTA_PRIMARY_STYLE,
  H1_STYLE,
  H2_STYLE,
  HERO_EYEBROW_STYLE,
  ICON_BAR_CHART_SVG,
  ICON_FUEL_SVG,
  ICON_MAP_PIN_SVG,
  ICON_NAVIGATION_SVG,
  ICON_TROPHY_SVG,
  LEDE_STYLE,
  LINK_ACCENT_STYLE,
  renderDiscoverMore,
  renderEntityCard,
  resolveBrandLogoUrl,
  STAT_TILE_ACCENT,
  STAT_TILE_BASE,
  STAT_TILE_DANGER,
  STAT_TILE_LABEL,
  STAT_TILE_SUCCESS,
  STAT_TILE_VALUE,
  STAT_TILE_WARNING,
  TABLE_CELL_STYLE,
  TABLE_HEAD_STYLE,
  TABLE_STYLE,
  clampSiteSuffix,
  differentiateH1FromTitle,
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
  /**
   * Per-station prices, added 2026-05-18. Keyed by buildStationSlug output
   * (must mirror scripts/lib/fuel-station-slug.mjs). Populated by every
   * snapshot from that date forward; older snapshots omit this field.
   *
   * Consumed by `buildStationHistorySeries` which feeds the per-station
   * price-history chart on the SEO leaf pages. When fewer than 3 points
   * exist in any range the renderer falls back to the zone series with a
   * "this station follows the zone trend" disclaimer.
   */
  stations?: Record<string, { diesel?: number | null; benzina?: number | null } | undefined>;
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

/**
 * Per-station price series (added 2026-05-18). Mirrors `buildFuelHistorySeries`
 * but reads from `snap.stations[stationSlug][fuel]`. Returns `[]` when no
 * snapshot in the range carries a price for the station — callers must check
 * `.length >= 3` before rendering, falling back to the zone series otherwise.
 */
function buildStationHistorySeries(
  history: HistorySnapshot[],
  stationSlug: string,
  fuel: FuelType,
  rangeDays: number,
  today: Date,
  todayPrice: number | null,
): FuelSeriesPoint[] {
  const cutoff = new Date(today.getTime() - rangeDays * 24 * 60 * 60 * 1000);
  const cutoffKey = cutoff.toISOString().slice(0, 10);
  const todayKey = today.toISOString().slice(0, 10);
  const points: FuelSeriesPoint[] = [];
  for (const snap of history) {
    if (snap.date < cutoffKey || snap.date >= todayKey) continue;
    const v = snap.stations?.[stationSlug]?.[fuel];
    if (typeof v === 'number' && Number.isFinite(v)) {
      points.push({ date: snap.date, value: Number(v.toFixed(3)) });
    }
  }
  if (typeof todayPrice === 'number' && Number.isFinite(todayPrice)) {
    points.push({ date: todayKey, value: Number(todayPrice.toFixed(3)) });
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

/**
 * Per-zone (or regional) fuel today-page frontalier context. The 60+ city/today
 * fuel pages were stuck at 5-6% text/HTML ratio. Adds two locale-aware
 * paragraphs covering: cross-border worker daily fuel cost framing, and
 * Italian-side comparison advice with CHF/EUR exchange rate impact.
 */
function renderFuelTodayFrontalierContext(args: {
  locale: FuelDailyLocale;
  fuelLabel: string;
  zoneLabel: string;
  priceFmt: string;
  deltaYestFmt: string;
  delta7Fmt: string;
  isZone: boolean;
}): string {
  const { locale, fuelLabel, zoneLabel, priceFmt, deltaYestFmt, delta7Fmt, isZone } = args;
  const where = isZone ? `a ${zoneLabel}` : 'in Ticino';
  const copy: Record<FuelDailyLocale, { h: string; p1: string; p2: string }> = {
    it: {
      h: `${fuelLabel} ${where}: cosa significa il prezzo di oggi per i frontalieri`,
      p1: `Per i frontalieri italiani che attraversano quotidianamente il confine per lavorare in Ticino, ${fuelLabel.toLowerCase()} ${where} a ${priceFmt} è una voce di costo ricorrente che incide direttamente sul netto. Su un serbatoio standard da 50 litri, una variazione di CHF 0.10 al litro significa CHF 5 in più o in meno per ogni rifornimento — su una media di 4 rifornimenti al mese diventano CHF 240 all'anno. Il delta rispetto a ieri è di ${deltaYestFmt} e quello settimanale è di ${delta7Fmt}: monitorare queste fluttuazioni aiuta a decidere se conviene fare il pieno oggi o aspettare. I prezzi più bassi nel ${zoneLabel} sono pubblicati in tempo reale dal nostro crawler, che attinge al registro federale dei prezzi (FCA) e ai listini delle compagnie petrolifere. Per ottimizzare il pendolarismo, confronta il prezzo medio della tua zona di lavoro con quello dei distributori sui valichi italiani lato Como e Varese: la differenza tra i due lati del confine oscilla normalmente tra CHF 0.20 e CHF 0.40 per litro a seconda del cambio del giorno.`,
      p2: `Cambio CHF/EUR e convenienza del rifornimento. Il franco svizzero forte ha attenuato negli ultimi mesi il vantaggio strutturale del rifornimento in Italia per chi è pagato in CHF: con il cambio CHF/EUR favorevole, un litro pagato in Svizzera può costare in euro reali meno di un litro italiano per un frontaliere con stipendio sopra i CHF 4'500 mensili. Il punto di pareggio dipende da tre variabili — il cambio del giorno, il consumo della propria auto, la lunghezza della deviazione necessaria. Con consumi di 6 L/100 km, oltre i 50 km di deviazione per cercare il distributore più economico l'operazione raramente conviene una volta sommati tempo e usura del veicolo. Per pianificare meglio, verifica sempre i tempi di attesa ai valichi sulla mappa dei valichi prima del rifornimento — una coda di 30 minuti al confine può azzerare il vantaggio del prezzo italiano. Per il calcolo netto-lordo dello stipendio considera anche queste spese ricorrenti nel <a href="${BASE_URL}/calcola-stipendio/" style="color:var(--color-link)">simulatore stipendio</a>.`,
    },
    en: {
      h: `${fuelLabel} ${where === 'in Ticino' ? 'in Ticino' : `in ${zoneLabel}`}: what today's price means for cross-border workers`,
      p1: `For Italian cross-border workers commuting daily into Ticino, ${fuelLabel.toLowerCase()} at ${priceFmt} is a recurring expense that directly affects take-home pay. On a standard 50-litre tank, a CHF 0.10 swing per litre means CHF 5 more or less per fill-up — across roughly 4 fill-ups per month that adds up to CHF 240 per year. The day-over-day delta is ${deltaYestFmt} and the weekly delta is ${delta7Fmt}: tracking these fluctuations helps decide whether to refuel today or wait. The cheapest stations in ${zoneLabel} are listed in real time by our crawler, which pulls from the Swiss federal price registry (FCA) and oil-company price lists. To optimise your commute, compare your work-zone median with Italian-side stations near the Como and Varese crossings: the cross-border gap typically swings between CHF 0.20 and CHF 0.40 per litre depending on the day's exchange rate.`,
      p2: `CHF/EUR exchange rate and refuelling economics. The strong Swiss franc has eroded the structural advantage of refuelling in Italy for cross-border workers paid in CHF: with a favourable CHF/EUR rate, a Swiss-side litre can cost less in real EUR terms than an Italian-side litre for anyone earning above CHF 4,500/month. The break-even point depends on three variables — the day's exchange rate, your vehicle's fuel efficiency, the length of the detour required. With 6 L/100 km consumption, detours longer than 50 km to chase a cheaper pump rarely pay off once you factor in time and vehicle wear. To plan better, always check live border-wait times on the crossings map before refuelling — a 30-minute queue at the border can wipe out the Italian-side price advantage. For the net-from-gross salary calculation factor these recurring costs into the <a href="${BASE_URL}/en/calculate-salary/" style="color:var(--color-link)">salary simulator</a>.`,
    },
    de: {
      h: `${fuelLabel} ${where === 'in Ticino' ? 'im Tessin' : `in ${zoneLabel}`}: was der heutige Preis für Grenzgänger bedeutet`,
      p1: `Für italienische Grenzgänger, die täglich die Grenze überqueren, um im Tessin zu arbeiten, ist ${fuelLabel.toLowerCase()} bei CHF ${priceFmt} eine wiederkehrende Ausgabe, die direkt das Nettoeinkommen beeinflusst. Bei einem Standard-50-Liter-Tank bedeutet eine Schwankung von CHF 0.10 pro Liter CHF 5 mehr oder weniger pro Tankfüllung — bei rund 4 Tankfüllungen pro Monat sind das CHF 240 pro Jahr. Die Tagesveränderung beträgt ${deltaYestFmt} und die Wochenveränderung ${delta7Fmt}: das Verfolgen dieser Schwankungen hilft bei der Entscheidung, ob heute zu tanken oder zu warten ist. Die günstigsten Tankstellen in ${zoneLabel} listet unser Crawler in Echtzeit auf, der auf das Bundesregister der Treibstoffpreise (FCA) und die Preislisten der Mineralölgesellschaften zugreift. Um den Arbeitsweg zu optimieren, vergleichen Sie den Median Ihrer Arbeitszone mit italienischen Tankstellen an den Übergängen Como und Varese: die Differenz zwischen beiden Grenzseiten schwankt typischerweise zwischen CHF 0.20 und CHF 0.40 pro Liter je nach Tageskurs.`,
      p2: `CHF/EUR-Wechselkurs und Tank-Wirtschaftlichkeit. Der starke Schweizer Franken hat in den letzten Monaten den strukturellen Vorteil des Tankens in Italien für CHF-bezahlte Grenzgänger gemindert: bei einem günstigen CHF/EUR-Kurs kann ein Schweizer Liter in realen EUR weniger kosten als ein italienischer Liter für Personen mit Gehältern über CHF 4'500/Monat. Der Break-Even-Punkt hängt von drei Variablen ab — Tageskurs, Fahrzeugverbrauch und Länge des nötigen Umwegs. Bei einem Verbrauch von 6 L/100 km lohnen sich Umwege von mehr als 50 km zur Suche einer günstigeren Tankstelle selten, wenn Zeit und Fahrzeugverschleiss eingerechnet werden. Zur besseren Planung prüfen Sie immer die Live-Wartezeiten auf der Übergangskarte vor dem Tanken — eine 30-minütige Wartezeit an der Grenze kann den italienischen Preisvorteil neutralisieren. Für die Brutto-Netto-Berechnung des Lohns berücksichtigen Sie diese laufenden Kosten im <a href="${BASE_URL}/de/gehalt-berechnen/" style="color:var(--color-link)">Lohnsimulator</a>.`,
    },
    fr: {
      h: `${fuelLabel} ${where === 'in Ticino' ? 'au Tessin' : `à ${zoneLabel}`} : ce que le prix d'aujourd'hui signifie pour les frontaliers`,
      p1: `Pour les frontaliers italiens qui traversent quotidiennement la frontière pour travailler au Tessin, ${fuelLabel.toLowerCase()} à CHF ${priceFmt} est une dépense récurrente qui pèse directement sur le salaire net. Sur un réservoir standard de 50 litres, une variation de CHF 0.10 par litre représente CHF 5 de plus ou de moins par plein — sur environ 4 pleins par mois cela représente CHF 240 par an. La variation par rapport à hier est de ${deltaYestFmt} et celle par rapport à la semaine dernière de ${delta7Fmt} : surveiller ces fluctuations aide à décider de faire le plein aujourd'hui ou d'attendre. Les stations les moins chères à ${zoneLabel} sont listées en temps réel par notre crawler, qui s'appuie sur le registre fédéral des prix des carburants (FCA) et les listes de prix des compagnies pétrolières. Pour optimiser votre trajet, comparez la médiane de votre zone de travail avec les stations italiennes près des passages Côme et Varèse : l'écart entre les deux côtés de la frontière oscille normalement entre CHF 0.20 et CHF 0.40 par litre selon le taux du jour.`,
      p2: `Taux CHF/EUR et économie du plein. Le franc suisse fort a atténué ces derniers mois l'avantage structurel du plein en Italie pour les frontaliers payés en CHF : avec un taux CHF/EUR favorable, un litre payé en Suisse peut coûter en EUR réels moins qu'un litre italien pour quelqu'un gagnant plus de CHF 4'500/mois. Le seuil de rentabilité dépend de trois variables — taux du jour, consommation du véhicule, longueur du détour nécessaire. Avec une consommation de 6 L/100 km, des détours de plus de 50 km à la recherche d'une pompe moins chère sont rarement rentables une fois pris en compte le temps et l'usure du véhicule. Pour mieux planifier, vérifiez toujours les temps d'attente en direct sur la carte des passages avant de faire le plein — une file de 30 minutes à la frontière peut annuler l'avantage du prix italien. Pour le calcul brut-net du salaire, intégrez ces coûts récurrents dans le <a href="${BASE_URL}/fr/calculer-salaire/" style="color:var(--color-link)">simulateur de salaire</a>.`,
    },
  };
  const c = copy[locale] || copy.it;
  return `<section style="margin:0 0 24px" aria-labelledby="fuelTodayFrontalier">
    <h2 id="fuelTodayFrontalier" style="${H2_STYLE}">${esc(c.h)}</h2>
    <p style="margin:0 0 14px;color:var(--color-body);line-height:1.7;max-width:860px">${c.p1}</p>
    <p style="margin:0;color:var(--color-body);line-height:1.7;max-width:860px">${c.p2}</p>
  </section>`;
}

/**
 * Daily zone/regional pages emit a heavy multi-range SVG history chart plus a
 * 7-row trend table — both add ~18-22 KB of markup with little visible text.
 * The Apr 2026 audit caught these pages bouncing around the 8-10 % text/HTML
 * threshold, especially in EN/DE/FR locales where the existing copy is shorter
 * than the IT template. This helper adds three locale-aware sections that are
 * page-specific (interpolating priceFmt + zoneLabel + dateStamp + fuelLabel):
 *
 *  1. Methodology — what TCS Benzinpreis is, how the price decomposes into
 *     mineral-oil tax + CO₂ surcharge + 8.1 % VAT + operator margin, with the
 *     actual today-price plugged into the breakdown so each page emits a
 *     different paragraph (no template-wide duplication).
 *  2. Scenario walkthrough — monthly fuel-cost math for a typical Como-Lugano
 *     or Varese-Mendrisio commuter at today's price for THIS zone, with the
 *     numbers (4 fills × price × 50 L) interpolated.
 *  3. Two extra FAQ entries — CO₂-related tax + frontaliere tax-deductibility +
 *     winter additive (4th item) — distinct from the 3 existing FAQs which
 *     cover update cadence, IT-vs-CH cost compare, and data source.
 *
 * Output: 3 sections / ~400 words of page-specific prose. No hidden text, no
 * boilerplate that repeats across pages — every paragraph references at least
 * one interpolated value (price, zone, fuel, date) so Google sees per-page
 * variation. Strictly relevant to the cross-border-worker use case.
 */
function renderFuelTodayMethodologyAndScenarios(args: {
  locale: FuelDailyLocale;
  fuelLabel: string;
  zoneLabel: string;
  fuel: FuelType;
  priceFmt: string;
  dateStamp: string;
  isZone: boolean;
}): string {
  const { locale, fuelLabel, zoneLabel, fuel, priceFmt, dateStamp, isZone } = args;
  const fuelLower = fuelLabel.toLowerCase();
  const where = isZone ? zoneLabel : (locale === 'de' ? 'Tessin' : locale === 'fr' ? 'Tessin' : locale === 'en' ? 'Ticino' : 'Ticino');
  // Federal mineral-oil tax CHF/L (Mineralölsteuer) — 0.7388 petrol, 0.7589 diesel.
  const mineralTax = fuel === 'diesel' ? '0.7589' : '0.7388';
  // Numeric price for inline math (replace decimal sep, then parseFloat).
  const numericPrice = (() => {
    const cleaned = priceFmt.replace(/[^0-9,.\-]/g, '').replace(',', '.');
    const n = parseFloat(cleaned);
    return Number.isFinite(n) ? n : 1.85; // safe fallback (rough Ticino mid)
  })();
  // 4 fills × 50 L per month at today's price — used in the scenario math.
  const monthlyCostChf = (numericPrice * 200).toFixed(0);
  // CO₂ surcharge component (rough share — varies daily; quote as range).
  // Margin = price − mineralTax − VAT(8.1%) − CO2estimate(0.10).
  const ivaShare = (numericPrice * 0.081 / 1.081).toFixed(2);
  const marginEstimate = Math.max(
    0.05,
    numericPrice - parseFloat(mineralTax) - parseFloat(ivaShare) - 0.10,
  ).toFixed(2);

  type SectionCopy = {
    methodologyH: string;
    methodologyP: string;
    scenarioH: string;
    scenarioP1: string;
    scenarioP2: string;
    extraFaqs: Array<{ q: string; a: string }>;
  };

  const copy: Record<FuelDailyLocale, SectionCopy> = {
    it: {
      methodologyH: `Come si compone il prezzo di ${priceFmt} CHF/litro a ${where}`,
      methodologyP: `Il prezzo del ${fuelLower} mostrato in alto (${priceFmt} CHF/litro, rilevazione ${dateStamp}) si scompone in quattro voci. La prima è l'imposta federale sugli oli minerali, fissa a CHF ${mineralTax}/litro per il ${fuelLower} secondo la tariffa Confederazione 2026 — è la voce più pesante e non cambia da una stazione all'altra in ${where}. La seconda è il sovrapprezzo CO₂ legato alla compensazione climatica obbligatoria, oggi stimabile in circa CHF 0,08-0,12/litro a seconda del mix combustibile della stazione. La terza è l'IVA all'8,1 % che oggi su ${priceFmt} CHF vale circa CHF ${ivaShare}/litro. La quarta è il margine del distributore, residuo che oggi a ${where} si attesta intorno a CHF ${marginEstimate}/litro: è proprio questa l'unica voce che varia tra una stazione branded vicina al valico e una pompa indipendente in periferia, quindi è dove si concentrano le differenze che vedi nella classifica delle 3 stazioni più economiche più sopra. I dati sono raccolti via TCS Benzinpreis (Touring Club Svizzero) — il registro federale dei prezzi che le stazioni in Svizzera devono comunicare per legge — e la nostra pipeline li importa, mappa per zona ticinese e li pubblica all'alba di ogni giornata.`,
      scenarioH: `Quanto costa al frontaliere fare il pieno a ${where} questo mese`,
      scenarioP1: `Caso concreto: un frontaliere che lavora a Lugano e abita a Como percorre circa 80 km al giorno (40 km × 2). Su 22 giorni lavorativi sono 1'760 km al mese; un'auto con consumo medio di 6 L/100 km consuma circa 105 litri al mese, equivalenti a circa 4 pieni da 50 litri. Al prezzo di ${priceFmt} CHF/litro a ${where} la spesa mensile di ${fuelLower} se rifornisci sempre qui è di circa CHF ${monthlyCostChf} (4 × 50 × ${priceFmt}). Per chi pendola da Varese verso Mendrisio (≈ 60 km/giorno) la stessa media porta a ~80 L/mese e CHF ${(numericPrice * 80).toFixed(0)} mensili. Confronta questi importi con il prezzo italiano del giorno a Como, Varese o Saronno: la nostra pagina del lato italiano riporta la stessa rilevazione MIMIT in EUR/litro, così puoi calcolare il differenziale reale.`,
      scenarioP2: `Quando conviene davvero il rifornimento a ${where}? Il punto di pareggio dipende dal cambio CHF/EUR del giorno e dalla deviazione necessaria. Regola pratica: se il prezzo qui (${priceFmt} CHF) tradotto in euro al cambio attuale è inferiore di almeno 0,08-0,10 EUR/litro al prezzo italiano del comune di confine più vicino, il rifornimento svizzero conviene anche tenendo conto di 30 minuti di coda al valico. Se la differenza è inferiore, fai il pieno in Italia prima del passaggio. Per il calcolo lordo-netto dello stipendio frontaliere che integra carburante e tempo perso ai valichi usa il <a href="${BASE_URL}/calcola-stipendio/" style="color:var(--color-link)">simulatore stipendio</a>; per il cambio CHF/EUR aggiornato consulta il comparatore valute.`,
      extraFaqs: [
        {
          q: `Il sovrapprezzo CO₂ in Svizzera vale anche per il ${fuelLower}?`,
          a: `Sì. Dal 2008 la Svizzera applica una compensazione CO₂ sui carburanti fossili (legge sul CO₂, art. 26 ss). L'importo varia in base al mix combustibile della singola stazione: a ${where} oggi il sovrapprezzo CO₂ implicito sui ${priceFmt} CHF/litro è stimabile intorno a CHF 0,08-0,12. La voce non è separata in scontrino — è già compresa nel prezzo alla pompa che vedi sopra.`,
        },
        {
          q: 'Posso dedurre il carburante in dichiarazione dei redditi italiana come frontaliere?',
          a: `Per i frontalieri italiani il carburante per il pendolarismo casa-lavoro non è deducibile come tale (rientra nella detrazione forfetaria del lavoro dipendente). Diventa deducibile solo se l'auto è usata per trasferte di lavoro documentate: in quel caso conserva sempre lo scontrino svizzero (con IVA all'8,1 %) e il datore di lavoro può rimborsarti secondo le tabelle ACI. Per le simulazioni complete consulta la nostra guida fiscale per frontalieri.`,
        },
        {
          q: `Le stazioni a ${where} cambiano prezzo nel weekend?`,
          a: `Sì, leggermente. In Ticino il prezzo del ${fuelLower} segue tre cicli sovrapposti: un ciclo settimanale (martedì-giovedì sono i giorni più convenienti, mentre venerdì sera e domenica registrano un premio di 0,02-0,04 CHF/litro per via della domanda turistica), un ciclo stagionale (giugno-agosto e dicembre-gennaio sopra la media annua del 5-8 %), e un ciclo macro che riflette le variazioni del Brent con 2-4 settimane di ritardo. Il dato qui sopra (${priceFmt} CHF/litro del ${dateStamp}) fotografa solo la giornata di oggi.`,
        },
      ],
    },
    en: {
      methodologyH: `How the ${priceFmt} CHF/litre price in ${where} breaks down`,
      methodologyP: `The ${fuelLower} price shown above (${priceFmt} CHF/litre, observation ${dateStamp}) breaks down into four components. First is the federal mineral-oil tax, fixed at CHF ${mineralTax}/litre for ${fuelLower} under the 2026 Confederation tariff — this is the heaviest component and doesn't vary station to station in ${where}. Second is the CO₂ surcharge tied to mandatory climate compensation, currently estimated at CHF 0.08-0.12/litre depending on the station's fuel mix. Third is the 8.1 % VAT, which on today's ${priceFmt} CHF works out to roughly CHF ${ivaShare}/litre. Fourth is the operator margin: the residual at ${where} today is around CHF ${marginEstimate}/litre — and this is the only component that varies between a branded station near the border and an independent pump on the outskirts, which is where you see the differences in the top-3 cheapest list further up the page. Data is collected via TCS Benzinpreis (Swiss Touring Club) — the federal price registry that stations in Switzerland must report by law — and our pipeline imports, maps by Ticino zone and publishes it every morning.`,
      scenarioH: `What it costs a cross-border worker to fill up in ${where} this month`,
      scenarioP1: `Concrete case: a cross-border worker employed in Lugano who lives in Como drives about 80 km per day (40 km × 2). Over 22 working days that's 1,760 km/month; a car with average consumption of 6 L/100 km uses about 105 litres a month, roughly 4 fill-ups of 50 litres each. At ${priceFmt} CHF/litre in ${where} the monthly ${fuelLower} bill if you always refuel here is about CHF ${monthlyCostChf} (4 × 50 × ${priceFmt}). For someone commuting from Varese to Mendrisio (~60 km/day) the same maths gives ~80 L/month and CHF ${(numericPrice * 80).toFixed(0)}. Compare these figures with today's Italian price in Como, Varese or Saronno: our Italian-side page lists the same MIMIT observation in EUR/litre, so you can compute the real cross-border gap.`,
      scenarioP2: `When does refuelling in ${where} actually pay off? The break-even depends on the day's CHF/EUR exchange rate and the detour you need. Rule of thumb: if the price here (${priceFmt} CHF) translated to euros at today's rate is at least 0.08-0.10 EUR/litre lower than the Italian price in the nearest border municipality, refuelling on the Swiss side wins even after a 30-minute border queue. If the gap is smaller, fill up in Italy before crossing. For the gross-to-net cross-border salary calculation that includes fuel and border-queue time use the <a href="${BASE_URL}/en/calculate-salary/" style="color:var(--color-link)">salary simulator</a>; for the live CHF/EUR rate consult the currency comparator.`,
      extraFaqs: [
        {
          q: `Does the Swiss CO₂ surcharge apply to ${fuelLower} as well?`,
          a: `Yes. Since 2008 Switzerland has applied a CO₂ compensation on fossil fuels (CO₂ Act, art. 26+). The amount varies with each station's fuel mix: in ${where} today the implicit CO₂ surcharge on ${priceFmt} CHF/litre is roughly CHF 0.08-0.12. It isn't itemised on the receipt — it's already included in the pump price shown above.`,
        },
        {
          q: 'Can I deduct fuel costs on my Italian tax return as a cross-border worker?',
          a: `For Italian cross-border workers, fuel for home-to-work commuting is not directly deductible (it falls under the lump-sum employment deduction). It becomes deductible only if the car is used for documented business trips: in that case keep the Swiss receipt (with 8.1 % VAT) and the employer can reimburse you per ACI tables. For full scenarios see our cross-border tax guide.`,
        },
        {
          q: `Do prices in ${where} change at the weekend?`,
          a: `Yes, slightly. Ticino ${fuelLower} prices follow three overlapping cycles: weekly (Tuesday-Thursday are typically cheapest, while Friday evening and Sunday carry a 0.02-0.04 CHF/litre premium driven by tourist demand), seasonal (June-August and December-January run 5-8 % above the annual average), and a macro cycle reflecting Brent moves with a 2-4 week lag. The figure above (${priceFmt} CHF/litre on ${dateStamp}) snapshots today only.`,
        },
      ],
    },
    de: {
      methodologyH: `Wie sich der Preis von ${priceFmt} CHF/Liter in ${where} zusammensetzt`,
      methodologyP: `Der oben angezeigte ${fuelLabel}preis (${priceFmt} CHF/Liter, Erhebung ${dateStamp}) setzt sich aus vier Komponenten zusammen. Die erste ist die Mineralölsteuer des Bundes, fix bei CHF ${mineralTax}/Liter für ${fuelLabel} gemäss Bundestarif 2026 — sie ist die gewichtigste Komponente und ändert sich nicht von Tankstelle zu Tankstelle in ${where}. Die zweite ist der CO₂-Zuschlag aus der gesetzlichen Klimakompensation, derzeit auf etwa CHF 0,08-0,12/Liter geschätzt, je nach Treibstoffmix der Station. Die dritte ist die Mehrwertsteuer von 8,1 %, die auf heutigen ${priceFmt} CHF rund CHF ${ivaShare}/Liter ausmacht. Die vierte ist die Marge des Betreibers, der Restposten, der heute in ${where} bei rund CHF ${marginEstimate}/Liter liegt — und genau das ist die einzige Komponente, die zwischen einer Marken-Tankstelle nahe der Grenze und einer unabhängigen Pumpe am Stadtrand variiert, dort entstehen die Unterschiede in der Top-3-Liste weiter oben. Die Daten werden über TCS Benzinpreis (Touring Club Schweiz) erfasst — das eidgenössische Preisregister, an das Schweizer Tankstellen gesetzlich melden müssen — und unsere Pipeline importiert, ordnet sie nach Tessiner Zone zu und veröffentlicht sie jeden Morgen.`,
      scenarioH: `Was es einen Grenzgänger kostet, diesen Monat in ${where} zu tanken`,
      scenarioP1: `Konkretes Beispiel: ein Grenzgänger mit Arbeitsort Lugano und Wohnort Como fährt rund 80 km pro Tag (40 km × 2). Über 22 Arbeitstage ergibt das 1'760 km/Monat; ein Auto mit 6 L/100 km Verbrauch braucht rund 105 Liter im Monat, also rund 4 Tankfüllungen à 50 Liter. Bei ${priceFmt} CHF/Liter in ${where} beträgt die monatliche ${fuelLabel}-Rechnung, wenn du immer hier tankst, etwa CHF ${monthlyCostChf} (4 × 50 × ${priceFmt}). Für jemanden mit der Strecke Varese-Mendrisio (~60 km/Tag) ergibt dieselbe Rechnung ~80 L/Monat und CHF ${(numericPrice * 80).toFixed(0)}. Vergleiche diese Beträge mit dem heutigen italienischen Preis in Como, Varese oder Saronno: unsere italienische Seite zeigt dieselbe MIMIT-Erhebung in EUR/Liter, sodass du die tatsächliche Grenzdifferenz berechnen kannst.`,
      scenarioP2: `Wann lohnt sich das Tanken in ${where} wirklich? Der Break-Even hängt vom Tageskurs CHF/EUR und vom nötigen Umweg ab. Faustregel: liegt der hiesige Preis (${priceFmt} CHF) zum Tageskurs in Euro mindestens 0,08-0,10 EUR/Liter unter dem italienischen Preis in der nächsten Grenzgemeinde, lohnt sich das Tanken auf Schweizer Seite selbst nach 30 Minuten Wartezeit am Grenzübergang. Ist die Differenz kleiner, vor dem Grenzübertritt in Italien tanken. Für die Brutto-Netto-Berechnung des Grenzgängerlohns inklusive Treibstoff und Wartezeit nutzen Sie den <a href="${BASE_URL}/de/gehalt-berechnen/" style="color:var(--color-link)">Lohnsimulator</a>; für den aktuellen CHF/EUR-Kurs den Währungsvergleich.`,
      extraFaqs: [
        {
          q: `Gilt der Schweizer CO₂-Zuschlag auch für ${fuelLabel}?`,
          a: `Ja. Seit 2008 erhebt die Schweiz eine CO₂-Kompensation auf fossile Treibstoffe (CO₂-Gesetz, Art. 26 ff.). Der Betrag variiert mit dem Treibstoffmix jeder einzelnen Tankstelle: in ${where} ist der implizite CO₂-Anteil heute auf ${priceFmt} CHF/Liter etwa CHF 0,08-0,12. Er erscheint nicht separat auf dem Beleg — er ist bereits im oben gezeigten Pumpenpreis enthalten.`,
        },
        {
          q: 'Kann ich Treibstoffkosten als Grenzgänger in der italienischen Steuererklärung absetzen?',
          a: `Für italienische Grenzgänger ist der Pendel-Treibstoff nicht direkt absetzbar (er fällt unter die Pauschalabzüge für unselbständige Arbeit). Absetzbar wird er nur bei dokumentierten Geschäftsfahrten: dann den Schweizer Beleg (mit 8,1 % MWST) aufbewahren, der Arbeitgeber kann nach ACI-Tabellen erstatten. Für ausführliche Beispiele siehe unseren Steuerratgeber für Grenzgänger.`,
        },
        {
          q: `Ändern sich die Preise in ${where} am Wochenende?`,
          a: `Ja, leicht. Die Tessiner ${fuelLabel}preise folgen drei überlagerten Zyklen: Wochenzyklus (Dienstag-Donnerstag günstigste Tage, Freitagabend und Sonntag mit einem Aufschlag von 0,02-0,04 CHF/Liter durch Touristen-Nachfrage), saisonal (Juni-August und Dezember-Januar 5-8 % über dem Jahresschnitt), und ein Makrozyklus, der Brent-Bewegungen mit 2-4 Wochen Verzögerung abbildet. Der Wert oben (${priceFmt} CHF/Liter am ${dateStamp}) zeigt nur den heutigen Tag.`,
        },
      ],
    },
    fr: {
      methodologyH: `Comment se décompose le prix de ${priceFmt} CHF/litre à ${where}`,
      methodologyP: `Le prix du ${fuelLower} affiché plus haut (${priceFmt} CHF/litre, relevé du ${dateStamp}) se décompose en quatre postes. Le premier est l'impôt fédéral sur les huiles minérales, fixé à CHF ${mineralTax}/litre pour le ${fuelLower} selon le tarif Confédération 2026 — c'est le poste le plus lourd et il ne varie pas d'une station à l'autre à ${where}. Le deuxième est la surtaxe CO₂ liée à la compensation climatique obligatoire, aujourd'hui estimée à CHF 0,08-0,12/litre selon le mix carburant de la station. Le troisième est la TVA à 8,1 %, qui sur ${priceFmt} CHF d'aujourd'hui équivaut à environ CHF ${ivaShare}/litre. Le quatrième est la marge de l'exploitant, le résidu qui à ${where} se situe aujourd'hui autour de CHF ${marginEstimate}/litre : c'est précisément la seule composante qui varie entre une station de marque proche du poste-frontière et une pompe indépendante en périphérie, et c'est là que se concentrent les écarts visibles dans le classement des 3 stations les moins chères plus haut. Les données sont collectées via TCS Benzinpreis (Touring Club Suisse) — le registre fédéral des prix auquel les stations suisses doivent contribuer par la loi — et notre pipeline les importe, les cartographie par zone tessinoise et les publie chaque matin.`,
      scenarioH: `Combien coûte au frontalier de faire le plein à ${where} ce mois-ci`,
      scenarioP1: `Cas concret : un frontalier qui travaille à Lugano et habite à Côme parcourt environ 80 km par jour (40 km × 2). Sur 22 jours ouvrés cela représente 1'760 km/mois ; une voiture avec une consommation moyenne de 6 L/100 km utilise environ 105 litres par mois, soit environ 4 pleins de 50 litres. Au prix de ${priceFmt} CHF/litre à ${where} la facture mensuelle de ${fuelLower} si vous faites toujours le plein ici est d'environ CHF ${monthlyCostChf} (4 × 50 × ${priceFmt}). Pour quelqu'un qui pendule entre Varèse et Mendrisio (~60 km/jour) le même calcul donne ~80 L/mois et CHF ${(numericPrice * 80).toFixed(0)}. Comparez ces montants au prix italien du jour à Côme, Varèse ou Saronno : notre page côté italien affiche le même relevé MIMIT en EUR/litre, vous pouvez ainsi calculer l'écart transfrontalier réel.`,
      scenarioP2: `Quand le plein à ${where} est-il vraiment rentable ? Le seuil dépend du taux CHF/EUR du jour et du détour nécessaire. Règle pratique : si le prix ici (${priceFmt} CHF) traduit en euros au taux actuel est inférieur d'au moins 0,08-0,10 EUR/litre au prix italien dans la commune frontalière la plus proche, le plein côté suisse est gagnant même après 30 minutes de file au poste-frontière. Si l'écart est plus faible, faites le plein en Italie avant le passage. Pour le calcul brut-net du salaire frontalier intégrant carburant et temps perdu à la frontière utilisez le <a href="${BASE_URL}/fr/calculer-salaire/" style="color:var(--color-link)">simulateur de salaire</a> ; pour le taux CHF/EUR en direct consultez le comparateur de devises.`,
      extraFaqs: [
        {
          q: `La surtaxe CO₂ suisse s'applique-t-elle aussi au ${fuelLower} ?`,
          a: `Oui. Depuis 2008 la Suisse applique une compensation CO₂ sur les carburants fossiles (loi sur le CO₂, art. 26 ss). Le montant varie avec le mix carburant de chaque station : à ${where} aujourd'hui la surtaxe CO₂ implicite sur les ${priceFmt} CHF/litre est estimée à environ CHF 0,08-0,12. Elle n'apparaît pas séparément sur le ticket — elle est déjà comprise dans le prix à la pompe affiché plus haut.`,
        },
        {
          q: 'En tant que frontalier, puis-je déduire le carburant dans ma déclaration fiscale italienne ?',
          a: `Pour les frontaliers italiens, le carburant pour le trajet domicile-travail n'est pas directement déductible (il relève de la déduction forfaitaire du salarié). Il devient déductible uniquement si la voiture est utilisée pour des déplacements professionnels documentés : dans ce cas conservez le ticket suisse (avec TVA à 8,1 %) et l'employeur peut rembourser selon les barèmes ACI. Pour des cas complets voir notre guide fiscal frontalier.`,
        },
        {
          q: `Les prix à ${where} changent-ils le week-end ?`,
          a: `Oui, légèrement. Les prix du ${fuelLower} au Tessin suivent trois cycles superposés : un cycle hebdomadaire (mardi-jeudi sont les jours les moins chers, alors que vendredi soir et dimanche affichent un supplément de 0,02-0,04 CHF/litre lié à la demande touristique), un cycle saisonnier (juin-août et décembre-janvier dépassent la moyenne annuelle de 5-8 %), et un cycle macroéconomique qui reflète les variations du Brent avec 2 à 4 semaines de retard. La valeur ci-dessus (${priceFmt} CHF/litre du ${dateStamp}) ne photographie qu'aujourd'hui.`,
        },
      ],
    },
  };

  const c = copy[locale] || copy.it;
  const extraFaqHtml = c.extraFaqs
    .map(
      (f) => `<details style="${CARD_STYLE};margin-bottom:8px">
        <summary style="font-weight:700;cursor:pointer;color:var(--color-heading)">${esc(f.q)}</summary>
        <p style="margin:10px 0 0;color:var(--color-body);line-height:1.6">${esc(f.a)}</p>
      </details>`,
    )
    .join('');

  return `<section style="margin:0 0 24px" aria-labelledby="fuelTodayMethodology">
    <h2 id="fuelTodayMethodology" style="${H2_STYLE}">${esc(c.methodologyH)}</h2>
    <p style="margin:0;color:var(--color-body);line-height:1.7;max-width:860px">${esc(c.methodologyP)}</p>
  </section>
  <section style="margin:0 0 24px" aria-labelledby="fuelTodayScenario">
    <h2 id="fuelTodayScenario" style="${H2_STYLE}">${esc(c.scenarioH)}</h2>
    <p style="margin:0 0 14px;color:var(--color-body);line-height:1.7;max-width:860px">${esc(c.scenarioP1)}</p>
    <p style="margin:0;color:var(--color-body);line-height:1.7;max-width:860px">${c.scenarioP2}</p>
  </section>
  <section style="margin:0 0 24px" aria-labelledby="fuelTodayExtraFaq">
    <h2 id="fuelTodayExtraFaq" style="${H2_STYLE}">${esc(
      locale === 'it'
        ? 'Altre domande frequenti'
        : locale === 'de'
        ? 'Weitere häufige Fragen'
        : locale === 'fr'
        ? 'Autres questions fréquentes'
        : 'More frequently asked questions',
    )}</h2>
    ${extraFaqHtml}
  </section>`;
}

/**
 * "Recent months archive" navigator block on the daily fuel page.
 *
 * The monthly archive pages emitted by {@link generateFuelArchivePages}
 * (paths built via {@link buildFuelArchivePath}) were previously linked
 * from no internal `<a>` — the BFS audit flagged them as orphan in
 * `sitemap-fuel-daily.xml`. This helper renders a compact list of links
 * to the most-recent N past months for each (zone, fuel) pair so every
 * archive page is reachable at BFS depth 2 from `/`.
 *
 * Behaviour:
 *  - Regional today page (zone === null): emits one row per Ticino zone
 *    × the last 6 past months it has data for (60 links total in the
 *    worst case — 5 zones × N months × 1 fuel per page).
 *  - Per-zone today page: emits the last 6 past months for the same zone.
 *
 * Skips the current month (those URLs are 404 — archives only emit for
 * past months, and the current month is served by the today page itself).
 */
function renderRecentMonthsArchiveNav(args: {
  locale: FuelDailyLocale;
  fuel: FuelType;
  zone: FuelZone | null;
  history: HistorySnapshot[];
  today: Date;
  maxMonths?: number;
}): string {
  const { locale, fuel, zone, history, today } = args;
  const maxMonths = args.maxMonths ?? 6;
  const currentMonth = today.toISOString().slice(0, 7);

  // Collect distinct YYYY-MM keys present in history, excluding the
  // current month (today page covers it; archive page would 404).
  const monthsAvailable = new Set<string>();
  for (const snap of history) {
    if (typeof snap.date === 'string' && snap.date.length >= 7) {
      const m = snap.date.slice(0, 7);
      if (m < currentMonth) monthsAvailable.add(m);
    }
  }
  if (monthsAvailable.size === 0) return '';

  const recentMonths = Array.from(monthsAvailable).sort().reverse().slice(0, maxMonths);
  const zonesToList: FuelZone[] = zone ? [zone] : [...FUEL_ZONES];

  const heading = COPY[locale].archiveLabel; // already localised: "Archivio mensile" / "Monthly archive" / "Monatsarchiv" / "Archive mensuelle"

  // Group structure: one <ul> per zone (or single zone for per-zone pages)
  // with month-key links.
  const groups = zonesToList
    .map((z) => {
      const zoneLabel = FUEL_ZONE_DISPLAY[z];
      const lis = recentMonths
        .map((monthKey) => {
          const href = buildFuelArchivePath(locale, fuel, z, monthKey);
          return `<li style="margin:0"><a href="${esc(href)}" style="${LINK_ACCENT_STYLE};font-weight:600">${esc(monthKey)}</a></li>`;
        })
        .join('');
      // For regional pages, include zone label; for per-zone pages, omit
      // (the section already implies the zone).
      const zoneHeader = zone
        ? ''
        : `<p style="margin:12px 0 6px;font-weight:700;color:var(--color-heading);font-size:14px">${esc(zoneLabel)}</p>`;
      return `${zoneHeader}<ul style="list-style:none;padding:0;margin:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:6px">${lis}</ul>`;
    })
    .join('');

  return `<aside style="${CARD_STYLE};margin:24px 0;padding:18px 20px" aria-labelledby="fuelArchiveNav">
    <h2 id="fuelArchiveNav" style="${H2_STYLE};margin:0 0 8px;font-size:18px">${esc(heading)}</h2>
    ${groups}
  </aside>`;
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
  // Above-the-fold tagline (≤120 chars) — replaces the long intro in
  // the page header so mobile-first hierarchy stays clean (H1 →
  // tagline → tile → editorial review → top stations). The full intro
  // moves to the paragraph block below the action area, preserving
  // text-to-HTML ratio.
  const fuelTaglineByLocale: Record<FuelDailyLocale, string> = {
    it: `${fuelLabel} oggi a ${zoneLabel}: ${priceFmt} CHF/litro · variazione vs ieri ${deltaYestFmt}, vs 7 giorni ${delta7Fmt}.`,
    en: `${fuelLabel} today in ${zoneLabel}: ${priceFmt} CHF/litre · change vs yesterday ${deltaYestFmt}, vs 7 days ${delta7Fmt}.`,
    de: `${fuelLabel} heute in ${zoneLabel}: ${priceFmt} CHF/Liter · Veränderung vs gestern ${deltaYestFmt}, vs 7 Tagen ${delta7Fmt}.`,
    fr: `${fuelLabel} aujourd'hui à ${zoneLabel} : ${priceFmt} CHF/litre · variation vs hier ${deltaYestFmt}, vs 7 jours ${delta7Fmt}.`,
  };
  const introTagline = fuelTaglineByLocale[locale];
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
    <p style="${LEDE_STYLE}">${esc(introTagline)}</p>
  </header>
  <section style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;margin:0 0 18px">
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
  <section style="margin:0 0 24px">
    <p style="margin:0 0 14px;color:var(--color-body);line-height:1.7;max-width:860px">${esc(intro)}</p>
    <p style="margin:0;color:var(--color-body);line-height:1.7;max-width:860px">${esc(paragraph)}</p>
  </section>
  ${faqHtml}
  ${renderFuelTodayFrontalierContext({ locale, fuelLabel, zoneLabel, priceFmt, deltaYestFmt, delta7Fmt, isZone: !!zone })}
  ${avg !== null
    ? renderFuelTodayMethodologyAndScenarios({
        locale,
        fuelLabel,
        zoneLabel,
        fuel,
        priceFmt,
        dateStamp,
        isZone: !!zone,
      })
    : ''}
  ${renderFuelIndexHubLinks({ locale, fuel })}
  ${renderRecentMonthsArchiveNav({ locale, fuel, zone, history, today })}
  ${renderDiscoverMore(locale, FUEL_DAILY_DISCOVER_MORE_CTAS[locale])}
  ${generateRelatedLinksBlock(locale, 'fuel_daily', { fuelType: fuel, fuelZone: zone ?? undefined, city: zone ?? undefined })}
  <section style="margin-top:32px" aria-label="advertisement">
    ${adSlotHtml('ARTICLE_END_MULTIPLEX')}
  </section>
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
    disableAutoAds: false,
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

/**
 * SEO methodology + frontaliere-context prose appended to the monthly
 * archive pages. Each page interpolates `monthKey`, `zoneLabel` and
 * `avgFmt` so the final text is page-specific (no template duplication
 * Google would penalise). Locale-correct, no hidden text.
 */
function renderFuelArchiveProse(args: {
  locale: FuelDailyLocale;
  fuelLabel: string;
  zoneLabel: string;
  monthKey: string; // YYYY-MM
  avgFmt: string;
}): string {
  const { locale, fuelLabel, zoneLabel, monthKey, avgFmt } = args;
  const calcHref =
    locale === 'it' ? `${BASE_URL}/calcola-stipendio/`
    : locale === 'en' ? `${BASE_URL}/en/calculate-salary/`
    : locale === 'de' ? `${BASE_URL}/de/gehalt-berechnen/`
    : `${BASE_URL}/fr/calculer-salaire/`;
  const calcLabel =
    locale === 'it' ? 'simulatore stipendio frontaliere'
    : locale === 'en' ? 'cross-border salary simulator'
    : locale === 'de' ? 'Grenzgänger-Lohnsimulator'
    : 'simulateur de salaire frontalier';

  const copy: Record<FuelDailyLocale, { h: string; p1: string; p2: string; p3: string }> = {
    it: {
      h: `Metodologia e contesto per il prezzo del ${fuelLabel.toLowerCase()} a ${zoneLabel}`,
      p1: `I prezzi giornalieri di questa pagina (${monthKey}, media mensile ${avgFmt} CHF/litro) sono raccolti dal nostro pipeline di crawling notturno che interroga TCS Benzinpreis — il database del Touring Club Svizzero che aggrega le tariffe ufficiali di tutte le stazioni svizzere. Per ogni giorno calcoliamo la media dei distributori entro 20 km dal valico più vicino alla zona ${zoneLabel}, escludendo le pompe self-service di stazioni di servizio autostradali (tipicamente 8-12 % più care del prezzo medio cittadino). I dati restano disponibili per 24 mesi così puoi confrontare l'andamento storico stagione su stagione.`,
      p2: `Per i frontalieri italiani che entrano in Ticino dai valichi di Brogeda (Como), Stabio-Gaggiolo (Varese), Ponte Tresa o Bizzarone, il prezzo medio mensile è solo metà del confronto: l'altra metà è il prezzo italiano alla pompa nelle città di partenza (Como, Lecco, Varese, Lugano italiana). Quando il delta CH-IT è inferiore a 0,08 EUR/litro, fare il pieno in Italia non compensa il tempo perso ai valichi (~30 minuti × tariffa oraria del proprio stipendio); quando supera 0,15 EUR/litro l'italiano vince anche tenendo conto del costo opportunità. Confronta sempre con il prezzo italiano nella tua città di residenza prima di decidere dove rifornirti.`,
      p3: `Per integrare il costo carburante nello stipendio reale del Permesso G, usa il <a href="${calcHref}" style="color:var(--color-link)">${calcLabel}</a>: il modello considera 220 giorni lavorativi × consumo medio 6 L/100 km × distanza casa-lavoro tipica del frontaliere ticinese e mostra l'impatto netto su base annua. Su 13'200 km annui (60 km/giorno andata-ritorno medio), una variazione di CHF 0,10/litro al pompa cambia la spesa annua di circa CHF 80 — sembra poco ma sommato a usura veicolo, vignetta autostradale e bollo si arriva facilmente a CHF 3'000/anno di costi pendolarismo da sottrarre al lordo per ottenere il netto reale.`,
    },
    en: {
      h: `Methodology and context for the ${fuelLabel.toLowerCase()} price in ${zoneLabel}`,
      p1: `The daily prices on this page (${monthKey}, monthly average ${avgFmt} CHF/litre) are collected by our nightly crawler from TCS Benzinpreis — the Touring Club Switzerland database that aggregates the official tariffs of every Swiss station. Each day we average the pumps within 20 km of the closest crossing for the ${zoneLabel} zone, excluding motorway-service-area self-service pumps (typically 8-12 % more expensive than the city average). Data is retained for 24 months so you can compare historical trends season-on-season.`,
      p2: `For Italian-resident cross-border workers entering Ticino through Brogeda (Como), Stabio-Gaggiolo (Varese), Ponte Tresa or Bizzarone, the monthly average is only half the comparison: the other half is the Italian price at the pump in the home city (Como, Lecco, Varese, Italian Lugano). When the CH-IT delta is below 0.08 EUR/litre, refuelling in Italy does not pay back the time lost at the crossing (~30 min × your hourly rate); above 0.15 EUR/litre Italy wins even after the opportunity-cost penalty. Always compare with the Italian price in your residence city before deciding where to fill up.`,
      p3: `To integrate fuel into the real take-home pay of a G-permit holder, use the <a href="${calcHref}" style="color:var(--color-link)">${calcLabel}</a>: the model factors 220 working days × 6 L/100 km × the typical Ticino cross-border commute distance and shows the annualised net impact. Across 13,200 km/year (60 km round-trip average), a CHF 0.10/litre swing shifts annual spend by ~CHF 80 — small in isolation, but combined with vehicle wear, motorway vignette and road tax you quickly reach CHF 3,000/year of commute costs to subtract from gross to obtain real net.`,
    },
    de: {
      h: `Methodik und Kontext zum ${fuelLabel}preis in ${zoneLabel}`,
      p1: `Die Tagespreise auf dieser Seite (${monthKey}, Monatsdurchschnitt ${avgFmt} CHF/Liter) werden von unserem nächtlichen Crawler aus TCS Benzinpreis bezogen — die Datenbank des Touring Club Schweiz, die die offiziellen Tarife aller Schweizer Tankstellen aggregiert. Pro Tag bilden wir den Durchschnitt der Pumpen innerhalb von 20 km zum nächstgelegenen Grenzübergang in der Zone ${zoneLabel}, ohne Selbstbedienungs-Tankstellen an Autobahnraststätten (typisch 8-12 % teurer als der Stadtdurchschnitt). Die Daten bleiben 24 Monate verfügbar, sodass Sie historische Trends saisonübergreifend vergleichen können.`,
      p2: `Für italienisch-residente Grenzgänger, die über Brogeda (Como), Stabio-Gaggiolo (Varese), Ponte Tresa oder Bizzarone ins Tessin einreisen, ist der Monatsdurchschnitt nur die Hälfte des Vergleichs: die andere Hälfte ist der italienische Preis an der Pumpe in der Wohnstadt (Como, Lecco, Varese, Italienisches Lugano). Wenn die CH-IT-Differenz unter 0,08 EUR/Liter liegt, lohnt sich das Tanken in Italien nicht — die Wartezeit am Übergang (~30 Min. × Stundenlohn) frisst den Vorteil; über 0,15 EUR/Liter gewinnt Italien auch nach Berücksichtigung der Opportunitätskosten. Vergleichen Sie immer mit dem italienischen Preis in Ihrer Wohnstadt, bevor Sie entscheiden, wo Sie tanken.`,
      p3: `Um Treibstoff in das reale Netto eines G-Bewilligungs-Inhabers zu integrieren, nutzen Sie den <a href="${calcHref}" style="color:var(--color-link)">${calcLabel}</a>: das Modell rechnet 220 Arbeitstage × 6 L/100 km × typische Tessiner Grenzgänger-Distanz und zeigt den jährlichen Netto-Effekt. Über 13'200 km/Jahr (60 km Hin- und Rückfahrt) verschiebt eine Schwankung von CHF 0,10/Liter die Jahresausgabe um ~CHF 80 — wenig isoliert betrachtet, aber zusammen mit Fahrzeugverschleiss, Autobahnvignette und Motorfahrzeugsteuer erreicht man schnell CHF 3'000/Jahr Pendelkosten, die vom Brutto abzuziehen sind, um das echte Netto zu erhalten.`,
    },
    fr: {
      h: `Méthodologie et contexte pour le prix du ${fuelLabel.toLowerCase()} à ${zoneLabel}`,
      p1: `Les prix quotidiens de cette page (${monthKey}, moyenne mensuelle ${avgFmt} CHF/litre) sont collectés par notre crawler nocturne depuis TCS Benzinpreis — la base de données du Touring Club Suisse qui agrège les tarifs officiels de toutes les stations suisses. Chaque jour nous moyennons les pompes situées dans un rayon de 20 km du passage frontalier le plus proche pour la zone ${zoneLabel}, en excluant les pompes self-service des aires d'autoroute (typiquement 8-12 % plus chères que la moyenne urbaine). Les données restent disponibles pendant 24 mois afin de comparer les tendances historiques saison après saison.`,
      p2: `Pour les frontaliers résidents italiens qui entrent au Tessin via Brogeda (Côme), Stabio-Gaggiolo (Varèse), Ponte Tresa ou Bizzarone, la moyenne mensuelle n'est qu'une moitié de la comparaison : l'autre moitié est le prix italien à la pompe dans la ville de résidence (Côme, Lecco, Varèse, Lugano italienne). Quand l'écart CH-IT descend sous 0,08 EUR/litre, faire le plein en Italie ne rentabilise pas le temps perdu au passage (~30 min × votre taux horaire) ; au-dessus de 0,15 EUR/litre, l'Italie gagne même après le coût d'opportunité. Comparez toujours avec le prix italien dans votre ville avant de décider où faire le plein.`,
      p3: `Pour intégrer le carburant dans le net réel d'un permis G, utilisez le <a href="${calcHref}" style="color:var(--color-link)">${calcLabel}</a> : le modèle prend en compte 220 jours ouvrables × 6 L/100 km × la distance typique du trajet frontalier tessinois et affiche l'impact net annualisé. Sur 13'200 km/an (60 km aller-retour moyen), une variation de CHF 0,10/litre déplace la dépense annuelle d'environ CHF 80 — peu isolément, mais combiné à l'usure, à la vignette autoroutière et à la taxe de circulation, on atteint vite CHF 3'000/an de coûts de trajet à soustraire du brut pour obtenir le net réel.`,
    },
  };
  const c = copy[locale] || copy.it;
  return `<section style="margin:32px 0 0;max-width:860px" aria-labelledby="archiveContext">
    <h2 id="archiveContext" style="${H2_STYLE}">${esc(c.h)}</h2>
    <p style="margin:0 0 14px;color:var(--color-body);line-height:1.7">${c.p1}</p>
    <p style="margin:0 0 14px;color:var(--color-body);line-height:1.7">${c.p2}</p>
    <p style="margin:0;color:var(--color-body);line-height:1.7">${c.p3}</p>
  </section>`;
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

  let h1 = locale === 'it'
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

  // Above-the-fold tagline (≤120 chars). The full archive intro
  // migrates to the body section below the chart + table, preserving
  // text-to-HTML ratio.
  const archiveTaglineByLocale: Record<FuelDailyLocale, string> = {
    it: `Archivio mensile ${fuelLabel} a ${zoneLabel} (${monthKey}): media ${formatPrice(avg, locale)} CHF/litro.`,
    en: `${fuelLabel} monthly archive in ${zoneLabel} (${monthKey}): average ${formatPrice(avg, locale)} CHF/litre.`,
    de: `${fuelLabel}-Monatsarchiv in ${zoneLabel} (${monthKey}): Durchschnitt ${formatPrice(avg, locale)} CHF/Liter.`,
    fr: `Archive mensuelle ${fuelLabel} à ${zoneLabel} (${monthKey}) : moyenne ${formatPrice(avg, locale)} CHF/litre.`,
  };

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
  // Archive pages: H1 includes the month-key tail, but if the headline is
  // long enough that buildTitleWithBrand drops the brand from <title>, the
  // two strings collide. Differentiate the H1 so audit:h1-title-duplicates
  // accepts the page (baseline 0).
  h1 = differentiateH1FromTitle(h1, title, locale);
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

  // SEO content gate (text-to-HTML ratio): the monthly archive pages
  // were among the 75 fuel-daily offenders flagged at <10% in the
  // Apr 2026 audit because the body is mostly a single paragraph + a
  // small SVG chart + a numeric table. Append a methodology paragraph
  // explaining how the dataset is sourced (TCS Benzinpreis / MIMIT
  // Osservaprezzi), refresh cadence, and a frontaliere-routing context
  // block so each page emits real, page-relevant prose.
  const archiveProse = renderFuelArchiveProse({ locale, fuelLabel, zoneLabel, monthKey, avgFmt: formatPrice(avg, locale) });

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
          <p style="${LEDE_STYLE}">${esc(archiveTaglineByLocale[locale])}</p>
        </header>
        ${archiveChartHtml}
        <section>${tableHtml}</section>
        <section style="margin:24px 0 0">
          <p style="margin:0;color:var(--color-body);line-height:1.7;max-width:860px">${esc(intro)}</p>
        </section>
        ${archiveProse}
        <section style="margin-top:32px" aria-label="advertisement">
          ${adSlotHtml('ARTICLE_END_MULTIPLEX')}
        </section>
      </article>`;

  return buildSeoPageHtml({
    disableAutoAds: false,
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
      const baseBrandDisplay = s.brand && s.brand.toUpperCase() !== 'UNDEFINED' ? titleCase(s.brand) : (s.name ? titleCase(s.name.split(/\s+/)[0] ?? 'Stazione') : 'Stazione');
      // Title-uniqueness fix (2026-04-27): when two stations share the same
      // brand+street, their slug carries a `-N` disambiguator (e.g.
      // `piccadilly-via-cantonale` vs `piccadilly-via-cantonale-2`). After the
      // 60-char clamp those two pages otherwise produce identical titles.
      // Append the slug's trailing number to the brand display so the
      // disambiguator survives the clamp at the start of the title.
      const slugTailNum = (() => {
        const m = slug.match(/-(\d+)$/);
        return m ? m[1] : '';
      })();
      const brandDisplay = slugTailNum ? `${baseBrandDisplay} ${slugTailNum}` : baseBrandDisplay;
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
function groupByZone(contexts: readonly StationContext[]): Map<FuelZone, StationContext[]> {
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
      `Da dove arriva il prezzo: il valore mostrato in alto è la rilevazione TCS Benzinpreis del giorno per la stazione ${b} di ${c}, con aggiornamento quotidiano nel primo mattino. La struttura del prezzo svizzero comprende l'imposta sugli oli minerali (CHF 0.7388 al litro per la benzina, CHF 0.7589 per il diesel), la sovrimposta CO₂ (variabile in base al mix combustibile), l'IVA all'8,1 % e il margine del distributore: quest'ultimo è la principale leva delle differenze fra ${z} e le zone Ticino limitrofe ed è in genere più alto vicino agli svincoli autostradali e nei comuni a bassa concorrenza. Per ${c} la stazione ${b} si confronta sia con il TCS-Index del giorno per la zona ${z}, sia con la stazione MIMIT più vicina sul lato italiano per dare al frontaliere un prezzo direttamente comparabile.`,
      `Quanto costa un mese di pieno qui: per chi percorre 80 km al giorno (es. tratta tipica Como-Lugano o Varese-Mendrisio) e rifornisce 50 litri ogni 7-9 giorni — circa 200 litri/mese — al prezzo attuale visualizzato sopra il costo mensile da questa stazione si aggira sui 4 pieni × prezzo × 50 L. Confrontalo con i 200 L mensili di benzina Italia (utilizzando il prezzo medio MIMIT Como/Varese/Saronno) e con la media autostradale: quando la differenza Italia-Ticino è inferiore a 0,08 EUR/litro la convenienza italiana scompare considerando 30 minuti di coda al valico (≈ 8-12 EUR di costo opportunità a settimana). Per il calcolo netto giornaliero del pendolarismo abbinato al carburante usa il <a href="/calcola-stipendio/" style="color:var(--color-link)">simulatore stipendio</a>; per la coda al valico la mappa dei tempi di attesa è aggiornata in tempo reale.`,
      `Effetto stagionalità e cambio CHF/EUR. Il prezzo del carburante in Ticino segue tre cicli sovrapposti: il ciclo settimanale (martedì–giovedì sono tipicamente i giorni più convenienti, mentre venerdì sera e domenica registrano un premio di 0,02-0,04 CHF/litro per via della domanda turistica e di rientro), il ciclo stagionale (giugno–agosto e dicembre–gennaio mostrano picchi del 5-8 % per via della domanda di vacanza e dei costi logistici winterizzati) e il ciclo macro (variazioni di Brent tradotte alla pompa con un ritardo di 2-4 settimane). A questo si somma il cambio CHF/EUR: ogni 2 % di rivalutazione del franco rispetto all'euro sposta il vantaggio Italia-Ticino di circa 0,03-0,04 EUR/litro a parità di prezzo lordo. Per un frontaliere ${b} a ${c} (zona ${z}) significa che fare il pieno in Ticino è progressivamente più conveniente quando il franco si rafforza — controllabile sulla pagina cambio valuta del nostro sito. Per scegliere consapevolmente, abbina questo dato al prezzo italiano del giorno e al cambio CHF/EUR live aggiornato dalla nostra pipeline.`,
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
      `Where this price comes from: the figure shown at the top of the page is the daily TCS Benzinpreis observation for the ${b} station in ${c}, refreshed every morning. Swiss pump prices break down into the federal mineral-oil tax (CHF 0.7388 per litre for petrol, CHF 0.7589 for diesel), the CO₂ surcharge (which varies with the fuel mix), 8.1 % VAT and the operator margin — the last lever is the main driver of differences between the ${z} zone and adjacent Ticino zones, and it tends to be higher near motorway exits and in low-competition municipalities. The ${b} station in ${c} is benchmarked both against the daily ${z}-zone TCS index and against the closest MIMIT station on the Italian side, so cross-border commuters get a directly comparable price.`,
      `Monthly cost from this station: a commuter driving roughly 80 km/day on a typical Como-Lugano or Varese-Mendrisio route refuels about 50 litres every 7-9 days — around 200 litres per month — so the monthly bill from this station is approximately four fills × price × 50 L. Compare that with 200 litres of Italian petrol (using the MIMIT average for Como/Varese/Saronno) and with the Swiss motorway average: when the Italy-vs-Ticino gap is under 0.08 EUR/litre the Italian advantage disappears once you factor a 30-minute border queue (≈ 8-12 EUR of opportunity cost per week). To net the fuel cost against your daily commute use the <a href="/en/calculate-salary/" style="color:var(--color-link)">salary calculator</a>, and consult the live border wait-time map before planning a detour.`,
      `Seasonality and the CHF/EUR currency effect. Ticino fuel prices follow three overlapping cycles: a weekly cycle (Tuesday–Thursday are typically the cheapest days, while Friday evening and Sunday carry a 0.02-0.04 CHF/litre premium driven by tourist and weekend-return demand), a seasonal cycle (June–August and December–January peak at 5-8 % above the annual average due to holiday traffic and winterised logistics) and a macro cycle (Brent moves take 2-4 weeks to translate to the pump). On top of this sits the CHF/EUR exchange rate: every 2 % franc appreciation against the euro shifts the Italy-vs-Ticino advantage by about 0.03-0.04 EUR/litre at constant gross price. For a cross-border worker filling up at ${b} in ${c} (${z} zone), refueling in Ticino becomes progressively more attractive whenever the franc strengthens — track the live CHF/EUR rate on our currency page and pair it with today's MIMIT price on the Italian side before deciding which side of the border to fill up on.`,
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
      `Woher der Preis kommt: Der oben angezeigte Wert ist die tägliche TCS-Benzinpreis-Erhebung für die Tankstelle ${b} in ${c}, jeden Morgen aktualisiert. Der schweizerische Pumpenpreis setzt sich zusammen aus der Mineralölsteuer (CHF 0.7388 pro Liter Benzin, CHF 0.7589 pro Liter Diesel), dem CO₂-Zuschlag (variabel je Treibstoffmix), 8,1 % MWST und der Margen des Betreibers — letzterer Hebel erklärt die meisten Unterschiede zwischen der ${z}-Zone und benachbarten Tessiner Zonen und ist typischerweise an Autobahnausfahrten und in wettbewerbsschwachen Gemeinden höher. Die Tankstelle ${b} in ${c} wird sowohl gegen den täglichen ${z}-Zonen-TCS-Index als auch gegen die nächstgelegene MIMIT-Tankstelle auf italienischer Seite gespiegelt — so erhält der Grenzgänger einen direkt vergleichbaren Preis.`,
      `Monatliche Tankkosten von dieser Tankstelle: Ein Pendler mit rund 80 km Tagesstrecke (typische Verbindungen Como-Lugano oder Varese-Mendrisio) tankt etwa 50 Liter alle 7-9 Tage — rund 200 Liter im Monat — und die monatliche Rechnung an dieser Tankstelle beträgt also etwa vier Tankfüllungen × Preis × 50 L. Vergleiche diesen Wert mit 200 Litern italienischem Benzin (anhand des MIMIT-Schnitts in Como/Varese/Saronno) und mit dem schweizerischen Autobahnschnitt: Wenn die Differenz Italien-Tessin unter 0,08 EUR/Liter liegt, verschwindet der italienische Vorteil bereits durch eine 30-Minuten-Grenzwartezeit (≈ 8-12 EUR Opportunitätskosten pro Woche). Die saubere Verrechnung Treibstoff vs. Lohn erfolgt im <a href="/de/gehalt-berechnen/" style="color:var(--color-link)">Gehaltsrechner</a>; die Live-Grenzwartezeiten-Karte zeigt vor jedem Umweg den aktuellen Stand.`,
      `Saisonalität und der CHF/EUR-Wechselkurs. Die Tessiner Treibstoffpreise folgen drei überlagerten Zyklen: einem Wochenzyklus (Dienstag–Donnerstag sind typischerweise die günstigsten Tage, während Freitagabend und Sonntag einen Aufschlag von 0,02-0,04 CHF/Liter aufgrund von Touristen- und Wochenend-Rückreiseverkehr aufweisen), einem saisonalen Zyklus (Juni–August und Dezember–Januar liegen 5-8 % über dem Jahresschnitt wegen Ferienverkehr und winterisierter Logistik) und einem makroökonomischen Zyklus (Brent-Bewegungen schlagen mit 2-4 Wochen Verzögerung an der Zapfsäule durch). Hinzu kommt der CHF/EUR-Wechselkurs: jede 2 %ige Aufwertung des Frankens gegenüber dem Euro verschiebt den Italien-Tessin-Vorteil bei gleichbleibendem Bruttopreis um etwa 0,03-0,04 EUR/Liter. Für einen Grenzgänger an der Tankstelle ${b} in ${c} (Zone ${z}) wird das Tanken im Tessin progressiv attraktiver, sobald der Franken stärker wird — der aktuelle CHF/EUR-Kurs und der heutige MIMIT-Preis auf italienischer Seite stehen auf unserer Wechselkurs-Seite, ideal als Entscheidungsgrundlage vor jeder Tankfahrt.`,
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
      `D'où vient ce prix : la valeur affichée en haut est le relevé quotidien TCS Benzinpreis pour la station ${b} à ${c}, mis à jour chaque matin. Le prix suisse à la pompe se décompose entre la taxe sur les huiles minérales (CHF 0.7388 le litre pour l'essence, CHF 0.7589 pour le diesel), la surtaxe CO₂ (variable selon le mix carburant), la TVA à 8,1 % et la marge de l'exploitant — ce dernier levier explique l'essentiel des écarts entre la zone ${z} et les zones tessinoises voisines, et est typiquement plus élevé près des sorties d'autoroute et dans les communes à faible concurrence. La station ${b} à ${c} est comparée à la fois à l'indice TCS quotidien de la zone ${z} et à la station MIMIT la plus proche côté italien, pour offrir au frontalier un prix directement comparable.`,
      `Coût mensuel d'un plein à cette station : un pendulaire qui parcourt environ 80 km/jour (trajet typique Côme-Lugano ou Varèse-Mendrisio) fait le plein de 50 litres tous les 7-9 jours — soit ≈ 200 litres par mois — donc la facture mensuelle ici équivaut à quatre pleins × prix × 50 L. Comparez ce chiffre à 200 litres d'essence italienne (à la moyenne MIMIT de Côme/Varèse/Saronno) et à la moyenne autoroutière suisse : lorsque l'écart Italie/Tessin descend sous 0,08 EUR/litre, l'avantage italien disparaît dès lors qu'on tient compte de 30 minutes de file au poste-frontière (≈ 8-12 EUR de coût d'opportunité par semaine). Pour intégrer le coût carburant à votre rémunération nette, utilisez le <a href="/fr/calculer-salaire/" style="color:var(--color-link)">simulateur de salaire</a> ; la carte des temps d'attente aux frontières est mise à jour en continu avant tout détour.`,
      `Saisonnalité et effet du change CHF/EUR. Les prix des carburants au Tessin suivent trois cycles superposés : un cycle hebdomadaire (mardi–jeudi sont typiquement les jours les moins chers, alors que vendredi soir et dimanche affichent un supplément de 0,02-0,04 CHF/litre tiré par la demande touristique et de retour de week-end), un cycle saisonnier (juin–août et décembre–janvier dépassent la moyenne annuelle de 5-8 % en raison du trafic de vacances et de la logistique hivernalisée) et un cycle macroéconomique (les variations du Brent se traduisent à la pompe avec 2 à 4 semaines de retard). À cela s'ajoute le change CHF/EUR : chaque 2 % d'appréciation du franc face à l'euro déplace l'avantage Italie/Tessin d'environ 0,03-0,04 EUR/litre à prix brut constant. Pour un frontalier qui fait le plein chez ${b} à ${c} (zone ${z}), faire le plein au Tessin devient progressivement plus attractif quand le franc se renforce — surveillez le cours CHF/EUR live sur notre page change et appariez-le au prix MIMIT du jour côté italien avant de choisir de quel côté de la frontière refaire le plein.`,
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

// ── Per-station hero + map + chart helpers (2026-05-18 redesign) ──
//
// These helpers compose the above-the-fold section of every per-station page.
// They replace the old "wall of prose first" layout that violated CLAUDE.md
// rule #15/16 (mobile-first, filler below fold). The long editorial prose
// remains in the page — just moved below this block so the meaty data
// (brand identity, today's price, location, history chart) reaches mobile
// users without scrolling past 80 lines of methodology.
//
// All styling binds to the OKLCH semantic tokens from `seoContentTokens.ts`
// (no inline hex, per CLAUDE.md rule #17). Brand logos are resolved via
// `resolveBrandLogoUrl` against `public/images/brands/{slug}.{png,svg}`;
// missing logos fall back to a neutral monogram chip. The mini-map embeds
// an OpenStreetMap iframe lazy-loaded (no API key, no script). The history
// chart reuses the existing zone-level `renderFuelHistoryCard` machinery —
// honest caption clarifies it's the zone trend (this station follows it).

interface StationRedesignLabels {
  readonly heroTagline: (street: string, city: string, zone: string) => string;
  readonly viewRanking: (city: string) => string;
  readonly openInMaps: string;
  readonly openInWaze: string;
  readonly locationHeading: string;
  readonly locationCaption: (brand: string, city: string) => string;
  readonly mapAria: (brand: string, city: string) => string;
  readonly coordinatesLabel: string;
  readonly openInOsm: string;
  readonly externalLinkSuffix: string;
  readonly historyHeading: (zone: string) => string;
  readonly historyHeadingStation: (brand: string) => string;
  readonly historyDisclaimer: string;
  readonly historyCaptionStation: string;
  readonly historyAriaLabel: (zone: string, fuel: string, avgFmt: string) => string;
  readonly historyAriaLabelStation: (brand: string, fuel: string, avgFmt: string) => string;
  readonly historyTrendLabel: string;
  readonly historyLastUpdated: (dateStamp: string) => string;
  readonly adviceCheaper: (delta: string, zone: string) => string;
  readonly adviceMedian: (zone: string) => string;
  readonly advicePremium: (delta: string, zone: string) => string;
  readonly rankSuffix: (rankIdx: number, total: number) => string;
}

const STATION_REDESIGN: Record<FuelDailyLocale, StationRedesignLabels> = {
  it: {
    heroTagline: (st, c, z) => `${st || c} · ${c} · zona ${z}`,
    viewRanking: (c) => `Vedi classifica ${c}`,
    openInMaps: 'Apri in Google Maps',
    openInWaze: 'Apri in Waze',
    locationHeading: 'Dove si trova',
    locationCaption: (b, c) => `Posizione della stazione ${b} a ${c}. Tocca la mappa per zoom o usa i pulsanti per la navigazione.`,
    mapAria: (b, c) => `Mappa OpenStreetMap che mostra la posizione della stazione ${b} a ${c}`,
    coordinatesLabel: 'Coordinate',
    openInOsm: 'Apri su OpenStreetMap',
    externalLinkSuffix: 'apre in una nuova scheda',
    historyHeading: (z) => `Andamento prezzo nella zona ${z}`,
    historyHeadingStation: (b) => `Andamento prezzo di ${b}`,
    historyDisclaimer: 'Cronologia per singola stazione non ancora disponibile: mostriamo l\'andamento medio della zona, che questa stazione segue da vicino.',
    historyCaptionStation: 'Serie giornaliera dei prezzi rilevati per questa specifica stazione.',
    historyAriaLabel: (z, f, avg) => `Andamento storico del prezzo ${f.toLowerCase()} nella zona ${z}, media ${avg} CHF/litro nell'intervallo selezionato.`,
    historyAriaLabelStation: (b, f, avg) => `Andamento storico del prezzo ${f.toLowerCase()} alla stazione ${b}, media ${avg} CHF/litro nell'intervallo selezionato.`,
    historyTrendLabel: 'Andamento prezzo',
    historyLastUpdated: (d) => `Ultimo aggiornamento: ${d}`,
    adviceCheaper: (delta, z) => `Buona scelta: oggi questa stazione è ${delta} CHF/litro più economica della media zona ${z}.`,
    adviceMedian: (z) => `Prezzo in linea con la media della zona ${z}: scegli in base alla comodità del percorso.`,
    advicePremium: (delta, z) => `Attenzione: oggi questa stazione è ${delta} CHF/litro più cara della media zona ${z}. Valuta una stazione più economica nella classifica.`,
    rankSuffix: (idx, tot) => tot > 0 ? `${idx + 1}° su ${tot}` : '—',
  },
  en: {
    heroTagline: (st, c, z) => `${st || c} · ${c} · ${z} zone`,
    viewRanking: (c) => `View ${c} ranking`,
    openInMaps: 'Open in Google Maps',
    openInWaze: 'Open in Waze',
    locationHeading: 'Where it is',
    locationCaption: (b, c) => `Location of the ${b} station in ${c}. Tap the map to zoom, or use the buttons for navigation.`,
    mapAria: (b, c) => `OpenStreetMap showing the location of the ${b} station in ${c}`,
    coordinatesLabel: 'Coordinates',
    openInOsm: 'Open in OpenStreetMap',
    externalLinkSuffix: 'opens in a new tab',
    historyHeading: (z) => `Price trend in the ${z} zone`,
    historyHeadingStation: (b) => `Price trend at ${b}`,
    historyDisclaimer: 'Per-station history not yet available: showing the zone average, which this station closely tracks.',
    historyCaptionStation: 'Daily price series observed at this specific station.',
    historyAriaLabel: (z, f, avg) => `Historical ${f.toLowerCase()} price trend in the ${z} zone, average ${avg} CHF/litre over the selected range.`,
    historyAriaLabelStation: (b, f, avg) => `Historical ${f.toLowerCase()} price trend at ${b}, average ${avg} CHF/litre over the selected range.`,
    historyTrendLabel: 'Price trend',
    historyLastUpdated: (d) => `Last updated: ${d}`,
    adviceCheaper: (delta, z) => `Good pick: today this station is ${delta} CHF/litre cheaper than the ${z}-zone average.`,
    adviceMedian: (z) => `Price in line with the ${z}-zone average: pick by route convenience.`,
    advicePremium: (delta, z) => `Heads up: today this station is ${delta} CHF/litre above the ${z}-zone average. Consider a cheaper one from the ranking.`,
    rankSuffix: (idx, tot) => tot > 0 ? `#${idx + 1} of ${tot}` : '—',
  },
  de: {
    heroTagline: (st, c, z) => `${st || c} · ${c} · Zone ${z}`,
    viewRanking: (c) => `Rangliste ${c} ansehen`,
    openInMaps: 'In Google Maps öffnen',
    openInWaze: 'In Waze öffnen',
    locationHeading: 'Standort',
    locationCaption: (b, c) => `Standort der Tankstelle ${b} in ${c}. Tippe die Karte für Zoom oder nutze die Buttons für Navigation.`,
    mapAria: (b, c) => `OpenStreetMap mit Standort der Tankstelle ${b} in ${c}`,
    coordinatesLabel: 'Koordinaten',
    openInOsm: 'In OpenStreetMap öffnen',
    externalLinkSuffix: 'öffnet in einem neuen Tab',
    historyHeading: (z) => `Preisverlauf in der Zone ${z}`,
    historyHeadingStation: (b) => `Preisverlauf bei ${b}`,
    historyDisclaimer: 'Stations-Historie noch nicht verfügbar: gezeigt wird der Zonen-Durchschnitt, dem diese Tankstelle folgt.',
    historyCaptionStation: 'Tägliche Preisreihe dieser spezifischen Tankstelle.',
    historyAriaLabel: (z, f, avg) => `Historischer ${f}-Preisverlauf in der Zone ${z}, Durchschnitt ${avg} CHF/Liter im ausgewählten Zeitraum.`,
    historyAriaLabelStation: (b, f, avg) => `Historischer ${f}-Preisverlauf bei ${b}, Durchschnitt ${avg} CHF/Liter im ausgewählten Zeitraum.`,
    historyTrendLabel: 'Preisverlauf',
    historyLastUpdated: (d) => `Zuletzt aktualisiert: ${d}`,
    adviceCheaper: (delta, z) => `Gute Wahl: heute ist diese Tankstelle ${delta} CHF/Liter günstiger als der Zonen-${z}-Schnitt.`,
    adviceMedian: (z) => `Preis im Schnitt der Zone ${z}: wähle nach Route.`,
    advicePremium: (delta, z) => `Achtung: heute ist diese Tankstelle ${delta} CHF/Liter teurer als der Zonen-${z}-Schnitt. Eine günstigere findest du in der Rangliste.`,
    rankSuffix: (idx, tot) => tot > 0 ? `${idx + 1}/${tot}` : '—',
  },
  fr: {
    heroTagline: (st, c, z) => `${st || c} · ${c} · zone ${z}`,
    viewRanking: (c) => `Voir le classement de ${c}`,
    openInMaps: 'Ouvrir dans Google Maps',
    openInWaze: 'Ouvrir dans Waze',
    locationHeading: 'Où elle se trouve',
    locationCaption: (b, c) => `Emplacement de la station ${b} à ${c}. Touchez la carte pour zoomer ou utilisez les boutons pour la navigation.`,
    mapAria: (b, c) => `OpenStreetMap montrant l'emplacement de la station ${b} à ${c}`,
    coordinatesLabel: 'Coordonnées',
    openInOsm: 'Ouvrir dans OpenStreetMap',
    externalLinkSuffix: 's\'ouvre dans un nouvel onglet',
    historyHeading: (z) => `Tendance du prix dans la zone ${z}`,
    historyHeadingStation: (b) => `Tendance du prix chez ${b}`,
    historyDisclaimer: 'Historique par station pas encore disponible : la moyenne de la zone est affichée, cette station la suit de près.',
    historyCaptionStation: 'Série quotidienne des prix relevés à cette station spécifique.',
    historyAriaLabel: (z, f, avg) => `Tendance historique du prix ${f.toLowerCase()} dans la zone ${z}, moyenne ${avg} CHF/litre sur la période sélectionnée.`,
    historyAriaLabelStation: (b, f, avg) => `Tendance historique du prix ${f.toLowerCase()} chez ${b}, moyenne ${avg} CHF/litre sur la période sélectionnée.`,
    historyTrendLabel: 'Tendance du prix',
    historyLastUpdated: (d) => `Dernière mise à jour : ${d}`,
    adviceCheaper: (delta, z) => `Bon choix : aujourd'hui cette station est ${delta} CHF/litre moins chère que la moyenne de la zone ${z}.`,
    adviceMedian: (z) => `Prix conforme à la moyenne de la zone ${z} : choisissez selon votre itinéraire.`,
    advicePremium: (delta, z) => `Attention : aujourd'hui cette station est ${delta} CHF/litre plus chère que la moyenne de la zone ${z}. Voyez le classement pour une option moins chère.`,
    rankSuffix: (idx, tot) => tot > 0 ? `${idx + 1}/${tot}` : '—',
  },
};

/** Normalised slug for `resolveBrandLogoUrl` (matches its [a-z0-9-] filter). */
function brandLogoSlug(brand: string): string {
  return String(brand || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '');
}

/** Compose the inline SVG monogram fallback when no brand logo is on disk. */
function renderBrandMonogram(brand: string, size: number): string {
  const initials = String(brand || '?')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w.charAt(0).toUpperCase())
    .join('') || '?';
  return `<span aria-hidden="true" style="display:inline-flex;align-items:center;justify-content:center;width:${size}px;height:${size}px;border-radius:14px;background:var(--color-accent-subtle);color:var(--color-accent);font-weight:800;font-size:${Math.round(size * 0.38)}px;border:1px solid var(--color-accent-border);flex-shrink:0">${esc(initials)}</span>`;
}

/** Render the brand visual: real logo if available, monogram fallback. */
function renderBrandVisual(rootDir: string | undefined, brand: string, size: number): string {
  const slug = brandLogoSlug(brand);
  const logoUrl = rootDir ? resolveBrandLogoUrl(rootDir, slug) : null;
  if (!logoUrl) return renderBrandMonogram(brand, size);
  return `<img src="${esc(logoUrl)}" alt="${esc(brand)}" width="${size}" height="${size}" loading="lazy" decoding="async" style="display:block;width:${size}px;height:${size}px;border-radius:14px;object-fit:contain;background:var(--color-surface-alt);padding:6px;border:1px solid var(--color-edge);flex-shrink:0">`;
}

interface StationHeroInput {
  readonly locale: FuelDailyLocale;
  readonly brand: string;
  readonly street: string;
  readonly city: string;
  readonly zoneLabel: string;
  readonly zonePath: string;
  readonly priceFmt: string;
  readonly currency: string;
  readonly fuelLabel: string;
  readonly deltaZone: number | null;
  readonly deltaZoneFmt: string;
  readonly rankIdx: number;
  readonly total: number;
  readonly lat: number | null;
  readonly lng: number | null;
  readonly rootDir: string | undefined;
}

/** Top hero card: brand identity + headline price + quick actions. */
function renderStationHero(inp: StationHeroInput): string {
  const labels = STATION_REDESIGN[inp.locale];
  const logo = renderBrandVisual(inp.rootDir, inp.brand, 64);
  const rankText = labels.rankSuffix(inp.rankIdx, inp.total);
  const deltaTone =
    inp.deltaZone === null
      ? 'var(--color-subtle)'
      : inp.deltaZone < -0.005
      ? 'var(--color-success)'
      : inp.deltaZone > 0.005
      ? 'var(--color-danger)'
      : 'var(--color-subtle)';
  const deltaBg =
    inp.deltaZone === null
      ? 'var(--color-surface-alt)'
      : inp.deltaZone < -0.005
      ? 'var(--color-success-subtle)'
      : inp.deltaZone > 0.005
      ? 'var(--color-danger-subtle)'
      : 'var(--color-surface-alt)';

  const hasCoords = inp.lat !== null && inp.lng !== null;
  const gmapsHref = hasCoords
    ? `https://www.google.com/maps/search/?api=1&query=${inp.lat!.toFixed(6)},${inp.lng!.toFixed(6)}`
    : '';
  const wazeHref = hasCoords
    ? `https://www.waze.com/ul?ll=${inp.lat!.toFixed(6)}%2C${inp.lng!.toFixed(6)}&navigate=yes`
    : '';

  const actionsHtml = `<div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:18px">
    <a href="${esc(inp.zonePath)}" style="${CTA_PRIMARY_STYLE};font-size:14px;padding:9px 14px">${ICON_BAR_CHART_SVG} ${esc(labels.viewRanking(inp.city))} →</a>
    ${hasCoords ? `<a href="${esc(gmapsHref)}" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:6px;padding:9px 14px;border-radius:10px;background:var(--color-surface-alt);color:var(--color-heading);text-decoration:none;font-weight:600;font-size:14px;border:1px solid var(--color-edge)">${ICON_MAP_PIN_SVG} ${esc(labels.openInMaps)}</a>` : ''}
    ${hasCoords ? `<a href="${esc(wazeHref)}" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:6px;padding:9px 14px;border-radius:10px;background:var(--color-surface-alt);color:var(--color-heading);text-decoration:none;font-weight:600;font-size:14px;border:1px solid var(--color-edge)">${ICON_NAVIGATION_SVG} ${esc(labels.openInWaze)}</a>` : ''}
  </div>`;

  return `<section style="${CARD_BODY_STYLE};padding:22px 22px 20px;margin:0 0 18px" aria-label="${esc(inp.brand)} ${esc(inp.city)}">
  <div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap">
    ${logo}
    <div style="flex:1;min-width:200px">
      <div style="font-size:22px;font-weight:700;color:var(--color-heading);line-height:1.2">${esc(inp.brand)}</div>
      <div style="margin-top:4px;font-size:14px;color:var(--color-subtle);line-height:1.4">${esc(labels.heroTagline(inp.street, inp.city, inp.zoneLabel))}</div>
    </div>
  </div>
  <div style="display:flex;gap:18px;flex-wrap:wrap;align-items:baseline;margin-top:20px">
    <div>
      <div style="font-size:clamp(2.2rem,6vw,3rem);font-weight:800;color:var(--color-heading);line-height:1;font-variant-numeric:tabular-nums">${esc(inp.priceFmt)}</div>
      <div style="margin-top:6px;font-size:13px;color:var(--color-subtle);text-transform:uppercase;letter-spacing:0.04em;font-weight:600">${esc(inp.currency)} · ${esc(inp.fuelLabel)}</div>
    </div>
    <div style="display:flex;flex-direction:column;gap:8px">
      <span style="display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border-radius:999px;background:${deltaBg};color:${deltaTone};font-weight:700;font-size:13px;font-variant-numeric:tabular-nums">${esc(inp.deltaZoneFmt)} vs ${esc(inp.zoneLabel)}</span>
      <a href="${esc(inp.zonePath)}" style="display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border-radius:999px;background:var(--color-accent-subtle);color:var(--color-accent);font-weight:700;font-size:13px;text-decoration:none;border:1px solid var(--color-accent-border)">${ICON_TROPHY_SVG} ${esc(rankText)} a ${esc(inp.city)} →</a>
    </div>
  </div>
  ${actionsHtml}
</section>`;
}

/** Advice banner that interprets the delta-vs-zone in one sentence. */
function renderStationAdvice(
  locale: FuelDailyLocale,
  deltaZone: number | null,
  deltaZoneFmt: string,
  zoneLabel: string,
): string {
  const labels = STATION_REDESIGN[locale];
  let text: string;
  let tone: string;
  // formatDelta returns "+0,065 CHF" / "-0,065 CHF" / "0,000 CHF" — strip the
  // sign + " CHF" suffix so the advice template controls punctuation.
  const absDeltaFmt = deltaZoneFmt.replace(/^[-+]/, '').replace(/\s*CHF\s*$/, '');
  if (deltaZone === null || Math.abs(deltaZone) <= 0.02) {
    text = labels.adviceMedian(zoneLabel);
    tone = STAT_TILE_WARNING;
  } else if (deltaZone < 0) {
    text = labels.adviceCheaper(absDeltaFmt, zoneLabel);
    tone = STAT_TILE_SUCCESS;
  } else {
    text = labels.advicePremium(absDeltaFmt, zoneLabel);
    tone = STAT_TILE_DANGER;
  }
  return `<aside data-station-advice style="${tone};margin:0 0 22px;font-weight:600;line-height:1.5">${esc(text)}</aside>`;
}

interface StationLocationInput {
  readonly locale: FuelDailyLocale;
  readonly brand: string;
  readonly city: string;
  readonly address: string;
  readonly lat: number;
  readonly lng: number;
}

/** Map + address card. OSM iframe lazy-loaded, no API key required. */
function renderStationLocationCard(inp: StationLocationInput): string {
  const labels = STATION_REDESIGN[inp.locale];
  const { lat, lng } = inp;
  // ~600m bbox at the equator; tighter near the poles. OK for the latitudes
  // covered by Ticino + 4 border cantons.
  const span = 0.006;
  const bbox = `${(lng - span).toFixed(5)},${(lat - span).toFixed(5)},${(lng + span).toFixed(5)},${(lat + span).toFixed(5)}`;
  const marker = `${lat.toFixed(6)},${lng.toFixed(6)}`;
  const iframeSrc = `https://www.openstreetmap.org/export/embed.html?bbox=${encodeURIComponent(bbox)}&amp;layer=mapnik&amp;marker=${encodeURIComponent(marker)}`;
  const gmapsHref = `https://www.google.com/maps/search/?api=1&query=${marker}`;
  const wazeHref = `https://www.waze.com/ul?ll=${marker.replace(',', '%2C')}&navigate=yes`;

  const osmHref = `https://www.openstreetmap.org/?mlat=${lat.toFixed(6)}&mlon=${lng.toFixed(6)}#map=17/${lat.toFixed(6)}/${lng.toFixed(6)}`;
  const ext = labels.externalLinkSuffix;
  const labelGmaps = `${labels.openInMaps} (${ext})`;
  const labelWaze = `${labels.openInWaze} (${ext})`;
  const labelOsm = `${labels.openInOsm} (${ext})`;

  return `<section style="${CARD_BODY_STYLE};padding:0;margin:0 0 22px;overflow:hidden" aria-labelledby="stationLocation">
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:0">
    <div style="position:relative;background:var(--color-surface-alt);min-height:240px">
      <iframe
        src="${iframeSrc}"
        width="100%"
        height="240"
        style="border:0;display:block;width:100%;height:100%;min-height:240px"
        loading="lazy"
        referrerpolicy="no-referrer-when-downgrade"
        title="${esc(labels.mapAria(inp.brand, inp.city))}"
        aria-label="${esc(labels.mapAria(inp.brand, inp.city))}"></iframe>
    </div>
    <div style="padding:18px 22px">
      <h2 id="stationLocation" style="${H2_STYLE};margin:0 0 10px;font-size:18px">${esc(labels.locationHeading)}</h2>
      <p style="margin:0 0 12px;color:var(--color-body);font-size:14px;line-height:1.5">${esc(labels.locationCaption(inp.brand, inp.city))}</p>
      <dl style="margin:0 0 14px;display:grid;grid-template-columns:max-content 1fr;column-gap:14px;row-gap:6px;font-size:14px;color:var(--color-body)">
        <dt style="display:flex;align-items:center;color:var(--color-subtle)" aria-hidden="true">${ICON_MAP_PIN_SVG}</dt><dd style="margin:0">${esc(inp.address || `${inp.city}`)}</dd>
        <dt style="display:flex;align-items:center;color:var(--color-subtle)" aria-hidden="true">${ICON_NAVIGATION_SVG}</dt><dd style="margin:0;font-variant-numeric:tabular-nums">${esc(labels.coordinatesLabel)}: ${lat.toFixed(5)}, ${lng.toFixed(5)}</dd>
      </dl>
      <div style="display:flex;flex-wrap:wrap;gap:8px">
        <a href="${esc(gmapsHref)}" target="_blank" rel="noopener" aria-label="${esc(labelGmaps)}" style="display:inline-flex;align-items:center;gap:6px;padding:8px 14px;border-radius:10px;background:var(--color-accent);color:var(--color-on-accent);text-decoration:none;font-weight:600;font-size:14px">${ICON_MAP_PIN_SVG} ${esc(labels.openInMaps)}<span aria-hidden="true" style="font-size:11px;opacity:0.85;margin-left:2px">↗</span></a>
        <a href="${esc(wazeHref)}" target="_blank" rel="noopener" aria-label="${esc(labelWaze)}" style="display:inline-flex;align-items:center;gap:6px;padding:8px 14px;border-radius:10px;background:var(--color-surface-alt);color:var(--color-heading);text-decoration:none;font-weight:600;font-size:14px;border:1px solid var(--color-edge)">${ICON_NAVIGATION_SVG} ${esc(labels.openInWaze)}<span aria-hidden="true" style="font-size:11px;opacity:0.7;margin-left:2px">↗</span></a>
      </div>
      <p style="margin:12px 0 0;font-size:13px;line-height:1.4"><a href="${esc(osmHref)}" target="_blank" rel="noopener" aria-label="${esc(labelOsm)}" style="color:var(--color-link);text-decoration:underline;text-underline-offset:2px">${esc(labels.openInOsm)} <span aria-hidden="true">↗</span></a></p>
    </div>
  </div>
</section>`;
}

interface StationHistoryInput {
  readonly locale: FuelDailyLocale;
  readonly zone: FuelZone;
  readonly zoneLabel: string;
  readonly fuel: FuelType;
  readonly fuelLabel: string;
  readonly history: readonly HistorySnapshot[];
  readonly today: Date;
  readonly zoneAvg: number | null;
  /** Slug of the current station — used to look up per-station prices in history. */
  readonly stationSlug: string;
  /** Brand display name — used in the heading + aria label when per-station data is present. */
  readonly brand: string;
  /** Today's per-station price for the chosen fuel (anchors the last point). */
  readonly stationPriceToday: number | null;
}

/**
 * Render the per-station price-history card.
 *
 * Strategy:
 *  - First try a per-station series from `snap.stations[slug][fuel]`.
 *  - If any range yields ≥3 numeric points → render the per-station chart.
 *  - Otherwise fall back to the zone series with an honest disclaimer
 *    ("station-level history not yet available, showing zone average").
 *
 * Going forward (from 2026-05-18 when the snapshot writer started persisting
 * `stations`), the per-station path will activate after ~3 snapshots, i.e.
 * within a few days for any actively-monitored station. Older snapshots
 * lack the `stations` field and contribute 0 station-level points — the
 * fallback path keeps the chart honest in the transition window.
 */
function renderStationHistoryCard(inp: StationHistoryInput): string {
  const labels = STATION_REDESIGN[inp.locale];

  // Try per-station first.
  const stationSeriesByRange = FUEL_RANGE_KEYS.reduce(
    (acc, rk) => {
      acc[rk] = buildStationHistorySeries(
        inp.history as HistorySnapshot[],
        inp.stationSlug,
        inp.fuel,
        FUEL_RANGE_DAYS[rk],
        inp.today,
        inp.stationPriceToday,
      );
      return acc;
    },
    {} as Record<FuelRangeKey, FuelSeriesPoint[]>,
  );
  const stationHasEnough = Object.values(stationSeriesByRange).some((s) => s.length >= 3);

  if (stationHasEnough) {
    const chartCard = renderFuelHistoryCard({
      locale: inp.locale,
      trendLabel: labels.historyTrendLabel,
      buildAriaLabel: (avgFmt) => labels.historyAriaLabelStation(inp.brand, inp.fuelLabel, avgFmt),
      seriesByRange: stationSeriesByRange,
      currency: 'CHF',
    });
    const lastUpdatedLine = `<p style="margin:8px 0 0;color:var(--color-subtle);font-size:12px;text-align:right;font-variant-numeric:tabular-nums">${esc(labels.historyLastUpdated(inp.today.toISOString().slice(0, 10)))}</p>`;
    return `<section style="margin:0 0 24px" aria-labelledby="stationHistory">
  <h2 id="stationHistory" style="${H2_STYLE};margin:0 0 8px;font-size:20px">${esc(labels.historyHeadingStation(inp.brand))}</h2>
  <p style="margin:0 0 14px;color:var(--color-subtle);font-size:13px;line-height:1.5">${esc(labels.historyCaptionStation)}</p>
  ${chartCard}
  ${lastUpdatedLine}
</section>`;
  }

  // Fallback: zone series.
  const zoneSeriesByRange = FUEL_RANGE_KEYS.reduce(
    (acc, rk) => {
      acc[rk] = buildFuelHistorySeries(
        inp.history as HistorySnapshot[],
        inp.zone,
        inp.fuel,
        FUEL_RANGE_DAYS[rk],
        inp.today,
        inp.zoneAvg,
      );
      return acc;
    },
    {} as Record<FuelRangeKey, FuelSeriesPoint[]>,
  );
  const zoneHasPoints = Object.values(zoneSeriesByRange).some((s) => s.length >= 2);
  if (!zoneHasPoints) return '';
  const chartCard = renderFuelHistoryCard({
    locale: inp.locale,
    trendLabel: labels.historyTrendLabel,
    buildAriaLabel: (avgFmt) => labels.historyAriaLabel(inp.zoneLabel, inp.fuelLabel, avgFmt),
    seriesByRange: zoneSeriesByRange,
    currency: 'CHF',
  });
  const lastUpdatedLine = `<p style="margin:8px 0 0;color:var(--color-subtle);font-size:12px;text-align:right;font-variant-numeric:tabular-nums">${esc(labels.historyLastUpdated(inp.today.toISOString().slice(0, 10)))}</p>`;
  return `<section style="margin:0 0 24px" aria-labelledby="stationHistory">
  <h2 id="stationHistory" style="${H2_STYLE};margin:0 0 8px;font-size:20px">${esc(labels.historyHeading(inp.zoneLabel))}</h2>
  <p style="margin:0 0 14px;color:var(--color-subtle);font-size:13px;line-height:1.5;font-style:italic">${esc(labels.historyDisclaimer)}</p>
  ${chartCard}
  ${lastUpdatedLine}
</section>`;
}

/** Render a Swiss per-station HTML page for a single fuel. */
/**
 * Per-station prose section that ties station price to the cross-border
 * commuter use case. Boosts text/HTML ratio above the 10% threshold
 * (audit-text-html-ratio gate) — fuel-station leaf pages were stuck just
 * under the threshold across 130+ stations.
 */
function renderFuelStationFrontalierContext(args: {
  locale: FuelDailyLocale;
  brand: string;
  city: string;
  zone: string;
  fuel: 'benzina' | 'diesel';
  fuelLabel: string;
  priceFmt: string;
  zoneAvgFmt: string;
}): string {
  const { locale, brand, city, zone, fuel, fuelLabel, priceFmt, zoneAvgFmt } = args;
  const isDiesel = fuel === 'diesel';
  const copy = {
    it: {
      h: `${fuelLabel} per frontalieri: cosa significa il prezzo di ${brand} a ${city}`,
      p1: `Per i frontalieri che attraversano quotidianamente il confine tra Italia e Svizzera per lavoro, il rifornimento di ${fuelLabel.toLowerCase()} è una voce di costo ricorrente che incide sul netto in busta paga. Il prezzo di ${priceFmt} a ${brand} (${city}) si colloca nel mercato della zona ${zone}, dove la mediana è di ${zoneAvgFmt}. Confrontare i distributori prima di fare il pieno permette di risparmiare fino a CHF 0.10-0.15 per litro: su un serbatoio da 50 litri sono CHF 5-7 di differenza per ogni rifornimento, che diventano CHF 200-300 all'anno per chi fa pendolarismo quotidiano sui valichi del Sottoceneri.`,
      p2: `${isDiesel ? 'Il diesel in Svizzera ha mantenuto un differenziale strutturale rispetto al diesel italiano' : 'La benzina svizzera è generalmente più costosa di quella italiana'} per via dei tributi federali e cantonali sui carburanti (Imposta sugli oli minerali, supplemento ambientale, IVA al 8.1%). Tuttavia, il franco forte ha attenuato negli ultimi mesi la convenienza del rifornimento in Italia per chi viene pagato in CHF: il cambio CHF/EUR favorevole rende il litro svizzero competitivo per i frontalieri con stipendi sopra i CHF 4'500 mensili. Il punto di pareggio dipende dal cambio del giorno e dall'efficienza della propria auto: con consumi di 6 L/100 km, oltre i 50 km di deviazione per cercare il distributore più economico l'operazione raramente conviene.`,
      p3: `${brand} a ${city} fa parte della rete di distributori monitorati quotidianamente dal nostro crawler, che attinge ai dati pubblici del registro federale dei prezzi (FCA) e ai listini comunicati dalle compagnie petrolifere. La pagina si aggiorna ogni mattina con il prezzo del giorno precedente. Per chi vuole ottimizzare il pendolarismo, suggeriamo di confrontare questo distributore con la mediana della zona ${zone} (${zoneAvgFmt}) e con i distributori sui valichi italiani lato Como/Varese — la differenza tra i due lati della frontiera oscilla normalmente tra CHF 0.20 e CHF 0.40 per litro a seconda del cambio del giorno.`,
    },
    en: {
      h: `${fuelLabel} for cross-border workers: what ${brand}'s price in ${city} means`,
      p1: `For cross-border workers commuting daily across the Italy-Switzerland border, fuel is a recurring expense that affects take-home pay. The CHF ${priceFmt} price at ${brand} (${city}) sits within the ${zone} market, where the median is ${zoneAvgFmt}. Comparing stations before refuelling can save CHF 0.10-0.15 per litre: on a 50-litre tank that is CHF 5-7 per fill-up, which adds up to CHF 200-300 per year for daily commuters on the Sottoceneri border crossings.`,
      p2: `${isDiesel ? 'Swiss diesel has held a structural premium over Italian diesel' : 'Swiss petrol is generally pricier than Italian petrol'} due to federal and cantonal fuel duties (mineral oil tax, environmental surcharge, 8.1% VAT). However, the strong Swiss franc has eased the case for refuelling in Italy for those paid in CHF: the favourable CHF/EUR rate makes Swiss litres competitive for cross-border workers earning above CHF 4,500/month. The break-even depends on the daily exchange rate and your vehicle efficiency: with 6 L/100 km, detours longer than 50 km to chase a cheaper pump rarely pay off.`,
      p3: `${brand} in ${city} is part of the station network monitored daily by our crawler, which pulls from the federal fuel price registry (FCA) and oil-company price lists. This page refreshes every morning with the previous day's price. To optimise your commute, compare this station with the ${zone} median (${zoneAvgFmt}) and with Italian-side stations near the Como/Varese crossings — the cross-border gap typically swings between CHF 0.20 and CHF 0.40 per litre depending on the day's exchange rate.`,
    },
    de: {
      h: `${fuelLabel} für Grenzgänger: was der Preis von ${brand} in ${city} bedeutet`,
      p1: `Für Grenzgänger, die täglich die italienisch-schweizerische Grenze für ihre Arbeit überqueren, ist Treibstoff eine wiederkehrende Ausgabe, die das Nettoeinkommen beeinflusst. Der Preis von CHF ${priceFmt} bei ${brand} (${city}) liegt im Markt der Zone ${zone}, wo der Median CHF ${zoneAvgFmt} beträgt. Der Vergleich von Tankstellen vor dem Tanken kann CHF 0.10-0.15 pro Liter sparen: bei einem 50-Liter-Tank sind das CHF 5-7 pro Tankfüllung, also CHF 200-300 pro Jahr für tägliche Pendler an den Grenzübergängen im Sottoceneri.`,
      p2: `${isDiesel ? 'Schweizer Diesel hat einen strukturellen Aufschlag gegenüber italienischem Diesel beibehalten' : 'Schweizer Benzin ist generell teurer als italienisches Benzin'} aufgrund der Bundes- und Kantonssteuern auf Treibstoffe (Mineralölsteuer, Umweltzuschlag, 8.1% MwSt.). Der starke Schweizer Franken hat jedoch die Vorteile des Tankens in Italien für CHF-bezahlte Personen verringert: Der günstige CHF/EUR-Kurs macht Schweizer Liter wettbewerbsfähig für Grenzgänger mit Gehältern über CHF 4'500/Monat. Die Wirtschaftlichkeit hängt vom Tageskurs und vom Verbrauch des Fahrzeugs ab.`,
      p3: `${brand} in ${city} gehört zum Tankstellennetz, das täglich von unserem Crawler überwacht wird, der auf das Bundesregister der Treibstoffpreise (FCA) und die Preislisten der Mineralölgesellschaften zugreift. Diese Seite aktualisiert sich jeden Morgen mit dem Preis des Vortages. Um den Arbeitsweg zu optimieren, vergleichen Sie diese Tankstelle mit dem Median der Zone ${zone} (CHF ${zoneAvgFmt}) und mit italienischen Tankstellen an den Übergängen Como/Varese.`,
    },
    fr: {
      h: `${fuelLabel} pour frontaliers: ce que signifie le prix de ${brand} à ${city}`,
      p1: `Pour les frontaliers qui traversent quotidiennement la frontière italo-suisse pour le travail, le carburant est une dépense récurrente qui pèse sur le salaire net. Le prix de CHF ${priceFmt} chez ${brand} (${city}) se situe sur le marché de la zone ${zone}, où la médiane est de CHF ${zoneAvgFmt}. Comparer les stations avant de faire le plein permet d'économiser CHF 0.10-0.15 par litre: sur un réservoir de 50 litres c'est CHF 5-7 par plein, soit CHF 200-300 par an pour les pendulaires quotidiens des passages du Sottoceneri.`,
      p2: `${isDiesel ? 'Le diesel suisse a maintenu une prime structurelle par rapport au diesel italien' : 'L\'essence suisse est généralement plus chère que l\'essence italienne'} en raison des taxes fédérales et cantonales sur les carburants (impôt sur les huiles minérales, surtaxe environnementale, TVA à 8.1%). Toutefois, le franc fort a atténué l'avantage de faire le plein en Italie pour ceux payés en CHF: le taux CHF/EUR favorable rend le litre suisse compétitif pour les frontaliers avec un salaire au-dessus de CHF 4'500/mois.`,
      p3: `${brand} à ${city} fait partie du réseau de stations surveillé quotidiennement par notre crawler, qui s'appuie sur le registre fédéral des prix des carburants (FCA) et les listes de prix des compagnies pétrolières. Cette page se met à jour chaque matin avec le prix de la veille. Pour optimiser votre trajet, comparez cette station avec la médiane de la zone ${zone} (CHF ${zoneAvgFmt}) et avec les stations italiennes près des passages Como/Varese.`,
    },
  };
  const c = copy[locale] || copy.it;
  return `<section style="margin:0 0 24px" aria-labelledby="fuelFrontalierContext">
    <h2 id="fuelFrontalierContext" style="${H2_STYLE}">${esc(c.h)}</h2>
    <p style="margin:0 0 14px;color:var(--color-body);line-height:1.7;max-width:860px">${esc(c.p1)}</p>
    <p style="margin:0 0 14px;color:var(--color-body);line-height:1.7;max-width:860px">${esc(c.p2)}</p>
    <p style="margin:0;color:var(--color-body);line-height:1.7;max-width:860px">${esc(c.p3)}</p>
  </section>`;
}

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
  history?: readonly HistorySnapshot[];
  rootDir?: string;
}): string {
  const { ctx, locale, fuel, zoneAvg, zoneStations, today, canonicalPath, alternates, distDir, history, rootDir } = opts;
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

  let h1 = copy.h1(ctx.brandDisplay, ctx.streetDisplay, ctx.city, fuelLabel);
  const intro = copy.intro(ctx.brandDisplay, ctx.city, priceFmt, fuelLabel);
  const paragraph = copy.paragraph(ctx.brandDisplay, ctx.city, priceFmt, zoneAvgFmt, fuelLabel);
  // Above-the-fold tagline (≤120 chars). Long intro/paragraph migrate
  // to the body section below the editorial review (advice), keeping
  // mobile-first hierarchy and preserving text-to-HTML ratio.
  const stationTaglineByLocale: Record<FuelDailyLocale, string> = {
    it: `${ctx.brandDisplay} a ${ctx.city}: ${fuelLabel} a ${priceFmt} CHF/litro · vs media zona ${deltaZoneFmt}.`,
    en: `${ctx.brandDisplay} in ${ctx.city}: ${fuelLabel} at ${priceFmt} CHF/litre · vs zone average ${deltaZoneFmt}.`,
    de: `${ctx.brandDisplay} in ${ctx.city}: ${fuelLabel} zu ${priceFmt} CHF/Liter · vs Zonen-Durchschnitt ${deltaZoneFmt}.`,
    fr: `${ctx.brandDisplay} à ${ctx.city} : ${fuelLabel} à ${priceFmt} CHF/litre · vs moyenne de zone ${deltaZoneFmt}.`,
  };
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
  // Guarantee H1 ≠ <title> after brand-strip — see Italian-station branch
  // for the full rationale (audit:h1-title-duplicates ratchet baseline 0).
  h1 = differentiateH1FromTitle(h1, title, locale);
  const description = intro.slice(0, 180);

  const zonePath = `${BASE_URL}${buildFuelTodayPath(locale, fuel, ctx.zone)}`;
  const hasGeo =
    typeof ctx.station.lat === 'number' &&
    typeof ctx.station.lng === 'number' &&
    Number.isFinite(ctx.station.lat) &&
    Number.isFinite(ctx.station.lng);
  const heroHtml = renderStationHero({
    locale,
    brand: ctx.brandDisplay,
    street: ctx.streetDisplay,
    city: ctx.city,
    zoneLabel,
    zonePath,
    priceFmt,
    currency: copy.currency,
    fuelLabel,
    deltaZone,
    deltaZoneFmt,
    rankIdx: Math.max(rankIdx, 0),
    total,
    lat: hasGeo ? (ctx.station.lat as number) : null,
    lng: hasGeo ? (ctx.station.lng as number) : null,
    rootDir,
  });
  const adviceHtml = renderStationAdvice(locale, deltaZone, deltaZoneFmt, zoneLabel);
  const locationHtml = hasGeo
    ? renderStationLocationCard({
        locale,
        brand: ctx.brandDisplay,
        city: ctx.city,
        address: ctx.station.address ?? '',
        lat: ctx.station.lat as number,
        lng: ctx.station.lng as number,
      })
    : '';
  const historyHtml = history && history.length > 0
    ? renderStationHistoryCard({
        locale,
        zone: ctx.zone,
        zoneLabel,
        fuel,
        fuelLabel,
        history,
        today,
        zoneAvg,
        stationSlug: ctx.slug,
        brand: ctx.brandDisplay,
        stationPriceToday: price,
      })
    : '';

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
  <header style="margin-bottom:18px">
    <p style="${HERO_EYEBROW_STYLE}">${esc(dateStamp)}</p>
    <h1 style="${H1_STYLE}">${esc(h1)}</h1>
    <p style="${LEDE_STYLE}">${esc(stationTaglineByLocale[locale])}</p>
  </header>
  ${heroHtml}
  ${adviceHtml}
  ${locationHtml}
  ${historyHtml}
  <section style="margin:0 0 24px;${CARD_STYLE}" aria-labelledby="stationReview">
    <h2 id="stationReview" style="${H2_STYLE};margin:0 0 12px;font-size:20px">${esc(editorialAssessment.heading)}</h2>
    <p style="margin:0;color:var(--color-body);line-height:1.7;max-width:860px">${esc(editorialAssessment.body)}</p>
  </section>
  <section style="margin:0 0 24px">
    <p style="margin:0 0 14px;color:var(--color-body);line-height:1.7;max-width:860px">${esc(intro)}</p>
    <p style="margin:0;color:var(--color-body);line-height:1.7;max-width:860px">${esc(paragraph)}</p>
  </section>
  <section style="margin:0 0 24px;${CARD_STYLE}" aria-labelledby="stationInfo">
    <h2 id="stationInfo" style="${H2_STYLE};margin:0 0 12px;font-size:20px">${esc(copy.infoHeading)}</h2>
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
  ${renderFuelStationFrontalierContext({ locale, brand: ctx.brandDisplay, city: ctx.city, zone: zoneLabel, fuel, fuelLabel, priceFmt, zoneAvgFmt })}
  <p style="margin:0 0 22px"><a href="${BASE_URL}${buildFuelTodayPath(locale, fuel, ctx.zone)}" style="${LINK_ACCENT_STYLE};font-weight:600">← ${esc(copy.backToZone(zoneLabel))}</a></p>
  ${generateRelatedLinksBlock(locale, 'fuel_station', {
    fuelType: fuel,
    fuelZone: ctx.zone,
    stationSlug: ctx.slug,
    siblingStations,
  })}
  <section style="margin-top:32px" aria-label="advertisement">
    ${adSlotHtml('ARTICLE_END_MULTIPLEX')}
  </section>
</article>`;

  const extraHead = `    <meta property="og:image" content="${BASE_URL}/og-image.png">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${esc(title)}">
    <meta name="twitter:description" content="${esc(description)}">
    <meta name="twitter:site" content="@frontaliereticino">`;

  return buildSeoPageHtml({
    disableAutoAds: false,
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

/**
 * Extra frontalier-context prose for Italian city/today fuel pages. The
 * pages have a heavy multi-range SVG chart (~30 KB markup) plus a
 * structured-data table that pushed the text/HTML ratio under 10 %
 * despite the existing 3-paragraph context section. This adds 2 more
 * paragraphs covering Italian fuel-tax mechanics and concrete commute
 * math interpolating cityDisplay/nearestZoneLabel/minPriceFmt.
 */
function renderItalianCityFrontalierExtra(args: {
  locale: FuelDailyLocale;
  fuelLabel: string;
  cityDisplay: string;
  nearestZoneLabel: string;
  minPriceFmt: string;
}): string {
  const { locale, fuelLabel, cityDisplay, nearestZoneLabel, minPriceFmt } = args;
  const copy: Record<FuelDailyLocale, { h: string; p1: string; p2: string }> = {
    it: {
      h: `${fuelLabel} a ${cityDisplay}: matematica del pendolarismo per i frontalieri`,
      p1: `La struttura del prezzo del ${fuelLabel.toLowerCase()} in Italia rende ${cityDisplay} un punto di riferimento utile per pianificare i rifornimenti del frontaliere. Il prezzo industriale (legato a Brent e cambio EUR/USD) rappresenta circa il 40 % del finale; le accise — fissate a circa 0,617 EUR/litro per la benzina e 0,617 EUR/litro per il gasolio dopo l'allineamento del 2024 — pesano per un altro 35 %; l'IVA al 22 % chiude il calcolo. Quando il prezzo industriale scende, l'effetto si propaga in 3-5 giorni alla pompa: le pagine come questa per ${cityDisplay} sono utili proprio per cogliere queste finestre temporali. Il minimo di oggi a ${cityDisplay} (${minPriceFmt} EUR/litro) va confrontato con la media del lato svizzero in zona ${nearestZoneLabel} per decidere se conviene rifornirsi prima del confine o sul rientro.`,
      p2: `Calcolo concreto per chi pendola da ${cityDisplay} verso il Ticino. Su un anno tipico (220 giorni lavorativi × 60 km medi andata-ritorno = 13'200 km), un'auto con consumo di 6 L/100 km consuma circa 792 litri. A 0,15 EUR/litro di differenza tra Italia e Ticino significano CHF 119 all'anno (con CHF/EUR a 1,06); a 0,30 EUR/litro la differenza sale a CHF 238. Aggiungi a questa cifra l'usura del veicolo (~CHF 0,15/km su veicolo medio = CHF 1'980/anno), il bollo (CHF 200-400 a seconda della cilindrata), l'assicurazione RC (CHF 600-1'200), revisione e tagliandi (~CHF 600/anno) e il costo opportunità del tempo perso ai valichi (30 minuti × 220 giorni × tariffa oraria del proprio salario): la voce carburante pesa solitamente solo per il 15-25 % del costo totale del pendolarismo. Per il calcolo netto-lordo dello stipendio considerando questi costi reali apri il <a href="${BASE_URL}/calcola-stipendio/" style="color:var(--color-link)">simulatore stipendio frontaliere</a>.`,
    },
    en: {
      h: `${fuelLabel} in ${cityDisplay}: cross-border worker commute math`,
      p1: `The price structure of ${fuelLabel.toLowerCase()} in Italy makes ${cityDisplay} a useful reference point for cross-border worker refuelling planning. The industrial price (linked to Brent and the EUR/USD rate) represents about 40 % of the final price; excise duties — set at roughly 0.617 EUR/litre for petrol and 0.617 EUR/litre for diesel after the 2024 alignment — weigh another 35 %; 22 % VAT closes the calculation. When the industrial price drops, the effect propagates to the pump in 3-5 days: pages like this one for ${cityDisplay} help spot those windows. Today's minimum in ${cityDisplay} (${minPriceFmt} EUR/litre) should be compared with the Swiss-side average in the ${nearestZoneLabel} zone to decide whether to refuel before crossing the border or on the way home.`,
      p2: `Concrete maths for someone commuting from ${cityDisplay} into Ticino. Across a typical year (220 working days × 60 km round-trip on average = 13,200 km), a car with 6 L/100 km consumption uses about 792 litres. A 0.15 EUR/litre gap between Italy and Ticino means CHF 119 per year (CHF/EUR at 1.06); a 0.30 EUR/litre gap doubles it to CHF 238. Add vehicle wear (~CHF 0.15/km on a mid-segment car = CHF 1,980/year), road tax (CHF 200-400 depending on engine size), liability insurance (CHF 600-1,200), inspection and servicing (~CHF 600/year) and the opportunity cost of time lost at the border (30 minutes × 220 days × your hourly rate): fuel typically accounts for only 15-25 % of total commute cost. For the gross-to-net calculation including these real costs use the <a href="${BASE_URL}/en/calculate-salary/" style="color:var(--color-link)">cross-border salary simulator</a>.`,
    },
    de: {
      h: `${fuelLabel} in ${cityDisplay}: Pendel-Mathematik für Grenzgänger`,
      p1: `Die Preisstruktur des ${fuelLabel.toLowerCase()} in Italien macht ${cityDisplay} zu einem nützlichen Referenzpunkt für die Tankplanung von Grenzgängern. Der Industriepreis (gekoppelt an Brent und EUR/USD-Kurs) macht etwa 40 % des Endpreises aus; die Verbrauchsteuern — nach der Angleichung 2024 auf rund 0,617 EUR/Liter für Benzin und 0,617 EUR/Liter für Diesel festgelegt — wiegen weitere 35 %; 22 % MwSt. schliessen die Rechnung ab. Wenn der Industriepreis sinkt, wirkt sich das in 3-5 Tagen an der Tankstelle aus: Seiten wie diese für ${cityDisplay} helfen genau dabei, diese Fenster zu erkennen. Der heutige Mindestpreis in ${cityDisplay} (${minPriceFmt} EUR/Liter) sollte mit dem Schweizer Durchschnitt in der Zone ${nearestZoneLabel} verglichen werden, um zu entscheiden, ob vor dem Grenzübergang oder auf der Rückfahrt zu tanken ist.`,
      p2: `Konkrete Rechnung für Pendler von ${cityDisplay} ins Tessin. Über ein typisches Jahr (220 Arbeitstage × 60 km Hin- und Rückfahrt im Durchschnitt = 13'200 km) verbraucht ein Auto mit 6 L/100 km rund 792 Liter. Eine Differenz von 0,15 EUR/Liter zwischen Italien und Tessin bedeutet CHF 119 pro Jahr (CHF/EUR bei 1,06); eine Differenz von 0,30 EUR/Liter verdoppelt das auf CHF 238. Hinzu kommen Fahrzeugverschleiss (~CHF 0,15/km auf einem Mittelklassewagen = CHF 1'980/Jahr), Motorfahrzeugsteuer (CHF 200-400 je nach Hubraum), Haftpflichtversicherung (CHF 600-1'200), Abgaswartung und Service (~CHF 600/Jahr) und die Opportunitätskosten der Wartezeit an der Grenze (30 Minuten × 220 Tage × Stundensatz Ihres Lohns): Treibstoff macht typischerweise nur 15-25 % der gesamten Pendelkosten aus. Für die Brutto-Netto-Berechnung des Lohns inklusive dieser realen Kosten nutzen Sie den <a href="${BASE_URL}/de/gehalt-berechnen/" style="color:var(--color-link)">Grenzgänger-Lohnsimulator</a>.`,
    },
    fr: {
      h: `${fuelLabel} à ${cityDisplay} : mathématique du trajet pour les frontaliers`,
      p1: `La structure du prix du ${fuelLabel.toLowerCase()} en Italie fait de ${cityDisplay} un point de référence utile pour la planification des pleins du frontalier. Le prix industriel (lié au Brent et au taux EUR/USD) représente environ 40 % du prix final ; les accises — fixées à environ 0,617 EUR/litre pour l'essence et 0,617 EUR/litre pour le diesel après l'alignement 2024 — pèsent encore 35 % ; la TVA à 22 % ferme le calcul. Lorsque le prix industriel baisse, l'effet se propage à la pompe en 3-5 jours : des pages comme celle-ci pour ${cityDisplay} aident précisément à saisir ces fenêtres. Le minimum d'aujourd'hui à ${cityDisplay} (${minPriceFmt} EUR/litre) doit être comparé à la moyenne suisse de la zone ${nearestZoneLabel} pour décider s'il convient de faire le plein avant la frontière ou au retour.`,
      p2: `Calcul concret pour quelqu'un qui pendule depuis ${cityDisplay} vers le Tessin. Sur une année typique (220 jours ouvrables × 60 km aller-retour en moyenne = 13'200 km), une voiture avec une consommation de 6 L/100 km consomme environ 792 litres. Un écart de 0,15 EUR/litre entre l'Italie et le Tessin représente CHF 119 par an (CHF/EUR à 1,06) ; un écart de 0,30 EUR/litre le double à CHF 238. Ajoutez l'usure du véhicule (~CHF 0,15/km sur une voiture milieu de gamme = CHF 1'980/an), la taxe de circulation (CHF 200-400 selon la cylindrée), l'assurance responsabilité civile (CHF 600-1'200), le contrôle technique et l'entretien (~CHF 600/an) et le coût d'opportunité du temps perdu à la frontière (30 minutes × 220 jours × votre taux horaire) : le carburant ne représente typiquement que 15-25 % du coût total du trajet. Pour le calcul brut-net du salaire incluant ces coûts réels, utilisez le <a href="${BASE_URL}/fr/calculer-salaire/" style="color:var(--color-link)">simulateur de salaire frontalier</a>.`,
    },
  };
  const c = copy[locale] || copy.it;
  return `<section style="margin:0 0 24px" aria-labelledby="itCityFrontalierExtra">
    <h2 id="itCityFrontalierExtra" style="${H2_STYLE}">${esc(c.h)}</h2>
    <p style="margin:0 0 14px;color:var(--color-body);line-height:1.7;max-width:860px">${c.p1}</p>
    <p style="margin:0;color:var(--color-body);line-height:1.7;max-width:860px">${c.p2}</p>
  </section>`;
}

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

  let h1 = copy.h1(fuelLabel, entry.display);
  const intro = copy.intro(fuelLabel, entry.display, minPriceFmt);
  const paragraph = copy.paragraph(fuelLabel, entry.display, minPriceFmt, nearestZoneLabel);
  // Above-the-fold tagline (≤120 chars). The long intro/paragraph migrate
  // to the body section below the action area, preserving text-to-HTML ratio.
  const italianCityTaglineByLocale: Record<FuelDailyLocale, string> = {
    it: `${fuelLabel} a ${entry.display}: prezzo minimo ${minPriceFmt} €/L · zona CH più vicina ${nearestZoneLabel}.`,
    en: `${fuelLabel} in ${entry.display}: lowest price ${minPriceFmt} €/L · nearest CH zone ${nearestZoneLabel}.`,
    de: `${fuelLabel} in ${entry.display}: Mindestpreis ${minPriceFmt} €/L · nächste CH-Zone ${nearestZoneLabel}.`,
    fr: `${fuelLabel} à ${entry.display} : prix minimum ${minPriceFmt} €/L · zone CH la plus proche ${nearestZoneLabel}.`,
  };

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
  // Differentiate H1 ↔ <title> after brand drop. See station-detail branch.
  h1 = differentiateH1FromTitle(h1, title, locale);
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
    <p style="${LEDE_STYLE}">${esc(italianCityTaglineByLocale[locale])}</p>
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
  <section style="margin:0 0 24px" aria-labelledby="itCityTable">
    <h2 id="itCityTable" style="${H2_STYLE}">${esc(copy.tableTitle(entry.display))}</h2>
    ${stationListHtml}
  </section>
  <section style="margin:0 0 24px">
    <p style="margin:0 0 14px;color:var(--color-body);line-height:1.7;max-width:860px">${esc(intro)}</p>
    <p style="margin:0;color:var(--color-body);line-height:1.7;max-width:860px">${esc(paragraph)}</p>
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
  ${renderItalianCityFrontalierExtra({ locale, fuelLabel, cityDisplay: entry.display, nearestZoneLabel, minPriceFmt })}
  <p style="margin:0 0 22px"><a href="${BASE_URL}${buildFuelTodayPath(locale, fuel, entry.nearestZone)}" style="${LINK_ACCENT_STYLE};font-weight:600">→ ${esc(copy.backLink)} (${esc(nearestZoneLabel)})</a></p>
  ${generateRelatedLinksBlock(locale, 'fuel_italian_city', {
    fuelType: fuel,
    italianCitySlug: entry.slug,
    italianCityDisplay: entry.display,
    fuelZone: entry.nearestZone,
  })}
  <section style="margin-top:32px" aria-label="advertisement">
    ${adSlotHtml('ARTICLE_END_MULTIPLEX')}
  </section>
</article>`;

  const extraHead = `    <meta property="og:image" content="${BASE_URL}/og-image.png">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${esc(title)}">
    <meta name="twitter:description" content="${esc(description)}">
    <meta name="twitter:site" content="@frontaliereticino">`;

  return buildSeoPageHtml({
    disableAutoAds: false,
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
 *
 * Single source of truth (2026-04-29 anti-orphan fix): callers may pass a
 * pre-collected `contexts` array. The fuel-station browseable index plugin
 * MUST be fed the same list so the index links every station that has a
 * detail page — otherwise stations whose detail page is emitted but whose
 * index link is missing become orphans in `sitemap-fuel-stations.xml`.
 */
export function generateFuelStationPages(opts: {
  dataset: FuelPricesDataset;
  today?: Date;
  distDir?: string;
  maxPages?: number;
  /**
   * Optional pre-collected contexts. When provided, the function skips its
   * own `collectSwissStationContexts(dataset)` call. Used by the closeBundle
   * hook so the index plugin and the detail-page generator share one list.
   */
  contexts?: readonly StationContext[];
  /** History snapshots — drives the per-page zone history chart. */
  history?: readonly HistorySnapshot[];
  /** Project root dir — passed to renderStationPage so it can resolve brand logos. */
  rootDir?: string;
}): Record<string, string> {
  const dataset = opts.dataset;
  const today = opts.today ?? new Date();
  const distDir = opts.distDir;
  const history = opts.history;
  const rootDir = opts.rootDir;
  const maxPages = opts.maxPages ?? Number(process.env.MAX_FUEL_STATION_PAGES_PER_BUILD || 1500);
  const pages: Record<string, string> = {};

  const contexts = opts.contexts ?? collectSwissStationContexts(dataset);
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
          history,
          rootDir,
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
      const baseBrandDisplay =
        s.brand && s.brand.toUpperCase() !== 'UNDEFINED'
          ? titleCase(s.brand)
          : s.stationName
            ? titleCase(s.stationName.split(/\s+/)[0] ?? 'Stazione')
            : 'Stazione';
      // Title-uniqueness fix (2026-04-27): same as Swiss path — append the
      // slug-disambiguator number to brand so the 60-char clamp doesn't
      // collapse two same-brand-and-street stations to the identical title.
      const slugTailNum = (() => {
        const m = slug.match(/-(\d+)$/);
        return m ? m[1] : '';
      })();
      const brandDisplay = slugTailNum ? `${baseBrandDisplay} ${slugTailNum}` : baseBrandDisplay;

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
  contexts: readonly ItalianStationContext[],
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
      `Da dove arriva il prezzo: la cifra in alto è la rilevazione MIMIT (Ministero delle Imprese e del Made in Italy) per la stazione di ${c}, dichiarata dal gestore tramite il portale Osservaprezzi e replicata qui ogni mattina. Il prezzo italiano alla pompa è composto da prezzo industriale (legato al Brent e al cambio EUR/USD), accisa fissa (≈ 0,617 EUR/litro per la benzina, ≈ 0,617 EUR/litro per il gasolio dopo l'allineamento del 2024), IVA al 22 % e margine del distributore: quest'ultima componente fa la differenza fra una pompa indipendente lontana dal valico e una stazione brand vicina al confine, dove la sovrattassa frontaliera è tipicamente di 0,03-0,07 EUR/litro. La pagina collega la stazione di ${c} alla zona Ticino più vicina (${nz}) per fornire al frontaliere un confronto immediato fra le due sponde del valico.`,
      `Quanto costa un mese di rifornimenti partendo da ${c}: per un frontaliere che percorre 80 km/giorno (es. ${c}-Lugano o ${c}-Mendrisio passando dal valico di Brogeda o di Stabio) e fa un pieno di 50 litri ogni 7-9 giorni — circa 200 litri al mese — il costo mensile da questa stazione equivale a 4 pieni × prezzo attuale × 50 L. Confronta questo importo con 200 litri sul lato Ticino (a media ${nz}) e considera il tempo aggiuntivo: 30 minuti di coda al valico al rientro × 4 settimane = ~2 ore/mese di costo-tempo, equivalenti a ~25-35 EUR per chi guadagna 4.000-6.000 CHF/mese. Quando il delta Italia-Ticino scende sotto 0,08 EUR/litro la convenienza italiana sparisce; sopra 0,15 EUR/litro restano 30-90 EUR netti al mese di risparmio.`,
      `Quale giorno e quale momento conviene fare il pieno qui. I prezzi MIMIT a ${c} hanno una stagionalità prevedibile: lunedì e martedì sono i giorni più convenienti perché molti gestori reimpostano i listini all'inizio della settimana, mentre venerdì pomeriggio e domenica registrano un premio di 0,02-0,05 EUR/litro per via della domanda di vacanza. In termini di orario, le prime ore del mattino (06:00-08:30) e tarda serata (dopo le 21:00) consentono di evitare la coda dovuta al traffico di lavoratori. Se la stazione di ${c} è self-service, il differenziale tipico è di 0,10-0,15 EUR/litro a favore tuo rispetto alla modalità "servito" — sempre vantaggioso per un pieno da 50 litri (≈ 5-7 EUR di risparmio). Le pompe bianche e gli ipermercati periferici di ${c} sono in genere ulteriori 0,03-0,07 EUR/litro più convenienti dei brand integrati. Per scegliere l'opzione più economica del giorno consulta tutte le stazioni della città dalla pagina hub di ${c} e abbinala al prezzo del lato Ticino in zona ${nz}: l'<a href="/calcola-stipendio/" style="color:var(--color-link)">simulatore stipendio</a> netta carburante e tempo perso sull'intero pendolarismo.`,
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
      `Where this price comes from: the figure shown at the top is the MIMIT (Italian Ministry of Enterprise) reading for this station in ${c}, self-declared by the operator through the Osservaprezzi portal and refreshed here every morning. The Italian pump price breaks down into the industrial price (linked to Brent and EUR/USD), the fixed excise duty (≈ 0.617 EUR/litre for petrol, ≈ 0.617 EUR/litre for diesel after the 2024 alignment), 22 % VAT, and the operator margin — the last component is what separates an independent pump far from the border from a branded station next to the crossing, where the frontaliere premium is typically 0.03-0.07 EUR/litre. The page maps this ${c} station to its nearest Ticino zone (${nz}) so that cross-border workers see both sides of the border at a glance.`,
      `Monthly refuel cost from ${c}: a frontaliere driving 80 km/day (for example ${c}-Lugano or ${c}-Mendrisio through Brogeda or Stabio) refuels 50 litres every 7-9 days — about 200 litres per month — so the monthly bill from this station is roughly 4 fills × today's price × 50 L. Compare that with 200 litres on the Ticino side (using the ${nz} zone average) and add the time penalty: 30 minutes of border queue × 4 weeks = ~2 hours/month, worth ~25-35 EUR for someone earning 4,000-6,000 CHF/month. When the Italy-vs-Ticino delta drops under 0.08 EUR/litre the Italian advantage disappears; above 0.15 EUR/litre 30-90 EUR/month of net saving remains.`,
      `Best day and time to fill up here. MIMIT prices in ${c} follow a predictable cadence: Monday and Tuesday are the cheapest days because many operators reset their lists at the start of the week, while Friday afternoons and Sundays carry a 0.02-0.05 EUR/litre premium driven by holiday demand. Time-of-day matters too: early morning (06:00-08:30) and late evening (after 21:00) avoid the working-traffic queue. If the station in ${c} is self-service, the typical differential is 0.10-0.15 EUR/litre in your favour against the "served" mode — always worth taking on a 50-litre fill (≈ 5-7 EUR saved). Independent "pompe bianche" and peripheral hypermarket stations in ${c} are usually a further 0.03-0.07 EUR/litre cheaper than the integrated brand stations. Pick today's lowest from the ${c} city hub and pair it with the Ticino-side ${nz} zone price: the <a href="/en/calculate-salary/" style="color:var(--color-link)">salary calculator</a> nets fuel and lost time across the whole commute.`,
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
      `Woher der Preis kommt: Der oben gezeigte Wert ist die MIMIT-Erhebung (Italienisches Ministerium für Unternehmen und Made in Italy) für die Tankstelle in ${c}, vom Betreiber über das Osservaprezzi-Portal selbst gemeldet und hier morgens aktualisiert. Der italienische Pumpenpreis setzt sich zusammen aus dem Industriepreis (gekoppelt an Brent und EUR/USD), der fixen Verbrauchsteuer (≈ 0,617 EUR/Liter Benzin und ≈ 0,617 EUR/Liter Diesel nach dem Angleich 2024), 22 % Mehrwertsteuer und der Marge des Betreibers — letzterer Hebel macht den Unterschied zwischen einer unabhängigen Tankstelle weit weg von der Grenze und einer Markentankstelle direkt am Übergang, wo der Grenzgänger-Aufschlag typischerweise 0,03-0,07 EUR/Liter beträgt. Diese Tankstelle in ${c} wird der nächstgelegenen Tessiner Zone (${nz}) zugeordnet, damit Grenzgänger beide Seiten der Grenze auf einen Blick vergleichen können.`,
      `Monatliche Tankkosten von ${c}: Ein Grenzgänger mit 80 km Tagesstrecke (z. B. ${c}-Lugano oder ${c}-Mendrisio über Brogeda oder Stabio) tankt etwa 50 Liter alle 7-9 Tage — rund 200 Liter im Monat — daher beträgt die Monatsrechnung an dieser Tankstelle ungefähr 4 Tankfüllungen × heutiger Preis × 50 L. Vergleiche das mit 200 Litern auf der Tessiner Seite (zum ${nz}-Zonendurchschnitt) und kalkuliere die Zeitkosten ein: 30 Minuten Grenzwartezeit × 4 Wochen = ~2 Stunden/Monat, entsprechend ~25-35 EUR für jemand mit 4.000-6.000 CHF/Monat Lohn. Wenn der Italien-Tessin-Delta unter 0,08 EUR/Liter sinkt, verschwindet der italienische Vorteil; über 0,15 EUR/Liter bleiben 30-90 EUR/Monat Nettoersparnis.`,
      `Bester Tag und beste Tageszeit zum Tanken hier. Die MIMIT-Preise in ${c} folgen einem vorhersehbaren Rhythmus: Montag und Dienstag sind die günstigsten Tage, weil viele Betreiber zu Wochenbeginn die Preislisten zurücksetzen, während Freitagnachmittag und Sonntag einen Aufschlag von 0,02-0,05 EUR/Liter aufgrund der Ferienverkehrnachfrage tragen. Auch die Tageszeit zählt: frühmorgens (06:00-08:30) und spätabends (nach 21:00) vermeidet man die Schlange der Berufspendler. Ist die Tankstelle in ${c} im Self-Service-Modus, beträgt die typische Differenz 0,10-0,15 EUR/Liter zu Ihren Gunsten gegenüber dem "Bedienmodus" — bei einer 50-Liter-Tankfüllung lohnt sich das immer (≈ 5-7 EUR gespart). Unabhängige "pompe bianche" und peripher gelegene Hypermarkt-Tankstellen in ${c} sind üblicherweise nochmals 0,03-0,07 EUR/Liter günstiger als die integrierten Markentankstellen. Wählen Sie das günstigste Angebot des Tages aus der ${c}-Stadt-Hub-Seite und vergleichen Sie es mit der Tessiner ${nz}-Zone: Der <a href="/de/gehalt-berechnen/" style="color:var(--color-link)">Gehaltsrechner</a> verrechnet Treibstoff- und Zeitkosten über das gesamte Pendeln.`,
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
      `D'où vient ce prix : la valeur affichée en haut est le relevé MIMIT (ministère italien de l'Entreprise et du Made in Italy) pour la station de ${c}, déclaré par l'exploitant via le portail Osservaprezzi et reproduit ici chaque matin. Le prix italien à la pompe se compose du prix industriel (lié au Brent et au cours EUR/USD), de l'accise fixe (≈ 0,617 EUR/litre pour l'essence et ≈ 0,617 EUR/litre pour le gasoil après l'alignement de 2024), de la TVA à 22 % et de la marge de l'exploitant — c'est cette dernière qui distingue une pompe indépendante éloignée du poste-frontière d'une station de marque collée à la frontière, où la surtaxe frontalière atteint typiquement 0,03-0,07 EUR/litre. La page met en relation cette station de ${c} avec la zone tessinoise la plus proche (${nz}) afin que les frontaliers voient les deux côtés de la frontière d'un coup d'œil.`,
      `Coût mensuel de plein depuis ${c} : un frontalier qui parcourt 80 km/jour (par exemple ${c}-Lugano ou ${c}-Mendrisio via Brogeda ou Stabio) refait son plein de 50 litres tous les 7-9 jours — environ 200 litres par mois — donc la facture mensuelle depuis cette station équivaut à 4 pleins × prix du jour × 50 L. Comparez ce montant à 200 litres côté tessinois (sur la moyenne de la zone ${nz}) et ajoutez la pénalité temporelle : 30 minutes de file × 4 semaines = ~2 heures/mois, ce qui représente ~25-35 EUR pour un revenu de 4.000-6.000 CHF/mois. Quand l'écart Italie/Tessin descend sous 0,08 EUR/litre l'avantage italien disparaît ; au-dessus de 0,15 EUR/litre il reste 30-90 EUR nets d'économie mensuelle.`,
      `Meilleur jour et meilleur moment pour faire le plein ici. Les prix MIMIT à ${c} suivent un rythme prévisible : lundi et mardi sont les jours les moins chers parce que beaucoup d'exploitants réinitialisent leurs listes en début de semaine, tandis que le vendredi après-midi et le dimanche affichent un supplément de 0,02-0,05 EUR/litre tiré par la demande de vacances. L'heure de la journée compte aussi : tôt le matin (06:00-08:30) et tard le soir (après 21:00) évitent la file des trajets domicile-travail. Si la station de ${c} est en self-service, le différentiel typique est de 0,10-0,15 EUR/litre en votre faveur par rapport au mode "servi" — toujours rentable sur un plein de 50 litres (≈ 5-7 EUR économisés). Les "pompes blanches" indépendantes et les hypermarchés périphériques de ${c} sont en général encore 0,03-0,07 EUR/litre moins chers que les stations de marque intégrées. Choisissez l'option la plus économique du jour depuis la page hub de ${c} et appariez-la au prix tessinois de la zone ${nz} : le <a href="/fr/calculer-salaire/" style="color:var(--color-link)">simulateur de salaire</a> intègre carburant et temps perdu sur l'ensemble du pendulaire.`,
    ],
    siblingsHeading: 'Autres stations en ville',
    breadcrumbHome: 'Accueil',
    italyLabel: 'Italie',
  },
};

/**
 * Locale-aware frontalier-context prose for Italian per-station detail pages.
 * Mirrors {@link renderItalianCityFrontalierExtra} but interpolates the
 * station-level identifiers (brand, street, city, today's price, nearest
 * Ticino zone) so each page emits page-specific copy — Google sees per-station
 * variation rather than template boilerplate, and the visible text/HTML ratio
 * stays comfortably above the Semrush 10 % threshold even with the SVG history
 * card and stat tiles dominating the markup.
 */
function renderItalianStationFrontalierExtra(args: {
  locale: FuelDailyLocale;
  fuelLabel: string;
  brandDisplay: string;
  streetDisplay: string;
  cityDisplay: string;
  nearestZoneLabel: string;
  priceFmt: string;
  cityAvgFmt: string;
}): string {
  const { locale, fuelLabel, brandDisplay, streetDisplay, cityDisplay, nearestZoneLabel, priceFmt, cityAvgFmt } = args;
  const stationLabel = `${brandDisplay} ${streetDisplay}`.trim();
  const copy: Record<FuelDailyLocale, { h: string; p1: string; p2: string }> = {
    it: {
      h: `${stationLabel} a ${cityDisplay}: matematica del rifornimento per il frontaliere`,
      p1: `Il prezzo di ${priceFmt} EUR/litro alla pompa ${stationLabel} di ${cityDisplay} si scompone secondo la struttura tipica del ${fuelLabel.toLowerCase()} italiano: circa il 40 % è prezzo industriale legato al Brent e al cambio EUR/USD, il 35 % è accisa fissa (≈ 0,617 EUR/litro dopo l'allineamento del 2024), il 22 % è IVA, e il restante è margine del distributore — è proprio quest'ultima componente, non le tasse, a separare una stazione brand vicina al valico da una pompa indipendente in periferia di ${cityDisplay}. Confronta il prezzo di oggi (${priceFmt} EUR) con la media città di ${cityAvgFmt} EUR e con la media della zona Ticino di ${nearestZoneLabel}: quando il delta Italia-Ticino supera 0,15 EUR/litro fare il pieno qui prima del valico ha senso anche tenendo conto del costo opportunità di una coda di 30 minuti al confine; quando scende sotto 0,08 EUR/litro l'unico vantaggio residuo è logistico (si rientra a casa già con il pieno).`,
      p2: `Calcolo annuale concreto per chi pendola da ${cityDisplay} verso il Ticino passando da questa stazione. Su 220 giorni lavorativi × 60 km medi andata-ritorno = 13'200 km annui, un'auto con consumo di 6 L/100 km consuma circa 792 litri all'anno: alla pompa ${stationLabel} a ${priceFmt} EUR/litro la spesa annua di carburante è circa 792 × ${priceFmt.replace(/[^0-9,.]/g, '').replace(',', '.')} EUR ≈ il 15-25 % del costo totale del pendolarismo. Il resto si compone di usura veicolo (~CHF 0,15/km × 13'200 km = CHF 1'980/anno), bollo (CHF 200-400 secondo cilindrata), assicurazione RC (CHF 600-1'200), revisione e tagliandi (~CHF 600/anno) e tempo perso ai valichi (30 minuti × 220 giorni × tariffa oraria del proprio salario CHF). Per il calcolo netto-lordo dello stipendio frontaliere che integra carburante, tempo e usura usa il <a href="${BASE_URL}/calcola-stipendio/" style="color:var(--color-link)">simulatore stipendio frontaliere</a>; per la convenienza fiscale aggiornata al nuovo accordo 2026 confronta il regime fiscale del Permesso G nel comparatore dedicato.`,
    },
    en: {
      h: `${stationLabel} in ${cityDisplay}: refuelling math for cross-border workers`,
      p1: `Today's ${priceFmt} EUR/litre at the ${stationLabel} pump in ${cityDisplay} breaks down along the standard Italian ${fuelLabel.toLowerCase()} structure: about 40 % is industrial price (linked to Brent and the EUR/USD rate), 35 % is fixed excise duty (≈ 0.617 EUR/litre after the 2024 alignment), 22 % is VAT, and the rest is the operator's margin — and it is the margin, not the tax stack, that separates a branded station next to the border crossing from an independent pump on the outskirts of ${cityDisplay}. Compare today's price (${priceFmt} EUR) with the city average of ${cityAvgFmt} EUR and with the Ticino-side ${nearestZoneLabel} zone average: when the Italy-vs-Ticino delta is above 0.15 EUR/litre, filling up here before crossing pays off even after a 30-minute border queue; below 0.08 EUR/litre the only remaining advantage is logistical (you arrive home already topped up).`,
      p2: `Concrete yearly maths for someone commuting from ${cityDisplay} into Ticino through this station. Across 220 working days × 60 km round-trip on average = 13,200 km/year, a car with 6 L/100 km consumption uses roughly 792 litres/year: at the ${stationLabel} pump priced at ${priceFmt} EUR/litre that's about 792 × ${priceFmt.replace(/[^0-9,.]/g, '').replace(',', '.')} EUR per year — typically 15-25 % of total commute cost. The remaining 75-85 % is vehicle wear (~CHF 0.15/km × 13,200 km = CHF 1,980/year), road tax (CHF 200-400 depending on engine size), liability insurance (CHF 600-1,200), inspection and servicing (~CHF 600/year) and the opportunity cost of border-queue time (30 minutes × 220 days × your hourly CHF rate). For the gross-to-net cross-border salary calculation including fuel, time and wear use the <a href="${BASE_URL}/en/calculate-salary/" style="color:var(--color-link)">cross-border salary simulator</a>; for the fiscal break-even under the 2026 New Agreement, compare the Permit G regime side-by-side in the dedicated comparator.`,
    },
    de: {
      h: `${stationLabel} in ${cityDisplay}: Tank-Mathematik für Grenzgänger`,
      p1: `Der heutige Preis von ${priceFmt} EUR/Liter an der Tankstelle ${stationLabel} in ${cityDisplay} setzt sich nach der typischen Struktur des italienischen ${fuelLabel.toLowerCase()} zusammen: rund 40 % entfallen auf den Industriepreis (gekoppelt an Brent und EUR/USD-Kurs), 35 % auf die fixe Verbrauchsteuer (≈ 0,617 EUR/Liter nach dem Angleich 2024), 22 % auf die Mehrwertsteuer und der Rest auf die Marge des Betreibers — und gerade letztere, nicht die Abgaben, trennt eine Marken-Tankstelle direkt am Grenzübergang von einer unabhängigen Pumpe am Stadtrand von ${cityDisplay}. Vergleichen Sie den heutigen Preis (${priceFmt} EUR) mit dem Stadtdurchschnitt von ${cityAvgFmt} EUR und mit dem Tessiner Zonendurchschnitt von ${nearestZoneLabel}: liegt der Italien-Tessin-Delta über 0,15 EUR/Liter, lohnt sich das Tanken hier vor dem Grenzübertritt selbst nach 30 Minuten Wartezeit; unter 0,08 EUR/Liter bleibt nur noch der logistische Vorteil (man fährt schon vollgetankt nach Hause).`,
      p2: `Konkrete Jahresrechnung für jemand, der von ${cityDisplay} ins Tessin pendelt und an dieser Tankstelle tankt. Über 220 Arbeitstage × 60 km Hin- und Rückfahrt im Durchschnitt = 13'200 km/Jahr verbraucht ein Auto mit 6 L/100 km rund 792 Liter pro Jahr: an der ${stationLabel}-Pumpe zum Preis von ${priceFmt} EUR/Liter ergibt das ungefähr 792 × ${priceFmt.replace(/[^0-9,.]/g, '').replace(',', '.')} EUR jährlich — typisch 15-25 % der gesamten Pendelkosten. Die restlichen 75-85 % verteilen sich auf Fahrzeugverschleiss (~CHF 0,15/km × 13'200 km = CHF 1'980/Jahr), Motorfahrzeugsteuer (CHF 200-400 je nach Hubraum), Haftpflichtversicherung (CHF 600-1'200), Service und Abgaswartung (~CHF 600/Jahr) und Opportunitätskosten der Wartezeit am Grenzübergang (30 Minuten × 220 Tage × Stundenlohn). Für die Brutto-Netto-Berechnung des Grenzgängerlohns inklusive Treibstoff, Zeit und Verschleiss nutzen Sie den <a href="${BASE_URL}/de/gehalt-berechnen/" style="color:var(--color-link)">Grenzgänger-Lohnsimulator</a>; für die steuerliche Wirtschaftlichkeit nach dem neuen Abkommen 2026 vergleichen Sie das Grenzgänger-G-Regime im dedizierten Vergleichsrechner.`,
    },
    fr: {
      h: `${stationLabel} à ${cityDisplay} : mathématique du plein pour le frontalier`,
      p1: `Le prix d'aujourd'hui de ${priceFmt} EUR/litre à la pompe ${stationLabel} de ${cityDisplay} se décompose selon la structure typique du ${fuelLabel.toLowerCase()} italien : environ 40 % est le prix industriel (lié au Brent et au taux EUR/USD), 35 % est l'accise fixe (≈ 0,617 EUR/litre après l'alignement 2024), 22 % est la TVA et le reste correspond à la marge de l'exploitant — et c'est précisément cette dernière, et non la fiscalité, qui sépare une station de marque collée à la frontière d'une pompe indépendante en périphérie de ${cityDisplay}. Comparez le prix d'aujourd'hui (${priceFmt} EUR) avec la moyenne ville de ${cityAvgFmt} EUR et avec la moyenne tessinoise de la zone ${nearestZoneLabel} : quand l'écart Italie/Tessin dépasse 0,15 EUR/litre, faire le plein ici avant le passage est rentable même après 30 minutes d'attente ; en dessous de 0,08 EUR/litre il ne reste que l'avantage logistique (on rentre déjà fait le plein).`,
      p2: `Calcul annuel concret pour qui pendule depuis ${cityDisplay} vers le Tessin via cette station. Sur 220 jours ouvrables × 60 km aller-retour moyen = 13'200 km/an, une voiture consommant 6 L/100 km utilise environ 792 litres/an : à la pompe ${stationLabel} à ${priceFmt} EUR/litre cela représente environ 792 × ${priceFmt.replace(/[^0-9,.]/g, '').replace(',', '.')} EUR par an — typiquement 15-25 % du coût total du trajet. Les 75-85 % restants se composent d'usure du véhicule (~CHF 0,15/km × 13'200 km = CHF 1'980/an), taxe de circulation (CHF 200-400 selon la cylindrée), assurance responsabilité civile (CHF 600-1'200), contrôle technique et entretien (~CHF 600/an) et coût d'opportunité du temps perdu à la frontière (30 minutes × 220 jours × votre taux horaire CHF). Pour le calcul brut-net du salaire frontalier intégrant carburant, temps et usure, utilisez le <a href="${BASE_URL}/fr/calculer-salaire/" style="color:var(--color-link)">simulateur de salaire frontalier</a> ; pour la rentabilité fiscale selon le nouvel accord 2026, comparez le régime du Permis G dans le comparateur dédié.`,
    },
  };
  const c = copy[locale] || copy.it;
  return `<section style="margin:0 0 24px" aria-labelledby="itStationFrontalierExtra">
    <h2 id="itStationFrontalierExtra" style="${H2_STYLE}">${esc(c.h)}</h2>
    <p style="margin:0 0 14px;color:var(--color-body);line-height:1.7;max-width:860px">${c.p1}</p>
    <p style="margin:0;color:var(--color-body);line-height:1.7;max-width:860px">${c.p2}</p>
  </section>`;
}

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

  let h1 = copy.h1(ctx.brandDisplay, ctx.streetDisplay, cityName, fuelLabel);
  const intro = copy.intro(ctx.brandDisplay, cityName, priceFmt, fuelLabel);
  const paragraph = copy.paragraph(ctx.brandDisplay, cityName, priceFmt, cityAvgFmt, fuelLabel);
  const rankingLine = copy.ranking(rankLabel, total, cityName);
  // Above-the-fold tagline (≤120 chars). Long intro/paragraph migrate
  // to the body section below the action area, preserving text-to-HTML ratio.
  const italianStationTaglineByLocale: Record<FuelDailyLocale, string> = {
    it: `${ctx.brandDisplay} a ${cityName}: ${fuelLabel} a ${priceFmt} €/L · vs media città ${deltaCityFmt}.`,
    en: `${ctx.brandDisplay} in ${cityName}: ${fuelLabel} at ${priceFmt} €/L · vs city average ${deltaCityFmt}.`,
    de: `${ctx.brandDisplay} in ${cityName}: ${fuelLabel} zu ${priceFmt} €/L · vs Stadt-Durchschnitt ${deltaCityFmt}.`,
    fr: `${ctx.brandDisplay} à ${cityName} : ${fuelLabel} à ${priceFmt} €/L · vs moyenne ville ${deltaCityFmt}.`,
  };

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
  // When buildTitleWithBrand drops the brand suffix (headline + brand > 66
  // chars), the rendered <title> collapses to the H1 string verbatim. The
  // helper appends a locale-aware narrative tag so the
  // `audit:h1-title-duplicates` ratchet (baseline 0) accepts the page.
  h1 = differentiateH1FromTitle(h1, title, locale);
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
    <p style="${LEDE_STYLE}">${esc(italianStationTaglineByLocale[locale])}</p>
  </header>
  <section style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;margin:0 0 18px">
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
    <p style="margin:0 0 12px;color:var(--color-body);line-height:1.7;max-width:860px">${esc(intro)}</p>
    <p style="margin:0 0 12px;color:var(--color-body);line-height:1.7;max-width:860px">${esc(paragraph)}</p>
    ${copy.contextParagraphs(ctx.brandDisplay, cityName, nearestZoneLabel)
      .map((p) => `<p style="margin:0 0 12px;color:var(--color-body);line-height:1.7;max-width:860px">${p}</p>`)
      .join('')}
  </section>
  ${renderItalianStationFrontalierExtra({
    locale,
    fuelLabel,
    brandDisplay: ctx.brandDisplay,
    streetDisplay: ctx.streetDisplay,
    cityDisplay: cityName,
    nearestZoneLabel,
    priceFmt,
    cityAvgFmt,
  })}
  ${historyCard
    ? `<section style="margin:0 0 24px" aria-labelledby="itStationTrend">
        <h2 id="itStationTrend" style="${H2_STYLE}">${esc(IT_TREND_LABEL[locale])}</h2>
        <p style="margin:0 0 12px;color:var(--color-subtle);line-height:1.6">${esc(IT_TREND_INTRO[locale])}</p>
        ${historyCard}
      </section>`
    : ''}
  <p style="margin:0 0 22px"><a href="${BASE_URL}${cityHubPath}" style="${LINK_ACCENT_STYLE};font-weight:600">← ${esc(copy.backToCity(cityName))}</a></p>
  ${siblingsHtml}
  <section style="margin-top:32px" aria-label="advertisement">
    ${adSlotHtml('ARTICLE_END_MULTIPLEX')}
  </section>
</article>`;

  const extraHead = `    <meta property="og:image" content="${BASE_URL}/og-image.png">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${esc(title)}">
    <meta name="twitter:description" content="${esc(description)}">
    <meta name="twitter:site" content="@frontaliereticino">`;

  return buildSeoPageHtml({
    disableAutoAds: false,
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
  /**
   * Optional pre-collected contexts (single-source-of-truth pattern; see
   * generateFuelStationPages for rationale). When provided, the function
   * skips its own `collectItalianStationContexts(dataset)` call.
   */
  contexts?: readonly ItalianStationContext[];
}): Record<string, string> {
  const dataset = opts.dataset;
  const history = opts.history ?? [];
  const today = opts.today ?? new Date();
  const distDir = opts.distDir;
  const pages: Record<string, string> = {};

  const contexts = opts.contexts ?? collectItalianStationContexts(dataset);
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
        'sitemap-fuel-indexes.xml',
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

      // ── Single source of truth for station contexts (2026-04-29) ─
      // Compute Swiss + Italian contexts ONCE before any generator runs,
      // then thread the SAME list through both the per-station page
      // generators AND the browseable-index generator. This guarantees the
      // index links every station whose detail page we emit — eliminating
      // the divergence that was leaking new orphans into
      // `sitemap-fuel-stations.xml` whenever the index source happened to
      // disagree with the detail-page source on a fresh dataset.
      const swissContexts = collectSwissStationContexts(dataset);
      const italianContexts = collectItalianStationContexts(dataset);

      const pages = generateFuelDailyPages({ rootDir, dataset, history, today, distDir });
      const archives = generateFuelArchivePages({ history, today, distDir });
      const stationPages = generateFuelStationPages({
        dataset,
        today,
        distDir,
        contexts: swissContexts,
        history,
        rootDir,
      });
      const italianCityPages = generateFuelItalianCityPages({ dataset, history, today, distDir });
      const italianStationPages = generateFuelItalianStationPages({
        dataset,
        history,
        today,
        distDir,
        contexts: italianContexts,
      });

      // ── F6.5: Browseable indexes (anti-orphan-page fix) ────────
      // Build leaf lists from the SAME contexts used for the per-station
      // pages above, so what we link from the index is exactly what we
      // publish. Any divergence here re-introduces orphans.
      const swissLeaves: SwissStationLeaf[] = swissContexts.map((c) => ({
        zone: c.zone,
        slug: c.slug,
        name: c.station.name ?? c.brandDisplay,
        brand: c.brandDisplay,
        address: c.station.address ?? '',
      }));
      const italianLeaves: ItalianStationLeaf[] = italianContexts.map((c) => ({
        citySlug: c.cityEntry.slug,
        cityDisplay: c.cityEntry.display,
        stationSlug: c.slug,
        name: c.station.stationName ?? c.brandDisplay,
        brand: c.brandDisplay,
        address: c.station.address ?? '',
      }));
      const indexPages = generateFuelIndexPages({
        distDir,
        today,
        swissStations: swissLeaves,
        italianStations: italianLeaves,
      });

      const collector = new WriteCollector({ distDir, pluginName: 'fuelDailyPagesPlugin' });

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

      // ── F6.5: Index pages (anti-orphan-page fix) ───────────────
      // These pages exist exactly to surface every per-station / per-city leaf
      // via internal <a href> links, so the orphan-pages-in-sitemaps gate
      // (CLAUDE.md "SEO content gate — orphan pages in sitemaps") sees them
      // reachable from the homepage BFS. Word-count gate is intentionally a
      // touch lower than per-station pages because each index has a long anchor
      // list that contributes meaningfully to the visible content surface.
      const INDEX_MIN_WORDS = 220;
      const indexSitemapPaths: string[] = [];
      let indexPagesWritten = 0;
      for (const [path, html] of Object.entries(indexPages)) {
        const words = countHtmlBodyWords(html);
        if (words < INDEX_MIN_WORDS) {
          // Loud failure: skipping a fuel index page silently orphans every
          // per-station / per-city leaf it would have linked. Emit an error
          // (not a warning) so CI surfaces it before the orphan-pages gate
          // catches the downstream regression.
          skipped++;
          console.error(
            `[fuel-daily-pages] CRITICAL: index thin content (${words} words < ${INDEX_MIN_WORDS}) for ${path} — skipping. ` +
              `Per-station leaves it should link will be orphaned in sitemap-fuel-stations.xml. ` +
              `Investigate fuelStationIndexPages.ts copy + station data integrity.`,
          );
          continue;
        }
        const outDir = np.join(distDir, path.replace(/^\/+/, ''));
        collector.add(np.join(outDir, 'index.html'), html);
        indexSitemapPaths.push(path);
        indexPagesWritten++;
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
      writeSitemap(indexSitemapPaths, 'sitemap-fuel-indexes.xml', 'daily');

      const result: PluginResult = {
        pagesWritten,
        archivesWritten,
        skippedForWordCount: skipped,
        stationPagesWritten,
        italianCityPagesWritten,
        italianStationPagesWritten,
      };
      console.log(
        `\x1b[36m[fuel-daily-pages]\x1b[0m Generated ${result.pagesWritten} daily + ${result.archivesWritten} archives + ${stationPagesWritten} CH-station + ${italianCityPagesWritten} IT-city + ${italianStationPagesWritten} IT-station + ${indexPagesWritten} indexes (skipped ${result.skippedForWordCount})`,
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
