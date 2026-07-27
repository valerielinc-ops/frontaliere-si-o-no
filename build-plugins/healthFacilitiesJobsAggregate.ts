/**
 * healthFacilitiesJobsAggregate.ts — build-time live aggregator for the
 * health-facilities hub (epic #4455 / sub #4457).
 *
 * For each committed facility (build-plugins/healthFacilitiesData.ts) it
 * selects the employer's live jobs from `data/jobs.json` by `companyKey`
 * (the registry stores the resolved keys, so no re-matching is needed here —
 * the name/geo matching lives once in the generator) and computes a snapshot:
 * live job count, healthcare-role mix + median salary (via the SAME
 * classifier + median helper the generator used), 30-day freshness, top
 * roles, top featured jobs (for the SPA job cards) and a JobPosting-ready
 * projection of the featured jobs.
 *
 * Module-level cache keyed by rootDir — the ~150 MB jobs.json is parsed once
 * per build (loadJobsJson is itself cached; this caches the per-facility
 * aggregation on top). Read-only, no side effects.
 */

import { loadJobsJson } from './shared/loadJobsJson';
import { realSalaryMedianChf } from './shared/realSalaryMedian';
import { firstParsableMs, firstParsableDateStr } from './shared/firstParsableDate';
import { classifyHealthcareRole, type HealthcareRole } from './healthFacilitiesMatch';
import { HEALTH_FACILITIES, type HealthFacilityRecord } from './healthFacilitiesData';

const DAY_MS = 86_400_000;

/** Minimal job-record shape we read from jobs.json. */
interface JobRecord {
  id?: string;
  slug?: string;
  slugByLocale?: Partial<Record<string, string>>;
  title?: string;
  titleByLocale?: Partial<Record<string, string>>;
  descriptionByLocale?: Partial<Record<string, string>>;
  description?: string;
  company?: string;
  companyKey?: string;
  companyDomain?: string;
  addressLocality?: string;
  canton?: string;
  contract?: string;
  employmentType?: string;
  salaryMin?: number | null;
  salaryMax?: number | null;
  salarySource?: string;
  currency?: string;
  postedDate?: string;
  firstSeenAt?: string;
  crawledAt?: string;
  validThrough?: string;
  featured?: boolean;
  url?: string;
  streetAddress?: string;
  postalCode?: string;
  sector?: string;
  category?: string;
}

/** A featured job projected for the SPA job card + JobPosting schema. */
export interface FacilityFeaturedJob {
  readonly id: string;
  readonly title: string;
  readonly titleByLocale: Partial<Record<string, string>>;
  readonly descriptionByLocale: Partial<Record<string, string>>;
  readonly description: string | null;
  readonly company: string;
  readonly companyKey: string | null;
  readonly companyDomain: string | null;
  readonly addressLocality: string | null;
  readonly canton: string | null;
  readonly streetAddress: string | null;
  readonly postalCode: string | null;
  readonly contract: string | null;
  readonly employmentType: string | null;
  readonly salaryMin: number | null;
  readonly salaryMax: number | null;
  readonly salarySource: string | null;
  readonly currency: string | null;
  readonly postedDate: string | null;
  readonly datePosted: string | null;
  readonly validThrough: string | null;
  readonly crawledAt: string | null;
  readonly daysAgo: number;
  readonly slug: string;
  readonly slugByLocale: Partial<Record<string, string>>;
  readonly url: string | null;
  readonly sector: string | null;
  readonly category: string | null;
}

export interface FacilitySnapshot {
  readonly slug: string;
  readonly liveCount: number;
  readonly healthcareCount: number;
  readonly fresh30Count: number;
  readonly medianSalaryChf: number | null;
  readonly roleCounts: Readonly<Record<HealthcareRole, number>>;
  readonly featured: readonly FacilityFeaturedJob[];
}

let _cache: Map<string, FacilitySnapshot> | null = null;
let _cacheRootDir: string | null = null;

