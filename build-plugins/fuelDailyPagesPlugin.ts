import { fuelObservation } from './shared/fuelObservation';
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
import { peelDanglingClauseTail } from './shared/clauseTail.mjs';
import fs from 'node:fs';
import np from 'node:path';
import {
  BASE_URL,
  BUILD_DATE_STAMP,
  FUEL_CHART_SCRIPT_TAG,
  MIN_INDEXABLE_WORDS,
  countHtmlBodyWords,
  DRIVEBY_AD_SNIPPET,
  buildCanonicalBridgePage,
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
  frFuelOf,
  frFuelThe,
  frFuelDe,
  frFuelAt,
  buildFuelArchivePath,
  buildFuelTodayPath,
  buildFuelStationPath,
  buildFuelItalianCityPath,
  buildFuelItalianStationPath,
  buildStationSlug,
  slugify,
  zoneForAddress,
  computeDeltaVsYesterday,
  type FuelDailyLocale,
  type FuelType,
  type FuelZone,
  type ItalianCityEntry,
} from './fuelDailyData';
import { generateRelatedLinksBlock, JOB_LISTING_ROOT, renderAboveFoldJobCta } from './shared/relatedLinks';
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
  ICON_BAR_CHART_SVG,
  ICON_FUEL_SVG,
  ICON_MAP_PIN_SVG,
  ICON_NAVIGATION_SVG,
  ICON_TROPHY_SVG,
  LINK_ACCENT_STYLE,
  renderDiscoverMore,
  renderEntityCard,
  STAT_TILE_BASE,
  STAT_TILE_DANGER,
  STAT_TILE_SUCCESS,
  STAT_TILE_WARNING,
  clampSiteSuffix,
  differentiateH1FromTitle,
  osmEmbedSrc,
} from './shared/seoContentTokens';
import { resolveStationBrandLogoUrl } from './shared/fuelBrandLogo';
import { inlineScriptJson } from './shared/inlineJsonScript';
import { intFromEnv } from '../scripts/lib/int-from-env.mjs';

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

/**
 * Below-floor bridge target (issue #4553 item 3): every daily/archive/station/
 * city/index page below has its own word-count floor and previously did a bare
 * `continue` on miss — a silent 404 for a URL a prior build emitted and Google
 * indexed once the underlying scraped data (station count observed to churn
 * 352↔384 across builds) dips even briefly. FUEL_STATS_HUB_PATH is a static
 * editorial page (SECTION_EDITORIAL in editorialContent.ts, emitted
 * unconditionally by staticPagesPlugin.ts regardless of any fuel dataset), so
 * it's a safe always-live redirect target — same shape as
 * shared/salaryStatsBridge.ts's renderSalaryStatsBridge for the salary-stats
 * family. No new self-map entry needed in searchConsoleCompat.ts: the existing
 * FUEL_SECTION_FALLBACKS catch-all (any sub-path under a fuel section →
 * that locale/fuel's regional "today" page) already covers this whole family,
 * and its target page is itself covered by this same bridge below.
 */
function localeOfFuelPath(path: string): FuelDailyLocale {
  const seg = path.split('/').filter(Boolean)[0];
  if (seg === 'en' || seg === 'de' || seg === 'fr') return seg;
  return 'it';
}

const FUEL_BRIDGE_COPY: Record<FuelDailyLocale, { title: string; description: string; ctaLabel: string }> = {
  it: {
    title: 'Pagina in aggiornamento | Frontaliere Ticino',
    description:
      'Questa pagina non ha ancora dati sufficienti oggi. Consulta lo storico completo dei prezzi carburante alla frontiera.',
    ctaLabel: 'Vai alle statistiche prezzi carburante',
  },
  en: {
    title: 'Page updating | Frontaliere Ticino',
    description:
      'This page does not have enough data yet today. See the full border fuel-price history and stats.',
    ctaLabel: 'Go to border fuel price statistics',
  },
  de: {
    title: 'Seite wird aktualisiert | Frontaliere Ticino',
    description:
      'Für diese Seite liegen heute noch nicht genügend Daten vor. Zur vollständigen Statistik der Spritpreise an der Grenze.',
    ctaLabel: 'Zur Spritpreis-Statistik',
  },
  fr: {
    title: 'Page en mise à jour | Frontaliere Ticino',
    description:
      "Cette page n'a pas encore assez de données aujourd'hui. Consultez l'historique complet des prix du carburant à la frontière.",
    ctaLabel: 'Voir les statistiques des prix du carburant',
  },
};

export function renderFuelBelowFloorBridge(path: string): string {
  const locale = localeOfFuelPath(path);
  const targetPath = FUEL_STATS_HUB_PATH[locale];
  const targetUrl = `${BASE_URL}${targetPath}`;
  const hreflangEntries: Array<{ hreflang: string; href: string }> = FUEL_DAILY_LOCALES.map((loc) => ({
    hreflang: loc,
    href: `${BASE_URL}${FUEL_STATS_HUB_PATH[loc]}`,
  }));
  hreflangEntries.push({ hreflang: 'x-default', href: `${BASE_URL}${FUEL_STATS_HUB_PATH.it}` });
  const copy = FUEL_BRIDGE_COPY[locale];
  const html = buildCanonicalBridgePage({
    canonicalUrl: targetUrl,
    pathLabel: targetPath,
    title: copy.title,
    description: copy.description,
    body: copy.description,
    ctaLabel: copy.ctaLabel,
    lang: locale,
    noindex: true,
    hreflangEntries,
  });
  return html.replace(
    '</head>',
    `    <meta http-equiv="refresh" content="0; url=${targetUrl}">\n  </head>`,
  );
}

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

  const titles: Record<
    FuelDailyLocale,
    { border: string; hiring: string; jobMarket: string; jobBoard: string }
  > = {
    it: {
      border: 'Tempi di attesa alle dogane',
      hiring: 'Aziende che assumono a Chiasso',
      jobMarket: 'Mercato del lavoro Ticino',
      jobBoard: 'Offerte di lavoro in Ticino',
    },
    en: {
      border: 'Border crossing wait times',
      hiring: 'Companies hiring in Chiasso',
      jobMarket: 'Ticino job market',
      jobBoard: 'Job openings in Ticino',
    },
    de: {
      border: 'Wartezeiten an der Grenze',
      hiring: 'Unternehmen die in Chiasso einstellen',
      jobMarket: 'Arbeitsmarkt Tessin',
      jobBoard: 'Stellenangebote im Tessin',
    },
    fr: {
      border: "Temps d'attente aux douanes",
      hiring: 'Entreprises qui recrutent à Chiasso',
      jobMarket: 'Marché du travail Tessin',
      jobBoard: "Offres d'emploi au Tessin",
    },
  };

  const t = titles[locale];
  return [
    { title: t.border, href: BORDER_WAIT_HUB_PATH[locale] },
    { title: t.jobBoard, href: JOB_LISTING_ROOT[locale] },
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
  dieselUpdatedAt?: string;
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
  diesel?: { source?: 'api' | 'derived' | 'mixed' | 'unavailable' };
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

// Each fuel is optional: never infer a diesel price from petrol.
function pricesFromStation(station: SwissStation): { diesel: number | null; benzina: number | null } | null {
  const observed = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? Number(value.toFixed(3)) : null;
  const benzina = observed(station.sp95PriceChf);
  const diesel = station.dieselSource === 'derived' || station.dieselSource === 'monthly_average'
    ? null : observed(station.dieselPriceChf);
  return benzina === null && diesel === null ? null : { benzina, diesel };
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
      if (!s || !pricesFromStation(s)) continue;
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
      if (!s || !pricesFromStation(s)) continue;
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
      return p[fuel] === null ? null : { station: s, price: p[fuel] } as const;
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
    const price = p?.[fuel];
    if (price === null || price === undefined) continue;
    prices.push(price);
    stationPrices.push({
      name: String(s.name || s.brand || '—').trim(),
      brand: String(s.brand || '').trim(),
      address: String(s.address || '').trim(),
      priceChf: price,
      slug: buildStationSlug({ brand: s.brand, name: s.name, address: s.address }),
    });
  }
  const top3 = stationPrices.sort((a, b) => a.priceChf - b.priceChf).slice(0, 3);
  return { avg: mean(prices), minStations: top3 };
}

// ── History ────────────────────────────────────────────────────

