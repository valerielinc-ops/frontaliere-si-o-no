/**
 * Vite build plugin — emits static HTML for the weekly / monthly "Ticino job
 * market snapshot" series in 4 locales (F4).
 *
 * Data sources
 * ────────────
 *   data/jobs-stats-history.json — daily aggregates: totalJobs, added,
 *     removed, plus per-company / per-location / per-title delta arrays.
 *   data/jobs.json — current job list; used for the hub "latest weeks" tease
 *     and to synthesise a "current week" snapshot when jobs-stats-history
 *     is sparse (<2 entries).
 *
 * Pages emitted
 * ─────────────
 *   • Hub (evergreen) — 4 pages, one per locale.
 *   • Weekly archives — complete ISO weeks only (Mon–Sun), for as many
 *     weeks as history supports. The current (in-progress) ISO week is
 *     emitted as "settimana-corrente" only in the degraded mode where no
 *     real history is available; in normal mode we stick to completed
 *     weeks so the page is stable when Google re-crawls.
 *   • Monthly aggregates — one page per completed calendar month present
 *     in the history, per locale. The current month is skipped (still
 *     accumulating).
 *
 * Content guarantees (hard gates)
 * ──────────────────────────────
 *   ≥350 words per weekly / monthly page, ≥300 per hub.
 *   Pages below the threshold are logged + skipped.
 *   Self-referencing canonical + hreflang alternates for all 4 locales.
 *   JSON-LD: Article (news-style) + Dataset + BreadcrumbList.
 *   SVG trend chart (12-week totalJobs trail when history allows).
 *   Only the latest 12 weekly archives get index,follow; older ones are
 *   marked noindex,follow to avoid diluting authority with stale pages.
 *
 * Env gate
 * ────────
 *   SKIP_JOB_MARKET_SNAPSHOT=1 — disables the plugin entirely (useful for
 *   fast local builds when you are not iterating on this surface).
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
  JOB_MARKET_HUB_NAME,
  JOB_MARKET_LOCALE_PREFIX,
  JOB_MARKET_MONTH_NAMES,
  JOB_MARKET_OG_LOCALE,
  JOB_MARKET_SECTION_SLUG,
  JOB_MARKET_SECTOR_DISPLAY,
  JOB_MARKET_SECTOR_KEYS,
  JOB_MARKET_SECTOR_MATCHERS,
  JOB_MARKET_SECTOR_SEGMENT,
  JOB_MARKET_SECTOR_SLUG,
  JOB_MARKET_SNAPSHOT_LOCALES,
  buildHubPath,
  buildMonthlyPath,
  buildSectorSnapshotPath,
  buildWeeklyPath,
  getIsoWeek,
  mondayOfIsoWeek,
  sundayOfIsoWeek,
  type JobMarketSectorKey,
  type JobMarketSnapshotLocale,
} from './jobMarketSnapshotData';
import { generateRelatedLinksBlock } from './shared/relatedLinks';
import { CITY_HUB_KEYS } from './cityJobsHub';
import { cleanNamespaces, cleanSitemapFiles } from './shared/distNamespaceCleanup';
import { employerCanonicalHref, loadKnownCompanySlugs, slugifyEmployer } from './shared/employerLinks';
import { SECTOR_HUB_KEYS, buildSectorHubPath, type SectorHubKey } from './jobSectorLanding';
import { JOB_RECENCY_LANDING_SLUGS } from './jobRecencyLanding';
import {
  WEEKLY_EMPLOYERS_CURRENT_SLUG,
  WEEKLY_EMPLOYERS_LOCALE_PREFIX,
  WEEKLY_EMPLOYERS_SECTION,
} from './weeklyEmployersData';
import {
  BREADCRUMB_LINK_STYLE,
  BREADCRUMB_STYLE,
  CARD_STYLE,
  H1_STYLE,
  H2_STYLE,
  HERO_EYEBROW_STYLE,
  ICON_BUILDING_SVG,
  LEDE_STYLE,
  LINK_ACCENT_STYLE,
  STAT_TILE_ACCENT,
  STAT_TILE_BASE,
  STAT_TILE_LABEL,
  STAT_TILE_SUCCESS,
  STAT_TILE_VALUE,
  STAT_TILE_WARNING,
  clampSiteSuffix,
  renderDiscoverMore,
  renderEntityCard,
  resolveBrandLogoUrl,
} from './shared/seoContentTokens';

// ── Feature-specific "Scopri di più" CTAs ─────────────────────
// Three contextually relevant links per locale for the F4 job-market-snapshot feature.
//
// URLs are built from canonical slug constants from weeklyEmployersData and
// jobRecencyLanding so they stay in sync with the actual pages emitted by
// those plugins. The "recent jobs" link targets `last-3-days` because that
// is the recency variant we currently emit (see JOB_RECENCY_LANDING_SLUGS).

type JobMarketDiscoverMoreCta = { title: string; href: string };

const JOB_BOARD_SLUG: Record<JobMarketSnapshotLocale, string> = {
  it: 'cerca-lavoro-ticino',
  en: 'find-jobs-ticino',
  de: 'jobs-im-tessin',
  fr: 'trouver-emploi-tessin',
};

const SALARY_STATS_PATH: Record<JobMarketSnapshotLocale, string> = {
  it: '/statistiche/confronta-stipendi/',
  en: '/en/statistics/compare-salaries/',
  de: '/de/statistiken/gehaelter-vergleichen/',
  fr: '/fr/statistiques/comparer-salaires/',
};

function buildJobMarketDiscoverMoreCtas(
  locale: JobMarketSnapshotLocale,
): ReadonlyArray<JobMarketDiscoverMoreCta> {
  const hiringHref =
    `${WEEKLY_EMPLOYERS_LOCALE_PREFIX[locale]}/${WEEKLY_EMPLOYERS_SECTION[locale]}/ticino/${WEEKLY_EMPLOYERS_CURRENT_SLUG[locale]}/`.replace(
      /\/{2,}/g,
      '/',
    );
  const recencyLocalePrefix = locale === 'it' ? '' : `/${locale}`;
  const recencyHref =
    `${recencyLocalePrefix}/${JOB_BOARD_SLUG[locale]}/${JOB_RECENCY_LANDING_SLUGS['last-3-days'][locale]}/`.replace(
      /\/{2,}/g,
      '/',
    );

  const titles: Record<
    JobMarketSnapshotLocale,
    { hiring: string; recency: string; salary: string }
  > = {
    it: {
      hiring: 'Aziende che assumono',
      recency: 'Offerte lavoro ultimi 3 giorni',
      salary: 'Report stipendi annuale',
    },
    en: {
      hiring: 'Companies hiring',
      recency: 'Jobs posted in the last 3 days',
      salary: 'Annual salary report',
    },
    de: {
      hiring: 'Einstellende Unternehmen',
      recency: 'Stellen der letzten 3 Tage',
      salary: 'Jahresgehaltsbericht',
    },
    fr: {
      hiring: 'Entreprises qui recrutent',
      recency: 'Offres des 3 derniers jours',
      salary: 'Rapport annuel des salaires',
    },
  };

  const t = titles[locale];
  return [
    { title: t.hiring, href: hiringHref },
    { title: t.recency, href: recencyHref },
    { title: t.salary, href: SALARY_STATS_PATH[locale] },
  ];
}

const JOB_MARKET_DISCOVER_MORE_CTAS: Record<
  JobMarketSnapshotLocale,
  ReadonlyArray<JobMarketDiscoverMoreCta>
> = {
  it: buildJobMarketDiscoverMoreCtas('it'),
  en: buildJobMarketDiscoverMoreCtas('en'),
  de: buildJobMarketDiscoverMoreCtas('de'),
  fr: buildJobMarketDiscoverMoreCtas('fr'),
};

// ── Types ──────────────────────────────────────────────────────

interface StatDelta {
  key: string;
  name: string;
  url?: string;
  addedKeys: string[];
  updatedKeys: string[];
  removedKeys: string[];
}

interface HistoryEntry {
  date: string; // YYYY-MM-DD
  totalJobs: number;
  added: number;
  updated: number;
  removed: number;
  addedKeys?: string[];
  updatedKeys?: string[];
  removedKeys?: string[];
  companyStats?: StatDelta[];
  locationStats?: StatDelta[];
  titleStats?: StatDelta[];
}

interface StatsHistoryDataset {
  version?: number;
  generatedAt?: string;
  entries: HistoryEntry[];
}

interface JobRecord {
  title?: string;
  company?: string;
  location?: string;
  description?: string;
  category?: string;
  tags?: readonly string[] | string;
  addressLocality?: string;
  titleByLocale?: Partial<Record<JobMarketSnapshotLocale, string>>;
  descriptionByLocale?: Partial<Record<JobMarketSnapshotLocale, string>>;
  datePosted?: string;
  firstSeenAt?: string;
  crawledAt?: string;
  postedDate?: string;
  needsRetranslation?: boolean | Partial<Record<JobMarketSnapshotLocale, boolean>>;
  expired?: boolean;
  baseSalary?: {
    value?: {
      minValue?: number;
      maxValue?: number;
    };
  };
}

// ── Constants ──────────────────────────────────────────────────

/** Cities highlighted in the city-breakdown section. */
const TICINO_CITIES: ReadonlyArray<{ key: string; name: string }> = [
  { key: 'lugano', name: 'Lugano' },
  { key: 'mendrisio', name: 'Mendrisio' },
  { key: 'bellinzona', name: 'Bellinzona' },
  { key: 'locarno', name: 'Locarno' },
  { key: 'chiasso', name: 'Chiasso' },
];

/** Number of weekly archives kept index,follow — older ones get noindex. */
const WEEKLY_INDEXABLE_LIMIT = 12;

/** Minimum weeks of real history needed to exit "degraded" mode. */
const MIN_HISTORY_WEEKS_FOR_NORMAL_MODE = 2;

/** Target hub min-word count. */
const MIN_HUB_WORDS = 300;

/** Target weekly / monthly min-word count. */
const MIN_SNAPSHOT_WORDS = 350;

// ── Helpers ────────────────────────────────────────────────────

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDate(date: Date, locale: JobMarketSnapshotLocale): string {
  const iso = date.toISOString().slice(0, 10);
  const [y, m, d] = iso.split('-');
  if (locale === 'it' || locale === 'fr') return `${d}/${m}/${y}`;
  if (locale === 'de') return `${d}.${m}.${y}`;
  return `${y}-${m}-${d}`;
}

function formatDelta(delta: number, locale: JobMarketSnapshotLocale): string {
  const sign = delta > 0 ? '+' : '';
  const suffix = locale === 'it' ? '' : '';
  return `${sign}${delta}${suffix}`;
}

function clampPercentage(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 100) return 100;
  return Math.round(value * 10) / 10;
}

function sum(nums: number[]): number {
  let total = 0;
  for (const n of nums) total += n;
  return total;
}

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
    : sorted[mid];
}

function extractDateFromUrl(urlKey: string): string | null {
  // Many keys look like "url:https://..." — not useful for dates.
  // We rely on per-entry dates of the history snapshot instead.
  return urlKey.length ? null : null;
}

// ── Core aggregation ───────────────────────────────────────────

interface WeekBucket {
  isoYear: number;
  isoWeek: number;
  monday: Date;
  sunday: Date;
  entries: HistoryEntry[];
}

interface MonthBucket {
  year: number;
  /** 1-indexed. */
  month: number;
  entries: HistoryEntry[];
}

/**
 * Group history entries into ISO-week buckets. Entries whose date lies
 * outside the Monday–Sunday window are skipped. Only complete weeks (every
 * weekday represented OR at least 4 days present, whichever happens first)
 * are returned so the aggregate is meaningful.
 */
export function bucketHistoryByWeek(
  entries: ReadonlyArray<HistoryEntry>,
  opts: { requireComplete?: boolean } = {},
): WeekBucket[] {
  const requireComplete = opts.requireComplete ?? true;
  const map = new Map<string, WeekBucket>();
  for (const entry of entries) {
    if (!entry || typeof entry.date !== 'string') continue;
    const [y, m, d] = entry.date.split('-').map(Number);
    if (!y || !m || !d) continue;
    const date = new Date(Date.UTC(y, m - 1, d));
    const { year, week } = getIsoWeek(date);
    const key = `${year}-${String(week).padStart(2, '0')}`;
    let bucket = map.get(key);
    if (!bucket) {
      bucket = {
        isoYear: year,
        isoWeek: week,
        monday: mondayOfIsoWeek(year, week),
        sunday: sundayOfIsoWeek(year, week),
        entries: [],
      };
      map.set(key, bucket);
    }
    bucket.entries.push(entry);
  }

  const buckets = Array.from(map.values()).sort((a, b) => {
    if (a.isoYear !== b.isoYear) return a.isoYear - b.isoYear;
    return a.isoWeek - b.isoWeek;
  });

  if (!requireComplete) return buckets;

  // Drop buckets whose latest entry pre-dates the ISO Sunday → week not
  // complete yet. ≥4 entries is our soft proxy for "enough data to trust".
  return buckets.filter((b) => {
    if (b.entries.length < 4) return false;
    const latest = b.entries[b.entries.length - 1].date;
    return latest >= b.sunday.toISOString().slice(0, 10)
      ? true
      : latest >= new Date(b.sunday.getTime() - 24 * 3600 * 1000).toISOString().slice(0, 10);
  });
}

export function bucketHistoryByMonth(entries: ReadonlyArray<HistoryEntry>): MonthBucket[] {
  const map = new Map<string, MonthBucket>();
  for (const entry of entries) {
    if (!entry || typeof entry.date !== 'string') continue;
    const [y, m] = entry.date.split('-').map(Number);
    if (!y || !m) continue;
    const key = `${y}-${String(m).padStart(2, '0')}`;
    let bucket = map.get(key);
    if (!bucket) {
      bucket = { year: y, month: m, entries: [] };
      map.set(key, bucket);
    }
    bucket.entries.push(entry);
  }
  return Array.from(map.values()).sort((a, b) => {
    if (a.year !== b.year) return a.year - b.year;
    return a.month - b.month;
  });
}

interface AggregatedStats {
  periodLabel: string; // e.g. "Settimana 16 2026"
  startDate: Date;
  endDate: Date;
  newJobs: number;
  closedJobs: number;
  updated: number;
  totalJobsEnd: number;
  totalJobsStart: number;
  totalJobsDelta: number;
  topRoles: Array<{ name: string; added: number; delta: number }>;
  topEmployers: Array<{ name: string; added: number; url?: string }>;
  cityBreakdown: Array<{ name: string; key: string; added: number; percentage: number }>;
  /** ≤12 entries, oldest first — used for the 12-week trend chart. */
  trendSeries: Array<{ periodLabel: string; value: number }>;
  activeEmployers: number;
  /** null when we don't have salary info for this bucket (hub only). */
  medianSalary: number | null;
}

function aggregateStatsForEntries(
  entries: ReadonlyArray<HistoryEntry>,
): Pick<AggregatedStats, 'newJobs' | 'closedJobs' | 'updated' | 'totalJobsEnd' | 'totalJobsStart' | 'totalJobsDelta' | 'topRoles' | 'topEmployers' | 'cityBreakdown' | 'activeEmployers'> {
  const newJobs = sum(entries.map((e) => e.added ?? 0));
  const closedJobs = sum(entries.map((e) => e.removed ?? 0));
  const updated = sum(entries.map((e) => e.updated ?? 0));
  const totalJobsEnd = entries.length > 0 ? entries[entries.length - 1].totalJobs ?? 0 : 0;
  const totalJobsStart = entries.length > 0 ? entries[0].totalJobs ?? 0 : 0;

  // Top roles (titleStats.addedKeys)
  const roleMap = new Map<string, { name: string; added: number }>();
  for (const entry of entries) {
    for (const t of entry.titleStats ?? []) {
      const cur = roleMap.get(t.key);
      const add = t.addedKeys?.length ?? 0;
      if (cur) cur.added += add;
      else roleMap.set(t.key, { name: t.name, added: add });
    }
  }
  const topRoles = Array.from(roleMap.values())
    .filter((r) => r.added > 0)
    .sort((a, b) => b.added - a.added)
    .slice(0, 5)
    .map((r) => ({ name: r.name, added: r.added, delta: r.added }));

  // Top employers (companyStats.addedKeys)
  const employerMap = new Map<string, { name: string; added: number; url?: string }>();
  for (const entry of entries) {
    for (const c of entry.companyStats ?? []) {
      const cur = employerMap.get(c.key);
      const add = c.addedKeys?.length ?? 0;
      if (cur) {
        cur.added += add;
      } else {
        employerMap.set(c.key, { name: c.name, added: add, url: c.url });
      }
    }
  }
  const topEmployers = Array.from(employerMap.values())
    .filter((e) => e.added > 0)
    .sort((a, b) => b.added - a.added)
    .slice(0, 5);

  // City breakdown — count addedKeys for our 5 Ticino cities
  const cityCounts = new Map<string, number>();
  for (const { key } of TICINO_CITIES) cityCounts.set(key, 0);
  for (const entry of entries) {
    for (const l of entry.locationStats ?? []) {
      if (cityCounts.has(l.key)) {
        const cur = cityCounts.get(l.key) ?? 0;
        cityCounts.set(l.key, cur + (l.addedKeys?.length ?? 0));
      }
    }
  }
  const totalCityAdded = sum(Array.from(cityCounts.values()));
  const cityBreakdown = TICINO_CITIES.map((c) => {
    const added = cityCounts.get(c.key) ?? 0;
    const percentage = totalCityAdded > 0 ? clampPercentage((added / totalCityAdded) * 100) : 0;
    return { name: c.name, key: c.key, added, percentage };
  }).sort((a, b) => b.added - a.added);

  // Active employers = distinct company keys that appear in any entry
  const activeEmployers = new Set<string>();
  for (const entry of entries) {
    for (const c of entry.companyStats ?? []) {
      if ((c.addedKeys?.length ?? 0) + (c.updatedKeys?.length ?? 0) + (c.removedKeys?.length ?? 0) > 0) {
        activeEmployers.add(c.key);
      }
    }
  }

  return {
    newJobs,
    closedJobs,
    updated,
    totalJobsEnd,
    totalJobsStart,
    totalJobsDelta: totalJobsEnd - totalJobsStart,
    topRoles,
    topEmployers,
    cityBreakdown,
    activeEmployers: activeEmployers.size,
  };
}

/** Compute a median salary from the current jobs.json snapshot. */
function computeMedianSalaryFromJobs(jobs: ReadonlyArray<JobRecord>): number | null {
  const vals: number[] = [];
  for (const job of jobs) {
    if (job.expired || job.needsRetranslation) continue;
    const b = job.baseSalary?.value;
    if (!b) continue;
    if (typeof b.minValue === 'number' && typeof b.maxValue === 'number' && b.minValue > 0 && b.maxValue > 0) {
      vals.push(Math.round((b.minValue + b.maxValue) / 2));
    } else if (typeof b.minValue === 'number' && b.minValue > 0) {
      vals.push(b.minValue);
    } else if (typeof b.maxValue === 'number' && b.maxValue > 0) {
      vals.push(b.maxValue);
    }
  }
  return median(vals);
}

// ── Builders ───────────────────────────────────────────────────

export interface PeriodStats extends AggregatedStats {
  /** Canonical path for this period. */
  canonicalPath: (locale: JobMarketSnapshotLocale) => string;
}

