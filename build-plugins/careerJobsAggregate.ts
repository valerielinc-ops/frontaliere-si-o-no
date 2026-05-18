/**
 * Build-time aggregator for the 4 career-landing topic pages (template B).
 *
 * Unlike `professionJobsAggregate` (clean per-mestiere title matching), the
 * career landings target topic-level concepts:
 *
 *   - agenzie-del-lavoro-lugano      → SECO-authorised staffing agencies
 *   - concorsi-pubblici-lugano       → cantonal/communal/parastatale jobs
 *   - stage-lugano                   → internships in Lugano area
 *   - contratti-lavoro-frontalieri   → editorial (G-permit contracts)
 *
 * Each aggregator returns a shape that mirrors `ProfessionJobsSnapshot` so
 * the renderer can reuse the template-B primitives (stat tiles + featured
 * cards + employer grid). When a topic has no jobs in `data/jobs.json` (e.g.
 * staffing agencies aren't crawled), the aggregator returns a snapshot with
 * empty featured/employer fields — the renderer then either suppresses the
 * section or falls back to a curated authority list (SECO registry,
 * concorsi-ti snapshot).
 *
 * Module-level cache keyed by `rootDir`. Read-only by design.
 */

import * as fs from 'node:fs';
import * as np from 'node:path';
import {
  CAREER_LOCALES,
  type CareerLocale,
} from './careerLandingsData';

// ── Types ────────────────────────────────────────────────────────────────────