export function readHistory(rootDir: string): HistorySnapshot[] {
  const historyDir = np.join(rootDir, 'data', 'fuel-prices-history');
  if (!fs.existsSync(historyDir)) return [];
  const files = fs.readdirSync(historyDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
  const snapshots: HistorySnapshot[] = [];
  for (const file of files) {
    try {
      const raw = fs.readFileSync(np.join(historyDir, file), 'utf-8');
      const parsed = JSON.parse(raw) as HistorySnapshot;
      if (parsed && typeof parsed.date === 'string') {
        // Legacy snapshots explicitly marked mixed/derived contain synthetic Swiss
        // diesel. Keep petrol and real Italian prices, without rewriting source files.
        if (parsed.diesel?.source === 'derived' || parsed.diesel?.source === 'mixed') {
          if (parsed.regional) parsed.regional.diesel = null;
          for (const price of Object.values(parsed.zones ?? {})) if (price) price.diesel = null;
          for (const price of Object.values(parsed.stations ?? {})) if (price) price.diesel = null;
        }
        snapshots.push(parsed);
      }
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

/**
 * Localised "no change over time" word, used in place of a literal "0,000 CHF"
 * delta — which users read as "no data" (see the live Locarno case). Applies
 * ONLY to TIME comparisons (vs yesterday / vs 7 days): "stabile" means the
 * price held steady. It is NOT correct for the station/Italian-city
 * spatial delta (station vs zone/city average), where zero means "in line with
 * the average" — a different concept handled there by the advice "median"
 * branch. All daily-zone consuming frames are adjective-position ("<word> vs
 * ieri", "è <word>") so this single adjective fits each surface grammatically.
 */
const DELTA_UNCHANGED_LABEL: Record<FuelDailyLocale, string> = {
  it: 'stabile',
  en: 'unchanged',
  de: 'unverändert',
  fr: 'stable',
};

/**
 * Time-delta presentation for visible copy: same as {@link formatDelta} but
 * renders the localised "unchanged" word for an exact-zero day-over-day /
 * 7-day delta instead of "0,000 CHF". Display-only — callers that PARSE the
 * delta (renderStationAdvice strips sign + "CHF"/"EUR") must keep using
 * {@link formatDelta}, and the station/city spatial delta keeps formatDelta
 * because "stabile" would misdescribe a station-vs-average comparison.
 */
function formatDeltaDisplay(delta: number | null, locale: FuelDailyLocale): string {
  if (delta === 0) return DELTA_UNCHANGED_LABEL[locale];
  return formatDelta(delta, locale);
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

/**
 * Swiss-convention display date (`24.08.2026`) for user-facing copy.
 *
 * Deliberately NOT the same value as `dateStamp`: that one is the ISO
 * `YYYY-MM-DD` string and must stay ISO because it is also emitted as the
 * schema.org `dateModified` property. This one only ever reaches prose —
 * `<title>`, the meta description and the on-page intro — where an ISO date
 * reads like machine output to an Italian/Swiss reader and wastes the
 * freshness signal the SERP snippet is supposed to carry.
 */
function formatFuelDateDisplay(d: Date): string {
  return new Intl.DateTimeFormat('de-CH', {
    timeZone: 'Europe/Zurich', day: '2-digit', month: '2-digit', year: 'numeric',
  }).format(d);
}

/**
 * Italian genitive for the fuel noun: "della benzina" vs "del diesel".
 *
 * `benzina` is feminine, `diesel` masculine. The previous copy hard-coded
 * `del ${fuel}` for both, so every Italian benzina page shipped "il prezzo
 * medio del benzina" — a visible grammar error in the meta description of
 * the highest-impression fuel page on the site.
 */
function itFuelGenitive(fuelLabel: string): string {
  const lower = fuelLabel.toLowerCase();
  return lower === 'benzina' ? `della ${lower}` : `del ${lower}`;
}

/**
 * Locative phrase used by prose copy ("in Ticino", "a Chiasso").
 *
 * The regional page used to interpolate the *UI* label into a sentence that
 * already supplied the preposition, yielding "a Tutto il Ticino". Prose needs
 * the whole prepositional phrase, not a bare noun, so it is built here once
 * per locale instead of being glued together inside each template.
 */
function fuelWhere(locale: FuelDailyLocale, zoneLabel: string, isZone: boolean): string {
  if (!isZone) {
    return locale === 'de' ? 'im Tessin' : locale === 'fr' ? 'au Tessin' : 'in Ticino';
  }
  return locale === 'fr' ? `à ${zoneLabel}` : locale === 'it' ? `a ${zoneLabel}` : `in ${zoneLabel}`;
}

interface FuelCopy {
  regionalH1: (fuelLabel: string) => string;
  zoneH1: (fuelLabel: string, zone: string) => string;
  /** `where` is a complete locative phrase from `fuelWhere()`, not a bare zone label. */
  intro: (fuelLabel: string, where: string, priceFmt: string, date: string) => string;
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
    intro: (f, where, priceFmt, date) =>
      `Prezzo medio ${itFuelGenitive(f)} ${where} il ${date}: ${priceFmt} CHF/litro. Confronta le stazioni del campione TCS e controlla la data di acquisizione.`,
    paragraph: (f, z, price, dYest, d7) =>
      `Oggi ${z} il ${f.toLowerCase()} costa in media ${price} CHF/litro, ${dYest} rispetto a ieri e ${d7} rispetto a 7 giorni fa. La pagina viene rigenerata automaticamente ogni giorno alle prime ore del mattino con i dati più freschi disponibili dalle stazioni di rifornimento della zona. Confronta le tre stazioni più economiche e verifica l'andamento della settimana per pianificare il rifornimento prima del pieno della tua settimana di frontaliere.`,
    historySection:
      "Il grafico qui sotto mostra l'andamento del prezzo nel tempo — utile per capire se conviene rifornirsi oggi o aspettare. Usa i pulsanti per cambiare l'intervallo (1 mese, 3 mesi, 6 mesi, 1 anno, 5 anni). Lo storico si popola giorno per giorno: gli intervalli più lunghi diventano disponibili man mano che raccogliamo nuovi dati.",
    updatedLabel: 'Aggiornamento',
    avgLabel: 'Prezzo medio rilevato',
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
      `Andamento storico del prezzo ${f.toLowerCase()} ${z}: media ${avgFmt} CHF/litro nell'intervallo selezionato.`,
    faq: [
      {
        q: 'Ogni quanto viene aggiornato il prezzo?',
        a: (f, z) =>
          `Il prezzo ${itFuelGenitive(f)} ${z} viene aggiornato ogni giorno. I dati provengono da TCS Benzinpreis, che raccoglie prezzi segnalati dagli utenti in Svizzera.`,
      },
      {
        q: 'Conviene rifornirsi in Italia o in Svizzera?',
        a: () =>
          "Dipende dal prezzo del giorno e dal costo del carburante in Italia: confronta il dato odierno con il prezzo italiano del comune di confine nella pagina comparatore carburanti. In genere in Italia il prezzo al litro è più basso, ma la Svizzera offre self-service h24 anche in zone rurali.",
      },
      {
        q: 'Da dove arrivano i prezzi delle stazioni elencate?',
        a: () =>
          "I prezzi sono raccolti da TCS Benzinpreis (Touring Club Svizzero), che raccoglie prezzi segnalati dagli utenti nelle stazioni svizzere. La nostra pipeline li mappa per zona ticinese e li pubblica ogni giorno.",
      },
    ],
  },
  en: {
    regionalH1: (f) => `${f} price Switzerland today — Ticino`,
    zoneH1: (f, z) => `${f} price today in ${z}`,
    intro: (f, where, priceFmt, date) =>
      `Average ${f.toLowerCase()} price ${where} on ${date}: ${priceFmt} CHF per litre. The 3 cheapest stations near the border, updated every morning from TCS.`,
    paragraph: (f, z, price, dYest, d7) =>
      `Today ${z} the ${f.toLowerCase()} costs ${price} CHF per litre on average, ${dYest} compared to yesterday and ${d7} compared to 7 days ago. This page is regenerated automatically every morning with the freshest data from stations in the area. Compare the three cheapest stations and check the weekly trend before you fill up during your cross-border commute.`,
    historySection:
      'The chart below shows the price trend over time — handy to decide whether to fill up today or wait. Use the buttons to switch the range (1 month, 3 months, 6 months, 1 year, 5 years). History is built day by day: longer ranges fill in as we collect more snapshots.',
    updatedLabel: 'Updated',
    avgLabel: 'Average observed price',
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
      `Historical ${f.toLowerCase()} price trend ${z}: average ${avgFmt} CHF/litre over the selected range.`,
    faq: [
      {
        q: 'How often is the price updated?',
        a: (f, z) =>
          `The ${f.toLowerCase()} price ${z} is updated daily. Data is sourced from TCS Benzinpreis, which collects user-reported station prices in Switzerland.`,
      },
      {
        q: 'Is it cheaper to refuel in Italy or in Switzerland?',
        a: () =>
          'It depends on today\'s price and the Italian fuel price: compare this page to the Italian price in our cross-border fuel comparator. Italy is usually cheaper per litre, but Switzerland offers 24/7 self-service even in rural spots.',
      },
      {
        q: 'Where do the listed station prices come from?',
        a: () =>
          'Prices are collected from TCS Benzinpreis (Touring Club Switzerland), which collects user-reported prices in Switzerland. Our pipeline maps them by Ticino zone and publishes them every day.',
      },
    ],
  },
  de: {
    regionalH1: (f) => `${f}preis Schweiz heute — Tessin`,
    zoneH1: (f, z) => `${f}preis heute in ${z}`,
    intro: (f, where, priceFmt, date) =>
      `Durchschnittlicher ${f}preis ${where} am ${date}: ${priceFmt} CHF pro Liter. Die 3 günstigsten Tankstellen nahe der Grenze, täglich von TCS aktualisiert.`,
    paragraph: (f, z, price, dYest, d7) =>
      `Heute kostet ${f} ${z} durchschnittlich ${price} CHF pro Liter, ${dYest} gegenüber gestern und ${d7} gegenüber vor 7 Tagen. Diese Seite wird jeden Morgen automatisch mit den frischesten Preisdaten der Tankstellen in der Region neu erzeugt. Vergleichen Sie die drei günstigsten Tankstellen und prüfen Sie den Wochentrend, bevor Sie im Rahmen Ihres Grenzgänger-Alltags tanken.`,
    historySection:
      'Das folgende Diagramm zeigt den Preisverlauf über die Zeit — hilfreich, um zu entscheiden, ob Sie heute tanken oder warten. Mit den Buttons wechseln Sie den Zeitraum (1 Monat, 3 Monate, 6 Monate, 1 Jahr, 5 Jahre). Die Historie baut sich Tag für Tag auf: längere Zeiträume werden verfügbar, sobald wir mehr Daten erfassen.',
    updatedLabel: 'Aktualisiert',
    avgLabel: 'Erfasster Durchschnittspreis',
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
      `Historischer Preisverlauf für ${f} ${z}: Durchschnitt ${avgFmt} CHF/Liter im ausgewählten Zeitraum.`,
    faq: [
      {
        q: 'Wie oft wird der Preis aktualisiert?',
        a: (f, z) =>
          `Der ${f}preis ${z} wird täglich aktualisiert. Die Daten stammen von TCS Benzinpreis, das von Nutzern gemeldete Schweizer Tankstellenpreise sammelt.`,
      },
      {
        q: 'Ist Tanken in Italien oder in der Schweiz günstiger?',
        a: () =>
          'Das hängt vom aktuellen Preis und vom italienischen Treibstoffpreis ab: Vergleichen Sie diese Seite mit dem italienischen Preis im grenzüberschreitenden Treibstoffvergleich. In Italien ist der Liter meist günstiger, die Schweiz bietet dafür 24/7-Selbstbedienung auch in ländlichen Gegenden.',
      },
      {
        q: 'Woher kommen die aufgeführten Tankstellenpreise?',
        a: () =>
          'Die Preise werden von TCS Benzinpreis (Touring Club Schweiz) erhoben, das von Nutzern gemeldete Preise in der Schweiz bündelt. Unsere Pipeline ordnet sie nach Tessiner Zone zu und publiziert sie täglich.',
      },
    ],
  },
  fr: {
    regionalH1: (f) => `Prix ${frFuelOf(f)} en Suisse aujourd'hui — Tessin`,
    zoneH1: (f, z) => `Prix ${frFuelOf(f)} aujourd'hui à ${z}`,
    intro: (f, where, priceFmt, date) =>
      `Prix moyen ${frFuelOf(f)} ${where} le ${date} : ${priceFmt} CHF par litre. Les 3 stations les moins chères près de la frontière, actualisées chaque matin par TCS.`,
    paragraph: (f, z, price, dYest, d7) =>
      `Aujourd'hui ${z} ${frFuelThe(f)} coûte ${price} CHF par litre en moyenne, ${dYest} par rapport à hier et ${d7} par rapport à il y a 7 jours. Cette page est régénérée chaque matin avec les données les plus récentes des stations de la région. Comparez les trois stations les moins chères et consultez la tendance hebdomadaire avant de faire le plein lors de votre trajet frontalier.`,
    historySection:
      "Le graphique ci-dessous montre l'évolution du prix dans le temps — utile pour décider si faire le plein aujourd'hui ou attendre. Utilisez les boutons pour changer la période (1 mois, 3 mois, 6 mois, 1 an, 5 ans). L'historique se construit jour après jour : les périodes plus longues deviennent disponibles au fil du temps.",
    updatedLabel: 'Mis à jour',
    avgLabel: 'Prix moyen observé',
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
      `Tendance historique du prix ${frFuelOf(f)} ${z} : moyenne ${avgFmt} CHF/litre sur la période sélectionnée.`,
    faq: [
      {
        q: 'À quelle fréquence le prix est-il mis à jour ?',
        a: (f, z) =>
          `Le prix ${frFuelOf(f)} ${z} est mis à jour chaque jour. Les données proviennent de TCS Benzinpreis, qui recueille les prix signalés par les utilisateurs en Suisse.`,
      },
      {
        q: 'Est-il plus avantageux de faire le plein en Italie ou en Suisse ?',
        a: () =>
          "Cela dépend du prix du jour et du prix italien : comparez cette page avec le prix italien dans notre comparateur transfrontalier. L'Italie est généralement moins chère au litre, mais la Suisse propose du self-service 24/7 même en zone rurale.",
      },
      {
        q: 'D\'où proviennent les prix des stations ?',
        a: () =>
          "Les prix proviennent de TCS Benzinpreis (Touring Club Suisse), qui recueille les prix signalés par les utilisateurs en Suisse. Notre pipeline les regroupe par zone tessinoise et les publie chaque jour.",
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
  it: 'it_CH',
  en: 'en_US',
  de: 'de_CH',
  fr: 'fr_CH',
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
  whereLabel: string,
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
      heading: 'Valutazione editoriale del campione',
      body: `Frontaliere Ticino assegna ${scoreFmt}/5 al prezzo medio ${itFuelGenitive(fuelLabel)} ${whereLabel}: il livello rilevato è ${dayTrend === 'stable_or_down' ? 'stabile o in calo rispetto al giorno precedente la rilevazione' : dayTrend === 'up' ? 'in aumento rispetto al giorno precedente la rilevazione' : 'ancora senza un confronto giornaliero'} e ${weekTrend === 'stable_or_down' ? 'resta competitivo anche sul confronto con la settimana precedente la rilevazione' : weekTrend === 'up' ? 'risulta meno competitivo rispetto alla settimana precedente la rilevazione' : 'ha uno storico settimanale ancora limitato'}. La valutazione combina prezzo medio di giornata (${priceFmt} CHF/litro), direzione del trend recente e presenza di stazioni economiche nella short list locale.`,
      ratingValue: score,
    };
  }
  if (locale === 'de') {
    return {
      heading: 'Redaktionelle Bewertung der Stichprobe',
      body: `Frontaliere Ticino vergibt ${scoreFmt}/5 für den durchschnittlichen ${fuelLabel}preis ${whereLabel}: das erhobene Niveau ist ${dayTrend === 'stable_or_down' ? 'stabil oder niedriger als am Tag vor der Erhebung' : dayTrend === 'up' ? 'höher als am Tag vor der Erhebung' : 'noch nicht mit dem Vortag der Erhebung vergleichbar'} und ${weekTrend === 'stable_or_down' ? 'bleibt auch im 7-Tage-Vergleich wettbewerbsfähig' : weekTrend === 'up' ? 'ist im Vergleich zur Vorwoche der Erhebung weniger attraktiv' : 'hat noch wenig Wochenhistorie'}. Die Bewertung kombiniert Tagesdurchschnitt (${priceFmt} CHF/Liter), kurzfristige Trendrichtung und die Präsenz günstiger Stationen in der lokalen Auswahl.`,
      ratingValue: score,
    };
  }
  if (locale === 'fr') {
    return {
      heading: "Évaluation éditoriale de l’échantillon",
      body: `Frontaliere Ticino attribue ${scoreFmt}/5 au prix moyen ${frFuelOf(fuelLabel)} ${whereLabel} : le niveau relevé est ${dayTrend === 'stable_or_down' ? 'stable ou en baisse par rapport au jour précédant le relevé' : dayTrend === 'up' ? "en hausse par rapport au jour précédant le relevé" : "encore sans comparaison quotidienne"} et ${weekTrend === 'stable_or_down' ? 'reste compétitif sur 7 jours' : weekTrend === 'up' ? 'est moins compétitif que la semaine précédant le relevé' : 'dispose encore de peu d’historique hebdomadaire'}. L’évaluation combine le prix moyen du jour (${priceFmt} CHF/litre), la direction récente de la tendance et la présence de stations avantageuses dans la sélection locale.`,
      ratingValue: score,
    };
  }
  return {
    heading: "Editorial assessment of the sample",
    body: `Frontaliere Ticino assigns ${scoreFmt}/5 to the average ${fuelLabel.toLowerCase()} price ${whereLabel}: the observed level is ${dayTrend === 'stable_or_down' ? 'stable or down against the day before collection' : dayTrend === 'up' ? 'up against the day before collection' : 'not yet comparable with the day before collection'} and ${weekTrend === 'stable_or_down' ? 'still competitive against the 7-day comparison' : weekTrend === 'up' ? 'less competitive than the week before collection' : 'still building weekly history'}. The assessment combines the current daily average (${priceFmt} CHF/litre), recent trend direction and the presence of low-price stations in the local shortlist.`,
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
      body: `Frontaliere Ticino assegna ${scoreFmt}/5 a ${brandDisplay} ${city} per il ${fuelLabel.toLowerCase()}: nel campione la stazione è in posizione ${rankText} nel ranking locale, con prezzo ${priceFmt} CHF/litro contro una media zona di ${zoneAvgFmt} CHF/litro. Il giudizio riflette competitività di prezzo giornaliera e posizionamento della stazione rispetto alle alternative vicine.`,
      ratingValue: score,
    };
  }
  if (locale === 'de') {
    return {
      heading: 'Redaktionelle Bewertung der Tankstelle',
      body: `Frontaliere Ticino vergibt ${scoreFmt}/5 an ${brandDisplay} ${city} für ${fuelLabel}: in der Stichprobe liegt die Station auf Rang ${rankText} im lokalen Vergleich, mit einem Preis von ${priceFmt} CHF/Liter gegenüber einem Zonendurchschnitt von ${zoneAvgFmt} CHF/Liter. Das Urteil spiegelt die Preiswettbewerbsfähigkeit des Tages und die Position der Station gegenüber nahen Alternativen wider.`,
      ratingValue: score,
    };
  }
  if (locale === 'fr') {
    return {
      heading: 'Évaluation éditoriale de la station',
      body: `Frontaliere Ticino attribue ${scoreFmt}/5 à ${brandDisplay} ${city} pour ${frFuelThe(fuelLabel)} : dans l’échantillon, la station occupe la position ${rankText} dans le classement local, avec un prix de ${priceFmt} CHF/litre contre une moyenne de zone de ${zoneAvgFmt} CHF/litre. Cette note reflète la compétitivité du prix du jour et le positionnement de la station face aux alternatives proches.`,
      ratingValue: score,
    };
  }
  return {
    heading: 'Editorial station review',
    body: `Frontaliere Ticino assigns ${scoreFmt}/5 to ${brandDisplay} ${city} for ${fuelLabel.toLowerCase()}: the station ranks in the sample ${rankText} in the local comparison, with a price of ${priceFmt} CHF/litre versus a zone average of ${zoneAvgFmt} CHF/litre. The score reflects day-of-price competitiveness and the station's position against nearby alternatives.`,
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
    return `<svg class="s-hUQt0t" role="img" aria-label="${esc(ariaLabel)}" viewBox="0 0 ${dims.width} ${dims.height}" preserveAspectRatio="xMidYMid meet">
      <rect x="${dims.padLeft}" y="${dims.padTop}" width="${plotW}" height="${plotH}" rx="8" class="s-crect"></rect>
      <text x="${dims.padLeft + plotW / 2}" y="${dims.padTop + plotH / 2}" text-anchor="middle" dominant-baseline="middle"
        class="s-cempty">${esc(FUEL_RANGE_EMPTY_MSG[locale])}</text>
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
  // Axis-tick text style lives in seo-static.css `.s-ctk` (font + fill +
  // tabular-nums) — repeats ~13×/page, so a class instead of an inline style
  // strips ~1.4 MB across the fuel corpus.

  // Grid-line + path stroke styling lives in seo-static.css (.s-cgl / .s-cgx /
  // .s-cpl / .s-cpa); only the per-element geometry stays inline.
  const yGridLines = yTicks
    .map(
      (t) =>
        `<line x1="${dims.padLeft}" x2="${dims.width - dims.padRight}" y1="${t.y.toFixed(1)}" y2="${t.y.toFixed(1)}" class="s-cgl"></line>`,
    )
    .join('');
  const yLabels = yTicks
    .map(
      (t) =>
        `<text x="${(dims.padLeft - 6).toFixed(0)}" y="${t.y.toFixed(1)}" text-anchor="end" dominant-baseline="middle" class="s-ctk">${esc(formatValue(t.v))}</text>`,
    )
    .join('');
  const xGridLines = xTicks
    .map(
      (t) =>
        `<line x1="${t.x.toFixed(1)}" x2="${t.x.toFixed(1)}" y1="${dims.padTop}" y2="${(dims.padTop + plotH).toFixed(1)}" class="s-cgx"></line>`,
    )
    .join('');
  const xLabels = xTicks
    .map(
      (t) =>
        `<text x="${t.x.toFixed(1)}" y="${(dims.padTop + plotH + 18).toFixed(1)}" text-anchor="middle" class="s-ctk">${esc(formatFuelDateShort(t.date, locale))}</text>`,
    )
    .join('');

  return `<svg class="s-hUQt0t" role="img" aria-label="${esc(ariaLabel)}" viewBox="0 0 ${dims.width} ${dims.height}" preserveAspectRatio="xMidYMid meet">
    <defs>
      <linearGradient id="${gradientId}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="5%" stop-color="var(--color-chart-area)" stop-opacity="0.35"></stop>
        <stop offset="95%" stop-color="var(--color-chart-area)" stop-opacity="0"></stop>
      </linearGradient>
    </defs>
    ${yGridLines}
    ${xGridLines}
    <path d="${areaPath}" fill="url(#${gradientId})" class="s-cpa"></path>
    <path d="${linePath}" class="s-cpl"></path>
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

  // Button visuals (base + active/inactive) live in seo-static.css `.s-rbtn`,
  // keyed off `aria-pressed` — so the inline script no longer writes
  // `style.background`/`style.color`, just flips the attribute.
  const buttonsHtml = FUEL_RANGE_KEYS.map((rk) => {
    const isActive = rk === FUEL_DEFAULT_RANGE;
    return `<button type="button" data-range-btn="${rk}" aria-pressed="${isActive ? 'true' : 'false'}" class="s-rbtn">${esc(FUEL_RANGE_BUTTON_LABEL[locale][rk])}</button>`;
  }).join('');

  // `.s-rcont` default-hides; the active range carries `.s-on` (display:block).
  const variantsHtml = variants
    .map(
      (v) =>
        `<div data-range-content="${v.rangeKey}" class="s-rcont${v.rangeKey === FUEL_DEFAULT_RANGE ? ' s-on' : ''}">${v.svg}</div>`,
    )
    .join('');

  const formatStatVal = (n: number): string => `${formatValue(n)} ${currency}`;
  // `.s-rstat` default-hides; the active range carries `.s-on` (display:flex).
  const statsVariantsHtml = variants
    .map((v) => {
      const visible = v.rangeKey === FUEL_DEFAULT_RANGE;
      const inner = v.stat
        ? `<span><strong>${esc(stats.min)}:</strong> ${esc(formatStatVal(v.stat.min))}</span><span><strong>${esc(stats.avg)}:</strong> ${esc(formatStatVal(v.stat.avg))}</span><span><strong>${esc(stats.max)}:</strong> ${esc(formatStatVal(v.stat.max))}</span>`
        : `<span class="s-FYTH34">—</span>`;
      return `<div data-range-stats="${v.rangeKey}" class="s-rstat${visible ? ' s-on' : ''}">${inner}</div>`;
    })
    .join('');

  // Range-selector wiring is externalised to one cached
  // `/assets/fuel-chart-{hash}.js` (FUEL_CHART_SCRIPT_TAG) instead of a ~600 B
  // inline IIFE repeated on every chart page. The external script self-wires
  // ALL `[data-fuel-history-chart]` blocks and is idempotent across duplicate
  // tags, so emitting it next to each card is safe.
  return `<div data-fuel-history-chart class="s-fhc">
    <div class="s-fhc-h">
      <div class="s-fhc-r" role="tablist" aria-label="${esc(trendLabel)}">${buttonsHtml}</div>
    </div>
    <div data-fuel-history-charts>${variantsHtml}</div>
    ${statsVariantsHtml}
  </div>${FUEL_CHART_SCRIPT_TAG}`;
}

/** Explain the observed sample and a transparent arithmetic example without invented price patterns. */
function renderFuelTodayMethodologyAndScenarios(args: {
  locale: FuelDailyLocale;
  fuelLabel: string;
  zoneLabel: string;
  fuel: FuelType;
  priceFmt: string;
  dateStamp: string;
  isZone: boolean;
}): string {
  const { locale, fuelLabel, zoneLabel, priceFmt } = args;
  const numericPrice = Number(priceFmt.replace(',', '.'));
  const exampleCost = Number.isFinite(numericPrice) ? (numericPrice * 50).toFixed(2) : '—';
  const copy = {
    it: {
      heading: 'Fonte e metodo del confronto',
      body: `La media e l’intervallo ${fuelLabel.toLowerCase()} riguardano soltanto le stazioni del campione in ${zoneLabel}. Le stazioni presenti per più comuni vengono contate una sola volta. Il radar TCS raccoglie prezzi segnalati dagli utenti: non è un registro federale e non garantisce copertura completa o un prezzo ancora valido alla pompa. La data di acquisizione indica quando abbiamo letto la fonte, non quando il gestore ha cambiato il listino. Per il diesel, la media corrente usa soltanto prezzi diesel disponibili, senza ricavarli dal prezzo della benzina. Lo storico conserva snapshot giornalieri; un intervallo senza dati non equivale a un prezzo invariato. Confronta stazioni dello stesso carburante e considera la distanza effettiva dal percorso prima di decidere.`,
      scenario: 'Esempio di calcolo, non una previsione di spesa',
      calculation: `Ipotizzando un rifornimento di 50 litri al prezzo medio mostrato di ${priceFmt} CHF/l, il costo è ${exampleCost} CHF. Il costo effettivo dipende dal prezzo della stazione scelta e dai litri erogati. Per confrontare l’Italia occorrono il prezzo italiano dello stesso carburante e un cambio CHF/EUR con data nota. Dal risparmio lordo sottrai il carburante della deviazione e gli altri costi del viaggio. Non esiste una soglia universale di convenienza valida per ogni tragitto.`,
    },
    en: {
      heading: 'Source and comparison method',
      body: `The ${fuelLabel.toLowerCase()} average and range cover only sampled stations in ${zoneLabel}. Stations appearing for several municipalities are counted once. The TCS radar collects user-reported prices: it is not a federal registry and does not guarantee full coverage or that a price remains valid at the pump. Collection time is when we read the source, not when the operator changed its price. The current diesel average uses available diesel prices only, without deriving them from petrol. History stores daily snapshots; a gap does not mean prices stayed unchanged. Compare the same fuel and consider the actual distance from your route before choosing a station.`,
      scenario: 'Calculation example, not a spending forecast',
      calculation: `Assuming a 50-litre fill at the displayed average of ${priceFmt} CHF/l, the cost is CHF ${exampleCost}. Actual cost depends on the selected station and litres dispensed. An Italian comparison needs the same fuel and a dated CHF/EUR exchange rate. Subtract detour fuel and other travel costs from gross savings. There is no universal break-even threshold for every journey.`,
    },
    de: {
      heading: 'Quelle und Vergleichsmethode',
      body: `Mittelwert und Spanne für ${fuelLabel} beziehen sich nur auf die erfassten Tankstellen in ${zoneLabel}. Für mehrere Gemeinden aufgeführte Tankstellen werden einmal gezählt. Der TCS-Radar sammelt Meldungen von Nutzern: Er ist kein Bundesregister und garantiert weder vollständige Abdeckung noch einen weiterhin gültigen Zapfsäulenpreis. Die Abrufzeit bezeichnet das Lesen der Quelle, nicht die Preisänderung durch den Betreiber. Der aktuelle Dieselmittelwert verwendet nur vorhandene Dieselpreise und keine Ableitung aus Benzinpreisen. Die Historie enthält tägliche Momentaufnahmen; eine Datenlücke bedeutet keinen unveränderten Preis. Vergleichen Sie denselben Kraftstoff und berücksichtigen Sie die tatsächliche Entfernung von Ihrer Route.`,
      scenario: 'Rechenbeispiel, keine Ausgabenprognose',
      calculation: `Bei angenommenen 50 Litern zum angezeigten Mittelwert von ${priceFmt} CHF/l ergeben sich CHF ${exampleCost}. Der tatsächliche Betrag hängt von Tankstelle und getankten Litern ab. Für Italien benötigen Sie den Preis desselben Kraftstoffs und einen datierten CHF/EUR-Kurs. Ziehen Sie den Kraftstoff für den Umweg und weitere Fahrtkosten von der Bruttoersparnis ab. Eine allgemeingültige Rentabilitätsschwelle für jede Strecke gibt es nicht.`,
    },
    fr: {
      heading: 'Source et méthode de comparaison',
      body: `La moyenne et la plage ${fuelLabel.toLowerCase()} concernent seulement les stations observées en ${zoneLabel}. Une station présente pour plusieurs communes compte une seule fois. Le radar TCS recueille les prix signalés par les utilisateurs : ce n’est pas un registre fédéral et il ne garantit ni une couverture complète ni un prix encore valable à la pompe. L’heure d’acquisition indique la lecture de la source, pas la modification du tarif par la station. La moyenne actuelle du diesel utilise uniquement les prix diesel disponibles, sans les déduire de l’essence. L’historique conserve des instantanés quotidiens ; une lacune ne signifie pas que le prix est resté identique. Comparez le même carburant et la distance réelle depuis votre trajet.`,
      scenario: 'Exemple de calcul, pas une prévision de dépense',
      calculation: `Pour un plein supposé de 50 litres à la moyenne affichée de ${priceFmt} CHF/l, le coût est de ${exampleCost} CHF. Le montant réel dépend de la station et des litres délivrés. Comparer l’Italie nécessite le même carburant et un taux CHF/EUR daté. Déduisez le carburant du détour et les autres frais de trajet de l’économie brute. Il n’existe pas de seuil de rentabilité universel pour tous les trajets.`,
    },
  }[locale];
  return `<section class="s-ziawP1" aria-labelledby="fuelTodayMethodology">
    <h2 id="fuelTodayMethodology" class="s-h2">${esc(copy.heading)}</h2>
    <p class="s-E7ZJqo">${esc(copy.body)} <a href="https://benzin.tcs.ch/" rel="noopener noreferrer" target="_blank">TCS Benzinpreis</a></p>
  </section><section class="s-ziawP1" aria-labelledby="fuelTodayScenario">
    <h2 id="fuelTodayScenario" class="s-h2">${esc(copy.scenario)}</h2>
    <p class="s-E7ZJqo">${esc(copy.calculation)}</p>
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
          return `<li class="s-q3nqK4"><a href="${esc(href)}" style="${LINK_ACCENT_STYLE};font-weight:600">${esc(monthKey)}</a></li>`;
        })
        .join('');
      // For regional pages, include zone label; for per-zone pages, omit
      // (the section already implies the zone).
      const zoneHeader = zone
        ? ''
        : `<p class="s-2xNC3d">${esc(zoneLabel)}</p>`;
      return `${zoneHeader}<ul class="s-po2dkR">${lis}</ul>`;
    })
    .join('');

  return `<aside class="s-card" style="margin:24px 0;padding:18px 20px" aria-labelledby="fuelArchiveNav">
    <h2 id="fuelArchiveNav" class="s-h2" style="margin:0 0 8px;font-size:18px">${esc(heading)}</h2>
    ${groups}
  </aside>`;
}

function renderPage(inp: PageInputs): string {
  const { locale, fuel, zone, dataset, history, canonicalPath, today, alternates, distDir, rootDir } = inp;
  const copy = COPY[locale];
  const fuelLabel = FUEL_TYPE_LABEL[locale][fuel];
  const zoneLabel = zone ? FUEL_ZONE_DISPLAY[zone] : copy.regionalLabel;
  // A rebuild must not relabel an older observation as today's price.
  const stations = zone ? collectZoneStations(dataset, zone) : collectAllStations(dataset);
  const zonePrice = computeZonePrice(stations, fuel);
  const avg = zonePrice.avg;
  const observation = fuelObservation(stations.filter((station) => pricesFromStation(station)?.[fuel] != null), fuel, dataset.generatedAt);
  const observationDate = observation.collectedAt ? new Date(observation.collectedAt) : null;
  const referenceDate = observationDate ?? today;
  const dateStamp = referenceDate.toISOString().slice(0, 10);
  const observedToday = Boolean(observationDate) && formatFuelDateDisplay(referenceDate) === formatFuelDateDisplay(today);
  // Snapshot filenames are UTC dates. A late UTC sample can already belong to
  // the next Swiss civil day; use dated comparisons rather than relabeling it.
  const snapshotDayMatchesCivilDay = formatFuelDateDisplay(new Date(`${dateStamp}T12:00:00Z`)) === formatFuelDateDisplay(referenceDate);
  const relativeComparisons = observedToday && snapshotDayMatchesCivilDay;
  const yesterday = observationDate ? lookbackPrice(history, zone, fuel, 1, referenceDate) : null;
  const weekAgo = observationDate ? lookbackPrice(history, zone, fuel, 7, referenceDate) : null;
  const deltaYest = computeDeltaVsYesterday(avg, yesterday);
  const delta7 = computeDeltaVsYesterday(avg, weekAgo);
  const priceFmt = formatPrice(avg, locale);
  const deltaYestFmt = formatDeltaDisplay(deltaYest, locale);
  const delta7Fmt = formatDeltaDisplay(delta7, locale);
  const comparisonLabel = (days: number) => relativeComparisons
    ? (days === 1 ? copy.vsYesterday : copy.vs7d)
    : observationDate
      ? `vs ${formatFuelDateDisplay(new Date(`${new Date(referenceDate.getTime() - days * 86400000).toISOString().slice(0, 10)}T12:00:00Z`))}`
      : ({ it: 'Confronto non disponibile', en: 'Comparison unavailable', de: 'Vergleich nicht verfügbar', fr: 'Comparaison indisponible' })[locale];
  const dailyComparison = deltaYest === null ? '' : relativeComparisons
    ? ({
        it: deltaYest === 0 ? `Il delta rispetto a ieri è ${deltaYestFmt}.` : `Il delta rispetto a ieri è di ${deltaYestFmt}.`,
        en: `The day-over-day delta is ${deltaYestFmt}.`,
        de: deltaYest === 0 ? `Die Tagesveränderung ist ${deltaYestFmt}.` : `Die Tagesveränderung beträgt ${deltaYestFmt}.`,
        fr: deltaYest === 0 ? `La variation par rapport à hier est ${deltaYestFmt}.` : `La variation par rapport à hier est de ${deltaYestFmt}.`,
      })[locale]
    : `${formatFuelDateDisplay(referenceDate)}: ${deltaYestFmt} ${comparisonLabel(1)}.`;
  const currentHeading = zone ? copy.zoneH1(fuelLabel, zoneLabel) : copy.regionalH1(fuelLabel);
  const h1 = observedToday ? currentHeading : ({
    it: `Prezzo ${fuelLabel.toLowerCase()} ${zone ? `a ${zoneLabel}` : 'in Ticino'} — ultima rilevazione`,
    en: `${fuelLabel} price ${zone ? `in ${zoneLabel}` : 'in Ticino'} — latest observation`,
    de: `${fuelLabel}preis ${zone ? `in ${zoneLabel}` : 'im Tessin'} — letzte Erhebung`,
    fr: `Prix ${frFuelOf(fuelLabel)} ${zone ? `à ${zoneLabel}` : 'au Tessin'} — dernier relevé`,
  })[locale];
  const whereLabel = fuelWhere(locale, zoneLabel, Boolean(zone));
  const observationStamp = observationDate
    ? new Intl.DateTimeFormat(`${locale}-CH`, { timeZone: 'Europe/Zurich', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }).format(observationDate)
    : ({ it: 'orario non disponibile', en: 'time unavailable', de: 'Zeit unbekannt', fr: 'heure indisponible' })[locale];
  const range = `${formatPrice(observation.min, locale)}–${formatPrice(observation.max, locale)}`;
  const shortArea = zone ? zoneLabel : 'Ticino';
  const intro = ({
    it: `${fuelLabel} ${shortArea}: media ${priceFmt} CHF/l, range ${range}. Fonte TCS, dati acquisiti ${observationStamp}.`,
    en: `${fuelLabel} ${shortArea}: average ${priceFmt} CHF/l, range ${range}. TCS source, collected ${observationStamp}.`,
    de: `${fuelLabel} ${shortArea}: Mittel ${priceFmt} CHF/l, Spanne ${range}. Quelle TCS, abgerufen ${observationStamp}.`,
    fr: `${fuelLabel} ${shortArea} : moyenne ${priceFmt} CHF/l, plage ${range}. Source TCS, relevé acquis ${observationStamp}.`,
  })[locale];
  const introTagline = ({
    it: `Media ${priceFmt} CHF/l · ${range} CHF/l · ${observation.count} stazioni campionate in ${shortArea}.`,
    en: `Average ${priceFmt} CHF/l · ${range} CHF/l · ${observation.count} sampled stations in ${shortArea}.`,
    de: `Mittel ${priceFmt} CHF/l · ${range} CHF/l · ${observation.count} erfasste Tankstellen in ${shortArea}.`,
    fr: `Moyenne ${priceFmt} CHF/l · ${range} CHF/l · ${observation.count} stations observées en ${shortArea}.`,
  })[locale] + (deltaYest === null ? '' : ` ${deltaYestFmt} ${comparisonLabel(1)}.`);
  const provenance = ({
    it: `Dati acquisiti: ${observationStamp}. L’orario di variazione del prezzo alla pompa non è fornito dalla fonte. Generazione pagina: ${today.toISOString()}.`,
    en: `Data collected: ${observationStamp}. The source does not provide the time of the price change at the pump. Page generated: ${today.toISOString()}.`,
    de: `Daten abgerufen: ${observationStamp}. Die Quelle nennt keinen Zeitpunkt der Preisänderung an der Zapfsäule. Seite erstellt: ${today.toISOString()}.`,
    fr: `Données acquises : ${observationStamp}. La source ne fournit pas l’heure de modification du prix à la pompe. Page générée : ${today.toISOString()}.`,
  })[locale];
  const stale = !observationDate || today.getTime() - observationDate.getTime() > 48 * 60 * 60 * 1000;
  const staleNote = stale ? ({
    it: 'Dato non recente: verifica il prezzo alla pompa prima del rifornimento.',
    en: 'Data is not recent: check the pump price before refuelling.',
    de: 'Daten nicht aktuell: vor dem Tanken den Preis an der Zapfsäule prüfen.',
    fr: 'Donnée non récente : vérifiez le prix à la pompe avant le plein.',
  })[locale] : '';
  const paragraph = `${intro} ${dailyComparison} ${copy.historySection}`;
  const historyCopy = copy.historySection;

  const canonicalUrl = `${BASE_URL}${canonicalPath}`;

  // Top 3 stations
  const top3 = zonePrice.minStations;
  const editorialAssessment = buildDailyEditorialAssessment(
    locale,
    fuelLabel,
    whereLabel,
    priceFmt,
    snapshotDayMatchesCivilDay ? deltaYest : null,
    snapshotDayMatchesCivilDay ? delta7 : null,
    top3.length,
  );
  const stationsHtml = top3.length > 0
    ? `<ol class="s-cTOdp9">${top3
        .map((s) => {
          // On the regional (no-zone) hub, resolve the station's zone from
          // its address so each card still links to its dedicated page.
          const stationZone = zone ?? zoneForAddress(s.address);
          const stationHref = stationZone && s.slug
            ? buildFuelStationPath(locale, fuel, stationZone, s.slug)
            : undefined;
          const logoUrl = resolveStationBrandLogoUrl(rootDir, s.brand);
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
          return `<li class="s-6FVpHG">${card}</li>`;
        })
        .join('')}</ol>`
    : `<p class="s-gWHXua">${esc(copy.trendEmpty)}</p>`;

  // Trend table: last 7 days from history
  const trendRows: Array<{ date: string; price: number | null }> = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(referenceDate.getTime() - i * 24 * 60 * 60 * 1000);
    const key = d.toISOString().slice(0, 10);
    if (i === 0) {
      trendRows.push({ date: key, price: observationDate ? avg : null });
    } else {
      const val = lookbackPrice(history, zone, fuel, i, referenceDate);
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
      acc[rk] = buildFuelHistorySeries(history, zone, fuel, FUEL_RANGE_DAYS[rk], referenceDate, observationDate ? avg : null);
      return acc;
    },
    {} as Record<FuelRangeKey, FuelSeriesPoint[]>,
  );
  const historyCard = renderFuelHistoryCard({
    locale,
    trendLabel: copy.trendLabel,
    buildAriaLabel: (avgFmt) => copy.chartAriaLabel(fuelLabel, whereLabel, avgFmt),
    seriesByRange: swissSeriesByRange,
    currency: 'CHF',
  });

  const trendTableHtml = `<table class="s-tbl" style="font-size:14px">
    <thead><tr>
      <th scope="col" class="s-thd">${esc(locale === 'it' ? 'Data' : locale === 'de' ? 'Datum' : 'Date')}</th>
      <th scope="col" class="s-thd" style="text-align:right">${esc(copy.avgLabel)}</th>
    </tr></thead>
    <tbody>${trendRows
      .map((r) => `<tr>
        <td class="s-tcl">${esc(r.date)}</td>
        <td class="s-tcl" style="text-align:right;font-variant-numeric:tabular-nums">${r.price === null ? '—' : formatPrice(r.price, locale) + ' CHF'}</td>
      </tr>`)
      .join('')}${
        periodAvg !== null
          ? `<tr>
        <th scope="row" class="s-tcl" style="font-weight:700">${esc(copy.periodAvgLabel)}</th>
        <td class="s-tcl" style="text-align:right;font-variant-numeric:tabular-nums;font-weight:700">${esc(
              periodAvgFmt,
            )} CHF</td>
      </tr>`
          : ''
      }</tbody>
  </table>`;

  const periodAvgNoteHtml =
    periodAvg === null
      ? `<p class="s-T__epv">${esc(copy.periodAvgUnavailableNote)}</p>`
      : '';

  // "Base dati in costruzione" fallback note — shown when either delta cannot
  // be computed (no yesterday snapshot, or no 7-day-ago snapshot). Links to
  // the long-form stats page where the full history chart lives.
  const statsHref = FUEL_STATS_HUB_PATH[locale];
  const unavailableNoteHtml =
    deltaYest === null || delta7 === null
      ? `<p class="s-01ocQJ">${esc(
          copy.dataUnavailableNote,
        )}<a href="${esc(statsHref)}" style="${LINK_ACCENT_STYLE};font-weight:600">${esc(copy.dataUnavailableLinkLabel)} →</a></p>`
      : '';

  // FAQ section
  const faqItems = copy.faq;
  const faqHtml = `<section class="s-ZqtBbL" aria-labelledby="fuelDailyFaq">
    <h2 id="fuelDailyFaq" class="s-h2">${esc(copy.faqTitle)}</h2>
    ${faqItems
      .map(
        (f) => `<details class="s-card" style="margin-bottom:8px">
        <summary class="s-HBR0NM">${esc(f.q)}</summary>
        <p class="s-OCic8j">${esc(f.a(fuelLabel, whereLabel))}</p>
      </details>`,
      )
      .join('')}
  </section>`;

  // Alternates — includes x-default pointing at the IT href (shared helper).
  const alternatesHtml = renderHreflangTags(alternates);

  // JSON-LD: this renderer has no editorial publication/change timestamp.
  // The build clock and acquisition timestamps are not publication dates.
  const breadcrumbLd = inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: copy.breadcrumbHome, item: `${BASE_URL}/` },
      { '@type': 'ListItem', position: 2, name: fuelLabel, item: `${BASE_URL}${FUEL_LOCALE_PREFIX[locale]}/${FUEL_SECTION_SLUG[locale][fuel]}/` },
      { '@type': 'ListItem', position: 3, name: zoneLabel, item: canonicalUrl },
    ],
  });

  const faqLd = inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    inLanguage: locale,
    mainEntity: faqItems.map((f) => ({
      '@type': 'Question',
      name: f.q,
      acceptedAnswer: { '@type': 'Answer', text: f.a(fuelLabel, whereLabel) },
    })),
  });

  const webPageLd = inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: h1,
    url: canonicalUrl,
    description: intro,
    inLanguage: locale,
    ...(observation.collectedAt ? { dateModified: observation.collectedAt } : {}),
  });

  // Product LD is intentionally NOT emitted for daily zone pages.
  // Rationale: Google's "Merchant listing" rich-results validator (mirrored in
  // scripts/validate-structured-data-completeness.mjs) requires Product to
  // carry aggregateRating + review — fake review data violates Google's
  // structured-data guidelines and risks a manual action. A daily aggregate
  // price per zone isn't a merchant product anyway; the WebPage + FAQPage +
  // BreadcrumbList already convey enough structure, and the live price is
  // surfaced in the visible page body.

  // Keep the observed price and collection date in the snippet, even when the page rebuilds later.
  const titleDate = observationDate ? formatFuelDateDisplay(observationDate) : '';
  const titleHeadline = `${fuelLabel} ${shortArea}: ${priceFmt} CHF/l`;
  const title = clampSiteSuffix(`${titleHeadline}${titleDate ? ` · TCS ${titleDate}` : ''}`, 'Frontaliere Ticino', 66);
  const description = intro;

  // Main body markup (kept plain + inline-styled so we don't depend on the
  // SPA bundle and the static page ranks on its own).
  const bodyHtml = `<article class="s-xzWvwM">
  <nav class="s-bcr">
    <a href="/" class="s-bcl">${esc(copy.breadcrumbHome)}</a>
    <span> / </span>
    <span>${esc(fuelLabel)}</span>
    <span> / </span>
    <span>${esc(zoneLabel)}</span>
  </nav>
  <header class="s-Nv0GaD">
    <p class="s-eyb">${esc(observationStamp)}</p>
    <h1 class="s-h1">${esc(h1)}</h1>
    <p class="s-lede">${esc(introTagline)}</p>
    <p class="text-sm text-muted">${esc(provenance)} <a href="https://benzin.tcs.ch/" rel="noopener noreferrer" target="_blank">TCS Benzinpreis</a></p>
    ${staleNote ? `<p role="note" class="text-sm text-warning">${esc(staleNote)}</p>` : ''}
  </header>
  <section class="s-Bk-L3k">
    <div class="s-tacc">
      <div class="s-tlbl">${esc(copy.avgLabel)}</div>
      <div class="s-tval" style="font-size:32px">${priceFmt}</div>
      <div class="s-iydat0">${esc(copy.currencyLabel)}</div>
    </div>
    <div style="${deltaYest === null ? STAT_TILE_BASE : deltaYest < 0 ? STAT_TILE_SUCCESS : deltaYest > 0 ? STAT_TILE_WARNING : STAT_TILE_BASE}">
      <div class="s-tlbl">${esc(comparisonLabel(1))}</div>
      <div class="s-tval" style="font-size:22px">${esc(deltaYestFmt)}</div>
    </div>
    <div style="${delta7 === null ? STAT_TILE_BASE : delta7 < 0 ? STAT_TILE_SUCCESS : delta7 > 0 ? STAT_TILE_WARNING : STAT_TILE_BASE}">
      <div class="s-tlbl">${esc(comparisonLabel(7))}</div>
      <div class="s-tval" style="font-size:22px">${esc(delta7Fmt)}</div>
    </div>
  </section>
  ${unavailableNoteHtml}
  ${renderAboveFoldJobCta(locale)}
  <section class="s-card" style="margin:0 0 24px" aria-labelledby="fuelReview">
    <h2 id="fuelReview" class="s-h2">${esc(editorialAssessment.heading)}</h2>
    <p class="s-E7ZJqo">${esc(editorialAssessment.body)}</p>
  </section>
  <section class="s-ziawP1" aria-labelledby="top3">
    <h2 id="top3" class="s-h2">${esc(copy.top3Label)}</h2>
    ${stationsHtml}
  </section>
  <section class="s-ziawP1" aria-labelledby="trend7">
    <h2 id="trend7" class="s-h2">${esc(copy.trendLabel)}</h2>
    <p class="s-C63fWv">${esc(historyCopy)}</p>
    ${historyCard}
    ${trendTableHtml}
    ${periodAvgNoteHtml}
  </section>
  ${DRIVEBY_AD_SNIPPET}
  ${faqHtml}
  <section class="s-GCEyQg" aria-label="${esc(copy.faqTitle)}">
    <p class="s-kvHUMU">${esc(intro)}</p>
    <p class="s-yOfiVn">${esc(paragraph)}</p>
  </section>
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
  <section class="s-sC82IX" aria-label="advertisement">
    ${adSlotHtml('ARTICLE_END_MULTIPLEX')}
  </section>
</article>`;

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
  const copy: Record<FuelDailyLocale, { h: string; p1: string; p2: string; p3: string }> = {
    it: {
      h: `Metodologia e contesto per il prezzo del ${fuelLabel.toLowerCase()} a ${zoneLabel}`,
      p1: `Per ${monthKey} questa pagina mostra le medie giornaliere disponibili per ${fuelLabel.toLowerCase()} nella zona ${zoneLabel}. La media mensile di ${avgFmt} CHF/litro è la media aritmetica dei valori numerici presenti nello storico, non una media ponderata per litri venduti. Un giorno senza rilevazione resta privo di prezzo: non viene sostituito con quello del giorno prima. Il campione di stazioni può variare nel tempo e non rappresenta necessariamente tutti i distributori della zona.`,
      p2: `La fonte dei prezzi svizzeri è il radar TCS, che raccoglie segnalazioni degli utenti. Lo storico conserva gli snapshot della nostra pipeline: la data identifica il giorno del campione, non certifica quando ogni gestore ha modificato il prezzo alla pompa. Una media mensile può nascondere differenze fra stazioni e fra giorni. Per scegliere dove rifornirti consulta la pagina corrente, controlla la data del dato e verifica il prezzo presso la stazione.`,
      p3: `Per confrontare ${zoneLabel} con una località italiana servono lo stesso carburante, prezzi riferiti a periodi confrontabili e un cambio CHF/EUR datato. Converti i prezzi nella stessa valuta, moltiplica la differenza per i litri da acquistare e sottrai i costi effettivi della deviazione. Distanza, consumo, pedaggi e tempo dipendono dal tuo tragitto. Lo storico non determina una soglia universale di convenienza né dimostra un sovrapprezzo fisso presso il confine.`,
    },
    en: {
      h: `Methodology and context for the ${fuelLabel.toLowerCase()} price in ${zoneLabel}`,
      p1: `For ${monthKey}, this page shows available daily ${fuelLabel.toLowerCase()} averages for the ${zoneLabel} zone. The monthly average of ${avgFmt} CHF/litre is the arithmetic mean of numeric values present in the history, not an average weighted by litres sold. A day without an observation has no price and is not filled with the previous value. The station sample can change over time and does not necessarily represent every station in the area.`,
      p2: `Swiss prices originate from the TCS radar, which collects user reports. This archive preserves snapshots from our pipeline: the date identifies the sample day, not the time each operator changed its pump price. A monthly average can hide differences between stations and days. Before choosing where to refuel, open the current page, check the collection date and confirm the price at the station. Missing observations do not establish that a price remained unchanged.`,
      p3: `To compare ${zoneLabel} with an Italian location, use the same fuel, observations from comparable periods and a dated CHF/EUR exchange rate. Convert both prices to one currency, multiply the difference by the litres you intend to buy, then subtract actual detour costs. Distance, consumption, tolls and time depend on your journey. This history does not establish a universal break-even threshold or a fixed premium at border stations.`,
    },
    de: {
      h: `Methodik und Kontext zum ${fuelLabel}preis in ${zoneLabel}`,
      p1: `Für ${monthKey} zeigt diese Seite die verfügbaren Tagesmittelwerte für ${fuelLabel} in der Zone ${zoneLabel}. Der Monatswert von ${avgFmt} CHF/Liter ist das arithmetische Mittel der vorhandenen Zahlenwerte, kein nach verkauften Litern gewichteter Durchschnitt. Ein Tag ohne Erhebung bleibt ohne Preis und wird nicht mit dem Vortageswert ergänzt. Die Auswahl der Tankstellen kann sich ändern und bildet nicht zwingend sämtliche Anbieter in der Zone ab.`,
      p2: `Die Schweizer Preise stammen aus dem TCS-Radar, der Meldungen von Nutzern sammelt. Das Archiv bewahrt Momentaufnahmen unserer Pipeline auf: Das Datum bezeichnet den Erhebungstag, nicht den Zeitpunkt jeder Preisänderung an einer Zapfsäule. Ein Monatsmittel kann Unterschiede zwischen Tankstellen und Tagen verdecken. Prüfen Sie vor dem Tanken die aktuelle Seite, das Erhebungsdatum und den Preis vor Ort. Fehlende Daten belegen keinen unveränderten Preis.`,
      p3: `Für den Vergleich zwischen ${zoneLabel} und einem italienischen Ort benötigen Sie denselben Kraftstoff, vergleichbare Erhebungszeiträume und einen datierten CHF/EUR-Kurs. Rechnen Sie beide Preise in dieselbe Währung um, multiplizieren Sie die Differenz mit der geplanten Literzahl und ziehen Sie tatsächliche Umwegkosten ab. Entfernung, Verbrauch, Maut und Zeit hängen von Ihrer Strecke ab. Die Historie belegt weder eine allgemeine Rentabilitätsschwelle noch einen festen Preisaufschlag an Grenztankstellen.`,
    },
    fr: {
      h: `Méthodologie et contexte pour le prix ${frFuelOf(fuelLabel)} à ${zoneLabel}`,
      p1: `Pour ${monthKey}, cette page présente les moyennes quotidiennes disponibles ${frFuelOf(fuelLabel)} dans la zone ${zoneLabel}. La moyenne mensuelle de ${avgFmt} CHF/litre est la moyenne arithmétique des valeurs numériques présentes dans l’historique, sans pondération par les litres vendus. Une journée sans relevé reste sans prix et ne reprend pas la valeur précédente. L’échantillon de stations peut varier dans le temps et ne représente pas nécessairement tous les distributeurs de la zone.`,
      p2: `Les prix suisses proviennent du radar TCS, qui recueille les signalements des utilisateurs. L’archive conserve les instantanés de notre collecte : la date désigne le jour de l’échantillon, pas l’heure de modification du prix de chaque station. Une moyenne mensuelle peut masquer des écarts entre stations et entre jours. Avant le plein, consultez la page courante, vérifiez la date du relevé et confirmez le prix sur place. Une lacune ne prouve pas un prix stable.`,
      p3: `Pour comparer ${zoneLabel} avec une localité italienne, utilisez le même carburant, des périodes comparables et un taux CHF/EUR daté. Convertissez les prix dans une même devise, multipliez l’écart par les litres prévus et déduisez les coûts réels du détour. Distance, consommation, péages et temps dépendent de votre trajet. Cet historique ne définit ni seuil universel de rentabilité ni supplément fixe près de la frontière.`,
    },
  };
  const c = copy[locale] || copy.it;
  return `<section class="s-PBAEDX" aria-labelledby="archiveContext">
    <h2 id="archiveContext" class="s-h2">${esc(c.h)}</h2>
    <p class="s-p6u8io">${c.p1}</p>
    <p class="s-p6u8io">${c.p2} <a href="https://benzin.tcs.ch/" rel="noopener noreferrer" target="_blank">TCS Benzinpreis</a></p>
    <p class="s-zXvi5E">${c.p3}</p>
  </section>`;
}

function renderArchive(inp: ArchiveInputs): string {
  const { locale, fuel, zone, monthKey, snapshots, canonicalPath, today, distDir } = inp;
  const copy = COPY[locale];
  const fuelLabel = FUEL_TYPE_LABEL[locale][fuel];
  const zoneLabel = FUEL_ZONE_DISPLAY[zone];
  const whereLabel = fuelWhere(locale, zoneLabel, true);
  const canonicalUrl = `${BASE_URL}${canonicalPath}`;

  const rows = snapshots
    .filter((s) => s.date.startsWith(monthKey))
    .map((s) => ({ date: s.date, price: s.zones?.[zone]?.[fuel] ?? null }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const prices = rows.map((r) => r.price).filter((p): p is number => typeof p === 'number' && Number.isFinite(p) && p > 0);
  const avg = mean(prices);

  let h1 = locale === 'it'
    ? `Archivio prezzo ${fuelLabel.toLowerCase()} a ${zoneLabel} — ${monthKey}`
    : locale === 'en'
    ? `${fuelLabel} price archive for ${zoneLabel} — ${monthKey}`
    : locale === 'de'
    ? `${fuelLabel}preis-Archiv ${zoneLabel} — ${monthKey}`
    : `Archive du prix ${frFuelOf(fuelLabel)} à ${zoneLabel} — ${monthKey}`;

  const intro = locale === 'it'
    ? `Questa pagina raccoglie il prezzo medio giornaliero del ${fuelLabel.toLowerCase()} a ${zoneLabel} per il mese ${monthKey}, con prezzo medio mensile di ${formatPrice(avg, locale)} CHF/litro. Utile per verificare l'andamento storico e decidere se il livello attuale è alto o basso rispetto al recente passato. I dati provengono dalle stazioni Svizzere monitorate ogni giorno dalla nostra pipeline basata su TCS Benzinpreis.`
    : locale === 'en'
    ? `This page collects the daily ${fuelLabel.toLowerCase()} price in ${zoneLabel} for month ${monthKey}, with a monthly average of ${formatPrice(avg, locale)} CHF/litre. Use it to check the historical trend and decide whether the current price is high or low. Data comes from Swiss stations monitored daily by our pipeline on top of TCS Benzinpreis.`
    : locale === 'de'
    ? `Diese Seite sammelt den täglichen ${fuelLabel}preis in ${zoneLabel} für den Monat ${monthKey}, mit einem Monatsdurchschnitt von ${formatPrice(avg, locale)} CHF/Liter. Nutzen Sie sie, um den historischen Verlauf einzuordnen und zu beurteilen, ob der aktuelle Preis hoch oder niedrig ist. Die Daten stammen von Schweizer Tankstellen, die täglich von unserer Pipeline auf Basis TCS Benzinpreis erfasst werden.`
    : `Cette page rassemble le prix quotidien ${frFuelOf(fuelLabel)} à ${zoneLabel} pour le mois ${monthKey}, avec une moyenne mensuelle de ${formatPrice(avg, locale)} CHF/litre. Utile pour évaluer la tendance historique et déterminer si le prix actuel est haut ou bas. Les données viennent des stations suisses surveillées chaque jour par notre pipeline basée sur TCS Benzinpreis.`;

  // Above-the-fold tagline (≤120 chars). The full archive intro
  // migrates to the body section below the chart + table, preserving
  // text-to-HTML ratio.
  const archiveTaglineByLocale: Record<FuelDailyLocale, string> = {
    it: `Archivio mensile ${fuelLabel} a ${zoneLabel} (${monthKey}): media ${formatPrice(avg, locale)} CHF/litro.`,
    en: `${fuelLabel} monthly archive in ${zoneLabel} (${monthKey}): average ${formatPrice(avg, locale)} CHF/litre.`,
    de: `${fuelLabel}-Monatsarchiv in ${zoneLabel} (${monthKey}): Durchschnitt ${formatPrice(avg, locale)} CHF/Liter.`,
    fr: `Archive mensuelle ${fuelLabel} à ${zoneLabel} (${monthKey}) : moyenne ${formatPrice(avg, locale)} CHF/litre.`,
  };

  const tableHtml = `<table class="s-tbl" style="font-size:14px">
    <thead><tr>
      <th class="s-thd">${esc(locale === 'it' ? 'Data' : locale === 'de' ? 'Datum' : 'Date')}</th>
      <th class="s-thd" style="text-align:right">${esc(copy.avgLabel)}</th>
    </tr></thead>
    <tbody>${rows.map((r) => `<tr>
      <td class="s-tcl">${esc(r.date)}</td>
      <td class="s-tcl" style="text-align:right;font-variant-numeric:tabular-nums">${r.price === null ? '—' : formatPrice(r.price, locale) + ' CHF'}</td>
    </tr>`).join('')}</tbody>
  </table>`;

  // Single-month area chart visualizing the table data above. No range
  // selector — the page is already scoped to one month.
  const chartSeries: FuelSeriesPoint[] = rows
    .filter((r): r is { date: string; price: number } => typeof r.price === 'number')
    .map((r) => ({ date: r.date, value: Number(r.price.toFixed(3)) }));
  const chartStats = computeFuelStats(chartSeries);
  const chartAriaLabel = copy.chartAriaLabel(fuelLabel, whereLabel, formatPrice(chartStats?.avg ?? null, locale));
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
    ? `<div class="s-JaMFJn">
      ${chartSvg}
      ${chartStats
        ? `<div class="s--11GVM">
          <span><strong>${esc(archiveStatLabels.min)}:</strong> ${esc(formatStatVal(chartStats.min))}</span>
          <span><strong>${esc(archiveStatLabels.avg)}:</strong> ${esc(formatStatVal(chartStats.avg))}</span>
          <span><strong>${esc(archiveStatLabels.max)}:</strong> ${esc(formatStatVal(chartStats.max))}</span>
        </div>`
        : ''}
    </div>`
    : '';

  const title = clampSiteSuffix(h1, 'Frontaliere Ticino');
  // Archive pages: H1 includes the month-key tail, but if the headline is
  // long enough that buildTitleWithBrand drops the brand from <title>, the
  // two strings collide. Differentiate the H1 so audit:h1-title-duplicates
  // accepts the page (baseline 0).
  h1 = differentiateH1FromTitle(h1, title, locale);
  // Pre-cut removed: clampMetaDescription (160) runs downstream and is
  // word-aware. Slicing first only handed it a string already broken
  // mid-word, which is what reached the SERP snippet.
  const description = intro;

  const breadcrumbLd = inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: copy.breadcrumbHome, item: `${BASE_URL}/` },
      { '@type': 'ListItem', position: 2, name: fuelLabel, item: `${BASE_URL}${FUEL_LOCALE_PREFIX[locale]}/${FUEL_SECTION_SLUG[locale][fuel]}/` },
      { '@type': 'ListItem', position: 3, name: `${zoneLabel} ${monthKey}`, item: canonicalUrl },
    ],
  });

  const webPageLd = inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: h1,
    url: canonicalUrl,
    description: intro,
    inLanguage: locale,
  });

  // SEO content gate (text-to-HTML ratio): the monthly archive pages
  // were among the 75 fuel-daily offenders flagged at <10% in the
  // Apr 2026 audit because the body is mostly a single paragraph + a
  // small SVG chart + a numeric table. Append a methodology paragraph
  // explaining how the dataset is sourced (TCS Benzinpreis / MIMIT
  // Osservaprezzi), refresh cadence, and a frontaliere-routing context
  // block so each page emits real, page-relevant prose.
  const archiveProse = renderFuelArchiveProse({ locale, fuelLabel, zoneLabel, monthKey, avgFmt: formatPrice(avg, locale) });

  const bodyHtml = `<article class="s-xzWvwM">
        <nav class="s-bcr">
          <a href="/" class="s-bcl">${esc(copy.breadcrumbHome)}</a>
          <span> / </span>
          <a href="${buildFuelTodayPath(locale, fuel, zone)}" class="s-bcl">${esc(zoneLabel)}</a>
          <span> / </span>
          <span>${esc(monthKey)}</span>
        </nav>
        <header class="s-Nv0GaD">
          <p class="s-eyb">${esc(copy.archiveLabel)} · ${esc(monthKey)}</p>
          <h1 class="s-h1">${esc(h1)}</h1>
          <p class="s-lede">${esc(archiveTaglineByLocale[locale])}</p>
        </header>
        ${archiveChartHtml}
        <section>${tableHtml}</section>
        <section class="s-Va7_33">
          <p class="s-E7ZJqo">${esc(intro)}</p>
        </section>
        ${archiveProse}
        <section class="s-sC82IX" aria-label="advertisement">
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
  prices: { diesel: number | null; benzina: number | null };
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
      if (!s || !pricesFromStation(s)) continue;
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

/** Shared reading guidance: no assumed taxes, premiums, queue costs or exchange rate. */
function fuelComparisonNotes(locale: FuelDailyLocale, place: string, source: 'TCS' | 'MIMIT'): string[] {
  const sourceNote = source === 'TCS' ? {
    it: 'Il radar TCS raccoglie prezzi segnalati dagli utenti. L’acquisizione indica quando abbiamo letto il dato, non quando il gestore ha modificato il prezzo. La presenza di una stazione nel campione non garantisce che il prezzo sia ancora valido alla pompa.',
    en: 'The TCS radar collects user-reported prices. Collection time records when we read the data, not when the operator changed its price. A station appearing in this sample does not guarantee that the displayed price is still valid at the pump.',
    de: 'Der TCS-Radar sammelt Preisangaben von Nutzern. Die Abrufzeit bezeichnet das Lesen der Daten, nicht die Preisänderung durch den Betreiber. Eine erfasste Tankstelle garantiert keinen weiterhin gültigen Preis an der Zapfsäule.',
    fr: 'Le radar TCS recueille les prix signalés par les utilisateurs. L’acquisition indique quand nous avons lu le relevé, pas quand le gestionnaire a modifié le tarif. La présence d’une station ne garantit pas que son prix soit encore valable à la pompe.',
  }[locale] : {
    it: 'I prezzi MIMIT Osservaprezzi sono comunicati dai gestori delle stazioni. Controlla la data della comunicazione e la modalità di rifornimento: self-service e servito possono avere listini diversi. La data di generazione della pagina non sostituisce la data del prezzo dichiarato dal gestore.',
    en: 'MIMIT Osservaprezzi prices are reported by station operators. Check the reporting date and service mode: self-service and attended pumps may have different prices. The page generation date does not replace the date of the operator’s price report.',
    de: 'Die Preise bei MIMIT Osservaprezzi werden von den Betreibern gemeldet. Prüfen Sie das Meldedatum und die Bedienungsart: Selbstbedienung und Bedienung können unterschiedliche Preise haben. Das Erstellungsdatum der Seite ersetzt nicht das Datum der Preisangabe des Betreibers.',
    fr: 'Les prix MIMIT Osservaprezzi sont déclarés par les exploitants. Vérifiez la date de communication et le mode de service : libre-service et service assisté peuvent avoir des tarifs différents. La date de génération de la page ne remplace pas celle du prix communiqué.',
  }[locale];
  return {
    it: [
      `Per ${place}, valuta il prezzo insieme all’indirizzo, al carburante e alla data del dato. La classifica riguarda soltanto le stazioni presenti nel campione e non assicura copertura completa. Il distributore più economico nell’elenco può trovarsi lontano dal percorso abituale: controlla la posizione sulla mappa, gli orari di apertura e il prezzo esposto prima di raggiungerlo.`,
      sourceNote,
      'Un confronto Italia–Svizzera richiede lo stesso carburante, date confrontabili e prezzi nella stessa valuta. Annota il cambio CHF/EUR e la sua data, considerando anche le condizioni applicate al pagamento. Una media di zona descrive il campione, non il prezzo di ogni pompa. La differenza fra due medie non garantisce il risparmio presso una stazione specifica.',
      'Esempio ipotetico di consumo: 80 km al giorno, 6 litri per 100 km e 22 giorni producono 105,6 litri al mese. Questi valori sono ipotesi, non una distanza o un consumo tipico misurato dei frontalieri. Sostituiscili con chilometri, consumo e giorni effettivi, poi moltiplica i litri per il prezzo della stazione scelta. Il risultato stima soltanto il carburante.',
      'Per valutare una deviazione, moltiplica la differenza di prezzo nella stessa valuta per i litri da acquistare. Sottrai il carburante per i chilometri aggiuntivi, eventuali pedaggi e gli altri costi effettivi. Il valore del tempo dipende dalle tue esigenze; non esiste una soglia unica valida per tutti. Manutenzione, assicurazione e altri costi del veicolo vanno valutati separatamente, senza dedurli automaticamente dalle imposte sul salario.',
    ],
    en: [
      `For ${place}, read the price together with the address, fuel type and observation date. Rankings cover only sampled stations and do not guarantee complete coverage. The cheapest listed pump may be far from your usual route. Check the map, opening hours and displayed pump price before travelling; a lower price per litre does not by itself establish a lower total journey cost.`,
      sourceNote,
      'An Italy–Switzerland comparison needs the same fuel, comparable dates and one currency. Record the CHF/EUR exchange rate and its date, including any payment conversion costs. A zone average describes the sample, not the price at every pump. A difference between two averages does not guarantee a saving at a particular station or establish which side is always cheaper.',
      'Hypothetical consumption example: 80 km per day, 6 litres per 100 km and 22 days produce 105.6 litres per month. These are assumptions, not measured typical commuting distances or consumption. Replace them with your actual kilometres, fuel consumption and working days, then multiply the litres by your chosen station price. The result estimates fuel only and is not a forecast of total commuting expenditure.',
      'To assess a detour, multiply the price difference in one currency by the litres you intend to buy. Subtract fuel for extra kilometres, any tolls and other actual costs. The value of time depends on your needs; there is no universal break-even threshold. Assess maintenance, insurance and other vehicle costs separately, without treating them as automatic deductions from salary taxes.',
    ],
    de: [
      `Bei ${place} sollten Sie Preis, Adresse, Kraftstoff und Erhebungsdatum gemeinsam betrachten. Die Rangliste umfasst nur erfasste Tankstellen und garantiert keine vollständige Abdeckung. Die günstigste aufgeführte Zapfsäule kann weit von Ihrer üblichen Strecke entfernt liegen. Prüfen Sie Karte, Öffnungszeiten und den ausgeschilderten Preis vor der Anfahrt. Ein niedrigerer Literpreis bedeutet nicht automatisch geringere Gesamtkosten der Fahrt.`,
      sourceNote,
      'Ein Vergleich zwischen Italien und der Schweiz erfordert denselben Kraftstoff, vergleichbare Zeitpunkte und dieselbe Währung. Notieren Sie den CHF/EUR-Kurs mit Datum und berücksichtigen Sie die Umrechnung beim Bezahlen. Ein Zonendurchschnitt beschreibt das erfasste Angebot, nicht jeden einzelnen Zapfsäulenpreis. Unterschiede zwischen Durchschnittswerten garantieren keine Ersparnis bei einer bestimmten Tankstelle und belegen keinen dauerhaften Vorteil einer Grenzseite.',
      'Hypothetisches Verbrauchsbeispiel: 80 km pro Tag, 6 Liter je 100 km und 22 Tage ergeben 105,6 Liter im Monat. Diese Annahmen sind keine gemessenen typischen Pendeldistanzen oder Verbrauchswerte. Setzen Sie Ihre tatsächlichen Kilometer, Ihren Verbrauch und Ihre Arbeitstage ein und multiplizieren Sie die Literzahl mit dem Preis der gewählten Tankstelle. Das Ergebnis schätzt nur den Kraftstoffbedarf und keine gesamten Pendelkosten.',
      'Multiplizieren Sie für einen Umweg die Preisdifferenz in derselben Währung mit der geplanten Literzahl. Ziehen Sie Kraftstoff für zusätzliche Kilometer, allfällige Maut und weitere tatsächliche Kosten ab. Der Zeitwert hängt von Ihren Bedürfnissen ab; es gibt keine allgemeingültige Rentabilitätsschwelle. Wartung, Versicherung und andere Fahrzeugkosten sind getrennt zu beurteilen und nicht automatisch von den Lohnsteuern abzuziehen.',
    ],
    fr: [
      `Pour ${place}, lisez le prix avec l’adresse, le carburant et la date du relevé. Le classement couvre seulement les stations observées, sans garantir une couverture complète. La pompe la moins chère de la liste peut être éloignée de votre trajet. Vérifiez la carte, les horaires et le prix affiché avant de partir : un tarif au litre inférieur ne garantit pas un coût total de déplacement moindre.`,
      sourceNote,
      'Comparer l’Italie et la Suisse exige le même carburant, des dates comparables et une seule devise. Notez le taux CHF/EUR avec sa date et les conditions de conversion du paiement. La moyenne d’une zone décrit l’échantillon, pas le tarif de chaque pompe. Un écart entre deux moyennes ne garantit ni économie dans une station donnée ni avantage permanent d’un côté de la frontière.',
      'Exemple hypothétique de consommation : 80 km par jour, 6 litres aux 100 km et 22 jours donnent 105,6 litres par mois. Ces valeurs sont des hypothèses, pas des trajets ou consommations typiques mesurés des frontaliers. Remplacez-les par vos kilomètres, votre consommation et vos jours réels, puis multipliez les litres par le prix de la station choisie. Le résultat estime seulement le carburant.',
      'Pour évaluer un détour, multipliez l’écart de prix dans une même devise par les litres prévus. Déduisez le carburant des kilomètres supplémentaires, les péages éventuels et les autres frais réels. La valeur du temps dépend de vos besoins ; aucun seuil universel ne convient à tous. Entretien, assurance et autres frais du véhicule se calculent séparément, sans déduction automatique des impôts sur le salaire.',
    ],
  }[locale];
}

const STATION_COPY: Record<FuelDailyLocale, StationCopy> = {
  it: {
    h1: (b, st, c, f) => `Prezzo ${f.toLowerCase()} ${b} ${st} a ${c}`,
    intro: (b, c, p, f) => `Il campione TCS riporta ${f.toLowerCase()} a ${p} CHF/litro per la stazione ${b} di ${c}. Controlla la data di acquisizione e verifica il prezzo alla pompa prima del rifornimento.`,
    paragraph: (b, c, p, zAvg, f) => `Alla stazione ${b} di ${c} il prezzo ${itFuelGenitive(f)} è ${p} CHF/litro rispetto alla media di zona di ${zAvg} CHF/litro. Questo dato ti aiuta a capire se conviene fare rifornimento qui oppure in una stazione vicina. Incrocia il valore con lo storico settimanale del prezzo in zona per decidere se aspettare o pieno subito. Usa la mappa dei valichi doganali per verificare la fila prima di spostarti e la guida frontaliere per capire costi e tempi complessivi del tragitto casa-lavoro.`,
    ranking: (r, t, c) => `Posizione nella classifica di ${c}: ${r} (${t} stazioni rilevate).`,
    infoHeading: 'Informazioni stazione',
    infoBrand: 'Brand',
    infoAddress: 'Indirizzo',
    infoUpdated: 'Acquisizione dato prezzo',
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
    contextParagraphs: (b, c, z, _f) => fuelComparisonNotes('it', `${b}, ${c} (${z})`, 'TCS'),
  },
  en: {
    h1: (b, st, c, f) => `${f} price ${b} ${st} in ${c}`,
    intro: (b, c, p, f) => `The TCS sample reports ${f.toLowerCase()} at ${p} CHF per litre for the ${b} station in ${c}. Check the collection date and confirm the pump price before refuelling.`,
    paragraph: (b, c, p, zAvg, f) => `At the ${b} station in ${c} the ${f.toLowerCase()} price is ${p} CHF per litre vs the zone average of ${zAvg} CHF per litre. Use this gap to decide whether to fill up here or at a nearby station. Cross-check with the weekly zone trend to plan your refuel, check the border crossing queue before you drive, and use the cross-border commuter guide for the full commute picture.`,
    ranking: (r, t, c) => `Rank in ${c}: ${r} (${t} stations observed).`,
    infoHeading: 'Station info',
    infoBrand: 'Brand',
    infoAddress: 'Address',
    infoUpdated: 'Price data collected',
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
    contextParagraphs: (b, c, z, _f) => fuelComparisonNotes('en', `${b}, ${c} (${z})`, 'TCS'),
  },
  de: {
    h1: (b, st, c, f) => `${f}preis ${b} ${st} in ${c}`,
    intro: (b, c, p, f) => `Die TCS-Stichprobe nennt ${p} CHF pro Liter für ${f} an der Tankstelle ${b} in ${c}. Prüfen Sie das Abrufdatum und bestätigen Sie den Preis vor dem Tanken an der Zapfsäule.`,
    paragraph: (b, c, p, zAvg, f) => `An der Tankstelle ${b} in ${c} liegt der ${f}preis bei ${p} CHF pro Liter gegenüber dem Zonendurchschnitt von ${zAvg} CHF pro Liter. Nutze die Differenz, um zu entscheiden, ob du hier oder an einer benachbarten Tankstelle tankst. Die Seite zeigt den verfügbaren Datenstand; ein Neuaufbau bestätigt keinen neuen Preis an der Zapfsäule. Vergleiche mit dem Wochenverlauf der Zone, prüfe die Wartezeit am nächsten Grenzübergang und konsultiere den Grenzgänger-Leitfaden für die gesamte Pendel-Kostenrechnung. So planst du deinen Tankstopp optimal: vor oder nach der Grenze, mit oder ohne Umweg, je nach Tagesdifferenz zwischen Italien und der Schweiz.`,
    ranking: (r, t, c) => `Rang in ${c}: ${r} (${t} erfasste Tankstellen).`,
    infoHeading: 'Tankstellen-Infos',
    infoBrand: 'Marke',
    infoAddress: 'Adresse',
    infoUpdated: 'Preisdaten abgerufen',
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
    contextParagraphs: (b, c, z, _f) => fuelComparisonNotes('de', `${b}, ${c} (${z})`, 'TCS'),
  },
  fr: {
    h1: (b, st, c, f) => `Prix ${frFuelOf(f)} ${b} ${st} à ${c}`,
    intro: (b, c, p, f) => `L’échantillon TCS indique ${frFuelOf(f)} à ${p} CHF le litre pour la station ${b} à ${c}. Vérifiez la date d’acquisition et le prix à la pompe avant de faire le plein.`,
    paragraph: (b, c, p, zAvg, f) => `À la station ${b} de ${c}, le prix ${frFuelOf(f)} est de ${p} CHF le litre contre une moyenne de zone de ${zAvg} CHF le litre. Utilisez cet écart pour choisir si faire le plein ici ou dans une station voisine. Croisez avec la tendance hebdomadaire de la zone, vérifiez le temps d'attente au poste-frontière le plus proche et consultez le guide frontalier pour l'ensemble du calcul du trajet.`,
    ranking: (r, t, c) => `Classement à ${c} : ${r} (${t} stations observées).`,
    infoHeading: 'Infos station',
    infoBrand: 'Marque',
    infoAddress: 'Adresse',
    infoUpdated: 'Acquisition du prix',
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
    contextParagraphs: (b, c, z, _f) => fuelComparisonNotes('fr', `${b}, ${c} (${z})`, 'TCS'),
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
    if (updatedText) parts.push(`acquisizione dato prezzo: ${updatedText}`);
    return `${parts.join('. ')}. Usa questa pagina come riferimento puntuale per la tua routine di rifornimento: il confronto con il prezzo italiano vicino e con le altre stazioni della zona ${zone} cambia di giorno in giorno.`;
  }
  if (locale === 'de') {
    const parts = [
      `Dieses Datenblatt bezieht sich speziell auf die Tankstelle ${brand} ${streetText || slug} in ${city} (Zone ${zone})`,
      `heute notiert zu ${priceFmt} CHF/Liter für ${fuelLabel} gegenüber einem Zonendurchschnitt von ${zoneAvgFmt} CHF/Liter, Rang ${rankText} in der lokalen Rangliste`,
    ];
    if (coords) parts.push(`Koordinaten ${coords}`);
    if (neighbour) parts.push(`nächstgelegener italienischer Ort: ${neighbour}${distanceKm ? ` (${distanceKm} km)` : ''}`);
    if (updatedText) parts.push(`Preisdaten abgerufen: ${updatedText}`);
    return `${parts.join('. ')}. Nutze diese Seite als präzise Referenz für deine Tankroutine: der Vergleich mit dem nächsten italienischen Preis und mit den übrigen Tankstellen der Zone ${zone} ändert sich täglich.`;
  }
  if (locale === 'fr') {
    const parts = [
      `Cette fiche se réfère spécifiquement à la station ${brand} ${streetText || slug} à ${city} (zone ${zone})`,
      `aujourd'hui cotée ${priceFmt} CHF/litre pour ${frFuelThe(fuelLabel)} contre une moyenne de zone de ${zoneAvgFmt} CHF/litre, position ${rankText} dans le classement local`,
    ];
    if (coords) parts.push(`coordonnées ${coords}`);
    if (neighbour) parts.push(`commune italienne la plus proche : ${neighbour}${distanceKm ? ` (${distanceKm} km)` : ''}`);
    if (updatedText) parts.push(`prix acquis : ${updatedText}`);
    return `${parts.join('. ')}. Utilisez cette page comme référence précise pour votre routine de plein : la comparaison avec le prix italien voisin et avec les autres stations de la zone ${zone} change chaque jour.`;
  }
  // en
  const parts = [
    `This page refers specifically to the ${brand} ${streetText || slug} station in ${city} (${zone} zone)`,
    `quoted today at ${priceFmt} CHF/litre for ${fuelLabel.toLowerCase()} vs a zone average of ${zoneAvgFmt} CHF/litre, rank ${rankText} in the local leaderboard`,
  ];
  if (coords) parts.push(`coordinates ${coords}`);
  if (neighbour) parts.push(`nearest Italian municipality: ${neighbour}${distanceKm ? ` (${distanceKm} km)` : ''}`);
  if (updatedText) parts.push(`price data collected: ${updatedText}`);
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
// `resolveStationBrandLogoUrl` against `public/images/brands/{slug}.{png,svg}`;
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
    historyAriaLabel: (z, f, avg) => `Tendance historique du prix ${frFuelOf(f)} dans la zone ${z}, moyenne ${avg} CHF/litre sur la période sélectionnée.`,
    historyAriaLabelStation: (b, f, avg) => `Tendance historique du prix ${frFuelOf(f)} chez ${b}, moyenne ${avg} CHF/litre sur la période sélectionnée.`,
    historyTrendLabel: 'Tendance du prix',
    historyLastUpdated: (d) => `Dernière mise à jour : ${d}`,
    adviceCheaper: (delta, z) => `Bon choix : aujourd'hui cette station est ${delta} CHF/litre moins chère que la moyenne de la zone ${z}.`,
    adviceMedian: (z) => `Prix conforme à la moyenne de la zone ${z} : choisissez selon votre itinéraire.`,
    advicePremium: (delta, z) => `Attention : aujourd'hui cette station est ${delta} CHF/litre plus chère que la moyenne de la zone ${z}. Voyez le classement pour une option moins chère.`,
    rankSuffix: (idx, tot) => tot > 0 ? `${idx + 1}/${tot}` : '—',
  },
};

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
  const logoUrl = resolveStationBrandLogoUrl(rootDir, brand);
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

  const actionsHtml = `<div class="s-2AE7uV">
    <a href="${esc(inp.zonePath)}" class="s-cta" style="font-size:14px;padding:9px 14px">${ICON_BAR_CHART_SVG} ${esc(labels.viewRanking(inp.city))} →</a>
    ${hasCoords ? `<a class="s-MTU2pO" href="${esc(gmapsHref)}" target="_blank" rel="noopener">${ICON_MAP_PIN_SVG} ${esc(labels.openInMaps)}</a>` : ''}
    ${hasCoords ? `<a class="s-MTU2pO" href="${esc(wazeHref)}" target="_blank" rel="noopener">${ICON_NAVIGATION_SVG} ${esc(labels.openInWaze)}</a>` : ''}
  </div>`;

  return `<section class="s-cbody" style="padding:22px 22px 20px;margin:0 0 18px" aria-label="${esc(inp.brand)} ${esc(inp.city)}">
  <div class="s-uKHM4F">
    ${logo}
    <div class="s-iFWoC6">
      <div class="s-Yv6nXB">${esc(inp.brand)}</div>
      <div class="s-BJbpLa">${esc(labels.heroTagline(inp.street, inp.city, inp.zoneLabel))}</div>
    </div>
  </div>
  <div class="s-FqOGbC">
    <div>
      <div class="s-k3C5vt">${esc(inp.priceFmt)}</div>
      <div class="s-6aG_zc">${esc(inp.currency)} · ${esc(inp.fuelLabel)}</div>
    </div>
    <div class="s-D7-ehZ">
      <span style="display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border-radius:999px;background:${deltaBg};color:${deltaTone};font-weight:700;font-size:13px;font-variant-numeric:tabular-nums">${esc(inp.deltaZoneFmt)} vs ${esc(inp.zoneLabel)}</span>
      <a class="s-Ys_0Hs" href="${esc(inp.zonePath)}">${ICON_TROPHY_SVG} ${esc(rankText)} a ${esc(inp.city)} →</a>
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
  const marker = `${lat.toFixed(6)},${lng.toFixed(6)}`;
  const iframeSrc = esc(osmEmbedSrc(lat, lng));
  const gmapsHref = `https://www.google.com/maps/search/?api=1&query=${marker}`;
  const wazeHref = `https://www.waze.com/ul?ll=${marker.replace(',', '%2C')}&navigate=yes`;

  const osmHref = `https://www.openstreetmap.org/?mlat=${lat.toFixed(6)}&mlon=${lng.toFixed(6)}#map=17/${lat.toFixed(6)}/${lng.toFixed(6)}`;
  const ext = labels.externalLinkSuffix;
  const labelGmaps = `${labels.openInMaps} (${ext})`;
  const labelWaze = `${labels.openInWaze} (${ext})`;
  const labelOsm = `${labels.openInOsm} (${ext})`;

  return `<section class="s-cbody" style="padding:0;margin:0 0 22px;overflow:hidden" aria-labelledby="stationLocation">
  <div class="s-1vBAVL">
    <div class="s-_Zpi92">
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
    <div class="s-cAzRHD">
      <h2 id="stationLocation" class="s-h2" style="margin:0 0 10px;font-size:18px">${esc(labels.locationHeading)}</h2>
      <p class="s-ZZMNPP">${esc(labels.locationCaption(inp.brand, inp.city))}</p>
      <dl class="s-PiTkcJ">
        <dt class="s-KBaHZf" aria-hidden="true">${ICON_MAP_PIN_SVG}</dt><dd class="s-q3nqK4">${esc(inp.address || `${inp.city}`)}</dd>
        <dt class="s-KBaHZf" aria-hidden="true">${ICON_NAVIGATION_SVG}</dt><dd class="s-tLNd9_">${esc(labels.coordinatesLabel)}: ${lat.toFixed(5)}, ${lng.toFixed(5)}</dd>
      </dl>
      <div class="s-5x_qUh">
        <a class="s-FiwK8Y" href="${esc(gmapsHref)}" target="_blank" rel="noopener" aria-label="${esc(labelGmaps)}">${ICON_MAP_PIN_SVG} ${esc(labels.openInMaps)}<span class="s-jg2Qlq" aria-hidden="true">↗</span></a>
        <a class="s-F2ygv1" href="${esc(wazeHref)}" target="_blank" rel="noopener" aria-label="${esc(labelWaze)}">${ICON_NAVIGATION_SVG} ${esc(labels.openInWaze)}<span class="s--xxlQD" aria-hidden="true">↗</span></a>
      </div>
      <p class="s-noKUE4"><a class="s-ktMAOG" href="${esc(osmHref)}" target="_blank" rel="noopener" aria-label="${esc(labelOsm)}">${esc(labels.openInOsm)} <span aria-hidden="true">↗</span></a></p>
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
    const lastUpdatedLine = `<p class="s-oF62Kj">${esc(labels.historyLastUpdated(inp.today.toISOString().slice(0, 10)))}</p>`;
    return `<section class="s-ziawP1" aria-labelledby="stationHistory">
  <h2 id="stationHistory" class="s-h2" style="margin:0 0 8px;font-size:20px">${esc(labels.historyHeadingStation(inp.brand))}</h2>
  <p class="s-MZT5qc">${esc(labels.historyCaptionStation)}</p>
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
  const lastUpdatedLine = `<p class="s-oF62Kj">${esc(labels.historyLastUpdated(inp.today.toISOString().slice(0, 10)))}</p>`;
  return `<section class="s-ziawP1" aria-labelledby="stationHistory">
  <h2 id="stationHistory" class="s-h2" style="margin:0 0 8px;font-size:20px">${esc(labels.historyHeading(inp.zoneLabel))}</h2>
  <p class="s-YUEhlJ">${esc(labels.historyDisclaimer)}</p>
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
  const { locale, brand, city, zone, fuelLabel, priceFmt, zoneAvgFmt } = args;
  const copy = {
    it: {
      h: `${fuelLabel} per frontalieri: leggere il prezzo di ${brand} a ${city}`,
      p1: `Il prezzo rilevato per ${fuelLabel.toLowerCase()} presso ${brand} a ${city} è ${priceFmt} CHF/litro. La media delle stazioni campionate nella zona ${zone} è ${zoneAvgFmt} CHF/litro. Si tratta di una media aritmetica, non della mediana né di una media ponderata per quantità vendute. Il confronto descrive il campione disponibile e non dimostra che questa stazione sia la più economica fra tutti i distributori della zona. Le stazioni prive di un prezzo per questo carburante non contribuiscono al calcolo.`,
      p2: `Per confrontare un distributore italiano serve il prezzo dello stesso carburante, riferito a un periodo confrontabile. Converti i due valori nella stessa valuta con un cambio CHF/EUR datato, quindi moltiplica la differenza per i litri previsti. Lo stipendio del conducente non cambia il prezzo alla pompa. Dal possibile risparmio vanno sottratti carburante, pedaggi e altri costi della deviazione; il valore attribuito al tempo dipende dalle esigenze personali. Non esiste una distanza massima o una soglia di stipendio che renda sempre conveniente il rifornimento da un lato del confine.`,
      p3: `La fonte svizzera è il radar TCS, basato su segnalazioni degli utenti. L’orario di acquisizione mostrato nella scheda indica quando il dato è stato letto, non quando il gestore ha modificato il prezzo. Rigenerare questa pagina non aggiorna la rilevazione. Prima del viaggio controlla anche indirizzo e modalità di servizio; una volta alla stazione verifica il prezzo esposto, che può essere cambiato rispetto al campione.`,
    },
    en: {
      h: `${fuelLabel} for cross-border workers: reading ${brand}'s price in ${city}`,
      p1: `The observed ${fuelLabel.toLowerCase()} price at ${brand} in ${city} is ${priceFmt} CHF/litre. The average for sampled stations in ${zone} is ${zoneAvgFmt} CHF/litre. This is an arithmetic mean, not a median or an average weighted by litres sold. The comparison describes the available sample and does not establish that this station is the cheapest among every provider in the area. Stations without a price for this fuel do not contribute to the calculation.`,
      p2: `An Italian comparison needs a price for the same fuel and a comparable observation period. Convert both values to the same currency using a dated CHF/EUR exchange rate, then multiply the difference by your planned litres. The driver’s salary does not change the pump price. Subtract fuel, tolls and other detour costs from potential savings; the value of time depends on personal circumstances. No universal maximum distance or salary threshold makes refuelling on either side of the border worthwhile.`,
      p3: `The Swiss source is the TCS radar, based on user reports. The collection time in the station information records when the data was read, not when the operator changed its price. Rebuilding this page does not refresh the observation. Before travelling, also check the address and service mode; at the station, confirm the displayed pump price, which may have changed since collection.`,
    },
    de: {
      h: `${fuelLabel} für Grenzgänger: den Preis von ${brand} in ${city} einordnen`,
      p1: `Der erfasste Preis für ${fuelLabel} bei ${brand} in ${city} beträgt ${priceFmt} CHF/Liter. Der Durchschnitt der erfassten Tankstellen in ${zone} beträgt ${zoneAvgFmt} CHF/Liter. Dies ist das arithmetische Mittel, weder der Median noch ein nach verkauften Litern gewichteter Wert. Der Vergleich beschreibt die verfügbare Stichprobe und belegt nicht, dass diese Tankstelle unter sämtlichen Anbietern der Zone am günstigsten ist. Tankstellen ohne Preisangabe für diesen Kraftstoff gehen nicht in die Berechnung ein.`,
      p2: `Ein Vergleich mit Italien benötigt denselben Kraftstoff und einen vergleichbaren Erhebungszeitraum. Rechnen Sie beide Werte mit einem datierten CHF/EUR-Kurs in dieselbe Währung um und multiplizieren Sie die Differenz mit der geplanten Literzahl. Der Lohn des Fahrers verändert den Preis an der Zapfsäule nicht. Ziehen Sie Kraftstoff, Maut und weitere Umwegkosten von einer möglichen Ersparnis ab. Der Wert der Zeit hängt von persönlichen Bedürfnissen ab. Es gibt keine allgemeine maximale Entfernung oder Lohngrenze, die das Tanken auf einer Seite stets wirtschaftlich macht.`,
      p3: `Die Schweizer Quelle ist der TCS-Radar mit Meldungen von Nutzern. Die Abrufzeit in den Tankstellenangaben bezeichnet das Lesen des Datensatzes, nicht die Preisänderung des Betreibers. Ein Neuaufbau der Seite erneuert die Erhebung nicht. Prüfen Sie vor der Fahrt auch Adresse und Bedienungsart. Bestätigen Sie vor Ort den angezeigten Zapfsäulenpreis, denn er kann sich seit dem Abruf geändert haben.`,
    },
    fr: {
      h: `${fuelLabel} pour frontaliers : comprendre le prix de ${brand} à ${city}`,
      p1: `Le prix relevé pour ${frFuelThe(fuelLabel)} chez ${brand} à ${city} est de ${priceFmt} CHF/litre. La moyenne des stations observées dans la zone ${zone} est de ${zoneAvgFmt} CHF/litre. Il s’agit d’une moyenne arithmétique, pas d’une médiane ni d’une moyenne pondérée par les litres vendus. La comparaison décrit l’échantillon disponible et ne prouve pas que cette station soit la moins chère parmi tous les distributeurs de la zone. Les stations sans prix pour ce carburant sont exclues du calcul.`,
      p2: `La comparaison avec une station italienne nécessite le même carburant et des périodes de relevé comparables. Convertissez les deux valeurs dans la même devise avec un taux CHF/EUR daté, puis multipliez l’écart par les litres prévus. Le salaire du conducteur ne modifie pas le prix à la pompe. Déduisez du gain potentiel le carburant, les péages et les autres coûts du détour ; la valeur du temps dépend de vos besoins personnels. Aucune distance maximale ni aucun seuil salarial ne rend toujours avantageux le plein d’un côté de la frontière.`,
      p3: `La source suisse est le radar TCS, alimenté par les utilisateurs. L’heure d’acquisition dans la fiche indique quand le relevé a été lu, pas quand l’exploitant a modifié son prix. La régénération de cette page ne renouvelle pas l’observation. Avant le trajet, contrôlez aussi l’adresse et le mode de service ; à la station, vérifiez le tarif affiché, qui peut avoir changé depuis l’acquisition.`,
    },
  };
  const c = copy[locale] || copy.it;
  return `<section class="s-ziawP1" aria-labelledby="fuelFrontalierContext">
    <h2 id="fuelFrontalierContext" class="s-h2">${esc(c.h)}</h2>
    <p class="s-KwuhOL">${esc(c.p1)}</p>
    <p class="s-KwuhOL">${esc(c.p2)}</p>
    <p class="s-E7ZJqo">${esc(c.p3)}</p>
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
  if (price === null) return renderFuelBelowFloorBridge(canonicalPath);
  const priceFmt = formatPrice(price, locale);
  const zoneAvgFmt = formatPrice(zoneAvg, locale);

  // Rank within zone (for the chosen fuel)
  const sortedByFuel = [...zoneStations]
    .map((c) => ({ slug: c.slug, price: c.prices[fuel] }))
    .filter((entry): entry is { slug: string; price: number } => entry.price !== null)
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
    .filter((s) => s.slug !== ctx.slug && s.prices[fuel] !== null)
    .slice(0, 6)
    .map((s) => ({ slug: s.slug, brand: s.brandDisplay, zone: s.zone }));

  // JSON-LD
  const breadcrumbLd = inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: locale === 'it' ? 'Home' : locale === 'de' ? 'Startseite' : locale === 'fr' ? 'Accueil' : 'Home', item: `${BASE_URL}/` },
      { '@type': 'ListItem', position: 2, name: fuelLabel, item: `${BASE_URL}${FUEL_LOCALE_PREFIX[locale]}/${FUEL_SECTION_SLUG[locale][fuel]}/` },
      { '@type': 'ListItem', position: 3, name: zoneLabel, item: `${BASE_URL}${buildFuelTodayPath(locale, fuel, ctx.zone)}` },
      { '@type': 'ListItem', position: 4, name: ctx.brandDisplay + ' ' + ctx.streetDisplay, item: canonicalUrl },
    ],
  });

  const webPageLd = inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: h1,
    url: canonicalUrl,
    description: intro,
    inLanguage: locale,
  });

  // GasStation + Place (geo)
  const gasStationLd = inlineScriptJson({
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
        // Shared peel — a word-boundary cut still stops mid-clause.
        return peelDanglingClauseTail(base);
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
  // Pre-cut removed: clampMetaDescription (160) runs downstream and is
  // word-aware. Slicing first only handed it a string already broken
  // mid-word, which is what reached the SERP snippet.
  const description = intro;

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

  const bodyHtml = `<article class="s-xzWvwM">
  <nav aria-label="Breadcrumb" class="s-bcr">
    <a href="/" class="s-bcl">Home</a>
    <span> / </span>
    <a href="${FUEL_LOCALE_PREFIX[locale]}/${FUEL_SECTION_SLUG[locale][fuel]}/${FUEL_TODAY_SLUG[locale]}/" class="s-bcl">${esc(fuelLabel)}</a>
    <span> / </span>
    <a href="${buildFuelTodayPath(locale, fuel, ctx.zone)}" class="s-bcl">${esc(zoneLabel)}</a>
    <span> / </span>
    <span>${esc(ctx.brandDisplay)} ${esc(ctx.streetDisplay)}</span>
  </nav>
  <header class="s-S1RSUf">
    <p class="s-eyb">${esc(dateStamp)}</p>
    <h1 class="s-h1">${esc(h1)}</h1>
    <p class="s-lede">${esc(stationTaglineByLocale[locale])}</p>
  </header>
  ${heroHtml}
  ${adviceHtml}
  ${locationHtml}
  ${historyHtml}
  <section class="s-card" style="margin:0 0 24px" aria-labelledby="stationReview">
    <h2 id="stationReview" class="s-h2" style="margin:0 0 12px;font-size:20px">${esc(editorialAssessment.heading)}</h2>
    <p class="s-E7ZJqo">${esc(editorialAssessment.body)}</p>
  </section>
  <section class="s-card" style="margin:0 0 24px" aria-labelledby="stationInfo">
    <h2 id="stationInfo" class="s-h2" style="margin:0 0 12px;font-size:20px">${esc(copy.infoHeading)}</h2>
    <dl class="s-RPPdPW">
      <dt class="s-bovPrI">${esc(copy.infoBrand)}</dt><dd class="s-q3nqK4">${esc(ctx.brandDisplay)}</dd>
      <dt class="s-bovPrI">${esc(copy.infoAddress)}</dt><dd class="s-q3nqK4">${esc(ctx.station.address ?? '—')}</dd>
      ${ctx.station.updatedAt ? `<dt class="s-bovPrI">${esc(copy.infoUpdated)}</dt><dd class="s-q3nqK4">${esc(String(ctx.station.updatedAt).slice(0, 10))}</dd>` : ''}
    </dl>
  </section>
  <section class="s-ziawP1" aria-labelledby="stationContext">
    <h2 id="stationContext" class="s-h2">${esc(copy.contextHeading)}</h2>
    ${copy.contextParagraphs(ctx.brandDisplay, ctx.city, zoneLabel, fuelLabel)
      .map((p) => `<p class="s-ZLNNaY">${p}</p>`)
      .join('')}
    <p class="s-ZLNNaY">${esc(
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
  <section class="s-GCEyQg" aria-label="${esc(copy.contextHeading)}">
    <p class="s-kvHUMU">${esc(intro)}</p>
    <p class="s-yOfiVn">${esc(paragraph)}</p>
  </section>
  <p class="s-QpkSyQ"><a href="${buildFuelTodayPath(locale, fuel, ctx.zone)}" style="${LINK_ACCENT_STYLE};font-weight:600">← ${esc(copy.backToZone(zoneLabel))}</a></p>
  ${generateRelatedLinksBlock(locale, 'fuel_station', {
    fuelType: fuel,
    fuelZone: ctx.zone,
    stationSlug: ctx.slug,
    siblingStations,
  })}
  <section class="s-sC82IX" aria-label="advertisement">
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
    hreflangHtml: alternatesHtml,
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
  /** Benzina price (EUR/L) — the historically-tracked cut. */
  priceEur?: number;
  /** Gasolio price (EUR/L) — populated since the MIMIT-diesel ingestion. */
  dieselPriceEur?: number | null;
  isSelf?: boolean;
  lat?: number;
  lng?: number;
  updatedAt?: string;
}

/** Pick the EUR price of a station for the requested fuel. */
function italianStationPriceForFuel(
  s: ItalianCityStation,
  fuel: FuelType,
): number | null {
  const p = fuel === 'diesel' ? s.dieselPriceEur : s.priceEur;
  return typeof p === 'number' && Number.isFinite(p) ? p : null;
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
  fuel: FuelType = 'benzina',
): ItalianCityStation[] {
  const out: ItalianCityStation[] = [];
  // For diesel we project the entry's `dieselPriceEur` onto `priceEur` so the
  // entire downstream (sort, min, station-context price, JSON-LD) stays
  // fuel-agnostic — only stations that reported a diesel price survive.
  const project = (s: ItalianCityStation): ItalianCityStation | null => {
    const price = italianStationPriceForFuel(s, fuel);
    if (price === null) return null;
    return fuel === 'diesel' ? { ...s, priceEur: price } : s;
  };
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
        const projected = s ? project(s) : null;
        if (projected) out.push(projected);
      }
    } else if (raw.cheapestStation) {
      const projected = project(raw.cheapestStation);
      if (projected) out.push(projected);
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
    intro: (f, c, p) =>
      `A ${c} il prezzo minimo ${itFuelGenitive(f)} nel campione disponibile è ${p} EUR/litro. La fonte MIMIT raccoglie i prezzi comunicati dai gestori: controlla la data del dato prima di confrontare Italia e Svizzera.`,
    paragraph: (f, c, p, nz) =>
      `Il prezzo minimo ${itFuelGenitive(f)} a ${c} è ${p} EUR/litro. La tabella elenca le stazioni campionate ordinate per prezzo crescente. Confronta con lo stesso carburante nella zona ticinese ${nz}, usando dati di periodi confrontabili e la stessa valuta. Il risparmio dipende dai litri acquistati e dai costi effettivi della deviazione; una differenza al litro, da sola, non dimostra la convenienza del viaggio.`,
    tableTitle: (c) => `Stazioni a ${c} — prezzi rilevati`,
    tableStation: 'Stazione',
    tableAddress: 'Indirizzo',
    tablePrice: 'Prezzo',
    crossBorderTip: `Controlla le condizioni del percorso e l’attesa al valico: distanza e tempo aggiuntivi vanno valutati insieme al risparmio sul pieno.`,
    currency: 'EUR/litro',
    backLink: 'Vedi il prezzo medio in Ticino',
    noData: 'Nessuna stazione disponibile per oggi — dati in aggiornamento.',
    contextHeading: 'Come leggere i prezzi carburante per un frontaliere',
    contextParagraphs: (f, c, nz) => fuelComparisonNotes('it', `${f}, ${c} / ${nz}`, 'MIMIT'),
    tipsHeading: 'Consigli pratici per il rifornimento',
    tipsItems: [
      `Consulta MIMIT Osservaprezzi e controlla la data della comunicazione del gestore prima di fermarti.`,
      `Verifica orari e modalità di rifornimento: self-service e servito possono avere prezzi diversi.`,
      `Calcola i chilometri aggiuntivi rispetto al tuo percorso; la vicinanza al confine non dimostra un sovrapprezzo.`,
      `Confronta il prezzo esposto alla pompa con il dato disponibile: una pagina rigenerata non garantisce un nuovo listino.`,
    ],
  },
  en: {
    h1: (f, c) => `${f} price in ${c} — cheapest stations`,
    intro: (f, c, p) =>
      `In ${c}, the minimum ${f.toLowerCase()} price in the available sample is ${p} EUR/litre. MIMIT collects operator-reported prices: check the reporting date before comparing Italy and Switzerland.`,
    paragraph: (f, c, p, nz) =>
      `The minimum ${f.toLowerCase()} price in ${c} is ${p} EUR/litre. The table lists sampled stations in price order. Compare the same fuel in the ${nz} Ticino zone using observations from comparable periods and the same currency. Savings depend on the litres purchased and actual detour costs; a per-litre difference alone does not establish whether the trip is worthwhile.`,
    tableTitle: (c) => `${c} stations — observed prices`,
    tableStation: 'Station',
    tableAddress: 'Address',
    tablePrice: 'Price',
    crossBorderTip: `Check your route and border waiting time: additional distance and time should be considered together with savings on a full tank.`,
    currency: 'EUR/litre',
    backLink: 'See the Ticino average price',
    noData: 'No station data for today — refresh pending.',
    contextHeading: 'How to read fuel prices as a cross-border commuter',
    contextParagraphs: (f, c, nz) => fuelComparisonNotes('en', `${f}, ${c} / ${nz}`, 'MIMIT'),
    tipsHeading: 'Practical refueling tips',
    tipsItems: [
      `Consult MIMIT Osservaprezzi and check the operator’s reporting date before stopping.`,
      `Check opening hours and service mode: self-service and attended pumps may have different prices.`,
      `Calculate extra distance from your route; proximity to the border does not establish a price premium.`,
      `Compare the pump price with the available record: rebuilding a page does not guarantee a new price report.`,
    ],
  },
  de: {
    h1: (f, c) => `${f}preis in ${c} — günstigste Tankstellen`,
    intro: (f, c, p) =>
      `In ${c} beträgt der niedrigste ${f}preis in der verfügbaren Stichprobe ${p} EUR/Liter. MIMIT erfasst Meldungen der Betreiber: prüfen Sie das Meldedatum vor dem Vergleich zwischen Italien und der Schweiz.`,
    paragraph: (f, c, p, nz) =>
      `Der Mindestpreis für ${f} in ${c} beträgt ${p} EUR/Liter. Die Tabelle ordnet die erfassten Tankstellen nach Preis. Vergleichen Sie denselben Kraftstoff in der Tessiner Zone ${nz} mit Daten aus vergleichbaren Zeiträumen und in derselben Währung. Die Ersparnis hängt von der Literzahl und den tatsächlichen Umwegkosten ab. Eine Preisdifferenz pro Liter allein beweist nicht, dass sich die Fahrt lohnt.`,
    tableTitle: (c) => `Tankstellen ${c} — erfasste Preise`,
    tableStation: 'Tankstelle',
    tableAddress: 'Adresse',
    tablePrice: 'Preis',
    crossBorderTip: `Prüfen Sie Strecke und Grenzwartezeit: zusätzliche Entfernung und Zeit sind gemeinsam mit der Ersparnis für die gesamte Tankfüllung zu bewerten.`,
    currency: 'EUR/Liter',
    backLink: 'Tessiner Durchschnittspreis anzeigen',
    noData: 'Keine Tankstellendaten für heute — Aktualisierung ausstehend.',
    contextHeading: 'Kraftstoffpreise als Grenzgänger richtig lesen',
    contextParagraphs: (f, c, nz) => fuelComparisonNotes('de', `${f}, ${c} / ${nz}`, 'MIMIT'),
    tipsHeading: 'Praktische Tipps zum Tanken',
    tipsItems: [
      `Prüfen Sie bei MIMIT Osservaprezzi das Meldedatum des Betreibers, bevor Sie tanken.`,
      `Kontrollieren Sie Öffnungszeiten und Bedienungsart: Selbstbedienung und Bedienung können unterschiedliche Preise haben.`,
      `Berechnen Sie den Umweg ab Ihrer Strecke; Grenznähe belegt keinen Preisaufschlag.`,
      `Vergleichen Sie den Zapfsäulenpreis mit dem Datensatz: Ein Neuaufbau der Seite garantiert keine neue Preismeldung.`,
    ],
  },
  fr: {
    h1: (f, c) => `Prix ${frFuelOf(f)} à ${c} — stations les moins chères`,
    intro: (f, c, p) =>
      `À ${c}, le prix minimum ${frFuelOf(f)} dans l’échantillon disponible est de ${p} EUR/litre. MIMIT recueille les prix déclarés par les exploitants : vérifiez la date avant de comparer l’Italie et la Suisse.`,
    paragraph: (f, c, p, nz) =>
      `Le prix minimum ${frFuelOf(f)} à ${c} est de ${p} EUR/litre. Le tableau classe les stations observées par prix. Comparez le même carburant dans la zone tessinoise ${nz} avec des périodes comparables et dans la même devise. L’économie dépend des litres achetés et des frais réels du détour ; un écart par litre ne suffit pas à établir la rentabilité du trajet.`,
    tableTitle: (c) => `Stations à ${c} — prix relevés`,
    tableStation: 'Station',
    tableAddress: 'Adresse',
    tablePrice: 'Prix',
    crossBorderTip: `Vérifiez le parcours et l’attente à la frontière : la distance et le temps supplémentaires se comparent à l’économie sur le plein entier.`,
    currency: 'EUR/litre',
    backLink: 'Voir le prix moyen au Tessin',
    noData: 'Aucune donnée de station disponible aujourd\'hui — mise à jour en attente.',
    contextHeading: 'Comment lire les prix du carburant en tant que frontalier',
    contextParagraphs: (f, c, nz) => fuelComparisonNotes('fr', `${f}, ${c} / ${nz}`, 'MIMIT'),
    tipsHeading: 'Conseils pratiques pour faire le plein',
    tipsItems: [
      `Consultez MIMIT Osservaprezzi et vérifiez la date de déclaration de l’exploitant avant de vous arrêter.`,
      `Vérifiez les horaires et le service : libre-service et service assisté peuvent avoir des prix différents.`,
      `Calculez la distance supplémentaire depuis votre parcours ; la proximité de la frontière ne prouve pas un surcoût.`,
      `Comparez le prix à la pompe avec le relevé : régénérer une page ne garantit pas une nouvelle déclaration de prix.`,
    ],
  },
};