function buildWeeklyAggregates(
  bucket: WeekBucket,
  trendSeries: Array<{ periodLabel: string; value: number }>,
  medianSalary: number | null,
): AggregatedStats {
  const core = aggregateStatsForEntries(bucket.entries);
  return {
    ...core,
    periodLabel: `${bucket.isoYear}-W${String(bucket.isoWeek).padStart(2, '0')}`,
    startDate: bucket.monday,
    endDate: bucket.sunday,
    trendSeries,
    medianSalary,
  };
}

function buildMonthlyAggregates(
  bucket: MonthBucket,
  trendSeries: Array<{ periodLabel: string; value: number }>,
  medianSalary: number | null,
): AggregatedStats {
  const core = aggregateStatsForEntries(bucket.entries);
  const startDate = new Date(Date.UTC(bucket.year, bucket.month - 1, 1));
  const endDate = new Date(Date.UTC(bucket.year, bucket.month, 0)); // last day of month
  return {
    ...core,
    periodLabel: `${bucket.year}-${String(bucket.month).padStart(2, '0')}`,
    startDate,
    endDate,
    trendSeries,
    medianSalary,
  };
}

// ── Localised copy ─────────────────────────────────────────────

interface LocalisedCopy {
  hubHeading: string;
  hubIntro: string;
  hubParagraph: string;
  hubLatestLabel: string;
  hubArchiveLabel: string;
  hubSeeCurrentWeek: string;
  seriesKicker: string;
  weeklyHeading: (week: number, year: number) => string;
  weeklyIntro: (stats: AggregatedStats) => string;
  weeklyParagraph: (stats: AggregatedStats) => string;
  monthlyHeading: (monthLabel: string, year: number) => string;
  monthlyIntro: (stats: AggregatedStats) => string;
  monthlyParagraph: (stats: AggregatedStats) => string;
  statNewJobs: string;
  statClosedJobs: string;
  statActiveEmployers: string;
  statMedianSalary: string;
  topRolesHeading: string;
  topEmployersHeading: string;
  cityBreakdownHeading: string;
  trendHeading: string;
  trendEmpty: string;
  degradedNote: string;
  relatedLinksHeading: string;
  relatedLinks: Array<{ href: string; label: string }>;
  breadcrumbHome: string;
  weekDateRange: (start: Date, end: Date, locale: JobMarketSnapshotLocale) => string;
  freshnessLabel: (isoDate: string) => string;
  methodologyHeading: string;
  methodologyBody: string;
  faqTitle: string;
  faq: Array<{ q: string; a: string }>;
}

function weekRangeLabel(start: Date, end: Date, locale: JobMarketSnapshotLocale): string {
  return `${formatDate(start, locale)} – ${formatDate(end, locale)}`;
}

const COPY: Record<JobMarketSnapshotLocale, LocalisedCopy> = {
  it: {
    hubHeading: 'Mercato del lavoro in Ticino — report settimanale',
    hubIntro:
      'Ogni settimana raccogliamo e pubblichiamo i dati aggregati sul mercato del lavoro in Ticino: nuove offerte, offerte chiuse, datori di lavoro più attivi, ruoli più richiesti e distribuzione delle posizioni tra Lugano, Mendrisio, Bellinzona, Locarno e Chiasso.',
    hubParagraph:
      'Frontaliere Ticino monitora in modo continuo le principali fonti di offerte di lavoro nel Canton Ticino — portali aziendali, aggregatori pubblici, ATS e bollettini cantonali — e ne sintetizza ogni giorno il delta: quante posizioni sono apparse, quante sono state aggiornate, quante hanno chiuso, in quali città, per quali ruoli. A partire da questi dati grezzi componiamo il report settimanale e l\'aggregato mensile che trovi qui sotto: uno strumento utile a frontalieri, HR interne, giornalisti e analisti di policy che vogliono capire come si muove la domanda di lavoro a sud delle Alpi, senza doversi affidare a ricerche puntuali su singoli portali.',
    hubLatestLabel: 'Ultime settimane',
    hubArchiveLabel: 'Archivio mensile',
    hubSeeCurrentWeek: 'Vai al report della settimana corrente',
    seriesKicker: 'Report mercato del lavoro · Ticino',
    weeklyHeading: (week, year) => `Mercato del lavoro in Ticino — settimana ${week} ${year}`,
    weeklyIntro: (stats) =>
      `Tra il ${formatDate(stats.startDate, 'it')} e il ${formatDate(stats.endDate, 'it')} sono apparse ${stats.newJobs} nuove offerte in Ticino, ${stats.closedJobs} sono state rimosse e ${stats.activeEmployers} aziende hanno pubblicato almeno un annuncio. Il totale delle offerte attive ha chiuso la settimana a ${stats.totalJobsEnd} (${formatDelta(stats.totalJobsDelta, 'it')} rispetto al lunedì).`,
    weeklyParagraph: (stats) =>
      `In termini di dinamica, il Ticino ha prodotto in media ${Math.round(stats.newJobs / 7)} nuove offerte al giorno. ${stats.topEmployers[0] ? `Il datore di lavoro più attivo è stato ${stats.topEmployers[0].name} con ${stats.topEmployers[0].added} nuove posizioni, seguito da ${stats.topEmployers.slice(1, 3).map((e) => e.name).join(' e ') || 'altri datori di lavoro del cantone'}. ` : ''}Le figure più richieste rientrano in ambito sanità, produzione, vendita e servizi — in coerenza con la struttura economica ticinese, dove EOC, la grande distribuzione e il comparto industriale continuano a rappresentare le principali quote di domanda. Lugano e Bellinzona guidano la classifica geografica delle nuove offerte, con Mendrisio e Locarno che mantengono un ruolo significativo anche grazie al polo farmaceutico del Mendrisiotto e al turismo del Locarnese. Il dato va letto come istantanea: le offerte possono chiudere rapidamente e l\'elenco dei migliori datori di lavoro varia di settimana in settimana, quindi i frontalieri in cerca di opportunità fanno bene a tornare sulle pagine hub per città o settore nei giorni feriali.`,
    monthlyHeading: (monthLabel, year) => `Mercato del lavoro in Ticino — ${monthLabel} ${year}`,
    monthlyIntro: (stats) =>
      `Nel mese di riferimento (${formatDate(stats.startDate, 'it')} – ${formatDate(stats.endDate, 'it')}) sono apparse ${stats.newJobs} nuove offerte in Ticino, ${stats.closedJobs} sono state chiuse e ${stats.activeEmployers} aziende hanno pubblicato almeno un annuncio. Il totale offerte ha chiuso il mese a ${stats.totalJobsEnd} posizioni attive.`,
    monthlyParagraph: (stats) =>
      `La vista mensile aggrega i report settimanali per offrire una lettura più stabile del mercato. Media giornaliera di nuove offerte: ${Math.round(stats.newJobs / Math.max(1, Math.ceil((stats.endDate.getTime() - stats.startDate.getTime()) / (24 * 3600 * 1000))))} annunci. ${stats.topEmployers.slice(0, 3).length ? `I tre datori di lavoro più attivi sono stati ${stats.topEmployers.slice(0, 3).map((e) => `${e.name} (${e.added})`).join(', ')}. ` : ''}Le figure più richieste si concentrano nei comparti che storicamente trainano la domanda in Ticino: cure, produzione manifatturiera, vendita al dettaglio, amministrazione pubblica. Per i frontalieri italiani che valutano un trasferimento o un cambio di azienda, il dato mensile è utile per capire se la domanda sta crescendo o rallentando rispetto al mese precedente, e per individuare finestre favorevoli di candidatura. Il report si basa sugli stessi dati che alimentano il nostro job board, aggiornati più volte al giorno da oltre 80 crawler dedicati ai principali datori di lavoro del cantone.`,
    statNewJobs: 'Nuove offerte',
    statClosedJobs: 'Offerte chiuse',
    statActiveEmployers: 'Aziende attive',
    statMedianSalary: 'Stipendio mediano',
    topRolesHeading: 'Top 5 ruoli per volume',
    topEmployersHeading: 'Top 5 datori di lavoro',
    cityBreakdownHeading: 'Distribuzione per città',
    trendHeading: 'Andamento ultime 12 settimane',
    trendEmpty:
      'Lo storico a 12 settimane è in costruzione: il grafico si popola man mano che accumuliamo nuovi snapshot settimanali.',
    degradedNote:
      'Stiamo iniziando a raccogliere lo storico settimanale del mercato ticinese. Questo primo report è basato sullo snapshot corrente delle offerte: i confronti week-over-week compariranno non appena avremo almeno due settimane complete di dati.',
    relatedLinksHeading: 'Approfondimenti',
    relatedLinks: [
      { href: '/cerca-lavoro-ticino/lugano/', label: 'Lavoro a Lugano' },
      { href: '/cerca-lavoro-ticino/mendrisio/', label: 'Lavoro a Mendrisio' },
      { href: '/cerca-lavoro-ticino/bellinzona/', label: 'Lavoro a Bellinzona' },
      { href: '/cerca-lavoro-ticino/ultimi-3-giorni/', label: 'Offerte degli ultimi 3 giorni' },
      { href: '/cerca-lavoro-ticino/', label: 'Tutte le offerte di lavoro in Ticino' },
    ],
    breadcrumbHome: 'Home',
    weekDateRange: (start, end) => weekRangeLabel(start, end, 'it'),
    freshnessLabel: (isoDate) => `Aggiornato al ${isoDate}`,
    methodologyHeading: 'Metodologia',
    methodologyBody:
      'I dati provengono da oltre 80 crawler dedicati ai principali datori di lavoro ticinesi, ai bollettini cantonali e agli aggregatori pubblici. Ogni notte aggiorniamo lo snapshot delle offerte attive e calcoliamo il delta rispetto al giorno precedente. Il report settimanale aggrega i delta da lunedì a domenica (settimana ISO). Le mediane salariali, quando disponibili, sono calcolate sulla base dei campi baseSalary delle offerte che espongono un range retributivo nel formato schema.org MonetaryAmount.',
    faqTitle: 'Domande frequenti',
    faq: [
      {
        q: 'Quanto spesso viene aggiornato il report?',
        a: 'Il report settimanale viene generato ogni settimana alla chiusura della settimana ISO (domenica), la pagina hub viene rigenerata ogni volta che pubblichiamo nuovi dati.',
      },
      {
        q: 'Da dove arrivano i dati?',
        a: 'I nostri crawler monitorano portali aziendali, ATS (Workable, Greenhouse, SAP SuccessFactors, Umantis, etc.), bollettini del Canton Ticino, aggregatori pubblici e siti istituzionali. La pipeline aggrega i risultati, deduplica e normalizza città e ruoli per lingua.',
      },
      {
        q: 'Come posso scaricare i dati grezzi?',
        a: 'I JSON-LD Dataset integrati in ogni report rendono la pagina leggibile dai motori di ricerca come fonte dati strutturata. Per richieste di export più approfondite contatta il team via form di contatto.',
      },
    ],
  },
  en: {
    hubHeading: 'Ticino job market — weekly report',
    hubIntro:
      'Every week we publish aggregated data on the Ticino job market: new postings, closed postings, most active employers, most in-demand roles, and the geographic breakdown across Lugano, Mendrisio, Bellinzona, Locarno and Chiasso.',
    hubParagraph:
      'Frontaliere Ticino continuously monitors the main job posting sources in the canton of Ticino — corporate portals, public aggregators, ATS platforms and cantonal bulletins — and publishes the daily delta: how many positions appeared, were updated, or closed, in which cities and for which roles. From this raw data we compose the weekly report and monthly aggregate below: a practical tool for cross-border workers, internal HR teams, journalists and policy analysts who want to understand how labour demand is moving south of the Alps without relying on piecemeal searches on individual portals.',
    hubLatestLabel: 'Latest weeks',
    hubArchiveLabel: 'Monthly archive',
    hubSeeCurrentWeek: 'Open the current week report',
    seriesKicker: 'Job market report · Ticino',
    weeklyHeading: (week, year) => `Ticino job market — week ${week} ${year}`,
    weeklyIntro: (stats) =>
      `Between ${formatDate(stats.startDate, 'en')} and ${formatDate(stats.endDate, 'en')}, ${stats.newJobs} new openings appeared in Ticino, ${stats.closedJobs} were removed, and ${stats.activeEmployers} employers posted at least one listing. The total number of active positions closed the week at ${stats.totalJobsEnd} (${formatDelta(stats.totalJobsDelta, 'en')} compared to Monday).`,
    weeklyParagraph: (stats) =>
      `In terms of dynamics, Ticino produced an average of ${Math.round(stats.newJobs / 7)} new postings per day. ${stats.topEmployers[0] ? `The most active employer was ${stats.topEmployers[0].name} with ${stats.topEmployers[0].added} new openings, followed by ${stats.topEmployers.slice(1, 3).map((e) => e.name).join(' and ') || 'other cantonal employers'}. ` : ''}The most in-demand roles sit in healthcare, manufacturing, retail and services — consistent with Ticino\'s economic structure, where EOC, large retailers and industrial firms account for the bulk of demand. Lugano and Bellinzona lead the geographic ranking of new postings, with Mendrisio and Locarno holding meaningful shares thanks to the Mendrisiotto pharma cluster and the Locarno tourism belt. Treat this as a snapshot: postings can close quickly and the top-employer mix varies from week to week, so cross-border workers looking for opportunities should keep an eye on the per-city and per-sector hubs during weekdays.`,
    monthlyHeading: (monthLabel, year) => `Ticino job market — ${monthLabel} ${year}`,
    monthlyIntro: (stats) =>
      `During the reference month (${formatDate(stats.startDate, 'en')} – ${formatDate(stats.endDate, 'en')}), ${stats.newJobs} new openings appeared in Ticino, ${stats.closedJobs} were closed, and ${stats.activeEmployers} employers posted at least one listing. Active postings closed the month at ${stats.totalJobsEnd} positions.`,
    monthlyParagraph: (stats) =>
      `The monthly view aggregates the weekly reports to offer a more stable reading of the market. Daily average of new postings: ${Math.round(stats.newJobs / Math.max(1, Math.ceil((stats.endDate.getTime() - stats.startDate.getTime()) / (24 * 3600 * 1000))))}. ${stats.topEmployers.slice(0, 3).length ? `The three most active employers were ${stats.topEmployers.slice(0, 3).map((e) => `${e.name} (${e.added})`).join(', ')}. ` : ''}The most in-demand roles concentrate in the sectors that historically drive Ticino\'s demand: healthcare, manufacturing, retail and public administration. For Italian cross-border workers weighing a move or a job change, the monthly figure is useful to see whether demand is growing or slowing compared to the previous month, and to identify favourable application windows. The report is powered by the same data that feeds our job board, refreshed multiple times a day by 80+ crawlers dedicated to the canton\'s top employers.`,
    statNewJobs: 'New postings',
    statClosedJobs: 'Closed postings',
    statActiveEmployers: 'Active employers',
    statMedianSalary: 'Median salary',
    topRolesHeading: 'Top 5 roles by volume',
    topEmployersHeading: 'Top 5 employers',
    cityBreakdownHeading: 'City breakdown',
    trendHeading: 'Last 12 weeks trend',
    trendEmpty:
      'The 12-week history is still being collected: the chart will fill in as we accumulate weekly snapshots.',
    degradedNote:
      'We are just starting to collect the weekly history of the Ticino market. This first report is based on the current postings snapshot: week-over-week comparisons will appear as soon as we have at least two complete weeks of data.',
    relatedLinksHeading: 'Related reading',
    relatedLinks: [
      { href: '/en/find-jobs-ticino/lugano/', label: 'Jobs in Lugano' },
      { href: '/en/find-jobs-ticino/mendrisio/', label: 'Jobs in Mendrisio' },
      { href: '/en/find-jobs-ticino/bellinzona/', label: 'Jobs in Bellinzona' },
      { href: '/en/find-jobs-ticino/last-3-days/', label: 'Last 3 days postings' },
      { href: '/en/find-jobs-ticino/', label: 'All Ticino jobs' },
    ],
    breadcrumbHome: 'Home',
    weekDateRange: (start, end) => weekRangeLabel(start, end, 'en'),
    freshnessLabel: (isoDate) => `Updated on ${isoDate}`,
    methodologyHeading: 'Methodology',
    methodologyBody:
      'The data comes from 80+ crawlers dedicated to the main Ticino employers, cantonal bulletins and public aggregators. Each night we refresh the active-postings snapshot and compute the delta versus the previous day. The weekly report aggregates deltas from Monday to Sunday (ISO week). Median salaries, when available, are computed on the basesalary fields of postings that expose a pay range in schema.org MonetaryAmount format.',
    faqTitle: 'Frequently asked questions',
    faq: [
      {
        q: 'How often is the report updated?',
        a: 'The weekly report is generated every week at the close of the ISO week (Sunday); the hub page is regenerated whenever we publish new data.',
      },
      {
        q: 'Where does the data come from?',
        a: 'Our crawlers track corporate portals, ATS platforms (Workable, Greenhouse, SAP SuccessFactors, Umantis, etc.), canton Ticino bulletins, public aggregators and institutional sites. The pipeline aggregates, deduplicates and normalises cities and roles per locale.',
      },
      {
        q: 'How can I download the raw data?',
        a: 'The JSON-LD Dataset embedded in every report makes the page machine-readable as a structured source. For deeper export requests, reach out to the team via the contact form.',
      },
    ],
  },
  de: {
    hubHeading: 'Tessiner Arbeitsmarkt — Wochenbericht',
    hubIntro:
      'Jede Woche veröffentlichen wir aggregierte Daten zum Tessiner Arbeitsmarkt: neue Stellen, geschlossene Stellen, aktivste Arbeitgeber, gefragteste Rollen und die regionale Verteilung auf Lugano, Mendrisio, Bellinzona, Locarno und Chiasso.',
    hubParagraph:
      'Frontaliere Ticino überwacht laufend die wichtigsten Quellen von Stellenausschreibungen im Kanton Tessin — Unternehmensportale, öffentliche Aggregatoren, ATS-Plattformen und kantonale Amtsblätter — und publiziert das tägliche Delta: wie viele Positionen erschienen sind, aktualisiert oder geschlossen wurden, in welchen Städten und für welche Rollen. Aus diesen Rohdaten erstellen wir den Wochenbericht und die monatliche Aggregation: ein praktisches Werkzeug für Grenzgänger, interne HR-Teams, Journalisten und Policy-Analystinnen, die verstehen möchten, wie sich die Arbeitsnachfrage südlich der Alpen bewegt, ohne auf Einzelabfragen auf separaten Portalen angewiesen zu sein.',
    hubLatestLabel: 'Letzte Wochen',
    hubArchiveLabel: 'Monatsarchiv',
    hubSeeCurrentWeek: 'Zum aktuellen Wochenbericht',
    seriesKicker: 'Arbeitsmarkt-Bericht · Tessin',
    weeklyHeading: (week, year) => `Tessiner Arbeitsmarkt — Woche ${week} ${year}`,
    weeklyIntro: (stats) =>
      `Zwischen dem ${formatDate(stats.startDate, 'de')} und dem ${formatDate(stats.endDate, 'de')} erschienen im Tessin ${stats.newJobs} neue Stellen, ${stats.closedJobs} wurden entfernt und ${stats.activeEmployers} Arbeitgeber haben mindestens eine Anzeige veröffentlicht. Die Gesamtzahl aktiver Positionen schloss die Woche bei ${stats.totalJobsEnd} (${formatDelta(stats.totalJobsDelta, 'de')} gegenüber Montag).`,
    weeklyParagraph: (stats) =>
      `Dynamisch betrachtet produzierte das Tessin durchschnittlich ${Math.round(stats.newJobs / 7)} neue Anzeigen pro Tag. ${stats.topEmployers[0] ? `Aktivster Arbeitgeber war ${stats.topEmployers[0].name} mit ${stats.topEmployers[0].added} neuen Stellen, gefolgt von ${stats.topEmployers.slice(1, 3).map((e) => e.name).join(' und ') || 'weiteren kantonalen Arbeitgebern'}. ` : ''}Die gefragtesten Rollen konzentrieren sich in Gesundheitswesen, Produktion, Handel und Dienstleistungen — im Einklang mit der Tessiner Wirtschaftsstruktur, in der EOC, grosse Detailhändler und Industrieunternehmen den Grossteil der Nachfrage ausmachen. Lugano und Bellinzona führen die geografische Rangliste der neuen Anzeigen an, während Mendrisio und Locarno dank dem Pharma-Cluster im Mendrisiotto und dem Tourismus im Locarnese bedeutende Anteile behalten. Der Bericht ist als Momentaufnahme zu verstehen: Stellen können rasch schliessen und die Mischung der Top-Arbeitgeber variiert von Woche zu Woche — Grenzgänger auf Stellensuche sollten daher unter der Woche regelmässig auf die Stadt- und Branchen-Hubs schauen.`,
    monthlyHeading: (monthLabel, year) => `Tessiner Arbeitsmarkt — ${monthLabel} ${year}`,
    monthlyIntro: (stats) =>
      `Im Referenzmonat (${formatDate(stats.startDate, 'de')} – ${formatDate(stats.endDate, 'de')}) erschienen im Tessin ${stats.newJobs} neue Stellen, ${stats.closedJobs} wurden geschlossen und ${stats.activeEmployers} Arbeitgeber haben mindestens eine Anzeige veröffentlicht. Die aktiven Anzeigen schlossen den Monat bei ${stats.totalJobsEnd} Positionen.`,
    monthlyParagraph: (stats) =>
      `Die Monatsansicht aggregiert die Wochenberichte und bietet eine stabilere Marktlesart. Tagesdurchschnitt neuer Anzeigen: ${Math.round(stats.newJobs / Math.max(1, Math.ceil((stats.endDate.getTime() - stats.startDate.getTime()) / (24 * 3600 * 1000))))}. ${stats.topEmployers.slice(0, 3).length ? `Die drei aktivsten Arbeitgeber waren ${stats.topEmployers.slice(0, 3).map((e) => `${e.name} (${e.added})`).join(', ')}. ` : ''}Die gefragtesten Rollen konzentrieren sich in den Branchen, die die Nachfrage im Tessin historisch bestimmen: Pflege, produzierendes Gewerbe, Detailhandel, öffentliche Verwaltung. Für italienische Grenzgänger, die einen Umzug oder einen Wechsel erwägen, ist die Monatszahl nützlich, um zu sehen, ob die Nachfrage gegenüber dem Vormonat wächst oder sich abschwächt, und um günstige Bewerbungsfenster zu identifizieren. Der Bericht stützt sich auf dieselben Daten, die unser Job-Board speisen — mehrmals täglich aktualisiert durch über 80 Crawler, die den wichtigsten Arbeitgebern des Kantons gewidmet sind.`,
    statNewJobs: 'Neue Stellen',
    statClosedJobs: 'Geschlossene Stellen',
    statActiveEmployers: 'Aktive Arbeitgeber',
    statMedianSalary: 'Medianlohn',
    topRolesHeading: 'Top-5-Rollen nach Volumen',
    topEmployersHeading: 'Top-5-Arbeitgeber',
    cityBreakdownHeading: 'Verteilung nach Stadt',
    trendHeading: 'Verlauf letzte 12 Wochen',
    trendEmpty:
      'Die 12-Wochen-Historie wird noch aufgebaut: Die Grafik füllt sich mit jedem neuen Wochen-Snapshot.',
    degradedNote:
      'Wir beginnen gerade, die Wochenhistorie des Tessiner Marktes zu erfassen. Dieser erste Bericht basiert auf dem aktuellen Snapshot der Anzeigen: Wochenvergleiche erscheinen, sobald mindestens zwei vollständige Wochen vorliegen.',
    relatedLinksHeading: 'Weiterführende Seiten',
    relatedLinks: [
      { href: '/de/jobs-im-tessin/lugano/', label: 'Jobs in Lugano' },
      { href: '/de/jobs-im-tessin/mendrisio/', label: 'Jobs in Mendrisio' },
      { href: '/de/jobs-im-tessin/bellinzona/', label: 'Jobs in Bellinzona' },
      { href: '/de/jobs-im-tessin/letzte-3-tage/', label: 'Anzeigen der letzten 3 Tage' },
      { href: '/de/jobs-im-tessin/', label: 'Alle Tessiner Jobs' },
    ],
    breadcrumbHome: 'Startseite',
    weekDateRange: (start, end) => weekRangeLabel(start, end, 'de'),
    freshnessLabel: (isoDate) => `Aktualisiert am ${isoDate}`,
    methodologyHeading: 'Methodik',
    methodologyBody:
      'Die Daten stammen von über 80 Crawlern, die den wichtigsten Tessiner Arbeitgebern, kantonalen Amtsblättern und öffentlichen Aggregatoren gewidmet sind. Jede Nacht aktualisieren wir den Snapshot der aktiven Anzeigen und berechnen das Delta zum Vortag. Der Wochenbericht aggregiert die Deltas von Montag bis Sonntag (ISO-Woche). Medianlöhne werden — wenn verfügbar — aus den baseSalary-Feldern der Anzeigen berechnet, die eine Lohnspanne im Format schema.org MonetaryAmount ausweisen.',
    faqTitle: 'Häufige Fragen',
    faq: [
      {
        q: 'Wie oft wird der Bericht aktualisiert?',
        a: 'Der Wochenbericht wird jede Woche zum Abschluss der ISO-Woche (Sonntag) erzeugt; die Hub-Seite wird bei jeder Datenpublikation neu erzeugt.',
      },
      {
        q: 'Woher stammen die Daten?',
        a: 'Unsere Crawler verfolgen Unternehmensportale, ATS-Plattformen (Workable, Greenhouse, SAP SuccessFactors, Umantis usw.), Bulletins des Kantons Tessin, öffentliche Aggregatoren und Institutionen. Die Pipeline aggregiert, dedupliziert und normalisiert Städte und Rollen pro Sprache.',
      },
      {
        q: 'Wie kann ich die Rohdaten beziehen?',
        a: 'Das in jeden Bericht eingebettete JSON-LD-Dataset macht die Seite maschinenlesbar als strukturierte Quelle. Für tiefere Export-Anfragen erreicht uns das Team über das Kontaktformular.',
      },
    ],
  },
  fr: {
    hubHeading: 'Marché du travail au Tessin — rapport hebdomadaire',
    hubIntro:
      'Chaque semaine nous publions des données agrégées sur le marché du travail tessinois : nouvelles offres, offres fermées, employeurs les plus actifs, rôles les plus demandés et répartition géographique entre Lugano, Mendrisio, Bellinzona, Locarno et Chiasso.',
    hubParagraph:
      'Frontaliere Ticino surveille en continu les principales sources d\'offres d\'emploi dans le canton du Tessin — portails d\'entreprise, agrégateurs publics, plateformes ATS et bulletins cantonaux — et publie le delta quotidien : combien de postes sont apparus, ont été mis à jour ou fermés, dans quelles villes et pour quels rôles. À partir de ces données brutes, nous composons le rapport hebdomadaire et l\'agrégation mensuelle : un outil pratique pour les frontaliers, les équipes RH internes, les journalistes et les analystes politiques qui souhaitent comprendre comment évolue la demande de travail au sud des Alpes, sans dépendre de recherches ponctuelles sur des portails isolés.',
    hubLatestLabel: 'Dernières semaines',
    hubArchiveLabel: 'Archive mensuelle',
    hubSeeCurrentWeek: 'Voir le rapport de la semaine en cours',
    seriesKicker: 'Rapport marché du travail · Tessin',
    weeklyHeading: (week, year) => `Marché du travail au Tessin — semaine ${week} ${year}`,
    weeklyIntro: (stats) =>
      `Entre le ${formatDate(stats.startDate, 'fr')} et le ${formatDate(stats.endDate, 'fr')}, ${stats.newJobs} nouvelles offres sont apparues au Tessin, ${stats.closedJobs} ont été retirées et ${stats.activeEmployers} employeurs ont publié au moins une annonce. Le total des postes actifs a clôturé la semaine à ${stats.totalJobsEnd} (${formatDelta(stats.totalJobsDelta, 'fr')} par rapport au lundi).`,
    weeklyParagraph: (stats) =>
      `En termes de dynamique, le Tessin a produit en moyenne ${Math.round(stats.newJobs / 7)} nouvelles annonces par jour. ${stats.topEmployers[0] ? `L\'employeur le plus actif a été ${stats.topEmployers[0].name} avec ${stats.topEmployers[0].added} nouveaux postes, suivi de ${stats.topEmployers.slice(1, 3).map((e) => e.name).join(' et ') || 'd\'autres employeurs cantonaux'}. ` : ''}Les rôles les plus demandés relèvent de la santé, de la production, du commerce et des services — cohérent avec la structure économique tessinoise, où EOC, la grande distribution et le secteur industriel représentent l\'essentiel de la demande. Lugano et Bellinzona dominent le classement géographique des nouvelles offres, tandis que Mendrisio et Locarno conservent un rôle significatif grâce au pôle pharmaceutique du Mendrisiotto et au tourisme du Locarnese. À lire comme un instantané : les offres peuvent se fermer rapidement et la liste des meilleurs employeurs varie d\'une semaine à l\'autre, donc les frontaliers en recherche d\'opportunités ont intérêt à revenir sur les hubs par ville et par secteur les jours ouvrables.`,
    monthlyHeading: (monthLabel, year) => `Marché du travail au Tessin — ${monthLabel} ${year}`,
    monthlyIntro: (stats) =>
      `Durant le mois de référence (${formatDate(stats.startDate, 'fr')} – ${formatDate(stats.endDate, 'fr')}), ${stats.newJobs} nouvelles offres sont apparues au Tessin, ${stats.closedJobs} ont été fermées et ${stats.activeEmployers} employeurs ont publié au moins une annonce. Les offres actives ont clôturé le mois à ${stats.totalJobsEnd} postes.`,
    monthlyParagraph: (stats) =>
      `La vue mensuelle agrège les rapports hebdomadaires pour offrir une lecture plus stable du marché. Moyenne quotidienne de nouvelles annonces : ${Math.round(stats.newJobs / Math.max(1, Math.ceil((stats.endDate.getTime() - stats.startDate.getTime()) / (24 * 3600 * 1000))))}. ${stats.topEmployers.slice(0, 3).length ? `Les trois employeurs les plus actifs ont été ${stats.topEmployers.slice(0, 3).map((e) => `${e.name} (${e.added})`).join(', ')}. ` : ''}Les rôles les plus demandés se concentrent dans les secteurs qui tirent historiquement la demande tessinoise : soins, industrie manufacturière, commerce de détail, administration publique. Pour les frontaliers italiens qui envisagent un déménagement ou un changement d\'entreprise, le chiffre mensuel permet de voir si la demande augmente ou ralentit par rapport au mois précédent, et d\'identifier des fenêtres favorables pour candidater. Le rapport repose sur les mêmes données qui alimentent notre job board, mises à jour plusieurs fois par jour par plus de 80 crawlers dédiés aux principaux employeurs du canton.`,
    statNewJobs: 'Nouvelles offres',
    statClosedJobs: 'Offres fermées',
    statActiveEmployers: 'Employeurs actifs',
    statMedianSalary: 'Salaire médian',
    topRolesHeading: 'Top 5 rôles par volume',
    topEmployersHeading: 'Top 5 employeurs',
    cityBreakdownHeading: 'Répartition par ville',
    trendHeading: 'Tendance des 12 dernières semaines',
    trendEmpty:
      'L\'historique sur 12 semaines est en construction : le graphique se remplira au fur et à mesure que nous accumulons des snapshots hebdomadaires.',
    degradedNote:
      'Nous commençons à peine à collecter l\'historique hebdomadaire du marché tessinois. Ce premier rapport est basé sur le snapshot actuel des offres : les comparaisons d\'une semaine sur l\'autre apparaîtront dès que nous aurons au moins deux semaines complètes de données.',
    relatedLinksHeading: 'Pour aller plus loin',
    relatedLinks: [
      { href: '/fr/trouver-emploi-tessin/lugano/', label: 'Emploi à Lugano' },
      { href: '/fr/trouver-emploi-tessin/mendrisio/', label: 'Emploi à Mendrisio' },
      { href: '/fr/trouver-emploi-tessin/bellinzona/', label: 'Emploi à Bellinzona' },
      { href: '/fr/trouver-emploi-tessin/3-derniers-jours/', label: 'Offres des 3 derniers jours' },
      { href: '/fr/trouver-emploi-tessin/', label: 'Toutes les offres au Tessin' },
    ],
    breadcrumbHome: 'Accueil',
    weekDateRange: (start, end) => weekRangeLabel(start, end, 'fr'),
    freshnessLabel: (isoDate) => `Mis à jour le ${isoDate}`,
    methodologyHeading: 'Méthodologie',
    methodologyBody:
      'Les données proviennent de plus de 80 crawlers dédiés aux principaux employeurs tessinois, aux bulletins cantonaux et aux agrégateurs publics. Chaque nuit nous actualisons le snapshot des offres actives et calculons le delta par rapport au jour précédent. Le rapport hebdomadaire agrège les deltas du lundi au dimanche (semaine ISO). Les salaires médians, lorsqu\'ils sont disponibles, sont calculés sur les champs baseSalary des offres qui exposent une fourchette au format schema.org MonetaryAmount.',
    faqTitle: 'Questions fréquentes',
    faq: [
      {
        q: 'À quelle fréquence le rapport est-il mis à jour ?',
        a: 'Le rapport hebdomadaire est généré chaque semaine à la clôture de la semaine ISO (dimanche) ; la page hub est régénérée à chaque publication de nouvelles données.',
      },
      {
        q: 'D\'où proviennent les données ?',
        a: 'Nos crawlers suivent les portails d\'entreprise, les plateformes ATS (Workable, Greenhouse, SAP SuccessFactors, Umantis, etc.), les bulletins du canton du Tessin, les agrégateurs publics et les sites institutionnels. La pipeline agrège, dédoublonne et normalise les villes et rôles par langue.',
      },
      {
        q: 'Comment télécharger les données brutes ?',
        a: 'Le JSON-LD Dataset intégré à chaque rapport rend la page lisible par les moteurs en tant que source structurée. Pour des demandes d\'export plus approfondies, contactez l\'équipe via le formulaire de contact.',
      },
    ],
  },
};

