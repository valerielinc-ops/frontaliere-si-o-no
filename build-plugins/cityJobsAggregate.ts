/**
 * Build-time aggregator for the cost-of-living city landings (AE-4 template B).
 *
 * Reads data/jobs.json once per build, derives per-city metrics that feed the
 * template B header (3 stat tiles + 3 featured jobs + employer grid) of the
 * cost-of-living landings. The cost-of-living FSO/ISTAT facts in
 * costOfLivingLandingsCopy.ts remain the editorial authority for rent and
 * basket numbers — this aggregator only provides the live job-market layer.
 *
 * Matching strategy
 * -----------------
 * jobs.json `addressLocality` is the primary signal (city/commune name). We
 * compare case-insensitively after Latin diacritics are stripped, and we
 * accept the "<city>-<suffix>" pattern (e.g. "Lugano-Paradiso" → "lugano",
 * "Mendrisio-Stabio" → "mendrisio") plus a small per-city alias list for
 * common multi-locale spellings ("Bellinzone", "Locarno-Muralto").
 *
 * The Ticino regional rollup matches every job whose `canton` resolves to TI
 * — those jobs are also captured by their city slice (one job can appear in
 * both Lugano AND Ticino aggregates).
 *
 * Output is cached at module level so multiple landings (or repeated calls
 * during a single build) don't re-parse the 31 MB file.
 *
 * Read-only by design — no write side effects.
 */

import * as fs from 'node:fs';
import * as np from 'node:path';
import {
  COL_CITY_IDS,
  type ColCityId,
  type ColLocale,
} from './costOfLivingLandingsData';

// ── Types ────────────────────────────────────────────────────────────────────

/** Subset of jobs.json record fields we actually need. */
interface JobRecord {
  id?: string;
  slug?: string;
  slugByLocale?: Partial<Record<ColLocale, string>>;
  title?: string;
  titleByLocale?: Partial<Record<ColLocale, string>>;
  company?: string;
  companyKey?: string;
  category?: string;
  sector?: string;
  addressLocality?: string;
  canton?: string;
  salaryMin?: number | null;
  salaryMax?: number | null;
  currency?: string;
  postedDate?: string;
  firstSeenAt?: string;
  featured?: boolean;
  employmentType?: string;
  url?: string;
  applyUrl?: string;
}

export interface CityFeaturedJob {
  readonly id: string;
  readonly title: string;
  readonly titleByLocale: Partial<Record<ColLocale, string>>;
  readonly company: string;
  readonly city: string;
  readonly salaryMin: number | null;
  readonly salaryMax: number | null;
  readonly postedDate: string;
  readonly daysAgo: number;
  readonly slug: string;
  readonly slugByLocale: Partial<Record<ColLocale, string>>;
  readonly employmentType: string | null;
}

export interface CityJobsSnapshot {
  /** Live count of matching jobs (all-time, no age filter). */
  readonly liveCount: number;
  /** Count of matches with `postedDate` in the last 30 days. */
  readonly fresh30Count: number;
  /** Median annual gross CHF salary computed from baseSalary midpoints. */
  readonly medianSalaryChf: number | null;
  /** Top 3 freshest (preferring `featured: true`) matching jobs. */
  readonly featured: readonly CityFeaturedJob[];
  /** Top 6 employers in the city by job count. */
  readonly topEmployers: ReadonlyArray<{ name: string; count: number }>;
}

// ── Matchers ─────────────────────────────────────────────────────────────────

/**
 * Per-city alias list. Vendor crawlers spell the same commune in subtly
 * different ways across locales — Bellinzona ↔ Bellinzone (FR), Locarno ↔
 * Locarno-Muralto (postal hamlet), Mendrisio ↔ Mendrisio-Stabio. The matcher
 * normalises diacritics + casefolds, then checks if the job's locality
 * starts with any alias OR contains one in a "<alias>-<suffix>" pattern.
 */
const CITY_ALIASES: Record<Exclude<ColCityId, 'ticino'>, readonly string[]> = {
  lugano: ['lugano', 'paradiso', 'massagno'],
  mendrisio: ['mendrisio', 'stabio', 'chiasso-mendrisio'],
  chiasso: ['chiasso', 'balerna', 'morbio'],
  bellinzona: ['bellinzona', 'bellinzone', 'giubiasco', 'arbedo-castione'],
  locarno: ['locarno', 'muralto', 'minusio', 'tenero'],
};