/** Subset of jobs.json record fields used by the aggregators. */
interface JobRecord {
  id?: string;
  slug?: string;
  slugByLocale?: Partial<Record<CareerLocale, string>>;
  title?: string;
  titleByLocale?: Partial<Record<CareerLocale, string>>;
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

export interface CareerFeaturedJob {
  readonly id: string;
  readonly title: string;
  readonly titleByLocale: Partial<Record<CareerLocale, string>>;
  readonly company: string;
  readonly city: string;
  readonly salaryMin: number | null;
  readonly salaryMax: number | null;
  readonly postedDate: string;
  readonly daysAgo: number;
  readonly slug: string;
  readonly slugByLocale: Partial<Record<CareerLocale, string>>;
  readonly employmentType: string | null;
}

export interface CareerEmployer {
  readonly name: string;
  /** Live job count when sourced from jobs.json; null when from a curated registry. */
  readonly count: number | null;
}

export interface CareerJobsSnapshot {
  /** Primary count for the stat-tile headline (matching jobs or curated entries). */
  readonly liveCount: number;
  /** Jobs first seen / posted in the last 30 days (NaN-safe: 0 when unknown). */
  readonly fresh30Count: number;
  /** Median annual gross CHF salary from baseSalary midpoints — null when sparse. */
  readonly medianSalaryChf: number | null;
  /** Top 3 freshest jobs (featured first), max 3. Empty when the topic isn't crawled. */
  readonly featured: readonly CareerFeaturedJob[];
  /** Top 6 employers — sourced live or from a curated registry. */
  readonly topEmployers: readonly CareerEmployer[];
  /** Number of top cities (used by the contracts landing). */
  readonly topCities: readonly string[];
}

// ── Constants ────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

/**
 * Lugano-area city regex — matches the city name in `addressLocality` and
 * common variants. Used to scope the public-sector and intern aggregators
 * (the keyword cluster targets Lugano specifically, not all of Ticino).
 */
const LUGANO_AREA_REGEX =
  /\b(lugano|paradiso|massagno|breganzona|viganello|pregassona|sorengo|savosa|porza|cureggia|cassarate|pambio|carona|gandria)\b/i;

/** Public-sector employer matcher — covers cantonal, communal, parastatal entities. */
const PUBLIC_SECTOR_COMPANY_REGEX =
  /\b(comune di|cantone|amministrazione cantonale|cancelleria|repubblica e cantone|eoc|ente ospedaliero|supsi|usi\b|università della svizzera|aet|ses(?:\s|$)|polizia|polcantonale|polizia cantonale|ffs|tilo|tpl|trasporti pubblici luganesi|aziende industriali|cardiocentro|istituto cantonale|fondazione cantonale|swissmedic|confederazione svizzera)\b/i;

/** Internship matcher — covers IT/EN/DE/FR title variants + INTERN employment type. */
const INTERN_TITLE_REGEX =
  /\b(stage(?:\s|$|s)|stagiaire|stagista|tirocini|tirocinio|praktikum|praktikant|internship|intern(?:\s|$)|trainee|tirocinant)/i;

// ── Cache + load ─────────────────────────────────────────────────────────────

let _cache: {
  rootDir: string;
  staffing: CareerJobsSnapshot;
  publicSector: CareerJobsSnapshot;
  internship: CareerJobsSnapshot;
  frontaliereContract: CareerJobsSnapshot;
} | null = null;

function loadJobs(rootDir: string): readonly JobRecord[] {
  const jobsPath = np.join(rootDir, 'data', 'jobs.json');
  if (!fs.existsSync(jobsPath)) return [];
  try {
    const raw = fs.readFileSync(jobsPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as JobRecord[];
    return [];
  } catch (err) {
    console.warn('[career-aggregate] failed to read jobs.json:', err);
    return [];
  }
}

interface SecoAgency {
  name: string;
  city: string;
  type?: string;
  notes?: string;
}

interface SecoRegistry {
  source?: string;
  sourceLabel?: string;
  fetchedAt?: string;
  count?: number;
  agencies: readonly SecoAgency[];
}

function loadSecoRegistry(rootDir: string): SecoRegistry | null {
  const p = np.join(rootDir, 'data', 'seco-staffing-registry.json');
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as SecoRegistry;
  } catch (err) {
    console.warn('[career-aggregate] failed to read seco-staffing-registry.json:', err);
    return null;
  }
}

interface ConcorsiEntry {
  ref?: string;
  title?: string;
  organization?: string | null;
  location?: string | null;
  deadline?: string | null;
  url?: string;
}

interface ConcorsiSnapshot {
  source?: string;
  fetchedAt?: string;
  count?: number;
  concorsi: readonly ConcorsiEntry[];
}

function loadConcorsi(rootDir: string): ConcorsiSnapshot | null {
  const p = np.join(rootDir, 'data', 'seo', 'concorsi-ti.json');
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as ConcorsiSnapshot;
  } catch (err) {
    console.warn('[career-aggregate] failed to read concorsi-ti.json:', err);
    return null;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function jobTitleHaystack(job: JobRecord): string {
  const parts: string[] = [];
  if (job.title) parts.push(job.title);
  if (job.titleByLocale) {
    for (const v of Object.values(job.titleByLocale)) {
      if (v) parts.push(v);
    }
  }
  return parts.join(' ');
}

function jobCityString(job: JobRecord): string {
  return `${job.addressLocality ?? ''} ${job.canton ?? ''}`;
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

function toFeatured(job: JobRecord, now: number): CareerFeaturedJob | null {
  if (!job.id || !job.title || !job.slug) return null;
  const postedDate = job.postedDate || job.firstSeenAt || '';
  const ts = postedDate ? Date.parse(postedDate) : NaN;
  const daysAgo = Number.isFinite(ts) ? Math.max(0, Math.round((now - ts) / DAY_MS)) : 9999;
  // Type-safe slugByLocale: jobs.json keys are arbitrary 2-char strings, but at
  // build-time we only need the CareerLocale subset — drop anything else.
  const slugByLocale: Partial<Record<CareerLocale, string>> = {};
  const titleByLocale: Partial<Record<CareerLocale, string>> = {};
  for (const loc of CAREER_LOCALES) {
    const s = job.slugByLocale?.[loc];
    if (typeof s === 'string') slugByLocale[loc] = s;
    const t = job.titleByLocale?.[loc];
    if (typeof t === 'string') titleByLocale[loc] = t;
  }
  return {
    id: job.id,
    title: job.title,
    titleByLocale,
    company: job.company ?? '',
    city: job.addressLocality ?? '',
    salaryMin: typeof job.salaryMin === 'number' ? job.salaryMin : null,
    salaryMax: typeof job.salaryMax === 'number' ? job.salaryMax : null,
    postedDate,
    daysAgo,
    slug: job.slug,
    slugByLocale,
    employmentType: job.employmentType ?? null,
  };
}

function pickFeatured(matches: readonly JobRecord[], now: number, limit: number): CareerFeaturedJob[] {
  const sorted = [...matches].sort((a, b) => {
    const aFeat = a.featured ? 1 : 0;
    const bFeat = b.featured ? 1 : 0;
    if (aFeat !== bFeat) return bFeat - aFeat;
    const aTs = a.postedDate ? Date.parse(a.postedDate) : 0;
    const bTs = b.postedDate ? Date.parse(b.postedDate) : 0;
    return bTs - aTs;
  });
  const out: CareerFeaturedJob[] = [];
  for (const job of sorted) {
    if (out.length >= limit) break;
    const f = toFeatured(job, now);
    if (f) out.push(f);
  }
  return out;
}

function fresh30Count(matches: readonly JobRecord[], now: number): number {
  const cutoff = now - 30 * DAY_MS;
  let n = 0;
  for (const job of matches) {
    const ts = job.postedDate ? Date.parse(job.postedDate) : NaN;
    if (Number.isFinite(ts) && ts >= cutoff) n++;
  }
  return n;
}

function topEmployersFromJobs(matches: readonly JobRecord[], limit = 6): CareerEmployer[] {
  const counts = new Map<string, number>();
  for (const job of matches) {
    const name = (job.company ?? '').trim();
    if (!name) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, count]) => ({ name, count }));
}

function topCitiesFromJobs(matches: readonly JobRecord[], limit = 5): string[] {
  const counts = new Map<string, number>();
  for (const job of matches) {
    const c = (job.addressLocality ?? '').trim();
    if (!c) continue;
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name]) => name);
}

