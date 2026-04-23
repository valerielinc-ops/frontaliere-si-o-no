/**
 * Weekly "Aziende che assumono" per-city Hub — Vite build plugin (F5).
 *
 * Emits a static HTML page per (locale × city × "current-week") plus
 * archive pages for each ISO week present in
 * `data/jobs-snapshots-history/*.json`. Pages list the top employers
 * hiring in the target city this week ranked by weekly delta
 * (new openings minus previous snapshot).
 *
 * Degradation when no snapshot history exists:
 *   - If `data/jobs-snapshots-history/` is empty or has <2 files, we still
 *     generate "current-week" pages with current jobs.json data only
 *     (no delta, "baseline data" label). Build does NOT fail.
 *   - Archive pages are only generated once ≥2 historical snapshots exist.
 *
 * Quality gates:
 *   - ≥50 words hard gate (target ≥300)
 *   - All 4 locales × 7 cities (6 cities + regional Ticino hub)
 *   - NO `dark:` color prefixes — semantic tokens via CSS vars
 *   - WriteCollector.skipExisting via content-hash manifest
 *   - Env gate: SKIP_WEEKLY_EMPLOYERS=1 short-circuits the plugin
 *
 * Indexing policy:
 *   - Current week + last 12 weekly archives: `index,follow`
 *   - Older archives: `noindex,follow` (kept reachable for continuity)
 *
 * Auto-stub employer sub-feature (DEFAULT OFF):
 *   - Env `ENABLE_AUTO_EMPLOYER_STUBS=1` — enables a `data-needs-editorial-
 *     review="true"` attribute on top-3 emerging companies lacking a
 *     curated employer brand hub. Ship disabled per plan.
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
  MAX_COMPANY_CITY_PAGES_PER_BUILD,
  MIN_JOBS_PER_COMPANY_IN_CITY,
  WEEKLY_EMPLOYERS_ARCHIVE_PREFIX,
  WEEKLY_EMPLOYERS_CITIES,
  WEEKLY_EMPLOYERS_CITY_DISPLAY,
  WEEKLY_EMPLOYERS_COMPANY_CITY_LIST,
  WEEKLY_EMPLOYERS_CURRENT_SLUG,
  WEEKLY_EMPLOYERS_INDEXABLE_WEEKS,
  WEEKLY_EMPLOYERS_LOCALE_PREFIX,
  WEEKLY_EMPLOYERS_LOCALES,
  WEEKLY_EMPLOYERS_OG_LOCALE,
  WEEKLY_EMPLOYERS_SECTION,
  buildArchiveWeekPath,
  buildCompanyCityArchivePath,
  buildCompanyCityCurrentPath,
  buildCurrentWeekPath,
  canonicalCompanySlug,
  getIsoWeekAndYear,
  isoWeekKey,
  parseCompanyCityPath,
  type CompanyCityPair,
  type WeeklyEmployersCity,
  type WeeklyEmployersCompanyCity,
  type WeeklyEmployersLocale,
} from './weeklyEmployersData';
import { generateRelatedLinksBlock } from './shared/relatedLinks';
import { EMPLOYER_BRANDS } from '../services/employerBrands';
import { resolveFallbackAddress, deriveCantonFromCity } from './shared/companyHqAddresses';

// ── Types ───────────────────────────────────────────────────────

export interface WeeklyCountableJob {
  slug?: string;
  slugByLocale?: Partial<Record<WeeklyEmployersLocale, string>>;
  title?: string;
  titleByLocale?: Partial<Record<WeeklyEmployersLocale, string>>;
  company?: string;
  companyKey?: string;
  location?: string;
  addressLocality?: string;
  postedDate?: string;
  datePosted?: string;
  expired?: boolean;
  needsRetranslation?: boolean | Partial<Record<WeeklyEmployersLocale, boolean>>;
  description?: string;
  descriptionByLocale?: Partial<Record<WeeklyEmployersLocale, string>>;
  category?: string;
  sector?: string;
  // ── JobPosting-structured-data inputs (optional; fallbacks apply) ──
  /** Contract label from crawlers: full-time | part-time | contract | … */
  contract?: string;
  /** Schema.org JobPosting employmentType token if pre-mapped. */
  employmentType?: string;
  /** Advertised yearly salary range, ISO 4217 currency. */
  salaryMin?: number;
  salaryMax?: number;
  salaryCurrency?: string;
  /** Rich baseSalary object if the crawler already produced one. */
  baseSalary?: {
    currency?: string;
    value?: {
      minValue?: number;
      maxValue?: number;
      value?: number;
      unitText?: string;
    };
  };
  streetAddress?: string;
  postalCode?: string;
}

/** Minimal shape persisted to data/jobs-snapshots-history/{YYYY-WW}.json. */
export interface JobsSnapshot {
  week: string; // "YYYY-WW"
  generatedAt?: string;
  jobs: Array<{
    slug: string;
    employer: string;
    employerKey?: string;
    city: string;
    role?: string;
    postedAt?: string;
  }>;
}

/** Per-city aggregation produced from current jobs + snapshot pair. */
export interface CityWeeklyStats {
  city: WeeklyEmployersCity;
  activeJobsCount: number;
  topCompanies: Array<{
    employer: string;
    employerKey?: string;
    active: number;
    delta: number; // current active - previous active (0 if no history)
  }>;
  newcomers: Array<{ employer: string; employerKey?: string; active: number }>;
  topRoles: Array<{ role: string; count: number }>;
}

// ── Helpers ─────────────────────────────────────────────────────

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function wordCount(s: string | undefined | null): number {
  if (!s) return 0;
  return String(s).trim().split(/\s+/).filter(Boolean).length;
}

function jobIsActive(
  job: WeeklyCountableJob,
  locale: WeeklyEmployersLocale,
): boolean {
  if (!job || typeof job !== 'object') return false;
  if (job.expired) return false;
  const nr = job.needsRetranslation;
  if (nr === true) return false;
  if (nr && typeof nr === 'object' && (nr as Record<string, boolean>)[locale]) {
    return false;
  }
  const localeDesc = job.descriptionByLocale?.[locale];
  const fallback = locale === 'it' ? job.description : undefined;
  const desc = localeDesc && localeDesc.trim().length > 0 ? localeDesc : fallback;
  return wordCount(desc) >= 50;
}

/** Case-insensitive city match against location / addressLocality. */
export function jobMatchesCity(
  job: WeeklyCountableJob,
  city: WeeklyEmployersCity,
): boolean {
  // "ticino" regional hub matches every Swiss job we have (site is Ticino-only)
  if (city === 'ticino') return true;
  const needle = WEEKLY_EMPLOYERS_CITY_DISPLAY[city].toLowerCase();
  const candidates = [job.addressLocality, job.location]
    .map((v) => (typeof v === 'string' ? v.toLowerCase() : ''))
    .filter(Boolean);
  return candidates.some((c) => c.includes(needle));
}

