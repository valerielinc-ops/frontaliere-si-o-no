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
import { WriteCollector } from './batchWrite';
import {
  JOB_MARKET_HUB_NAME,
  JOB_MARKET_LOCALE_PREFIX,
  JOB_MARKET_MONTH_NAMES,
  JOB_MARKET_OG_LOCALE,
  JOB_MARKET_SECTION_SLUG,
  JOB_MARKET_SNAPSHOT_LOCALES,
  buildHubPath,
  buildMonthlyPath,
  buildWeeklyPath,
  getIsoWeek,
  mondayOfIsoWeek,
  sundayOfIsoWeek,
  type JobMarketSnapshotLocale,
} from './jobMarketSnapshotData';
import { generateRelatedLinksBlock } from './shared/relatedLinks';

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
  datePosted?: string;
  firstSeenAt?: string;
  crawledAt?: string;
  postedDate?: string;
  needsRetranslation?: boolean;
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
}

function renderHreflangAlternates(alternates: Record<JobMarketSnapshotLocale, string>): string {
  const lines = JOB_MARKET_SNAPSHOT_LOCALES.map(
    (alt) => `    <link rel="alternate" hreflang="${alt}" href="${BASE_URL}${alternates[alt]}">`,
  );
  lines.push(`    <link rel="alternate" hreflang="x-default" href="${BASE_URL}${alternates.it}">`);
  return lines.join('\n');
}

function renderSvgTrendChart(
  series: ReadonlyArray<{ periodLabel: string; value: number }>,
  trendEmptyCopy: string,
): string {
  if (series.length < 2) {
    return `<p style="padding:14px 16px;border-radius:12px;background:#fef3c7;color:#78350f;margin:0">${esc(trendEmptyCopy)}</p>`;
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
      return `<text x="${x.toFixed(2)}" y="${height - 8}" text-anchor="middle" font-size="11" fill="#475569">${esc(s.periodLabel)}</text>`;
    })
    .join('');
  return `<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Trend chart" style="width:100%;max-width:100%;height:auto;background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px">
    <polygon points="${areaPoints}" fill="#c7d2fe" fill-opacity="0.5" />
    <polyline points="${points}" fill="none" stroke="#4338ca" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />
    ${series.map((s, i) => {
      const x = padding + (series.length === 1 ? innerW / 2 : (i * innerW) / (series.length - 1));
      const y = padding + innerH - ((s.value - minValue) / range) * innerH;
      return `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="3.5" fill="#1e293b" />`;
    }).join('')}
    <text x="${padding}" y="${padding - 10}" font-size="11" fill="#475569">${esc(String(maxValue))}</text>
    <text x="${padding}" y="${padding + innerH + 0}" font-size="11" fill="#475569" dy="0">${esc(String(minValue))}</text>
    ${ticks}
  </svg>`;
}

function renderRelatedLinks(copy: LocalisedCopy): string {
  return `<aside style="margin:28px 0 0;padding:18px 20px;border-radius:18px;background:#f8fafc;border:1px solid #e2e8f0" aria-labelledby="relatedLinks">
    <h2 id="relatedLinks" style="margin:0 0 10px;font-size:18px;color:#0f172a">${esc(copy.relatedLinksHeading)}</h2>
    <ul style="margin:0;padding:0;list-style:none;display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px">
      ${copy.relatedLinks
        .map(
          (l) => `<li><a href="${esc(l.href)}" style="color:#1d4ed8;text-decoration:none;font-weight:600">${esc(l.label)} →</a></li>`,
        )
        .join('')}
    </ul>
  </aside>`;
}

function renderFaq(copy: LocalisedCopy): string {
  if (copy.faq.length === 0) return '';
  return `<section style="margin:32px 0 0" aria-labelledby="jobMarketFaq">
    <h2 id="jobMarketFaq" style="margin:0 0 14px;font-size:22px;color:#0f172a">${esc(copy.faqTitle)}</h2>
    ${copy.faq
      .map(
        (f) => `<details style="padding:12px 14px;border:1px solid #e2e8f0;border-radius:12px;margin-bottom:8px;background:#ffffff">
      <summary style="font-weight:700;cursor:pointer;color:#0f172a">${esc(f.q)}</summary>
      <p style="margin:10px 0 0;color:#334155;line-height:1.6">${esc(f.a)}</p>
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
  const palette =
    variant === 'success'
      ? { bg: '#ecfccb', border: '#bef264', text: '#365314' }
      : variant === 'warning'
      ? { bg: '#fef3c7', border: '#fde68a', text: '#78350f' }
      : variant === 'neutral'
      ? { bg: '#f1f5f9', border: '#cbd5e1', text: '#0f172a' }
      : { bg: '#eef2ff', border: '#c7d2fe', text: '#4338ca' };
  return `<div style="padding:18px;border-radius:18px;background:${palette.bg};border:1px solid ${palette.border}">
    <div style="font-size:12px;color:${palette.text};font-weight:700;text-transform:uppercase;letter-spacing:.04em">${esc(label)}</div>
    <div style="margin-top:8px;font-size:28px;font-weight:800;color:#1e293b">${esc(value)}</div>
  </div>`;
}