// ── Rendering ─────────────────────────────────────────────────

interface CommonRenderInputs {
  locale: JobMarketSnapshotLocale;
  canonicalPath: string;
  alternates: Record<JobMarketSnapshotLocale, string>;
  todayIso: string;
  degraded: boolean;
  /** dist directory for entry-asset resolution (omit in tests). */
  distDir?: string;
  /**
   * Set of company slugs for which a canonical `/cerca-lavoro-ticino/azienda-{slug}/`
   * page exists. Built from `data/all-known-job-slugs.json` by the plugin.
   * When omitted, employer names are rendered as plain text.
   */
  knownSlugs?: ReadonlySet<string>;
  /** Repository root — enables `public/images/brands/*.png` lookup for company logos. */
  rootDir?: string;
}

function renderHreflangAlternates(alternates: Record<JobMarketSnapshotLocale, string>): string {
  return renderHreflangTags(alternates);
}

/**
 * Truncate a string at a word boundary (no mid-word cuts) with an ellipsis.
 * Intended for meta/JSON-LD description generation. Returns the original
 * string unchanged if it is already at or below `maxLength`.
 */
function truncateAtWordBoundary(input: string, maxLength: number): string {
  const s = input.trim();
  if (s.length <= maxLength) return s;
  // Leave room for the ellipsis character.
  const hardLimit = Math.max(1, maxLength - 1);
  const slice = s.slice(0, hardLimit);
  const lastSpace = slice.lastIndexOf(' ');
  // Use the last space if it's not absurdly early; otherwise fall back to a hard cut.
  const cutAt = lastSpace > Math.floor(hardLimit * 0.6) ? lastSpace : hardLimit;
  const trimmed = slice.slice(0, cutAt).replace(/[\s.,;:!?\-–—]+$/u, '');
  return `${trimmed}…`;
}

/**
 * Build a locale-appropriate accessible name for the SVG trend chart.
 * Combines the heading + period range + start/end values so screen readers
 * announce a meaningful trend description rather than the generic "Trend chart".
 */
function buildTrendChartAriaLabel(
  locale: JobMarketSnapshotLocale,
  trendHeading: string,
  series: ReadonlyArray<{ periodLabel: string; value: number }>,
): string {
  if (series.length < 2) return trendHeading;
  const first = series[0];
  const last = series[series.length - 1];
  const from = first.periodLabel;
  const to = last.periodLabel;
  const startValue = String(first.value);
  const endValue = String(last.value);
  switch (locale) {
    case 'en':
      return `${trendHeading}: from ${from} to ${to}, ${startValue} to ${endValue}`;
    case 'de':
      return `${trendHeading}: von ${from} bis ${to}, ${startValue} bis ${endValue}`;
    case 'fr':
      return `${trendHeading} : de ${from} à ${to}, ${startValue} à ${endValue}`;
    case 'it':
    default:
      return `${trendHeading}: da ${from} a ${to}, da ${startValue} a ${endValue}`;
  }
}