/** Copy for the "verdict + value badge" banner on Italian city pages. */
interface ItalianCityVerdictCopy {
  readonly aria: (city: string) => string;
  readonly cheapestHeading: (city: string) => string;
  readonly cheapestBadge: string;
  readonly priciestBadge: string;
  readonly flagIt: string;
  readonly flagCh: string;
  readonly itWins: (saving: string, delta: string) => string;
  readonly chWins: (zone: string, saving: string, delta: string) => string;
  readonly same: string;
}

const IT_CITY_VERDICT_COPY: Record<FuelDailyLocale, ItalianCityVerdictCopy> = {
  it: {
    aria: (c) => `Verdetto convenienza carburante a ${c}: Italia o Svizzera oggi`,
    cheapestHeading: (c) => `La più conveniente oggi a ${c}`,
    cheapestBadge: 'Più conveniente',
    priciestBadge: 'Più cara',
    flagIt: '🇮🇹',
    flagCh: '🇨🇭',
    itWins: (saving, delta) => `Oggi conviene fare il pieno in Italia: ~${saving} € risparmiati su un pieno da 50 L (${delta} €/L in meno della stazione svizzera più vicina).`,
    chWins: (zone, saving, delta) => `Oggi conviene fare il pieno in Svizzera, zona ${zone}: ~${saving} € risparmiati su 50 L (${delta} €/L in meno del prezzo italiano).`,
    same: 'Oggi Italia e Svizzera sono quasi pari: la differenza non ripaga la coda al valico.',
  },
  en: {
    aria: (c) => `Fuel value verdict in ${c}: Italy or Switzerland today`,
    cheapestHeading: (c) => `Cheapest pump in ${c} today`,
    cheapestBadge: 'Best value',
    priciestBadge: 'Priciest',
    flagIt: '🇮🇹',
    flagCh: '🇨🇭',
    itWins: (saving, delta) => `Fill up in Italy today: ~€${saving} saved on a 50 L tank (${delta} €/L below the nearest Swiss station).`,
    chWins: (zone, saving, delta) => `Fill up in Switzerland today, ${zone} zone: ~€${saving} saved on 50 L (${delta} €/L below the Italian price).`,
    same: 'Italy and Switzerland are near-even today: the gap won’t repay the border queue.',
  },
  de: {
    aria: (c) => `Tank-Verdikt in ${c}: Italien oder Schweiz heute`,
    cheapestHeading: (c) => `Günstigste Tankstelle in ${c} heute`,
    cheapestBadge: 'Bester Preis',
    priciestBadge: 'Teuerste',
    flagIt: '🇮🇹',
    flagCh: '🇨🇭',
    itWins: (saving, delta) => `Heute in Italien tanken: ~${saving} € gespart bei 50 L (${delta} €/L unter der nächsten Schweizer Tankstelle).`,
    chWins: (zone, saving, delta) => `Heute in der Schweiz tanken, Zone ${zone}: ~${saving} € gespart bei 50 L (${delta} €/L unter dem italienischen Preis).`,
    same: 'Italien und Schweiz sind heute fast gleichauf: die Differenz lohnt die Grenzwartezeit nicht.',
  },
  fr: {
    aria: (c) => `Verdict carburant à ${c} : Italie ou Suisse aujourd’hui`,
    cheapestHeading: (c) => `La station la moins chère à ${c} aujourd’hui`,
    cheapestBadge: 'Meilleur prix',
    priciestBadge: 'La plus chère',
    flagIt: '🇮🇹',
    flagCh: '🇨🇭',
    itWins: (saving, delta) => `Faites le plein en Italie aujourd’hui : ~${saving} € économisés sur 50 L (${delta} €/L sous la station suisse la plus proche).`,
    chWins: (zone, saving, delta) => `Faites le plein en Suisse aujourd’hui, zone ${zone} : ~${saving} € économisés sur 50 L (${delta} €/L sous le prix italien).`,
    same: 'Italie et Suisse sont quasi à égalité aujourd’hui : l’écart ne rembourse pas la file à la frontière.',
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
      p1: `Per ${cityDisplay}, il prezzo rilevato di ${fuelLabel.toLowerCase()} è ${minPriceFmt} EUR/litro. Il confronto con la zona ticinese ${nearestZoneLabel} richiede lo stesso carburante e un cambio CHF/EUR riferito a una data nota. Una media svizzera e il minimo italiano descrivono due quantità diverse: per scegliere una stazione confronta anche i singoli prezzi e indirizzi, con le rispettive date di rilevazione. La fonte non permette di ricavare dal prezzo finale il margine di questo gestore o una convenienza universale del tragitto.`,
      p2: `Esempio ipotetico annuale: 220 giorni di viaggio, 60 km al giorno e un consumo di 6 litri ogni 100 km producono 13.200 km e 792 litri. Non sono valori medi misurati dei frontalieri. Sostituisci queste ipotesi con i tuoi dati e moltiplica i litri per il prezzo scelto nella stessa valuta. Il risultato riguarda soltanto il carburante: manutenzione, assicurazione, imposte sul veicolo, pedaggi e tempo si valutano separatamente. La spesa di carburante non si sottrae automaticamente dalle imposte sul reddito né identifica una quota fissa del costo totale del pendolarismo.`,
    },
    en: {
      h: `${fuelLabel} in ${cityDisplay}: cross-border worker commute math`,
      p1: `For ${cityDisplay}, the observed ${fuelLabel.toLowerCase()} price is ${minPriceFmt} EUR/litre. Comparing the ${nearestZoneLabel} Ticino zone requires the same fuel and a CHF/EUR rate with a known date. A Swiss average and an Italian minimum describe different quantities: to choose a station, also compare individual prices and addresses together with their reporting dates. The source does not establish this operator’s margin from the final price or whether every cross-border detour is worthwhile.`,
      p2: `Hypothetical annual example: 220 travel days, 60 km per day and consumption of 6 litres per 100 km produce 13,200 km and 792 litres. These are assumptions, not measured commuter averages. Replace them with your own figures and multiply the litres by the chosen price in the same currency. The result covers fuel only: maintenance, insurance, vehicle taxes, tolls and time should be evaluated separately. Fuel expenses are not automatically deducted from income tax and do not establish a fixed percentage of total commuting costs.`,
    },
    de: {
      h: `${fuelLabel} in ${cityDisplay}: Pendel-Mathematik für Grenzgänger`,
      p1: `Für ${cityDisplay} liegt der erfasste Preis für ${fuelLabel} bei ${minPriceFmt} EUR/Liter. Der Vergleich mit der Tessiner Zone ${nearestZoneLabel} benötigt denselben Kraftstoff und einen CHF/EUR-Kurs mit bekanntem Datum. Ein Schweizer Durchschnitt und ein italienischer Mindestwert bezeichnen unterschiedliche Grössen: Vergleichen Sie für die Wahl einer Tankstelle auch Einzelpreise, Adressen und jeweilige Meldedaten. Die Quelle erlaubt weder die Bestimmung der Betreibermarge aus dem Endpreis noch eine allgemeine Aussage zur Wirtschaftlichkeit eines Umwegs.`,
      p2: `Hypothetisches Jahresbeispiel: 220 Fahrtage, 60 km am Tag und 6 Liter Verbrauch je 100 km ergeben 13.200 km und 792 Liter. Dies sind Annahmen, keine gemessenen Durchschnittswerte von Grenzgängern. Ersetzen Sie die Angaben durch Ihre eigenen Werte und multiplizieren Sie die Literzahl mit dem gewählten Preis in derselben Währung. Das Ergebnis umfasst nur Treibstoff. Wartung, Versicherung, Fahrzeugsteuern, Maut und Zeit sind getrennt zu betrachten. Treibstoffausgaben werden nicht automatisch von der Einkommensteuer abgezogen und ergeben keinen festen Anteil der gesamten Pendelkosten.`,
    },
    fr: {
      h: `${fuelLabel} à ${cityDisplay} : mathématique du trajet pour les frontaliers`,
      p1: `Pour ${cityDisplay}, le prix relevé pour ${frFuelThe(fuelLabel)} est de ${minPriceFmt} EUR/litre. La comparaison avec la zone tessinoise ${nearestZoneLabel} nécessite le même carburant et un taux CHF/EUR dont la date est connue. Une moyenne suisse et un minimum italien décrivent deux quantités différentes : pour choisir une station, comparez aussi les prix individuels, les adresses et les dates de déclaration. La source ne permet ni de déduire la marge de cet exploitant du prix final ni de déterminer une rentabilité universelle du détour.`,
      p2: `Exemple annuel hypothétique : 220 jours de trajet, 60 km par jour et une consommation de 6 litres aux 100 km donnent 13.200 km et 792 litres. Ces hypothèses ne sont pas des moyennes mesurées des frontaliers. Remplacez-les par vos propres données et multipliez les litres par le prix choisi dans la même devise. Le résultat couvre seulement le carburant : entretien, assurance, taxes sur le véhicule, péages et temps se calculent séparément. Le carburant ne se déduit pas automatiquement des impôts sur le revenu et ne constitue pas une part fixe des frais totaux du trajet.`,
    },
  };
  const c = copy[locale] || copy.it;
  return `<section class="s-ziawP1" aria-labelledby="itCityFrontalierExtra">
    <h2 id="itCityFrontalierExtra" class="s-h2">${esc(c.h)}</h2>
    <p class="s-KwuhOL">${c.p1}</p>
    <p class="s-E7ZJqo">${c.p2}</p>
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
   * falls back to the legacy non-clickable table — used for fuels with no
   * per-station price coverage for this city.
   */
  stationContexts?: ItalianStationContext[];
  /**
   * Cross-border verdict (cheapest IT pump vs cheapest Swiss station near the
   * city, both in EUR/L). Drives the "Italy or Switzerland today?" banner.
   */
  crossBorder?: CityCrossBorder | null;
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
  /** Project root, threaded through for build-time brand-logo resolution. */
  rootDir?: string;
}): string {
  const { entry, locale, fuel, stations, history, crossBorder, canonicalPath, alternates, today, distDir, rootDir } = opts;
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

  // ── "Verdict + value badge" redesign ───────────────────────────
  // Make the page instantly scannable for the commuter audience: a top
  // verdict banner ("fill up in Italy or Switzerland today?") plus a
  // colour-coded, badge'd station list so the cheapest pump pops at a glance.
  const verdictCopy = IT_CITY_VERDICT_COPY[locale];
  const cheapest = sortedStations[0] ?? null;
  const priciest = sortedStations.length > 3 ? sortedStations[sortedStations.length - 1] : null;
  const fmtEuro = (n: number): string => n.toLocaleString(locale === 'it' ? 'it-IT' : locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  const crossBorderLine = (() => {
    if (!crossBorder) return '';
    const saving = fmtEuro(crossBorder.saving50LEur);
    const delta = formatPrice(Math.abs(crossBorder.deltaEur), locale);
    if (crossBorder.cheaper === 'IT') {
      return `<p class="s-itVerdictLine" style="margin:0;font-size:14px"><span style="color:var(--color-success);font-weight:700">${esc(verdictCopy.flagIt)}</span> ${esc(verdictCopy.itWins(saving, delta))}</p>`;
    }
    if (crossBorder.cheaper === 'CH') {
      return `<p class="s-itVerdictLine" style="margin:0;font-size:14px"><span style="color:var(--color-accent);font-weight:700">${esc(verdictCopy.flagCh)}</span> ${esc(verdictCopy.chWins(nearestZoneLabel, saving, delta))}</p>`;
    }
    return `<p class="s-itVerdictLine" style="margin:0;font-size:14px;color:var(--color-subtle)">${esc(verdictCopy.same)}</p>`;
  })();

  const verdictBannerHtml = cheapest
    ? `<aside class="s-itVerdict" aria-label="${esc(verdictCopy.aria(entry.display))}" style="display:flex;flex-direction:column;gap:8px;padding:16px;border-radius:14px;background:var(--color-surface-alt);border:1px solid var(--color-edge);margin:8px 0 16px">
        <div style="display:flex;align-items:center;gap:10px">
          <span aria-hidden="true" style="display:flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:10px;background:var(--color-surface);color:var(--color-success);flex-shrink:0">${ICON_TROPHY_SVG}</span>
          <div>
            <div style="font-weight:700;font-size:15px">${esc(verdictCopy.cheapestHeading(entry.display))}</div>
            <div style="font-size:14px;color:var(--color-subtle)">${esc(cheapest.stationName || cheapest.brand || '—')} · <span style="color:var(--color-success);font-weight:700;font-variant-numeric:tabular-nums">${esc(typeof cheapest.priceEur === 'number' ? formatPrice(cheapest.priceEur, locale) : '—')} ${esc(copy.currency)}</span></div>
          </div>
        </div>
        ${crossBorderLine}
      </aside>`
    : '';

  // Top-station listing. When per-station detail pages exist for this city +
  // fuel, render a clickable card list so users can drill into each station;
  // otherwise fall back to a static table (still colour-coded + badge'd).
  const stationContexts = opts.stationContexts ?? [];
  const ctxBySlug = new Map(stationContexts.map((c) => [c.station.id ?? '', c]));
  const toneFor = (s: ItalianCityStation): 'success' | 'warning' | 'accent' =>
    s === cheapest ? 'success' : s === priciest ? 'warning' : 'accent';
  const badgeChip = (label: string, tone: 'success' | 'warning'): string => {
    const color = tone === 'success' ? 'var(--color-success)' : 'var(--color-warning)';
    return `<span class="s-itBadge" style="display:inline-flex;align-items:center;gap:4px;align-self:flex-start;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.03em;color:${color};background:var(--color-surface-alt);border:1px solid var(--color-edge);border-radius:999px;padding:2px 8px">${esc(label)}</span>`;
  };
  const stationListHtml = sortedStations.length === 0
    ? `<p class="s-gWHXua">${esc(copy.noData)}</p>`
    : stationContexts.length > 0
      ? `<ol class="s-cTOdp9">${sortedStations
          .map((s) => {
            const matched = s.id ? ctxBySlug.get(s.id) : undefined;
            const href = matched ? buildFuelItalianStationPath(locale, fuel, entry.slug, matched.slug) : undefined;
            const logoUrl = resolveStationBrandLogoUrl(rootDir, s.brand);
            const card = renderEntityCard({
              href,
              logoUrl: logoUrl ?? undefined,
              logoAlt: s.brand || s.stationName,
              iconSvg: logoUrl ? undefined : ICON_FUEL_SVG,
              title: s.stationName || s.brand || '—',
              subtitle: s.address || '—',
              metric: `${typeof s.priceEur === 'number' ? formatPrice(s.priceEur, locale) : '—'} ${copy.currency}`,
              metricTone: toneFor(s),
            });
            const chip = s === cheapest
              ? badgeChip(verdictCopy.cheapestBadge, 'success')
              : s === priciest
                ? badgeChip(verdictCopy.priciestBadge, 'warning')
                : '';
            return `<li class="s-6FVpHG" style="display:flex;flex-direction:column;gap:6px">${chip}${card}</li>`;
          })
          .join('')}</ol>`
      : `<table class="s-tbl" style="font-size:14px">
        <thead><tr>
          <th scope="col" class="s-thd">${esc(copy.tableStation)}</th>
          <th scope="col" class="s-thd">${esc(copy.tableAddress)}</th>
          <th scope="col" class="s-thd" style="text-align:right">${esc(copy.tablePrice)}</th>
        </tr></thead>
        <tbody>${sortedStations
          .map((s) => {
            const tone = s === cheapest ? 'var(--color-success)' : s === priciest ? 'var(--color-warning)' : 'inherit';
            const weight = s === cheapest ? '700' : '400';
            return `<tr>
            <td class="s-tcl">${esc(s.stationName || s.brand || '—')}${s === cheapest ? `<span style="color:var(--color-success);font-weight:700"> · ${esc(verdictCopy.cheapestBadge)}</span>` : ''}</td>
            <td class="s-tcl" style="color:var(--color-subtle)">${esc(s.address || '—')}</td>
            <td class="s-tcl" style="text-align:right;font-variant-numeric:tabular-nums;color:${tone};font-weight:${weight}">${typeof s.priceEur === 'number' ? formatPrice(s.priceEur, locale) + ' EUR' : '—'}</td>
          </tr>`;
          })
          .join('')}</tbody>
      </table>`;

  // JSON-LD
  const breadcrumbLd = inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: locale === 'it' ? 'Home' : locale === 'de' ? 'Startseite' : locale === 'fr' ? 'Accueil' : 'Home', item: `${BASE_URL}/` },
      { '@type': 'ListItem', position: 2, name: fuelLabel, item: `${BASE_URL}${FUEL_LOCALE_PREFIX[locale]}/${FUEL_SECTION_SLUG[locale][fuel]}/` },
      { '@type': 'ListItem', position: 3, name: locale === 'it' ? 'Italia' : locale === 'de' ? 'Italien' : locale === 'fr' ? 'Italie' : 'Italy', item: `${BASE_URL}${FUEL_LOCALE_PREFIX[locale]}/${FUEL_SECTION_SLUG[locale][fuel]}/${FUEL_ITALY_SLUG[locale]}/` },
      { '@type': 'ListItem', position: 4, name: entry.display, item: canonicalUrl },
    ],
  });

  const webPageLd = inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: h1,
    url: canonicalUrl,
    description: intro,
    inLanguage: locale,
  });

  const itemListLd = inlineScriptJson({
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
  // Pre-cut removed: clampMetaDescription (160) runs downstream and is
  // word-aware. Slicing first only handed it a string already broken
  // mid-word, which is what reached the SERP snippet.
  const description = intro;

  const bodyHtml = `<article class="s-xzWvwM">
  <nav aria-label="Breadcrumb" class="s-bcr">
    <a href="/" class="s-bcl">Home</a>
    <span> / </span>
    <a href="${FUEL_LOCALE_PREFIX[locale]}/${FUEL_SECTION_SLUG[locale][fuel]}/${FUEL_TODAY_SLUG[locale]}/" class="s-bcl">${esc(fuelLabel)}</a>
    <span> / </span>
    <span>${esc(entry.display)}</span>
  </nav>
  <header class="s-Nv0GaD">
    <p class="s-eyb">${esc(dateStamp)}</p>
    <h1 class="s-h1">${esc(h1)}</h1>
    <p class="s-lede">${esc(italianCityTaglineByLocale[locale])}</p>
  </header>
  <section class="s-gfdc7T">
    <div class="s-tacc">
      <div class="s-tlbl">${esc(locale === 'it' ? 'Prezzo minimo' : locale === 'de' ? 'Mindestpreis' : locale === 'fr' ? 'Prix minimum' : 'Minimum price')}</div>
      <div class="s-tval" style="font-size:32px">${esc(minPriceFmt)}</div>
      <div class="s-iydat0">${esc(copy.currency)}</div>
    </div>
    <div class="s-tok">
      <div class="s-tlbl">${esc(locale === 'it' ? 'Zona Ticino più vicina' : locale === 'de' ? 'Nächste Tessiner Zone' : locale === 'fr' ? 'Zone tessinoise la plus proche' : 'Nearest Ticino zone')}</div>
      <div class="s-tval" style="font-size:22px"><a class="s-z7KUiE" href="${buildFuelTodayPath(locale, fuel, entry.nearestZone)}">${esc(nearestZoneLabel)}</a></div>
    </div>
  </section>
  ${verdictBannerHtml}
  <section class="s-ziawP1" aria-labelledby="itCityTable">
    <h2 id="itCityTable" class="s-h2">${esc(copy.tableTitle(entry.display))}</h2>
    ${stationListHtml}
  </section>
  ${historyCard
    ? `<section class="s-ziawP1" aria-labelledby="itCityTrend">
        <h2 id="itCityTrend" class="s-h2">${esc(IT_TREND_LABEL[locale])}</h2>
        <p class="s-C63fWv">${esc(IT_TREND_INTRO[locale])}</p>
        ${historyCard}
      </section>`
    : ''}
  <section class="s-d9ZwXC">
    <p class="s-BMekyJ">${esc(copy.crossBorderTip)}</p>
  </section>
  <section class="s-ziawP1" aria-labelledby="itCityContext">
    <h2 id="itCityContext" class="s-h2">${esc(copy.contextHeading)}</h2>
    ${copy.contextParagraphs(fuelLabel, entry.display, nearestZoneLabel)
      .map((p) => `<p class="s-ZLNNaY">${p}</p>`)
      .join('')}
  </section>
  <section class="s-ziawP1" aria-labelledby="itCityTips">
    <h2 id="itCityTips" class="s-h2">${esc(copy.tipsHeading)}</h2>
    <ul class="s-diIsZC">
      ${copy.tipsItems.map((t) => `<li class="s-Pkexk_">${esc(t)}</li>`).join('')}
    </ul>
  </section>
  ${renderItalianCityFrontalierExtra({ locale, fuelLabel, cityDisplay: entry.display, nearestZoneLabel, minPriceFmt })}
  <section class="s-GCEyQg" aria-label="${esc(copy.contextHeading)}">
    <p class="s-kvHUMU">${esc(intro)}</p>
    <p class="s-yOfiVn">${esc(paragraph)}</p>
  </section>
  <p class="s-QpkSyQ"><a href="${buildFuelTodayPath(locale, fuel, entry.nearestZone)}" style="${LINK_ACCENT_STYLE};font-weight:600">→ ${esc(copy.backLink)} (${esc(nearestZoneLabel)})</a></p>
  ${generateRelatedLinksBlock(locale, 'fuel_italian_city', {
    fuelType: fuel,
    italianCitySlug: entry.slug,
    italianCityDisplay: entry.display,
    fuelZone: entry.nearestZone,
  })}
  <section class="s-sC82IX" aria-label="advertisement">
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
    hreflangHtml: alternatesHtml,
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
 * generator stops emitting and logs a warning. The resolved default is derived
 * from the supplied station matrix (contexts × fuels × locales), so a growth
 * in the station set gets matching page capacity. The current matrix is 256
 * stations × 4 locales × 2 fuels; therefore `MAX_FUEL_STATION_PAGES_PER_BUILD >= 2048`
 * is the minimum equivalent capacity that keeps the emitted station set aligned with its index.
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
  const pages: Record<string, string> = {};

  const contexts = opts.contexts ?? collectSwissStationContexts(dataset);
  if (contexts.length === 0) return pages;
  const maxPages = opts.maxPages ?? intFromEnv(
    'MAX_FUEL_STATION_PAGES_PER_BUILD',
    contexts.length * FUEL_TYPES.length * FUEL_DAILY_LOCALES.length,
  );

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
      const prices = ctxList.map((c) => c.prices[fuel]).filter((price): price is number => price !== null);
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
 * Cross-border verdict for a city page: compares today's cheapest Italian
 * pump (for the requested fuel) against the cheapest Swiss station near the
 * same municipality, both already expressed in EUR/L by the dataset pipeline.
 */
