/**
 * clusterSearchSeed.ts — the build→SPA contract for related-search cluster
 * landings (`/cerca-lavoro-svizzera/ricerca-{slug}/` + locale variants).
 *
 * ## Why this exists
 *
 * The cluster page is emitted with a job set the BUILD computed, and the SPA
 * then recomputes the same search client-side and shows a DIFFERENT, smaller
 * one. Measured 2026-08-19 on
 * `/cerca-lavoro-svizzera/ricerca-offerte-lavoro-assistente-psicologo/`: the
 * static page lists 30 jobs, the hydrated board 6-8.
 *
 * The two sides are not looking at the same corpus. `relatedSearchClustersPlugin`
 * builds its haystack from `title + company + location + canton + DESCRIPTION`
 * (see `jobHaystack`), while JobBoard builds its own from the slim index — which
 * deliberately carries NO description (they live in `/data/job-detail/<id>.json`,
 * see `SLIM_INDEX_FIELDS`). So every job whose match lives in its description
 * survives the build and is dropped at hydration. Proven offline against the
 * live corpus: of the 30 jobs on that page, all 30 are present in the slim
 * index and only 6 pass the SPA matcher.
 *
 * This is not a relevance improvement the SPA makes — it is a loss. Among the
 * dropped ones: "Psicologo-psicoterapeuta in Psicologia", "Assistente medico in
 * psichiatria infantile stazionaria", "Pedopsichiatra - Ambulatorio della
 * Crisi". They are dropped because the query needs BOTH tokens and their titles
 * carry only one; the build saw the other in the description.
 *
 * Fixing it from the SPA side is not possible: it would mean shipping
 * descriptions to the client, and they are the reason the slim index exists.
 * So the build hands over the answer it already computed.
 *
 * ## Why the field set is not `SLIM_INDEX_FIELDS`
 *
 * This payload is inlined into every one of the ~156k emitted cluster pages, so
 * bytes here are multiplied by 156.032. The full 30-field slim record measures
 * 24,7 KB per page (3,58 GB across the family); this trimmed set measures
 * 15,5 KB (2,26 GB). `url` alone — the EXTERNAL apply link — was 19% of the
 * payload and is not read by any listing card: `buildJobPath()` derives the
 * internal href from `slug` + `canton`, and the detail view fetches the full
 * record from `/data/job-detail/<id>.json` when it opens. Every falsy value is
 * omitted rather than serialized as `null`.
 *
 * Keep this list to what a LISTING CARD reads. Anything a card does not render
 * is 156k copies of dead weight.
 */

/** Inline-script global carrying the seed. One document, one seed. */
export const CLUSTER_SEARCH_SEED_GLOBAL = '__SEARCH_SEED__';

/**
 * Fields a listing card (and the helpers that build its props) actually read:
 * `JobCard` itself reads canton/category/company/featured/id/location/title,
 * and its props come from `buildJobPath` (slug, canton), `formatSalary`
 * (salaryMin/Max, currency), `companyLogoUrl` (companyLogo, companyDomain),
 * `isNewJob` + `daysSincePosted` (postedDate) and `contractTranslationKey`
 * (contract).
 */
export const CLUSTER_SEARCH_SEED_FIELDS: readonly string[] = [
  'id', 'slug', 'title',
  'company', 'companyDomain', 'companyLogo',
  'location', 'canton',
  'category', 'contract', 'featured',
  'postedDate',
  'salaryMin', 'salaryMax', 'currency',
];

export interface ClusterSearchSeed {
  /** Pathname this seed belongs to. Short key: it ships 156k times. */
  readonly p: string;
  /** The query the page's slug resolves to — the SPA prefills the same string. */
  readonly q: string;
  /** Build-computed result set, in the build's relevance order. */
  readonly j: ReadonlyArray<Record<string, unknown>>;
}

/** Trim one job to the seed field set, dropping every falsy value. */
export function pickClusterSeedJob(job: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of CLUSTER_SEARCH_SEED_FIELDS) {
    const value = job[field];
    // `0` is falsy but meaningless for every field here (an id/slug/title of 0
    // does not occur, and salaryMin 0 carries no more than its absence), so a
    // plain truthiness test is the whole rule — no per-field exceptions to
    // drift out of sync with the field list above.
    if (value) out[field] = value;
  }
  return out;
}

export function buildClusterSearchSeed(
  pathname: string,
  query: string,
  jobs: ReadonlyArray<Record<string, unknown>>,
): ClusterSearchSeed {
  return { p: pathname, q: query, j: jobs.map(pickClusterSeedJob) };
}

/**
 * Read + validate the seed on the client. Returns null unless the seed is
 * well-formed AND belongs to `currentPathname` — the inline script is never
 * cleared by SPA navigation, so a bare presence check would let one cluster
 * page's results follow the visitor onto the next route (the stale-seed class
 * that `readSeededJob` documents for `__JOB_SEED__`).
 */
export function readClusterSearchSeed(currentPathname: string): ClusterSearchSeed | null {
  try {
    if (typeof window === 'undefined') return null;
    const raw = (window as unknown as Record<string, unknown>)[CLUSTER_SEARCH_SEED_GLOBAL];
    if (!raw || typeof raw !== 'object') return null;
    const seed = raw as Partial<ClusterSearchSeed>;
    if (typeof seed.p !== 'string' || seed.p !== currentPathname) return null;
    if (typeof seed.q !== 'string' || !seed.q.trim()) return null;
    if (!Array.isArray(seed.j) || seed.j.length === 0) return null;
    const jobs = seed.j.filter(
      (entry): entry is Record<string, unknown> =>
        !!entry && typeof entry === 'object'
        && typeof (entry as { id?: unknown }).id === 'string'
        && !!(entry as { id: string }).id
        && typeof (entry as { slug?: unknown }).slug === 'string'
        && !!(entry as { slug: string }).slug,
    );
    if (jobs.length === 0) return null;
    return { p: seed.p, q: seed.q, j: jobs };
  } catch {
    return null;
  }
}