// ── Aggregators ──────────────────────────────────────────────────────────────

/**
 * Agenzie del lavoro (staffing agencies) — Lugano.
 *
 * Vendor crawlers don't ingest staffing-agency jobs as such (Adecco etc. post
 * their assignments under client brands), so `data/jobs.json` returns ~0
 * matches by company. The aggregator therefore sources the live signal from
 * the SECO registry snapshot (`data/seco-staffing-registry.json`) — that's
 * the authoritative count of AVG-authorised agencies the page is built around.
 * Featured is intentionally empty; the employer grid uses the SECO list.
 */
function buildStaffingSnapshot(rootDir: string): CareerJobsSnapshot {
  const registry = loadSecoRegistry(rootDir);
  const agencies = registry?.agencies ?? [];
  const topEmployers: CareerEmployer[] = agencies
    .slice(0, 6)
    .map((a) => ({ name: a.name, count: null }));
  return {
    liveCount: agencies.length,
    fresh30Count: 0,
    medianSalaryChf: null,
    featured: [],
    topEmployers,
    topCities: ['Lugano'],
  };
}

/**
 * Concorsi pubblici / public-sector jobs — Lugano area.
 *
 * Combines two sources:
 *   - `data/seo/concorsi-ti.json` snapshot — cantonal concorsi (the canonical
 *     count for the headline tile).
 *   - `data/jobs.json` filtered by company regex matching cantonal/communal/
 *     parastatal entities + Lugano-area locality — for featured cards and
 *     a richer employer grid.
 */
function buildPublicSectorSnapshot(
  rootDir: string,
  jobs: readonly JobRecord[],
  now: number,
): CareerJobsSnapshot {
  const concorsi = loadConcorsi(rootDir);
  const concorsiCount = concorsi?.concorsi.length ?? 0;

  const matches: JobRecord[] = [];
  for (const job of jobs) {
    const company = `${job.company ?? ''} ${job.companyKey ?? ''}`;
    if (!PUBLIC_SECTOR_COMPANY_REGEX.test(company)) continue;
    const city = jobCityString(job);
    if (city && !LUGANO_AREA_REGEX.test(city)) {
      // Also accept jobs that don't have city info but DO match canton TI —
      // the company regex is strict enough that EOC/Cantone TI is on-topic.
      const isTicino = (job.canton ?? '').toLowerCase() === 'ti';
      if (!isTicino) continue;
    }
    matches.push(job);
  }

  const liveCount = Math.max(concorsiCount, matches.length);
  const salaryValues: number[] = [];
  for (const job of matches) {
    const mid = jobMidpoint(job);
    if (mid) salaryValues.push(mid);
  }

  return {
    liveCount,
    fresh30Count: fresh30Count(matches, now),
    medianSalaryChf: median(salaryValues),
    featured: pickFeatured(matches, now, 3),
    topEmployers: topEmployersFromJobs(matches, 6),
    topCities: topCitiesFromJobs(matches, 5),
  };
}

/**
 * Stage / internships — Lugano area.
 *
 * Matches on `employmentType === 'INTERN'` (case-insensitive) OR title regex
 * across the 4 locale variants. Scopes to Lugano locality.
 */