function renderTopList(
  heading: string,
  items: ReadonlyArray<{ name: string; added: number; url?: string }>,
  suffixLabel: string,
): string {
  if (items.length === 0) {
    return `<section style="margin:22px 0 0" aria-labelledby="${esc(heading)}">
      <h2 style="margin:0 0 10px;font-size:20px;color:#0f172a">${esc(heading)}</h2>
      <p style="margin:0;color:#475569">—</p>
    </section>`;
  }
  const rows = items
    .map((item, idx) => {
      const nameHtml = item.url
        ? `<a href="${esc(item.url)}" style="color:#0f172a;text-decoration:none;font-weight:700">${esc(item.name)}</a>`
        : `<span style="color:#0f172a;font-weight:700">${esc(item.name)}</span>`;
      return `<li style="padding:12px 16px;border:1px solid #e2e8f0;border-radius:12px;background:#ffffff;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;gap:12px">
      <span style="display:flex;align-items:center;gap:10px"><span style="background:#eef2ff;color:#4338ca;border-radius:999px;padding:2px 10px;font-weight:700;font-size:12px">#${idx + 1}</span>${nameHtml}</span>
      <span style="color:#1d4ed8;font-weight:700">${esc(String(item.added))} ${esc(suffixLabel)}</span>
    </li>`;
    })
    .join('');
  return `<section style="margin:22px 0 0" aria-labelledby="${esc(heading)}">
    <h2 style="margin:0 0 10px;font-size:20px;color:#0f172a">${esc(heading)}</h2>
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
  const rows = items
    .map(
      (c) => `<li style="padding:12px 16px;border:1px solid #e2e8f0;border-radius:12px;background:#ffffff;margin-bottom:8px">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:12px">
      <a href="${esc(cityLinkBase[locale])}/${esc(c.key)}/" style="color:#0f172a;text-decoration:none;font-weight:700">${esc(c.name)}</a>
      <span style="color:#475569;font-weight:600">${esc(String(c.added))} · ${esc(c.percentage.toFixed(1))}%</span>
    </div>
    <div style="margin-top:8px;background:#e2e8f0;border-radius:999px;height:6px;overflow:hidden">
      <div style="width:${esc(c.percentage.toFixed(1))}%;height:100%;background:#4f46e5"></div>
    </div>
  </li>`,
    )
    .join('');
  return `<section style="margin:22px 0 0" aria-labelledby="cityBreakdown">
    <h2 id="cityBreakdown" style="margin:0 0 10px;font-size:20px;color:#0f172a">${esc(heading)}</h2>
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
  const { locale, canonicalPath, alternates, todayIso, degraded, kind, stats, weekLabel, monthLabel, noindex, distDir } = inp;
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
    ? `<p style="margin:0 0 14px;padding:12px 16px;border-radius:12px;background:#fef3c7;color:#78350f;border:1px solid #fcd34d">${esc(copy.degradedNote)}</p>`
    : '';

  const statTiles = `<section style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;margin:0 0 22px" aria-label="${esc(copy.seriesKicker)}">
    ${renderStatTile(copy.statNewJobs, String(stats.newJobs), 'primary')}
    ${renderStatTile(copy.statClosedJobs, String(stats.closedJobs), 'warning')}
    ${renderStatTile(copy.statActiveEmployers, String(stats.activeEmployers), 'success')}
    ${stats.medianSalary !== null ? renderStatTile(copy.statMedianSalary, `${stats.medianSalary.toLocaleString('en-US').replace(/,/g, '\u202f')} CHF`, 'neutral') : ''}
  </section>`;

  const topRolesList = renderTopList(
    copy.topRolesHeading,
    stats.topRoles.map((r) => ({ name: r.name, added: r.added })),
    locale === 'it' ? 'annunci' : locale === 'de' ? 'Anzeigen' : locale === 'fr' ? 'annonces' : 'postings',
  );

  const topEmployersList = renderTopList(
    copy.topEmployersHeading,
    stats.topEmployers.map((e) => ({ name: e.name, added: e.added, url: e.url })),
    locale === 'it' ? 'nuove offerte' : locale === 'de' ? 'neue Stellen' : locale === 'fr' ? 'nouvelles offres' : 'new openings',
  );

  const cityBreakdown = renderCityBreakdown(copy.cityBreakdownHeading, stats.cityBreakdown, locale);

  const trendSection = `<section style="margin:24px 0 0" aria-labelledby="trendChart">
    <h2 id="trendChart" style="margin:0 0 12px;font-size:20px;color:#0f172a">${esc(copy.trendHeading)}</h2>
    ${renderSvgTrendChart(stats.trendSeries, copy.trendEmpty)}
  </section>`;

  const methodology = `<section style="margin:26px 0 0" aria-labelledby="methodology">
    <h2 id="methodology" style="margin:0 0 10px;font-size:20px;color:#0f172a">${esc(copy.methodologyHeading)}</h2>
    <p style="margin:0;color:#334155;line-height:1.65">${esc(copy.methodologyBody)}</p>
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
    description: intro.slice(0, 220),
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
    temporalCoverage: `${stats.startDate.toISOString().slice(0, 10)}/${stats.endDate.toISOString().slice(0, 10)}`,
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
    mainEntity: copy.faq.map((f) => ({
      '@type': 'Question',
      name: f.q,
      acceptedAnswer: { '@type': 'Answer', text: f.a },
    })),
  });

  const title = `${h1} | Frontaliere Ticino`;
  const description = intro.length > 180 ? `${intro.slice(0, 177)}...` : intro;

  const robots = noindex ? 'noindex,follow' : 'index,follow';

  const bodyHtml = `<main style="max-width:1100px;margin:0 auto;padding:32px 20px 56px;color:#0f172a">
    <nav style="margin:0 0 14px;font-size:13px;color:#475569">
      <a href="${BASE_URL}/" style="color:#1d4ed8;text-decoration:none">${esc(copy.breadcrumbHome)}</a>
      <span> / </span>
      <a href="${BASE_URL}${buildHubPath(locale)}" style="color:#1d4ed8;text-decoration:none">${esc(JOB_MARKET_HUB_NAME[locale])}</a>
      <span> / </span>
      <span>${esc(periodRange)}</span>
    </nav>
    <header style="margin-bottom:22px">
      <p style="margin:0 0 6px;color:#4f46e5;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.04em">${esc(copy.seriesKicker)} · ${esc(periodRange)}</p>
      <h1 style="margin:0 0 14px;font-size:clamp(1.9rem,4.5vw,2.75rem);line-height:1.1">${esc(h1)}</h1>
      <p style="margin:0 0 10px;color:#475569;font-size:13px">${esc(copy.freshnessLabel(todayIso))}</p>
      <p style="margin:0 0 14px;font-size:18px;line-height:1.55;max-width:860px">${esc(intro)}</p>
    </header>
    ${degradedNote}
    ${statTiles}
    <section style="margin:0 0 22px">
      <p style="margin:0;color:#334155;line-height:1.7;max-width:860px">${esc(paragraph)}</p>
    </section>
    ${topRolesList}
    ${topEmployersList}
    ${cityBreakdown}
    ${trendSection}
    ${methodology}
    ${faqHtml}
    ${relatedHtml}
    ${generateRelatedLinksBlock(locale, 'job_market_snapshot')}
  </main>`;

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
    ? `<p style="margin:0 0 14px;padding:12px 16px;border-radius:12px;background:#fef3c7;color:#78350f;border:1px solid #fcd34d">${esc(copy.degradedNote)}</p>`
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
        <h2 id="latestWeeks" style="margin:0 0 12px;font-size:22px;color:#0f172a">${esc(copy.hubLatestLabel)}</h2>
        <ol style="margin:0;padding:0;list-style:none;display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px">
          ${latestWeeks
            .map(
              (w) => `<li style="padding:14px 16px;border:1px solid #e2e8f0;border-radius:14px;background:#ffffff">
                <a href="${esc(w.href)}" style="color:#0f172a;text-decoration:none;display:block">
                  <div style="font-weight:700;font-size:16px">${esc(copy.weeklyHeading(w.week, w.year))}</div>
                  <div style="margin-top:4px;color:#475569;font-size:13px">${esc(w.rangeLabel)}</div>
                  <div style="margin-top:10px;display:flex;gap:14px;font-size:14px;color:#334155">
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
        <h2 id="monthlyArchive" style="margin:0 0 10px;font-size:22px;color:#0f172a">${esc(copy.hubArchiveLabel)}</h2>
        <ul style="margin:0;padding:0;list-style:none;display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px">
          ${monthlyArchive
            .map(
              (m) => `<li><a href="${esc(m.href)}" style="color:#1d4ed8;text-decoration:none;font-weight:600">${esc(m.monthLabel)} →</a></li>`,
            )
            .join('')}
        </ul>
      </section>`
    : '';

  const ctaHtml = latestWeekHref
    ? `<p style="margin:0 0 20px"><a href="${esc(latestWeekHref)}" style="display:inline-block;padding:12px 22px;border-radius:12px;background:#4f46e5;color:#ffffff;text-decoration:none;font-weight:700">${esc(copy.hubSeeCurrentWeek)} →</a></p>`
    : '';

  const methodology = `<section style="margin:26px 0 0" aria-labelledby="methodology">
    <h2 id="methodology" style="margin:0 0 10px;font-size:20px;color:#0f172a">${esc(copy.methodologyHeading)}</h2>
    <p style="margin:0;color:#334155;line-height:1.65">${esc(copy.methodologyBody)}</p>
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

  const faqLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: copy.faq.map((f) => ({
      '@type': 'Question',
      name: f.q,
      acceptedAnswer: { '@type': 'Answer', text: f.a },
    })),
  });

  const title = `${h1} | Frontaliere Ticino`;
  const description = copy.hubIntro.length > 180 ? `${copy.hubIntro.slice(0, 177)}...` : copy.hubIntro;

  const bodyHtml = `<main style="max-width:1100px;margin:0 auto;padding:32px 20px 56px;color:#0f172a">
    <nav style="margin:0 0 14px;font-size:13px;color:#475569">
      <a href="${BASE_URL}/" style="color:#1d4ed8;text-decoration:none">${esc(copy.breadcrumbHome)}</a>
      <span> / </span>
      <span>${esc(JOB_MARKET_HUB_NAME[locale])}</span>
    </nav>
    <header style="margin-bottom:22px">
      <p style="margin:0 0 6px;color:#4f46e5;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.04em">${esc(copy.seriesKicker)}</p>
      <h1 style="margin:0 0 14px;font-size:clamp(2rem,4.5vw,3rem);line-height:1.1">${esc(h1)}</h1>
      <p style="margin:0 0 10px;color:#475569;font-size:13px">${esc(copy.freshnessLabel(todayIso))}</p>
      <p style="margin:0 0 14px;font-size:18px;line-height:1.55;max-width:860px">${esc(copy.hubIntro)}</p>
    </header>
    ${degradedNote}
    ${ctaHtml}
    ${heroStatsHtml}
    <section style="margin:0 0 22px">
      <p style="margin:0;color:#334155;line-height:1.7;max-width:860px">${esc(copy.hubParagraph)}</p>
    </section>
    ${latestWeeksHtml}
    ${archiveHtml}
    ${methodology}
    ${faqHtml}
    ${relatedHtml}
    ${generateRelatedLinksBlock(locale, 'job_market_snapshot')}
  </main>`;

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
    jsonLdScripts: [breadcrumbLd, collectionLd, faqLd],
    bodyHtml,
    distDir,
  });
}

// ── Page generator (pure) ─────────────────────────────────────

export interface GeneratorInputs {
  history: StatsHistoryDataset | null;
  jobs: ReadonlyArray<JobRecord>;
  today?: Date;
  /** dist directory for entry-asset resolution (omit in tests). */
  distDir?: string;
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
      });
    }
  }

  return { pages, degraded, completedWeeks, completedMonths };
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
      const { pages, degraded } = generateJobMarketSnapshotPages({ history, jobs, today, distDir });

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

      console.log(
        `\x1b[36m[job-market-snapshot]\x1b[0m Generated ${pagesWritten} pages (skipped ${skippedForWordCount}, degraded=${degraded})`,
      );
    },
  };
}