function renderSvgTrendChart(
  series: ReadonlyArray<{ periodLabel: string; value: number }>,
  trendEmptyCopy: string,
  ariaLabel: string,
): string {
  if (series.length < 2) {
    return `<p style="${STAT_TILE_WARNING};padding:14px 16px;border-radius:12px;margin:0">${esc(trendEmptyCopy)}</p>`;
  }
  const values = series.map((s) => s.value);
  const maxValue = Math.max(...values);
  const minValue = Math.min(...values);
  const width = 720;
  const height = 220;
  const padding = 32;
  const innerW = width - padding * 2;
  const innerH = height - padding * 2;
  const range = Math.max(1, maxValue - minValue);
  const points = series
    .map((s, i) => {
      const x = padding + (series.length === 1 ? innerW / 2 : (i * innerW) / (series.length - 1));
      const y = padding + innerH - ((s.value - minValue) / range) * innerH;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');
  const areaPoints = `${padding},${padding + innerH} ${points} ${padding + innerW},${padding + innerH}`;
  const ticks = series
    .map((s, i) => {
      const x = padding + (series.length === 1 ? innerW / 2 : (i * innerW) / (series.length - 1));
      return `<text x="${x.toFixed(2)}" y="${height - 8}" text-anchor="middle" font-size="11" style="fill:var(--color-chart-label)">${esc(s.periodLabel)}</text>`;
    })
    .join('');
  return `<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${esc(ariaLabel)}" style="width:100%;max-width:100%;height:auto;background:var(--color-surface-alt);border:1px solid var(--color-edge);border-radius:12px">
    <polygon points="${areaPoints}" style="fill:var(--color-chart-area)" fill-opacity="0.5" />
    <polyline points="${points}" fill="none" style="stroke:var(--color-chart-line)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />
    ${series.map((s, i) => {
      const x = padding + (series.length === 1 ? innerW / 2 : (i * innerW) / (series.length - 1));
      const y = padding + innerH - ((s.value - minValue) / range) * innerH;
      return `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="3.5" style="fill:var(--color-chart-dot)" />`;
    }).join('')}
    <text x="${padding}" y="${padding - 10}" font-size="11" style="fill:var(--color-chart-label)">${esc(String(maxValue))}</text>
    <text x="${padding}" y="${padding + innerH + 0}" font-size="11" style="fill:var(--color-chart-label)" dy="0">${esc(String(minValue))}</text>
    ${ticks}
  </svg>`;
}

function renderRelatedLinks(copy: LocalisedCopy): string {
  return `<aside style="margin:28px 0 0;${CARD_STYLE}" aria-labelledby="relatedLinks">
    <h2 id="relatedLinks" style="${H2_STYLE};font-size:18px;margin-bottom:10px">${esc(copy.relatedLinksHeading)}</h2>
    <ul style="margin:0;padding:0;list-style:none;display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px">
      ${copy.relatedLinks
        .map(
          (l) => `<li><a href="${esc(l.href)}" style="${LINK_ACCENT_STYLE};font-weight:600">${esc(l.label)} →</a></li>`,
        )
        .join('')}
    </ul>
  </aside>`;
}

function renderFaq(copy: LocalisedCopy): string {
  if (copy.faq.length === 0) return '';
  return `<section style="margin:32px 0 0" aria-labelledby="jobMarketFaq">
    <h2 id="jobMarketFaq" style="${H2_STYLE}">${esc(copy.faqTitle)}</h2>
    ${copy.faq
      .map(
        (f) => `<details style="${CARD_STYLE};margin-bottom:8px">
      <summary style="font-weight:700;cursor:pointer;color:var(--color-heading)">${esc(f.q)}</summary>
      <p style="margin:10px 0 0;color:var(--color-body);line-height:1.6">${esc(f.a)}</p>
    </details>`,
      )
      .join('')}
  </section>`;
}

function renderStatTile(
  label: string,
  value: string,
  variant: 'primary' | 'success' | 'warning' | 'neutral' = 'primary',
): string {
  const tileStyle =
    variant === 'success'
      ? STAT_TILE_SUCCESS
      : variant === 'warning'
      ? STAT_TILE_WARNING
      : variant === 'neutral'
      ? STAT_TILE_BASE
      : STAT_TILE_ACCENT;
  return `<div style="${tileStyle}">
    <div style="${STAT_TILE_LABEL}">${esc(label)}</div>
    <div style="${STAT_TILE_VALUE}">${esc(value)}</div>
  </div>`;
}

/**
 * Build a DOM-safe id slug from free-form heading text.
 * Used to wire `<section aria-labelledby>` to its `<h2 id>`.
 */
function toHeadingId(prefix: string, heading: string): string {
  const slug = heading
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${prefix}-${slug || 'section'}`;
}

function renderTopList(
  heading: string,
  items: ReadonlyArray<{ name: string; added: number; url?: string }>,
  suffixLabel: string,
  idPrefix: 'top-roles' | 'top-employers' = 'top-roles',
  rootDir?: string,
): string {
  const headingId = toHeadingId(idPrefix, heading);
  if (items.length === 0) {
    return `<section style="margin:22px 0 0" aria-labelledby="${headingId}">
      <h2 id="${headingId}" style="margin:0 0 10px;${H2_STYLE}">${esc(heading)}</h2>
      <p style="margin:0;color:var(--color-subtle)">—</p>
    </section>`;
  }
  const isEmployerList = idPrefix === 'top-employers';
  const rows = items
    .map((item, idx) => {
      const logoSlug = isEmployerList ? slugifyEmployer(item.name) : '';
      const logoUrl = rootDir && isEmployerList ? resolveBrandLogoUrl(rootDir, logoSlug) : null;
      const card = renderEntityCard({
        href: item.url,
        title: `#${idx + 1} · ${item.name}`,
        metric: `${String(item.added)} ${suffixLabel}`,
        metricTone: 'default',
        logoUrl: logoUrl ?? undefined,
        logoAlt: item.name,
        iconSvg: isEmployerList ? (logoUrl ? undefined : ICON_BUILDING_SVG) : undefined,
      });
      return `<li style="margin:0 0 8px;padding:0">${card}</li>`;
    })
    .join('');
  return `<section style="margin:22px 0 0" aria-labelledby="${headingId}">
    <h2 id="${headingId}" style="${H2_STYLE};margin-bottom:10px">${esc(heading)}</h2>
    <ol style="margin:0;padding:0;list-style:none">${rows}</ol>
  </section>`;
}

function renderCityBreakdown(
  heading: string,
  items: ReadonlyArray<{ name: string; added: number; percentage: number; key: string }>,
  locale: JobMarketSnapshotLocale,
): string {
  if (items.length === 0) return '';
  const cityLinkBase: Record<JobMarketSnapshotLocale, string> = {
    it: '/cerca-lavoro-ticino',
    en: '/en/find-jobs-ticino',
    de: '/de/jobs-im-tessin',
    fr: '/fr/trouver-emploi-tessin',
  };
  const hubKeys = new Set<string>(CITY_HUB_KEYS as readonly string[]);
  const rows = items
    .map((c) => {
      const label = hubKeys.has(c.key)
        ? `<a href="${esc(cityLinkBase[locale])}/${esc(c.key)}/" style="color:var(--color-body);text-decoration:none;font-weight:700">${esc(c.name)}</a>`
        : `<span style="color:var(--color-body);font-weight:700">${esc(c.name)}</span>`;
      return `<li style="${CARD_STYLE};margin-bottom:8px">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:12px">
      ${label}
      <span style="color:var(--color-subtle);font-weight:600">${esc(String(c.added))} · ${esc(c.percentage.toFixed(1))}%</span>
    </div>
    <div style="margin-top:8px;background:var(--color-edge);border-radius:999px;height:6px;overflow:hidden">
      <div style="width:${esc(c.percentage.toFixed(1))}%;height:100%;background:var(--color-accent)"></div>
    </div>
  </li>`;
    })
    .join('');
  return `<section style="margin:22px 0 0" aria-labelledby="cityBreakdown">
    <h2 id="cityBreakdown" style="${H2_STYLE};margin-bottom:10px">${esc(heading)}</h2>
    <ol style="margin:0;padding:0;list-style:none">${rows}</ol>
  </section>`;
}

interface SnapshotPageInputs extends CommonRenderInputs {
  kind: 'weekly' | 'monthly';
  stats: AggregatedStats;
  weekLabel?: { week: number; year: number };
  monthLabel?: { monthName: string; year: number };
  /** When true the weekly archive is marked noindex (older than 12 weeks). */
  noindex: boolean;
}

function renderSnapshotPage(inp: SnapshotPageInputs): string {
  const { locale, canonicalPath, alternates, todayIso, degraded, kind, stats, weekLabel, monthLabel, noindex, distDir, knownSlugs, rootDir } = inp;
  const copy = COPY[locale];
  const canonicalUrl = `${BASE_URL}${canonicalPath}`;
  const h1 =
    kind === 'weekly' && weekLabel
      ? copy.weeklyHeading(weekLabel.week, weekLabel.year)
      : kind === 'monthly' && monthLabel
      ? copy.monthlyHeading(monthLabel.monthName, monthLabel.year)
      : JOB_MARKET_HUB_NAME[locale];
  const intro = kind === 'weekly' ? copy.weeklyIntro(stats) : copy.monthlyIntro(stats);
  const paragraph = kind === 'weekly' ? copy.weeklyParagraph(stats) : copy.monthlyParagraph(stats);

  const periodRange =
    kind === 'weekly'
      ? copy.weekDateRange(stats.startDate, stats.endDate, locale)
      : `${formatDate(stats.startDate, locale)} – ${formatDate(stats.endDate, locale)}`;

  const degradedNote = degraded
    ? `<p style="margin:0 0 14px;padding:12px 16px;border-radius:12px;background:var(--color-warning-subtle);color:var(--color-warning);border:1px solid var(--color-warning-border)">${esc(copy.degradedNote)}</p>`
    : '';

  const statTiles = `<section style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;margin:0 0 22px" aria-label="${esc(copy.seriesKicker)}">
    ${renderStatTile(copy.statNewJobs, String(stats.newJobs), 'primary')}
    ${renderStatTile(copy.statClosedJobs, String(stats.closedJobs), 'warning')}
    ${renderStatTile(copy.statActiveEmployers, String(stats.activeEmployers), 'success')}
    ${stats.medianSalary !== null ? renderStatTile(copy.statMedianSalary, `${stats.medianSalary.toLocaleString('en-US').replace(/,/g, '\u202f')} CHF`, 'neutral') : ''}
  </section>`;

  const jobBoardSearchBaseSnapshot: Record<JobMarketSnapshotLocale, string> = {
    it: '/cerca-lavoro-ticino/',
    en: '/en/find-jobs-ticino/',
    de: '/de/jobs-im-tessin/',
    fr: '/fr/trouver-emploi-tessin/',
  };
  // Common role-slug → sector hub mapping (mirror of the table in
  // weeklyEmployersPlugin.ts:rolesHtml). Roles that map to a curated hub
  // get the canonical URL; the rest fall back to `?q=` keyword search.
  const ROLE_TO_SECTOR_HUB_SNAP: Record<string, SectorHubKey> = {
    infermiere: 'infermieri', infermieri: 'infermieri', nurse: 'infermieri', nurses: 'infermieri',
    pflegefachperson: 'infermieri', pflegepersonal: 'infermieri', infirmier: 'infermieri', infirmiere: 'infermieri',
    educatore: 'educatori', educatrice: 'educatori', educatori: 'educatori',
    erzieher: 'educatori', educateur: 'educatori', educateurs: 'educatori',
    ingegnere: 'ingegneri', ingegneri: 'ingegneri', engineer: 'ingegneri', ingenieur: 'ingegneri',
    autista: 'autisti', autisti: 'autisti', driver: 'autisti', fahrer: 'autisti', chauffeur: 'autisti',
    sviluppatore: 'sviluppatori', sviluppatori: 'sviluppatori', developer: 'sviluppatori',
    entwickler: 'sviluppatori', developpeur: 'sviluppatori',
    cuoco: 'ristorazione', cuochi: 'ristorazione', chef: 'ristorazione', cameriere: 'ristorazione',
    koch: 'ristorazione', kellner: 'ristorazione', cuisinier: 'ristorazione', serveur: 'ristorazione',
    'operatore-socio-sanitario': 'oss', oss: 'oss', osa: 'oss',
    pflegeassistent: 'oss', 'aide-soignant': 'oss',
    logistico: 'logistica', logistica: 'logistica', magazziniere: 'logistica',
    lagerist: 'logistica', logisticien: 'logistica',
    apprendista: 'apprendistato', apprendisti: 'apprendistato', apprenticeship: 'apprendistato',
    intern: 'apprendistato', lehrling: 'apprendistato', apprenti: 'apprendistato',
  };
  const topRolesList = renderTopList(
    copy.topRolesHeading,
    stats.topRoles.map((r) => {
      const roleSlug = slugifyEmployer(r.name);
      const sectorKey = ROLE_TO_SECTOR_HUB_SNAP[roleSlug.toLowerCase()];
      const url = sectorKey && (SECTOR_HUB_KEYS as readonly string[]).includes(sectorKey)
        ? `${BASE_URL}${buildSectorHubPath(locale, sectorKey)}`
        : `${jobBoardSearchBaseSnapshot[locale]}?q=${encodeURIComponent(roleSlug || r.name)}`;
      return { name: r.name, added: r.added, url };
    }),
    locale === 'it' ? 'annunci' : locale === 'de' ? 'Anzeigen' : locale === 'fr' ? 'annonces' : 'postings',
    'top-roles',
    rootDir,
  );

  const topEmployersList = renderTopList(
    copy.topEmployersHeading,
    // Use canonical /azienda-{slug}/ when a matching page exists in the
    // known-slugs registry; fall back to plain text (no broken ?q= links
    // for employers — search is less reliable for company names).
    stats.topEmployers.map((e) => ({
      name: e.name,
      added: e.added,
      url: knownSlugs ? (employerCanonicalHref(e.name, knownSlugs) ?? undefined) : undefined,
    })),
    locale === 'it' ? 'nuove offerte' : locale === 'de' ? 'neue Stellen' : locale === 'fr' ? 'nouvelles offres' : 'new openings',
    'top-employers',
    rootDir,
  );

  const cityBreakdown = renderCityBreakdown(copy.cityBreakdownHeading, stats.cityBreakdown, locale);

  const trendSection = `<section style="margin:24px 0 0" aria-labelledby="trendChart">
    <h2 id="trendChart" style="${H2_STYLE};margin-bottom:12px">${esc(copy.trendHeading)}</h2>
    ${renderSvgTrendChart(
      stats.trendSeries,
      copy.trendEmpty,
      buildTrendChartAriaLabel(locale, copy.trendHeading, stats.trendSeries),
    )}
  </section>`;

  const methodology = `<section style="margin:26px 0 0" aria-labelledby="methodology">
    <h2 id="methodology" style="${H2_STYLE};margin-bottom:10px">${esc(copy.methodologyHeading)}</h2>
    <p style="margin:0;color:var(--color-body);line-height:1.65">${esc(copy.methodologyBody)}</p>
  </section>`;

  const faqHtml = renderFaq(copy);
  const relatedHtml = renderRelatedLinks(copy);

  const alternatesHtml = renderHreflangAlternates(alternates);

  // JSON-LD
  const breadcrumbLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: copy.breadcrumbHome, item: `${BASE_URL}/` },
      {
        '@type': 'ListItem',
        position: 2,
        name: JOB_MARKET_HUB_NAME[locale],
        item: `${BASE_URL}${buildHubPath(locale)}`,
      },
      { '@type': 'ListItem', position: 3, name: h1, item: canonicalUrl },
    ],
  });

  const articleLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'NewsArticle',
    headline: h1,
    description: truncateAtWordBoundary(intro, 220),
    datePublished: stats.endDate.toISOString(),
    dateModified: `${todayIso}T00:00:00.000Z`,
    author: {
      '@type': 'Organization',
      name: 'Frontaliere Ticino',
      url: BASE_URL,
    },
    publisher: {
      '@type': 'Organization',
      name: 'Frontaliere Ticino',
      url: BASE_URL,
      logo: {
        '@type': 'ImageObject',
        url: `${BASE_URL}/logo-512.png`,
      },
    },
    mainEntityOfPage: canonicalUrl,
    inLanguage: locale,
  });

  const datasetLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Dataset',
    inLanguage: locale,
    name: h1,
    description: intro,
    url: canonicalUrl,
    isAccessibleForFree: true,
    license: 'https://creativecommons.org/licenses/by/4.0/',
    creator: {
      '@type': 'Organization',
      name: 'Frontaliere Ticino',
      url: BASE_URL,
    },
    publisher: {
      '@type': 'Organization',
      name: 'Frontaliere Ticino',
      url: BASE_URL,
    },
    dateModified: `${todayIso}T00:00:00.000Z`,
    datePublished: stats.endDate.toISOString(),
    temporalCoverage: `${stats.startDate.toISOString().slice(0, 10)}/${stats.endDate.toISOString().slice(0, 10)}`,
    spatialCoverage: {
      '@type': 'Place',
      name: 'Canton Ticino',
      address: {
        '@type': 'PostalAddress',
        addressCountry: 'CH',
        addressRegion: 'TI',
      },
    },
    keywords: [
      'Canton Ticino',
      'frontalieri',
      'lavoro Ticino',
      'mercato del lavoro',
      'job market',
      'cross-border workers',
    ],
    distribution: [
      {
        '@type': 'DataDownload',
        encodingFormat: 'application/json',
        contentUrl: `${BASE_URL}/data/jobs-stats.json`,
        name: 'Ticino jobs statistics (weekly snapshot)',
      },
      {
        '@type': 'DataDownload',
        encodingFormat: 'text/html',
        contentUrl: canonicalUrl,
        name: 'HTML report',
      },
    ],
    variableMeasured: [
      copy.statNewJobs,
      copy.statClosedJobs,
      copy.statActiveEmployers,
      copy.topRolesHeading,
      copy.topEmployersHeading,
      copy.cityBreakdownHeading,
    ],
  });

  const faqLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    inLanguage: locale,
    mainEntity: copy.faq.map((f) => ({
      '@type': 'Question',
      name: f.q,
      acceptedAnswer: { '@type': 'Answer', text: f.a },
    })),
  });

  // Phase 3A — title vs H1 differentiation (Semrush W2 ≤60 char + W3
  // "Duplicate H1 and title tags"). The H1 is the editorial headline (e.g.
  // "Ticino job market — March 2026"); the SEO title MUST stay distinct
  // even after the brand suffix is stripped, so each variant adds an extra
  // keyword (trends/Statistik/tendances/statistiche) the H1 doesn't carry.
  // Title-uniqueness fix (2026-04-27): put the month / week disambiguator
  // BEFORE the trailing keyword qualifier so it survives the 60-char clamp.
  // Without this rearrangement two adjacent months collapse to the same
  // truncated title (e.g. "Mercato lavoro Ticino — statistiche…").
  const titleBase =
    kind === 'weekly' && weekLabel
      ? (locale === 'it' ? `Mercato lavoro Ticino W${weekLabel.week} ${weekLabel.year} — report`
        : locale === 'en' ? `Ticino job market W${weekLabel.week} ${weekLabel.year} — report`
        : locale === 'de' ? `Tessiner Arbeitsmarkt W${weekLabel.week} ${weekLabel.year} — Bericht`
        : `Marché travail Tessin S${weekLabel.week} ${weekLabel.year} — rapport`)
      : kind === 'monthly' && monthLabel
      ? (locale === 'it' ? `Mercato lavoro Ticino ${monthLabel.monthName} ${monthLabel.year} — statistiche`
        : locale === 'en' ? `Ticino job market ${monthLabel.monthName} ${monthLabel.year} — trends`
        : locale === 'de' ? `Tessiner Arbeitsmarkt ${monthLabel.monthName} ${monthLabel.year} — Statistik`
        : `Marché travail Tessin ${monthLabel.monthName} ${monthLabel.year} — tendances`)
      : JOB_MARKET_HUB_NAME[locale];
  const title = clampSiteSuffix(titleBase, 'Frontaliere Ticino');
  const description = truncateAtWordBoundary(intro, 180);

  const robots = noindex ? 'noindex,follow' : 'index,follow';

  const bodyHtml = `<article style="max-width:1100px;margin:0 auto;padding:32px 20px 56px">
    <nav style="${BREADCRUMB_STYLE}">
      <a href="${BASE_URL}/" style="${BREADCRUMB_LINK_STYLE}">${esc(copy.breadcrumbHome)}</a>
      <span> / </span>
      <a href="${BASE_URL}${buildHubPath(locale)}" style="${BREADCRUMB_LINK_STYLE}">${esc(JOB_MARKET_HUB_NAME[locale])}</a>
      <span> / </span>
      <span>${esc(periodRange)}</span>
    </nav>
    <header style="margin-bottom:22px">
      <p style="${HERO_EYEBROW_STYLE}">${esc(copy.seriesKicker)} · ${esc(periodRange)}</p>
      <h1 style="${H1_STYLE}">${esc(h1)}</h1>
      <p style="margin:0 0 10px;color:var(--color-subtle);font-size:13px">${esc(copy.freshnessLabel(todayIso))}</p>
      <p style="${LEDE_STYLE}">${esc(intro)}</p>
    </header>
    ${degradedNote}
    ${statTiles}
    <section style="margin:0 0 22px">
      <p style="margin:0;color:var(--color-body);line-height:1.7;max-width:860px">${esc(paragraph)}</p>
    </section>
    ${topRolesList}
    ${topEmployersList}
    ${cityBreakdown}
    ${trendSection}
    ${methodology}
    ${faqHtml}
    ${relatedHtml}
    ${renderDiscoverMore(locale, JOB_MARKET_DISCOVER_MORE_CTAS[locale])}
    ${generateRelatedLinksBlock(locale, 'job_market_snapshot')}
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
    robots,
    ogType: 'article',
    ogLocale: JOB_MARKET_OG_LOCALE[locale],
    hreflangHtml: alternatesHtml,
    extraHeadHtml: extraHead,
    jsonLdScripts: [breadcrumbLd, articleLd, datasetLd, faqLd],
    bodyHtml,
    distDir,
    hubChrome: { hubKey: 'stats', activeSubTab: 'jobs-observatory' },
  });
}

interface HubPageInputs extends CommonRenderInputs {
  latestWeeks: Array<{
    week: number;
    year: number;
    href: string;
    rangeLabel: string;
    newJobs: number;
    activeEmployers: number;
  }>;
  monthlyArchive: Array<{ monthLabel: string; href: string; year: number; month: number }>;
  latestWeekHref: string | null;
  heroStats: AggregatedStats | null;
}

function renderHubPage(inp: HubPageInputs): string {
  const { locale, canonicalPath, alternates, todayIso, degraded, latestWeeks, monthlyArchive, latestWeekHref, heroStats, distDir } = inp;
  const copy = COPY[locale];
  const canonicalUrl = `${BASE_URL}${canonicalPath}`;
  const h1 = copy.hubHeading;

  const degradedNote = degraded
    ? `<p style="margin:0 0 14px;padding:12px 16px;border-radius:12px;background:var(--color-warning-subtle);color:var(--color-warning);border:1px solid var(--color-warning-border)">${esc(copy.degradedNote)}</p>`
    : '';

  const heroStatsHtml = heroStats
    ? `<section style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;margin:0 0 22px">
      ${renderStatTile(copy.statNewJobs, String(heroStats.newJobs), 'primary')}
      ${renderStatTile(copy.statClosedJobs, String(heroStats.closedJobs), 'warning')}
      ${renderStatTile(copy.statActiveEmployers, String(heroStats.activeEmployers), 'success')}
      ${heroStats.medianSalary !== null ? renderStatTile(copy.statMedianSalary, `${heroStats.medianSalary.toLocaleString('en-US').replace(/,/g, '\u202f')} CHF`, 'neutral') : ''}
    </section>`
    : '';

  const latestWeeksHtml = latestWeeks.length > 0
    ? `<section style="margin:24px 0 0" aria-labelledby="latestWeeks">
        <h2 id="latestWeeks" style="${H2_STYLE}">${esc(copy.hubLatestLabel)}</h2>
        <ol style="margin:0;padding:0;list-style:none;display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px">
          ${latestWeeks
            .map(
              (w) => `<li style="${CARD_STYLE}">
                <a href="${esc(w.href)}" style="color:var(--color-body);text-decoration:none;display:block">
                  <div style="font-weight:700;font-size:16px">${esc(copy.weeklyHeading(w.week, w.year))}</div>
                  <div style="margin-top:4px;color:var(--color-subtle);font-size:13px">${esc(w.rangeLabel)}</div>
                  <div style="margin-top:10px;display:flex;gap:14px;font-size:14px;color:var(--color-body)">
                    <span><strong>${esc(String(w.newJobs))}</strong> ${esc(copy.statNewJobs.toLowerCase())}</span>
                    <span><strong>${esc(String(w.activeEmployers))}</strong> ${esc(copy.statActiveEmployers.toLowerCase())}</span>
                  </div>
                </a>
              </li>`,
            )
            .join('')}
        </ol>
      </section>`
    : '';

  const archiveHtml = monthlyArchive.length > 0
    ? `<section style="margin:24px 0 0" aria-labelledby="monthlyArchive">
        <h2 id="monthlyArchive" style="${H2_STYLE}">${esc(copy.hubArchiveLabel)}</h2>
        <ul style="margin:0;padding:0;list-style:none;display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px">
          ${monthlyArchive
            .map(
              (m) => `<li><a href="${esc(m.href)}" style="${LINK_ACCENT_STYLE};font-weight:600">${esc(m.monthLabel)} →</a></li>`,
            )
            .join('')}
        </ul>
      </section>`
    : '';

  const ctaHtml = latestWeekHref
    ? `<p style="margin:0 0 20px"><a href="${esc(latestWeekHref)}" style="display:inline-flex;align-items:center;gap:6px;padding:12px 22px;border-radius:12px;background:var(--color-accent);color:var(--color-on-accent);text-decoration:none;font-weight:700">${esc(copy.hubSeeCurrentWeek)} →</a></p>`
    : '';

  const methodology = `<section style="margin:26px 0 0" aria-labelledby="methodology">
    <h2 id="methodology" style="${H2_STYLE};margin-bottom:10px">${esc(copy.methodologyHeading)}</h2>
    <p style="margin:0;color:var(--color-body);line-height:1.65">${esc(copy.methodologyBody)}</p>
  </section>`;

  const faqHtml = renderFaq(copy);
  const relatedHtml = renderRelatedLinks(copy);
  const alternatesHtml = renderHreflangAlternates(alternates);

  const breadcrumbLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: copy.breadcrumbHome, item: `${BASE_URL}/` },
      { '@type': 'ListItem', position: 2, name: JOB_MARKET_HUB_NAME[locale], item: canonicalUrl },
    ],
  });

  const collectionLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: h1,
    description: copy.hubIntro,
    url: canonicalUrl,
    inLanguage: locale,
    dateModified: `${todayIso}T00:00:00.000Z`,
    isPartOf: {
      '@type': 'WebSite',
      name: 'Frontaliere Ticino',
      url: BASE_URL,
    },
  });

  const hubDatasetLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Dataset',
    inLanguage: locale,
    name: h1,
    description: copy.hubIntro,
    url: canonicalUrl,
    isAccessibleForFree: true,
    license: 'https://creativecommons.org/licenses/by/4.0/',
    creator: {
      '@type': 'Organization',
      name: 'Frontaliere Ticino',
      url: BASE_URL,
    },
    publisher: {
      '@type': 'Organization',
      name: 'Frontaliere Ticino',
      url: BASE_URL,
    },
    dateModified: `${todayIso}T00:00:00.000Z`,
    spatialCoverage: {
      '@type': 'Place',
      name: 'Canton Ticino',
      address: {
        '@type': 'PostalAddress',
        addressCountry: 'CH',
        addressRegion: 'TI',
      },
    },
    keywords: [
      'Canton Ticino',
      'frontalieri',
      'lavoro Ticino',
      'mercato del lavoro',
      'job market',
      'cross-border workers',
    ],
    distribution: [
      {
        '@type': 'DataDownload',
        encodingFormat: 'application/json',
        contentUrl: `${BASE_URL}/data/jobs-stats.json`,
        name: 'Ticino jobs statistics (weekly snapshot)',
      },
      {
        '@type': 'DataDownload',
        encodingFormat: 'text/html',
        contentUrl: canonicalUrl,
        name: 'HTML hub',
      },
    ],
    variableMeasured: [
      copy.statNewJobs,
      copy.statActiveEmployers,
      copy.topRolesHeading,
      copy.topEmployersHeading,
    ],
  });

  const faqLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    inLanguage: locale,
    mainEntity: copy.faq.map((f) => ({
      '@type': 'Question',
      name: f.q,
      acceptedAnswer: { '@type': 'Answer', text: f.a },
    })),
  });

  // Hub root: H1 is the editorial heading ("Ticino job market — weekly
  // report"); add a year stamp + brand suffix so SEO <title> stays
  // distinct even after the test's stripBrand normalisation (Semrush W3).
  const titleBase = `${h1} ${new Date().getFullYear()}`;
  const title = clampSiteSuffix(titleBase, 'Frontaliere Ticino');
  const description = truncateAtWordBoundary(copy.hubIntro, 180);

  const bodyHtml = `<article style="max-width:1100px;margin:0 auto;padding:32px 20px 56px">
    <nav style="${BREADCRUMB_STYLE}">
      <a href="${BASE_URL}/" style="${BREADCRUMB_LINK_STYLE}">${esc(copy.breadcrumbHome)}</a>
      <span> / </span>
      <span>${esc(JOB_MARKET_HUB_NAME[locale])}</span>
    </nav>
    <header style="margin-bottom:22px">
      <p style="${HERO_EYEBROW_STYLE}">${esc(copy.seriesKicker)}</p>
      <h1 style="${H1_STYLE}">${esc(h1)}</h1>
      <p style="margin:0 0 10px;color:var(--color-subtle);font-size:13px">${esc(copy.freshnessLabel(todayIso))}</p>
      <p style="${LEDE_STYLE}">${esc(copy.hubIntro)}</p>
    </header>
    ${degradedNote}
    ${ctaHtml}
    ${heroStatsHtml}
    <section style="margin:0 0 22px">
      <p style="margin:0;color:var(--color-body);line-height:1.7;max-width:860px">${esc(copy.hubParagraph)}</p>
    </section>
    ${latestWeeksHtml}
    ${archiveHtml}
    ${methodology}
    ${faqHtml}
    ${relatedHtml}
    ${renderDiscoverMore(locale, JOB_MARKET_DISCOVER_MORE_CTAS[locale])}
    ${generateRelatedLinksBlock(locale, 'job_market_snapshot')}
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
    ogLocale: JOB_MARKET_OG_LOCALE[locale],
    hreflangHtml: alternatesHtml,
    extraHeadHtml: extraHead,
    jsonLdScripts: [breadcrumbLd, collectionLd, hubDatasetLd, faqLd],
    bodyHtml,
    distDir,
    hubChrome: { hubKey: 'stats', activeSubTab: 'jobs-observatory' },
  });
}