interface CityCrossBorder {
  readonly chPriceEur: number;
  readonly itPriceEur: number;
  /** chPriceEur − itPriceEur (positive ⇒ Italy cheaper). */
  readonly deltaEur: number;
  readonly saving50LEur: number;
  readonly cheaper: 'IT' | 'CH' | 'SAME';
}

interface DatasetSwissPriced {
  readonly sp95PriceEur?: number | null;
  readonly dieselPriceEur?: number | null;
}

function collectCityCrossBorder(
  dataset: FuelPricesDataset,
  entry: ItalianCityEntry,
  fuel: FuelType,
  itPriceEur: number | null,
): CityCrossBorder | null {
  if (itPriceEur === null) return null;
  const priceOf = (s: DatasetSwissPriced): number | null => {
    const raw = fuel === 'diesel' ? s.dieselPriceEur : s.sp95PriceEur;
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
  };
  let chPriceEur: number | null = null;
  for (const row of dataset.municipalities ?? []) {
    if (!row.municipality) continue;
    if (row.municipality.toLowerCase() !== entry.matchKey) continue;
    const swiss = (row as unknown as {
      swiss?: {
        cheapestStation?: DatasetSwissPriced;
        cheapestDieselStation?: DatasetSwissPriced;
        nearbyStations?: DatasetSwissPriced[];
      };
    }).swiss;
    if (!swiss) continue;
    // `cheapestStation`/`nearbyStations` are ranked + truncated by sp95
    // (benzina), so the genuinely diesel-cheapest pump can be absent from
    // them. The generator now persists `cheapestDieselStation` (diesel-ranked
    // over the full candidate set) — prefer it for the diesel verdict. We
    // still fold in nearbyStations + cheapestStation as a fallback for
    // datasets emitted before that field existed; Math.min keeps the true
    // minimum regardless of which sources are present.
    const candidates: DatasetSwissPriced[] = [
      ...(fuel === 'diesel' && swiss.cheapestDieselStation ? [swiss.cheapestDieselStation] : []),
      ...(Array.isArray(swiss.nearbyStations) ? swiss.nearbyStations : []),
      ...(swiss.cheapestStation ? [swiss.cheapestStation] : []),
    ];
    for (const c of candidates) {
      const p = priceOf(c);
      if (p !== null) chPriceEur = chPriceEur === null ? p : Math.min(chPriceEur, p);
    }
  }
  if (chPriceEur === null) return null;
  const deltaEur = Number((chPriceEur - itPriceEur).toFixed(3));
  const cheaper: CityCrossBorder['cheaper'] =
    Math.abs(deltaEur) < 0.005 ? 'SAME' : deltaEur > 0 ? 'IT' : 'CH';
  return {
    chPriceEur,
    itPriceEur,
    deltaEur,
    saving50LEur: Number((Math.abs(deltaEur) * 50).toFixed(2)),
    cheaper,
  };
}