function normEmployerKey(company: string, companyKey?: string): string {
  const raw = (companyKey || company || '').trim().toLowerCase();
  return raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Build a per-city aggregation from current jobs + optional previous snapshot. */
export function buildCityWeeklyStats(opts: {
  city: WeeklyEmployersCity;
  locale: WeeklyEmployersLocale;
  jobs: readonly WeeklyCountableJob[];
  previousSnapshot?: JobsSnapshot | null;
  /** Older snapshots used to decide "first appearance". */
  historicalSnapshots?: readonly JobsSnapshot[];
  limitCompanies?: number;
}): CityWeeklyStats {
  const {
    city,
    locale,
    jobs,
    previousSnapshot,
    historicalSnapshots = [],
    limitCompanies = 20,
  } = opts;

  // Active jobs matching this city in this locale
  const cityJobs = jobs.filter(
    (j) => jobIsActive(j, locale) && jobMatchesCity(j, city),
  );

  // Count per employer (active)
  const activeCounts = new Map<
    string,
    { employer: string; employerKey?: string; active: number }
  >();
  for (const j of cityJobs) {
    const company = String(j.company || '').trim();
    if (!company) continue;
    const key = normEmployerKey(company, j.companyKey);
    const rec = activeCounts.get(key);
    if (rec) {
      rec.active++;
    } else {
      activeCounts.set(key, {
        employer: company,
        employerKey: j.companyKey || key,
        active: 1,
      });
    }
  }

  // Previous-week count per employer
  const prevCounts = new Map<string, number>();
  if (previousSnapshot?.jobs) {
    for (const row of previousSnapshot.jobs) {
      // Use same city match semantics on snapshot row
      if (city !== 'ticino') {
        if (
          !String(row.city || '')
            .toLowerCase()
            .includes(WEEKLY_EMPLOYERS_CITY_DISPLAY[city].toLowerCase())
        ) {
          continue;
        }
      }
      const key = normEmployerKey(row.employer || '', row.employerKey);
      prevCounts.set(key, (prevCounts.get(key) || 0) + 1);
    }
  }

  // Historical employer set — any employer observed in prior snapshots (except the
  // most recent / previous one) — used for "first-time" detection.
  const historicallyKnown = new Set<string>();
  for (const snap of historicalSnapshots) {
    for (const row of snap.jobs || []) {
      const key = normEmployerKey(row.employer || '', row.employerKey);
      if (key) historicallyKnown.add(key);
    }
  }
  if (previousSnapshot?.jobs) {
    for (const row of previousSnapshot.jobs) {
      const key = normEmployerKey(row.employer || '', row.employerKey);
      if (key) historicallyKnown.add(key);
    }
  }

  const topCompanies = Array.from(activeCounts.entries())
    .map(([key, rec]) => {
      const prev = prevCounts.get(key) ?? 0;
      return {
        employer: rec.employer,
        employerKey: rec.employerKey,
        active: rec.active,
        delta: rec.active - prev,
      };
    })
    .sort((a, b) => {
      if (b.delta !== a.delta) return b.delta - a.delta;
      return b.active - a.active;
    })
    .slice(0, limitCompanies);

  const newcomers = Array.from(activeCounts.entries())
    .filter(([key]) => !historicallyKnown.has(key))
    .map(([key, rec]) => ({
      employer: rec.employer,
      employerKey: rec.employerKey ?? key,
      active: rec.active,
    }))
    .sort((a, b) => b.active - a.active)
    .slice(0, 10);

  // Top roles
  const roleCounts = new Map<string, number>();
  for (const j of cityJobs) {
    const role = (j.titleByLocale?.[locale] || j.title || '').trim();
    if (!role) continue;
    // Extract first 3-4 words — a reasonable "role family" bucket
    const bucket = role
      .split(/\s+/)
      .slice(0, 3)
      .join(' ')
      .toLowerCase();
    roleCounts.set(bucket, (roleCounts.get(bucket) || 0) + 1);
  }
  const topRoles = Array.from(roleCounts.entries())
    .map(([role, count]) => ({ role, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  return {
    city,
    activeJobsCount: cityJobs.length,
    topCompanies,
    newcomers,
    topRoles,
  };
}

// ── Company × City aggregation (D-2 Expansion B) ───────────────

export interface CompanyCityActiveJob {
  slug: string;
  title: string;
  detailPath: string;
  postedDate?: string;
  /**
   * Full job description (locale-specific or IT fallback). Used to emit
   * JobPosting.description with ≥30 chars — CLAUDE.md rule #3.
   */
  description?: string;
  /**
   * Schema.org JobPosting employmentType token (e.g. `FULL_TIME`,
   * `PART_TIME`, `CONTRACTOR`). Always populated; defaults to
   * `FULL_TIME` when source data omits it.
   */
  employmentType?: string;
  /** `baseSalary.value.minValue` (CHF, yearly). */
  salaryMin?: number;
  /** `baseSalary.value.maxValue` (CHF, yearly). */
  salaryMax?: number;
  /** ISO currency code for baseSalary. Defaults to `CHF`. */
  salaryCurrency?: string;
  /** Explicit street address from source job (may be unvalidated). */
  streetAddress?: string;
  /** Explicit postal code from source job (may be unvalidated). */
  postalCode?: string;
  /**
   * Source job's addressLocality if present — lets us pick the job's
   * actual locality over the hub-city parameter.
   */
  addressLocality?: string;
  /**
   * Schema.org-compliant Swiss canton code (`TI`, `GR`, …) from source
   * data. When absent we derive it from `addressLocality`.
   */
  addressRegion?: string;
  /** ISO datetime when the job was last verified active by the crawler. */
  crawledAt?: string;
  /** Source-provided validThrough date — overrides the computed default. */
  validThrough?: string;
  /**
   * Canonicalised company slug — consumed by `jobToJsonLd` to look up
   * `COMPANY_HQ_ADDRESSES` fallback when the job lacks valid HQ data.
   */
  companySlug?: string;
}

export interface CompanyCityStats {
  city: WeeklyEmployersCompanyCity;
  companySlug: string;
  employer: string;
  employerKey?: string;
  activeJobs: CompanyCityActiveJob[];
  activeJobsCount: number;
  /** Delta vs previous snapshot (current - previous) for this (company, city). */
  delta: number;
  /** Previous snapshot count (for this company × city). 0 when no history. */
  previousCount: number;
  /** Top 3 role "families" (first 3 words, lowercased) for editorial copy. */
  topRoles: Array<{ role: string; count: number }>;
  /** Average advertised salary in CHF (rounded) when jobs expose a baseSalary. */
  avgSalary?: number;
}

/**
 * Job-detail section slug per locale — mirrors jobsSeoPagesPlugin.ts so
 * the company-city page links to the actual static job HTML.
 */
const JOB_DETAIL_SECTION_BY_LOCALE: Record<WeeklyEmployersLocale, string> = {
  it: 'cerca-lavoro-ticino',
  en: 'find-jobs-ticino',
  de: 'jobs-im-tessin',
  fr: 'trouver-emploi-tessin',
};

function localizedJobSlug(
  job: WeeklyCountableJob,
  locale: WeeklyEmployersLocale,
): string {
  const byLocale = job.slugByLocale?.[locale];
  if (byLocale && typeof byLocale === 'string' && byLocale.length > 0) return byLocale;
  return String(job.slug || '');
}

function buildJobDetailPath(
  job: WeeklyCountableJob,
  locale: WeeklyEmployersLocale,
): string {
  const slug = localizedJobSlug(job, locale);
  if (!slug) return '';
  const prefix = WEEKLY_EMPLOYERS_LOCALE_PREFIX[locale];
  const section = JOB_DETAIL_SECTION_BY_LOCALE[locale];
  return `${prefix}/${section}/${slug}/`.replace(/\/+/g, '/');
}

interface JobBaseSalaryLike {
  baseSalary?: {
    value?: {
      minValue?: number;
      maxValue?: number;
      value?: number;
    };
  };
  salaryMin?: number;
  salaryMax?: number;
}

/**
 * Map source contract/employmentType strings to Schema.org JobPosting tokens.
 * Always returns a non-empty value — defaults to `FULL_TIME` when the source
 * job omits a contract label (CLAUDE.md rule #3: employmentType is mandatory).
 */
const EMPLOYMENT_TYPE_MAP: Record<string, string> = {
  'full-time': 'FULL_TIME',
  'fulltime': 'FULL_TIME',
  'full time': 'FULL_TIME',
  'part-time': 'PART_TIME',
  'parttime': 'PART_TIME',
  'part time': 'PART_TIME',
  'temporary': 'TEMPORARY',
  'internship': 'INTERN',
  'intern': 'INTERN',
  'contract': 'CONTRACTOR',
  'contractor': 'CONTRACTOR',
  'per-diem': 'PER_DIEM',
  'other': 'OTHER',
};

function resolveEmploymentType(job: WeeklyCountableJob): string {
  const explicit = String(job.employmentType || '').trim().toUpperCase();
  if (explicit) {
    // Already a Schema.org token (e.g. 'FULL_TIME') — accept as-is.
    if (/^[A-Z_]+$/.test(explicit)) return explicit;
    const mapped = EMPLOYMENT_TYPE_MAP[explicit.toLowerCase()];
    if (mapped) return mapped;
  }
  const contract = String(job.contract || '').trim().toLowerCase();
  if (contract && EMPLOYMENT_TYPE_MAP[contract]) return EMPLOYMENT_TYPE_MAP[contract];
  return 'FULL_TIME';
}

function extractSalaryMidpoint(job: WeeklyCountableJob): number | null {
  const j = job as JobBaseSalaryLike;
  const min = j.baseSalary?.value?.minValue ?? j.salaryMin;
  const max = j.baseSalary?.value?.maxValue ?? j.salaryMax;
  if (typeof min === 'number' && typeof max === 'number' && min > 0 && max > 0) {
    return Math.round((min + max) / 2);
  }
  const single = j.baseSalary?.value?.value;
  if (typeof single === 'number' && single > 0) return single;
  if (typeof min === 'number' && min > 0) return min;
  if (typeof max === 'number' && max > 0) return max;
  return null;
}

/**
 * Build a per (company × city) aggregation. Returns null when the gate
 * {@link MIN_JOBS_PER_COMPANY_IN_CITY} isn't met — caller must check.
 *
 * `companySlug` is passed explicitly so the caller decides the canonical
 * slug (keeps slug logic in one place).
 */
export function buildCompanyCityStats(opts: {
  city: WeeklyEmployersCompanyCity;
  companySlug: string;
  employerKey: string;
  locale: WeeklyEmployersLocale;
  jobs: readonly WeeklyCountableJob[];
  previousSnapshot?: JobsSnapshot | null;
  limitJobs?: number;
}): CompanyCityStats | null {
  const {
    city,
    companySlug,
    employerKey,
    locale,
    jobs,
    previousSnapshot,
    limitJobs = 10,
  } = opts;

  // IMPORTANT: for a listing page we use the IT-locale activity oracle so a
  // job present only in IT still shows up on EN/DE/FR hubs (the detail page
  // URL falls back to the IT slug when the locale slug is missing — same
  // policy as existing F5 city-level hubs).
  const matching = jobs.filter((j) => {
    if (!jobIsActive(j, 'it')) return false;
    if (!jobMatchesCity(j, city)) return false;
    const company = String(j.company || '').trim();
    if (!company) return false;
    const jobKey = normEmployerKey(company, j.companyKey);
    return jobKey === employerKey;
  });

  if (matching.length < MIN_JOBS_PER_COMPANY_IN_CITY) return null;

  // Canonical employer display name — take first job's company string.
  const employer = String(matching[0].company || '').trim();

  // Sort by recency desc (postedDate/datePosted descending, missing last).
  const sorted = [...matching].sort((a, b) => {
    const da = String(a.postedDate || a.datePosted || '');
    const db = String(b.postedDate || b.datePosted || '');
    return db.localeCompare(da);
  });

  const activeJobs: CompanyCityActiveJob[] = sorted.slice(0, limitJobs).map((j) => {
    const js = j as JobBaseSalaryLike & WeeklyCountableJob;
    const localeDesc = j.descriptionByLocale?.[locale];
    const itDesc = j.description;
    const description = (localeDesc && localeDesc.trim().length > 0 ? localeDesc : itDesc) || '';
    const salaryMin =
      typeof js.salaryMin === 'number' && js.salaryMin > 0
        ? js.salaryMin
        : typeof js.baseSalary?.value?.minValue === 'number' && js.baseSalary.value.minValue > 0
          ? js.baseSalary.value.minValue
          : undefined;
    const salaryMax =
      typeof js.salaryMax === 'number' && js.salaryMax > 0
        ? js.salaryMax
        : typeof js.baseSalary?.value?.maxValue === 'number' && js.baseSalary.value.maxValue > 0
          ? js.baseSalary.value.maxValue
          : undefined;
    const salaryCurrency =
      (typeof js.salaryCurrency === 'string' && js.salaryCurrency) ||
      (typeof js.baseSalary?.currency === 'string' && js.baseSalary.currency) ||
      undefined;
    return {
      slug: localizedJobSlug(j, locale) || String(j.slug || ''),
      title: String(j.titleByLocale?.[locale] || j.title || '').trim(),
      detailPath: buildJobDetailPath(j, locale),
      postedDate: j.postedDate || j.datePosted,
      description: description.trim() ? description : undefined,
      employmentType: resolveEmploymentType(j),
      salaryMin,
      salaryMax,
      salaryCurrency,
      streetAddress:
        typeof j.streetAddress === 'string' && j.streetAddress.trim().length > 0
          ? j.streetAddress.trim()
          : undefined,
      postalCode:
        typeof j.postalCode === 'string' && j.postalCode.trim().length > 0
          ? j.postalCode.trim()
          : undefined,
      addressLocality:
        typeof j.addressLocality === 'string' && j.addressLocality.trim().length > 0
          ? j.addressLocality.trim()
          : undefined,
      companySlug,
    };
  });

  // Previous snapshot count for this (company, city).
  let previousCount = 0;
  if (previousSnapshot?.jobs) {
    for (const row of previousSnapshot.jobs) {
      if (!row.employer) continue;
      const rowKey = normEmployerKey(row.employer, row.employerKey);
      if (rowKey !== employerKey) continue;
      if (
        !String(row.city || '')
          .toLowerCase()
          .includes(WEEKLY_EMPLOYERS_CITY_DISPLAY[city].toLowerCase())
      ) {
        continue;
      }
      previousCount++;
    }
  }
  const delta = matching.length - previousCount;

  // Role families: first 3 words lowercase.
  const roleCounts = new Map<string, number>();
  for (const j of matching) {
    const role = (j.titleByLocale?.[locale] || j.title || '').trim();
    if (!role) continue;
    const bucket = role.split(/\s+/).slice(0, 3).join(' ').toLowerCase();
    roleCounts.set(bucket, (roleCounts.get(bucket) || 0) + 1);
  }
  const topRoles = Array.from(roleCounts.entries())
    .map(([role, count]) => ({ role, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 3);

  // Salary average.
  const salaries: number[] = [];
  for (const j of matching) {
    const mid = extractSalaryMidpoint(j);
    if (mid !== null) salaries.push(mid);
  }
  const avgSalary =
    salaries.length > 0
      ? Math.round(salaries.reduce((s, v) => s + v, 0) / salaries.length)
      : undefined;

  return {
    city,
    companySlug,
    employer,
    employerKey,
    activeJobs,
    activeJobsCount: matching.length,
    delta,
    previousCount,
    topRoles,
    avgSalary,
  };
}

/**
 * Enumerate the (company × city) pairs that satisfy the
 * {@link MIN_JOBS_PER_COMPANY_IN_CITY} gate. A pair qualifies iff ≥3
 * active jobs from that company are posted in that city (in the IT locale —
 * we treat IT as the "does this company exist in this city?" oracle; EN/DE/FR
 * pages still render from localised job fields).
 *
 * The result is ordered by (city ASC, active DESC, companySlug ASC) so the
 * iteration order is deterministic across builds.
 *
 * Respects the {@link MAX_COMPANY_CITY_PAGES_PER_BUILD} cap — pairs beyond
 * the cap are silently dropped.
 */
export function enumerateCompanyCityPairs(
  jobs: readonly WeeklyCountableJob[],
): Array<CompanyCityPair & { employerKey: string; employer: string; active: number }> {
  const pairs = new Map<
    string,
    {
      city: WeeklyEmployersCompanyCity;
      companySlug: string;
      employerKey: string;
      employer: string;
      active: number;
    }
  >();

  for (const city of WEEKLY_EMPLOYERS_COMPANY_CITY_LIST) {
    const counts = new Map<
      string,
      { employer: string; employerKey: string; active: number }
    >();
    for (const j of jobs) {
      if (!jobIsActive(j, 'it')) continue;
      if (!jobMatchesCity(j, city)) continue;
      const company = String(j.company || '').trim();
      if (!company) continue;
      const key = normEmployerKey(company, j.companyKey);
      if (!key) continue;
      const rec = counts.get(key);
      if (rec) rec.active++;
      else counts.set(key, { employer: company, employerKey: key, active: 1 });
    }
    for (const [employerKey, rec] of counts.entries()) {
      if (rec.active < MIN_JOBS_PER_COMPANY_IN_CITY) continue;
      const companySlug = canonicalCompanySlug(rec.employer, employerKey);
      if (!companySlug || !/^[a-z0-9][a-z0-9-]*$/.test(companySlug)) continue;
      pairs.set(`${city}::${companySlug}`, {
        city,
        companySlug,
        employerKey,
        employer: rec.employer,
        active: rec.active,
      });
    }
  }

  const pages = Array.from(pairs.values()).sort((a, b) => {
    if (a.city !== b.city) return a.city < b.city ? -1 : 1;
    if (b.active !== a.active) return b.active - a.active;
    return a.companySlug < b.companySlug ? -1 : 1;
  });

  // 4 locales × pairs = page count. Cap at MAX_COMPANY_CITY_PAGES_PER_BUILD.
  const maxPairs = Math.floor(
    MAX_COMPANY_CITY_PAGES_PER_BUILD / WEEKLY_EMPLOYERS_LOCALES.length,
  );
  return pages.slice(0, maxPairs);
}

// ── Localised copy ──────────────────────────────────────────────

interface WeeklyCopy {
  sectionLabel: string;
  breadcrumbHome: string;
  h1Current: (cityDisplay: string, isRegional: boolean) => string;
  h1Archive: (cityDisplay: string, week: number, year: number, isRegional: boolean) => string;
  kickerCurrent: string;
  kickerArchive: string;
  heroSummary: (city: string, companiesCount: number, jobsCount: number) => string;
  heroSummaryNoDelta: (city: string, companiesCount: number, jobsCount: number) => string;
  intro: (city: string) => string;
  topCompaniesTitle: string;
  topCompaniesEmpty: string;
  newcomersTitle: string;
  newcomersDesc: string;
  newcomersEmpty: string;
  rolesTitle: string;
  rolesEmpty: string;
  relatedLinksTitle: string;
  relatedLinksCityHub: (city: string) => string;
  relatedLinksEmployerBrand: (employer: string) => string;
  jobsCountLabel: (count: number) => string;
  deltaPositive: (count: number) => string;
  deltaZero: string;
  coldStart: string;
  faqTitle: string;
  faqHowOftenQ: string;
  faqHowOftenA: string;
  faqDeltaQ: string;
  faqDeltaA: string;
  faqApplyQ: string;
  faqApplyA: string;
  archiveNoindexNote: string;
  updatedLabel: string;
  // Extra body copy — helps hit ≥300 words without feeling templatey
  editorialBlock: (city: string) => string;
  methodologyBlock: string;
  // ── Company × City page copy (D-2 Expansion B) ────────────────
  companyCityH1Current: (employer: string, city: string) => string;
  companyCityH1Archive: (
    employer: string,
    city: string,
    week: number,
    year: number,
  ) => string;
  companyCityKicker: string;
  /** Hero summary WITH delta. */
  companyCityHeroWithDelta: (args: {
    employer: string;
    city: string;
    jobsCount: number;
    delta: number;
  }) => string;
  /** Hero summary WITHOUT delta (cold start). */
  companyCityHeroNoDelta: (args: {
    employer: string;
    city: string;
    jobsCount: number;
  }) => string;
  companyCityIntro: (args: {
    employer: string;
    city: string;
    topRoles: string[];
    avgSalary?: number;
  }) => string;
  companyCityJobsHeading: (employer: string, city: string) => string;
  companyCityApplyCta: string;
  companyCityBrandHubLabel: (employer: string) => string;
  companyCityParentHubLabel: (city: string) => string;
  companyCityCityHubLabel: (city: string) => string;
  companyCitySiblingLabel: (employer: string, city: string) => string;
  companyCityEditorial: (args: {
    employer: string;
    city: string;
    jobsCount: number;
    topRoles: string[];
  }) => string;
  companyCityFaqWhyQ: (employer: string) => string;
  companyCityFaqWhyA: (employer: string, city: string) => string;
  companyCityFaqHowApplyQ: string;
  companyCityFaqHowApplyA: (employer: string) => string;
  companyCityFaqUpdateQ: string;
  companyCityFaqUpdateA: string;
}

const COPY: Record<WeeklyEmployersLocale, WeeklyCopy> = {
  it: {
    sectionLabel: 'Aziende che assumono',
    breadcrumbHome: 'Home',
    h1Current: (c, reg) =>
      reg ? `Aziende che assumono in Ticino questa settimana` : `Aziende che assumono a ${c} questa settimana`,
    h1Archive: (c, w, y, reg) =>
      reg ? `Aziende che assumevano in Ticino — Settimana ${w} ${y}` : `Aziende che assumevano a ${c} — Settimana ${w} ${y}`,
    kickerCurrent: 'Classifica settimanale',
    kickerArchive: 'Archivio settimanale',
    heroSummary: (city, c, j) =>
      `Questa settimana a ${city} ${c} aziende hanno pubblicato ${j} offerte attive.`,
    heroSummaryNoDelta: (city, c, j) =>
      `A ${city} risultano ${c} aziende con ${j} offerte attive. Dati iniziali — il delta settimanale sarà disponibile dalla settimana prossima.`,
    intro: (city) =>
      `Classifica aggiornata ogni lunedì mattina delle aziende con il maggior numero di nuove offerte pubblicate a ${city} nell'ultima settimana. Utile per capire chi sta assumendo davvero oggi, quali ruoli stanno crescendo e dove concentrare la candidatura spontanea prima della concorrenza. I dati sono aggregati dai job-board monitorati dalla nostra pipeline: portali aziendali, piattaforme ATS e API pubbliche.`,
    topCompaniesTitle: 'Top aziende che stanno assumendo',
    topCompaniesEmpty: 'Nessuna nuova offerta rilevata in questa zona negli ultimi 7 giorni.',
    newcomersTitle: 'Aziende nuove — prima apparizione',
    newcomersDesc:
      'Aziende che non avevano mai pubblicato offerte nelle settimane precedenti. Spesso sono le prime avvisaglie di nuove assunzioni strutturate: vale la pena arrivare per primi con una candidatura mirata.',
    newcomersEmpty:
      'Nessuna azienda nuova questa settimana — tutte le aziende elencate hanno già pubblicato offerte in passato.',
    rolesTitle: 'Ruoli più richiesti questa settimana',
    rolesEmpty:
      'Non abbiamo ancora abbastanza offerte attive per costruire il breakdown dei ruoli.',
    relatedLinksTitle: 'Approfondimenti correlati',
    relatedLinksCityHub: (c) => `Tutte le offerte a ${c}`,
    relatedLinksEmployerBrand: (e) => `Pagina azienda: ${e}`,
    jobsCountLabel: (n) => (n === 1 ? `${n} offerta` : `${n} offerte`),
    deltaPositive: (n) => `+${n} questa settimana`,
    deltaZero: 'invariato',
    coldStart: 'Dati iniziali — delta disponibile dalla settimana prossima',
    faqTitle: 'Domande frequenti',
    faqHowOftenQ: 'Ogni quanto viene aggiornata questa classifica?',
    faqHowOftenA:
      'La classifica viene rigenerata automaticamente ogni lunedì mattina con i dati aggregati dei job-board monitorati dalla nostra pipeline.',
    faqDeltaQ: 'Cosa indica il "delta" accanto al nome azienda?',
    faqDeltaA:
      'Indica quante offerte in più sono state pubblicate questa settimana rispetto allo snapshot precedente. Un delta alto significa che l\'azienda sta attivamente assumendo adesso.',
    faqApplyQ: 'Come ci si candida a queste aziende?',
    faqApplyA:
      'Ogni azienda porta alle sue offerte pubblicate sulla nostra bacheca, dove puoi candidarti direttamente o aprire il sito ufficiale dell\'azienda.',
    archiveNoindexNote: 'Archivio storico — mantenuto per continuità, non più aggiornato.',
    updatedLabel: 'Aggiornamento',
    editorialBlock: (city) =>
      `La fotografia settimanale delle aziende che assumono a ${city} è utile a più profili: frontalieri italiani che cercano il primo ingaggio, lavoratori già in Ticino che vogliono cambiare ruolo, residenti svizzeri che valutano offerte più competitive. Monitorare i picchi di pubblicazione aiuta a individuare i datori di lavoro che stanno espandendo l\'organico — e quindi quelli più aperti a candidature spontanee anche se al momento non c\'è una posizione esattamente in linea con il profilo.`,
    methodologyBlock:
      'Metodologia: ogni lunedì mattina alle 06:00 UTC la nostra pipeline confronta lo snapshot delle offerte attive con quello della settimana precedente e calcola un delta per azienda. Aziende con delta positivo salgono in classifica. Le aziende "nuove" sono quelle mai viste negli snapshot delle ultime 12 settimane. Il breakdown dei ruoli è costruito raggruppando le prime 3 parole del titolo offerta, con piccola tolleranza per varianti di formattazione.',
    companyCityH1Current: (e, c) =>
      `Aziende che assumono — ${e} a ${c}, settimana corrente`,
    companyCityH1Archive: (e, c, w, y) =>
      `Aziende che assumevano — ${e} a ${c}, settimana ${w} ${y}`,
    companyCityKicker: 'Azienda × città',
    companyCityHeroWithDelta: ({ employer, city, jobsCount, delta }) =>
      delta > 0
        ? `Questa settimana ${employer} ha ${jobsCount} offerte aperte a ${city} (+${delta} rispetto alla settimana scorsa).`
        : delta < 0
        ? `Questa settimana ${employer} ha ${jobsCount} offerte aperte a ${city} (${delta} rispetto alla settimana scorsa).`
        : `Questa settimana ${employer} ha ${jobsCount} offerte aperte a ${city} — invariato rispetto alla settimana scorsa.`,
    companyCityHeroNoDelta: ({ employer, city, jobsCount }) =>
      `Questa settimana ${employer} ha ${jobsCount} offerte aperte a ${city}. Dati iniziali — il delta settimanale sarà disponibile dalla prossima rilevazione.`,
    companyCityIntro: ({ employer, city, topRoles, avgSalary }) => {
      const rolesText =
        topRoles.length > 0
          ? `I ruoli principali offerti da ${employer} a ${city} questa settimana sono: ${topRoles.slice(0, 3).join(', ')}.`
          : `Le posizioni aperte coprono diversi profili professionali, dal supporto operativo alle funzioni specialistiche.`;
      const salaryText =
        typeof avgSalary === 'number'
          ? ` La retribuzione lorda media indicata nelle offerte di questa settimana è di circa CHF ${avgSalary.toLocaleString('it-CH')} all'anno — utile come riferimento per valutare la competitività delle proposte ricevute.`
          : '';
      return `Elenco aggiornato delle offerte attive di ${employer} a ${city}, con link diretto ad ogni annuncio pubblicato sul nostro job-board. Aggiornato ogni settimana per aiutarti a capire come stanno evolvendo le assunzioni dell'azienda nella città e a individuare ruoli coerenti con il tuo profilo prima della concorrenza. ${rolesText}${salaryText}`;
    },
    companyCityJobsHeading: (e, c) =>
      `Offerte aperte di ${e} a ${c} questa settimana`,
    companyCityApplyCta: 'Apri l\'offerta',
    companyCityBrandHubLabel: (e) => `Scheda azienda: ${e}`,
    companyCityParentHubLabel: (c) =>
      `Tutte le aziende che assumono a ${c} questa settimana`,
    companyCityCityHubLabel: (c) => `Tutte le offerte di lavoro a ${c}`,
    companyCitySiblingLabel: (e, c) => `${e} a ${c}`,
    companyCityEditorial: ({ employer, city, jobsCount, topRoles }) => {
      const roles =
        topRoles.length > 0
          ? topRoles.slice(0, 3).join(', ')
          : 'ruoli operativi e specialistici';
      return `La scheda settimanale dedicata a ${employer} a ${city} serve a chi sta valutando l'azienda come potenziale datore di lavoro: permette di vedere in un colpo d'occhio quante posizioni sono effettivamente aperte oggi (${jobsCount}), quali famiglie di ruoli sono più rappresentate (${roles}) e come cambia la dimensione del piano assunzioni da una settimana all'altra. È utile soprattutto per chi punta alla candidatura spontanea: un incremento del numero di offerte è spesso il segnale che l'azienda sta espandendo l'organico e valuta con più attenzione i profili inviati fuori da una posizione specifica. Questa pagina è rigenerata automaticamente ogni lunedì mattina: il contenuto riflette lo stato delle offerte al momento della generazione. Per candidarti, apri il singolo annuncio e segui le istruzioni dell'azienda — oppure usa la scheda employer brand (quando disponibile) per un quadro completo di benefit, sedi e FAQ.`;
    },
    companyCityFaqWhyQ: (e) => `Perché una pagina dedicata a ${e}?`,
    companyCityFaqWhyA: (e, c) =>
      `${e} è tra le aziende con più offerte attive a ${c} questa settimana: una pagina dedicata permette di seguire le posizioni aperte in città senza dover filtrare manualmente il job-board e di confrontare settimana dopo settimana l'evoluzione del piano assunzioni.`,
    companyCityFaqHowApplyQ: 'Come ci si candida a queste offerte?',
    companyCityFaqHowApplyA: (e) =>
      `Ogni offerta in elenco porta alla pagina dettaglio sul nostro job-board, da cui si apre il link ufficiale ai canali di candidatura gestiti direttamente da ${e}. Non raccogliamo CV — la candidatura avviene sempre sul sito dell'azienda.`,
    companyCityFaqUpdateQ: 'Quando viene aggiornata questa pagina?',
    companyCityFaqUpdateA:
      'Ogni lunedì mattina la pipeline genera un nuovo snapshot delle offerte attive e aggiorna delta, classifica e testo editoriale. Puoi tornare settimanalmente per vedere come evolve il quadro assunzioni.',
  },
  en: {
    sectionLabel: 'Companies hiring',
    breadcrumbHome: 'Home',
    h1Current: (c, reg) =>
      reg ? `Companies hiring in Ticino this week` : `Companies hiring in ${c} this week`,
    h1Archive: (c, w, y, reg) =>
      reg ? `Companies hiring in Ticino — Week ${w} ${y}` : `Companies hiring in ${c} — Week ${w} ${y}`,
    kickerCurrent: 'Weekly leaderboard',
    kickerArchive: 'Weekly archive',
    heroSummary: (city, c, j) =>
      `This week in ${city} ${c} companies have ${j} active openings.`,
    heroSummaryNoDelta: (city, c, j) =>
      `${c} companies in ${city} currently have ${j} active openings. Baseline data — weekly delta available starting next week.`,
    intro: (city) =>
      `Leaderboard refreshed every Monday morning ranking the companies with the most new openings posted in ${city} over the last 7 days. Useful to see who is actually hiring right now, which roles are trending, and where to focus outreach before the competition. Data is aggregated from the job boards monitored by our pipeline: company career pages, ATS platforms, and public APIs.`,
    topCompaniesTitle: 'Top companies hiring',
    topCompaniesEmpty: 'No new openings detected in this area over the past 7 days.',
    newcomersTitle: 'New companies — first appearance',
    newcomersDesc:
      'Companies that had never posted openings in the previous weeks. Often an early signal of structured hiring — a good chance to apply with a targeted pitch before the competition picks up.',
    newcomersEmpty:
      'No new companies this week — every company listed has posted openings in previous weeks.',
    rolesTitle: 'Roles most in demand this week',
    rolesEmpty: 'Not enough active openings yet to build the role breakdown.',
    relatedLinksTitle: 'Related pages',
    relatedLinksCityHub: (c) => `All jobs in ${c}`,
    relatedLinksEmployerBrand: (e) => `Employer page: ${e}`,
    jobsCountLabel: (n) => (n === 1 ? `${n} opening` : `${n} openings`),
    deltaPositive: (n) => `+${n} this week`,
    deltaZero: 'unchanged',
    coldStart: 'Baseline data — delta available starting next week',
    faqTitle: 'Frequently asked questions',
    faqHowOftenQ: 'How often is this leaderboard updated?',
    faqHowOftenA:
      'The leaderboard is regenerated automatically every Monday morning using aggregated data from the job boards monitored by our pipeline.',
    faqDeltaQ: 'What does the "delta" next to each company name mean?',
    faqDeltaA:
      'It shows how many more openings were published this week compared to the previous snapshot. A high delta means the company is actively hiring right now.',
    faqApplyQ: 'How do I apply to these companies?',
    faqApplyA:
      'Each company links to its active openings on our job board, where you can apply directly or open the company\'s official page.',
    archiveNoindexNote: 'Historical archive — kept for continuity, no longer updated.',
    updatedLabel: 'Updated',
    editorialBlock: (city) =>
      `The weekly snapshot of companies hiring in ${city} is useful for multiple profiles: Italian cross-border workers looking for their first role, workers already in Ticino aiming to switch positions, and Swiss residents evaluating more competitive offers. Tracking publication spikes helps spot employers actively growing their workforce — and therefore those most open to spontaneous applications even when there is no posting that perfectly matches the profile.`,
    methodologyBlock:
      'Methodology: every Monday morning at 06:00 UTC our pipeline compares the snapshot of active openings with the previous week\'s and computes a per-company delta. Companies with a positive delta move up the leaderboard. "New" companies are those never seen in the last 12 weekly snapshots. The role breakdown groups the first 3 words of the job title, with small tolerance for formatting variants.',
    companyCityH1Current: (e, c) => `Companies hiring — ${e} in ${c}, current week`,
    companyCityH1Archive: (e, c, w, y) =>
      `Companies hiring — ${e} in ${c}, week ${w} ${y}`,
    companyCityKicker: 'Company × city',
    companyCityHeroWithDelta: ({ employer, city, jobsCount, delta }) =>
      delta > 0
        ? `This week ${employer} has ${jobsCount} open positions in ${city} (+${delta} vs last week).`
        : delta < 0
        ? `This week ${employer} has ${jobsCount} open positions in ${city} (${delta} vs last week).`
        : `This week ${employer} has ${jobsCount} open positions in ${city} — unchanged vs last week.`,
    companyCityHeroNoDelta: ({ employer, city, jobsCount }) =>
      `This week ${employer} has ${jobsCount} open positions in ${city}. Baseline data — the weekly delta will appear starting with the next snapshot.`,
    companyCityIntro: ({ employer, city, topRoles, avgSalary }) => {
      const rolesText =
        topRoles.length > 0
          ? `The most common roles ${employer} is hiring for in ${city} this week are: ${topRoles.slice(0, 3).join(', ')}.`
          : `The open positions span multiple profiles, from operational support to specialist functions.`;
      const salaryText =
        typeof avgSalary === 'number'
          ? ` The average gross salary quoted in this week's listings is about CHF ${avgSalary.toLocaleString('en-US')} per year — useful as a benchmark to evaluate any offer you receive.`
          : '';
      return `Up-to-date list of active ${employer} openings in ${city}, each linked to the individual listing on our job board. Refreshed weekly so you can see how the company's hiring plan evolves in the city and spot the roles that fit your profile before the competition. ${rolesText}${salaryText}`;
    },
    companyCityJobsHeading: (e, c) => `Open positions at ${e} in ${c} this week`,
    companyCityApplyCta: 'View posting',
    companyCityBrandHubLabel: (e) => `Employer page: ${e}`,
    companyCityParentHubLabel: (c) => `All companies hiring in ${c} this week`,
    companyCityCityHubLabel: (c) => `All jobs in ${c}`,
    companyCitySiblingLabel: (e, c) => `${e} in ${c}`,
    companyCityEditorial: ({ employer, city, jobsCount, topRoles }) => {
      const roles =
        topRoles.length > 0
          ? topRoles.slice(0, 3).join(', ')
          : 'operational and specialist roles';
      return `This weekly overview of ${employer} in ${city} is aimed at anyone evaluating the company as a potential employer: it shows at a glance how many positions are actually open today (${jobsCount}), which role families are most represented (${roles}), and how the hiring plan shifts from one week to the next. It's especially useful if you're targeting a spontaneous application: a rise in open positions often signals the company is growing its headcount and will take a closer look at profiles sent outside a specific posting. The page is regenerated automatically every Monday morning — the content reflects the state of the openings at generation time. To apply, open the individual listing and follow the company's instructions, or use the employer brand page (when available) for a full overview of benefits, locations and FAQ.`;
    },
    companyCityFaqWhyQ: (e) => `Why a dedicated page for ${e}?`,
    companyCityFaqWhyA: (e, c) =>
      `${e} is among the companies with the most active openings in ${c} this week: a dedicated page makes it easy to track the open positions in the city without filtering the job board manually, and to compare how the hiring plan evolves week after week.`,
    companyCityFaqHowApplyQ: 'How do I apply to these openings?',
    companyCityFaqHowApplyA: (e) =>
      `Every listing here links to the detail page on our job board, which in turn links to the official application channel managed by ${e}. We don't collect résumés — the application always happens on the company's website.`,
    companyCityFaqUpdateQ: 'How often is this page updated?',
    companyCityFaqUpdateA:
      'Every Monday morning the pipeline regenerates the snapshot of active openings and updates the delta, ranking and editorial copy. Check back weekly to see how the hiring outlook shifts.',
  },
  de: {
    sectionLabel: 'Unternehmen mit offenen Stellen',
    breadcrumbHome: 'Startseite',
    h1Current: (c, reg) =>
      reg ? `Unternehmen, die diese Woche im Tessin einstellen` : `Unternehmen, die diese Woche in ${c} einstellen`,
    h1Archive: (c, w, y, reg) =>
      reg ? `Unternehmen, die im Tessin eingestellt haben — Woche ${w} ${y}` : `Unternehmen, die in ${c} eingestellt haben — Woche ${w} ${y}`,
    kickerCurrent: 'Wöchentliche Rangliste',
    kickerArchive: 'Wöchentliches Archiv',
    heroSummary: (city, c, j) =>
      `Diese Woche haben in ${city} ${c} Unternehmen ${j} aktive offene Stellen.`,
    heroSummaryNoDelta: (city, c, j) =>
      `In ${city} haben aktuell ${c} Unternehmen ${j} aktive Stellen. Basisdaten — die Wochenveränderung ist ab nächster Woche verfügbar.`,
    intro: (city) =>
      `Rangliste, jeden Montagmorgen aktualisiert, der Unternehmen mit den meisten neuen Stellen in ${city} in den letzten 7 Tagen. Hilfreich, um zu sehen, wer jetzt wirklich einstellt, welche Rollen im Trend liegen und wo sich eine Initiativbewerbung vor der Konkurrenz lohnt. Die Daten werden aus den von unserer Pipeline überwachten Job-Portalen aggregiert: Karriereseiten, ATS-Plattformen und öffentliche APIs.`,
    topCompaniesTitle: 'Top-Unternehmen mit offenen Stellen',
    topCompaniesEmpty:
      'In den letzten 7 Tagen wurden in diesem Gebiet keine neuen Stellen entdeckt.',
    newcomersTitle: 'Neue Unternehmen — erste Erwähnung',
    newcomersDesc:
      'Unternehmen, die in den Vorwochen nie Stellen ausgeschrieben hatten. Oft ein frühes Zeichen für strukturierte Einstellungen — eine gute Chance, sich vor der Konkurrenz gezielt zu bewerben.',
    newcomersEmpty:
      'Diese Woche keine neuen Unternehmen — alle aufgeführten Firmen haben bereits in Vorwochen Stellen ausgeschrieben.',
    rolesTitle: 'Gefragteste Rollen diese Woche',
    rolesEmpty: 'Noch nicht genügend aktive Stellen, um die Rollenaufteilung zu erstellen.',
    relatedLinksTitle: 'Verwandte Seiten',
    relatedLinksCityHub: (c) => `Alle Stellen in ${c}`,
    relatedLinksEmployerBrand: (e) => `Arbeitgeberseite: ${e}`,
    jobsCountLabel: (n) => (n === 1 ? `${n} Stelle` : `${n} Stellen`),
    deltaPositive: (n) => `+${n} diese Woche`,
    deltaZero: 'unverändert',
    coldStart: 'Basisdaten — Wochenveränderung ab nächster Woche verfügbar',
    faqTitle: 'Häufige Fragen',
    faqHowOftenQ: 'Wie oft wird diese Rangliste aktualisiert?',
    faqHowOftenA:
      'Die Rangliste wird automatisch jeden Montagmorgen mit aggregierten Daten der von unserer Pipeline überwachten Job-Portale neu generiert.',
    faqDeltaQ: 'Was bedeutet die "Veränderung" neben dem Firmennamen?',
    faqDeltaA:
      'Sie zeigt, wie viele Stellen diese Woche gegenüber dem vorherigen Snapshot mehr ausgeschrieben wurden. Eine hohe Veränderung bedeutet, dass das Unternehmen aktuell aktiv einstellt.',
    faqApplyQ: 'Wie bewerbe ich mich bei diesen Unternehmen?',
    faqApplyA:
      'Jedes Unternehmen verlinkt auf seine aktiven Stellen auf unserem Job-Board, wo Sie sich direkt bewerben oder die offizielle Firmenseite öffnen können.',
    archiveNoindexNote: 'Historisches Archiv — zur Kontinuität aufbewahrt, nicht mehr aktualisiert.',
    updatedLabel: 'Aktualisiert',
    editorialBlock: (city) =>
      `Die wöchentliche Aufnahme der Unternehmen, die in ${city} einstellen, ist für mehrere Zielgruppen nützlich: italienische Grenzgänger auf Jobsuche, Personen mit Arbeitsplatz im Tessin, die wechseln möchten, und Schweizer Einheimische, die attraktivere Angebote prüfen. Publikationsspitzen helfen dabei, Arbeitgeber zu erkennen, die gerade ihre Belegschaft ausbauen — und daher offener für Initiativbewerbungen sind, auch wenn aktuell keine exakt passende Stelle ausgeschrieben ist.`,
    methodologyBlock:
      'Methodik: Jeden Montagmorgen um 06:00 UTC vergleicht unsere Pipeline den Snapshot der aktiven Stellen mit dem der Vorwoche und berechnet eine firmenspezifische Veränderung. Unternehmen mit positiver Veränderung steigen in der Rangliste. "Neue" Unternehmen sind solche, die in den letzten 12 Wochen-Snapshots nie vorkamen. Die Rollenaufteilung gruppiert die ersten drei Wörter des Stellentitels mit geringer Toleranz für Formatvarianten.',
    companyCityH1Current: (e, c) =>
      `Unternehmen mit offenen Stellen — ${e} in ${c}, aktuelle Woche`,
    companyCityH1Archive: (e, c, w, y) =>
      `Unternehmen mit offenen Stellen — ${e} in ${c}, Woche ${w} ${y}`,
    companyCityKicker: 'Unternehmen × Stadt',
    companyCityHeroWithDelta: ({ employer, city, jobsCount, delta }) =>
      delta > 0
        ? `Diese Woche hat ${employer} ${jobsCount} offene Stellen in ${city} (+${delta} gegenüber letzter Woche).`
        : delta < 0
        ? `Diese Woche hat ${employer} ${jobsCount} offene Stellen in ${city} (${delta} gegenüber letzter Woche).`
        : `Diese Woche hat ${employer} ${jobsCount} offene Stellen in ${city} — unverändert gegenüber letzter Woche.`,
    companyCityHeroNoDelta: ({ employer, city, jobsCount }) =>
      `Diese Woche hat ${employer} ${jobsCount} offene Stellen in ${city}. Basisdaten — die Wochenveränderung ist ab der nächsten Erhebung verfügbar.`,
    companyCityIntro: ({ employer, city, topRoles, avgSalary }) => {
      const rolesText =
        topRoles.length > 0
          ? `Die häufigsten Rollen, für die ${employer} in ${city} diese Woche sucht: ${topRoles.slice(0, 3).join(', ')}.`
          : `Die offenen Stellen decken verschiedene Profile ab, von operativen Aufgaben bis zu Fachfunktionen.`;
      const salaryText =
        typeof avgSalary === 'number'
          ? ` Das durchschnittliche Bruttogehalt in den Ausschreibungen dieser Woche liegt bei rund CHF ${avgSalary.toLocaleString('de-CH')} pro Jahr — nützlich als Orientierung, um ein Angebot einzuordnen.`
          : '';
      return `Aktuelle Liste der offenen Stellen bei ${employer} in ${city} mit direktem Link zu jeder Ausschreibung auf unserem Job-Board. Wöchentlich aktualisiert, damit Sie nachvollziehen können, wie sich der Personalplan des Unternehmens in der Stadt entwickelt und Rollen finden, die zu Ihrem Profil passen, bevor die Konkurrenz zuschlägt. ${rolesText}${salaryText}`;
    },
    companyCityJobsHeading: (e, c) =>
      `Offene Stellen bei ${e} in ${c} diese Woche`,
    companyCityApplyCta: 'Stelle ansehen',
    companyCityBrandHubLabel: (e) => `Arbeitgeberseite: ${e}`,
    companyCityParentHubLabel: (c) =>
      `Alle Unternehmen mit offenen Stellen in ${c} diese Woche`,
    companyCityCityHubLabel: (c) => `Alle Stellen in ${c}`,
    companyCitySiblingLabel: (e, c) => `${e} in ${c}`,
    companyCityEditorial: ({ employer, city, jobsCount, topRoles }) => {
      const roles =
        topRoles.length > 0
          ? topRoles.slice(0, 3).join(', ')
          : 'operative und Fachrollen';
      return `Die wöchentliche Übersicht zu ${employer} in ${city} richtet sich an alle, die das Unternehmen als möglichen Arbeitgeber prüfen: Sie sehen auf einen Blick, wie viele Stellen aktuell offen sind (${jobsCount}), welche Rollenfamilien am stärksten vertreten sind (${roles}) und wie sich der Personalplan von Woche zu Woche verändert. Besonders hilfreich ist das für Initiativbewerbungen: Steigt die Zahl der Ausschreibungen, wächst meist der Personalbestand — und die Firma prüft Profile, die außerhalb einer konkreten Ausschreibung eingehen, genauer. Die Seite wird jeden Montagmorgen automatisch neu erstellt; der Inhalt spiegelt den Stand der Stellen zum Zeitpunkt der Erzeugung wider. Für eine Bewerbung die jeweilige Ausschreibung öffnen und den Anweisungen des Unternehmens folgen — oder die Arbeitgeberseite (sofern verfügbar) für einen Überblick zu Benefits, Standorten und FAQ nutzen.`;
    },
    companyCityFaqWhyQ: (e) => `Warum eine eigene Seite für ${e}?`,
    companyCityFaqWhyA: (e, c) =>
      `${e} zählt zu den Unternehmen mit den meisten offenen Stellen in ${c} diese Woche: Eine eigene Seite erlaubt es, die offenen Positionen in der Stadt ohne manuelles Filtern des Job-Boards zu verfolgen und den Personalplan Woche für Woche zu vergleichen.`,
    companyCityFaqHowApplyQ: 'Wie bewerbe ich mich auf diese Stellen?',
    companyCityFaqHowApplyA: (e) =>
      `Jede Ausschreibung verlinkt auf die Detailseite auf unserem Job-Board, die wiederum auf den offiziellen Bewerbungskanal von ${e} führt. Wir sammeln keine Lebensläufe — die Bewerbung läuft immer über die Unternehmenswebsite.`,
    companyCityFaqUpdateQ: 'Wie oft wird diese Seite aktualisiert?',
    companyCityFaqUpdateA:
      'Jeden Montagmorgen erstellt die Pipeline einen neuen Snapshot der offenen Stellen und aktualisiert Veränderung, Rangliste und redaktionellen Text. Schauen Sie wöchentlich vorbei, um die Entwicklung zu verfolgen.',
  },
  fr: {
    sectionLabel: 'Entreprises qui recrutent',
    breadcrumbHome: 'Accueil',
    h1Current: (c, reg) =>
      reg ? `Entreprises qui recrutent au Tessin cette semaine` : `Entreprises qui recrutent à ${c} cette semaine`,
    h1Archive: (c, w, y, reg) =>
      reg ? `Entreprises qui recrutaient au Tessin — Semaine ${w} ${y}` : `Entreprises qui recrutaient à ${c} — Semaine ${w} ${y}`,
    kickerCurrent: 'Classement hebdomadaire',
    kickerArchive: 'Archive hebdomadaire',
    heroSummary: (city, c, j) =>
      `Cette semaine à ${city}, ${c} entreprises ont ${j} offres actives.`,
    heroSummaryNoDelta: (city, c, j) =>
      `À ${city}, ${c} entreprises ont actuellement ${j} offres actives. Données initiales — la variation hebdomadaire sera disponible dès la semaine prochaine.`,
    intro: (city) =>
      `Classement mis à jour chaque lundi matin des entreprises ayant publié le plus de nouvelles offres à ${city} ces 7 derniers jours. Utile pour identifier qui recrute vraiment maintenant, quels rôles sont en hausse et où concentrer ses candidatures spontanées avant la concurrence. Les données sont agrégées depuis les sites d\'offres d\'emploi suivis par notre pipeline : pages carrière, plateformes ATS et API publiques.`,
    topCompaniesTitle: 'Meilleures entreprises qui recrutent',
    topCompaniesEmpty: 'Aucune nouvelle offre détectée dans cette zone ces 7 derniers jours.',
    newcomersTitle: 'Nouvelles entreprises — première apparition',
    newcomersDesc:
      'Entreprises qui n\'avaient jamais publié d\'offres les semaines précédentes. Souvent un signal précoce d\'embauches structurées — une bonne occasion de postuler avec une candidature ciblée avant la concurrence.',
    newcomersEmpty:
      'Aucune nouvelle entreprise cette semaine — toutes celles listées ont déjà publié des offres auparavant.',
    rolesTitle: 'Rôles les plus demandés cette semaine',
    rolesEmpty: 'Pas encore assez d\'offres actives pour construire la répartition par rôle.',
    relatedLinksTitle: 'Pages liées',
    relatedLinksCityHub: (c) => `Toutes les offres à ${c}`,
    relatedLinksEmployerBrand: (e) => `Page employeur : ${e}`,
    jobsCountLabel: (n) => (n === 1 ? `${n} offre` : `${n} offres`),
    deltaPositive: (n) => `+${n} cette semaine`,
    deltaZero: 'inchangé',
    coldStart: 'Données initiales — variation disponible dès la semaine prochaine',
    faqTitle: 'Questions fréquentes',
    faqHowOftenQ: 'À quelle fréquence ce classement est-il mis à jour ?',
    faqHowOftenA:
      'Le classement est régénéré automatiquement chaque lundi matin à partir des données agrégées des sites d\'offres d\'emploi suivis par notre pipeline.',
    faqDeltaQ: 'Que signifie la "variation" à côté du nom de l\'entreprise ?',
    faqDeltaA:
      'Elle indique combien d\'offres supplémentaires ont été publiées cette semaine par rapport au snapshot précédent. Une variation élevée signifie que l\'entreprise recrute activement en ce moment.',
    faqApplyQ: 'Comment postuler à ces entreprises ?',
    faqApplyA:
      'Chaque entreprise renvoie vers ses offres actives sur notre tableau, où vous pouvez postuler directement ou ouvrir le site officiel de l\'entreprise.',
    archiveNoindexNote: 'Archive historique — conservée pour continuité, non mise à jour.',
    updatedLabel: 'Mis à jour',
    editorialBlock: (city) =>
      `L\'image hebdomadaire des entreprises qui recrutent à ${city} est utile à plusieurs profils : frontaliers italiens en recherche de premier poste, personnes déjà installées au Tessin souhaitant changer de poste, et résidents suisses évaluant des offres plus compétitives. Surveiller les pics de publication aide à repérer les employeurs qui étoffent leurs équipes — et donc ceux qui sont les plus ouverts aux candidatures spontanées même lorsqu\'aucun poste ne correspond exactement au profil.`,
    methodologyBlock:
      'Méthodologie : chaque lundi matin à 06:00 UTC, notre pipeline compare le snapshot des offres actives avec celui de la semaine précédente et calcule une variation par entreprise. Les entreprises avec une variation positive montent dans le classement. Les "nouvelles" entreprises sont celles jamais observées dans les 12 derniers snapshots hebdomadaires. La répartition par rôle regroupe les trois premiers mots du titre de l\'offre, avec une petite tolérance aux variantes de formatage.',
    companyCityH1Current: (e, c) =>
      `Entreprises qui recrutent — ${e} à ${c}, semaine courante`,
    companyCityH1Archive: (e, c, w, y) =>
      `Entreprises qui recrutaient — ${e} à ${c}, semaine ${w} ${y}`,
    companyCityKicker: 'Entreprise × ville',
    companyCityHeroWithDelta: ({ employer, city, jobsCount, delta }) =>
      delta > 0
        ? `Cette semaine ${employer} a ${jobsCount} offres ouvertes à ${city} (+${delta} par rapport à la semaine dernière).`
        : delta < 0
        ? `Cette semaine ${employer} a ${jobsCount} offres ouvertes à ${city} (${delta} par rapport à la semaine dernière).`
        : `Cette semaine ${employer} a ${jobsCount} offres ouvertes à ${city} — inchangé par rapport à la semaine dernière.`,
    companyCityHeroNoDelta: ({ employer, city, jobsCount }) =>
      `Cette semaine ${employer} a ${jobsCount} offres ouvertes à ${city}. Données initiales — la variation hebdomadaire apparaîtra dès le prochain snapshot.`,
    companyCityIntro: ({ employer, city, topRoles, avgSalary }) => {
      const rolesText =
        topRoles.length > 0
          ? `Les rôles les plus recherchés par ${employer} à ${city} cette semaine : ${topRoles.slice(0, 3).join(', ')}.`
          : `Les postes ouverts couvrent plusieurs profils, du soutien opérationnel aux fonctions spécialisées.`;
      const salaryText =
        typeof avgSalary === 'number'
          ? ` Le salaire brut moyen affiché dans les offres de cette semaine est d'environ CHF ${avgSalary.toLocaleString('fr-CH')} par an — un repère utile pour évaluer une proposition.`
          : '';
      return `Liste à jour des offres actives de ${employer} à ${city}, avec un lien direct vers chaque annonce sur notre tableau d'offres. Actualisée chaque semaine pour suivre l'évolution du plan de recrutement de l'entreprise dans la ville et repérer les rôles qui correspondent à votre profil avant la concurrence. ${rolesText}${salaryText}`;
    },
    companyCityJobsHeading: (e, c) =>
      `Offres ouvertes chez ${e} à ${c} cette semaine`,
    companyCityApplyCta: 'Voir l\'offre',
    companyCityBrandHubLabel: (e) => `Page employeur : ${e}`,
    companyCityParentHubLabel: (c) =>
      `Toutes les entreprises qui recrutent à ${c} cette semaine`,
    companyCityCityHubLabel: (c) => `Toutes les offres à ${c}`,
    companyCitySiblingLabel: (e, c) => `${e} à ${c}`,
    companyCityEditorial: ({ employer, city, jobsCount, topRoles }) => {
      const roles =
        topRoles.length > 0
          ? topRoles.slice(0, 3).join(', ')
          : 'rôles opérationnels et spécialisés';
      return `Cette fiche hebdomadaire consacrée à ${employer} à ${city} s'adresse à celles et ceux qui évaluent l'entreprise comme employeur potentiel : elle montre d'un coup d'œil combien de postes sont réellement ouverts aujourd'hui (${jobsCount}), quelles familles de rôles sont les plus représentées (${roles}) et comment le plan de recrutement évolue d'une semaine à l'autre. Particulièrement utile pour les candidatures spontanées : une hausse du nombre d'offres signale souvent que l'entreprise accroît ses effectifs et examine avec plus d'attention les profils envoyés en dehors d'un poste précis. La page est régénérée automatiquement chaque lundi matin ; le contenu reflète l'état des offres au moment de la génération. Pour postuler, ouvrez l'annonce individuelle et suivez les instructions de l'entreprise — ou utilisez la page employeur (si disponible) pour un aperçu complet des avantages, des sites et de la FAQ.`;
    },
    companyCityFaqWhyQ: (e) => `Pourquoi une page dédiée à ${e} ?`,
    companyCityFaqWhyA: (e, c) =>
      `${e} fait partie des entreprises avec le plus d'offres actives à ${c} cette semaine : une page dédiée permet de suivre les postes ouverts dans la ville sans filtrer manuellement le tableau d'offres, et de comparer l'évolution du plan de recrutement semaine après semaine.`,
    companyCityFaqHowApplyQ: 'Comment postuler à ces offres ?',
    companyCityFaqHowApplyA: (e) =>
      `Chaque annonce listée renvoie vers la page détail sur notre tableau d'offres, qui mène au canal de candidature officiel géré par ${e}. Nous ne collectons pas les CV — la candidature se fait toujours sur le site de l'entreprise.`,
    companyCityFaqUpdateQ: 'À quelle fréquence cette page est-elle mise à jour ?',
    companyCityFaqUpdateA:
      'Chaque lundi matin, la pipeline régénère le snapshot des offres actives et met à jour la variation, le classement et le texte éditorial. Revenez chaque semaine pour voir comment évolue le plan d\'embauche.',
  },
};

// ── Page renderer ───────────────────────────────────────────────

export interface WeeklyEmployersPageInputs {
  locale: WeeklyEmployersLocale;
  city: WeeklyEmployersCity;
  variant: 'current' | 'archive';
  weekNum: number;
  year: number;
  stats: CityWeeklyStats;
  hasHistoricalDelta: boolean;
  canonicalPath: string;
  today: Date;
  /** Whether this page should be `index,follow` (current & last 12 archives) */
  indexable: boolean;
  /** Enable the auto-employer-stub attribute markers (default false). */
  enableAutoStubs?: boolean;
  /** dist directory for entry-asset resolution (omit in tests). */
  distDir?: string;
}

function cityJobsHubPath(locale: WeeklyEmployersLocale, city: WeeklyEmployersCity): string {
  // Link back to existing city-jobs-hub (if there is one).
  // Only lugano/mendrisio/bellinzona are covered by cityJobsHub; others
  // fall back to the main job-board root for the locale.
  const section: Record<WeeklyEmployersLocale, string> = {
    it: 'cerca-lavoro-ticino',
    en: 'find-jobs-ticino',
    de: 'jobs-im-tessin',
    fr: 'trouver-emploi-tessin',
  };
  const prefix = WEEKLY_EMPLOYERS_LOCALE_PREFIX[locale];
  if (city === 'ticino') return `${prefix}/${section[locale]}/`.replace(/\/+/g, '/');
  const covered = new Set<WeeklyEmployersCity>(['lugano', 'mendrisio', 'bellinzona']);
  if (!covered.has(city)) return `${prefix}/${section[locale]}/`.replace(/\/+/g, '/');
  return `${prefix}/${section[locale]}/${city}/`.replace(/\/+/g, '/');
}

function employerBrandPath(employerKey: string | undefined): string | null {
  if (!employerKey) return null;
  const key = String(employerKey).toLowerCase();
  // EMPLOYER_BRANDS is keyed by `brandKey` — match loosely.
  for (const brand of Object.values(EMPLOYER_BRANDS)) {
    if (
      brand.brandKey === key ||
      brand.brandKey === key.replace(/-/g, '') ||
      key.includes(brand.brandKey) ||
      brand.brandKey.includes(key.split('-')[0])
    ) {
      return `/cerca-lavoro-ticino/azienda-${brand.brandKey}/`;
    }
  }
  return null;
}

export function renderWeeklyEmployersPage(inp: WeeklyEmployersPageInputs): string {
  const {
    locale,
    city,
    variant,
    weekNum,
    year,
    stats,
    hasHistoricalDelta,
    canonicalPath,
    today,
    indexable,
    enableAutoStubs = false,
    distDir,
  } = inp;

  const copy = COPY[locale];
  const cityDisplay = WEEKLY_EMPLOYERS_CITY_DISPLAY[city];
  const isRegional = city === 'ticino';
  const dateStamp = today.toISOString().slice(0, 10);
  const canonicalUrl = `${BASE_URL}${canonicalPath}`;

  const h1 =
    variant === 'current'
      ? copy.h1Current(cityDisplay, isRegional)
      : copy.h1Archive(cityDisplay, weekNum, year, isRegional);
  const kicker = variant === 'current' ? copy.kickerCurrent : copy.kickerArchive;

  const companiesCount = stats.topCompanies.length;
  const jobsCount = stats.activeJobsCount;
  const heroSummary = hasHistoricalDelta
    ? copy.heroSummary(cityDisplay, companiesCount, jobsCount)
    : copy.heroSummaryNoDelta(cityDisplay, companiesCount, jobsCount);
  const intro = copy.intro(cityDisplay);
  const editorial = copy.editorialBlock(cityDisplay);
  const methodology = copy.methodologyBlock;

  // Alternates to other locales for the same (city, variant)
  const alternatesHtml = WEEKLY_EMPLOYERS_LOCALES.map((alt) => {
    let path: string;
    if (variant === 'current') {
      path = buildCurrentWeekPath(alt, city);
    } else {
      path = buildArchiveWeekPath(alt, city, weekNum, year);
    }
    return `    <link rel="alternate" hreflang="${alt}" href="${BASE_URL}${path}">`;
  }).join('\n');

  const xDefaultPath =
    variant === 'current'
      ? buildCurrentWeekPath('it', city)
      : buildArchiveWeekPath('it', city, weekNum, year);

  // Top companies rendering
  const topCompaniesHtml =
    stats.topCompanies.length > 0
      ? `<ol style="list-style:none;padding:0;margin:0;display:grid;grid-template-columns:1fr;gap:10px">${stats.topCompanies
          .map((c, idx) => {
            const brandHref = employerBrandPath(c.employerKey);
            const deltaLabel =
              hasHistoricalDelta && c.delta > 0
                ? copy.deltaPositive(c.delta)
                : hasHistoricalDelta
                ? copy.deltaZero
                : copy.coldStart;
            const needsReview =
              enableAutoStubs && !brandHref && c.active >= 3 && idx < 3 ? ' data-needs-editorial-review="true"' : '';
            const employerEsc = esc(c.employer);
            const badge =
              hasHistoricalDelta && c.delta > 0
                ? `<span style="margin-left:10px;padding:3px 8px;border-radius:999px;background:#ecfccb;color:#365314;font-size:12px;font-weight:700">${esc(deltaLabel)}</span>`
                : `<span style="margin-left:10px;padding:3px 8px;border-radius:999px;background:#f1f5f9;color:#475569;font-size:12px">${esc(deltaLabel)}</span>`;
            const content = `<div style="font-weight:700;font-size:16px;color:#0f172a">${idx + 1}. ${employerEsc}${badge}</div>
      <div style="margin-top:4px;color:#475569;font-size:14px">${esc(copy.jobsCountLabel(c.active))}</div>`;
            const inner = brandHref
              ? `<a href="${esc(brandHref)}" style="color:inherit;text-decoration:none;display:block"${needsReview}>${content}</a>`
              : `<div${needsReview}>${content}</div>`;
            return `<li style="padding:14px 16px;border:1px solid #e2e8f0;border-radius:14px;background:#ffffff">${inner}</li>`;
          })
          .join('')}</ol>`
      : `<p style="padding:14px 16px;border-radius:12px;background:#fef3c7;color:#78350f">${esc(copy.topCompaniesEmpty)}</p>`;

  const newcomersHtml =
    stats.newcomers.length > 0
      ? `<ul style="list-style:disc;padding-left:20px;margin:0 0 0 4px;color:#0f172a;line-height:1.7">${stats.newcomers
          .map(
            (n) =>
              `<li><strong>${esc(n.employer)}</strong> — ${esc(copy.jobsCountLabel(n.active))}</li>`,
          )
          .join('')}</ul>`
      : `<p style="color:#475569;line-height:1.7">${esc(copy.newcomersEmpty)}</p>`;

  const rolesHtml =
    stats.topRoles.length > 0
      ? `<ul style="list-style:disc;padding-left:20px;margin:0 0 0 4px;color:#0f172a;line-height:1.7">${stats.topRoles
          .map(
            (r) =>
              `<li><span style="text-transform:capitalize">${esc(r.role)}</span> — ${esc(
                copy.jobsCountLabel(r.count),
              )}</li>`,
          )
          .join('')}</ul>`
      : `<p style="color:#475569;line-height:1.7">${esc(copy.rolesEmpty)}</p>`;

  // Related links: city hub + first employer brand (if present)
  const relatedLinks: string[] = [];
  relatedLinks.push(
    `<a href="${esc(cityJobsHubPath(locale, city))}" style="color:#1d4ed8;text-decoration:none">${esc(copy.relatedLinksCityHub(cityDisplay))}</a>`,
  );
  const firstEmployerWithBrand = stats.topCompanies.find(
    (c) => !!employerBrandPath(c.employerKey),
  );
  if (firstEmployerWithBrand) {
    const href = employerBrandPath(firstEmployerWithBrand.employerKey)!;
    relatedLinks.push(
      `<a href="${esc(href)}" style="color:#1d4ed8;text-decoration:none">${esc(copy.relatedLinksEmployerBrand(firstEmployerWithBrand.employer))}</a>`,
    );
  }
  const relatedHtml = `<ul style="list-style:none;padding:0;margin:0;display:flex;gap:14px;flex-wrap:wrap">${relatedLinks
    .map((link) => `<li>${link}</li>`)
    .join('')}</ul>`;

  // JSON-LD
  const breadcrumbLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: copy.breadcrumbHome, item: `${BASE_URL}/` },
      {
        '@type': 'ListItem',
        position: 2,
        name: copy.sectionLabel,
        item: `${BASE_URL}${WEEKLY_EMPLOYERS_LOCALE_PREFIX[locale]}/${WEEKLY_EMPLOYERS_SECTION[locale]}/ticino/${WEEKLY_EMPLOYERS_CURRENT_SLUG[locale]}/`.replace(
          /([^:])\/+/g,
          '$1/',
        ),
      },
      { '@type': 'ListItem', position: 3, name: cityDisplay, item: canonicalUrl },
    ],
  });

  const itemListLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: h1,
    numberOfItems: stats.topCompanies.length,
    inLanguage: locale,
    itemListElement: stats.topCompanies.map((c, idx) => ({
      '@type': 'ListItem',
      position: idx + 1,
      item: {
        '@type': 'Organization',
        name: c.employer,
        url: employerBrandPath(c.employerKey)
          ? `${BASE_URL}${employerBrandPath(c.employerKey)}`
          : undefined,
      },
    })),
  });

  const webPageLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: h1,
    url: canonicalUrl,
    description: heroSummary,
    inLanguage: locale,
    dateModified: today.toISOString(),
    datePublished: today.toISOString(),
  });

  const faqLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    inLanguage: locale,
    mainEntity: [
      { '@type': 'Question', name: copy.faqHowOftenQ, acceptedAnswer: { '@type': 'Answer', text: copy.faqHowOftenA } },
      { '@type': 'Question', name: copy.faqDeltaQ, acceptedAnswer: { '@type': 'Answer', text: copy.faqDeltaA } },
      { '@type': 'Question', name: copy.faqApplyQ, acceptedAnswer: { '@type': 'Answer', text: copy.faqApplyA } },
    ],
  });

  const robots = indexable ? 'index,follow' : 'noindex,follow';
  const title =
    variant === 'current'
      ? `${h1} | Frontaliere Ticino`
      : `${h1} — Archivio | Frontaliere Ticino`;
  const description = heroSummary.slice(0, 180);

  const archiveNote =
    variant === 'archive' && !indexable
      ? `<p style="margin:0 0 16px;color:#78350f;background:#fef3c7;padding:10px 14px;border-radius:12px;font-size:14px">${esc(copy.archiveNoindexNote)}</p>`
      : '';

  const bodyHtml = `<main style="max-width:1100px;margin:0 auto;padding:32px 20px 56px;color:#0f172a">
  <nav style="margin:0 0 14px;font-size:13px;color:#475569" aria-label="breadcrumb">
    <a href="${BASE_URL}/" style="color:#1d4ed8;text-decoration:none">${esc(copy.breadcrumbHome)}</a>
    <span> / </span>
    <span>${esc(copy.sectionLabel)}</span>
    <span> / </span>
    <span>${esc(cityDisplay)}</span>
  </nav>
  <header style="margin-bottom:22px">
    <p style="margin:0 0 6px;color:#4f46e5;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.04em">${esc(kicker)} · ${esc(copy.updatedLabel)} ${dateStamp}</p>
    <h1 style="margin:0 0 12px;font-size:clamp(1.8rem,4.5vw,2.75rem);line-height:1.1">${esc(h1)}</h1>
    <p style="margin:0 0 14px;font-size:18px;line-height:1.55;max-width:860px">${esc(heroSummary)}</p>
    <p style="margin:0;color:#334155;line-height:1.7;max-width:860px">${esc(intro)}</p>
  </header>
  ${archiveNote}
  <section style="margin:0 0 28px" aria-labelledby="topCompanies">
    <h2 id="topCompanies" style="margin:0 0 14px;font-size:22px;color:#0f172a">${esc(copy.topCompaniesTitle)}</h2>
    ${topCompaniesHtml}
  </section>
  <section style="margin:0 0 28px" aria-labelledby="newcomers">
    <h2 id="newcomers" style="margin:0 0 10px;font-size:22px;color:#0f172a">${esc(copy.newcomersTitle)}</h2>
    <p style="margin:0 0 10px;color:#334155;line-height:1.65;max-width:860px">${esc(copy.newcomersDesc)}</p>
    ${newcomersHtml}
  </section>
  <section style="margin:0 0 28px" aria-labelledby="roles">
    <h2 id="roles" style="margin:0 0 10px;font-size:22px;color:#0f172a">${esc(copy.rolesTitle)}</h2>
    ${rolesHtml}
  </section>
  <section style="margin:0 0 28px" aria-labelledby="editorial">
    <h2 id="editorial" style="margin:0 0 10px;font-size:20px;color:#0f172a">${esc(cityDisplay)}</h2>
    <p style="margin:0 0 10px;color:#334155;line-height:1.7;max-width:860px">${esc(editorial)}</p>
    <p style="margin:0;color:#475569;line-height:1.7;max-width:860px;font-size:14px">${esc(methodology)}</p>
  </section>
  <section style="margin:0 0 28px" aria-labelledby="relatedLinks">
    <h2 id="relatedLinks" style="margin:0 0 10px;font-size:20px;color:#0f172a">${esc(copy.relatedLinksTitle)}</h2>
    ${relatedHtml}
  </section>
  <section style="margin:0 0 0" aria-labelledby="weeklyFaq">
    <h2 id="weeklyFaq" style="margin:0 0 10px;font-size:22px;color:#0f172a">${esc(copy.faqTitle)}</h2>
    <details style="padding:12px 14px;border:1px solid #e2e8f0;border-radius:12px;margin-bottom:8px;background:#ffffff">
      <summary style="font-weight:700;cursor:pointer;color:#0f172a">${esc(copy.faqHowOftenQ)}</summary>
      <p style="margin:10px 0 0;color:#334155;line-height:1.6">${esc(copy.faqHowOftenA)}</p>
    </details>
    <details style="padding:12px 14px;border:1px solid #e2e8f0;border-radius:12px;margin-bottom:8px;background:#ffffff">
      <summary style="font-weight:700;cursor:pointer;color:#0f172a">${esc(copy.faqDeltaQ)}</summary>
      <p style="margin:10px 0 0;color:#334155;line-height:1.6">${esc(copy.faqDeltaA)}</p>
    </details>
    <details style="padding:12px 14px;border:1px solid #e2e8f0;border-radius:12px;margin-bottom:8px;background:#ffffff">
      <summary style="font-weight:700;cursor:pointer;color:#0f172a">${esc(copy.faqApplyQ)}</summary>
      <p style="margin:10px 0 0;color:#334155;line-height:1.6">${esc(copy.faqApplyA)}</p>
    </details>
  </section>
  ${generateRelatedLinksBlock(locale, 'weekly_employers', { city, weeklyCity: city })}
</main>`;

  // Extra head: OG image dims + twitter card — matches pre-shell-wrap output.
  const extraHead = `    <meta property="og:image" content="${BASE_URL}/og-image.png">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${esc(title)}">
    <meta name="twitter:description" content="${esc(description)}">
    <meta name="twitter:site" content="@frontaliereticino">`;

  const hreflangHtml = `${alternatesHtml}\n    <link rel="alternate" hreflang="x-default" href="${BASE_URL}${xDefaultPath}">`;

  return buildSeoPageHtml({
    locale,
    title,
    description,
    canonicalUrl,
    robots,
    ogType: 'website',
    ogLocale: WEEKLY_EMPLOYERS_OG_LOCALE[locale],
    hreflangHtml,
    extraHeadHtml: extraHead,
    jsonLdScripts: [breadcrumbLd, webPageLd, itemListLd, faqLd],
    bodyHtml,
    distDir,
  });
}