// ── Page generator (pure) ─────────────────────────────────────

export interface GeneratorInputs {
  history: StatsHistoryDataset | null;
  jobs: ReadonlyArray<JobRecord>;
  today?: Date;
  /** dist directory for entry-asset resolution (omit in tests). */
  distDir?: string;
  /**
   * Set of company slugs for which a canonical `/cerca-lavoro-ticino/azienda-{slug}/`
   * page exists. When omitted, employer names are rendered as plain text.
   */
  knownSlugs?: ReadonlySet<string>;
  /** Repository root — enables `public/images/brands/*.png` lookup for company logos. */
  rootDir?: string;
}

export interface GeneratorOutput {
  pages: Record<string, string>;
  /** True when we fell back to current-snapshot-only (history too sparse). */
  degraded: boolean;
  /** Weekly buckets in the normal mode, or synthesised ones in degraded mode. */
  completedWeeks: WeekBucket[];
  completedMonths: MonthBucket[];
}

function alternatesForHub(): Record<JobMarketSnapshotLocale, string> {
  const out: Record<JobMarketSnapshotLocale, string> = { it: '', en: '', de: '', fr: '' };
  for (const loc of JOB_MARKET_SNAPSHOT_LOCALES) out[loc] = buildHubPath(loc);
  return out;
}

function alternatesForWeek(isoYear: number, isoWeek: number): Record<JobMarketSnapshotLocale, string> {
  const out: Record<JobMarketSnapshotLocale, string> = { it: '', en: '', de: '', fr: '' };
  for (const loc of JOB_MARKET_SNAPSHOT_LOCALES) out[loc] = buildWeeklyPath(loc, isoYear, isoWeek);
  return out;
}

function alternatesForMonth(year: number, month: number): Record<JobMarketSnapshotLocale, string> {
  const out: Record<JobMarketSnapshotLocale, string> = { it: '', en: '', de: '', fr: '' };
  for (const loc of JOB_MARKET_SNAPSHOT_LOCALES) out[loc] = buildMonthlyPath(loc, year, month);
  return out;
}

/**
 * Build a trend series (totalJobs at bucket end) for the most recent 12
 * complete weeks. Shorter series are returned when history is thinner.
 */
export function buildWeeklyTrendSeries(
  buckets: ReadonlyArray<WeekBucket>,
): Array<{ periodLabel: string; value: number }> {
  const last = buckets.slice(-12);
  return last.map((b) => ({
    periodLabel: `W${String(b.isoWeek).padStart(2, '0')}`,
    value: b.entries.length > 0 ? b.entries[b.entries.length - 1].totalJobs ?? 0 : 0,
  }));
}

