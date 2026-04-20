/**
 * Orphan-query cluster landing — pure data/path helpers.
 *
 * The clustering script `scripts/cluster-orphan-queries.mjs` writes
 * `data/gsc-orphan-queries-clusters.json`. This module defines the
 * TypeScript shape, URL structure, and job-matching utilities consumed
 * by the Vite build plugin (`orphanQueryLandingPlugin.ts`) and the
 * router. No I/O, no side effects.
 */

export type OrphanLandingLocale = 'it' | 'en' | 'de' | 'fr';

export const ORPHAN_LANDING_LOCALES: ReadonlyArray<OrphanLandingLocale> = ['it', 'en', 'de', 'fr'] as const;

/** Section slug per locale for orphan-query landings. */
export const ORPHAN_LANDING_SECTION: Record<OrphanLandingLocale, string> = {
  it: 'ricerca',
  en: 'search',
  de: 'suche',
  fr: 'recherche',
};

/** Locale path prefix (Italian has no prefix, others get /xx). */
export const ORPHAN_LANDING_LOCALE_PREFIX: Record<OrphanLandingLocale, string> = {
  it: '',
  en: '/en',
  de: '/de',
  fr: '/fr',
};

export const ORPHAN_LANDING_OG_LOCALE: Record<OrphanLandingLocale, string> = {
  it: 'it_IT',
  en: 'en_US',
  de: 'de_DE',
  fr: 'fr_FR',
};

/** Shape of a single cluster as serialized to data/gsc-orphan-queries-clusters.json. */
export interface OrphanQueryCluster {
  clusterId: string;
  locale: OrphanLandingLocale;
  canonicalQuery: string;
  canonicalSlug: string;
  roleTokens: string[];
  regionTokens: string[];
  totalImpressions: number;
  totalClicks: number;
  queries: ReadonlyArray<{ query: string; clicks: number; impressions: number }>;
}

export interface OrphanQueryClustersFile {
  generatedAt: string;
  sourceFile?: string;
  totalClusters?: number;
  gates?: { minClusterImpressions?: number };
  clusters: OrphanQueryCluster[];
}

/** Shape of a job consumed by `filterMatchingJobs`. */
export interface OrphanCountableJob {
  title?: string;
  titleByLocale?: Partial<Record<OrphanLandingLocale, string>>;
  slug?: string;
  slugByLocale?: Partial<Record<OrphanLandingLocale, string>>;
  company?: string;
  location?: string;
  addressLocality?: string;
  expired?: boolean;
  needsRetranslation?: boolean | Partial<Record<OrphanLandingLocale, boolean>>;
  description?: string;
  descriptionByLocale?: Partial<Record<OrphanLandingLocale, string>>;
  salaryMin?: number;
  salaryMax?: number;
  currency?: string;
  postedDate?: string;
  datePosted?: string;
  url?: string;
}

/** Build the canonical URL path (always trailing slash) for a cluster. */
export function buildOrphanLandingPath(locale: OrphanLandingLocale, slug: string): string {
  const prefix = ORPHAN_LANDING_LOCALE_PREFIX[locale];
  const section = ORPHAN_LANDING_SECTION[locale];
  return `${prefix}/${section}/${slug}/`.replace(/\/+/g, '/');
}

/** Parse a URL path and return (locale, slug) if it matches an orphan landing, else null. */
export function parseOrphanLandingPath(urlPath: string): { locale: OrphanLandingLocale; slug: string } | null {
  if (!urlPath) return null;
  const withSlash = urlPath.endsWith('/') ? urlPath : `${urlPath}/`;
  for (const locale of ORPHAN_LANDING_LOCALES) {
    const prefix = ORPHAN_LANDING_LOCALE_PREFIX[locale];
    const section = ORPHAN_LANDING_SECTION[locale];
    const base = `${prefix}/${section}/`.replace(/\/+/g, '/');
    if (withSlash.startsWith(base)) {
      const rest = withSlash.slice(base.length).replace(/\/+$/, '');
      if (rest && !rest.includes('/')) {
        return { locale, slug: rest };
      }
    }
  }
  return null;
}

/**
 * Tokens used to match jobs to a cluster. All tokens lowercased and
 * diacritic-free. Token set is intersected with the role + region tokens
 * produced by the clustering script.
 */
function normalizeTokens(s: string | undefined | null): string[] {
  if (!s) return [];
  return String(s)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter((t) => t.length >= 3);
}

function wordCount(s: string | undefined | null): number {
  if (!s) return 0;
  return String(s).trim().split(/\s+/).filter(Boolean).length;
}

