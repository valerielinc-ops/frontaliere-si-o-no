/** Snapshot source and pagination plan shared by canton landings and archives. */
import type fsT from 'node:fs';
import type npT from 'node:path';
import { resolveJobCanton } from './cantonSection';
import { JOBS_PAGE_SIZE } from '../seoHubsData';
import { MIN_JOBS_FOR_CANTON_PAGE } from '../weeklyEmployersData';

function slugifyEmployer(value: string): string {
  return String(value || '').toLowerCase().normalize('NFD')
    .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Reads the latest jobs snapshot and returns:
 * - `counts`: employerKey → active job count (for "N offerte attive" labels)
 * - `urlToKey`: company URL slug → employerKey (for logo lookup)
 *
 * The company URL slug is derived by slugifying `job.employer` (full name),
 * which mirrors how `jobsSeoPagesPlugin` builds `companyMap` keys. The reverse
 * map lets us resolve logos from `company-logos-manifest.json` (keyed by short
 * `employerKey`) when given the long URL slug from `known-company-slugs.json`.
 */
export interface CantonJobEntry {
  readonly slug: string;
  readonly role: string;
  readonly employer: string;
  readonly employerKey: string;
  readonly city: string;
  /** ISO YYYY-MM-DD when the job was first posted by the source ATS — drives
   *  the recency landings ("offerte da ieri", "ultimi 3 giorni", "ultima
   *  settimana"). Optional because pre-2026-04 snapshots omit it. */
  readonly postedAt?: string;
}

export function readJobsData(
  fs: typeof fsT,
  np: typeof npT,
  rootDir: string,
): {
  counts: Map<string, number>;
  urlToKey: Map<string, string>;
  cantonJobCounts: Map<string, number>;
  cantonJobs: Map<string, CantonJobEntry[]>;
  cantonEmployerCounts: Map<string, Map<string, number>>;
} {
  const counts = new Map<string, number>();
  const urlToKey = new Map<string, string>();
  const cantonJobCounts = new Map<string, number>();
  const cantonJobs = new Map<string, CantonJobEntry[]>();
  const cantonEmployerCounts = new Map<string, Map<string, number>>();
  const historyDir = np.resolve(rootDir, 'data', 'jobs-snapshots-history');
  try {
    if (!fs.existsSync(historyDir)) {
      return { counts, urlToKey, cantonJobCounts, cantonJobs, cantonEmployerCounts };
    }
    const files = fs.readdirSync(historyDir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .reverse();
    if (files.length === 0) {
      return { counts, urlToKey, cantonJobCounts, cantonJobs, cantonEmployerCounts };
    }
    const raw = JSON.parse(fs.readFileSync(np.join(historyDir, files[0]), 'utf-8'));
    for (const job of Array.isArray(raw?.jobs) ? raw.jobs : []) {
      if (typeof job?.employerKey === 'string' && job.employerKey) {
        counts.set(job.employerKey, (counts.get(job.employerKey) ?? 0) + 1);
        if (typeof job.employer === 'string' && job.employer) {
          const urlSlug = slugifyEmployer(job.employer);
          if (urlSlug && !urlToKey.has(urlSlug)) urlToKey.set(urlSlug, job.employerKey);
        }
      }
      // Canton resolution: use explicit `job.canton` when present, else fall
      // back to the city → canton mapping in `resolveJobCanton`.
      const cantonInput = {
        canton: typeof job?.canton === 'string' ? job.canton : undefined,
        location: typeof job?.city === 'string' ? job.city : undefined,
      };
      const canton = resolveJobCanton(cantonInput);
      cantonJobCounts.set(canton, (cantonJobCounts.get(canton) ?? 0) + 1);
      if (typeof job?.slug === 'string' && job.slug) {
        // BFS-depth closure (2026-05-12): removed the prior 200-job cap. The
        // cathedral expansion added per-canton `tutti/page-N/` archive
        // pagination, which needs every job slug in the canton so the
        // archive ladder reaches every leaf at depth ≤ 4 from `/`. Max
        // canton (GR/VS/ZH) carries ~1800 jobs; aggregate across 26 cantons
        // is ~15k entries × ~200 bytes ≈ 3 MB — well within build memory.
        const arr = cantonJobs.get(canton) ?? [];
        arr.push({
          slug: job.slug,
          role: typeof job?.role === 'string' ? job.role : job.slug,
          employer: typeof job?.employer === 'string' ? job.employer : '',
          employerKey: typeof job?.employerKey === 'string' ? job.employerKey : '',
          city: typeof job?.city === 'string' ? job.city : '',
          postedAt: typeof job?.postedAt === 'string' ? job.postedAt : undefined,
        });
        cantonJobs.set(canton, arr);
      }
      if (typeof job?.employerKey === 'string' && job.employerKey) {
        const empMap = cantonEmployerCounts.get(canton) ?? new Map<string, number>();
        empMap.set(job.employerKey, (empMap.get(job.employerKey) ?? 0) + 1);
        cantonEmployerCounts.set(canton, empMap);
      }
    }
  } catch (err) {
    console.warn('[seo-hubs] failed to read job snapshot', err);
  }
  return { counts, urlToKey, cantonJobCounts, cantonJobs, cantonEmployerCounts };
}

/** Zero means only the below-floor canonical bridge will be emitted. */
export function cantonArchivePageCount(
  total: number,
  jobs: readonly CantonJobEntry[],
  parentIndexable: boolean,
): number {
  if (!parentIndexable || total < MIN_JOBS_FOR_CANTON_PAGE || jobs.length < MIN_JOBS_FOR_CANTON_PAGE) return 0;
  const dedupKeys = new Set<string>();
  for (const job of jobs) {
    const role = String(job.role || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const employer = String(job.employerKey || job.employer || '').toLowerCase().replace(/\s+/g, ' ').trim();
    dedupKeys.add(`tc|${role}|${employer}`);
  }
  if (dedupKeys.size < MIN_JOBS_FOR_CANTON_PAGE) return 0;
  return Math.max(1, Math.ceil(jobs.length / JOBS_PAGE_SIZE));
}