export function generateJobMarketSnapshotPages(opts: GeneratorInputs): GeneratorOutput {
  const today = opts.today ?? new Date();
  const distDir = opts.distDir;
  const knownSlugs = opts.knownSlugs;
  const rootDir = opts.rootDir;
  const todayIso = today.toISOString().slice(0, 10);
  const entries = opts.history?.entries ?? [];
  const completedWeeks = bucketHistoryByWeek(entries, { requireComplete: true });
  const allWeekBuckets = bucketHistoryByWeek(entries, { requireComplete: false });
  const completedMonths = bucketHistoryByMonth(entries).filter((m) => {
    // Skip the current (in-progress) month
    const currentMonthKey = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, '0')}`;
    const bucketKey = `${m.year}-${String(m.month).padStart(2, '0')}`;
    return bucketKey < currentMonthKey;
  });

  const medianSalary = computeMedianSalaryFromJobs(opts.jobs);

  const pages: Record<string, string> = {};
  const trendSeries = buildWeeklyTrendSeries(completedWeeks);
  const degraded = completedWeeks.length < MIN_HISTORY_WEEKS_FOR_NORMAL_MODE;

  // ── Hero stats for the hub (uses most-recent complete week when available,
  //    otherwise falls back to the current in-progress bucket so the hub
  //    still shows something meaningful on day one).
  let heroStats: AggregatedStats | null = null;
  if (completedWeeks.length > 0) {
    const latest = completedWeeks[completedWeeks.length - 1];
    heroStats = buildWeeklyAggregates(latest, trendSeries, medianSalary);
  } else if (allWeekBuckets.length > 0) {
    const latest = allWeekBuckets[allWeekBuckets.length - 1];
    heroStats = buildWeeklyAggregates(latest, trendSeries, medianSalary);
  } else if (opts.jobs.length > 0) {
    // No history — synthesise a very lightweight hero stat line from jobs.json.
    const activeEmployers = new Set<string>();
    for (const job of opts.jobs) {
      if (job.expired || job.needsRetranslation) continue;
      if (job.company) activeEmployers.add(job.company);
    }
    heroStats = {
      periodLabel: todayIso,
      startDate: new Date(today.getTime() - 6 * 24 * 3600 * 1000),
      endDate: today,
      newJobs: opts.jobs.filter((j) => !j.expired && !j.needsRetranslation).length,
      closedJobs: 0,
      updated: 0,
      totalJobsEnd: opts.jobs.filter((j) => !j.expired && !j.needsRetranslation).length,
      totalJobsStart: 0,
      totalJobsDelta: 0,
      topRoles: [],
      topEmployers: [],
      cityBreakdown: TICINO_CITIES.map((c) => ({ name: c.name, key: c.key, added: 0, percentage: 0 })),
      trendSeries: [],
      activeEmployers: activeEmployers.size,
      medianSalary,
    };
  }

  // ── Hub pages (always emitted for all 4 locales)
  const latestWeeksSummary = completedWeeks.slice(-4).reverse().map((b) => {
    const summary = aggregateStatsForEntries(b.entries);
    return { bucket: b, summary };
  });

  for (const locale of JOB_MARKET_SNAPSHOT_LOCALES) {
    const canonicalPath = buildHubPath(locale);
    const latestWeeks = latestWeeksSummary.map(({ bucket, summary }) => ({
      week: bucket.isoWeek,
      year: bucket.isoYear,
      href: `${BASE_URL}${buildWeeklyPath(locale, bucket.isoYear, bucket.isoWeek)}`,
      rangeLabel: weekRangeLabel(bucket.monday, bucket.sunday, locale),
      newJobs: summary.newJobs,
      activeEmployers: summary.activeEmployers,
    }));

    const monthlyArchive = completedMonths.slice().reverse().map((m) => ({
      year: m.year,
      month: m.month,
      monthLabel: `${JOB_MARKET_MONTH_NAMES[locale][m.month].charAt(0).toUpperCase() + JOB_MARKET_MONTH_NAMES[locale][m.month].slice(1)} ${m.year}`,
      href: `${BASE_URL}${buildMonthlyPath(locale, m.year, m.month)}`,
    }));

    const latestBucket = completedWeeks[completedWeeks.length - 1] ?? allWeekBuckets[allWeekBuckets.length - 1];
    const latestWeekHref = latestBucket
      ? `${BASE_URL}${buildWeeklyPath(locale, latestBucket.isoYear, latestBucket.isoWeek)}`
      : null;

    pages[canonicalPath] = renderHubPage({
      locale,
      canonicalPath,
      alternates: alternatesForHub(),
      todayIso,
      degraded,
      latestWeeks,
      monthlyArchive,
      latestWeekHref,
      heroStats,
      distDir,
      knownSlugs,
    });
  }

  // ── Weekly pages (for every completed week in all 4 locales)
  // If degraded mode, emit a single weekly page for the most-recent in-progress bucket.
  const weeksToEmit: Array<{ bucket: WeekBucket; noindex: boolean }> = [];
  if (completedWeeks.length > 0) {
    const allowedIndexable = completedWeeks.slice(-WEEKLY_INDEXABLE_LIMIT);
    const allowedSet = new Set(allowedIndexable.map((b) => `${b.isoYear}-${b.isoWeek}`));
    for (const bucket of completedWeeks) {
      const key = `${bucket.isoYear}-${bucket.isoWeek}`;
      weeksToEmit.push({ bucket, noindex: !allowedSet.has(key) });
    }
  } else if (allWeekBuckets.length > 0) {
    // Degraded mode: emit the latest in-progress bucket so the hub link resolves
    weeksToEmit.push({ bucket: allWeekBuckets[allWeekBuckets.length - 1], noindex: false });
  }

  for (const { bucket, noindex } of weeksToEmit) {
    const stats = buildWeeklyAggregates(bucket, trendSeries, medianSalary);
    for (const locale of JOB_MARKET_SNAPSHOT_LOCALES) {
      const canonicalPath = buildWeeklyPath(locale, bucket.isoYear, bucket.isoWeek);
      pages[canonicalPath] = renderSnapshotPage({
        locale,
        kind: 'weekly',
        stats,
        weekLabel: { week: bucket.isoWeek, year: bucket.isoYear },
        canonicalPath,
        alternates: alternatesForWeek(bucket.isoYear, bucket.isoWeek),
        todayIso,
        degraded,
        noindex,
        distDir,
        knownSlugs,
        rootDir,
      });
    }
  }

  // ── Monthly pages (completed months, all 4 locales)
  for (const bucket of completedMonths) {
    const stats = buildMonthlyAggregates(bucket, trendSeries, medianSalary);
    for (const locale of JOB_MARKET_SNAPSHOT_LOCALES) {
      const canonicalPath = buildMonthlyPath(locale, bucket.year, bucket.month);
      const monthName =
        JOB_MARKET_MONTH_NAMES[locale][bucket.month].charAt(0).toUpperCase() +
        JOB_MARKET_MONTH_NAMES[locale][bucket.month].slice(1);
      pages[canonicalPath] = renderSnapshotPage({
        locale,
        kind: 'monthly',
        stats,
        monthLabel: { monthName, year: bucket.year },
        canonicalPath,
        alternates: alternatesForMonth(bucket.year, bucket.month),
        todayIso,
        degraded: false,
        noindex: false,
        distDir,
        knownSlugs,
        rootDir,
      });
    }
  }

  return { pages, degraded, completedWeeks, completedMonths };
}

// ── Per-sector snapshot generation (D-3A) ──────────────────────

/** Case-insensitive match of a job against a sector keyword pattern. */
function jobMatchesSector(job: JobRecord, sector: JobMarketSectorKey): boolean {
  const pattern = JOB_MARKET_SECTOR_MATCHERS[sector];
  const parts: string[] = [];
  if (job.title) parts.push(String(job.title));
  if (job.description) parts.push(String(job.description));
  if (job.category) parts.push(String(job.category));
  if (job.company) parts.push(String(job.company));
  if (job.location) parts.push(String(job.location));
  if (job.addressLocality) parts.push(String(job.addressLocality));
  if (job.tags) {
    if (Array.isArray(job.tags)) parts.push(job.tags.join(' '));
    else parts.push(String(job.tags));
  }
  if (job.titleByLocale) {
    for (const v of Object.values(job.titleByLocale)) {
      if (typeof v === 'string') parts.push(v);
    }
  }
  if (job.descriptionByLocale) {
    for (const v of Object.values(job.descriptionByLocale)) {
      if (typeof v === 'string') parts.push(v);
    }
  }
  return pattern.test(parts.join(' \n '));
}

function jobIsActiveForSector(job: JobRecord): boolean {
  if (!job || typeof job !== 'object') return false;
  if (job.expired) return false;
  const nr = job.needsRetranslation;
  if (nr === true) return false;
  return true;
}

interface SectorStats {
  sector: JobMarketSectorKey;
  activeJobs: number;
  topEmployers: Array<{ name: string; count: number }>;
  medianSalary: number | null;
  trendSeries: Array<{ periodLabel: string; value: number }>;
  totalJobsEnd: number;
  /** Week-over-week new postings delta for this sector (may be null if history sparse). */
  weeklyDelta: number | null;
  /** Month-over-month new postings delta for this sector (may be null if history sparse). */
  monthlyDelta: number | null;
}

/** Count additions for a sector within a HistoryEntry using the keyword matcher
 *  applied against title/location/company stat keys. */
function countSectorAddsInEntry(entry: HistoryEntry, sector: JobMarketSectorKey): number {
  const pattern = JOB_MARKET_SECTOR_MATCHERS[sector];
  let total = 0;
  for (const t of entry.titleStats ?? []) {
    if (pattern.test(t.key) || pattern.test(t.name)) {
      total += t.addedKeys?.length ?? 0;
    }
  }
  return total;
}

function aggregateSectorStats(
  sector: JobMarketSectorKey,
  jobs: ReadonlyArray<JobRecord>,
  history: ReadonlyArray<HistoryEntry>,
  completedWeeks: ReadonlyArray<WeekBucket>,
  completedMonths: ReadonlyArray<MonthBucket>,
): SectorStats {
  const matching: JobRecord[] = [];
  for (const job of jobs) {
    if (!jobIsActiveForSector(job)) continue;
    if (jobMatchesSector(job, sector)) matching.push(job);
  }
  const activeJobs = matching.length;

  // Top employers for this sector
  const employerMap = new Map<string, number>();
  for (const job of matching) {
    const name = String(job.company || '').trim();
    if (!name) continue;
    employerMap.set(name, (employerMap.get(name) ?? 0) + 1);
  }
  const topEmployers = Array.from(employerMap.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, count]) => ({ name, count }));

  // Median salary estimate for this sector
  const salaryVals: number[] = [];
  for (const job of matching) {
    const b = job.baseSalary?.value;
    if (!b) continue;
    if (typeof b.minValue === 'number' && typeof b.maxValue === 'number' && b.minValue > 0 && b.maxValue > 0) {
      salaryVals.push(Math.round((b.minValue + b.maxValue) / 2));
    } else if (typeof b.minValue === 'number' && b.minValue > 0) {
      salaryVals.push(b.minValue);
    } else if (typeof b.maxValue === 'number' && b.maxValue > 0) {
      salaryVals.push(b.maxValue);
    }
  }
  const medianSalary = median(salaryVals);

  // Trend series: last 12 complete weeks, per-week additions for this sector.
  const recent = completedWeeks.slice(-12);
  const trendSeries = recent.map((b) => {
    let value = 0;
    for (const e of b.entries) value += countSectorAddsInEntry(e, sector);
    return { periodLabel: `W${String(b.isoWeek).padStart(2, '0')}`, value };
  });

  // Weekly delta: compare last vs second-to-last complete week
  let weeklyDelta: number | null = null;
  if (completedWeeks.length >= 2) {
    const last = completedWeeks[completedWeeks.length - 1];
    const prev = completedWeeks[completedWeeks.length - 2];
    const lastAdds = last.entries.reduce((s, e) => s + countSectorAddsInEntry(e, sector), 0);
    const prevAdds = prev.entries.reduce((s, e) => s + countSectorAddsInEntry(e, sector), 0);
    weeklyDelta = lastAdds - prevAdds;
  }

  // Monthly delta: compare last vs second-to-last complete month
  let monthlyDelta: number | null = null;
  if (completedMonths.length >= 2) {
    const last = completedMonths[completedMonths.length - 1];
    const prev = completedMonths[completedMonths.length - 2];
    const lastAdds = last.entries.reduce((s, e) => s + countSectorAddsInEntry(e, sector), 0);
    const prevAdds = prev.entries.reduce((s, e) => s + countSectorAddsInEntry(e, sector), 0);
    monthlyDelta = lastAdds - prevAdds;
  }

  const totalJobsEnd = history.length > 0 ? history[history.length - 1].totalJobs ?? 0 : activeJobs;

  return {
    sector,
    activeJobs,
    topEmployers,
    medianSalary,
    trendSeries,
    totalJobsEnd,
    weeklyDelta,
    monthlyDelta,
  };
}

// ── Localised sector copy ──────────────────────────────────────

interface SectorCopy {
  h1: (sectorLabel: string) => string;
  metaTitle: (sectorLabel: string) => string;
  metaDesc: (sectorLabel: string, count: number) => string;
  kicker: string;
  intro: (sectorLabel: string, count: number) => string;
  paragraph1: (sectorLabel: string, stats: SectorStats) => string;
  paragraph2: (sectorLabel: string) => string;
  statActiveJobs: string;
  statMedianSalary: string;
  statWeeklyDelta: string;
  statMonthlyDelta: string;
  statEditorialFallback: string;
  topEmployersHeading: string;
  trendHeading: string;
  trendEmpty: string;
  sectorHubCta: (sectorLabel: string) => string;
  sectorHubLink: (sectorSlug: string, locale: JobMarketSnapshotLocale) => string;
  snapshotRootCta: string;
  methodologyHeading: string;
  methodologyBody: (sectorLabel: string) => string;
  breadcrumbHome: string;
  breadcrumbSectorHub: string;
  freshnessLabel: (isoDate: string) => string;
  faqTitle: string;
  faq: (sectorLabel: string, stats: SectorStats) => Array<{ q: string; a: string }>;
}

const CITY_SECTOR_HUB_PREFIX: Record<JobMarketSnapshotLocale, string> = {
  it: '/cerca-lavoro-ticino',
  en: '/en/find-jobs-ticino',
  de: '/de/jobs-im-tessin',
  fr: '/fr/trouver-emploi-tessin',
};

const SECTOR_COPY: Record<JobMarketSnapshotLocale, SectorCopy> = {
  it: {
    h1: (label) => `Mercato lavoro ${label} Ticino — offerte attive oggi`,
    metaTitle: (label) =>
      `Mercato lavoro ${label} Ticino — stipendi, datori di lavoro, trend | Frontaliere Ticino`,
    metaDesc: (label, count) =>
      `${count} offerte attive per ${label} in Ticino. Top datori di lavoro, stipendio mediano, trend delle ultime 12 settimane, delta settimanale e mensile.`,
    kicker: 'Report di settore · Ticino',
    intro: (label, count) =>
      `Questa pagina aggrega i dati chiave del mercato del lavoro ticinese nel comparto ${label}. ${count > 0 ? `Al momento ci sono ${count} offerte attive per ${label}` : `Al momento non sono presenti offerte attive per ${label}`}, monitorate ogni giorno dai nostri crawler. Trovi i principali datori di lavoro, la stima dello stipendio mediano, il trend delle nuove posizioni nelle ultime 12 settimane e il confronto con la settimana e il mese precedenti.`,
    paragraph1: (label, stats) =>
      `Le offerte per ${label} in Ticino si concentrano su ${stats.topEmployers.slice(0, 3).map((e) => e.name).join(', ') || 'diversi datori di lavoro cantonali'}. La domanda è in linea con la struttura economica del cantone, dove sanità pubblica (EOC, cliniche private), retail organizzato (Migros, Coop, Denner), industria (Lonza, AMAG, Mikron) e servizi (assicurazioni, banche, ingegneria) rappresentano le principali componenti della domanda. I frontalieri italiani con permesso G possono candidarsi direttamente: la stragrande maggioranza dei datori di lavoro ticinesi accetta candidature trans-frontaliere, a condizione che le competenze linguistiche e tecniche richieste dall'annuncio siano soddisfatte.`,
    paragraph2: (label) =>
      `Lo stipendio mediano riportato è una stima calcolata sui campi baseSalary.minValue / baseSalary.maxValue delle offerte ${label} che dichiarano una forchetta salariale secondo lo schema schema.org MonetaryAmount. Le offerte senza indicazione esplicita del salario non entrano nel calcolo. Il trend a 12 settimane misura le nuove posizioni apparse per settimana nel settore, usando lo storico aggregato di jobs-stats-history.json; quando la serie è corta o piatta, significa che la finestra storica non copre ancora abbastanza settimane per mostrare una dinamica significativa. Ti consigliamo di controllare la pagina più volte nel corso della settimana: le offerte in Ticino tendono a chiudere rapidamente e i datori di lavoro con più turnover — ospedali, case anziani, retail — aprono e chiudono posizioni ogni giorno.`,
    statActiveJobs: 'Offerte attive',
    statMedianSalary: 'Stipendio mediano',
    statWeeklyDelta: 'Delta settimanale',
    statMonthlyDelta: 'Delta mensile',
    statEditorialFallback: 'storico in costruzione',
    topEmployersHeading: 'Datori di lavoro più attivi',
    trendHeading: 'Trend nuove posizioni — ultime 12 settimane',
    trendEmpty:
      'Lo storico a 12 settimane per questo settore è ancora in costruzione: il grafico si popola man mano che raccogliamo nuovi snapshot.',
    sectorHubCta: (label) => `Vedi tutte le offerte ${label} in Ticino`,
    sectorHubLink: (sectorSlug, _locale) => `/cerca-lavoro-ticino/${sectorSlug}/`,
    snapshotRootCta: 'Report mercato del lavoro Ticino',
    methodologyHeading: 'Metodologia',
    methodologyBody: (label) =>
      `I conteggi per ${label} derivano da un matching case-insensitive su titolo, descrizione, categoria, azienda e tag delle offerte attive. Le nuove posizioni per settore nel trend settimanale provengono da jobs-stats-history.json, filtrando i titleStats che matchano il pattern keyword del settore. Le offerte scadute (expired=true) e quelle in attesa di ritraduzione (needsRetranslation=true) sono escluse. I dati sono aggiornati più volte al giorno dai nostri 80+ crawler dedicati ai principali datori di lavoro ticinesi, ai bollettini cantonali e agli aggregatori pubblici.`,
    breadcrumbHome: 'Home',
    breadcrumbSectorHub: 'Settori',
    freshnessLabel: (isoDate) => `Aggiornato al ${isoDate}`,
    faqTitle: 'Domande frequenti',
    faq: (label, stats) => [
      {
        q: `Quanti posti di lavoro per ${label} ci sono in Ticino?`,
        a:
          stats.activeJobs > 0
            ? `Attualmente ci sono ${stats.activeJobs} offerte attive per ${label} in Ticino, aggiornate più volte al giorno dai nostri crawler.`
            : `La lista è aggiornata più volte al giorno. Torna fra qualche ora per nuove offerte ${label} in Ticino.`,
      },
      {
        q: 'Posso candidarmi come frontaliere?',
        a: `Sì. La maggior parte dei datori di lavoro ticinesi accetta candidature da frontalieri italiani con permesso G. Ogni annuncio porta alla candidatura ufficiale del datore di lavoro.`,
      },
      {
        q: 'Come viene calcolato lo stipendio mediano?',
        a: `Lo stipendio mediano è la mediana dei valori baseSalary.minValue / baseSalary.maxValue delle offerte ${label} che dichiarano una forchetta salariale. Le offerte senza salario esplicito non entrano nel calcolo.`,
      },
    ],
  },
  en: {
    h1: (label) => `${label} job market in Ticino — openings today`,
    metaTitle: (label) =>
      `${label} job market in Ticino — salaries, employers, trends | Frontaliere Ticino`,
    metaDesc: (label, count) =>
      `${count} active openings for ${label} in Ticino. Top employers, median salary, 12-week trend, week-over-week and month-over-month deltas.`,
    kicker: 'Sector report · Ticino',
    intro: (label, count) =>
      `This page aggregates the key signals of the Ticino job market for the ${label} sector. ${count > 0 ? `There are currently ${count} active openings for ${label}` : `There are no active openings for ${label}`} — monitored daily by our crawlers. You'll find the most active employers, the estimated median salary, the trend of new postings over the last 12 weeks, and week-over-week / month-over-month deltas.`,
    paragraph1: (label, stats) =>
      `Openings for ${label} in Ticino concentrate around ${stats.topEmployers.slice(0, 3).map((e) => e.name).join(', ') || 'several cantonal employers'}. Demand aligns with the canton's economic structure: public healthcare (EOC, private clinics), organised retail (Migros, Coop, Denner), industry (Lonza, AMAG, Mikron) and services (insurance, banking, engineering) account for most of the hiring. Italian cross-border workers with a G permit can apply directly: the vast majority of Ticino employers accept cross-border applications provided the language and technical requirements stated in the posting are met.`,
    paragraph2: (label) =>
      `The median salary shown is computed from the baseSalary.minValue / baseSalary.maxValue fields of ${label} postings that declare a pay range in the schema.org MonetaryAmount format. Postings without an explicit salary are not counted. The 12-week trend measures new openings per week for the sector, using the aggregated history in jobs-stats-history.json; when the series is short or flat, the history window does not yet cover enough weeks to show a meaningful trend. We recommend checking the page multiple times per week: Ticino postings tend to close quickly, and higher-turnover employers — hospitals, elderly-care homes, retail — open and close positions daily.`,
    statActiveJobs: 'Active openings',
    statMedianSalary: 'Median salary',
    statWeeklyDelta: 'Week-over-week delta',
    statMonthlyDelta: 'Month-over-month delta',
    statEditorialFallback: 'history still building',
    topEmployersHeading: 'Most active employers',
    trendHeading: 'New openings trend — last 12 weeks',
    trendEmpty:
      'The 12-week history for this sector is still being collected: the chart fills in as we gather snapshots.',
    sectorHubCta: (label) => `See all ${label} openings in Ticino`,
    sectorHubLink: (sectorSlug, _locale) => `/en/find-jobs-ticino/${sectorSlug}/`,
    snapshotRootCta: 'Ticino job market report',
    methodologyHeading: 'Methodology',
    methodologyBody: (label) =>
      `The ${label} counts come from a case-insensitive match on title, description, category, company and tags of active postings. Weekly new-posting counts in the trend come from jobs-stats-history.json by filtering titleStats that match the sector keyword pattern. Expired postings (expired=true) and those awaiting retranslation (needsRetranslation=true) are excluded. Data refreshes several times per day, driven by 80+ crawlers dedicated to Ticino's main employers, cantonal bulletins and public aggregators.`,
    breadcrumbHome: 'Home',
    breadcrumbSectorHub: 'Sectors',
    freshnessLabel: (isoDate) => `Updated on ${isoDate}`,
    faqTitle: 'Frequently asked questions',
    faq: (label, stats) => [
      {
        q: `How many ${label} jobs are there in Ticino?`,
        a:
          stats.activeJobs > 0
            ? `There are currently ${stats.activeJobs} active openings for ${label} in Ticino, refreshed multiple times per day.`
            : `The list refreshes several times per day. Check back soon for new ${label} openings in Ticino.`,
      },
      {
        q: 'Can I apply as a cross-border worker?',
        a: `Yes. Most Ticino employers accept applications from Italian cross-border workers with a G permit. Each listing links directly to the employer's official application page.`,
      },
      {
        q: 'How is the median salary computed?',
        a: `The median salary is the median of the baseSalary.minValue / baseSalary.maxValue values of ${label} postings that declare a pay range. Postings without an explicit salary are not counted.`,
      },
    ],
  },
  de: {
    h1: (label) => `Arbeitsmarkt ${label} Tessin — aktive Stellen heute`,
    metaTitle: (label) =>
      `Arbeitsmarkt ${label} Tessin — Löhne, Arbeitgeber, Trends | Frontaliere Ticino`,
    metaDesc: (label, count) =>
      `${count} aktive Stellen für ${label} im Tessin. Top-Arbeitgeber, Medianlohn, 12-Wochen-Trend, Wochen- und Monatsdelta.`,
    kicker: 'Branchenbericht · Tessin',
    intro: (label, count) =>
      `Diese Seite aggregiert die wichtigsten Signale des Tessiner Arbeitsmarkts für die Branche ${label}. ${count > 0 ? `Aktuell sind ${count} aktive Stellen für ${label} ausgeschrieben` : `Aktuell gibt es keine aktiven Stellen für ${label}`} — täglich von unseren Crawlern erfasst. Du findest die aktivsten Arbeitgeber, den geschätzten Medianlohn, den Trend neuer Stellen über die letzten 12 Wochen sowie Wochen- und Monatsvergleiche.`,
    paragraph1: (label, stats) =>
      `Die Stellen für ${label} im Tessin konzentrieren sich bei ${stats.topEmployers.slice(0, 3).map((e) => e.name).join(', ') || 'verschiedenen kantonalen Arbeitgebern'}. Die Nachfrage entspricht der wirtschaftlichen Struktur des Kantons: öffentliches Gesundheitswesen (EOC, Privatkliniken), organisierter Detailhandel (Migros, Coop, Denner), Industrie (Lonza, AMAG, Mikron) und Dienstleistungen (Versicherungen, Banken, Engineering) bilden den Hauptteil der Einstellungen. Italienische Grenzgänger mit G-Bewilligung können sich direkt bewerben: Die grosse Mehrheit der Tessiner Arbeitgeber akzeptiert Bewerbungen von Grenzgängern, sofern die Sprach- und Fachanforderungen der Anzeige erfüllt sind.`,
    paragraph2: (label) =>
      `Der angezeigte Medianlohn wird aus den Feldern baseSalary.minValue / baseSalary.maxValue der ${label}-Anzeigen berechnet, die eine Lohnspanne im schema.org MonetaryAmount-Format ausweisen. Anzeigen ohne expliziten Lohn werden nicht gezählt. Der 12-Wochen-Trend misst wöchentliche Neueröffnungen in der Branche und nutzt die aggregierte Historie aus jobs-stats-history.json. Wenn die Serie kurz oder flach wirkt, reicht das Zeitfenster noch nicht, um eine aussagekräftige Dynamik zu zeigen. Wir empfehlen, die Seite mehrmals pro Woche zu prüfen: Tessiner Stellen schliessen schnell, und Arbeitgeber mit hoher Fluktuation — Spitäler, Altenheime, Detailhandel — eröffnen und schliessen täglich Positionen.`,
    statActiveJobs: 'Aktive Stellen',
    statMedianSalary: 'Medianlohn',
    statWeeklyDelta: 'Wochen-Delta',
    statMonthlyDelta: 'Monats-Delta',
    statEditorialFallback: 'Historie im Aufbau',
    topEmployersHeading: 'Aktivste Arbeitgeber',
    trendHeading: 'Neue Stellen — letzte 12 Wochen',
    trendEmpty:
      'Die 12-Wochen-Historie für diese Branche wird noch erfasst: Die Grafik füllt sich mit jedem neuen Snapshot.',
    sectorHubCta: (label) => `Alle ${label}-Stellen im Tessin ansehen`,
    sectorHubLink: (sectorSlug, _locale) => `/de/jobs-im-tessin/${sectorSlug}/`,
    snapshotRootCta: 'Tessiner Arbeitsmarkt-Bericht',
    methodologyHeading: 'Methodik',
    methodologyBody: (label) =>
      `Die Zählungen für ${label} stammen aus einem case-insensitiven Abgleich auf Titel, Beschreibung, Kategorie, Firma und Tags der aktiven Anzeigen. Die wöchentlichen Neueinträge im Trend kommen aus jobs-stats-history.json: wir filtern titleStats, die dem Keyword-Muster der Branche entsprechen. Abgelaufene Anzeigen (expired=true) und Anzeigen mit ausstehender Nachübersetzung (needsRetranslation=true) werden ausgeschlossen. Die Daten werden mehrmals täglich aktualisiert, betrieben von 80+ Crawlern für die wichtigsten Tessiner Arbeitgeber, kantonale Bulletins und öffentliche Aggregatoren.`,
    breadcrumbHome: 'Startseite',
    breadcrumbSectorHub: 'Branchen',
    freshnessLabel: (isoDate) => `Aktualisiert am ${isoDate}`,
    faqTitle: 'Häufige Fragen',
    faq: (label, stats) => [
      {
        q: `Wie viele Stellen für ${label} gibt es im Tessin?`,
        a:
          stats.activeJobs > 0
            ? `Aktuell sind ${stats.activeJobs} aktive Stellen für ${label} im Tessin verfügbar, mehrmals täglich aktualisiert.`
            : `Die Liste wird mehrmals täglich aktualisiert. Schauen Sie bald wieder für neue ${label}-Stellen im Tessin vorbei.`,
      },
      {
        q: 'Kann ich mich als Grenzgänger bewerben?',
        a: `Ja. Die meisten Tessiner Arbeitgeber akzeptieren Bewerbungen von italienischen Grenzgängern mit G-Bewilligung. Jede Anzeige verlinkt direkt auf die offizielle Bewerbungsseite.`,
      },
      {
        q: 'Wie wird der Medianlohn berechnet?',
        a: `Der Medianlohn ist der Median der baseSalary.minValue / baseSalary.maxValue-Werte der ${label}-Anzeigen, die eine Lohnspanne deklarieren. Anzeigen ohne expliziten Lohn fliessen nicht in die Berechnung ein.`,
      },
    ],
  },
  fr: {
    h1: (label) => `Marché du travail ${label} Tessin — offres actives aujourd'hui`,
    metaTitle: (label) =>
      `Marché du travail ${label} Tessin — salaires, employeurs, tendances | Frontaliere Ticino`,
    metaDesc: (label, count) =>
      `${count} offres actives pour ${label} au Tessin. Employeurs les plus actifs, salaire médian, tendance sur 12 semaines, deltas hebdomadaire et mensuel.`,
    kicker: 'Rapport sectoriel · Tessin',
    intro: (label, count) =>
      `Cette page agrège les signaux clés du marché du travail tessinois pour le secteur ${label}. ${count > 0 ? `Il y a actuellement ${count} offres actives pour ${label}` : `Il n'y a actuellement aucune offre active pour ${label}`} — surveillées chaque jour par nos crawlers. Tu trouves les employeurs les plus actifs, une estimation du salaire médian, la tendance des nouvelles offres sur les 12 dernières semaines et les comparaisons hebdomadaire et mensuelle.`,
    paragraph1: (label, stats) =>
      `Les offres pour ${label} au Tessin se concentrent sur ${stats.topEmployers.slice(0, 3).map((e) => e.name).join(', ') || 'plusieurs employeurs cantonaux'}. La demande correspond à la structure économique du canton : santé publique (EOC, cliniques privées), distribution organisée (Migros, Coop, Denner), industrie (Lonza, AMAG, Mikron) et services (assurance, banque, ingénierie) forment l'essentiel des recrutements. Les frontaliers italiens avec permis G peuvent postuler directement : la grande majorité des employeurs tessinois acceptent les candidatures transfrontalières, à condition que les exigences linguistiques et techniques de l'annonce soient remplies.`,
    paragraph2: (label) =>
      `Le salaire médian affiché est calculé sur les champs baseSalary.minValue / baseSalary.maxValue des annonces ${label} qui déclarent une fourchette au format schema.org MonetaryAmount. Les annonces sans salaire explicite ne sont pas comptées. La tendance sur 12 semaines mesure les nouvelles offres par semaine pour le secteur, à partir de l'historique agrégé de jobs-stats-history.json ; quand la série est courte ou plate, la fenêtre historique ne couvre pas encore assez de semaines pour montrer une dynamique significative. Nous recommandons de consulter la page plusieurs fois par semaine : les offres tessinoises se ferment rapidement, et les employeurs à forte rotation — hôpitaux, maisons de retraite, retail — ouvrent et ferment des positions chaque jour.`,
    statActiveJobs: 'Offres actives',
    statMedianSalary: 'Salaire médian',
    statWeeklyDelta: 'Delta hebdomadaire',
    statMonthlyDelta: 'Delta mensuel',
    statEditorialFallback: 'historique en construction',
    topEmployersHeading: 'Employeurs les plus actifs',
    trendHeading: 'Tendance nouvelles offres — 12 dernières semaines',
    trendEmpty:
      "L'historique sur 12 semaines pour ce secteur est encore en construction : le graphique se remplira au fil des snapshots.",
    sectorHubCta: (label) => `Voir toutes les offres ${label} au Tessin`,
    sectorHubLink: (sectorSlug, _locale) => `/fr/trouver-emploi-tessin/${sectorSlug}/`,
    snapshotRootCta: 'Rapport marché du travail Tessin',
    methodologyHeading: 'Méthodologie',
    methodologyBody: (label) =>
      `Les comptages pour ${label} proviennent d'un appariement insensible à la casse sur le titre, la description, la catégorie, l'entreprise et les tags des offres actives. Les nouvelles offres hebdomadaires dans la tendance viennent de jobs-stats-history.json : on filtre les titleStats qui correspondent au motif mot-clé du secteur. Les offres expirées (expired=true) et celles en attente de retraduction (needsRetranslation=true) sont exclues. Les données sont rafraîchies plusieurs fois par jour par plus de 80 crawlers dédiés aux principaux employeurs tessinois, aux bulletins cantonaux et aux agrégateurs publics.`,
    breadcrumbHome: 'Accueil',
    breadcrumbSectorHub: 'Secteurs',
    freshnessLabel: (isoDate) => `Mis à jour le ${isoDate}`,
    faqTitle: 'Questions fréquentes',
    faq: (label, stats) => [
      {
        q: `Combien d'offres pour ${label} au Tessin ?`,
        a:
          stats.activeJobs > 0
            ? `Il y a actuellement ${stats.activeJobs} offres actives pour ${label} au Tessin, mises à jour plusieurs fois par jour.`
            : `La liste est mise à jour plusieurs fois par jour. Revenez bientôt pour de nouvelles offres ${label} au Tessin.`,
      },
      {
        q: 'Puis-je postuler comme frontalier ?',
        a: `Oui. La plupart des employeurs tessinois acceptent les candidatures de frontaliers italiens avec un permis G. Chaque annonce renvoie à la candidature officielle de l'employeur.`,
      },
      {
        q: 'Comment est calculé le salaire médian ?',
        a: `Le salaire médian est la médiane des valeurs baseSalary.minValue / baseSalary.maxValue des annonces ${label} qui déclarent une fourchette. Les annonces sans salaire explicite ne sont pas comptées.`,
      },
    ],
  },
};

