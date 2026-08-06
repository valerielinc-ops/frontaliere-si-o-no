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
  canton?: string;
  location?: string;
  addressLocality?: string;
  expired?: boolean;
  needsRetranslation?: boolean | Partial<Record<OrphanLandingLocale, boolean>>;
  sourceLang?: OrphanLandingLocale;
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
  // needsRetranslation=true means translations FROM the job's source locale
  // are stale/pending — it never means the source locale's own content is
  // bad. Blocking the source locale too wrongly zeroes out well-formed jobs
  // in their own language (#4715).
  if (nr === true && locale !== (job.sourceLang || 'it')) return false;
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

  return matchesClusterFacts(titleTokens, locTokens, clusterMatchFacts(cluster));
}

// ─────────────────────────────────────────────────────────────────────────────
// Hoisting the invariants out of the (clusters x jobs) pair loop
//
// `orphanQueryLandingPlugin` calls `filterMatchingJobs(jobs, cluster, 15)` once
// per cluster — 500 clusters (DEFAULT_MAX_LANDINGS) over ~26k jobs = ~13M
// (job, cluster) pairs per build, twice (the emission pass and the hub-hreflang
// availability pass both go through `renderClusterPage`). Deploy 31065272867
// measured the `it` leg at wall_s=190.98 cpu_s=197.50 while the plugin's own
// emit is 0.7 s — i.e. essentially the whole plugin is this pair loop.
//
// A local profile over the committed corpus (25,658 jobs x 500 clusters =
// 12.8M pairs, 222.5 s) split the per-pair body as:
//     isJobActiveForLocale -> wordCount(description)   16.39 s   75.0 %
//     titleTokens Set (3x normalizeTokens)              4.43 s   20.3 %
//     locTokens   Set (2x normalizeTokens)              0.97 s    4.5 %
//     the actual match logic                            0.05 s    0.2 %
// (measured over a 50-cluster subset; x10 => ~218 s, matching the 222.5 s run.)
//
// Every one of those top three is a pure function of (job, locale) or of `job`
// alone — NOTHING in them reads the cluster beyond `cluster.locale`, and there
// are exactly four locales. `specificRegions` / `allRolesGeneric` are likewise
// pure functions of the cluster. So the whole per-pair body is memoisable:
// 12.8M evaluations collapse to at most `jobs.length x 4`.
//
// This changes NO decision. The memoised values are the same values the inline
// code computed, and the two consumers (`tokenMatchesStem`,
// `localityMatchesCity`) only ever ask "does ANY token match?" — a predicate
// that is invariant under both de-duplication and iteration order, which is why
// a `string[]` here is interchangeable with the `Set<string>` above.
// `jobMatchesCluster` keeps its original un-memoised body so an ad-hoc object
// (tests, callers outside a build) behaves exactly as before.
// ─────────────────────────────────────────────────────────────────────────────

interface ClusterMatchFacts {
  readonly roleTokens: readonly string[];
  readonly specificRegions: readonly string[];
  readonly allRolesGeneric: boolean;
}

const clusterFactsCache = new WeakMap<OrphanQueryCluster, ClusterMatchFacts>();

/** Cluster-only derived state (identical for every job). */
function clusterMatchFacts(cluster: OrphanQueryCluster): ClusterMatchFacts {
  const hit = clusterFactsCache.get(cluster);
  if (hit) return hit;
  // A *specific* locality (city) is enforced against the job location; *broad*
  // tokens (svizzera/ticino/ch) only mean site-wide coverage.
  const specificRegions = cluster.regionTokens.filter((r) => !BROAD_REGION_TOKENS.has(r));
  const allRolesGeneric =
    cluster.roleTokens.length === 0 || cluster.roleTokens.every((r) => GENERIC_ROLE_STEMS.has(r));
  const facts: ClusterMatchFacts = { roleTokens: cluster.roleTokens, specificRegions, allRolesGeneric };
  clusterFactsCache.set(cluster, facts);
  return facts;
}

/**
 * The role+region decision, byte-for-byte the branch sequence that used to live
 * inline in `jobMatchesCluster`. Both call sites (the public per-job function
 * and the indexed loop) go through this, so there is exactly one copy of it.
 */
function matchesClusterFacts(
  titleTokens: Iterable<string>,
  locTokens: Iterable<string>,
  facts: ClusterMatchFacts,
): boolean {
  // Pure geographic search ("jobs in <city>"): no occupational intent, just a
  // named city → match by locality alone.
  if (facts.specificRegions.length > 0 && facts.allRolesGeneric) {
    return facts.specificRegions.some((rtok) => localityMatchesCity(locTokens, rtok));
  }

  // Role: need at least 1 overlap (prefix-tolerant for stems).
  if (!facts.roleTokens.some((stem) => tokenMatchesStem(titleTokens, stem))) return false;

  // Region: a named city must appear in the job location; broad-only tokens
  // (or no region tokens) leave coverage unconstrained / site-wide.
  if (facts.specificRegions.length > 0) {
    if (!facts.specificRegions.some((rtok) => localityMatchesCity(locTokens, rtok))) return false;
  }

  return true;
}