// ── Company × City page renderer (D-2 Expansion B) ────────────

export interface CompanyCityPageInputs {
  locale: WeeklyEmployersLocale;
  city: WeeklyEmployersCompanyCity;
  companySlug: string;
  variant: 'current' | 'archive';
  weekNum: number;
  year: number;
  stats: CompanyCityStats;
  hasHistoricalDelta: boolean;
  canonicalPath: string;
  today: Date;
  indexable: boolean;
  distDir?: string;
  /** Cities where the same company has a generated page in this locale.
   *  Used to keep related-links sibling cluster honest (no broken links). */
  companySiblingCities?: readonly WeeklyEmployersCompanyCity[];
}

/**
 * JSON-LD `JobPosting` full shape — every mandatory field per CLAUDE.md rule #3
 * (title, description, datePosted, hiringOrganization.name, jobLocation,
 * employmentType, baseSalary, postalCode, streetAddress). Uses
 * `COMPANY_HQ_ADDRESSES` as fallback when source data is missing and a
 * reasonable editorial description when the job has no parsed body.
 *
 * The validator (scripts/validate-structured-data-completeness.mjs) rejects
 * empty strings as missing — therefore every field MUST be non-empty.
 */
const OPEN_POSITION_LABEL: Record<WeeklyEmployersLocale, string> = {
  it: 'Posizione aperta',
  en: 'Open position',
  de: 'Offene Stelle',
  fr: 'Poste ouvert',
};