interface SectorPageInputs {
  locale: JobMarketSnapshotLocale;
  sector: JobMarketSectorKey;
  sectorLabel: string;
  canonicalPath: string;
  alternates: Record<JobMarketSnapshotLocale, string>;
  todayIso: string;
  stats: SectorStats;
  distDir?: string;
  knownSlugs?: ReadonlySet<string>;
  /** Repository root — enables `public/images/brands/*.png` lookup for company logos. */
  rootDir?: string;
}

function formatSectorDelta(
  value: number | null,
  fallbackCopy: string,
): string {
  if (value === null) return fallbackCopy;
  const sign = value > 0 ? '+' : '';
  return `${sign}${value}`;
}

function alternatesForSector(
  sector: JobMarketSectorKey,
): Record<JobMarketSnapshotLocale, string> {
  const out: Record<JobMarketSnapshotLocale, string> = { it: '', en: '', de: '', fr: '' };
  for (const loc of JOB_MARKET_SNAPSHOT_LOCALES) out[loc] = buildSectorSnapshotPath(loc, sector);
  return out;
}

/**
 * Per-sector frontalier-context section — boosts text/HTML on the 25
 * sector-snapshot pages (gymnastics, edilizia, infermieri, etc.) which
 * had heavy stat tiles + trend chart but thin prose. Two locale-aware
 * paragraphs covering: applicability of the sector to cross-border
 * workers (permit + commute), and salary/CCL benchmarks for that sector.
 */
function renderSectorFrontalierContext(args: {
  locale: JobMarketSnapshotLocale;
  sectorLabel: string;
  activeJobs: number;
  medianSalary: number | null;
}): string {
  const { locale, sectorLabel, activeJobs, medianSalary } = args;
  const medianTxt = medianSalary !== null
    ? `${medianSalary.toLocaleString('en-US').replace(/,/g, "'")} CHF`
    : null;
  const copy = {
    it: {
      h: `${sectorLabel} per frontalieri: come orientarsi tra le ${activeJobs} offerte`,
      p1: `Il settore ${sectorLabel} in Ticino è una delle aree storiche di assunzione di lavoratori frontalieri italiani: la prossimità con la Lombardia, le competenze tecniche trasferibili e la maggiore disponibilità di posti rispetto al mercato italiano locale rendono il Ticino un'opzione concreta per chi cerca un primo ingaggio o un salto di carriera. Per candidarsi alle ${activeJobs} posizioni aperte del settore serve il Permesso G, residenza in un comune italiano entro 20 km dal confine (Lombardia o Piemonte) e rientro al domicilio almeno una volta a settimana. Il datore richiede il permesso all'Ufficio della migrazione cantonale dopo la firma del contratto: la prima emissione richiede 2-6 settimane, poi viene rinnovato annualmente.`,
      p2: `Il riferimento retributivo nel ${sectorLabel}${medianTxt ? ` è una mediana di ${medianTxt} lordi annui` : ''}, ma la dispersione dipende molto dal CCL applicato (CCL ramo, contratto aziendale, CCNL nazionale per multinazionali) e dalle certificazioni richieste. Confronta sempre il lordo svizzero con il netto italiano equivalente: a parità di mansione il netto in Ticino resta superiore del 25-45 % grazie alla pressione fiscale e contributiva ridotta, ma l'effetto del cambio CHF/EUR può variare il netto in euro fino al 12 % a parità di lordo. Per un calcolo preciso usa il <a href="${BASE_URL}/calcola-stipendio/">simulatore stipendio</a> con il tuo CCL e la tua composizione familiare. Considera anche i costi del pendolarismo (carburante, usura veicolo, tempo perso ai valichi) prima di confrontare un'offerta del ${sectorLabel} con un'alternativa italiana.`,
    },
    en: {
      h: `${sectorLabel} for cross-border workers: navigating the ${activeJobs} active openings`,
      p1: `The ${sectorLabel} sector in Ticino is one of the historic hiring areas for Italian cross-border workers: the proximity to Lombardy, transferable technical skills, and a larger pool of openings than the local Italian market make Ticino a concrete option for first hires or career jumps. Applying to the ${activeJobs} active sector openings requires a G Permit, residence in an Italian municipality within the 20 km border zone (Lombardy or Piedmont) and returning home at least once a week. The employer files for the permit at the cantonal migration office after the contract is signed: first issuance takes 2-6 weeks and is renewed yearly.`,
      p2: `Compensation in ${sectorLabel}${medianTxt ? ` clusters around a ${medianTxt} gross annual median` : ''}, but the spread depends heavily on the applicable collective agreement (sector CCL, company contract, multinational national CCNL) and required certifications. Always compare the Swiss gross with the Italian net equivalent: for the same job, Ticino net is typically 25-45 % higher due to lower fiscal and social burden, but CHF/EUR moves can change EUR net by up to 12 % at the same Swiss gross. For a precise figure use the <a href="${BASE_URL}/en/calculate-salary/">salary simulator</a> with your contract band and household composition. Also factor commute costs (fuel, vehicle wear, time at the border) before comparing a ${sectorLabel} offer with an Italian alternative.`,
    },
    de: {
      h: `${sectorLabel} für Grenzgänger: Orientierung bei ${activeJobs} offenen Stellen`,
      p1: `Der Sektor ${sectorLabel} im Tessin ist einer der historischen Anstellungsbereiche für italienische Grenzgänger: die Nähe zur Lombardei, übertragbare technische Kompetenzen und ein grösseres Angebot als auf dem lokalen italienischen Markt machen das Tessin zu einer konkreten Option für die erste Anstellung oder einen Karrieresprung. Eine Bewerbung auf die ${activeJobs} aktiven Stellen des Sektors setzt eine G-Bewilligung voraus, Wohnsitz in einer italienischen Gemeinde innerhalb der 20-km-Grenzzone (Lombardei oder Piemont) und Rückkehr nach Hause mindestens einmal pro Woche. Der Arbeitgeber beantragt die Bewilligung beim kantonalen Migrationsamt nach Vertragsunterzeichnung: die erste Ausstellung dauert 2-6 Wochen, anschliessend erfolgt die jährliche Verlängerung.`,
      p2: `Die Lohnreferenz im Sektor ${sectorLabel}${medianTxt ? ` liegt bei einem Medianbruttojahreslohn von ${medianTxt}` : ''}, aber die Bandbreite hängt stark vom anwendbaren GAV (Branchen-GAV, Firmenvertrag, multinationaler nationaler GAV) und den geforderten Zertifizierungen ab. Vergleichen Sie immer das Schweizer Brutto mit dem italienischen Netto-Äquivalent: für dieselbe Stelle ist das Tessiner Netto typischerweise 25-45 % höher dank tieferer Steuer- und Soziallast, aber Bewegungen des CHF/EUR-Kurses können den Nettobetrag in EUR um bis zu 12 % ändern. Für eine präzise Berechnung verwenden Sie den <a href="${BASE_URL}/de/gehalt-berechnen/">Lohnsimulator</a> mit Ihrer Vertragsstufe und Ihrer Haushaltszusammensetzung. Berücksichtigen Sie auch die Pendelkosten (Treibstoff, Fahrzeugverschleiss, Wartezeit an der Grenze), bevor Sie ein ${sectorLabel}-Angebot mit einer italienischen Alternative vergleichen.`,
    },
    fr: {
      h: `${sectorLabel} pour frontaliers : s'orienter parmi les ${activeJobs} offres actives`,
      p1: `Le secteur ${sectorLabel} au Tessin est l'un des bassins historiques d'embauche des frontaliers italiens : la proximité avec la Lombardie, des compétences techniques transférables et un volume d'offres supérieur au marché italien local font du Tessin une option concrète pour une première embauche ou un saut de carrière. Pour postuler aux ${activeJobs} postes actifs du secteur, il faut un permis G, une résidence dans une commune italienne située dans la zone frontalière des 20 km (Lombardie ou Piémont) et un retour au domicile au moins une fois par semaine. L'employeur demande le permis à l'office cantonal des migrations après la signature du contrat : la première délivrance prend 2 à 6 semaines, puis le permis est renouvelé chaque année.`,
      p2: `La référence salariale dans le ${sectorLabel}${medianTxt ? ` se situe autour d'une médiane de ${medianTxt} brut annuel` : ''}, mais la dispersion dépend fortement de la convention collective applicable (CCL de branche, contrat d'entreprise, CCNL national pour les multinationales) et des certifications exigées. Comparez toujours le brut suisse avec le net italien équivalent : pour le même poste, le net tessinois est généralement 25-45 % supérieur grâce à une charge fiscale et sociale plus faible, mais les mouvements du taux CHF/EUR peuvent modifier le net en EUR jusqu'à 12 % à brut suisse égal. Pour un calcul précis, utilisez le <a href="${BASE_URL}/fr/calculer-salaire/">simulateur de salaire</a> avec votre échelon contractuel et votre composition familiale. Tenez aussi compte des coûts du trajet (carburant, usure du véhicule, temps perdu à la frontière) avant de comparer une offre ${sectorLabel} avec une alternative italienne.`,
    },
  };
  const c = copy[locale] || copy.it;
  return `<section style="margin:24px 0 0" aria-labelledby="sectorFrontalierContext">
    <h2 id="sectorFrontalierContext" style="${H2_STYLE};margin-bottom:10px">${esc(c.h)}</h2>
    <p style="margin:0 0 14px;color:var(--color-body);line-height:1.7;max-width:860px">${c.p1}</p>
    <p style="margin:0;color:var(--color-body);line-height:1.7;max-width:860px">${c.p2}</p>
  </section>`;
}