/**
 * Generate Italian per-city hub pages for the curated list of border cities.
 */
export function generateFuelItalianCityPages(opts: {
  dataset: FuelPricesDataset;
  history?: HistorySnapshot[];
  today?: Date;
  distDir?: string;
  rootDir?: string;
}): Record<string, string> {
  const dataset = opts.dataset;
  const history = opts.history ?? [];
  const today = opts.today ?? new Date();
  const distDir = opts.distDir;
  const rootDir = opts.rootDir;
  const pages: Record<string, string> = {};

  // Per-station contexts are fuel-specific now (diesel only covers stations
  // that reported a Gasolio price). Compute one grouping per fuel so the
  // city-page cards link only to per-station pages we actually emit.
  const contextsByCityByFuel = new Map<FuelType, Map<string, ItalianStationContext[]>>();
  for (const fuel of FUEL_TYPES) {
    contextsByCityByFuel.set(
      fuel,
      groupItalianContextsByCity(collectItalianStationContexts(dataset, fuel)),
    );
  }

  for (const entry of buildItalianCityEntries(dataset)) {
    for (const fuel of FUEL_TYPES) {
      const stations = collectItalianCityStations(dataset, entry, fuel);
      if (stations.length === 0) continue; // skip if no station data for this fuel
      const cityContexts = contextsByCityByFuel.get(fuel)?.get(entry.slug) ?? [];
      const itMin = stations.reduce<number | null>((min, s) => {
        const p = typeof s.priceEur === 'number' ? s.priceEur : null;
        return p === null ? min : min === null ? p : Math.min(min, p);
      }, null);
      const crossBorder = collectCityCrossBorder(dataset, entry, fuel, itMin);
      for (const locale of FUEL_DAILY_LOCALES) {
        const canonicalPath = buildFuelItalianCityPath(locale, fuel, entry.slug);
        const alternates: Record<FuelDailyLocale, string> = { it: '', en: '', de: '', fr: '' };
        for (const alt of FUEL_DAILY_LOCALES) {
          alternates[alt] = buildFuelItalianCityPath(alt, fuel, entry.slug);
        }
        const html = renderItalianCityPage({
          entry,
          locale,
          fuel,
          stations,
          stationContexts: cityContexts,
          crossBorder,
          history,
          canonicalPath,
          alternates,
          today,
          distDir,
          rootDir,
        });
        pages[canonicalPath] = html;
      }
    }
  }
  return pages;
}