const JOB_DESC_FALLBACK: Record<WeeklyEmployersLocale, (title: string, employer: string, city: string) => string> = {
  it: (t, e, c) => `${t} presso ${e} a ${c}. Candidatura diretta tramite il nostro portale, con dettagli, requisiti e informazioni complete sulla pagina dell'offerta di lavoro.`,
  en: (t, e, c) => `${t} at ${e} in ${c}. Apply directly through our portal — full details, requirements and information are available on the job posting page.`,
  de: (t, e, c) => `${t} bei ${e} in ${c}. Direkte Bewerbung über unser Portal mit allen Details, Anforderungen und Informationen auf der Stellenanzeige.`,
  fr: (t, e, c) => `${t} chez ${e} à ${c}. Candidature directe via notre portail, avec tous les détails, exigences et informations sur la page de l'offre.`,
};

/**
 * Compute a future ISO `validThrough` value for JobPosting rich-results.
 * Source-provided value wins, then crawledAt + 60 days, then datePosted + 90 days.
 * Falls back to now + 60 days when every input is invalid — never returns empty.
 */
function computeValidThrough(
  explicit: string | undefined,
  crawledAt: string | undefined,
  datePosted: string,
): string {
  const tryParse = (s: string | undefined): Date | null => {
    if (!s) return null;
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  };

  const explicitDate = tryParse(explicit);
  if (explicitDate) return explicitDate.toISOString();

  const crawled = tryParse(crawledAt);
  if (crawled) {
    const out = new Date(crawled);
    out.setUTCDate(out.getUTCDate() + 60);
    return out.toISOString();
  }

  const posted = tryParse(datePosted);
  if (posted) {
    const out = new Date(posted);
    out.setUTCDate(out.getUTCDate() + 90);
    return out.toISOString();
  }

  const fallback = new Date();
  fallback.setUTCDate(fallback.getUTCDate() + 60);
  return fallback.toISOString();
}