function renderSectorPage(inp: SectorPageInputs): string {
  const { locale, sector, sectorLabel, canonicalPath, alternates, todayIso, stats, distDir, knownSlugs, rootDir } = inp;
  const copy = SECTOR_COPY[locale];
  const canonicalUrl = `${BASE_URL}${canonicalPath}`;
  const h1 = copy.h1(sectorLabel);
  // Phase 3A — keyword-first compact title (≤60 char), drop the "salaries,
  // employers, trends" fragment that pushed it past 90 chars in some locales.
  const titleBase =
    locale === 'it' ? `Mercato lavoro ${sectorLabel} Ticino`
    : locale === 'en' ? `${sectorLabel} job market in Ticino`
    : locale === 'de' ? `Arbeitsmarkt ${sectorLabel} Tessin`
    : `Marché travail ${sectorLabel} Tessin`;
  const title = clampSiteSuffix(titleBase, 'Frontaliere Ticino');
  const metaDesc = copy.metaDesc(sectorLabel, stats.activeJobs);

  const statTiles = `<section style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;margin:0 0 22px" aria-label="${esc(copy.kicker)}">
    ${renderStatTile(copy.statActiveJobs, String(stats.activeJobs), 'primary')}
    ${stats.medianSalary !== null ? renderStatTile(copy.statMedianSalary, `${stats.medianSalary.toLocaleString('en-US').replace(/,/g, '\u202f')} CHF`, 'neutral') : ''}
    ${renderStatTile(copy.statWeeklyDelta, formatSectorDelta(stats.weeklyDelta, copy.statEditorialFallback), 'success')}
    ${renderStatTile(copy.statMonthlyDelta, formatSectorDelta(stats.monthlyDelta, copy.statEditorialFallback), 'warning')}
  </section>`;

  const topEmployersList = renderTopList(
    copy.topEmployersHeading,
    stats.topEmployers.map((e) => ({
      name: e.name,
      added: e.count,
      url: knownSlugs ? (employerCanonicalHref(e.name, knownSlugs) ?? undefined) : undefined,
    })),
    locale === 'it'
      ? 'offerte attive'
      : locale === 'de'
      ? 'aktive Stellen'
      : locale === 'fr'
      ? 'offres actives'
      : 'active openings',
    'top-employers',
    rootDir,
  );

  const trendSection = `<section style="margin:24px 0 0" aria-labelledby="sectorTrend">
    <h2 id="sectorTrend" style="${H2_STYLE};margin-bottom:12px">${esc(copy.trendHeading)}</h2>
    ${renderSvgTrendChart(
      stats.trendSeries,
      copy.trendEmpty,
      buildTrendChartAriaLabel(locale, copy.trendHeading, stats.trendSeries),
    )}
  </section>`;

  const sectorHasHub = (SECTOR_HUB_KEYS as readonly string[]).includes(sector);
  const sectorHubHref = sectorHasHub
    ? `${CITY_SECTOR_HUB_PREFIX[locale]}/${JOB_MARKET_SECTOR_SLUG[sector]}/`
    : `${CITY_SECTOR_HUB_PREFIX[locale]}/`;
  const snapshotHubHref = buildHubPath(locale);

  const ctaHtml = `<p style="margin:0 0 20px;display:flex;gap:12px;flex-wrap:wrap">
    <a href="${esc(sectorHubHref)}" style="display:inline-flex;align-items:center;gap:6px;padding:12px 22px;border-radius:12px;background:var(--color-accent);color:var(--color-on-accent);text-decoration:none;font-weight:700">${esc(copy.sectorHubCta(sectorLabel))} →</a>
    <a href="${esc(snapshotHubHref)}" style="display:inline-flex;align-items:center;gap:6px;padding:12px 22px;border-radius:12px;background:var(--color-surface);border:1px solid var(--color-accent-border);color:var(--color-accent);text-decoration:none;font-weight:700">${esc(copy.snapshotRootCta)} →</a>
  </p>`;

  const methodology = `<section style="margin:26px 0 0" aria-labelledby="sectorMethodology">
    <h2 id="sectorMethodology" style="${H2_STYLE};margin-bottom:10px">${esc(copy.methodologyHeading)}</h2>
    <p style="margin:0;color:var(--color-body);line-height:1.65">${esc(copy.methodologyBody(sectorLabel))}</p>
  </section>`;

  const faqEntries = copy.faq(sectorLabel, stats);
  const faqHtml = faqEntries.length > 0
    ? `<section style="margin:32px 0 0" aria-labelledby="sectorFaq">
        <h2 id="sectorFaq" style="${H2_STYLE}">${esc(copy.faqTitle)}</h2>
        ${faqEntries
          .map(
            (f) => `<details style="${CARD_STYLE};margin-bottom:8px">
              <summary style="font-weight:700;cursor:pointer;color:var(--color-heading)">${esc(f.q)}</summary>
              <p style="margin:10px 0 0;color:var(--color-body);line-height:1.6">${esc(f.a)}</p>
            </details>`,
          )
          .join('')}
      </section>`
    : '';

  const alternatesHtml = renderHreflangAlternates(alternates);

  const breadcrumbLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: copy.breadcrumbHome, item: `${BASE_URL}/` },
      {
        '@type': 'ListItem',
        position: 2,
        name: JOB_MARKET_HUB_NAME[locale],
        item: `${BASE_URL}${buildHubPath(locale)}`,
      },
      { '@type': 'ListItem', position: 3, name: h1, item: canonicalUrl },
    ],
  });

  const webPageLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: h1,
    description: metaDesc,
    url: canonicalUrl,
    inLanguage: locale,
    dateModified: `${todayIso}T00:00:00.000Z`,
    isPartOf: {
      '@type': 'WebSite',
      name: 'Frontaliere Ticino',
      url: BASE_URL,
    },
  });

  const datasetLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Dataset',
    inLanguage: locale,
    name: h1,
    description: metaDesc,
    url: canonicalUrl,
    isAccessibleForFree: true,
    license: 'https://creativecommons.org/licenses/by/4.0/',
    creator: {
      '@type': 'Organization',
      name: 'Frontaliere Ticino',
      url: BASE_URL,
    },
    publisher: {
      '@type': 'Organization',
      name: 'Frontaliere Ticino',
      url: BASE_URL,
    },
    dateModified: `${todayIso}T00:00:00.000Z`,
    spatialCoverage: {
      '@type': 'Place',
      name: 'Canton Ticino',
      address: {
        '@type': 'PostalAddress',
        addressCountry: 'CH',
        addressRegion: 'TI',
      },
    },
    keywords: [
      'Canton Ticino',
      'frontalieri',
      'lavoro Ticino',
      sectorLabel,
      'mercato del lavoro',
    ],
    distribution: [
      {
        '@type': 'DataDownload',
        encodingFormat: 'application/json',
        contentUrl: `${BASE_URL}/data/jobs-stats.json`,
        name: 'Ticino jobs statistics (weekly snapshot)',
      },
      {
        '@type': 'DataDownload',
        encodingFormat: 'text/html',
        contentUrl: canonicalUrl,
        name: 'HTML report',
      },
    ],
    variableMeasured: [
      copy.statActiveJobs,
      copy.statMedianSalary,
      copy.statWeeklyDelta,
      copy.statMonthlyDelta,
      copy.topEmployersHeading,
      copy.trendHeading,
    ],
  });

  const faqLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    inLanguage: locale,
    mainEntity: faqEntries.map((f) => ({
      '@type': 'Question',
      name: f.q,
      acceptedAnswer: { '@type': 'Answer', text: f.a },
    })),
  });

  const frontalierContextHtml = renderSectorFrontalierContext({
    locale,
    sectorLabel,
    activeJobs: stats.activeJobs,
    medianSalary: stats.medianSalary,
  });

  const bodyHtml = `<article style="max-width:1100px;margin:0 auto;padding:32px 20px 56px">
    <nav style="${BREADCRUMB_STYLE}">
      <a href="${BASE_URL}/" style="${BREADCRUMB_LINK_STYLE}">${esc(copy.breadcrumbHome)}</a>
      <span> / </span>
      <a href="${BASE_URL}${buildHubPath(locale)}" style="${BREADCRUMB_LINK_STYLE}">${esc(JOB_MARKET_HUB_NAME[locale])}</a>
      <span> / </span>
      <span>${esc(sectorLabel)}</span>
    </nav>
    <header style="margin-bottom:22px">
      <p style="${HERO_EYEBROW_STYLE}">${esc(copy.kicker)} · ${esc(sectorLabel)}</p>
      <h1 style="${H1_STYLE}">${esc(h1)}</h1>
      <p style="margin:0 0 10px;color:var(--color-subtle);font-size:13px">${esc(copy.freshnessLabel(todayIso))}</p>
      <p style="${LEDE_STYLE}">${esc(copy.intro(sectorLabel, stats.activeJobs))}</p>
    </header>
    ${ctaHtml}
    ${statTiles}
    <section style="margin:0 0 22px">
      <p style="margin:0 0 14px;color:var(--color-body);line-height:1.7;max-width:860px">${esc(copy.paragraph1(sectorLabel, stats))}</p>
      <p style="margin:0;color:var(--color-body);line-height:1.7;max-width:860px">${esc(copy.paragraph2(sectorLabel))}</p>
    </section>
    ${topEmployersList}
    ${trendSection}
    ${frontalierContextHtml}
    ${methodology}
    ${faqHtml}
    ${renderDiscoverMore(locale, JOB_MARKET_DISCOVER_MORE_CTAS[locale])}
    ${generateRelatedLinksBlock(locale, 'job_market_snapshot')}
  </article>`;

  const extraHead = `    <meta property="og:image" content="${BASE_URL}/og-image.png">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${esc(title)}">
    <meta name="twitter:description" content="${esc(metaDesc)}">
    <meta name="twitter:site" content="@frontaliereticino">`;

  return buildSeoPageHtml({
    locale,
    title,
    description: metaDesc,
    canonicalUrl,
    robots: 'index,follow',
    ogType: 'website',
    ogLocale: JOB_MARKET_OG_LOCALE[locale],
    hreflangHtml: alternatesHtml,
    extraHeadHtml: extraHead,
    jsonLdScripts: [breadcrumbLd, webPageLd, datasetLd, faqLd],
    bodyHtml,
    distDir,
    hubChrome: { hubKey: 'stats', activeSubTab: 'jobs-observatory' },
  });
}

export interface SectorGeneratorInputs {
  history: StatsHistoryDataset | null;
  jobs: ReadonlyArray<JobRecord>;
  today?: Date;
  distDir?: string;
  knownSlugs?: ReadonlySet<string>;
  /** Repository root — enables `public/images/brands/*.png` lookup for company logos. */
  rootDir?: string;
}

export interface SectorGeneratorOutput {
  pages: Record<string, string>;
  sectorStats: Record<JobMarketSectorKey, SectorStats>;
}

export function generateSectorSnapshotPages(
  opts: SectorGeneratorInputs,
): SectorGeneratorOutput {
  const today = opts.today ?? new Date();
  const todayIso = today.toISOString().slice(0, 10);
  const entries = opts.history?.entries ?? [];
  const completedWeeks = bucketHistoryByWeek(entries, { requireComplete: true });
  const completedMonths = bucketHistoryByMonth(entries).filter((m) => {
    const currentMonthKey = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, '0')}`;
    const bucketKey = `${m.year}-${String(m.month).padStart(2, '0')}`;
    return bucketKey < currentMonthKey;
  });

  const pages: Record<string, string> = {};
  const sectorStats = {} as Record<JobMarketSectorKey, SectorStats>;

  for (const sector of JOB_MARKET_SECTOR_KEYS) {
    const stats = aggregateSectorStats(sector, opts.jobs, entries, completedWeeks, completedMonths);
    sectorStats[sector] = stats;
    for (const locale of JOB_MARKET_SNAPSHOT_LOCALES) {
      const canonicalPath = buildSectorSnapshotPath(locale, sector);
      const sectorLabel = JOB_MARKET_SECTOR_DISPLAY[locale][sector];
      pages[canonicalPath] = renderSectorPage({
        locale,
        sector,
        sectorLabel,
        canonicalPath,
        alternates: alternatesForSector(sector),
        todayIso,
        stats,
        distDir: opts.distDir,
        knownSlugs: opts.knownSlugs,
        rootDir: opts.rootDir,
      });
    }
  }

  return { pages, sectorStats };
}

// ── Sitemap writer ─────────────────────────────────────────────

function patchSitemapIndex(distDir: string, dateStamp: string): void {
  const indexPath = np.join(distDir, 'sitemap.xml');
  if (!fs.existsSync(indexPath)) return;
  try {
    let idx = fs.readFileSync(indexPath, 'utf-8');
    if (!idx.includes('sitemap-job-market.xml')) {
      idx = idx.replace(
        '</sitemapindex>',
        `  <sitemap>\n    <loc>${BASE_URL}/sitemap-job-market.xml</loc>\n    <lastmod>${dateStamp}</lastmod>\n  </sitemap>\n</sitemapindex>`,
      );
    } else {
      idx = idx.replace(
        /(<loc>https:\/\/frontaliereticino\.ch\/sitemap-job-market\.xml<\/loc>\s*<lastmod>)\d{4}-\d{2}-\d{2}(<\/lastmod>)/,
        `$1${dateStamp}$2`,
      );
    }
    fs.writeFileSync(indexPath, idx, 'utf-8');
  } catch (err) {
    console.warn('[job-market-snapshot] failed to patch sitemap index', err);
  }
}

// ── Plugin entry ──────────────────────────────────────────────

export function jobMarketSnapshotPlugin(rootDir: string): Plugin {
  return {
    name: 'job-market-snapshot',
    apply: 'build',
    async closeBundle() {
      if (process.env.SKIP_JOB_MARKET_SNAPSHOT === '1') {
        console.log('\x1b[33m[job-market-snapshot]\x1b[0m Skipped (SKIP_JOB_MARKET_SNAPSHOT=1)');
        return;
      }
      const distDir = np.resolve(rootDir, 'dist');
      if (!fs.existsSync(distDir)) {
        // nothing to do — happens when another plugin hasn't created the dist yet
        return;
      }

      // Ext3 task 3 — wipe owned namespaces before regen so per-sector /
      // per-archive pages that drop out don't linger as stale files.
      cleanNamespaces(distDir, [
        'mercato-lavoro-ticino',
        'en/ticino-job-market',
        'de/tessiner-arbeitsmarkt',
        'fr/marche-travail-tessin',
      ]);
      cleanSitemapFiles(distDir, ['sitemap-job-market.xml']);

      const historyPath = np.resolve(rootDir, 'data', 'jobs-stats-history.json');
      const jobsPath = np.resolve(rootDir, 'data', 'jobs.json');

      let history: StatsHistoryDataset | null = null;
      try {
        if (fs.existsSync(historyPath)) {
          const raw = fs.readFileSync(historyPath, 'utf-8');
          const parsed = JSON.parse(raw) as StatsHistoryDataset;
          if (parsed && Array.isArray(parsed.entries)) history = parsed;
        }
      } catch (err) {
        console.warn('[job-market-snapshot] failed to read data/jobs-stats-history.json', err);
      }

      let jobs: JobRecord[] = [];
      try {
        if (fs.existsSync(jobsPath)) {
          const raw = fs.readFileSync(jobsPath, 'utf-8');
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) jobs = parsed as JobRecord[];
        }
      } catch (err) {
        console.warn('[job-market-snapshot] failed to read data/jobs.json', err);
      }

      const today = new Date();
      const knownSlugs = loadKnownCompanySlugs(rootDir);
      const { pages, degraded } = generateJobMarketSnapshotPages({ history, jobs, today, distDir, knownSlugs, rootDir });

      // D-3A: per-sector snapshot pages (~14 sectors × 4 locali = ~56 pages)
      const sectorOutput = generateSectorSnapshotPages({ history, jobs, today, distDir, knownSlugs, rootDir });
      for (const [path, html] of Object.entries(sectorOutput.pages)) {
        pages[path] = html;
      }

      const collector = new WriteCollector({ distDir });
      const sitemapEntries: string[] = [];
      let pagesWritten = 0;
      let skippedForWordCount = 0;

      for (const [path, html] of Object.entries(pages)) {
        const isHub = JOB_MARKET_SNAPSHOT_LOCALES.some((loc) => buildHubPath(loc) === path);
        const minWords = isHub ? MIN_HUB_WORDS : MIN_SNAPSHOT_WORDS;
        const words = countHtmlBodyWords(html);
        if (words < Math.max(MIN_INDEXABLE_WORDS, minWords)) {
          skippedForWordCount++;
          console.warn(`[job-market-snapshot] thin content (${words} words) for ${path} — skipping`);
          continue;
        }
        const outDir = np.join(distDir, path.replace(/^\/+/, ''));
        collector.add(np.join(outDir, 'index.html'), html);
        pagesWritten++;

        // Sitemap: only emit IT canonical for each page (hub/weekly/monthly), with hreflang alternates
        const isItalian = !path.startsWith('/en/') && !path.startsWith('/de/') && !path.startsWith('/fr/');
        if (isItalian && !html.includes('name="robots" content="noindex')) {
          // Extract the IT sub-slug after the section, then re-localise it
          // per alternate so the alternate link lands on the correct
          // locale-specific URL (woche-16-2026, week-16-2026, etc.).
          const stripped = path.replace(/^\/mercato-lavoro-ticino\/?/, '');
          const subSlug = stripped.replace(/\/+$/, '');
          const localisedSubSlug = (alt: JobMarketSnapshotLocale): string => {
            if (!subSlug) return '';
            // Weekly slug form: settimana-NN-YYYY
            const weekMatch = /^settimana-(\d{1,2})-(\d{4})$/.exec(subSlug);
            if (weekMatch) {
              const week = weekMatch[1];
              const year = weekMatch[2];
              const prefix = alt === 'it' ? 'settimana' : alt === 'en' ? 'week' : alt === 'de' ? 'woche' : 'semaine';
              return `${prefix}-${week}-${year}`;
            }
            // Monthly slug form: <monthName>-YYYY (IT)
            const monthMatch = /^([a-z]+)-(\d{4})$/.exec(subSlug);
            if (monthMatch) {
              const itMonthName = monthMatch[1];
              const year = Number(monthMatch[2]);
              const itIdx = JOB_MARKET_MONTH_NAMES.it.indexOf(itMonthName);
              if (itIdx >= 1) {
                const altName = JOB_MARKET_MONTH_NAMES[alt][itIdx];
                return `${altName}-${year}`;
              }
            }
            // Sector slug form: settore/<sectorSlug> (IT) → branche/<slug> (DE) etc.
            const sectorMatch = /^settore\/([a-z0-9-]+)$/.exec(subSlug);
            if (sectorMatch) {
              const leaf = sectorMatch[1];
              return `${JOB_MARKET_SECTOR_SEGMENT[alt]}/${leaf}`;
            }
            return subSlug;
          };
          const alternates = JOB_MARKET_SNAPSHOT_LOCALES.map((alt) => {
            const altSub = localisedSubSlug(alt);
            const basePath = `${JOB_MARKET_LOCALE_PREFIX[alt]}/${JOB_MARKET_SECTION_SLUG[alt]}/`;
            const altPath = (altSub ? `${basePath}${altSub}/` : basePath).replace(/\/+/g, '/');
            return `    <xhtml:link rel="alternate" hreflang="${alt}" href="${BASE_URL}${altPath}" />`;
          }).join('\n');
          sitemapEntries.push(
            `  <url>\n    <loc>${BASE_URL}${path}</loc>\n${alternates}\n    <xhtml:link rel="alternate" hreflang="x-default" href="${BASE_URL}${path}" />\n    <lastmod>${today.toISOString().slice(0, 10)}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>0.7</priority>\n  </url>`,
          );
        }
      }

      await collector.flush();

      if (sitemapEntries.length > 0) {
        const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${sitemapEntries.join('\n')}
</urlset>
`;
        try {
          fs.writeFileSync(np.join(distDir, 'sitemap-job-market.xml'), sitemapXml, 'utf-8');
          patchSitemapIndex(distDir, today.toISOString().slice(0, 10));
        } catch (err) {
          console.warn('[job-market-snapshot] failed to write sitemap-job-market.xml', err);
        }
      }

      const sectorPagesCount = Object.keys(sectorOutput.pages).length;
      console.log(
        `\x1b[36m[job-market-snapshot]\x1b[0m Generated ${pagesWritten} pages (skipped ${skippedForWordCount}, degraded=${degraded}, sector=${sectorPagesCount})`,
      );
    },
  };
}