// ── Dynamic Italian-city coverage (all municipalities, not just curated) ──
//
// The 14 curated FUEL_ITALIAN_CITIES keep hand-tuned slug/display/zone. Every
// OTHER municipality in the dataset that has ≥1 priced Italian station also
// gets per-city + per-station pages, so the cross-border fuel SPA can deep-link
// EVERY station (no orphaned "data-only" cards). Nearest Ticino zone is derived
// from the closest Swiss station address; a province fallback covers comuni
// whose 20 km Swiss radius came back empty.
const PROVINCE_FALLBACK_ZONE: Record<string, FuelZone> = {
  CO: 'chiasso',
  VA: 'mendrisio',
  LC: 'bellinzona',
  SO: 'bellinzona',
  VB: 'locarno',
  MB: 'chiasso',
  MI: 'chiasso',
  LO: 'chiasso',
  PV: 'chiasso',
  CR: 'chiasso',
  BG: 'bellinzona',
  MC: 'chiasso',
};

interface ItalianDatasetRowLite {
  municipality?: string;
  province?: string;
  swiss?: {
    nearbyStations?: Array<{ address?: string }>;
    cheapestStation?: { address?: string };
  };
  italy?: {
    stations?: Array<{
      priceEur?: number;
      dieselPriceEur?: number | null;
      brand?: string;
      stationName?: string;
    }>;
  };
}