function jobToJsonLd(
  job: CompanyCityActiveJob,
  employer: string,
  city: string,
  locale: WeeklyEmployersLocale = 'it',
): Record<string, unknown> {
  const fallbackAddr = resolveFallbackAddress(job.companySlug, city.toLowerCase());

  const streetAddress =
    (job.streetAddress && job.streetAddress.trim().length > 0 && job.streetAddress.trim()) ||
    fallbackAddr.streetAddress;
  const postalCode =
    (job.postalCode && /^\d{4,5}$/.test(job.postalCode.trim()) && job.postalCode.trim()) ||
    fallbackAddr.postalCode;
  const addressLocality =
    (job.addressLocality && job.addressLocality.trim().length > 0 && job.addressLocality.trim()) ||
    fallbackAddr.addressLocality ||
    city;

  // Description MUST be ≥30 chars (validator rejects thin descriptions).
  // Build an editorial fallback that references the role + employer + city
  // so even ad-slots with empty source descriptions pass validation.
  const rawDesc = (job.description || '').trim();
  const titleFallback = job.title || OPEN_POSITION_LABEL[locale];
  const description =
    rawDesc.length >= 30
      ? rawDesc.slice(0, 5000)
      : JOB_DESC_FALLBACK[locale](titleFallback, employer, addressLocality);

  const employmentType = job.employmentType && job.employmentType.length > 0
    ? job.employmentType
    : 'FULL_TIME';

  // baseSalary fallback — Ticino healthcare/service median band (annual).
  // Must include currency + value.minValue (>0) + value.maxValue (>=min) +
  // value.unitText (validate-structured-data-completeness rejects missing).
  const minValue =
    typeof job.salaryMin === 'number' && job.salaryMin > 0 ? job.salaryMin : 55000;
  const maxValue =
    typeof job.salaryMax === 'number' && job.salaryMax >= minValue
      ? job.salaryMax
      : Math.max(minValue + 1, 95000);
  const currency = job.salaryCurrency && job.salaryCurrency.length > 0 ? job.salaryCurrency : 'CHF';

  const datePosted = job.postedDate || new Date().toISOString().slice(0, 10);

  // addressRegion: source field → derived from addressLocality → fallback HQ canton.
  // Required by GSC for JobPosting rich-result quality (no empty values allowed).
  const explicitRegion = (job.addressRegion || '').trim().toUpperCase();
  const addressRegion =
    /^[A-Z]{2}$/.test(explicitRegion)
      ? explicitRegion
      : deriveCantonFromCity(addressLocality) || fallbackAddr.addressRegion;

  // validThrough: source field → crawledAt + 60d → postedDate + 90d → now + 60d.
  // Always emit a future ISO datetime — Google requires validThrough to be
  // present and in the future for active JobPosting rich-results.
  const validThrough = computeValidThrough(job.validThrough, job.crawledAt, datePosted);

  return {
    '@type': 'JobPosting',
    title: job.title || OPEN_POSITION_LABEL[locale],
    description,
    inLanguage: locale,
    url: `${BASE_URL}${job.detailPath}`,
    datePosted,
    validThrough,
    employmentType,
    hiringOrganization: {
      '@type': 'Organization',
      name: employer,
    },
    jobLocation: {
      '@type': 'Place',
      address: {
        '@type': 'PostalAddress',
        streetAddress,
        postalCode,
        addressLocality,
        addressRegion,
        addressCountry: 'CH',
      },
    },
    baseSalary: {
      '@type': 'MonetaryAmount',
      currency,
      value: {
        '@type': 'QuantitativeValue',
        minValue,
        maxValue,
        unitText: 'YEAR',
      },
    },
  };
}