function buildInternshipSnapshot(jobs: readonly JobRecord[], now: number): CareerJobsSnapshot {
  const matches: JobRecord[] = [];
  for (const job of jobs) {
    const et = (job.employmentType ?? '').toUpperCase();
    const isIntern = et === 'INTERN' || INTERN_TITLE_REGEX.test(jobTitleHaystack(job));
    if (!isIntern) continue;
    const city = jobCityString(job);
    if (!LUGANO_AREA_REGEX.test(city)) continue;
    matches.push(job);
  }
  const salaryValues: number[] = [];
  for (const job of matches) {
    const mid = jobMidpoint(job);
    if (mid) salaryValues.push(mid);
  }
  return {
    liveCount: matches.length,
    fresh30Count: fresh30Count(matches, now),
    medianSalaryChf: median(salaryValues),
    featured: pickFeatured(matches, now, 3),
    // No employer grid for stage — the curated copy carries that signal.
    topEmployers: [],
    topCities: topCitiesFromJobs(matches, 3),
  };
}

/**
 * Contratti lavoro frontalieri — purely editorial.
 *
 * Surfaces total CH-side jobs + median salary + top cities to give the page
 * concrete numbers in the stat tiles, but does NOT pick featured jobs (the
 * topic is about contract types, not specific positions).
 */
function buildFrontaliereContractSnapshot(
  jobs: readonly JobRecord[],
  now: number,
): CareerJobsSnapshot {
  // Use every job in the dataset (all are CH-side, suitable for permesso G).
  const salaryValues: number[] = [];
  for (const job of jobs) {
    const mid = jobMidpoint(job);
    if (mid) salaryValues.push(mid);
  }
  return {
    liveCount: jobs.length,
    fresh30Count: fresh30Count(jobs, now),
    medianSalaryChf: median(salaryValues),
    featured: [],
    topEmployers: [],
    topCities: topCitiesFromJobs(jobs, 5),
  };
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface CareerLandingSnapshots {
  readonly 'agenzie-lavoro-lugano': CareerJobsSnapshot;
  readonly 'concorsi-pubblici-lugano': CareerJobsSnapshot;
  readonly 'stage-lugano': CareerJobsSnapshot;
  readonly 'contratti-lavoro-frontalieri': CareerJobsSnapshot;
}

/**
 * Aggregate every career landing's snapshot in a single pass. Module-level
 * cached per `rootDir` so multiple plugins (or repeated calls during a build)
 * don't re-parse the 30 MB jobs.json file.
 */
export function aggregateCareerLandings(
  rootDir: string,
  now: number = Date.now(),
): CareerLandingSnapshots {
  if (_cache && _cache.rootDir === rootDir) {
    return {
      'agenzie-lavoro-lugano': _cache.staffing,
      'concorsi-pubblici-lugano': _cache.publicSector,
      'stage-lugano': _cache.internship,
      'contratti-lavoro-frontalieri': _cache.frontaliereContract,
    };
  }

  const jobs = loadJobs(rootDir);
  const staffing = buildStaffingSnapshot(rootDir);
  const publicSector = buildPublicSectorSnapshot(rootDir, jobs, now);
  const internship = buildInternshipSnapshot(jobs, now);
  const frontaliereContract = buildFrontaliereContractSnapshot(jobs, now);

  _cache = {
    rootDir,
    staffing,
    publicSector,
    internship,
    frontaliereContract,
  };

  return {
    'agenzie-lavoro-lugano': staffing,
    'concorsi-pubblici-lugano': publicSector,
    'stage-lugano': internship,
    'contratti-lavoro-frontalieri': frontaliereContract,
  };
}

/** Test/CI helper — clear the module-level cache. */
export function _resetCareerJobsAggregateCache(): void {
  _cache = null;
}

// ── Job-board URL builder ────────────────────────────────────────────────────

const JOB_BOARD_BASE_PATH: Record<CareerLocale, string> = {
  it: '/cerca-lavoro-ticino',
  en: '/en/find-jobs-ticino',
  de: '/de/jobs-im-tessin',
  fr: '/fr/trouver-emploi-tessin',
};

export function buildCareerFeaturedJobUrl(
  job: CareerFeaturedJob,
  locale: CareerLocale,
): string {
  const slug = job.slugByLocale[locale] ?? job.slug;
  return `${JOB_BOARD_BASE_PATH[locale]}/${slug}/`;
}

export function buildCareerJobBoardUrl(locale: CareerLocale): string {
  return `${JOB_BOARD_BASE_PATH[locale]}/`;
}