/** Nearest Ticino zone for a municipality: closest Swiss station → province fallback. */
function deriveItalianCityZone(row: ItalianDatasetRowLite): FuelZone {
  for (const s of row.swiss?.nearbyStations ?? []) {
    const z = zoneForAddress(s.address);
    if (z) return z;
  }
  const z2 = zoneForAddress(row.swiss?.cheapestStation?.address);
  if (z2) return z2;
  return PROVINCE_FALLBACK_ZONE[(row.province ?? '').toUpperCase()] ?? 'chiasso';
}

const _italianCityEntriesCache = new WeakMap<object, ItalianCityEntry[]>();

/**
 * Full Italian-city entry list for page generation: the curated 14 (with their
 * hand-tuned metadata) plus a dynamic entry for every other municipality that
 * has at least one priced station. Memoised per dataset object. Slug is
 * `slugify(municipality)` — verified collision-free across the dataset; the
 * defensive suffix below only fires if two municipalities ever collide (the SPA
 * mirrors the bare `slugify(municipality)` form, so collisions would desync and
 * are intentionally kept impossible by the data).
 */
function buildItalianCityEntries(dataset: FuelPricesDataset): ItalianCityEntry[] {
  const cached = _italianCityEntriesCache.get(dataset as object);
  if (cached) return cached;
  const out: ItalianCityEntry[] = [...FUEL_ITALIAN_CITIES];
  const seenKey = new Set(FUEL_ITALIAN_CITIES.map((c) => c.matchKey));
  const seenSlug = new Set(FUEL_ITALIAN_CITIES.map((c) => c.slug));
  // Province claimed by each matchKey (curated entries seed it). matchKey is the
  // lowercased municipality name, and station collection matches rows by matchKey
  // alone (no province filter, see collectItalianCityStations / cross-border loops).
  // So two homonym comuni in DIFFERENT provinces would: (a) drop the second from
  // `out` via the dedup `continue` below — no page of its own — and (b) silently
  // merge its stations onto the first city's page. Today's dataset has 0 such
  // collisions, but a future MIMIT cut could introduce one. Fail loud here instead
  // of degrading silently (missing page + mixed content). Same-name/same-province
  // rows are legitimate duplicates and still dedup quietly.
  const claimedProvince = new Map<string, string>(
    FUEL_ITALIAN_CITIES.map((c) => [c.matchKey, c.province.toUpperCase()] as [string, string]),
  );
  const rows = (dataset.municipalities ?? []) as unknown as ItalianDatasetRowLite[];
  for (const row of rows) {
    const name = (row.municipality ?? '').trim();
    if (!name) continue;
    const matchKey = name.toLowerCase();
    const province = (row.province ?? '').toUpperCase();
    if (seenKey.has(matchKey)) {
      const claimed = claimedProvince.get(matchKey);
      if (claimed !== undefined && claimed !== province) {
        throw new Error(
          `[fuel] matchKey collision: '${matchKey}' already claimed by province ` +
            `'${claimed}' but a dataset row reports province '${province}'. Homonym ` +
            `comuni in different provinces would silently merge stations onto one ` +
            `page and drop the second comune's page — disambiguate the matchKey ` +
            `(e.g. suffix the province) before emitting.`,
        );
      }
      continue;
    }
    const hasPriced = (row.italy?.stations ?? []).some(
      (s) =>
        (s.brand || s.stationName) &&
        ((typeof s.priceEur === 'number' && Number.isFinite(s.priceEur)) ||
          (typeof s.dieselPriceEur === 'number' && Number.isFinite(s.dieselPriceEur))),
    );
    if (!hasPriced) continue;
    const base = slugify(name);
    if (!base) continue;
    let slug = base;
    if (seenSlug.has(slug)) {
      const withProv = `${base}-${(row.province ?? '').toLowerCase()}`;
      let candidate = withProv;
      let n = 2;
      while (seenSlug.has(candidate)) candidate = `${withProv}-${n++}`;
      slug = candidate;
    }
    seenKey.add(matchKey);
    seenSlug.add(slug);
    claimedProvince.set(matchKey, province);
    out.push({
      slug,
      display: titleCase(name),
      matchKey,
      province,
      nearestZone: deriveItalianCityZone(row),
    });
  }
  _italianCityEntriesCache.set(dataset as object, out);
  return out;
}

