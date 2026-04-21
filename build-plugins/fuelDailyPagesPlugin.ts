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
  ANALYTICS_SNIPPET,
  BASE_URL,
  FAVICON_LINKS,
  MIN_INDEXABLE_WORDS,
  countHtmlBodyWords,
} from './constants';
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
  buildFuelArchivePath,
  buildFuelTodayPath,
  type FuelDailyLocale,
  type FuelType,
  type FuelZone,
} from './fuelDailyData';
import { generateRelatedLinksBlock } from './shared/relatedLinks';

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
}

interface ZonePrice {
  avg: number | null;
  minStations: Array<{ name: string; address: string; priceChf: number }>;
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
  const stationPrices: Array<{ name: string; address: string; priceChf: number }> = [];
  for (const s of stations) {
    const p = pricesFromStation(s);
    if (!p) continue;
    prices.push(p[fuel]);
    stationPrices.push({
      name: String(s.name || s.brand || '—').trim(),
      address: String(s.address || '').trim(),
      priceChf: p[fuel],
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
  // Accept within ±1 day drift
  const candidates = history.filter((h) => {
    const diff = Math.abs((new Date(h.date).getTime() - new Date(target).getTime()) / (24 * 3600 * 1000));
    return diff <= 1;
  });
  const snap = candidates[candidates.length - 1];
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
      'Il grafico qui sotto mostra l\'andamento del prezzo negli ultimi 7 giorni — utile per capire se conviene rifornirsi oggi o aspettare. I dati arrivano dalle stazioni Swiss vicine al confine e sono aggiornati quotidianamente. Lo storico si popola con il passare dei giorni.',
    updatedLabel: 'Aggiornamento',
    avgLabel: 'Prezzo medio oggi',
    vsYesterday: 'vs ieri',
    vs7d: 'vs 7 giorni fa',
    top3Label: 'Le 3 stazioni più economiche',
    trendLabel: 'Andamento ultimi 7 giorni',
    trendEmpty: 'Storico in costruzione: il grafico si aggiorna ogni giorno a partire da oggi.',
    faqTitle: 'Domande frequenti',
    regionalLabel: 'Tutto il Ticino',
    archiveLabel: 'Archivio mensile',
    breadcrumbHome: 'Home',
    currencyLabel: 'CHF/litro',
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
      'The chart below shows the price trend for the last 7 days — handy to decide whether to fill up today or wait. Data comes from Swiss stations close to the border and is updated daily. History builds up as the days go by.',
    updatedLabel: 'Updated',
    avgLabel: 'Average price today',
    vsYesterday: 'vs yesterday',
    vs7d: 'vs 7 days ago',
    top3Label: 'Top 3 cheapest stations',
    trendLabel: 'Last 7 days trend',
    trendEmpty: 'History is being collected: the chart fills in day by day.',
    faqTitle: 'Frequently asked questions',
    regionalLabel: 'All of Ticino',
    archiveLabel: 'Monthly archive',
    breadcrumbHome: 'Home',
    currencyLabel: 'CHF/litre',
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
      'Das folgende Diagramm zeigt die Preisentwicklung der letzten 7 Tage — hilfreich, um zu entscheiden, ob Sie heute tanken oder warten. Die Daten kommen aus den Tankstellen in Grenznähe und werden täglich aktualisiert. Die Historie baut sich Tag für Tag auf.',
    updatedLabel: 'Aktualisiert',
    avgLabel: 'Durchschnittspreis heute',
    vsYesterday: 'vs gestern',
    vs7d: 'vs 7 Tage',
    top3Label: 'Top 3 günstigste Tankstellen',
    trendLabel: 'Verlauf der letzten 7 Tage',
    trendEmpty: 'Historie wird aufgebaut: das Diagramm füllt sich Tag für Tag.',
    faqTitle: 'Häufige Fragen',
    regionalLabel: 'Ganzes Tessin',
    archiveLabel: 'Monatsarchiv',
    breadcrumbHome: 'Startseite',
    currencyLabel: 'CHF/Liter',
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
      'Le graphique ci-dessous montre l\'évolution du prix sur les 7 derniers jours — utile pour décider si faire le plein aujourd\'hui ou attendre. Les données viennent des stations suisses près de la frontière et sont mises à jour quotidiennement. L\'historique se construit jour après jour.',
    updatedLabel: 'Mis à jour',
    avgLabel: 'Prix moyen aujourd\'hui',
    vsYesterday: 'vs hier',
    vs7d: 'vs 7 jours',
    top3Label: 'Top 3 stations les moins chères',
    trendLabel: 'Tendance des 7 derniers jours',
    trendEmpty: 'Historique en cours de construction : le graphique se remplit jour par jour.',
    faqTitle: 'Questions fréquentes',
    regionalLabel: 'Tout le Tessin',
    archiveLabel: 'Archive mensuelle',
    breadcrumbHome: 'Accueil',
    currencyLabel: 'CHF/litre',
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
}

const LOCALE_OG: Record<FuelDailyLocale, string> = {
  it: 'it_IT',
  en: 'en_US',
  de: 'de_DE',
  fr: 'fr_FR',
};

function renderPage(inp: PageInputs): string {
  const { locale, fuel, zone, dataset, history, canonicalPath, today, alternates } = inp;
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

  const deltaYest = avg !== null && yesterday !== null ? Number((avg - yesterday).toFixed(3)) : null;
  const delta7 = avg !== null && weekAgo !== null ? Number((avg - weekAgo).toFixed(3)) : null;

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
  const stationsHtml = top3.length > 0
    ? `<ol style="list-style:decimal inside;padding:0;margin:0">${top3
        .map(
          (s) => `<li style="padding:12px 16px;border:1px solid #e2e8f0;border-radius:12px;background:#ffffff;margin-bottom:10px">
        <div style="font-weight:700;font-size:16px;color:#0f172a">${esc(s.name)}</div>
        <div style="margin-top:4px;color:#475569;font-size:14px">${esc(s.address)}</div>
        <div style="margin-top:6px;font-size:15px;color:#1d4ed8;font-weight:700">${formatPrice(s.priceChf, locale)} ${esc(copy.currencyLabel)}</div>
      </li>`,
        )
        .join('')}</ol>`
    : `<p style="padding:12px 16px;border-radius:12px;background:#fef3c7;color:#78350f">${esc(copy.trendEmpty)}</p>`;

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
  const trendHtml = `<table style="width:100%;border-collapse:collapse;font-size:14px">
    <thead><tr>
      <th style="text-align:left;padding:8px;border-bottom:1px solid #e2e8f0;color:#475569;font-weight:700">${esc(locale === 'it' ? 'Data' : locale === 'de' ? 'Datum' : 'Date')}</th>
      <th style="text-align:right;padding:8px;border-bottom:1px solid #e2e8f0;color:#475569;font-weight:700">${esc(copy.avgLabel)}</th>
    </tr></thead>
    <tbody>${trendRows
      .map((r) => `<tr>
        <td style="padding:8px;border-bottom:1px solid #f1f5f9;color:#0f172a">${esc(r.date)}</td>
        <td style="padding:8px;border-bottom:1px solid #f1f5f9;color:#0f172a;text-align:right;font-variant-numeric:tabular-nums">${r.price === null ? '—' : formatPrice(r.price, locale) + ' CHF'}</td>
      </tr>`)
      .join('')}</tbody>
  </table>`;

  // FAQ section
  const faqItems = copy.faq;
  const faqHtml = `<section style="margin:32px 0 0" aria-labelledby="fuelDailyFaq">
    <h2 id="fuelDailyFaq" style="margin:0 0 14px;font-size:22px;color:#0f172a">${esc(copy.faqTitle)}</h2>
    ${faqItems
      .map(
        (f) => `<details style="padding:12px 14px;border:1px solid #e2e8f0;border-radius:12px;margin-bottom:8px;background:#ffffff">
        <summary style="font-weight:700;cursor:pointer;color:#0f172a">${esc(f.q)}</summary>
        <p style="margin:10px 0 0;color:#334155;line-height:1.6">${esc(f.a(fuelLabel, zoneLabel))}</p>
      </details>`,
      )
      .join('')}
  </section>`;

  // Alternates
  const alternatesHtml = (Object.keys(alternates) as FuelDailyLocale[])
    .map((alt) => `    <link rel="alternate" hreflang="${alt}" href="${BASE_URL}${alternates[alt]}">`)
    .join('\n');

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

  // Product LD (price + currency). Only emit when we have a real average —
  // fulfils the spec's "price with currency CHF" requirement.
  const productLd = avg !== null
    ? JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'Product',
        name: `${fuelLabel} ${zoneLabel}`,
        description: intro,
        category: fuel === 'diesel' ? 'Fuel/Diesel' : 'Fuel/Gasoline',
        offers: {
          '@type': 'Offer',
          priceCurrency: 'CHF',
          price: avg.toFixed(3),
          priceValidUntil: new Date(today.getTime() + 24 * 3600 * 1000).toISOString().slice(0, 10),
          availability: 'https://schema.org/InStock',
          url: canonicalUrl,
        },
      })
    : '';

  const title = `${h1} (${dateStamp}) | Frontaliere Ticino`;
  const description = intro.slice(0, 180);

  // Main body markup (kept plain + inline-styled so we don't depend on the
  // SPA bundle and the static page ranks on its own).
  const bodyHtml = `<main style="max-width:1100px;margin:0 auto;padding:32px 20px 56px;color:#0f172a;font-family:system-ui,-apple-system,sans-serif">
  <nav style="margin:0 0 14px;font-size:13px;color:#475569">
    <a href="${BASE_URL}/" style="color:#1d4ed8;text-decoration:none">${esc(copy.breadcrumbHome)}</a>
    <span> / </span>
    <span>${esc(fuelLabel)}</span>
    <span> / </span>
    <span>${esc(zoneLabel)}</span>
  </nav>
  <header style="margin-bottom:22px">
    <p style="margin:0 0 6px;color:#4f46e5;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.04em">${esc(copy.updatedLabel)} · ${dateStamp}</p>
    <h1 style="margin:0 0 12px;font-size:clamp(1.8rem,4.5vw,2.75rem);line-height:1.1">${esc(h1)}</h1>
    <p style="margin:0 0 14px;font-size:18px;line-height:1.55;max-width:860px">${esc(intro)}</p>
  </header>
  <section style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;margin:0 0 24px">
    <div style="padding:18px;border-radius:18px;background:#eef2ff;border:1px solid #c7d2fe">
      <div style="font-size:12px;color:#4338ca;font-weight:700;text-transform:uppercase">${esc(copy.avgLabel)}</div>
      <div style="margin-top:8px;font-size:32px;font-weight:800;color:#1e293b">${priceFmt}</div>
      <div style="margin-top:2px;font-size:13px;color:#475569">${esc(copy.currencyLabel)}</div>
    </div>
    <div style="padding:18px;border-radius:18px;background:${deltaYest !== null && deltaYest < 0 ? '#ecfccb' : '#fef3c7'};border:1px solid ${deltaYest !== null && deltaYest < 0 ? '#bef264' : '#fde68a'}">
      <div style="font-size:12px;color:#365314;font-weight:700;text-transform:uppercase">${esc(copy.vsYesterday)}</div>
      <div style="margin-top:8px;font-size:22px;font-weight:700;color:#1e293b">${esc(deltaYestFmt)}</div>
    </div>
    <div style="padding:18px;border-radius:18px;background:${delta7 !== null && delta7 < 0 ? '#ecfccb' : '#fef3c7'};border:1px solid ${delta7 !== null && delta7 < 0 ? '#bef264' : '#fde68a'}">
      <div style="font-size:12px;color:#365314;font-weight:700;text-transform:uppercase">${esc(copy.vs7d)}</div>
      <div style="margin-top:8px;font-size:22px;font-weight:700;color:#1e293b">${esc(delta7Fmt)}</div>
    </div>
  </section>
  <section style="margin:0 0 24px">
    <p style="margin:0 0 14px;color:#334155;line-height:1.7;max-width:860px">${esc(paragraph)}</p>
  </section>
  <section style="margin:0 0 24px" aria-labelledby="top3">
    <h2 id="top3" style="margin:0 0 12px;font-size:22px;color:#0f172a">${esc(copy.top3Label)}</h2>
    ${stationsHtml}
  </section>
  <section style="margin:0 0 24px" aria-labelledby="trend7">
    <h2 id="trend7" style="margin:0 0 12px;font-size:22px;color:#0f172a">${esc(copy.trendLabel)}</h2>
    <p style="margin:0 0 12px;color:#475569;line-height:1.6">${esc(historyCopy)}</p>
    ${trendHtml}
  </section>
  ${faqHtml}
  ${generateRelatedLinksBlock(locale, 'fuel_daily', { fuelType: fuel, fuelZone: zone ?? undefined, city: zone ?? undefined })}
</main>`;

  // Word count sanity check (hard-gated later by the caller)
  const html = `<!doctype html>
<html lang="${locale}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    ${FAVICON_LINKS}
    <title>${esc(title)}</title>
    <meta name="description" content="${esc(description)}">
    <meta name="robots" content="index,follow">
    <meta property="og:type" content="website">
    <meta property="og:site_name" content="Frontaliere Ticino">
    <meta property="og:locale" content="${LOCALE_OG[locale]}">
    <meta property="og:title" content="${esc(title)}">
    <meta property="og:description" content="${esc(description)}">
    <meta property="og:url" content="${canonicalUrl}">
    <meta property="og:image" content="${BASE_URL}/og-image.png">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${esc(title)}">
    <meta name="twitter:description" content="${esc(description)}">
    <meta name="twitter:site" content="@frontaliereticino">
    <link rel="canonical" href="${canonicalUrl}">
${alternatesHtml}
    <script type="application/ld+json">${breadcrumbLd}</script>
    <script type="application/ld+json">${webPageLd}</script>
    <script type="application/ld+json">${faqLd}</script>${productLd ? `\n    <script type="application/ld+json">${productLd}</script>` : ''}
    ${ANALYTICS_SNIPPET}
  </head>
  <body>
    <div id="root">
${bodyHtml}
    </div>
  </body>
</html>`;

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
}

function renderArchive(inp: ArchiveInputs): string {
  const { locale, fuel, zone, monthKey, snapshots, canonicalPath, today } = inp;
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

  const tableHtml = `<table style="width:100%;border-collapse:collapse;font-size:14px">
    <thead><tr>
      <th style="text-align:left;padding:8px;border-bottom:1px solid #e2e8f0;color:#475569;font-weight:700">${esc(locale === 'it' ? 'Data' : locale === 'de' ? 'Datum' : 'Date')}</th>
      <th style="text-align:right;padding:8px;border-bottom:1px solid #e2e8f0;color:#475569;font-weight:700">${esc(copy.avgLabel)}</th>
    </tr></thead>
    <tbody>${rows.map((r) => `<tr>
      <td style="padding:8px;border-bottom:1px solid #f1f5f9;color:#0f172a">${esc(r.date)}</td>
      <td style="padding:8px;border-bottom:1px solid #f1f5f9;color:#0f172a;text-align:right;font-variant-numeric:tabular-nums">${r.price === null ? '—' : formatPrice(r.price, locale) + ' CHF'}</td>
    </tr>`).join('')}</tbody>
  </table>`;

  const dateStamp = today.toISOString().slice(0, 10);
  const title = `${h1} | Frontaliere Ticino`;
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

  return `<!doctype html>
<html lang="${locale}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    ${FAVICON_LINKS}
    <title>${esc(title)}</title>
    <meta name="description" content="${esc(description)}">
    <meta name="robots" content="index,follow">
    <link rel="canonical" href="${canonicalUrl}">
    <script type="application/ld+json">${breadcrumbLd}</script>
    <script type="application/ld+json">${webPageLd}</script>
    ${ANALYTICS_SNIPPET}
  </head>
  <body>
    <div id="root">
      <main style="max-width:1100px;margin:0 auto;padding:32px 20px 56px;color:#0f172a;font-family:system-ui,-apple-system,sans-serif">
        <nav style="margin:0 0 14px;font-size:13px;color:#475569">
          <a href="${BASE_URL}/" style="color:#1d4ed8;text-decoration:none">${esc(copy.breadcrumbHome)}</a>
          <span> / </span>
          <a href="${BASE_URL}${buildFuelTodayPath(locale, fuel, zone)}" style="color:#1d4ed8;text-decoration:none">${esc(zoneLabel)}</a>
          <span> / </span>
          <span>${esc(monthKey)}</span>
        </nav>
        <header style="margin-bottom:22px">
          <p style="margin:0 0 6px;color:#4f46e5;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.04em">${esc(copy.archiveLabel)} · ${esc(monthKey)}</p>
          <h1 style="margin:0 0 12px;font-size:clamp(1.8rem,4.5vw,2.5rem);line-height:1.1">${esc(h1)}</h1>
          <p style="margin:0;font-size:17px;line-height:1.55;max-width:860px">${esc(intro)}</p>
        </header>
        <section>${tableHtml}</section>
      </main>
    </div>
  </body>
</html>`;
}

// ── Plugin ─────────────────────────────────────────────────────

interface PluginResult {
  pagesWritten: number;
  archivesWritten: number;
  skippedForWordCount: number;
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
}): Record<string, string> {
  const dataset = opts.dataset;
  const history = opts.history ?? [];
  const today = opts.today ?? new Date();

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
}): Record<string, string> {
  const history = opts.history;
  const today = opts.today ?? new Date();
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

      const pages = generateFuelDailyPages({ rootDir, dataset, history, today });
      const archives = generateFuelArchivePages({ history, today });

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

      await collector.flush();

      // ── Emit sitemap-fuel-daily.xml ─────────────────────────────
      // The sitemapAliasPlugin auto-discovers every `sitemap-*.xml` in dist/
      // and weaves it into the master sitemap index, so no manual patching
      // of `dist/sitemap.xml` is needed here.
      if (sitemapPaths.length > 0) {
        try {
          const dateStamp = today.toISOString().slice(0, 10);
          const urlEntries = sitemapPaths
            .map((p) => {
              return `  <url>\n    <loc>${BASE_URL}${p}</loc>\n    <lastmod>${dateStamp}</lastmod>\n    <changefreq>daily</changefreq>\n    <priority>0.7</priority>\n  </url>`;
            })
            .join('\n');
          const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urlEntries}
</urlset>
`;
          fs.writeFileSync(np.join(distDir, 'sitemap-fuel-daily.xml'), sitemapXml, 'utf-8');
          console.log(
            `\x1b[36m[fuel-daily-pages]\x1b[0m Wrote sitemap-fuel-daily.xml (${sitemapPaths.length} URLs)`,
          );
        } catch (err) {
          console.warn('[fuel-daily-pages] failed to write sitemap-fuel-daily.xml', err);
        }
      }

      const result: PluginResult = { pagesWritten, archivesWritten, skippedForWordCount: skipped };
      console.log(
        `\x1b[36m[fuel-daily-pages]\x1b[0m Generated ${result.pagesWritten} daily pages + ${result.archivesWritten} archives (skipped ${result.skippedForWordCount})`,
      );
    },
  };
}
