/**
 * Orphan-query cluster landing — pure data/path helpers.
 *
 * The clustering script `scripts/cluster-orphan-queries.mjs` writes
 * `data/gsc-orphan-queries-clusters.json`. This module defines the
 * TypeScript shape, URL structure, and job-matching utilities consumed
 * by the Vite build plugin (`orphanQueryLandingPlugin.ts`) and the
 * router. No I/O, no side effects.
 */

import { firstParsableMs } from './shared/firstParsableDate';

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
  it: 'it_CH',
  en: 'en_US',
  de: 'de_CH',
  fr: 'fr_CH',
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
 * Region tokens that denote the whole country / canton rather than a single
 * locality. When these are the ONLY region tokens of a cluster, every active
 * Ticino job is geographically relevant (site-wide coverage). Crucially they
 * must NOT let a cluster that ALSO names a specific city (e.g.
 * "lavoro stabio svizzera") silently match jobs anywhere in Switzerland — that
 * was the doorway bug where the city page surfaced wrong-city openings.
 */
const BROAD_REGION_TOKENS = new Set<string>([
  'svizzera', 'suisse', 'switzerland', 'schweiz',
  'ticino', 'tessin', 'ch',
]);

/**
 * Role stems that mean "job / work / opening / hiring / company / recently"
 * rather than an actual profession. A cluster whose role tokens are ALL
 * generic (e.g. "lavoro", "offerte", "cerco lavoro", "jobs … da ieri") carries
 * no occupational intent: it is a pure geographic search ("jobs in <city>")
 * and must be matched by locality alone. Applying the title-token role filter
 * to such a cluster surfaces unrelated jobs (often in the wrong city) and hides
 * the actual openings located in the searched city.
 */
const GENERIC_ROLE_STEMS = new Set<string>([
  'lavor', 'lavorar', 'lav', 'job', 'jobs', 'offert', 'offerta', 'offr', 'offre',
  'emplo', 'employ', 'travail', 'travaill', 'cerc', 'cerco', 'cercas', 'ricerc',
  'ricerch', 'trovar', 'trov', 'post', 'posizion', 'apert', 'assumon', 'assunzion',
  'aziend', 'annunc', 'concors', 'vacant', 'recrutement', 'recrut', 'search', 'find',
  'near', 'nah', 'vicin', 'stellen', 'stellenangebot', 'stelleninserat', 'arbeit',
  // recency / filler qualifiers from queries like "…da ieri", "3 derniers jours"
  'noi', 'ier', 'hier', 'ultim', 'giorn', 'settiman', 'tutt', 'letzten', 'tagen',
  'dernier', 'jour', 'press', 'ent',
]);

/** Prefix-tolerant token match (min stem length 3), used for role matching. */
function tokenMatchesStem(tokens: Iterable<string>, stem: string): boolean {
  if (stem.length < 3) return false;
  for (const tok of tokens) {
    if (tok.startsWith(stem) || stem.startsWith(tok.slice(0, Math.max(3, stem.length - 1)))) return true;
  }
  return false;
}

/**
 * Locality (city) gate — unidirectional prefix match: the job's location token
 * must START WITH the searched city token. Unlike role matching, city names are
 * proper nouns where `tokenMatchesStem`'s bidirectional fuzzy clause bleeds
 * foreign cities that share a common prefix: e.g. region `'manno'` →
 * `'mannedorf'.slice(0,4)='mann'` and `'manno'.startsWith('mann')` is true, so a
 * Männedorf (ZH) job would surface on the Manno (TI) geo page. Requiring the job
 * location to actually begin with the city token eliminates that cross-city
 * doorway while still allowing legitimate sub-locality forms (e.g. a 'lugano'
 * city token matching a 'luganese' location).
 */
function localityMatchesCity(locTokens: Iterable<string>, cityTok: string): boolean {
  if (cityTok.length < 3) return false;
  for (const locTok of locTokens) {
    if (locTok.startsWith(cityTok)) return true;
  }
  return false;
}

/**
 * Return true when a job plausibly matches a cluster (role + region overlap).
 *
 * Heuristic:
 *   - The job must be active in the target locale.
 *   - Pure geographic search (named city + only generic role words) → match by
 *     locality alone, skipping the meaningless title-token role filter.
 *   - Otherwise at least 1 role token must appear in the job's
 *     title/company (stemming-tolerant prefix match, min len 3).
 *   - A named city (specific, non-broad region token) MUST appear in the job's
 *     location/addressLocality. A broad svizzera/ticino token present alongside
 *     it does NOT trivially satisfy the geo gate. When the cluster has only
 *     broad region tokens, coverage is site-wide.
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

  // A *specific* locality (city) is enforced against the job location; *broad*
  // tokens (svizzera/ticino/ch) only mean site-wide coverage.
  const specificRegions = cluster.regionTokens.filter((r) => !BROAD_REGION_TOKENS.has(r));
  const allRolesGeneric =
    cluster.roleTokens.length === 0 || cluster.roleTokens.every((r) => GENERIC_ROLE_STEMS.has(r));

  // Pure geographic search ("jobs in <city>"): no occupational intent, just a
  // named city → match by locality alone.
  if (specificRegions.length > 0 && allRolesGeneric) {
    return specificRegions.some((rtok) => localityMatchesCity(locTokens, rtok));
  }

  // Role: need at least 1 overlap (prefix-tolerant for stems).
  if (!cluster.roleTokens.some((stem) => tokenMatchesStem(titleTokens, stem))) return false;

  // Region: a named city must appear in the job location; broad-only tokens
  // (or no region tokens) leave coverage unconstrained / site-wide.
  if (specificRegions.length > 0) {
    if (!specificRegions.some((rtok) => localityMatchesCity(locTokens, rtok))) return false;
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
    // First *parsable* date (not first truthy): a malformed `postedDate`
    // ("30/05/26") is truthy and sorts lexically above ISO strings, floating a
    // stale job to the top of the slice and pushing a fresh one out of the
    // indexed list. See firstParsableMs.
    const ad = firstParsableMs(a.postedDate, a.datePosted);
    const bd = firstParsableMs(b.postedDate, b.datePosted);
    return bd - ad;
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