function stripDiacritics(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function normaliseLocality(raw: string | undefined | null): string {
  if (!raw) return '';
  return stripDiacritics(String(raw)).toLowerCase().trim();
}

function jobMatchesCity(job: JobRecord, cityId: ColCityId): boolean {
  if (cityId === 'ticino') {
    // Region rollup: accept any TI job. Use canton when present, fall back to
    // addressLocality cross-check against the 5 known TI cities so jobs that
    // omit `canton` still get captured.
    const canton = (job.canton ?? '').toString().toUpperCase().trim();
    if (canton === 'TI') return true;
    const loc = normaliseLocality(job.addressLocality);
    if (!loc) return false;
    for (const id of ['lugano', 'mendrisio', 'chiasso', 'bellinzona', 'locarno'] as const) {
      const aliases = CITY_ALIASES[id];
      for (const alias of aliases) {
        if (loc === alias || loc.startsWith(`${alias}-`) || loc.startsWith(`${alias} `)) {
          return true;
        }
      }
    }
    return false;
  }
  const loc = normaliseLocality(job.addressLocality);
  if (!loc) return false;
  const aliases = CITY_ALIASES[cityId];
  for (const alias of aliases) {
    if (loc === alias) return true;
    // "lugano-paradiso" / "lugano paradiso" / "lugano (centro)"
    if (loc.startsWith(`${alias}-`)) return true;
    if (loc.startsWith(`${alias} `)) return true;
    if (loc.startsWith(`${alias},`)) return true;
    if (loc.startsWith(`${alias}/`)) return true;
  }
  return false;
}

// ── Cache + load ─────────────────────────────────────────────────────────────

let _snapshotCache: Record<ColCityId, CityJobsSnapshot> | null = null;
let _cacheRootDir: string | null = null;

const DAY_MS = 86_400_000;

function loadJobs(rootDir: string): readonly JobRecord[] {
  const jobsPath = np.join(rootDir, 'data', 'jobs.json');
  if (!fs.existsSync(jobsPath)) return [];
  try {
    const raw = fs.readFileSync(jobsPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as JobRecord[];
    return [];
  } catch (err) {
    console.warn('[city-jobs-aggregate] failed to read jobs.json:', err);
    return [];
  }
}

function median(values: readonly number[]): number | null {
  const sorted = [...values].filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid];
}

function jobMidpoint(job: JobRecord): number | null {
  const min = typeof job.salaryMin === 'number' ? job.salaryMin : null;
  const max = typeof job.salaryMax === 'number' ? job.salaryMax : null;
  if (min && max) return Math.round((min + max) / 2);
  if (min) return min;
  if (max) return max;
  return null;
}

function toFeatured(job: JobRecord, now: number): CityFeaturedJob | null {
  if (!job.id || !job.title || !job.slug) return null;
  const postedDate = job.postedDate || job.firstSeenAt || '';
  const ts = postedDate ? Date.parse(postedDate) : NaN;
  const daysAgo = Number.isFinite(ts) ? Math.max(0, Math.round((now - ts) / DAY_MS)) : 9999;
  return {
    id: job.id,
    title: job.title,
    titleByLocale: job.titleByLocale ?? {},
    company: job.company ?? '',
    city: job.addressLocality ?? '',
    salaryMin: typeof job.salaryMin === 'number' ? job.salaryMin : null,
    salaryMax: typeof job.salaryMax === 'number' ? job.salaryMax : null,
    postedDate,
    daysAgo,
    slug: job.slug,
    slugByLocale: job.slugByLocale ?? {},
    employmentType: job.employmentType ?? null,
  };
}

function buildSnapshotForCity(
  jobs: readonly JobRecord[],
  cityId: ColCityId,
  now: number,
): CityJobsSnapshot {
  const matches: JobRecord[] = [];
  for (const job of jobs) {
    if (jobMatchesCity(job, cityId)) matches.push(job);
  }

  const last30 = now - 30 * DAY_MS;
  let fresh30 = 0;
  for (const job of matches) {
    const ts = job.postedDate ? Date.parse(job.postedDate) : NaN;
    if (Number.isFinite(ts) && ts >= last30) fresh30++;
  }

  const salaryValues: number[] = [];
  for (const job of matches) {
    const mid = jobMidpoint(job);
    if (mid) salaryValues.push(mid);
  }
  const medianSalary = median(salaryValues);

  const employerCounts = new Map<string, number>();
  for (const job of matches) {
    const name = (job.company ?? '').trim();
    if (!name) continue;
    employerCounts.set(name, (employerCounts.get(name) ?? 0) + 1);
  }
  const topEmployers = [...employerCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([name, count]) => ({ name, count }));

  // Featured: top 3 — prefer `featured: true`, then freshest postedDate.
  const sortedMatches = [...matches].sort((a, b) => {
    const aFeat = a.featured ? 1 : 0;
    const bFeat = b.featured ? 1 : 0;
    if (aFeat !== bFeat) return bFeat - aFeat;
    const aTs = a.postedDate ? Date.parse(a.postedDate) : 0;
    const bTs = b.postedDate ? Date.parse(b.postedDate) : 0;
    return bTs - aTs;
  });
  const featured: CityFeaturedJob[] = [];
  for (const job of sortedMatches) {
    if (featured.length >= 3) break;
    const f = toFeatured(job, now);
    if (f) featured.push(f);
  }

  return {
    liveCount: matches.length,
    fresh30Count: fresh30,
    medianSalaryChf: medianSalary,
    featured,
    topEmployers,
  };
}

/**
 * Aggregate jobs.json into per-city snapshots. Cached per `rootDir`.
 * Pass `now` to override the clock (used by tests); defaults to Date.now().
 */
export function aggregateAllCities(
  rootDir: string,
  now: number = Date.now(),
): Record<ColCityId, CityJobsSnapshot> {
  if (_snapshotCache && _cacheRootDir === rootDir) return _snapshotCache;

  const jobs = loadJobs(rootDir);
  const out = {} as Record<ColCityId, CityJobsSnapshot>;
  for (const id of COL_CITY_IDS) {
    out[id] = buildSnapshotForCity(jobs, id, now);
  }
  _snapshotCache = out;
  _cacheRootDir = rootDir;
  return out;
}

/**
 * Aggregate a single city's snapshot. Convenience wrapper around
 * {@link aggregateAllCities} — reuses the module-level cache.
 */
export function aggregateCityJobs(
  rootDir: string,
  cityId: ColCityId,
  now: number = Date.now(),
): CityJobsSnapshot {
  return aggregateAllCities(rootDir, now)[cityId];
}

/** Test/CI helper — clear the module-level cache. */
export function _resetCityJobsAggregateCache(): void {
  _snapshotCache = null;
  _cacheRootDir = null;
}

// ── Job-board URL builders ───────────────────────────────────────────────────

const JOB_BOARD_SECTION: Record<ColLocale, string> = {
  it: 'cerca-lavoro-ticino',
  en: 'find-jobs-ticino',
  de: 'jobs-im-tessin',
  fr: 'trouver-emploi-tessin',
};

const JOB_BOARD_LOCALE_PREFIX: Record<ColLocale, string> = {
  it: '',
  en: '/en',
  de: '/de',
  fr: '/fr',
};

/**
 * Build the canonical detail-page URL for a featured job in the target locale.
 * Falls back to the IT slug when the locale-specific one is missing.
 */
export function buildFeaturedJobUrl(job: CityFeaturedJob, locale: ColLocale): string {
  const slug = job.slugByLocale[locale] ?? job.slug;
  return `${JOB_BOARD_LOCALE_PREFIX[locale]}/${JOB_BOARD_SECTION[locale]}/${slug}/`;
}

/**
 * Build the city-scoped job-board URL for the given locale + city
 * (e.g. `/cerca-lavoro-ticino/lugano/`). The Ticino regional rollup maps to
 * the un-scoped job-board landing (no per-city subpath).
 */
export function buildCityJobBoardUrl(locale: ColLocale, cityId: ColCityId): string {
  const prefix = JOB_BOARD_LOCALE_PREFIX[locale];
  const section = JOB_BOARD_SECTION[locale];
  if (cityId === 'ticino') return `${prefix}/${section}/`.replace(/\/+/g, '/');
  return `${prefix}/${section}/${cityId}/`.replace(/\/+/g, '/');
}

/** Job-board landing URL for the locale (no city scope). */
export function buildJobBoardUrl(locale: ColLocale): string {
  return `${JOB_BOARD_LOCALE_PREFIX[locale]}/${JOB_BOARD_SECTION[locale]}/`.replace(
    /\/+/g,
    '/',
  );
}