function toFeatured(job: JobRecord, now: number): FacilityFeaturedJob | null {
  if (!job.id || !job.title || !job.slug) return null;
  const postedDate = firstParsableDateStr(job.postedDate, job.firstSeenAt);
  const ts = firstParsableMs(job.postedDate, job.firstSeenAt);
  const daysAgo = ts ? Math.max(0, Math.round((now - ts) / DAY_MS)) : 9999;
  return {
    id: job.id,
    title: job.title,
    titleByLocale: job.titleByLocale ?? {},
    descriptionByLocale: job.descriptionByLocale ?? {},
    description: job.description ?? null,
    company: job.company ?? '',
    companyKey: job.companyKey ?? null,
    companyDomain: job.companyDomain ?? null,
    addressLocality: job.addressLocality ?? null,
    canton: job.canton ?? null,
    streetAddress: job.streetAddress ?? null,
    postalCode: job.postalCode ?? null,
    contract: job.contract ?? null,
    employmentType: job.employmentType ?? null,
    salaryMin: typeof job.salaryMin === 'number' ? job.salaryMin : null,
    salaryMax: typeof job.salaryMax === 'number' ? job.salaryMax : null,
    salarySource: job.salarySource ?? null,
    currency: job.currency ?? null,
    postedDate,
    datePosted: postedDate,
    validThrough: job.validThrough ?? null,
    crawledAt: job.crawledAt ?? null,
    daysAgo,
    slug: job.slug,
    slugByLocale: job.slugByLocale ?? {},
    url: job.url ?? null,
    sector: job.sector ?? null,
    category: job.category ?? null,
  };
}

const EMPTY_ROLE_COUNTS = (): Record<HealthcareRole, number> => ({
  infermiere: 0,
  oss: 0,
  medico: 0,
  terapista: 0,
  ostetrica: 0,
  tecnico: 0,
  altro: 0,
});

function buildSnapshot(
  facility: HealthFacilityRecord,
  jobsByKey: Map<string, JobRecord[]>,
  now: number,
): FacilitySnapshot {
  const jobs: JobRecord[] = [];
  for (const key of facility.companyKeys) {
    const bucket = jobsByKey.get(key);
    if (bucket) jobs.push(...bucket);
  }

  const roleCounts = EMPTY_ROLE_COUNTS();
  const healthcareJobs: JobRecord[] = [];
  for (const job of jobs) {
    const role = classifyHealthcareRole(job.title);
    if (role) {
      roleCounts[role]++;
      healthcareJobs.push(job);
    }
  }

  const last30 = now - 30 * DAY_MS;
  let fresh30 = 0;
  for (const job of jobs) {
    const ts = firstParsableMs(job.postedDate, job.firstSeenAt);
    if (ts && ts >= last30) fresh30++;
  }

  const median = realSalaryMedianChf(healthcareJobs) ?? realSalaryMedianChf(jobs);

  // Featured: healthcare roles first, then freshest. Falls back to any job so
  // an all-admin snapshot still surfaces the employer's live openings.
  const ranked = [...jobs].sort((a, b) => {
    const aHealth = classifyHealthcareRole(a.title) ? 1 : 0;
    const bHealth = classifyHealthcareRole(b.title) ? 1 : 0;
    if (aHealth !== bHealth) return bHealth - aHealth;
    const aFeat = a.featured ? 1 : 0;
    const bFeat = b.featured ? 1 : 0;
    if (aFeat !== bFeat) return bFeat - aFeat;
    return firstParsableMs(b.postedDate, b.firstSeenAt) - firstParsableMs(a.postedDate, a.firstSeenAt);
  });
  const featured: FacilityFeaturedJob[] = [];
  for (const job of ranked) {
    if (featured.length >= 6) break;
    const f = toFeatured(job, now);
    if (f) featured.push(f);
  }

  return {
    slug: facility.slug,
    liveCount: jobs.length,
    healthcareCount: healthcareJobs.length,
    fresh30Count: fresh30,
    medianSalaryChf: median,
    roleCounts,
    featured,
  };
}

/**
 * Aggregate live jobs.json into per-facility snapshots, keyed by slug.
 * Cached per rootDir. Pass `now` to override the clock (tests).
 */
export function aggregateHealthFacilityJobs(
  rootDir: string,
  now: number = Date.now(),
): Map<string, FacilitySnapshot> {
  if (_cache && _cacheRootDir === rootDir) return _cache;

  const allJobs = loadJobsJson<JobRecord>(rootDir);
  const jobsByKey = new Map<string, JobRecord[]>();
  for (const job of allJobs) {
    const key = job.companyKey;
    if (!key) continue;
    let bucket = jobsByKey.get(key);
    if (!bucket) {
      bucket = [];
      jobsByKey.set(key, bucket);
    }
    bucket.push(job);
  }

  const out = new Map<string, FacilitySnapshot>();
  for (const facility of HEALTH_FACILITIES) {
    out.set(facility.slug, buildSnapshot(facility, jobsByKey, now));
  }

  _cache = out;
  _cacheRootDir = rootDir;
  return out;
}

/** Test/CI helper — clear the module-level cache. */
export function _resetHealthFacilityJobsAggregateCache(): void {
  _cache = null;
  _cacheRootDir = null;
}