function isJobActiveForLocale(job: OrphanCountableJob, locale: OrphanLandingLocale): boolean {
  if (!job || typeof job !== 'object') return false;
  if (job.expired) return false;
  const nr = job.needsRetranslation;
  if (nr === true) return false;
  if (nr && typeof nr === 'object' && (nr as Record<string, boolean>)[locale]) return false;
  const localeDesc = job.descriptionByLocale?.[locale];
  const fallback = locale === 'it' ? job.description : undefined;
  const desc = localeDesc && localeDesc.trim().length > 0 ? localeDesc : fallback;
  return wordCount(desc) >= 50;
}

/**
 * Return true when a job plausibly matches a cluster (role + region overlap).
 *
 * Heuristic:
 *   - At least 1 role token from the cluster must appear in the job's
 *     title/location/company (stemming-tolerant prefix match, min len 3).
 *   - If cluster has region tokens, at least 1 of them must appear in
 *     the job's location or addressLocality.
 *   - The job must be active in the target locale.
 */
export function jobMatchesCluster(job: OrphanCountableJob, cluster: OrphanQueryCluster): boolean {
  if (!isJobActiveForLocale(job, cluster.locale)) return false;

  const titleTokens = new Set<string>([
    ...normalizeTokens(job.title),
    ...normalizeTokens(job.titleByLocale?.[cluster.locale]),
    ...normalizeTokens(job.company),
  ]);
  const locTokens = new Set<string>([
    ...normalizeTokens(job.location),
    ...normalizeTokens(job.addressLocality),
  ]);

  // Role: need at least 1 overlap (prefix-tolerant for stems).
  const roleHit = cluster.roleTokens.some((stem) => {
    if (stem.length < 3) return false;
    for (const tok of titleTokens) {
      if (tok.startsWith(stem) || stem.startsWith(tok.slice(0, Math.max(3, stem.length - 1)))) return true;
    }
    return false;
  });
  if (!roleHit) return false;

  // Region: optional — if cluster has regions, at least one must appear.
  if (cluster.regionTokens.length > 0) {
    const regionHit = cluster.regionTokens.some((rtok) => {
      if (rtok === 'svizzera' || rtok === 'ticino') {
        // Site-wide coverage: every active Ticino job effectively matches
        // "svizzera/ticino". Treat as satisfied.
        return true;
      }
      for (const tok of locTokens) {
        if (tok.startsWith(rtok) || rtok.startsWith(tok.slice(0, Math.max(3, rtok.length - 1)))) return true;
      }
      return false;
    });
    if (!regionHit) return false;
  }

  return true;
}

/** Return up to `limit` jobs matching a cluster, sorted by postedDate desc. */
export function filterMatchingJobs<T extends OrphanCountableJob>(
  jobs: readonly T[],
  cluster: OrphanQueryCluster,
  limit = 15,
): T[] {
  const matches = jobs.filter((j) => jobMatchesCluster(j, cluster));
  matches.sort((a, b) => {
    const ad = String(a.postedDate || a.datePosted || '');
    const bd = String(b.postedDate || b.datePosted || '');
    return bd.localeCompare(ad);
  });
  return matches.slice(0, limit);
}

/** Median of a number array; returns 0 for empty input. */
export function median(values: readonly number[]): number {
  const nums = values.filter((n) => Number.isFinite(n) && n > 0).slice().sort((a, b) => a - b);
  if (nums.length === 0) return 0;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 === 0 ? Math.round((nums[mid - 1] + nums[mid]) / 2) : nums[mid];
}

/** Return top N (name, count) entries from a list of raw strings. */
export function topCounts(values: ReadonlyArray<string | undefined | null>, n: number): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>();
  for (const v of values) {
    const key = String(v || '').trim();
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const entries = Array.from(counts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
  return entries.slice(0, n);
}

/**
 * Build all orphan landing routes (for router + sitemap). Returns an array of
 * { locale, slug, path }.
 */
export interface OrphanLandingRoute {
  locale: OrphanLandingLocale;
  slug: string;
  path: string;
}

export function buildOrphanLandingRoutes(clusters: readonly OrphanQueryCluster[]): OrphanLandingRoute[] {
  const out: OrphanLandingRoute[] = [];
  for (const c of clusters) {
    out.push({
      locale: c.locale,
      slug: c.canonicalSlug,
      path: buildOrphanLandingPath(c.locale, c.canonicalSlug),
    });
  }
  return out;
}
