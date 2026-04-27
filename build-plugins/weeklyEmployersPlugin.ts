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
import { renderHreflangTags, type HreflangPaths } from './shared/hreflang';
import { WriteCollector } from './batchWrite';
import {
  MAX_COMPANY_CITY_PAGES_PER_BUILD,
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
  companyCityMeetsThreshold,
  getIsoWeekAndYear,
  isoWeekKey,
  parseCompanyCityPath,
  type CompanyCityPair,
  type WeeklyEmployersCity,
  type WeeklyEmployersCompanyCity,
  type WeeklyEmployersLocale,
} from './weeklyEmployersData';
import { generateRelatedLinksBlock } from './shared/relatedLinks';
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
  SMALL_HEADING_STYLE,
  clampSiteSuffix,
  renderDiscoverMore,
  renderEntityCard,
  resolveBrandLogoUrl,
} from './shared/seoContentTokens';
import { EMPLOYER_BRANDS } from '../services/employerBrands';
import { CRAWLED_COMPANY_LOGOS } from '../services/jobDataNormalization';
// Note: resolveFallbackAddress / deriveCantonFromCity are now used indirectly
// via the canonical `buildJobPostingSchema` builder.
import { buildJobPostingSchema, type JobInput } from './shared/jobPostingSchema';
import { cleanNamespaces, cleanSitemapFiles } from './shared/distNamespaceCleanup';
import { employerCanonicalHref, loadKnownCompanySlugs, slugifyEmployer } from './shared/employerLinks';
import { SECTOR_HUB_KEYS, buildSectorHubPath, type SectorHubKey } from './jobSectorLanding';

// ── Feature-specific "Scopri di più" CTAs ─────────────────────
// Three contextually relevant links per locale for the F5 weekly-employers feature.

const WEEKLY_EMPLOYERS_DISCOVER_MORE_CTAS: Record<WeeklyEmployersLocale, ReadonlyArray<{ title: string; href: string }>> = {
  it: [
    { title: 'Offerte lavoro ultimi 3 giorni',        href: '/cerca-lavoro-ticino/ultimi-3-giorni/' },
    { title: 'Costo della vita in Ticino',            href: '/costo-vita-ticino/' },
    { title: 'Calcolatore stipendio frontaliere',     href: '/' },
  ],
  en: [
    { title: 'Jobs posted in the last 3 days',        href: '/en/find-jobs-ticino/last-3-days/' },
    { title: 'Cost of living in Ticino',              href: '/en/cost-of-living-ticino/' },
    { title: 'Cross-border salary calculator',        href: '/en/' },
  ],
  de: [
    { title: 'Stellen der letzten 3 Tage',            href: '/de/jobs-im-tessin/letzte-3-tage/' },
    { title: 'Lebenshaltungskosten Tessin',           href: '/de/lebenshaltungskosten-tessin/' },
    { title: 'Gehaltsrechner Grenzgänger',            href: '/de/' },
  ],
  fr: [
    { title: 'Offres des 3 derniers jours',           href: '/fr/trouver-emploi-tessin/derniers-3-jours/' },
    { title: 'Coût de la vie au Tessin',              href: '/fr/cout-vie-tessin/' },
    { title: 'Calculateur salaire frontalier',        href: '/fr/' },
  ],
};

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

  if (!companyCityMeetsThreshold({ active: matching.length })) return null;

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
      if (!companyCityMeetsThreshold(rec)) continue;
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

/**
 * Build the list of (href, label) pairs that safely link to per-company ×
 * per-city pages for a given locale, gating each pair through
 * {@link companyCityMeetsThreshold} so we never emit a URL to a page the
 * generator will refuse to materialise.
 *
 * Exposed so callers (and tests) can filter arbitrary pair lists through
 * the same gate that the page generator applies — this closes the link
 * graph that caused "empty shell" pages in Phase 3.
 */
export interface CompanyCityLink {
  readonly href: string;
  readonly label: string;
}