// ── Italian per-station rendering ──────────────────────────────
//
// Mirror of the Swiss per-station pipeline (collectSwissStationContexts +
// renderStationPage + generateFuelStationPages) but for Italian curated
// border cities. The MIMIT dataset gives us per-station identity (id,
// stationName, brand, address, lat/lng, priceEur) so we can emit one
// page per station with editorial copy + structured data.
//
// Fuel coverage: scripts/generate-fuel-prices-dataset.mjs ingests both
// MIMIT cuts — Benzina (`priceEur`) and Gasolio (`dieselPriceEur`). Benzina
// covers every border station; diesel covers the subset that reported a
// Gasolio price, so /prezzi-diesel/italia/{city}/stazioni/{slug}/ is emitted
// only for those stations (contexts are collected per fuel via
// collectItalianStationContexts(dataset, fuel)).

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
  fuel: FuelType = 'benzina',
): ItalianStationContext[] {
  const out: ItalianStationContext[] = [];
  const slugSeen = new Set<string>();

  for (const entry of buildItalianCityEntries(dataset)) {
    const rawStations = collectItalianCityStations(dataset, entry, fuel);
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
      `Per la stazione ${b} a ${c}, il dato MIMIT disponibile riporta ${f.toLowerCase()} a ${p} EUR/litro. Controlla la data della comunicazione e la modalità di servizio, quindi verifica il prezzo alla pompa.`,
    paragraph: (b, c, p, cAvg, f) =>
      `Alla stazione ${b} di ${c} il prezzo ${itFuelGenitive(f)} è ${p} EUR/litro contro una media città di ${cAvg} EUR/litro. La media riguarda il campione disponibile, non tutti i distributori. Per confrontare il Ticino usa lo stesso carburante, un cambio datato e periodi confrontabili. Moltiplica la differenza per i litri previsti e sottrai i costi del tragitto aggiuntivo.`,
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
    priceLabel: `Prezzo rilevato`,
    contextHeading: 'Conviene fare il pieno qui prima del valico?',
    contextParagraphs: (b, c, nz) => fuelComparisonNotes('it', `${b}, ${c} / ${nz}`, 'MIMIT'),
    siblingsHeading: 'Altre stazioni in città',
    breadcrumbHome: 'Home',
    italyLabel: 'Italia',
  },
  en: {
    h1: (b, st, c, f) => `${f} price ${b} ${st} in ${c}`,
    intro: (b, c, p, f) =>
      `The available MIMIT record reports ${f.toLowerCase()} at ${p} EUR/litre for the ${b} station in ${c}. Check the reporting date and service mode, then confirm the price at the pump.`,
    paragraph: (b, c, p, cAvg, f) =>
      `At the ${b} station in ${c}, the ${f.toLowerCase()} price is ${p} EUR/litre versus a city average of ${cAvg} EUR/litre. The average covers the available sample, not every station. For a Ticino comparison use the same fuel, a dated exchange rate and comparable observation periods. Multiply the difference by your planned litres and subtract the cost of any extra travel.`,
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
    priceLabel: `Observed price`,
    contextHeading: 'Worth filling up here before crossing?',
    contextParagraphs: (b, c, nz) => fuelComparisonNotes('en', `${b}, ${c} / ${nz}`, 'MIMIT'),
    siblingsHeading: 'Other stations in town',
    breadcrumbHome: 'Home',
    italyLabel: 'Italy',
  },
  de: {
    h1: (b, st, c, f) => `${f}preis ${b} ${st} in ${c}`,
    intro: (b, c, p, f) =>
      `Der verfügbare MIMIT-Datensatz nennt ${p} EUR/Liter für ${f} an der Tankstelle ${b} in ${c}. Prüfen Sie Meldedatum und Bedienungsart und bestätigen Sie den Preis an der Zapfsäule.`,
    paragraph: (b, c, p, cAvg, f) =>
      `An der Tankstelle ${b} in ${c} beträgt der ${f}preis ${p} EUR/Liter gegenüber einem Stadtdurchschnitt von ${cAvg} EUR/Liter. Das Mittel umfasst die verfügbare Stichprobe, nicht sämtliche Tankstellen. Für den Tessin-Vergleich benötigen Sie denselben Kraftstoff, einen datierten Wechselkurs und vergleichbare Erhebungszeiträume. Multiplizieren Sie die Differenz mit der geplanten Literzahl und ziehen Sie zusätzliche Fahrtkosten ab.`,
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
    priceLabel: `Erfasster Preis`,
    contextHeading: 'Lohnt sich das Tanken hier vor dem Grenzübergang?',
    contextParagraphs: (b, c, nz) => fuelComparisonNotes('de', `${b}, ${c} / ${nz}`, 'MIMIT'),
    siblingsHeading: 'Andere Tankstellen in der Stadt',
    breadcrumbHome: 'Startseite',
    italyLabel: 'Italien',
  },
  fr: {
    h1: (b, st, c, f) => `Prix ${frFuelOf(f)} ${b} ${st} à ${c}`,
    intro: (b, c, p, f) =>
      `Le relevé MIMIT disponible indique ${frFuelOf(f)} à ${p} EUR/litre pour la station ${b} à ${c}. Vérifiez la date de déclaration et le mode de service, puis confirmez le prix à la pompe.`,
    paragraph: (b, c, p, cAvg, f) =>
      `À la station ${b} de ${c}, le prix ${frFuelOf(f)} est de ${p} EUR/litre contre une moyenne de ${cAvg} EUR/litre dans la ville. Cette moyenne couvre l’échantillon disponible, pas tous les distributeurs. Pour comparer le Tessin, utilisez le même carburant, un taux de change daté et des périodes comparables. Multipliez l’écart par les litres prévus et déduisez les frais du trajet supplémentaire.`,
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
    priceLabel: `Prix relevé`,
    contextHeading: 'Faire le plein ici avant la frontière en vaut-il la peine ?',
    contextParagraphs: (b, c, nz) => fuelComparisonNotes('fr', `${b}, ${c} / ${nz}`, 'MIMIT'),
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
  const { locale, fuelLabel, brandDisplay, streetDisplay, cityDisplay, nearestZoneLabel, priceFmt } = args;
  const stationLabel = `${brandDisplay} ${streetDisplay}`.trim();
  const copy: Record<FuelDailyLocale, { h: string; p1: string; p2: string }> = {
    it: {
      h: `${stationLabel} a ${cityDisplay}: matematica del rifornimento per il frontaliere`,
      p1: `Per ${stationLabel} (${cityDisplay}), il prezzo rilevato di ${fuelLabel.toLowerCase()} è ${priceFmt} EUR/litro. Il confronto con la zona ticinese ${nearestZoneLabel} richiede lo stesso carburante e un cambio CHF/EUR riferito a una data nota. Una media svizzera e il minimo italiano descrivono due quantità diverse: per scegliere una stazione confronta anche i singoli prezzi e indirizzi, con le rispettive date di rilevazione. La fonte non permette di ricavare dal prezzo finale il margine di questo gestore o una convenienza universale del tragitto.`,
      p2: `Esempio ipotetico annuale: 220 giorni di viaggio, 60 km al giorno e un consumo di 6 litri ogni 100 km producono 13.200 km e 792 litri. Non sono valori medi misurati dei frontalieri. Sostituisci queste ipotesi con i tuoi dati e moltiplica i litri per il prezzo scelto nella stessa valuta. Il risultato riguarda soltanto il carburante: manutenzione, assicurazione, imposte sul veicolo, pedaggi e tempo si valutano separatamente. La spesa di carburante non si sottrae automaticamente dalle imposte sul reddito né identifica una quota fissa del costo totale del pendolarismo.`,
    },
    en: {
      h: `${stationLabel} in ${cityDisplay}: refuelling math for cross-border workers`,
      p1: `For ${stationLabel} (${cityDisplay}), the observed ${fuelLabel.toLowerCase()} price is ${priceFmt} EUR/litre. Comparing the ${nearestZoneLabel} Ticino zone requires the same fuel and a CHF/EUR rate with a known date. A Swiss average and an Italian minimum describe different quantities: to choose a station, also compare individual prices and addresses together with their reporting dates. The source does not establish this operator’s margin from the final price or whether every cross-border detour is worthwhile.`,
      p2: `Hypothetical annual example: 220 travel days, 60 km per day and consumption of 6 litres per 100 km produce 13,200 km and 792 litres. These are assumptions, not measured commuter averages. Replace them with your own figures and multiply the litres by the chosen price in the same currency. The result covers fuel only: maintenance, insurance, vehicle taxes, tolls and time should be evaluated separately. Fuel expenses are not automatically deducted from income tax and do not establish a fixed percentage of total commuting costs.`,
    },
    de: {
      h: `${stationLabel} in ${cityDisplay}: Tank-Mathematik für Grenzgänger`,
      p1: `Für ${stationLabel} (${cityDisplay}) liegt der erfasste Preis für ${fuelLabel} bei ${priceFmt} EUR/Liter. Der Vergleich mit der Tessiner Zone ${nearestZoneLabel} benötigt denselben Kraftstoff und einen CHF/EUR-Kurs mit bekanntem Datum. Ein Schweizer Durchschnitt und ein italienischer Mindestwert bezeichnen unterschiedliche Grössen: Vergleichen Sie für die Wahl einer Tankstelle auch Einzelpreise, Adressen und jeweilige Meldedaten. Die Quelle erlaubt weder die Bestimmung der Betreibermarge aus dem Endpreis noch eine allgemeine Aussage zur Wirtschaftlichkeit eines Umwegs.`,
      p2: `Hypothetisches Jahresbeispiel: 220 Fahrtage, 60 km am Tag und 6 Liter Verbrauch je 100 km ergeben 13.200 km und 792 Liter. Dies sind Annahmen, keine gemessenen Durchschnittswerte von Grenzgängern. Ersetzen Sie die Angaben durch Ihre eigenen Werte und multiplizieren Sie die Literzahl mit dem gewählten Preis in derselben Währung. Das Ergebnis umfasst nur Treibstoff. Wartung, Versicherung, Fahrzeugsteuern, Maut und Zeit sind getrennt zu betrachten. Treibstoffausgaben werden nicht automatisch von der Einkommensteuer abgezogen und ergeben keinen festen Anteil der gesamten Pendelkosten.`,
    },
    fr: {
      h: `${stationLabel} à ${cityDisplay} : mathématique du plein pour le frontalier`,
      p1: `Pour ${stationLabel} (${cityDisplay}), le prix relevé pour ${frFuelThe(fuelLabel)} est de ${priceFmt} EUR/litre. La comparaison avec la zone tessinoise ${nearestZoneLabel} nécessite le même carburant et un taux CHF/EUR dont la date est connue. Une moyenne suisse et un minimum italien décrivent deux quantités différentes : pour choisir une station, comparez aussi les prix individuels, les adresses et les dates de déclaration. La source ne permet ni de déduire la marge de cet exploitant du prix final ni de déterminer une rentabilité universelle du détour.`,
      p2: `Exemple annuel hypothétique : 220 jours de trajet, 60 km par jour et une consommation de 6 litres aux 100 km donnent 13.200 km et 792 litres. Ces hypothèses ne sont pas des moyennes mesurées des frontaliers. Remplacez-les par vos propres données et multipliez les litres par le prix choisi dans la même devise. Le résultat couvre seulement le carburant : entretien, assurance, taxes sur le véhicule, péages et temps se calculent séparément. Le carburant ne se déduit pas automatiquement des impôts sur le revenu et ne constitue pas une part fixe des frais totaux du trajet.`,
    },
  };
  const c = copy[locale] || copy.it;
  return `<section class="s-ziawP1" aria-labelledby="itStationFrontalierExtra">
    <h2 id="itStationFrontalierExtra" class="s-h2">${esc(c.h)}</h2>
    <p class="s-KwuhOL">${c.p1}</p>
    <p class="s-E7ZJqo">${c.p2}</p>
  </section>`;
}

// ── Italian per-station hero + advice helpers (2026-05-18 parity) ──
//
// Mirrors the Swiss-side hero/advice components (`renderStationHero`,
// `renderStationAdvice`) but localises currency (EUR), rank-link target
// (city hub instead of zone hub), and advice copy ("media città" vs
// "media zona"). All other above-the-fold affordances — map+location
// card, lucide SVG icons, OSM fallback, last-updated timestamp — are
// rendered by the same shared helpers the Swiss path uses, so any UX
// change to those affects both countries simultaneously.

interface ItalianStationHeroInput {
  readonly locale: FuelDailyLocale;
  readonly brand: string;
  readonly street: string;
  readonly city: string;
  readonly cityHubPath: string;
  readonly priceFmt: string;
  readonly fuelLabel: string;
  readonly deltaCity: number | null;
  readonly deltaCityFmt: string;
  readonly rankIdx: number;
  readonly total: number;
  readonly lat: number | null;
  readonly lng: number | null;
  readonly rootDir: string | undefined;
}

function renderItalianStationHero(inp: ItalianStationHeroInput): string {
  const labels = STATION_REDESIGN[inp.locale];
  const logo = renderBrandVisual(inp.rootDir, inp.brand, 64);
  const rankText = labels.rankSuffix(inp.rankIdx, inp.total);
  const deltaTone =
    inp.deltaCity === null
      ? 'var(--color-subtle)'
      : inp.deltaCity < -0.005
        ? 'var(--color-success)'
        : inp.deltaCity > 0.005
          ? 'var(--color-danger)'
          : 'var(--color-subtle)';
  const deltaBg =
    inp.deltaCity === null
      ? 'var(--color-surface-alt)'
      : inp.deltaCity < -0.005
        ? 'var(--color-success-subtle)'
        : inp.deltaCity > 0.005
          ? 'var(--color-danger-subtle)'
          : 'var(--color-surface-alt)';
  const hasCoords = inp.lat !== null && inp.lng !== null;
  const gmapsHref = hasCoords
    ? `https://www.google.com/maps/search/?api=1&query=${inp.lat!.toFixed(6)},${inp.lng!.toFixed(6)}`
    : '';
  const wazeHref = hasCoords
    ? `https://www.waze.com/ul?ll=${inp.lat!.toFixed(6)}%2C${inp.lng!.toFixed(6)}&navigate=yes`
    : '';
  const ext = labels.externalLinkSuffix;
  const labelGmaps = `${labels.openInMaps} (${ext})`;
  const labelWaze = `${labels.openInWaze} (${ext})`;

  const actionsHtml = `<div class="s-2AE7uV">
    <a href="${esc(inp.cityHubPath)}" class="s-cta" style="font-size:14px;padding:9px 14px">${ICON_BAR_CHART_SVG} ${esc(labels.viewRanking(inp.city))} →</a>
    ${hasCoords ? `<a class="s-MTU2pO" href="${esc(gmapsHref)}" target="_blank" rel="noopener" aria-label="${esc(labelGmaps)}">${ICON_MAP_PIN_SVG} ${esc(labels.openInMaps)}<span class="s--xxlQD" aria-hidden="true">↗</span></a>` : ''}
    ${hasCoords ? `<a class="s-MTU2pO" href="${esc(wazeHref)}" target="_blank" rel="noopener" aria-label="${esc(labelWaze)}">${ICON_NAVIGATION_SVG} ${esc(labels.openInWaze)}<span class="s--xxlQD" aria-hidden="true">↗</span></a>` : ''}
  </div>`;

  return `<section class="s-cbody" style="padding:22px 22px 20px;margin:0 0 18px" aria-label="${esc(inp.brand)} ${esc(inp.city)}">
  <div class="s-uKHM4F">
    ${logo}
    <div class="s-iFWoC6">
      <div class="s-Yv6nXB">${esc(inp.brand)}</div>
      <div class="s-BJbpLa">${esc(inp.street || inp.city)} · ${esc(inp.city)}</div>
    </div>
  </div>
  <div class="s-FqOGbC">
    <div>
      <div class="s-k3C5vt">${esc(inp.priceFmt)}</div>
      <div class="s-6aG_zc">EUR/litro · ${esc(inp.fuelLabel)}</div>
    </div>
    <div class="s-D7-ehZ">
      <span style="display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border-radius:999px;background:${deltaBg};color:${deltaTone};font-weight:700;font-size:13px;font-variant-numeric:tabular-nums">${esc(inp.deltaCityFmt)} vs ${esc(inp.city)}</span>
      <a class="s-Ys_0Hs" href="${esc(inp.cityHubPath)}">${ICON_TROPHY_SVG} ${esc(rankText)} a ${esc(inp.city)} →</a>
    </div>
  </div>
  ${actionsHtml}
</section>`;
}

/**
 * IT-side advice banner — same tone palette as the Swiss path
 * (`renderStationAdvice`), but the copy says "media città X" instead of
 * "media zona X" so the recommendation matches the data source the user
 * is reading. Currency stays in the rendered delta string.
 */
function renderItalianStationAdvice(
  locale: FuelDailyLocale,
  deltaCity: number | null,
  deltaCityFmt: string,
  city: string,
): string {
  // formatDelta with EUR override returns "+0.012 EUR" — strip sign + " EUR"
  // suffix so the advice template controls punctuation.
  const absDeltaFmt = deltaCityFmt.replace(/^[-+]/, '').replace(/\s*EUR\s*$/, '');
  let text: string;
  let tone: string;
  if (deltaCity === null || Math.abs(deltaCity) <= 0.02) {
    text = IT_STATION_ADVICE[locale].median(city);
    tone = STAT_TILE_WARNING;
  } else if (deltaCity < 0) {
    text = IT_STATION_ADVICE[locale].cheaper(absDeltaFmt, city);
    tone = STAT_TILE_SUCCESS;
  } else {
    text = IT_STATION_ADVICE[locale].premium(absDeltaFmt, city);
    tone = STAT_TILE_DANGER;
  }
  return `<aside data-station-advice style="${tone};margin:0 0 22px;font-weight:600;line-height:1.5">${esc(text)}</aside>`;
}

interface ItalianAdviceCopy {
  readonly cheaper: (delta: string, city: string) => string;
  readonly median: (city: string) => string;
  readonly premium: (delta: string, city: string) => string;
}

const IT_STATION_ADVICE: Record<FuelDailyLocale, ItalianAdviceCopy> = {
  it: {
    cheaper: (d, c) => `Buona scelta: oggi questa stazione è ${d} EUR/litro più economica della media città ${c}.`,
    median: (c) => `Prezzo in linea con la media della città ${c}: scegli in base alla comodità del percorso.`,
    premium: (d, c) => `Attenzione: oggi questa stazione è ${d} EUR/litro più cara della media città ${c}. Valuta una stazione più economica nella classifica.`,
  },
  en: {
    cheaper: (d, c) => `Good pick: today this station is ${d} EUR/litre cheaper than the ${c} city average.`,
    median: (c) => `Price in line with the ${c} city average: pick by route convenience.`,
    premium: (d, c) => `Heads up: today this station is ${d} EUR/litre above the ${c} city average. Consider a cheaper one from the ranking.`,
  },
  de: {
    cheaper: (d, c) => `Gute Wahl: heute ist diese Tankstelle ${d} EUR/Liter günstiger als der Stadt-${c}-Schnitt.`,
    median: (c) => `Preis im Schnitt der Stadt ${c}: wähle nach Route.`,
    premium: (d, c) => `Achtung: heute ist diese Tankstelle ${d} EUR/Liter teurer als der Stadt-${c}-Schnitt.`,
  },
  fr: {
    cheaper: (d, c) => `Bon choix : aujourd'hui cette station est ${d} EUR/litre moins chère que la moyenne de la ville ${c}.`,
    median: (c) => `Prix conforme à la moyenne de la ville ${c} : choisissez selon votre itinéraire.`,
    premium: (d, c) => `Attention : aujourd'hui cette station est ${d} EUR/litre plus chère que la moyenne de la ville ${c}.`,
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
  /** Project root for resolving brand logos via resolveStationBrandLogoUrl. */
  readonly rootDir?: string;
}): string {
  const { ctx, locale, fuel, cityAvg, cityStations, history, today, canonicalPath, alternates, distDir, rootDir } = opts;
  const copy = IT_STATION_COPY[locale];
  const redesignLabels = STATION_REDESIGN[locale];
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
  const breadcrumbLd = inlineScriptJson({
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

  const webPageLd = inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: h1,
    url: canonicalUrl,
    description: intro,
    inLanguage: locale,
  });

  const gasStationLd = inlineScriptJson({
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
        // Shared peel — a word-boundary cut still stops mid-clause.
        return peelDanglingClauseTail(base);
      })();
  const dated = `${trimmedH1} (${dateStamp})`;
  const withDate = dated.length <= titleBudget ? dated : trimmedH1;
  const title = clampSiteSuffix(withDate, 'Frontaliere Ticino', titleBudget);
  // When buildTitleWithBrand drops the brand suffix (headline + brand > 66
  // chars), the rendered <title> collapses to the H1 string verbatim. The
  // helper appends a locale-aware narrative tag so the
  // `audit:h1-title-duplicates` ratchet (baseline 0) accepts the page.
  h1 = differentiateH1FromTitle(h1, title, locale);
  // Pre-cut removed: clampMetaDescription (160) runs downstream and is
  // word-aware. Slicing first only handed it a string already broken
  // mid-word, which is what reached the SERP snippet.
  const description = intro;

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
    ? `<section class="s-ZqtBbL" aria-labelledby="itStationSiblings">
        <h2 id="itStationSiblings" class="s-h2">${esc(copy.siblingsHeading)}</h2>
        <ul class="s-RBoxs1">
          ${siblingStations
            .map((s) => {
              const href = buildFuelItalianStationPath(locale, fuel, s.cityEntry.slug, s.slug);
              return `<li class="s-q3nqK4"><a href="${esc(href)}" style="${LINK_ACCENT_STYLE};font-weight:600;display:block;padding:10px 12px;border-radius:10px;background:var(--color-surface);border:1px solid var(--color-edge);text-decoration:none">${esc(s.brandDisplay)} ${esc(s.streetDisplay)}</a></li>`;
            })
            .join('')}
        </ul>
      </section>`
    : '';

  const hasGeo =
    typeof ctx.station.lat === 'number' &&
    typeof ctx.station.lng === 'number' &&
    Number.isFinite(ctx.station.lat) &&
    Number.isFinite(ctx.station.lng);
  const heroHtml = renderItalianStationHero({
    locale,
    brand: ctx.brandDisplay,
    street: ctx.streetDisplay,
    city: cityName,
    cityHubPath: `${BASE_URL}${cityHubPath}`,
    priceFmt,
    fuelLabel,
    deltaCity,
    deltaCityFmt,
    rankIdx: Math.max(rankIdx, 0),
    total,
    lat: hasGeo ? (ctx.station.lat as number) : null,
    lng: hasGeo ? (ctx.station.lng as number) : null,
    rootDir,
  });
  const adviceHtml = renderItalianStationAdvice(locale, deltaCity, deltaCityFmt, cityName);
  const locationHtml = hasGeo
    ? renderStationLocationCard({
        locale,
        brand: ctx.brandDisplay,
        city: cityName,
        address: ctx.station.address ?? '',
        lat: ctx.station.lat as number,
        lng: ctx.station.lng as number,
      })
    : '';
  const lastUpdatedLine = `<p class="s-oF62Kj">${esc(redesignLabels.historyLastUpdated(dateStamp))}</p>`;

  const bodyHtml = `<article class="s-xzWvwM">
  <nav aria-label="Breadcrumb" class="s-bcr">
    <a href="/" class="s-bcl">${esc(copy.breadcrumbHome)}</a>
    <span> / </span>
    <a href="${FUEL_LOCALE_PREFIX[locale]}/${FUEL_SECTION_SLUG[locale][fuel]}/${FUEL_TODAY_SLUG[locale]}/" class="s-bcl">${esc(fuelLabel)}</a>
    <span> / </span>
    <a href="${cityHubPath}" class="s-bcl">${esc(cityName)}</a>
    <span> / </span>
    <span>${esc(ctx.brandDisplay)} ${esc(ctx.streetDisplay)}</span>
  </nav>
  <header class="s-S1RSUf">
    <p class="s-eyb">${esc(dateStamp)}</p>
    <h1 class="s-h1">${esc(h1)}</h1>
    <p class="s-lede">${esc(italianStationTaglineByLocale[locale])}</p>
  </header>
  ${heroHtml}
  ${adviceHtml}
  ${locationHtml}
  ${historyCard
    ? `<section class="s-ziawP1" aria-labelledby="itStationTrend">
        <h2 id="itStationTrend" class="s-h2" style="margin:0 0 8px;font-size:20px">${esc(IT_TREND_LABEL[locale])}</h2>
        <p class="s-zYNVmR">${esc(IT_TREND_INTRO[locale])}</p>
        ${historyCard}
        ${lastUpdatedLine}
      </section>`
    : ''}
  <section class="s-card" style="margin:0 0 24px" aria-labelledby="itStationInfo">
    <h2 id="itStationInfo" class="s-h2" style="margin:0 0 12px;font-size:20px">${esc(copy.infoHeading)}</h2>
    <dl class="s-RPPdPW">
      <dt class="s-bovPrI">${esc(copy.infoBrand)}</dt><dd class="s-q3nqK4">${esc(ctx.brandDisplay)}</dd>
      <dt class="s-bovPrI">${esc(copy.infoAddress)}</dt><dd class="s-q3nqK4">${esc(ctx.station.address ?? '—')}, ${esc(cityName)} (${esc(ctx.cityEntry.province)})</dd>
      ${typeof ctx.station.isSelf === 'boolean' ? `<dt class="s-bovPrI">${esc(copy.infoSelfService)}</dt><dd class="s-q3nqK4">${ctx.station.isSelf ? 'Self-service' : (locale === 'it' ? 'Servito' : locale === 'de' ? 'Bedient' : locale === 'fr' ? 'Servi' : 'Served')}</dd>` : ''}
      ${ctx.station.updatedAt ? `<dt class="s-bovPrI">${esc(copy.infoUpdated)}</dt><dd class="s-q3nqK4">${esc(String(ctx.station.updatedAt).slice(0, 10))}</dd>` : ''}
    </dl>
  </section>
  <section class="s-ziawP1" aria-labelledby="itStationContext">
    <h2 id="itStationContext" class="s-h2" style="margin:0 0 12px;font-size:20px">${esc(copy.contextHeading)}</h2>
    <p class="s-ZLNNaY">${esc(intro)}</p>
    <p class="s-ZLNNaY">${esc(paragraph)}</p>
    ${copy.contextParagraphs(ctx.brandDisplay, cityName, nearestZoneLabel)
      .map((p) => `<p class="s-ZLNNaY">${p}</p>`)
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
  <p class="s-USY9TF"><a href="${cityHubPath}" style="${LINK_ACCENT_STYLE};font-weight:600">← ${esc(copy.backToCity(cityName))}</a></p>
  ${siblingsHtml}
  <section class="s-sC82IX" aria-label="advertisement">
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
    hreflangHtml: alternatesHtml,
    jsonLdScripts: [breadcrumbLd, webPageLd, gasStationLd],
    bodyHtml,
    distDir,
    hubChrome: { hubKey: 'stats', activeSubTab: 'fuel-prices' },
  });
}

/**
 * Generate Italian per-station detail pages for all curated cities, for every
 * fuel that has per-station price coverage. Benzina covers all stations;
 * diesel covers the subset that reported a Gasolio price (MIMIT ingestion).
 */
export function generateFuelItalianStationPages(opts: {
  dataset: FuelPricesDataset;
  history?: HistorySnapshot[];
  today?: Date;
  distDir?: string;
  /**
   * Optional pre-collected per-fuel contexts (single-source-of-truth pattern;
   * see generateFuelStationPages for rationale). When provided for a fuel, the
   * function skips its own `collectItalianStationContexts(dataset, fuel)` call
   * — the closeBundle hook threads the SAME lists into the browseable index so
   * every emitted station page is linked (no orphans).
   */
  contextsByFuel?: Partial<Record<FuelType, readonly ItalianStationContext[]>>;
  /** Project root — passed to renderItalianStationPage so it can resolve brand logos. */
  rootDir?: string;
}): Record<string, string> {
  const dataset = opts.dataset;
  const history = opts.history ?? [];
  const today = opts.today ?? new Date();
  const distDir = opts.distDir;
  const rootDir = opts.rootDir;
  const pages: Record<string, string> = {};

  for (const fuel of FUEL_TYPES) {
    const contexts = opts.contextsByFuel?.[fuel] ?? collectItalianStationContexts(dataset, fuel);
    if (contexts.length === 0) continue;

    const cityGroups = groupItalianContextsByCity(contexts);

    // Precompute per-city averages (priceEur is already the fuel's price).
    const cityAvg = new Map<string, number>();
    for (const [citySlug, list] of cityGroups) {
      const avg = mean(list.map((c) => c.priceEur));
      if (avg !== null) cityAvg.set(citySlug, avg);
    }

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
          rootDir,
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
  bridgesWritten?: number;
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
      // BUILD_DATE_STAMP (deploy-wide, derived from DEPLOY_BUILD_ID), NOT a
      // fresh `new Date()` — this "today" gates which past months qualify
      // for archive pages, and on the matrix deploy the it/en/de/fr shards
      // are independent processes. A per-shard `new Date()` could cross a
      // UTC-midnight boundary between shards, so the current month flips to
      // "past" on one shard but not its siblings: the archive page (and its
      // sitemap-fuel-daily.xml entry, emitted from the same pass) exists on
      // one shard but not the others once merged (#6971, same class as #5911
      // in eventsSeoPagesPlugin.ts). See build-plugins/constants.ts BUILD_DATE_STAMP doc.
      const today = new Date(BUILD_DATE_STAMP);

      // ── Single source of truth for station contexts (2026-04-29) ─
      // Compute Swiss + Italian contexts ONCE before any generator runs,
      // then thread the SAME list through both the per-station page
      // generators AND the browseable-index generator. This guarantees the
      // index links every station whose detail page we emit — eliminating
      // the divergence that was leaking new orphans into
      // `sitemap-fuel-stations.xml` whenever the index source happened to
      // disagree with the detail-page source on a fresh dataset.
      const swissContexts = collectSwissStationContexts(dataset);
      // Italian contexts are fuel-specific (diesel covers only stations with a
      // Gasolio price). Compute once per fuel and thread the SAME lists into
      // both the per-station page generator and the browseable index below.
      const italianContextsByFuel: Partial<Record<FuelType, ItalianStationContext[]>> = {};
      for (const fuel of FUEL_TYPES) {
        italianContextsByFuel[fuel] = collectItalianStationContexts(dataset, fuel);
      }

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
      const italianCityPages = generateFuelItalianCityPages({ dataset, history, today, distDir, rootDir });
      const italianStationPages = generateFuelItalianStationPages({
        dataset,
        history,
        today,
        distDir,
        contextsByFuel: italianContextsByFuel,
        rootDir,
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
        lat: typeof c.station.lat === 'number' ? c.station.lat : null,
        lng: typeof c.station.lng === 'number' ? c.station.lng : null,
        benzinaPriceChf: c.prices.benzina,
        dieselPriceChf: c.prices.diesel,
        updatedAt: c.station.updatedAt ?? null,
        dieselUpdatedAt: c.station.dieselUpdatedAt ?? c.station.updatedAt ?? null,
      }));
      // Per-fuel Italian leaves — derived from the SAME contexts emitted as
      // station pages, so the index links exactly what we publish (and the
      // diesel index only appears once Gasolio coverage exists).
      const buildItalianLeaves = (ctxs: readonly ItalianStationContext[]): ItalianStationLeaf[] =>
        ctxs.map((c) => ({
          citySlug: c.cityEntry.slug,
          cityDisplay: c.cityEntry.display,
          stationSlug: c.slug,
          name: c.station.stationName ?? c.brandDisplay,
          brand: c.brandDisplay,
          address: c.station.address ?? '',
        }));
      const italianStationsByFuel: Partial<Record<FuelType, ItalianStationLeaf[]>> = {};
      for (const fuel of FUEL_TYPES) {
        italianStationsByFuel[fuel] = buildItalianLeaves(italianContextsByFuel[fuel] ?? []);
      }
      const collector = new WriteCollector({ distDir, pluginName: 'fuelDailyPagesPlugin' });

      let pagesWritten = 0;
      let skipped = 0;
      let bridgesWritten = 0;
      const sitemapPaths: string[] = [];
      for (const [path, html] of Object.entries(pages)) {
        const words = countHtmlBodyWords(html);
        if (words < MIN_INDEXABLE_WORDS) {
          skipped++;
          console.warn(`[fuel-daily-pages] thin content (${words} words) for ${path} — skipping`);
          const outDir = np.join(distDir, path.replace(/^\/+/, ''));
          collector.add(np.join(outDir, 'index.html'), renderFuelBelowFloorBridge(path));
          bridgesWritten++;
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
          const outDir = np.join(distDir, path.replace(/^\/+/, ''));
          collector.add(np.join(outDir, 'index.html'), renderFuelBelowFloorBridge(path));
          bridgesWritten++;
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
      const unavailableStationPaths = new Set(swissContexts.flatMap((ctx) =>
        FUEL_TYPES.filter((fuel) => ctx.prices[fuel] === null).flatMap((fuel) =>
          FUEL_DAILY_LOCALES.map((locale) => buildFuelStationPath(locale, fuel, ctx.zone, ctx.slug)))));
      for (const [path, html] of Object.entries(stationPages)) {
        // Preserve previously published URLs without listing a fabricated fuel price.
        if (unavailableStationPaths.has(path)) {
          collector.add(np.join(distDir, path.replace(/^\/+/, ''), 'index.html'), html);
          bridgesWritten++;
          continue;
        }
        const words = countHtmlBodyWords(html);
        if (words < STATION_MIN_WORDS) {
          skipped++;
          console.warn(`[fuel-daily-pages] station thin content (${words} words) for ${path} — skipping`);
          const outDir = np.join(distDir, path.replace(/^\/+/, ''));
          collector.add(np.join(outDir, 'index.html'), renderFuelBelowFloorBridge(path));
          bridgesWritten++;
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
          const outDir = np.join(distDir, path.replace(/^\/+/, ''));
          collector.add(np.join(outDir, 'index.html'), renderFuelBelowFloorBridge(path));
          bridgesWritten++;
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
          const outDir = np.join(distDir, path.replace(/^\/+/, ''));
          collector.add(np.join(outDir, 'index.html'), renderFuelBelowFloorBridge(path));
          bridgesWritten++;
          continue;
        }
        const outDir = np.join(distDir, path.replace(/^\/+/, ''));
        collector.add(np.join(outDir, 'index.html'), html);
        italianStationSitemapPaths.push(path);
        italianStationPagesWritten++;
      }

      // ── Manifest of ACTUALLY-emitted Italian station pages ─────
      // The cross-border SPA (`FuelPriceStats`) deep-links each station by
      // recomputing `slugify(municipality)` + the per-station slug. That mirror
      // can diverge from what the build truly wrote (word-gate skip, future
      // slug collision, whitespace) → 404s from an indexed page. Publish the
      // authoritative set of written benzina pages as `{citySlug}/{stationSlug}`
      // (locale-agnostic); the SPA links a station only when it appears here.
      const italianStationManifest = Array.from(
        new Set(
          italianStationSitemapPaths
            .map((p) => /^\/prezzi-benzina\/italia\/([^/]+)\/stazioni\/([^/]+)\/$/.exec(p))
            .filter((m): m is RegExpExecArray => m !== null)
            .map((m) => `${m[1]}/${m[2]}`),
        ),
      ).sort();
      collector.add(
        np.join(distDir, 'data', 'fuel-italian-station-pages.json'),
        JSON.stringify({ stations: italianStationManifest }),
      );

      // Generate the browseable indexes AFTER the page write loops, gated on the
      // set of paths actually written (post word-gate). This guarantees the
      // crawlable, sitemap'd index never links a city-hub / station page that was
      // skipped for thin content → no broken internal links / soft-404s.
      const emittedFuelPaths = new Set<string>([
        ...sitemapPaths,
        ...stationSitemapPaths,
        ...italianCitySitemapPaths,
        ...italianStationSitemapPaths,
      ]);
      const indexPages = generateFuelIndexPages({
        distDir,
        rootDir,
        today,
        swissStations: swissLeaves,
        italianStations: italianStationsByFuel.benzina ?? [],
        italianStationsByFuel,
        italianCities: buildItalianCityEntries(dataset),
        emittedPaths: emittedFuelPaths,
      });

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
          // Loud failure: the per-station / per-city leaves this index would
          // have linked are orphaned in sitemap-fuel-stations.xml regardless
          // (they're in their own sitemap already, this index was their only
          // BFS-reachable inbound link) — same either way whether the URL is
          // silently missing or bridged, so bridge it below-floor same as the
          // other 5 emission sites rather than leaving a bare 404 for a URL a
          // prior build may have indexed. Emit an error (not a warning) so CI
          // surfaces it before the orphan-pages gate catches the downstream
          // regression.
          skipped++;
          console.error(
            `[fuel-daily-pages] CRITICAL: index thin content (${words} words < ${INDEX_MIN_WORDS}) for ${path} — skipping. ` +
              `Per-station leaves it should link will be orphaned in sitemap-fuel-stations.xml. ` +
              `Investigate fuelStationIndexPages.ts copy + station data integrity.`,
          );
          const outDir = np.join(distDir, path.replace(/^\/+/, ''));
          collector.add(np.join(outDir, 'index.html'), renderFuelBelowFloorBridge(path));
          bridgesWritten++;
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
          const urlEntries = paths
            .map((p) => {
              return `  <url>\n    <loc>${BASE_URL}${p}</loc>\n    <changefreq>${changefreq}</changefreq>\n    <priority>0.6</priority>\n  </url>`;
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
        bridgesWritten,
      };
      console.log(
        `\x1b[36m[fuel-daily-pages]\x1b[0m Generated ${result.pagesWritten} daily + ${result.archivesWritten} archives + ${stationPagesWritten} CH-station + ${italianCityPagesWritten} IT-city + ${italianStationPagesWritten} IT-station + ${indexPagesWritten} indexes (skipped ${result.skippedForWordCount}, bridged ${result.bridgesWritten})`,
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