/** Per-job derived state. Locale-keyed fields are filled lazily, per locale. */
interface JobMatchEntry {
  /** normalizeTokens(location) + normalizeTokens(addressLocality), de-duped. */
  locTokens?: string[];
  /** firstParsableMs(postedDate, datePosted) — the sort key, locale-invariant. */
  postedMs: number;
  activeByLocale: Partial<Record<OrphanLandingLocale, boolean>>;
  titleTokensByLocale: Partial<Record<OrphanLandingLocale, string[]>>;
}

interface JobMatchIndex {
  readonly length: number;
  readonly entries: JobMatchEntry[];
}

// Keyed on the jobs ARRAY identity: the plugin loads the corpus once and then
// loops, so one index serves all 500 clusters and both passes. A WeakMap means
// the index dies with the array (no build-lifetime leak), and `length` is
// re-checked so a caller that swaps the corpus can never read a stale index.
const jobIndexCache = new WeakMap<object, JobMatchIndex>();

function getJobIndex(jobs: readonly OrphanCountableJob[]): JobMatchIndex {
  const key = jobs as unknown as object;
  const hit = jobIndexCache.get(key);
  if (hit && hit.length === jobs.length) return hit;
  const entries: JobMatchEntry[] = new Array(jobs.length);
  for (let i = 0; i < jobs.length; i++) {
    const j = jobs[i];
    entries[i] = {
      // Same call, same argument order as the old inline comparator.
      postedMs: firstParsableMs(j?.postedDate, j?.datePosted),
      activeByLocale: {},
      titleTokensByLocale: {},
    };
  }
  const index: JobMatchIndex = { length: jobs.length, entries };
  jobIndexCache.set(key, index);
  return index;
}

function entryLocTokens(entry: JobMatchEntry, job: OrphanCountableJob): string[] {
  let t = entry.locTokens;
  if (t === undefined) {
    t = [...new Set<string>([...normalizeTokens(job.location), ...normalizeTokens(job.addressLocality)])];
    entry.locTokens = t;
  }
  return t;
}

function entryTitleTokens(
  entry: JobMatchEntry,
  job: OrphanCountableJob,
  locale: OrphanLandingLocale,
): string[] {
  let t = entry.titleTokensByLocale[locale];
  if (t === undefined) {
    t = [
      ...new Set<string>([
        ...normalizeTokens(job.title),
        ...normalizeTokens(job.titleByLocale?.[locale]),
        ...normalizeTokens(job.company),
      ]),
    ];
    entry.titleTokensByLocale[locale] = t;
  }
  return t;
}

function entryActive(
  entry: JobMatchEntry,
  job: OrphanCountableJob,
  locale: OrphanLandingLocale,
): boolean {
  let a = entry.activeByLocale[locale];
  if (a === undefined) {
    a = isJobActiveForLocale(job, locale);
    entry.activeByLocale[locale] = a;
  }
  return a;
}

/** Return up to `limit` jobs matching a cluster, sorted by postedDate desc. */
export function filterMatchingJobs<T extends OrphanCountableJob>(
  jobs: readonly T[],
  cluster: OrphanQueryCluster,
  limit = 15,
): T[] {
  const index = getJobIndex(jobs);
  const facts = clusterMatchFacts(cluster);
  const locale = cluster.locale;

  // Collect INDICES (not jobs) so the sort below can read the precomputed
  // `postedMs` without re-parsing dates inside the comparator. Indices are
  // pushed in `jobs` order, exactly the order `jobs.filter(...)` produced.
  const matched: number[] = [];
  for (let i = 0; i < jobs.length; i++) {
    const entry = index.entries[i];
    if (!entryActive(entry, jobs[i], locale)) continue;
    if (!matchesClusterFacts(entryTitleTokens(entry, jobs[i], locale), entryLocTokens(entry, jobs[i]), facts)) {
      continue;
    }
    matched.push(i);
  }

  // First *parsable* date (not first truthy): a malformed `postedDate`
  // ("30/05/26") is truthy and sorts lexically above ISO strings, floating a
  // stale job to the top of the slice and pushing a fresh one out of the
  // indexed list. See firstParsableMs.
  //
  // `postedMs` is precomputed per job, so the comparator sees exactly the
  // values the old inline `firstParsableMs(...)` calls returned. Array#sort is
  // stable (V8 TimSort) and the input is in the same order as before, so equal
  // timestamps keep the same relative order the old `matches.sort` produced.
  matched.sort((a, b) => index.entries[b].postedMs - index.entries[a].postedMs);

  const out: T[] = [];
  for (let i = 0; i < matched.length && i < limit; i++) out.push(jobs[matched[i]]);
  return out;
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