export function buildCompanyCityLinks(
  pairs: ReadonlyArray<
    Readonly<{
      city: WeeklyEmployersCompanyCity;
      companySlug: string;
      employer: string;
      active: number;
    }>
  >,
  locale: WeeklyEmployersLocale,
): ReadonlyArray<CompanyCityLink> {
  return pairs
    .filter(companyCityMeetsThreshold)
    .map((p) => ({
      href: buildCompanyCityCurrentPath(locale, p.city, p.companySlug),
      label: `${p.employer} — ${WEEKLY_EMPLOYERS_CITY_DISPLAY[p.city]}`,
    }));
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
  /** Single page-level banner shown when the whole page is in initial-data state (no delta history). */
  coldStartBanner: string;
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
  /**
   * Per-company × city frontalier context section. Two paragraphs covering
   * permit + commute reality from typical Lombardy origins to {city}, and
   * the gross-to-net mechanics that determine whether a {employer} offer
   * in {city} pays off vs an Italian alternative. Adds substantive
   * page-relevant text — fixes the Semrush text/HTML ratio gate without
   * filler.
   */
  companyCityFrontalierTitle: (employer: string, city: string) => string;
  companyCityFrontalier: (args: { employer: string; city: string; jobsCount: number }) => string[];
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
    coldStartBanner: 'Prima settimana di dati — dalla prossima settimana vedrai la variazione per ogni azienda.',
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
          : `Le posizioni aperte coprono diversi profili professionali a ${city}, da ruoli operativi (assistenza, magazzino, manutenzione) a funzioni specialistiche (amministrazione, IT, contabilità, gestione progetti) — apri ciascun annuncio in elenco per vedere mansionario completo, requisiti formali (titolo di studio, anni di esperienza, lingue richieste), tipo di contratto (tempo indeterminato, determinato, apprendistato) e il canale di candidatura ufficiale gestito direttamente da ${employer}.`;
      const salaryText =
        typeof avgSalary === 'number'
          ? ` La retribuzione lorda media indicata nelle offerte di questa settimana è di circa CHF ${avgSalary.toLocaleString('it-CH')} all'anno — utile come riferimento per valutare la competitività delle proposte ricevute.`
          : ` Quando ${employer} non pubblica le fasce salariali nelle proprie offerte, fai riferimento all'indagine cantonale Salarium 2024 (USTAT) per la fascia di settore + qualifica + età; per la maggioranza dei profili a Ticino la mediana annua si colloca tra CHF 60.000 e CHF 90.000 lordi a seconda di esperienza e responsabilità, con premi del 5-15 % per cittadini di lingua tedesca e profili senior con esperienza estera.`;
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
      const lowVolumeNote =
        jobsCount <= 3
          ? ` Anche con un volume contenuto di offerte (${jobsCount} questa settimana), un'azienda strutturata come ${employer} valuta normalmente più candidature in parallelo per ogni posizione: aprire la scheda azienda e candidarsi rapidamente alle posizioni in elenco fa la differenza in shortlist.`
          : '';
      const noRolesNote =
        topRoles.length === 0
          ? ` Quando i ruoli non sono ancora classificati nei nostri snapshot — capita per aziende con titoli di offerta poco standardizzati o piccoli settori di nicchia — la classificazione testuale del job-board completa il quadro automaticamente entro 7-14 giorni dalla prima rilevazione.`
          : '';
      return `La scheda settimanale dedicata a ${employer} a ${city} serve a chi sta valutando l'azienda come potenziale datore di lavoro: permette di vedere in un colpo d'occhio quante posizioni sono effettivamente aperte oggi (${jobsCount}), quali famiglie di ruoli sono più rappresentate (${roles}) e come cambia la dimensione del piano assunzioni da una settimana all'altra. È utile soprattutto per chi punta alla candidatura spontanea: un incremento del numero di offerte è spesso il segnale che l'azienda sta espandendo l'organico e valuta con più attenzione i profili inviati fuori da una posizione specifica.${lowVolumeNote}${noRolesNote} Questa pagina è rigenerata automaticamente ogni lunedì mattina: il contenuto riflette lo stato delle offerte al momento della generazione. Per candidarti, apri il singolo annuncio e segui le istruzioni dell'azienda — oppure usa la scheda employer brand (quando disponibile) per un quadro completo di benefit, sedi e FAQ.`;
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
    companyCityFrontalierTitle: (e, c) => `Lavorare per ${e} a ${c} da frontaliere`,
    companyCityFrontalier: ({ employer, city, jobsCount }) => [
      `Permesso e tragitto. Per candidarsi a una delle ${jobsCount} posizioni aperte di ${employer} a ${city} come frontaliere serve la residenza in un comune italiano entro 20 km dal confine svizzero (Lombardia o Piemonte) e il rientro al domicilio almeno una volta a settimana. Il Permesso G viene richiesto dal datore dopo la firma del contratto: la prima emissione richiede 2-6 settimane, poi il rinnovo è annuale fino al limite contrattuale. Da Como il tragitto verso ${city} passa tipicamente dal valico di Brogeda (autostrada A2) o Chiasso-strada con 25-50 minuti in ora di punta a seconda delle code; da Varese o Luino i valichi di Stabio o Gaggiolo offrono alternative. Verifica i tempi di attesa in tempo reale sulla mappa dei valichi prima di stimare l'orario di arrivo per il colloquio o il primo giorno di lavoro.`,
      `Stipendio netto e cosa controllare nelle offerte. ${employer} pubblica le retribuzioni come lordo annuo: per un frontaliere assunto nel ${city} dopo il 1° gennaio 2024 il netto reale dipende dal Nuovo Accordo fiscale Italia-Svizzera (imposta concorrente con credito d'imposta italiano fino all'80 % sulla ritenuta svizzera), dai contributi sociali (AVS-AI-IPG 5,3 %, disoccupazione 1,1 % fino a 148.200 CHF/anno, LPP variabile 7-18 % a seconda dell'età) e dal regime fiscale del cantone. La differenza lordo-netto tipica è 18-28 %. Confronta la retribuzione media di queste ${jobsCount} offerte con i parametri della tua busta paga attuale italiana, calcola il netto effettivo nel <a href="${BASE_URL}/calcola-stipendio/">simulatore stipendio</a> e ricorda di considerare anche i costi del pendolarismo (carburante, usura veicolo, tempo perso) per un confronto onesto.`,
      `Benefit, telelavoro e prospettive di carriera. Oltre allo stipendio lordo, valuta sempre i benefit non monetari quando ${employer} chiama per un colloquio a ${city}: contributo LPP sopra il minimo legale (8-12 % del lordo è il benchmark per ruoli qualificati), 13ª e 14ª mensilità, bonus annuale legato a obiettivi (5-15 % del lordo), giorni di vacanza oltre le 4 settimane di legge (le aziende competitive offrono 5-6 settimane), formazione continua (CHF 1'500-3'500/anno per ruoli senior), copertura assicurativa LCA integrativa e flessibilità di telelavoro. Quest'ultimo punto è critico per i frontalieri: dal 1° gennaio 2024 si può lavorare da casa fino al 25 % del tempo senza perdere lo status fiscale, ma il datore deve esplicitarlo nel contratto. Per ${employer} a ${city} questo significa potenzialmente 1 giorno di telelavoro a settimana — un risparmio reale su carburante, tempo di viaggio e usura del veicolo che cambia il calcolo costo-beneficio del pendolarismo. Verifica il regime concreto in fase di trattativa contrattuale, non dopo la firma.`,
      `Candidatura spontanea e tempi del processo di selezione. Quando questa scheda mostra ${jobsCount} posizioni aperte da ${employer} a ${city}, è un segnale che l'azienda è in fase attiva di assunzione: aggiungere il proprio CV ad una candidatura spontanea — anche fuori dalle posizioni esattamente in linea — ha più probabilità di esito positivo rispetto a un periodo di hiring freeze. Il processo tipico per un frontaliere assunto da ${employer} a ${city} prevede 3-5 step: screening del CV (1-2 settimane), primo colloquio HR telefonico o video (45-60 minuti), 1-2 colloqui tecnici con il futuro responsabile (90-120 minuti ciascuno), eventuale assessment psicometrico o caso pratico, offerta scritta. Tempi totali dalla candidatura all'offerta: 4-8 settimane per le PMI ticinesi, 6-12 settimane per le multinazionali con HR centralizzato. Conta poi 2-6 settimane per l'emissione del Permesso G una volta firmato il contratto. Per i ruoli regolamentati (sanitario, scolastico, finanziario) avvia in parallelo la pratica di equipollenza del titolo italiano presso SBFI/SEFRI: richiede 3-6 mesi e va lanciata prima dell'invio del CV, non dopo.`,
    ],
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
    coldStartBanner: 'First week of data — from next week you will see the change for each company.',
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
          : `The open positions span a range of profiles in ${city}, from operational roles (assistance, warehouse, maintenance) to specialist functions (administration, IT, accounting, project management) — open each listing to see the full job description, formal requirements (degree, years of experience, language skills), contract type (permanent, fixed-term, apprenticeship) and the official application channel managed directly by ${employer}.`;
      const salaryText =
        typeof avgSalary === 'number'
          ? ` The average gross salary quoted in this week's listings is about CHF ${avgSalary.toLocaleString('en-US')} per year — useful as a benchmark to evaluate any offer you receive.`
          : ` When ${employer} doesn't disclose salary bands in its listings, fall back on the cantonal Salarium 2024 survey (USTAT) for the matching sector + qualification + age cohort; for most Ticino profiles the annual median sits between CHF 60,000 and CHF 90,000 gross depending on experience and responsibility, with a 5-15 % premium for German-speakers and senior profiles with foreign experience.`;
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
      const lowVolumeNote =
        jobsCount <= 3
          ? ` Even with a small volume of openings (${jobsCount} this week), a structured employer like ${employer} typically reviews several applications per role in parallel: opening the company hub and applying quickly to listed positions makes the difference at the shortlist stage.`
          : '';
      const noRolesNote =
        topRoles.length === 0
          ? ` When roles aren't yet classified in our snapshots — common for employers with non-standard listing titles or small niche sectors — the job-board's text classifier completes the picture automatically within 7-14 days of the first observation.`
          : '';
      return `This weekly overview of ${employer} in ${city} is aimed at anyone evaluating the company as a potential employer: it shows at a glance how many positions are actually open today (${jobsCount}), which role families are most represented (${roles}), and how the hiring plan shifts from one week to the next. It's especially useful if you're targeting a spontaneous application: a rise in open positions often signals the company is growing its headcount and will take a closer look at profiles sent outside a specific posting.${lowVolumeNote}${noRolesNote} The page is regenerated automatically every Monday morning — the content reflects the state of the openings at generation time. To apply, open the individual listing and follow the company's instructions, or use the employer brand page (when available) for a full overview of benefits, locations and FAQ.`;
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
    companyCityFrontalierTitle: (e, c) => `Working for ${e} in ${c} as a cross-border worker`,
    companyCityFrontalier: ({ employer, city, jobsCount }) => [
      `Permit and commute. To apply to one of the ${jobsCount} active positions at ${employer} in ${city} as a cross-border worker you must reside in an Italian municipality within the 20 km border zone (Lombardy or Piedmont) and return home at least once a week. The G permit is requested by the employer at the cantonal migration office after the contract is signed: first issuance takes 2-6 weeks and is then renewed yearly. From Como the commute to ${city} typically goes through the Brogeda crossing (A2 motorway) or Chiasso-strada, with 25-50 minutes at peak times depending on the queue. From Varese or Luino, the Stabio or Gaggiolo crossings offer alternatives. Check the live border-wait map before sizing the arrival time for an interview or your first day on site.`,
      `Net salary and what to read in the listings. ${employer} posts compensation as gross annual figures: for a cross-border worker hired in ${city} on or after 1 January 2024, the real take-home depends on the Italy-Switzerland fiscal agreement (concurrent taxation with Italian tax credit up to 80 % on the Swiss withholding), social charges (AVS-AI-IPG 5.3 %, unemployment 1.1 % up to CHF 148,200/year, LPP rising from 7 % at 25 to 18 % over 55) and the cantonal tax regime. The typical gross-to-net gap is 18-28 %. Benchmark the average salary across these ${jobsCount} listings against your current Italian payslip, run the actual net figure in the <a href="${BASE_URL}/en/calculate-salary/">salary simulator</a>, and factor in commute costs (fuel, vehicle wear, time lost at the border) for an honest comparison.`,
      `Benefits, remote work and career outlook. Beyond the gross salary, always evaluate non-cash benefits when ${employer} invites you to interview in ${city}: pension (LPP) contribution above the legal minimum (8-12 % of gross is the benchmark for skilled roles), 13th and 14th-month payments, annual bonus tied to targets (5-15 % of gross), holiday entitlement beyond the legal 4-week minimum (competitive employers offer 5-6 weeks), continuous training (CHF 1,500-3,500/year budget for senior roles), supplementary LCA health insurance and remote-work flexibility. The latter is critical for cross-border workers: since 1 January 2024 you can work remotely up to 25 % of the time without losing fiscal status, but the employer must explicitly include it in the contract. For ${employer} in ${city} this potentially means one remote day per week — a real saving on fuel, travel time and vehicle wear that changes the cost-benefit math of commuting. Confirm the actual policy during contract negotiation, not after signing.`,
      `Speculative applications and selection-process timing. When this snapshot shows ${jobsCount} open positions at ${employer} in ${city}, that's a signal the company is actively hiring: adding your CV through a speculative application — even outside an exactly aligned opening — has a much better hit rate than during a hiring freeze. The typical process for a cross-border worker hired by ${employer} in ${city} runs 3-5 steps: CV screening (1-2 weeks), first HR phone or video interview (45-60 minutes), 1-2 technical interviews with the future manager (90-120 minutes each), optional psychometric assessment or take-home case, written offer. Total time from application to offer: 4-8 weeks for Ticino SMEs, 6-12 weeks for multinationals with centralised HR. Add 2-6 weeks for G permit issuance once the contract is signed. For regulated roles (healthcare, school, finance) launch the Italian-title equivalence procedure with SBFI/SEFRI in parallel: it takes 3-6 months and should be started before sending the CV, not after.`,
    ],
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
    coldStartBanner: 'Erste Datenwoche — ab nächster Woche sehen Sie die Veränderung für jedes Unternehmen.',
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
          : `Die offenen Stellen decken eine Bandbreite an Profilen in ${city} ab — von operativen Funktionen (Assistenz, Lager, Wartung) bis zu Fachpositionen (Administration, IT, Buchhaltung, Projektmanagement). Öffnen Sie jede Ausschreibung für die vollständige Stellenbeschreibung, formale Anforderungen (Abschluss, Berufserfahrung, Sprachkenntnisse), Vertragsart (unbefristet, befristet, Lehre) und den offiziellen Bewerbungskanal von ${employer}.`;
      const salaryText =
        typeof avgSalary === 'number'
          ? ` Das durchschnittliche Bruttogehalt in den Ausschreibungen dieser Woche liegt bei rund CHF ${avgSalary.toLocaleString('de-CH')} pro Jahr — nützlich als Orientierung, um ein Angebot einzuordnen.`
          : ` Wenn ${employer} keine Lohnbänder in seinen Ausschreibungen veröffentlicht, orientieren Sie sich an der kantonalen Salarium-2024-Erhebung (USTAT) für die Kombination Branche + Qualifikation + Altersgruppe; für die meisten Tessiner Profile liegt der Jahresmedian je nach Erfahrung und Verantwortung zwischen CHF 60'000 und CHF 90'000 brutto, mit einem Aufschlag von 5-15 % für Deutschsprachige und Senior-Profile mit Auslandserfahrung.`;
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
      const lowVolumeNote =
        jobsCount <= 3
          ? ` Auch bei einem geringen Stellenvolumen (${jobsCount} diese Woche) prüft ein strukturiertes Unternehmen wie ${employer} typischerweise mehrere Bewerbungen pro Position parallel: Wer den Firmen-Hub öffnet und sich rasch auf die gelisteten Stellen bewirbt, gewinnt im Shortlist-Schritt.`
          : '';
      const noRolesNote =
        topRoles.length === 0
          ? ` Wenn die Rollen noch nicht in unseren Snapshots klassifiziert sind — was bei Arbeitgebern mit unkonventionellen Stellentiteln oder kleinen Nischenbranchen vorkommt — schliesst der Textklassifikator des Job-Boards die Lücke automatisch innerhalb von 7-14 Tagen nach der ersten Beobachtung.`
          : '';
      return `Die wöchentliche Übersicht zu ${employer} in ${city} richtet sich an alle, die das Unternehmen als möglichen Arbeitgeber prüfen: Sie sehen auf einen Blick, wie viele Stellen aktuell offen sind (${jobsCount}), welche Rollenfamilien am stärksten vertreten sind (${roles}) und wie sich der Personalplan von Woche zu Woche verändert. Besonders hilfreich ist das für Initiativbewerbungen: Steigt die Zahl der Ausschreibungen, wächst meist der Personalbestand — und die Firma prüft Profile, die außerhalb einer konkreten Ausschreibung eingehen, genauer.${lowVolumeNote}${noRolesNote} Die Seite wird jeden Montagmorgen automatisch neu erstellt; der Inhalt spiegelt den Stand der Stellen zum Zeitpunkt der Erzeugung wider. Für eine Bewerbung die jeweilige Ausschreibung öffnen und den Anweisungen des Unternehmens folgen — oder die Arbeitgeberseite (sofern verfügbar) für einen Überblick zu Benefits, Standorten und FAQ nutzen.`;
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
    companyCityFrontalierTitle: (e, c) => `Als Grenzgänger für ${e} in ${c} arbeiten`,
    companyCityFrontalier: ({ employer, city, jobsCount }) => [
      `Bewilligung und Pendelweg. Um sich auf eine der ${jobsCount} aktiven Stellen bei ${employer} in ${city} als Grenzgänger zu bewerben, müssen Sie in einer italienischen Gemeinde innerhalb der 20-km-Grenzzone (Lombardei oder Piemont) wohnen und mindestens einmal pro Woche nach Hause zurückkehren. Die G-Bewilligung wird vom Arbeitgeber nach Vertragsunterzeichnung beim kantonalen Migrationsamt beantragt: die erste Ausstellung dauert 2-6 Wochen, die jährliche Verlängerung erfolgt anschliessend. Von Como führt der Weg nach ${city} typischerweise über den Grenzübergang Brogeda (Autobahn A2) oder Chiasso-Strasse, mit 25-50 Minuten in Stosszeiten je nach Wartezeit. Von Varese oder Luino bieten Stabio oder Gaggiolo Alternativen. Prüfen Sie die Live-Wartezeitenkarte, bevor Sie die Ankunftszeit für ein Vorstellungsgespräch oder den ersten Arbeitstag berechnen.`,
      `Nettolohn und worauf in den Inseraten zu achten ist. ${employer} gibt Löhne als Bruttojahresgehalt an: Für einen ab dem 1. Januar 2024 in ${city} angestellten Grenzgänger hängt der reale Nettolohn vom neuen Steuerabkommen Italien-Schweiz (konkurrierende Besteuerung, italienische Steuergutschrift bis zu 80 % auf die schweizerische Quellensteuer), den Sozialabgaben (AHV-IV-EO 5,3 %, ALV 1,1 % bis CHF 148'200/Jahr, BVG variabel von 7 % mit 25 Jahren bis 18 % über 55) und der kantonalen Steuerregelung ab. Der typische Brutto-Netto-Abstand beträgt 18-28 %. Vergleichen Sie den Durchschnittslohn dieser ${jobsCount} Inserate mit Ihrer aktuellen italienischen Lohnabrechnung, berechnen Sie den exakten Nettowert im <a href="${BASE_URL}/de/gehalt-berechnen/">Lohnsimulator</a> und beziehen Sie auch die Pendelkosten (Treibstoff, Fahrzeugverschleiss, Zeitverlust an der Grenze) für einen ehrlichen Vergleich mit ein.`,
      `Zusatzleistungen, Telearbeit und Karriereperspektiven. Über das Bruttogehalt hinaus prüfen Sie bei einer Einladung von ${employer} zum Vorstellungsgespräch in ${city} stets die nicht monetären Leistungen: BVG-Beitrag über dem gesetzlichen Minimum (8-12 % des Brutto sind der Benchmark für qualifizierte Rollen), 13. und 14. Monatslohn, an Zielvereinbarungen gekoppelter Bonus (5-15 % des Brutto), Ferienanspruch über den gesetzlichen 4 Wochen (kompetitive Arbeitgeber bieten 5-6 Wochen), Weiterbildung (CHF 1'500-3'500/Jahr für Senior-Rollen), ergänzende LCA-Krankenversicherung und Telearbeit-Flexibilität. Letzteres ist für Grenzgänger entscheidend: seit dem 1. Januar 2024 dürfen Sie bis zu 25 % der Zeit im Homeoffice arbeiten, ohne den Steuerstatus zu verlieren — der Arbeitgeber muss dies aber im Vertrag explizit regeln. Für ${employer} in ${city} bedeutet das potenziell einen Homeoffice-Tag pro Woche — eine reale Ersparnis bei Treibstoff, Reisezeit und Fahrzeugverschleiss, die die Kosten-Nutzen-Rechnung des Pendelns verändert. Bestätigen Sie die konkrete Regelung in der Vertragsverhandlung, nicht erst nach der Unterzeichnung.`,
      `Initiativbewerbung und Zeitablauf des Auswahlverfahrens. Wenn diese Übersicht ${jobsCount} offene Stellen bei ${employer} in ${city} zeigt, ist das ein Signal, dass das Unternehmen aktiv einstellt: das Hinzufügen Ihres Lebenslaufs als Initiativbewerbung — auch ausserhalb einer exakt passenden Stelle — hat deutlich bessere Chancen als in Phasen eines Einstellungsstopps. Der typische Ablauf für einen bei ${employer} in ${city} angestellten Grenzgänger umfasst 3-5 Schritte: CV-Screening (1-2 Wochen), erstes HR-Telefon- oder Videogespräch (45-60 Minuten), 1-2 Fachgespräche mit dem zukünftigen Vorgesetzten (je 90-120 Minuten), optionaler psychometrischer Test oder Case Study, schriftliches Angebot. Gesamtdauer von der Bewerbung bis zum Angebot: 4-8 Wochen bei Tessiner KMU, 6-12 Wochen bei Multinationals mit zentralisierter HR. Plus 2-6 Wochen für die Ausstellung der G-Bewilligung nach Vertragsunterzeichnung. Für regulierte Rollen (Gesundheit, Schule, Finanzen) starten Sie das Anerkennungsverfahren des italienischen Titels beim SBFI/SEFRI parallel: es dauert 3-6 Monate und sollte vor dem Versand des Lebenslaufs gestartet werden, nicht danach.`,
    ],
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
    coldStartBanner: 'Première semaine de données — dès la semaine prochaine vous verrez la variation pour chaque entreprise.',
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
          : `Les postes ouverts couvrent plusieurs profils à ${city}, du soutien opérationnel (assistance, magasin, maintenance) aux fonctions spécialisées (administration, IT, comptabilité, gestion de projets) — ouvrez chaque annonce pour voir le descriptif complet, les exigences formelles (diplôme, années d'expérience, compétences linguistiques), le type de contrat (CDI, CDD, apprentissage) et le canal de candidature officiel géré directement par ${employer}.`;
      const salaryText =
        typeof avgSalary === 'number'
          ? ` Le salaire brut moyen affiché dans les offres de cette semaine est d'environ CHF ${avgSalary.toLocaleString('fr-CH')} par an — un repère utile pour évaluer une proposition.`
          : ` Quand ${employer} ne publie pas les fourchettes salariales dans ses offres, appuyez-vous sur l'enquête cantonale Salarium 2024 (USTAT) pour la combinaison secteur + qualification + cohorte d'âge ; pour la plupart des profils tessinois, la médiane annuelle se situe entre CHF 60'000 et CHF 90'000 bruts selon l'expérience et la responsabilité, avec une prime de 5-15 % pour les germanophones et les profils seniors avec expérience à l'étranger.`;
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
      const lowVolumeNote =
        jobsCount <= 3
          ? ` Même avec un volume d'offres limité (${jobsCount} cette semaine), un employeur structuré comme ${employer} examine généralement plusieurs candidatures par poste en parallèle : ouvrir la fiche entreprise et postuler rapidement aux postes listés fait la différence à l'étape de la shortlist.`
          : '';
      const noRolesNote =
        topRoles.length === 0
          ? ` Lorsque les rôles ne sont pas encore classés dans nos snapshots — fréquent pour des employeurs aux titres d'offres atypiques ou de petits secteurs de niche — le classifieur textuel du tableau d'offres complète le tableau automatiquement dans les 7 à 14 jours suivant la première observation.`
          : '';
      return `Cette fiche hebdomadaire consacrée à ${employer} à ${city} s'adresse à celles et ceux qui évaluent l'entreprise comme employeur potentiel : elle montre d'un coup d'œil combien de postes sont réellement ouverts aujourd'hui (${jobsCount}), quelles familles de rôles sont les plus représentées (${roles}) et comment le plan de recrutement évolue d'une semaine à l'autre. Particulièrement utile pour les candidatures spontanées : une hausse du nombre d'offres signale souvent que l'entreprise accroît ses effectifs et examine avec plus d'attention les profils envoyés en dehors d'un poste précis.${lowVolumeNote}${noRolesNote} La page est régénérée automatiquement chaque lundi matin ; le contenu reflète l'état des offres au moment de la génération. Pour postuler, ouvrez l'annonce individuelle et suivez les instructions de l'entreprise — ou utilisez la page employeur (si disponible) pour un aperçu complet des avantages, des sites et de la FAQ.`;
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
    companyCityFrontalierTitle: (e, c) => `Travailler pour ${e} à ${c} en tant que frontalier`,
    companyCityFrontalier: ({ employer, city, jobsCount }) => [
      `Permis et trajet. Pour postuler à l'un des ${jobsCount} postes ouverts chez ${employer} à ${city} en tant que frontalier, vous devez résider dans une commune italienne située dans la zone frontière des 20 km (Lombardie ou Piémont) et rentrer chez vous au moins une fois par semaine. Le permis G est demandé par l'employeur à l'office cantonal des migrations après la signature du contrat : la première délivrance prend 2 à 6 semaines, puis le permis est renouvelé chaque année. Depuis Côme, le trajet vers ${city} passe en général par le poste-frontière de Brogeda (autoroute A2) ou par Chiasso-route, en 25-50 minutes aux heures de pointe selon la file. Depuis Varèse ou Luino, les passages de Stabio ou Gaggiolo offrent des alternatives. Vérifiez la carte des temps d'attente en direct avant d'estimer l'heure d'arrivée pour un entretien ou le premier jour de travail.`,
      `Salaire net et points à vérifier dans les offres. ${employer} publie les rémunérations en brut annuel : pour un frontalier engagé à ${city} à partir du 1er janvier 2024, le net réel dépend du nouvel accord fiscal Italie-Suisse (imposition concurrente, crédit d'impôt italien jusqu'à 80 % sur la retenue suisse), des charges sociales (AVS-AI-APG 5,3 %, chômage 1,1 % jusqu'à CHF 148'200/an, LPP variable de 7 % à 25 ans à 18 % au-delà de 55 ans) et du régime fiscal cantonal. L'écart brut-net typique est de 18 à 28 %. Comparez le salaire moyen de ces ${jobsCount} offres à votre fiche de paie italienne actuelle, calculez le net exact dans le <a href="${BASE_URL}/fr/calculer-salaire/">simulateur de salaire</a> et tenez compte des coûts du trajet (carburant, usure du véhicule, temps perdu à la frontière) pour une comparaison honnête.`,
      `Avantages, télétravail et perspectives de carrière. Au-delà du salaire brut, évaluez toujours les avantages non monétaires lorsque ${employer} vous invite à un entretien à ${city} : cotisation LPP au-delà du minimum légal (8-12 % du brut est le benchmark pour les postes qualifiés), 13e et 14e mois, bonus annuel indexé sur des objectifs (5-15 % du brut), congés au-delà du minimum légal de 4 semaines (les employeurs compétitifs offrent 5-6 semaines), formation continue (budget CHF 1'500-3'500/an pour les postes seniors), assurance maladie complémentaire LCA et flexibilité du télétravail. Ce dernier point est critique pour les frontaliers : depuis le 1er janvier 2024, vous pouvez télétravailler jusqu'à 25 % du temps sans perdre votre statut fiscal, mais l'employeur doit l'inscrire explicitement dans le contrat. Pour ${employer} à ${city}, cela représente potentiellement un jour de télétravail par semaine — une économie réelle sur le carburant, le temps de trajet et l'usure du véhicule qui modifie le calcul coût-bénéfice du pendulariat. Confirmez le régime concret au moment de la négociation contractuelle, pas après la signature.`,
      `Candidature spontanée et délais du processus de sélection. Lorsque ce panorama indique ${jobsCount} postes ouverts chez ${employer} à ${city}, c'est un signal que l'entreprise est en phase active de recrutement : ajouter votre CV via une candidature spontanée — même hors d'une offre parfaitement alignée — a un taux de succès bien supérieur à une phase de gel des embauches. Le processus typique pour un frontalier engagé par ${employer} à ${city} comporte 3 à 5 étapes : sélection du CV (1-2 semaines), premier entretien RH téléphonique ou vidéo (45-60 minutes), 1 à 2 entretiens techniques avec le futur responsable (90-120 minutes chacun), évaluation psychométrique ou étude de cas en option, offre écrite. Délais totaux de la candidature à l'offre : 4-8 semaines pour les PME tessinoises, 6-12 semaines pour les multinationales à RH centralisée. Comptez ensuite 2-6 semaines pour la délivrance du permis G après signature du contrat. Pour les rôles réglementés (santé, école, finance) lancez la procédure d'équivalence du titre italien auprès du SBFI/SEFRI en parallèle : elle prend 3 à 6 mois et doit être initiée avant l'envoi du CV, pas après.`,
    ],
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
  /**
   * Set of company slugs for which a canonical `/cerca-lavoro-ticino/azienda-{slug}/`
   * page exists. Built from `data/all-known-job-slugs.json` by the plugin.
   * When omitted (e.g. in tests), only EMPLOYER_BRANDS lookups are used.
   */
  knownSlugs?: ReadonlySet<string>;
  /** Repository root — enables `public/images/brands/*.png` lookup for company logos. */
  rootDir?: string;
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

function employerBrandPath(
  employerKey: string | undefined,
  employerName?: string,
  knownSlugs?: ReadonlySet<string>,
): string | null {
  if (!employerKey) return null;
  const key = String(employerKey).toLowerCase();
  // Priority 1: EMPLOYER_BRANDS curated registry.
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
  // Priority 2: canonical page registry (all-known-job-slugs.json).
  if (knownSlugs && employerName) {
    const canonical = employerCanonicalHref(employerName, knownSlugs);
    if (canonical) return canonical;
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
    knownSlugs,
    rootDir,
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

  // Alternates to other locales for the same (city, variant). Shared helper
  // emits 4 locales + x-default on the canonical host.
  const hreflangPaths = WEEKLY_EMPLOYERS_LOCALES.reduce<Record<WeeklyEmployersLocale, string>>(
    (acc, alt) => {
      acc[alt] =
        variant === 'current'
          ? buildCurrentWeekPath(alt, city)
          : buildArchiveWeekPath(alt, city, weekNum, year);
      return acc;
    },
    { it: '', en: '', de: '', fr: '' },
  );
  const alternatesHtml = renderHreflangTags(hreflangPaths as HreflangPaths);

  // Single cold-start banner: shown once above the list when ALL cards are in
  // initial-data state (no historical delta available yet). Suppresses the
  // per-card "coldStart" label to avoid 20× repetition of the same sentence.
  const coldStartBannerHtml = !hasHistoricalDelta
    ? `<aside style="margin:0 0 16px;padding:14px 16px;border-radius:12px;background:var(--color-surface-alt);border:1px solid var(--color-edge);color:var(--color-subtle);font-size:14px;line-height:1.6" role="note">${esc(copy.coldStartBanner)}</aside>`
    : '';

  // Top companies rendering
  const jobBoardSectionByLocale: Record<WeeklyEmployersLocale, string> = {
    it: 'cerca-lavoro-ticino',
    en: 'find-jobs-ticino',
    de: 'jobs-im-tessin',
    fr: 'trouver-emploi-tessin',
  };
  const topCompaniesHtml =
    stats.topCompanies.length > 0
      ? `${coldStartBannerHtml}<ol style="list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:10px;counter-reset:seo-rank">${stats.topCompanies
          .map((c, idx) => {
            const brandHref = employerBrandPath(c.employerKey, c.employer, knownSlugs);
            // When no historical delta exists at all, suppress the per-card
            // coldStart label (shown once above as a banner instead).
            const deltaLabel =
              !hasHistoricalDelta
                ? null
                : c.delta > 0
                ? copy.deltaPositive(c.delta)
                : copy.deltaZero;
            const needsReview =
              enableAutoStubs && !brandHref && c.active >= 3 && idx < 3;
            const localePrefix = WEEKLY_EMPLOYERS_LOCALE_PREFIX[locale];
            const companyFallbackHref = (`${localePrefix}/${jobBoardSectionByLocale[locale]}/?q=${encodeURIComponent(c.employer)}`).replace(/\/\/+/g, '/');
            const href = brandHref ?? companyFallbackHref;
            const subtitle = deltaLabel
              ? `${cityDisplay} · ${deltaLabel}`
              : cityDisplay;
            const logoSlug = c.employerKey || slugifyEmployer(c.employer);
            const logoUrl = rootDir ? resolveBrandLogoUrl(rootDir, logoSlug) : null;
            const card = renderEntityCard({
              href,
              title: `${idx + 1}. ${c.employer}`,
              subtitle,
              metric: copy.jobsCountLabel(c.active),
              metricTone: c.delta > 0 ? 'success' : 'default',
              logoUrl: logoUrl ?? undefined,
              logoAlt: c.employer,
              iconSvg: logoUrl ? undefined : ICON_BUILDING_SVG,
            });
            // Preserve the auto-employer-stub review marker on the list item
            // (no production code currently reads it, but it existed for
            // potential editorial tooling — keep the signal alive).
            const reviewAttr = needsReview ? ' data-needs-editorial-review="true"' : '';
            return `<li style="margin:0;padding:0"${reviewAttr}>${card}</li>`;
          })
          .join('')}</ol>`
      : `<p style="padding:14px 16px;border-radius:12px;background:var(--color-warning-subtle);color:var(--color-warning)">${esc(copy.topCompaniesEmpty)}</p>`;

  const newcomersHtml =
    stats.newcomers.length > 0
      ? `<ul style="list-style:disc;padding-left:20px;margin:0 0 0 4px;color:var(--color-body);line-height:1.7">${stats.newcomers
          .map((n) => {
            const newcomerHref = employerBrandPath(n.employerKey, n.employer, knownSlugs);
            const nameHtml = newcomerHref
              ? `<a href="${esc(newcomerHref)}" style="color:var(--color-link);text-decoration:none;font-weight:700">${esc(n.employer)}</a>`
              : `<strong>${esc(n.employer)}</strong>`;
            return `<li>${nameHtml} — ${esc(copy.jobsCountLabel(n.active))}</li>`;
          })
          .join('')}</ul>`
      : `<p style="color:var(--color-subtle);line-height:1.7">${esc(copy.newcomersEmpty)}</p>`;

  const jobBoardSearchBase: Record<WeeklyEmployersLocale, string> = {
    it: '/cerca-lavoro-ticino/',
    en: '/en/find-jobs-ticino/',
    de: '/de/jobs-im-tessin/',
    fr: '/fr/trouver-emploi-tessin/',
  };
  // Map common role slugs to a SECTOR_HUB_KEY. Promotes the role link to
  // the canonical sector hub when available (closes the link-equity leak
  // toward `noindex` `?q=` URLs); falls back to keyword search otherwise.
  const ROLE_TO_SECTOR_HUB: Record<string, SectorHubKey> = {
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
  const rolesHtml =
    stats.topRoles.length > 0
      ? `<ul style="list-style:disc;padding-left:20px;margin:0 0 0 4px;color:var(--color-body);line-height:1.7">${stats.topRoles
          .map((r) => {
            const roleSlug = slugifyEmployer(r.role);
            const sectorKey = ROLE_TO_SECTOR_HUB[roleSlug.toLowerCase()];
            const roleHref = sectorKey && (SECTOR_HUB_KEYS as readonly string[]).includes(sectorKey)
              ? buildSectorHubPath(locale, sectorKey)
              : `${jobBoardSearchBase[locale]}?q=${encodeURIComponent(roleSlug || r.role)}`;
            return `<li><a href="${esc(roleHref)}" style="color:var(--color-link);text-decoration:none;text-transform:capitalize">${esc(r.role)}</a> — ${esc(copy.jobsCountLabel(r.count))}</li>`;
          })
          .join('')}</ul>`
      : `<p style="color:var(--color-subtle);line-height:1.7">${esc(copy.rolesEmpty)}</p>`;

  // Related links: city hub + first employer brand (if present)
  const relatedLinks: string[] = [];
  relatedLinks.push(
    `<a href="${esc(cityJobsHubPath(locale, city))}" style="${LINK_ACCENT_STYLE}">${esc(copy.relatedLinksCityHub(cityDisplay))}</a>`,
  );
  const firstEmployerWithBrand = stats.topCompanies.find(
    (c) => !!employerBrandPath(c.employerKey, c.employer, knownSlugs),
  );
  if (firstEmployerWithBrand) {
    const href = employerBrandPath(firstEmployerWithBrand.employerKey, firstEmployerWithBrand.employer, knownSlugs)!;
    relatedLinks.push(
      `<a href="${esc(href)}" style="${LINK_ACCENT_STYLE}">${esc(copy.relatedLinksEmployerBrand(firstEmployerWithBrand.employer))}</a>`,
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
    itemListElement: stats.topCompanies.map((c, idx) => ({
      '@type': 'ListItem',
      position: idx + 1,
      item: {
        '@type': 'Organization',
        name: c.employer,
        url: employerBrandPath(c.employerKey, c.employer, knownSlugs)
          ? `${BASE_URL}${employerBrandPath(c.employerKey, c.employer, knownSlugs)}`
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
  // Phase 3A — Semrush W2 (≤60 char). Build a compact keyword-first title
  // and only append the brand suffix when it still fits the budget.
  const titleKeywordIt =
    locale === 'it' ? 'Aziende che assumono'
    : locale === 'en' ? 'Companies hiring'
    : locale === 'de' ? 'Firmen, die einstellen'
    : 'Entreprises qui recrutent';
  const titleQualifier =
    variant === 'current'
      ? (companiesCount > 0
          ? (locale === 'it' ? `${companiesCount} datori` : locale === 'en' ? `${companiesCount} employers` : locale === 'de' ? `${companiesCount} Firmen` : `${companiesCount} employeurs`)
          : undefined)
      : `W${weekNum} ${year}`;
  const titleBase = (() => {
    const parts = [titleKeywordIt, cityDisplay].join(locale === 'it' ? ' a ' : locale === 'en' ? ' in ' : locale === 'de' ? ' in ' : ' à ');
    return titleQualifier ? `${parts} — ${titleQualifier}` : parts;
  })();
  const cityTitleClamped = titleBase.length <= 60 ? titleBase : titleBase.slice(0, 60).replace(/[\s,—-]+$/u, '');
  const title = clampSiteSuffix(cityTitleClamped, 'Frontaliere Ticino');
  // H1 narrative differs from title (Semrush W3): keep the locale-specific
  // verbose phrasing already in COPY[] which always carries "questa settimana"
  // / "this week" / "diese Woche" / "cette semaine".
  void h1; // h1 is already differentiated from title; declared above.
  const description = heroSummary.slice(0, 180);

  const archiveNote =
    variant === 'archive' && !indexable
      ? `<p style="margin:0 0 16px;color:var(--color-warning);background:var(--color-warning-subtle);padding:10px 14px;border-radius:12px;font-size:14px">${esc(copy.archiveNoindexNote)}</p>`
      : '';

  const bodyHtml = `<article style="max-width:1100px;margin:0 auto;padding:32px 20px 56px">
  <nav style="${BREADCRUMB_STYLE}" aria-label="breadcrumb">
    <a href="${BASE_URL}/" style="${BREADCRUMB_LINK_STYLE}">${esc(copy.breadcrumbHome)}</a>
    <span> / </span>
    <span>${esc(copy.sectionLabel)}</span>
    <span> / </span>
    <span>${esc(cityDisplay)}</span>
  </nav>
  <header style="margin-bottom:22px">
    <p style="${HERO_EYEBROW_STYLE}">${esc(kicker)} · ${esc(copy.updatedLabel)} ${dateStamp}</p>
    <h1 style="${H1_STYLE}">${esc(h1)}</h1>
    <p style="${LEDE_STYLE}">${esc(heroSummary)}</p>
    <p style="margin:0;color:var(--color-body);line-height:1.7;max-width:860px">${esc(intro)}</p>
  </header>
  ${archiveNote}
  <section style="margin:0 0 28px" aria-labelledby="topCompanies">
    <h2 id="topCompanies" style="${H2_STYLE}">${esc(copy.topCompaniesTitle)}</h2>
    ${topCompaniesHtml}
  </section>
  <section style="margin:0 0 28px" aria-labelledby="newcomers">
    <h2 id="newcomers" style="${H2_STYLE}">${esc(copy.newcomersTitle)}</h2>
    <p style="margin:0 0 10px;color:var(--color-body);line-height:1.65;max-width:860px">${esc(copy.newcomersDesc)}</p>
    ${newcomersHtml}
  </section>
  <section style="margin:0 0 28px" aria-labelledby="roles">
    <h2 id="roles" style="${H2_STYLE}">${esc(copy.rolesTitle)}</h2>
    ${rolesHtml}
  </section>
  <section style="margin:0 0 28px" aria-labelledby="editorial">
    <h2 id="editorial" style="${H2_STYLE}">${esc(cityDisplay)}</h2>
    <p style="margin:0 0 10px;color:var(--color-body);line-height:1.7;max-width:860px">${esc(editorial)}</p>
    <p style="margin:0;color:var(--color-subtle);line-height:1.7;max-width:860px;font-size:14px">${esc(methodology)}</p>
  </section>
  <section style="margin:0 0 28px" aria-labelledby="relatedLinks">
    <h2 id="relatedLinks" style="${H2_STYLE}">${esc(copy.relatedLinksTitle)}</h2>
    ${relatedHtml}
  </section>
  <section style="margin:0 0 0" aria-labelledby="weeklyFaq">
    <h2 id="weeklyFaq" style="${H2_STYLE}">${esc(copy.faqTitle)}</h2>
    <details style="${CARD_STYLE};margin-bottom:8px">
      <summary style="font-weight:700;cursor:pointer;color:var(--color-heading)">${esc(copy.faqHowOftenQ)}</summary>
      <p style="margin:10px 0 0;color:var(--color-body);line-height:1.6">${esc(copy.faqHowOftenA)}</p>
    </details>
    <details style="${CARD_STYLE};margin-bottom:8px">
      <summary style="font-weight:700;cursor:pointer;color:var(--color-heading)">${esc(copy.faqDeltaQ)}</summary>
      <p style="margin:10px 0 0;color:var(--color-body);line-height:1.6">${esc(copy.faqDeltaA)}</p>
    </details>
    <details style="${CARD_STYLE};margin-bottom:8px">
      <summary style="font-weight:700;cursor:pointer;color:var(--color-heading)">${esc(copy.faqApplyQ)}</summary>
      <p style="margin:10px 0 0;color:var(--color-body);line-height:1.6">${esc(copy.faqApplyA)}</p>
    </details>
  </section>
  ${renderDiscoverMore(locale, WEEKLY_EMPLOYERS_DISCOVER_MORE_CTAS[locale])}
  ${generateRelatedLinksBlock(locale, 'weekly_employers', { city, weeklyCity: city })}
</article>`;

  // Extra head: OG image dims + twitter card — matches pre-shell-wrap output.
  const extraHead = `    <meta property="og:image" content="${BASE_URL}/og-image.png">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${esc(title)}">
    <meta name="twitter:description" content="${esc(description)}">
    <meta name="twitter:site" content="@frontaliereticino">`;

  // `alternatesHtml` already includes x-default via the shared helper.
  const hreflangHtml = alternatesHtml;

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
    hubChrome: { hubKey: 'job-board', activeSubTab: 'jobs' },
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
  /**
   * Set of company slugs for which a canonical `/cerca-lavoro-ticino/azienda-{slug}/`
   * page exists. When omitted, only EMPLOYER_BRANDS lookups are used.
   */
  knownSlugs?: ReadonlySet<string>;
  /** Repository root — enables `public/images/brands/*.png` lookup for the company logo. */
  rootDir?: string;
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

// JOB_DESC_FALLBACK and computeValidThrough previously lived here. Both are
// now encapsulated inside `buildJobPostingSchema` so every emitter shares
// the same locale-aware descriptions and validThrough heuristics.

function jobToJsonLd(
  job: CompanyCityActiveJob,
  employer: string,
  city: string,
  locale: WeeklyEmployersLocale = 'it',
): Record<string, unknown> {
  // Map the weekly-employers `CompanyCityActiveJob` shape onto the canonical
  // `JobInput` contract and delegate to the shared builder. This keeps all
  // mandatory-field enforcement (CLAUDE.md rule #3) in one place.
  const input: JobInput = {
    id: job.slug || job.detailPath,
    slug: job.slug,
    title: job.title || OPEN_POSITION_LABEL[locale],
    description: job.description,
    company: employer,
    companySlug: job.companySlug,
    city,
    addressLocality: job.addressLocality,
    addressRegion: job.addressRegion,
    postalCode: job.postalCode,
    streetAddress: job.streetAddress,
    postedDate: job.postedDate,
    crawledAt: job.crawledAt,
    validThrough: job.validThrough,
    employmentType: job.employmentType,
    salaryMin: typeof job.salaryMin === 'number' ? job.salaryMin : null,
    salaryMax: typeof job.salaryMax === 'number' ? job.salaryMax : null,
    salaryCurrency: job.salaryCurrency,
    url: job.detailPath ? `${BASE_URL}${job.detailPath}` : undefined,
  };
  const schema = buildJobPostingSchema(input, {
    locale,
    url: `${BASE_URL}${job.detailPath}`,
    baseUrl: BASE_URL,
  });
  // Emit the schema.org block without the `@context` (the parent graph
  // declares it at the document level).
  const { '@context': _omit, ...rest } = schema as unknown as Record<string, unknown>;
  return rest;
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
    knownSlugs,
    rootDir,
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
  // Shared helper emits 4 locales + x-default on the canonical host.
  const hreflangPaths = WEEKLY_EMPLOYERS_LOCALES.reduce<Record<WeeklyEmployersLocale, string>>(
    (acc, alt) => {
      acc[alt] =
        variant === 'current'
          ? buildCompanyCityCurrentPath(alt, city, companySlug)
          : buildCompanyCityArchivePath(alt, city, companySlug, weekNum, year);
      return acc;
    },
    { it: '', en: '', de: '', fr: '' },
  );
  const hreflangHtml = renderHreflangTags(hreflangPaths as HreflangPaths);

  // Brand logo — prefer the curated `CRAWLED_COMPANY_LOGOS` registry (same
  // source the SPA job-board uses, so cards on this page match the listing
  // exactly). Falls back to a local `public/images/brands/{slug}.png` if the
  // registry has no entry, then to the neutral building icon.
  const brandLogoSlug = stats.employerKey || slugifyEmployer(employer);
  const brandLogoUrl =
    (CRAWLED_COMPANY_LOGOS[brandLogoSlug] as string | undefined) ??
    (rootDir ? resolveBrandLogoUrl(rootDir, brandLogoSlug) : null);
  // Static-page mirror of `services/logoService.ts` `handleCompanyLogoError`:
  // Clearbit → Google favicon → /icons/company-placeholder.svg, guarded
  // against infinite loops via `data-lf`. Inline because static HTML cannot
  // attach React onError handlers.
  const LOGO_ONERROR = `if(this.dataset.lf==='ph')return;if(this.src.indexOf('logo.clearbit.com')>-1){var d=this.src.replace(/^https?:\\/\\/logo\\.clearbit\\.com\\//,'').split(/[\\/?#]/)[0];if(d){this.src='https://www.google.com/s2/favicons?domain='+encodeURIComponent(d)+'&sz=128';this.dataset.lf='gf';return;}}this.src='/icons/company-placeholder.svg';this.dataset.lf='ph';this.style.visibility='visible';`;
  const headerLogoHtml = brandLogoUrl
    ? `<img src="${esc(brandLogoUrl)}" alt="Logo ${esc(employer)}" width="80" height="80" loading="eager" decoding="async" onerror="${LOGO_ONERROR}" style="display:block;width:80px;height:80px;border-radius:16px;object-fit:contain;background:var(--color-surface-alt);border:1px solid var(--color-edge);flex-shrink:0">`
    : `<span aria-hidden="true" style="display:flex;align-items:center;justify-content:center;width:80px;height:80px;border-radius:16px;background:var(--color-surface-alt);border:1px solid var(--color-edge);color:var(--color-subtle);flex-shrink:0">${ICON_BUILDING_SVG}</span>`;

  // Localized labels for the job-card pills (employment type + salary suffix).
  const empTypeLabel: Record<string, string> = (
    {
      it: { FULL_TIME: 'Tempo pieno', PART_TIME: 'Tempo parziale', CONTRACTOR: 'Contratto', TEMPORARY: 'Temporaneo', INTERN: 'Stage', PER_DIEM: 'A giornata', OTHER: 'Altro' },
      en: { FULL_TIME: 'Full-time', PART_TIME: 'Part-time', CONTRACTOR: 'Contract', TEMPORARY: 'Temporary', INTERN: 'Internship', PER_DIEM: 'Per diem', OTHER: 'Other' },
      de: { FULL_TIME: 'Vollzeit', PART_TIME: 'Teilzeit', CONTRACTOR: 'Vertrag', TEMPORARY: 'Befristet', INTERN: 'Praktikum', PER_DIEM: 'Tageweise', OTHER: 'Sonstige' },
      fr: { FULL_TIME: 'Temps plein', PART_TIME: 'Temps partiel', CONTRACTOR: 'Contrat', TEMPORARY: 'Temporaire', INTERN: 'Stage', PER_DIEM: 'Journalier', OTHER: 'Autre' },
    } as Record<WeeklyEmployersLocale, Record<string, string>>
  )[locale];
  const salarySuffix: Record<WeeklyEmployersLocale, string> = {
    it: '/anno',
    en: '/yr',
    de: '/Jahr',
    fr: '/an',
  };
  const numberLocale: Record<WeeklyEmployersLocale, string> = {
    it: 'it-CH',
    en: 'en-US',
    de: 'de-CH',
    fr: 'fr-CH',
  };
  // Inline lucide-style icons (24×24 via stroke=currentColor).
  const ICON_PIN = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>';
  const ICON_CLOCK = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';
  const ICON_EURO = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 10h12"/><path d="M4 14h9"/><path d="M19 6a4 4 0 0 0-4-4H4v20h11a4 4 0 0 0 0-8"/></svg>';

  const formatSalary = (job: CompanyCityActiveJob): string | null => {
    const cur = (job.salaryCurrency || 'CHF').toUpperCase();
    const fmt = (n: number) => n.toLocaleString(numberLocale[locale]);
    if (typeof job.salaryMin === 'number' && typeof job.salaryMax === 'number' && job.salaryMin > 0 && job.salaryMax > 0) {
      return job.salaryMin === job.salaryMax
        ? `${cur} ${fmt(job.salaryMin)}${salarySuffix[locale]}`
        : `${cur} ${fmt(job.salaryMin)}–${fmt(job.salaryMax)}${salarySuffix[locale]}`;
    }
    if (typeof job.salaryMin === 'number' && job.salaryMin > 0) return `${cur} ${fmt(job.salaryMin)}${salarySuffix[locale]}`;
    if (typeof job.salaryMax === 'number' && job.salaryMax > 0) return `${cur} ${fmt(job.salaryMax)}${salarySuffix[locale]}`;
    return null;
  };

  // Job list (≤10) — styled as job-board cards: logo · title · company·city
  // subtitle · salary · location/contract/posted-date pill row.
  const jobCardLogoHtml = brandLogoUrl
    ? `<img src="${esc(brandLogoUrl)}" alt="Logo ${esc(employer)}" width="40" height="40" loading="lazy" decoding="async" onerror="${LOGO_ONERROR}" style="display:block;width:40px;height:40px;border-radius:10px;object-fit:contain;background:var(--color-surface-alt);border:1px solid var(--color-edge);flex-shrink:0">`
    : `<span aria-hidden="true" style="display:flex;align-items:center;justify-content:center;width:40px;height:40px;border-radius:10px;background:var(--color-surface-alt);border:1px solid var(--color-edge);color:var(--color-subtle);flex-shrink:0">${ICON_BUILDING_SVG}</span>`;

  const jobsListHtml =
    stats.activeJobs.length > 0
      ? `<ol style="list-style:none;padding:0;margin:0;display:grid;grid-template-columns:1fr;gap:10px">${stats.activeJobs
          .map((job, idx) => {
            const title = esc(job.title || `Posizione ${idx + 1}`);
            const localityRaw = job.addressLocality || cityDisplay;
            const locality = esc(localityRaw);
            const datePill = job.postedDate
              ? `<span style="display:inline-flex;align-items:center;gap:4px;color:var(--color-subtle)">${ICON_CLOCK}${esc(String(job.postedDate).slice(0, 10))}</span>`
              : '';
            const empType = job.employmentType && empTypeLabel[job.employmentType] ? empTypeLabel[job.employmentType] : null;
            const empPill = empType
              ? `<span style="padding:2px 8px;border-radius:6px;background:var(--color-surface-alt);color:var(--color-subtle)">${esc(empType)}</span>`
              : '';
            const salaryStr = formatSalary(job);
            const salaryHtml = salaryStr
              ? `<span style="margin-top:6px;display:inline-flex;align-items:center;gap:4px;font-size:13px;font-weight:700;color:var(--color-success)">${ICON_EURO}${esc(salaryStr)}</span>`
              : '';
            return `<li style="margin:0;padding:0">
      <article style="${CARD_STYLE}">
        <a href="${esc(job.detailPath)}" style="display:block;color:inherit;text-decoration:none">
          <div style="display:flex;align-items:flex-start;gap:12px">
            ${jobCardLogoHtml}
            <div style="min-width:0;flex:1">
              <h3 style="margin:0;font-size:16px;font-weight:700;color:var(--color-heading);line-height:1.3">${idx + 1}. ${title}</h3>
              <p style="margin:4px 0 0;font-size:13px;color:var(--color-subtle);line-height:1.4">${esc(employer)} · ${locality}</p>
              ${salaryHtml}
            </div>
          </div>
          <div style="margin-top:12px;display:flex;flex-wrap:wrap;align-items:center;gap:8px;font-size:12px;color:var(--color-subtle)">
            <span style="display:inline-flex;align-items:center;gap:4px">${ICON_PIN}${locality}</span>
            ${empPill}
            ${datePill}
            <span style="margin-left:auto;color:var(--color-link);font-weight:600;font-size:13px">${esc(copy.companyCityApplyCta)} →</span>
          </div>
        </a>
      </article>
    </li>`;
          })
          .join('')}</ol>`
      : `<p style="padding:14px 16px;border-radius:12px;background:var(--color-warning-subtle);color:var(--color-warning)">${esc(copy.topCompaniesEmpty)}</p>`;

  // Related links (own + cross-feature via shared helper).
  const parentHubHref = buildCurrentWeekPath(locale, city);
  const cityJobsHref = cityJobsHubPath(locale, city);
  const brandHref = employerBrandPath(stats.employerKey, employer, knownSlugs);

  const ownRelated: string[] = [];
  if (brandHref) {
    ownRelated.push(
      `<li style="margin:0;padding:0"><a href="${esc(brandHref)}" style="display:inline-block;padding:8px 0;${LINK_ACCENT_STYLE};font-weight:600">${esc(copy.companyCityBrandHubLabel(employer))} →</a></li>`,
    );
  }
  ownRelated.push(
    `<li style="margin:0;padding:0"><a href="${esc(parentHubHref)}" style="display:inline-block;padding:8px 0;${LINK_ACCENT_STYLE};font-weight:600">${esc(copy.companyCityParentHubLabel(cityDisplay))} →</a></li>`,
  );
  ownRelated.push(
    `<li style="margin:0;padding:0"><a href="${esc(cityJobsHref)}" style="display:inline-block;padding:8px 0;${LINK_ACCENT_STYLE};font-weight:600">${esc(copy.companyCityCityHubLabel(cityDisplay))} →</a></li>`,
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
  // Phase 3A — keyword-first compact title (≤60 char preferred).
  const compactBase = (() => {
    const sep = locale === 'it' ? ' a ' : locale === 'en' ? ' in ' : locale === 'de' ? ' in ' : ' à ';
    const head = `${employer}${sep}${cityDisplay}`;
    const qualifier =
      variant === 'current'
        ? (locale === 'it' ? 'offerte aperte' : locale === 'en' ? 'open jobs' : locale === 'de' ? 'offene Stellen' : 'offres ouvertes')
        : `W${weekNum} ${year}`;
    return `${head} — ${qualifier}`;
  })();
  const compactClamped = compactBase.length <= 60 ? compactBase : compactBase.slice(0, 60).replace(/[\s,—-]+$/u, '');
  const title = clampSiteSuffix(compactClamped, 'Frontaliere Ticino');
  const description = heroSummary.slice(0, 180);

  const archiveNote =
    variant === 'archive' && !indexable
      ? `<p style="margin:0 0 16px;color:var(--color-warning);background:var(--color-warning-subtle);padding:10px 14px;border-radius:12px;font-size:14px">${esc(copy.archiveNoindexNote)}</p>`
      : '';

  const bodyHtml = `<article style="max-width:1100px;margin:0 auto;padding:32px 20px 56px">
  <nav style="${BREADCRUMB_STYLE}" aria-label="breadcrumb">
    <a href="${BASE_URL}/" style="${BREADCRUMB_LINK_STYLE}">${esc(copy.breadcrumbHome)}</a>
    <span> / </span>
    <a href="${BASE_URL}${WEEKLY_EMPLOYERS_LOCALE_PREFIX[locale]}/${WEEKLY_EMPLOYERS_SECTION[locale]}/ticino/${WEEKLY_EMPLOYERS_CURRENT_SLUG[locale]}/" style="${BREADCRUMB_LINK_STYLE}">${esc(copy.sectionLabel)}</a>
    <span> / </span>
    <a href="${esc(parentHubHref)}" style="${BREADCRUMB_LINK_STYLE}">${esc(cityDisplay)}</a>
    <span> / </span>
    <span>${esc(employer)}</span>
  </nav>
  <header style="margin-bottom:22px;display:flex;align-items:flex-start;gap:18px;flex-wrap:wrap">
    ${headerLogoHtml}
    <div style="flex:1;min-width:260px">
      <p style="${HERO_EYEBROW_STYLE}">${esc(copy.companyCityKicker)} · ${esc(copy.updatedLabel)} ${dateStamp}</p>
      <h1 style="${H1_STYLE}">${esc(h1)}</h1>
      <p style="${LEDE_STYLE}">${esc(heroSummary)}</p>
      <p style="margin:0;color:var(--color-body);line-height:1.7;max-width:860px">${esc(intro)}</p>
    </div>
  </header>
  ${archiveNote}
  <section style="margin:0 0 28px" aria-labelledby="companyCityJobs">
    <h2 id="companyCityJobs" style="${H2_STYLE}">${esc(copy.companyCityJobsHeading(employer, cityDisplay))}</h2>
    ${jobsListHtml}
  </section>
  <section style="margin:0 0 28px" aria-labelledby="companyCityEditorial">
    <h2 id="companyCityEditorial" style="${H2_STYLE}">${esc(employer)} · ${esc(cityDisplay)}</h2>
    <p style="margin:0;color:var(--color-body);line-height:1.7;max-width:860px">${esc(editorial)}</p>
  </section>
  <section style="margin:0 0 28px" aria-labelledby="companyCityFrontalier">
    <h2 id="companyCityFrontalier" style="${H2_STYLE}">${esc(copy.companyCityFrontalierTitle(employer, cityDisplay))}</h2>
    ${copy
      .companyCityFrontalier({ employer, city: cityDisplay, jobsCount: stats.activeJobsCount })
      .map((p) => `<p style="margin:0 0 12px;color:var(--color-body);line-height:1.7;max-width:860px">${p}</p>`)
      .join('')}
  </section>
  <section style="margin:0 0 28px" aria-labelledby="companyCityLinks">
    <h2 id="companyCityLinks" style="${H2_STYLE}">${esc(copy.relatedLinksTitle)}</h2>
    <ul style="list-style:none;padding:0;margin:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:6px 18px">${ownRelated.join('')}</ul>
    ${siblingsPlaceholder}
  </section>
  <section style="margin:0 0 0" aria-labelledby="companyCityFaq">
    <h2 id="companyCityFaq" style="${H2_STYLE}">${esc(copy.faqTitle)}</h2>
    <details style="${CARD_STYLE};margin-bottom:8px">
      <summary style="font-weight:700;cursor:pointer;color:var(--color-heading)">${esc(copy.companyCityFaqWhyQ(employer))}</summary>
      <p style="margin:10px 0 0;color:var(--color-body);line-height:1.6">${esc(copy.companyCityFaqWhyA(employer, cityDisplay))}</p>
    </details>
    <details style="${CARD_STYLE};margin-bottom:8px">
      <summary style="font-weight:700;cursor:pointer;color:var(--color-heading)">${esc(copy.companyCityFaqHowApplyQ)}</summary>
      <p style="margin:10px 0 0;color:var(--color-body);line-height:1.6">${esc(copy.companyCityFaqHowApplyA(employer))}</p>
    </details>
    <details style="${CARD_STYLE};margin-bottom:8px">
      <summary style="font-weight:700;cursor:pointer;color:var(--color-heading)">${esc(copy.companyCityFaqUpdateQ)}</summary>
      <p style="margin:10px 0 0;color:var(--color-body);line-height:1.6">${esc(copy.companyCityFaqUpdateA)}</p>
    </details>
  </section>
  ${generateRelatedLinksBlock(locale, 'weekly_employer_company_city', {
    city,
    weeklyCity: city,
    companySlug,
    employer,
    companySiblingCities,
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
    robots,
    ogType: 'website',
    ogLocale: WEEKLY_EMPLOYERS_OG_LOCALE[locale],
    hreflangHtml,
    extraHeadHtml: extraHead,
    jsonLdScripts: [breadcrumbLd, webPageLd, itemListLd, faqLd],
    bodyHtml,
    distDir,
    hubChrome: { hubKey: 'job-board', activeSubTab: 'jobs' },
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
      return `<li style="margin:0;padding:0"><a href="${esc(href)}" style="display:inline-block;padding:8px 0;${LINK_ACCENT_STYLE};font-weight:600">${esc(label)} →</a></li>`;
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

  // Load company slug registry once for the entire generation run.
  const knownSlugs = loadKnownCompanySlugs(opts.rootDir);

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
        knownSlugs,
        rootDir: opts.rootDir,
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
            knownSlugs,
            rootDir: opts.rootDir,
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
        knownSlugs,
        rootDir: opts.rootDir,
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

      // Ext3 task 3 — wipe owned namespaces before regeneration so last
      // build's company×city pages don't linger after employer drops out
      // of the pairs list (the thin-content guard used to leave empty
      // directories behind — see PLAN-SPRINT-1-TECH-FIXES-EXTENSION-3 §3).
      cleanNamespaces(distDir, [
        'aziende-che-assumono',
        'en/companies-hiring',
        'de/unternehmen-einstellen',
        'fr/entreprises-recrutent',
      ]);
      cleanSitemapFiles(distDir, ['sitemap-weekly-employers.xml']);

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