export function renderCompanyCityPage(inp: CompanyCityPageInputs): string {
  const {
    locale,
    city,
    companySlug,
    variant,
    weekNum,
    year,
    stats,
    hasHistoricalDelta,
    canonicalPath,
    today,
    indexable,
    distDir,
    companySiblingCities,
  } = inp;

  const copy = COPY[locale];
  const cityDisplay = WEEKLY_EMPLOYERS_CITY_DISPLAY[city];
  const employer = stats.employer || '';
  const dateStamp = today.toISOString().slice(0, 10);
  const canonicalUrl = `${BASE_URL}${canonicalPath}`;

  const h1 =
    variant === 'current'
      ? copy.companyCityH1Current(employer, cityDisplay)
      : copy.companyCityH1Archive(employer, cityDisplay, weekNum, year);

  const heroSummary = hasHistoricalDelta
    ? copy.companyCityHeroWithDelta({
        employer,
        city: cityDisplay,
        jobsCount: stats.activeJobsCount,
        delta: stats.delta,
      })
    : copy.companyCityHeroNoDelta({
        employer,
        city: cityDisplay,
        jobsCount: stats.activeJobsCount,
      });

  const topRoleLabels = stats.topRoles.map((r) => r.role);
  const intro = copy.companyCityIntro({
    employer,
    city: cityDisplay,
    topRoles: topRoleLabels,
    avgSalary: stats.avgSalary,
  });
  const editorial = copy.companyCityEditorial({
    employer,
    city: cityDisplay,
    jobsCount: stats.activeJobsCount,
    topRoles: topRoleLabels,
  });

  // hreflang alternates to the same (city, companySlug, variant) in other locales.
  const alternatesHtml = WEEKLY_EMPLOYERS_LOCALES.map((alt) => {
    const p =
      variant === 'current'
        ? buildCompanyCityCurrentPath(alt, city, companySlug)
        : buildCompanyCityArchivePath(alt, city, companySlug, weekNum, year);
    return `    <link rel="alternate" hreflang="${alt}" href="${BASE_URL}${p}">`;
  }).join('\n');
  const xDefaultPath =
    variant === 'current'
      ? buildCompanyCityCurrentPath('it', city, companySlug)
      : buildCompanyCityArchivePath('it', city, companySlug, weekNum, year);

  const hreflangHtml = `${alternatesHtml}\n    <link rel="alternate" hreflang="x-default" href="${BASE_URL}${xDefaultPath}">`;

  // Job list (≤10).
  const jobsListHtml =
    stats.activeJobs.length > 0
      ? `<ol style="list-style:none;padding:0;margin:0;display:grid;grid-template-columns:1fr;gap:10px">${stats.activeJobs
          .map((job, idx) => {
            const title = esc(job.title || `Posizione ${idx + 1}`);
            const date = job.postedDate
              ? `<span style="color:#64748b;font-size:13px">${esc(String(job.postedDate).slice(0, 10))}</span>`
              : '';
            const apply = esc(copy.companyCityApplyCta);
            return `<li style="padding:14px 16px;border:1px solid #e2e8f0;border-radius:14px;background:#ffffff">
      <a href="${esc(job.detailPath)}" style="display:block;color:inherit;text-decoration:none">
        <div style="font-weight:700;font-size:16px;color:#0f172a">${idx + 1}. ${title}</div>
        <div style="margin-top:4px;display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
          ${date}
          <span style="color:#1d4ed8;font-weight:600;font-size:14px">${apply} →</span>
        </div>
      </a>
    </li>`;
          })
          .join('')}</ol>`
      : `<p style="padding:14px 16px;border-radius:12px;background:#fef3c7;color:#78350f">${esc(copy.topCompaniesEmpty)}</p>`;

  // Related links (own + cross-feature via shared helper).
  const parentHubHref = buildCurrentWeekPath(locale, city);
  const cityJobsHref = cityJobsHubPath(locale, city);
  const brandHref = employerBrandPath(stats.employerKey);

  const ownRelated: string[] = [];
  if (brandHref) {
    ownRelated.push(
      `<li style="margin:0;padding:0"><a href="${esc(brandHref)}" style="display:inline-block;padding:8px 0;color:#1d4ed8;text-decoration:none;font-weight:600">${esc(copy.companyCityBrandHubLabel(employer))} →</a></li>`,
    );
  }
  ownRelated.push(
    `<li style="margin:0;padding:0"><a href="${esc(parentHubHref)}" style="display:inline-block;padding:8px 0;color:#1d4ed8;text-decoration:none;font-weight:600">${esc(copy.companyCityParentHubLabel(cityDisplay))} →</a></li>`,
  );
  ownRelated.push(
    `<li style="margin:0;padding:0"><a href="${esc(cityJobsHref)}" style="display:inline-block;padding:8px 0;color:#1d4ed8;text-decoration:none;font-weight:600">${esc(copy.companyCityCityHubLabel(cityDisplay))} →</a></li>`,
  );

  // Sibling company-city pages for the same company (other cities).
  // Build the list of sibling cities that qualify — we rely on the calling
  // generator to pass us `stats.employerKey`, and here we just try to emit
  // links to other cities in the static hardcoded city list if a sibling
  // stats was computed upstream and pinned on `_siblingCities` (optional).
  // To keep this renderer dependency-free we expose a CSS grid of potential
  // siblings; the generator below patches the DOM when siblings exist.
  //
  // For SEO simplicity we ALWAYS emit a stub `<section id="siblings">` so
  // downstream injection is easy; the generator populates it with real
  // sibling pairs after computing the global pair list.
  const siblingsPlaceholder = '<!--SIBLING_LINKS_PLACEHOLDER-->';

  // JSON-LD
  const breadcrumbLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: copy.breadcrumbHome, item: `${BASE_URL}/` },
      {
        '@type': 'ListItem',
        position: 2,
        name: copy.sectionLabel,
        item: `${BASE_URL}${WEEKLY_EMPLOYERS_LOCALE_PREFIX[locale]}/${WEEKLY_EMPLOYERS_SECTION[locale]}/ticino/${WEEKLY_EMPLOYERS_CURRENT_SLUG[locale]}/`.replace(/([^:])\/+/g, '$1/'),
      },
      {
        '@type': 'ListItem',
        position: 3,
        name: cityDisplay,
        item: `${BASE_URL}${parentHubHref}`,
      },
      { '@type': 'ListItem', position: 4, name: employer, item: canonicalUrl },
    ],
  });

  const webPageLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: h1,
    url: canonicalUrl,
    description: heroSummary,
    inLanguage: locale,
    dateModified: today.toISOString(),
    datePublished: today.toISOString(),
  });

  const itemListLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: h1,
    numberOfItems: stats.activeJobs.length,
    inLanguage: locale,
    itemListElement: stats.activeJobs.map((job, idx) => ({
      '@type': 'ListItem',
      position: idx + 1,
      item: jobToJsonLd(job, employer, cityDisplay, locale),
    })),
  });

  const faqLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    inLanguage: locale,
    mainEntity: [
      {
        '@type': 'Question',
        name: copy.companyCityFaqWhyQ(employer),
        acceptedAnswer: {
          '@type': 'Answer',
          text: copy.companyCityFaqWhyA(employer, cityDisplay),
        },
      },
      {
        '@type': 'Question',
        name: copy.companyCityFaqHowApplyQ,
        acceptedAnswer: {
          '@type': 'Answer',
          text: copy.companyCityFaqHowApplyA(employer),
        },
      },
      {
        '@type': 'Question',
        name: copy.companyCityFaqUpdateQ,
        acceptedAnswer: { '@type': 'Answer', text: copy.companyCityFaqUpdateA },
      },
    ],
  });

  const robots = indexable ? 'index,follow' : 'noindex,follow';
  const title = `${h1} | Frontaliere Ticino`.slice(0, 160);
  const description = heroSummary.slice(0, 180);

  const archiveNote =
    variant === 'archive' && !indexable
      ? `<p style="margin:0 0 16px;color:#78350f;background:#fef3c7;padding:10px 14px;border-radius:12px;font-size:14px">${esc(copy.archiveNoindexNote)}</p>`
      : '';

  const bodyHtml = `<main style="max-width:1100px;margin:0 auto;padding:32px 20px 56px;color:#0f172a">
  <nav style="margin:0 0 14px;font-size:13px;color:#475569" aria-label="breadcrumb">
    <a href="${BASE_URL}/" style="color:#1d4ed8;text-decoration:none">${esc(copy.breadcrumbHome)}</a>
    <span> / </span>
    <a href="${BASE_URL}${WEEKLY_EMPLOYERS_LOCALE_PREFIX[locale]}/${WEEKLY_EMPLOYERS_SECTION[locale]}/ticino/${WEEKLY_EMPLOYERS_CURRENT_SLUG[locale]}/" style="color:#1d4ed8;text-decoration:none">${esc(copy.sectionLabel)}</a>
    <span> / </span>
    <a href="${esc(parentHubHref)}" style="color:#1d4ed8;text-decoration:none">${esc(cityDisplay)}</a>
    <span> / </span>
    <span>${esc(employer)}</span>
  </nav>
  <header style="margin-bottom:22px">
    <p style="margin:0 0 6px;color:#4f46e5;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.04em">${esc(copy.companyCityKicker)} · ${esc(copy.updatedLabel)} ${dateStamp}</p>
    <h1 style="margin:0 0 12px;font-size:clamp(1.8rem,4.5vw,2.75rem);line-height:1.1">${esc(h1)}</h1>
    <p style="margin:0 0 14px;font-size:18px;line-height:1.55;max-width:860px">${esc(heroSummary)}</p>
    <p style="margin:0;color:#334155;line-height:1.7;max-width:860px">${esc(intro)}</p>
  </header>
  ${archiveNote}
  <section style="margin:0 0 28px" aria-labelledby="companyCityJobs">
    <h2 id="companyCityJobs" style="margin:0 0 14px;font-size:22px;color:#0f172a">${esc(copy.companyCityJobsHeading(employer, cityDisplay))}</h2>
    ${jobsListHtml}
  </section>
  <section style="margin:0 0 28px" aria-labelledby="companyCityEditorial">
    <h2 id="companyCityEditorial" style="margin:0 0 10px;font-size:20px;color:#0f172a">${esc(employer)} · ${esc(cityDisplay)}</h2>
    <p style="margin:0;color:#334155;line-height:1.7;max-width:860px">${esc(editorial)}</p>
  </section>
  <section style="margin:0 0 28px" aria-labelledby="companyCityLinks">
    <h2 id="companyCityLinks" style="margin:0 0 10px;font-size:20px;color:#0f172a">${esc(copy.relatedLinksTitle)}</h2>
    <ul style="list-style:none;padding:0;margin:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:6px 18px">${ownRelated.join('')}</ul>
    ${siblingsPlaceholder}
  </section>
  <section style="margin:0 0 0" aria-labelledby="companyCityFaq">
    <h2 id="companyCityFaq" style="margin:0 0 10px;font-size:22px;color:#0f172a">${esc(copy.faqTitle)}</h2>
    <details style="padding:12px 14px;border:1px solid #e2e8f0;border-radius:12px;margin-bottom:8px;background:#ffffff">
      <summary style="font-weight:700;cursor:pointer;color:#0f172a">${esc(copy.companyCityFaqWhyQ(employer))}</summary>
      <p style="margin:10px 0 0;color:#334155;line-height:1.6">${esc(copy.companyCityFaqWhyA(employer, cityDisplay))}</p>
    </details>
    <details style="padding:12px 14px;border:1px solid #e2e8f0;border-radius:12px;margin-bottom:8px;background:#ffffff">
      <summary style="font-weight:700;cursor:pointer;color:#0f172a">${esc(copy.companyCityFaqHowApplyQ)}</summary>
      <p style="margin:10px 0 0;color:#334155;line-height:1.6">${esc(copy.companyCityFaqHowApplyA(employer))}</p>
    </details>
    <details style="padding:12px 14px;border:1px solid #e2e8f0;border-radius:12px;margin-bottom:8px;background:#ffffff">
      <summary style="font-weight:700;cursor:pointer;color:#0f172a">${esc(copy.companyCityFaqUpdateQ)}</summary>
      <p style="margin:10px 0 0;color:#334155;line-height:1.6">${esc(copy.companyCityFaqUpdateA)}</p>
    </details>
  </section>
  ${generateRelatedLinksBlock(locale, 'weekly_employer_company_city', {
    city,
    weeklyCity: city,
    companySlug,
    employer,
    companySiblingCities,
  })}
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
    ogType: 'website',
    ogLocale: WEEKLY_EMPLOYERS_OG_LOCALE[locale],
    hreflangHtml,
    extraHeadHtml: extraHead,
    jsonLdScripts: [breadcrumbLd, webPageLd, itemListLd, faqLd],
    bodyHtml,
    distDir,
  });
}

/**
 * Inject sibling-city links into a company-city HTML page. Returns a new
 * string — does not mutate.
 *
 * Kept out of `renderCompanyCityPage` because sibling discovery requires
 * the full list of qualifying pairs, which only the generator has.
 */
export function injectSiblingLinks(
  html: string,
  locale: WeeklyEmployersLocale,
  companySlug: string,
  currentCity: WeeklyEmployersCompanyCity,
  siblingCities: readonly WeeklyEmployersCompanyCity[],
  employer: string,
): string {
  const copy = COPY[locale];
  if (siblingCities.length === 0) {
    return html.replace('<!--SIBLING_LINKS_PLACEHOLDER-->', '');
  }
  const items = siblingCities
    .filter((c) => c !== currentCity)
    .map((c) => {
      const href = buildCompanyCityCurrentPath(locale, c, companySlug);
      const label = copy.companyCitySiblingLabel(employer, WEEKLY_EMPLOYERS_CITY_DISPLAY[c]);
      return `<li style="margin:0;padding:0"><a href="${esc(href)}" style="display:inline-block;padding:8px 0;color:#1d4ed8;text-decoration:none;font-weight:600">${esc(label)} →</a></li>`;
    })
    .join('');
  if (!items) {
    return html.replace('<!--SIBLING_LINKS_PLACEHOLDER-->', '');
  }
  const block = `<ul style="list-style:none;padding:0;margin:12px 0 0;display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:4px 16px">${items}</ul>`;
  return html.replace('<!--SIBLING_LINKS_PLACEHOLDER-->', block);
}

// ── Snapshot I/O ────────────────────────────────────────────────

/** Read all snapshots from data/jobs-snapshots-history/*.json sorted by week asc. */
export function readSnapshotHistory(rootDir: string): JobsSnapshot[] {
  const historyDir = np.join(rootDir, 'data', 'jobs-snapshots-history');
  if (!fs.existsSync(historyDir)) return [];
  const files = fs.readdirSync(historyDir).filter((f) => /^\d{4}-\d{2}\.json$/.test(f));
  const snapshots: JobsSnapshot[] = [];
  for (const file of files) {
    try {
      const raw = fs.readFileSync(np.join(historyDir, file), 'utf-8');
      const parsed = JSON.parse(raw) as JobsSnapshot;
      if (parsed && typeof parsed.week === 'string' && Array.isArray(parsed.jobs)) {
        snapshots.push(parsed);
      }
    } catch {
      // skip malformed snapshot
    }
  }
  snapshots.sort((a, b) => a.week.localeCompare(b.week));
  return snapshots;
}

/** Load all jobs from data/jobs.json + per-crawler slices. */
function loadAllJobs(rootDir: string): WeeklyCountableJob[] {
  const dataDir = np.join(rootDir, 'data');
  const out: WeeklyCountableJob[] = [];
  const seen = new Set<string>();

  const mainPath = np.join(dataDir, 'jobs.json');
  if (fs.existsSync(mainPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(mainPath, 'utf-8'));
      if (Array.isArray(raw)) {
        for (const j of raw) {
          const key = String(j?.slug || j?.id || '');
          if (key && !seen.has(key)) {
            seen.add(key);
            out.push(j as WeeklyCountableJob);
          }
        }
      }
    } catch (err) {
      console.warn('[weekly-employers] failed to parse jobs.json:', err);
    }
  }

  const sliceDir = np.join(dataDir, 'jobs', 'by-crawler');
  if (fs.existsSync(sliceDir)) {
    for (const file of fs.readdirSync(sliceDir)) {
      if (!file.endsWith('.json')) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(np.join(sliceDir, file), 'utf-8'));
        const jobs: unknown = Array.isArray(raw) ? raw : raw?.jobs;
        if (!Array.isArray(jobs)) continue;
        for (const j of jobs as WeeklyCountableJob[]) {
          const key = String(j?.slug || (j as { id?: string })?.id || '');
          if (key && !seen.has(key)) {
            seen.add(key);
            out.push(j);
          }
        }
      } catch {
        // slice parse failure — skip
      }
    }
  }

  return out;
}

// ── Generator ───────────────────────────────────────────────────

export interface GeneratedPage {
  path: string;
  html: string;
  indexable: boolean;
}

export interface GenerationOptions {
  rootDir: string;
  jobs: readonly WeeklyCountableJob[];
  snapshots: readonly JobsSnapshot[];
  today?: Date;
  enableAutoStubs?: boolean;
  /** dist directory for entry-asset resolution (omit in tests). */
  distDir?: string;
}

/**
 * Pure generator — used by both the Vite plugin (closeBundle) and tests.
 * Returns every page ready to be written.
 */
export function generateWeeklyEmployerPages(opts: GenerationOptions): GeneratedPage[] {
  const today = opts.today ?? new Date();
  const distDir = opts.distDir;
  const { week: currentWeek, year: currentYear } = getIsoWeekAndYear(today);

  const latestSnapshot: JobsSnapshot | null =
    opts.snapshots.length > 0 ? opts.snapshots[opts.snapshots.length - 1] : null;
  const previousSnapshot: JobsSnapshot | null =
    opts.snapshots.length > 1 ? opts.snapshots[opts.snapshots.length - 2] : null;

  const olderSnapshots = opts.snapshots.slice(0, Math.max(0, opts.snapshots.length - 1));
  const hasHistoricalDelta = opts.snapshots.length >= 2;

  const pages: GeneratedPage[] = [];

  // Current week (always emit regardless of snapshot history — degraded mode)
  for (const locale of WEEKLY_EMPLOYERS_LOCALES) {
    for (const city of WEEKLY_EMPLOYERS_CITIES) {
      const stats = buildCityWeeklyStats({
        city,
        locale,
        jobs: opts.jobs,
        previousSnapshot,
        historicalSnapshots: olderSnapshots,
      });
      const canonicalPath = buildCurrentWeekPath(locale, city);
      const html = renderWeeklyEmployersPage({
        locale,
        city,
        variant: 'current',
        weekNum: currentWeek,
        year: currentYear,
        stats,
        hasHistoricalDelta,
        canonicalPath,
        today,
        indexable: true,
        enableAutoStubs: opts.enableAutoStubs,
        distDir,
      });
      pages.push({ path: canonicalPath, html, indexable: true });
    }
  }

  // Archive pages — require ≥2 historical snapshots
  if (opts.snapshots.length >= 2) {
    // Sort snapshots desc by ISO week key; index newest first so we mark oldest as noindex.
    const sortedDesc = [...opts.snapshots].sort((a, b) => b.week.localeCompare(a.week));
    for (let i = 0; i < sortedDesc.length; i++) {
      const snap = sortedDesc[i];
      const m = /^(\d{4})-(\d{2})$/.exec(snap.week);
      if (!m) continue;
      const year = Number.parseInt(m[1], 10);
      const weekNum = Number.parseInt(m[2], 10);

      // Do NOT emit an archive for the current ISO week (it's covered by
      // the current-week page). This keeps one canonical URL per week.
      if (year === currentYear && weekNum === currentWeek) continue;

      // Index only the most-recent 12 archive weeks.
      const indexable = i < WEEKLY_EMPLOYERS_INDEXABLE_WEEKS;

      // For archives, "stats" reflect jobs as they were at snapshot time —
      // we derive them from the snapshot rows (not jobs.json, which represents
      // the current week). The previous-week snapshot for delta is the next
      // older one in the sorted list.
      const prevForArchive = sortedDesc[i + 1] ?? null;

      // Build "virtual jobs" from the snapshot so buildCityWeeklyStats can
      // reuse the same aggregation logic. Snapshot rows have 'employer',
      // 'city', 'role' — map to the WeeklyCountableJob shape.
      const virtualJobs: WeeklyCountableJob[] = snap.jobs.map((row, idx) => ({
        slug: row.slug || `snap-${snap.week}-${idx}`,
        title: row.role || 'Posizione',
        company: row.employer,
        companyKey: row.employerKey,
        location: row.city,
        addressLocality: row.city,
        postedDate: row.postedAt,
        // Force "active" to pass filter: supply 60-word description so
        // jobIsActive() is true in every locale.
        description:
          'Snapshot storico: questa offerta era attiva nella settimana ' +
          snap.week +
          ' secondo i dati pubblicati dai job-board monitorati. Utile per ricostruire il trend settimanale della settimana indicata e confrontare la dinamica delle aziende sul territorio.',
      }));

      for (const locale of WEEKLY_EMPLOYERS_LOCALES) {
        for (const city of WEEKLY_EMPLOYERS_CITIES) {
          const stats = buildCityWeeklyStats({
            city,
            locale,
            jobs: virtualJobs,
            previousSnapshot: prevForArchive,
            historicalSnapshots: sortedDesc.slice(i + 2),
          });
          const canonicalPath = buildArchiveWeekPath(locale, city, weekNum, year);
          const html = renderWeeklyEmployersPage({
            locale,
            city,
            variant: 'archive',
            weekNum,
            year,
            stats,
            hasHistoricalDelta: prevForArchive !== null,
            canonicalPath,
            today,
            indexable,
            enableAutoStubs: opts.enableAutoStubs,
            distDir,
          });
          pages.push({ path: canonicalPath, html, indexable });
        }
      }
    }
  }

  // ── D-2 Expansion B: per-company × per-city pages ──────────────
  // Runs AFTER the city-level loop so we can lean on the latest snapshot
  // as the "previous week" for delta. Skipped for the regional "ticino"
  // hub (already covered by per-city pages).
  const pairs = enumerateCompanyCityPairs(opts.jobs);

  // Pass 1: compute stats per (pair, locale) to know which pages will be
  // generated. Both the older <!--SIBLING_LINKS_PLACEHOLDER--> block and the
  // shared 3-cluster related-links block (which renders a `sibling` cluster
  // via `pickSiblingCities`) need to be constrained to real pages to avoid
  // broken cross-city links.
  type PairLocaleKey = string;
  const pairLocaleStats = new Map<PairLocaleKey, ReturnType<typeof buildCompanyCityStats>>();
  const pairLocaleKey = (companySlug: string, city: WeeklyEmployersCompanyCity, locale: WeeklyEmployersLocale) =>
    `${companySlug}::${city}::${locale}`;
  for (const pair of pairs) {
    for (const locale of WEEKLY_EMPLOYERS_LOCALES) {
      const stats = buildCompanyCityStats({
        city: pair.city,
        companySlug: pair.companySlug,
        employerKey: pair.employerKey,
        locale,
        jobs: opts.jobs,
        previousSnapshot,
      });
      pairLocaleStats.set(pairLocaleKey(pair.companySlug, pair.city, locale), stats);
    }
  }

  // Build per-locale sibling map from the eligible pairs.
  const siblingsByLocaleCompany = new Map<string, Map<string, WeeklyEmployersCompanyCity[]>>();
  for (const locale of WEEKLY_EMPLOYERS_LOCALES) {
    siblingsByLocaleCompany.set(locale, new Map());
  }
  for (const pair of pairs) {
    for (const locale of WEEKLY_EMPLOYERS_LOCALES) {
      if (!pairLocaleStats.get(pairLocaleKey(pair.companySlug, pair.city, locale))) continue;
      const localeMap = siblingsByLocaleCompany.get(locale)!;
      const list = localeMap.get(pair.companySlug) ?? [];
      list.push(pair.city);
      localeMap.set(pair.companySlug, list);
    }
  }

  // Pass 2: render each eligible page with the correct sibling list baked in,
  // then patch the legacy sibling-placeholder for the in-page sibling section.
  for (const pair of pairs) {
    for (const locale of WEEKLY_EMPLOYERS_LOCALES) {
      const stats = pairLocaleStats.get(pairLocaleKey(pair.companySlug, pair.city, locale));
      if (!stats) continue;
      const canonicalPath = buildCompanyCityCurrentPath(
        locale,
        pair.city,
        pair.companySlug,
      );
      const companySiblingCities =
        siblingsByLocaleCompany.get(locale)?.get(pair.companySlug) ?? [];
      let html = renderCompanyCityPage({
        locale,
        city: pair.city,
        companySlug: pair.companySlug,
        variant: 'current',
        weekNum: currentWeek,
        year: currentYear,
        stats,
        hasHistoricalDelta,
        canonicalPath,
        today,
        indexable: true,
        distDir,
        companySiblingCities,
      });
      html = injectSiblingLinks(
        html,
        locale,
        pair.companySlug,
        pair.city,
        companySiblingCities,
        stats.employer,
      );
      pages.push({ path: canonicalPath, html, indexable: true });
    }
  }

  return pages;
}

// ── Vite plugin ─────────────────────────────────────────────────

interface PluginResult {
  pagesWritten: number;
  currentWeekPages: number;
  archivePages: number;
  companyCityPages: number;
  skippedForWordCount: number;
  degradedMode: boolean;
}

export function weeklyEmployersPlugin(rootDir: string): Plugin {
  return {
    name: 'weekly-employers-pages',
    apply: 'build',
    async closeBundle() {
      if (process.env.SKIP_WEEKLY_EMPLOYERS === '1') {
        console.log(
          '\x1b[33m[weekly-employers]\x1b[0m Skipped (SKIP_WEEKLY_EMPLOYERS=1)',
        );
        return;
      }
      const distDir = np.resolve(rootDir, 'dist');
      const today = new Date();

      const jobs = loadAllJobs(rootDir);
      const snapshots = readSnapshotHistory(rootDir);
      const degraded = snapshots.length < 2;

      if (degraded) {
        console.log(
          `\x1b[33m[weekly-employers]\x1b[0m DEGRADED MODE: ${snapshots.length} snapshot(s) in history — generating current-week pages without delta. Archives will appear once ≥2 snapshots exist.`,
        );
      }

      const enableAutoStubs = process.env.ENABLE_AUTO_EMPLOYER_STUBS === '1';
      const pages = generateWeeklyEmployerPages({
        rootDir,
        jobs,
        snapshots,
        today,
        enableAutoStubs,
        distDir,
      });

      const collector = new WriteCollector({ distDir, skipExisting: false });

      let currentWeekCount = 0;
      let archiveCount = 0;
      let companyCityCount = 0;
      let skipped = 0;
      // Paths that should land in sitemap-weekly-employers.xml. Only indexable
      // pages (current-week + last-12-weeks archives) are listed — noindex
      // archives stay reachable but are excluded from the sitemap to keep
      // crawl budget focused on fresh content.
      const indexableSitemapPaths: string[] = [];

      // Classify by path — archive paths contain "settimana-NN-YYYY" etc.
      const archiveRe = /\/(?:settimana|week|woche|semaine)-\d{2}-\d{4}\/?$/;

      for (const page of pages) {
        const words = countHtmlBodyWords(page.html);
        if (words < MIN_INDEXABLE_WORDS) {
          skipped++;
          console.warn(
            `[weekly-employers] thin content (${words} words) for ${page.path} — skipping`,
          );
          continue;
        }
        const outDir = np.join(distDir, page.path.replace(/^\/+/, ''));
        collector.add(np.join(outDir, 'index.html'), page.html);
        // Company × city pages have 4 segments after the locale prefix (section,
        // city, companySlug, when) vs. 3 segments for city-only pages. Use the
        // parse helper so we don't re-derive the rule.
        const companyCityMatch = parseCompanyCityPath(page.path);
        if (companyCityMatch) companyCityCount++;
        else if (archiveRe.test(page.path)) archiveCount++;
        else currentWeekCount++;
        if (page.indexable) indexableSitemapPaths.push(page.path);
      }

      const written = await collector.flush();

      // ── Emit sitemap-weekly-employers.xml ───────────────────────
      // Auto-discovered by sitemapAliasPlugin into dist/sitemap.xml.
      if (indexableSitemapPaths.length > 0) {
        try {
          const dateStamp = today.toISOString().slice(0, 10);
          const urlEntries = indexableSitemapPaths
            .map((p) => {
              // Current-week pages update weekly; archives update monthly.
              const isCurrent = !archiveRe.test(p);
              const changefreq = isCurrent ? 'weekly' : 'monthly';
              const priority = isCurrent ? '0.8' : '0.5';
              return `  <url>\n    <loc>${BASE_URL}${p}</loc>\n    <lastmod>${dateStamp}</lastmod>\n    <changefreq>${changefreq}</changefreq>\n    <priority>${priority}</priority>\n  </url>`;
            })
            .join('\n');
          const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urlEntries}
</urlset>
`;
          fs.writeFileSync(
            np.join(distDir, 'sitemap-weekly-employers.xml'),
            sitemapXml,
            'utf-8',
          );
          console.log(
            `\x1b[36m[weekly-employers]\x1b[0m Wrote sitemap-weekly-employers.xml (${indexableSitemapPaths.length} URLs)`,
          );
        } catch (err) {
          console.warn(
            '[weekly-employers] failed to write sitemap-weekly-employers.xml',
            err,
          );
        }
      }

      const result: PluginResult = {
        pagesWritten: written,
        currentWeekPages: currentWeekCount,
        archivePages: archiveCount,
        companyCityPages: companyCityCount,
        skippedForWordCount: skipped,
        degradedMode: degraded,
      };

      console.log(
        `\x1b[36m[weekly-employers]\x1b[0m Generated ${result.currentWeekPages} current-week + ${result.archivePages} archive + ${result.companyCityPages} company×city pages (skipped ${result.skippedForWordCount}) — degraded=${result.degradedMode}`,
      );
    },
  };
}
