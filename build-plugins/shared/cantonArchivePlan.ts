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
  /** Exact detail path per locale, when the entry comes from the build's
   *  live inventory (see `setLiveCantonArchiveJobs`). Snapshot entries have
   *  none and fall back to `all-known-job-slugs.json`. */
  readonly hrefByLocale?: Readonly<Partial<Record<'it' | 'en' | 'de' | 'fr', string>>>;
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


type CantonArchiveData = ReturnType<typeof readJobsData>;

/**
 * Live listing inventory of the current build, per canton, registered by
 * `jobsSeoPagesPlugin` before it plans the archive navigator of each canton
 * landing, and read by `seoHubsPlugin` when it emits `tutti/page-N/`. Both
 * plugins run in one Node process, jobsSeoPagesPlugin first (same contract as
 * `cantonSectorPageRegistry`).
 *
 * Why (2026-10-02). The archive was built only from the WEEKLY snapshot
 * (`data/jobs-snapshots-history/<week>.json`), so a job published after the
 * snapshot was in no `tutti/page-N/`: measured on build f3659686 (snapshot
 * 2026-40 of 2026-09-28), 307 of the 1 708 Zurich IT job pages in the sitemap
 * were missing from it, and 44 of the 55 Zurich job pages buried deeper than
 * 4 clicks (`audit:max-bfs-depth`) were among them.
 */
let liveCantonArchiveJobs: Map<string, CantonJobEntry[]> | null = null;

export function setLiveCantonArchiveJobs(jobsByCanton: Map<string, CantonJobEntry[]>): void {
  liveCantonArchiveJobs = jobsByCanton;
}

/** Test/diagnostic helper — never mutate from production code. */
export function _resetLiveCantonArchiveJobs(): void {
  liveCantonArchiveJobs = null;
}

/**
 * Snapshot ∪ live inventory, per canton. The snapshot keeps its order (its
 * pages do not reshuffle every build); a live job already in the snapshot
 * gains its exact per-locale hrefs; a live job missing from it is appended,
 * by slug. Nothing is dropped: snapshot entries of jobs that are no longer
 * live keep their link to their historical page. Counts follow the merge.
 * Pure.
 */
export function mergeLiveArchiveJobs(snapshot: CantonArchiveData, live: Map<string, CantonJobEntry[]>): CantonArchiveData {
  const cantonJobs = new Map(snapshot.cantonJobs);
  const cantonJobCounts = new Map(snapshot.cantonJobCounts);
  const cantonEmployerCounts = new Map(
    [...snapshot.cantonEmployerCounts].map(([canton, counts]) => [canton, new Map(counts)] as const),
  );
  for (const [canton, liveEntries] of live) {
    const existing = cantonJobs.get(canton) ?? [];
    const liveBySlug = new Map(liveEntries.filter((e) => e.slug).map((e) => [e.slug, e] as const));
    const seen = new Set<string>();
    const merged: CantonJobEntry[] = existing.map((entry) => {
      seen.add(entry.slug);
      const fresh = liveBySlug.get(entry.slug);
      return fresh?.hrefByLocale ? { ...entry, hrefByLocale: fresh.hrefByLocale } : entry;
    });
    const added = [...liveBySlug.values()]
      .filter((e) => !seen.has(e.slug))
      .sort((a, b) => a.slug.localeCompare(b.slug));
    if (added.length === 0 && merged.every((e, i) => e === existing[i])) continue;
    cantonJobs.set(canton, [...merged, ...added]);
    cantonJobCounts.set(canton, (cantonJobCounts.get(canton) ?? 0) + added.length);
    const empMap = cantonEmployerCounts.get(canton) ?? new Map<string, number>();
    for (const e of added) if (e.employerKey) empMap.set(e.employerKey, (empMap.get(e.employerKey) ?? 0) + 1);
    cantonEmployerCounts.set(canton, empMap);
  }
  return { ...snapshot, cantonJobs, cantonJobCounts, cantonEmployerCounts };
}

/**
 * The archive source BOTH plugins must use: the landing's page-index
 * navigator and the emitted `tutti/page-N/` pages have to agree on the page
 * count. Snapshot alone when no live inventory was registered (a build that
 * skipped jobsSeoPagesPlugin).
 */
export function readCantonArchiveData(fs: typeof fsT, np: typeof npT, rootDir: string): CantonArchiveData {
  const snapshot = readJobsData(fs, np, rootDir);
  return liveCantonArchiveJobs ? mergeLiveArchiveJobs(snapshot, liveCantonArchiveJobs) : snapshot;
}
