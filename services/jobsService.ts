/**
 * jobsService.ts — per-canton job-shard fetch layer with IDB cache + ETag.
 *
 * Decision references:
 *   - D9 (CEO review):  SPA payload sharded per-canton with lazy fetch + IDB
 *                       cache. Monolithic public/data/jobs.json deprecated.
 *   - D11:              Default canton selection is referrer-aware (any URL
 *                       containing the substring "frontaliere" → TI; otherwise
 *                       fall back to the multi-canton _AGGREGATE_ shard).
 *   - E4 (eng review):  ETag-based freshness — first GET stores ETag; later
 *                       calls send `If-None-Match` and fall back to the cached
 *                       payload on a 304. GitHub Pages emits stable ETags.
 *
 * Fetch flow (single canton):
 *
 *     fetchJobsForCanton('TI')
 *           │
 *           ▼
 *     ┌─────────────────────┐
 *     │  IDB cache lookup   │  (frontaliere-jobs-cache › canton-shards)
 *     │  key = 'TI'         │
 *     └─────────────────────┘
 *      │ miss              │ hit (record has etag)
 *      │                   │
 *      ▼                   ▼
 *    GET                  HEAD  /public/data/jobs-by-canton/TI.json
 *      │                  │  + If-None-Match: <etag>
 *      │                  │
 *      │            ┌─────┴─────┐
 *      │            │  status?  │
 *      │            └─────┬─────┘
 *      │           304    │   200 (etag changed)
 *      │            │     │
 *      │            ▼     ▼
 *      │       return  → re-GET
 *      │       cached    │
 *      ▼                 ▼
 *    parse JSON ──── store {etag, fetchedAt, jobs}
 *      │                 │
 *      └───────┬─────────┘
 *              ▼
 *           Job[]
 *
 * If IDB is unavailable (Safari private mode pre-iOS 14, ad-blockers, SSR)
 * every IDB call short-circuits to a direct fetch with no caching layer —
 * correctness over speed.
 */

/**
 * Permissive Job shape. The full Job interface lives in component-level types,
 * but this fetch/cache layer is structure-agnostic — it only needs to round-trip
 * the JSON payload. Consumers re-cast to their own Job interface.
 */
export type Job = Record<string, unknown>;

/** Sentinel canton code for the multi-canton aggregate shard. */
export const AGGREGATE_CANTON_CODE = '_AGGREGATE_' as const;

/** Default cantons fetched when callers don't specify (backward-compat = TI/GR/VS). */
export const DEFAULT_AGGREGATE_CANTONS: readonly string[] = ['TI', 'GR', 'VS'] as const;

const SHARD_BASE_PATH = '/data/jobs-by-canton';
const IDB_DB_NAME = 'frontaliere-jobs-cache';
const IDB_DB_VERSION = 1;
const IDB_STORE_NAME = 'canton-shards';
const SESSION_DEFAULT_CANTON_KEY = 'frontaliere:defaultCanton';

interface CantonCacheRecord {
 readonly cantonCode: string;
 readonly etag: string | null;
 readonly fetchedAt: number;
 readonly jobs: ReadonlyArray<Job>;
}

interface FetchAggregatedJobsOptions {
 /** Remove cross-canton duplicates (same fingerprint appearing in 2+ shards). */
 readonly deduplicate?: boolean;
}

// --------------------------------------------------------------------------
// IDB minimal wrapper (no external dep — `idb` package is NOT in package.json)
// --------------------------------------------------------------------------

/**
 * Open the IDB database. Returns null when IDB is unavailable (SSR, private
 * mode, ad-blockers, quota-exceeded). Callers MUST treat null as "no cache".
 */
function openCantonCacheDb(): Promise<IDBDatabase | null> {
 return new Promise((resolve) => {
  if (typeof indexedDB === 'undefined' || indexedDB === null) {
   resolve(null);
   return;
  }
  let request: IDBOpenDBRequest;
  try {
   request = indexedDB.open(IDB_DB_NAME, IDB_DB_VERSION);
  } catch {
   resolve(null);
   return;
  }
  request.onupgradeneeded = () => {
   const db = request.result;
   if (!db.objectStoreNames.contains(IDB_STORE_NAME)) {
    db.createObjectStore(IDB_STORE_NAME, { keyPath: 'cantonCode' });
   }
  };
  request.onsuccess = () => {
   resolve(request.result);
  };
  request.onerror = () => {
   resolve(null);
  };
  request.onblocked = () => {
   resolve(null);
  };
 });
}

function idbGet(db: IDBDatabase, cantonCode: string): Promise<CantonCacheRecord | null> {
 return new Promise((resolve) => {
  try {
   const tx = db.transaction(IDB_STORE_NAME, 'readonly');
   const store = tx.objectStore(IDB_STORE_NAME);
   const req = store.get(cantonCode);
   req.onsuccess = () => {
    const value = req.result as CantonCacheRecord | undefined;
    resolve(value ?? null);
   };
   req.onerror = () => resolve(null);
  } catch {
   resolve(null);
  }
 });
}

function idbPut(db: IDBDatabase, record: CantonCacheRecord): Promise<void> {
 return new Promise((resolve) => {
  try {
   const tx = db.transaction(IDB_STORE_NAME, 'readwrite');
   const store = tx.objectStore(IDB_STORE_NAME);
   store.put(record);
   tx.oncomplete = () => resolve();
   tx.onerror = () => resolve();
   tx.onabort = () => resolve();
  } catch {
   resolve();
  }
 });
}

// --------------------------------------------------------------------------
// Network helpers
// --------------------------------------------------------------------------

function buildShardUrl(cantonCode: string): string {
 // Encode just in case a code contains characters needing escaping (e.g. '_AGGREGATE_').
 return `${SHARD_BASE_PATH}/${encodeURIComponent(cantonCode)}.json`;
}

async function fetchShardDirect(cantonCode: string): Promise<{
 readonly jobs: ReadonlyArray<Job>;
 readonly etag: string | null;
}> {
 const url = buildShardUrl(cantonCode);
 const res = await fetch(url, { method: 'GET' });
 if (res.status === 404) {
  // Canton not yet built — keep the SPA alive, just log a warning.
  // eslint-disable-next-line no-console
  console.warn(`[jobsService] shard 404 for canton "${cantonCode}" at ${url}`);
  return { jobs: [], etag: null };
 }
 if (!res.ok) {
  throw new Error(`[jobsService] fetch ${url} failed: HTTP ${res.status}`);
 }
 const etag = res.headers.get('etag');
 const data = (await res.json()) as unknown;
 if (!Array.isArray(data)) {
  throw new Error(`[jobsService] shard payload for "${cantonCode}" is not an array`);
 }
 return { jobs: data as ReadonlyArray<Job>, etag };
}

async function revalidateWithEtag(
 cantonCode: string,
 etag: string,
): Promise<{ readonly status: 304 | 200; readonly jobs?: ReadonlyArray<Job>; readonly etag?: string | null }> {
 const url = buildShardUrl(cantonCode);
 // Use GET + If-None-Match. HEAD on GitHub Pages does NOT echo ETag reliably for
 // every CDN edge, and a conditional GET is what `Pragma: cache` was designed for.
 const res = await fetch(url, {
  method: 'GET',
  headers: { 'If-None-Match': etag },
 });
 if (res.status === 304) {
  return { status: 304 };
 }
 if (res.status === 404) {
  // eslint-disable-next-line no-console
  console.warn(`[jobsService] shard 404 on revalidate for canton "${cantonCode}"`);
  return { status: 200, jobs: [], etag: null };
 }
 if (!res.ok) {
  throw new Error(`[jobsService] revalidate ${url} failed: HTTP ${res.status}`);
 }
 const newEtag = res.headers.get('etag');
 const data = (await res.json()) as unknown;
 if (!Array.isArray(data)) {
  throw new Error(`[jobsService] revalidate payload for "${cantonCode}" is not an array`);
 }
 return { status: 200, jobs: data as ReadonlyArray<Job>, etag: newEtag };
}

// --------------------------------------------------------------------------
// Public API
// --------------------------------------------------------------------------

/**
 * Fetch the per-canton job shard, transparently using IDB cache + ETag
 * revalidation when the browser supports IDB.
 *
 * @param cantonCode  Two-letter Swiss canton code (e.g. `'TI'`, `'ZH'`) or the
 *                    sentinel {@link AGGREGATE_CANTON_CODE} (`'_AGGREGATE_'`)
 *                    for the multi-canton aggregate shard used when canton
 *                    intent is uncertain.
 * @returns           Job[] for the requested canton. Returns `[]` (not a
 *                    rejection) when the shard is missing (404), so callers
 *                    can render an empty state without try/catch noise.
 *
 * Behavior:
 *   - First call:   IDB miss → GET → store `{etag, fetchedAt, jobs}`
 *   - Later calls:  IDB hit  → conditional GET (If-None-Match) →
 *                   304 ⇒ return cached jobs;
 *                   200 ⇒ replace cache with new payload + new ETag.
 *   - Empty shards (canton with 0 jobs) are cached as `[]` so we don't
 *     re-fetch on every navigation.
 *   - IDB unavailable: degrades to a plain GET each time — correctness over
 *     bandwidth.
 */
export async function fetchJobsForCanton(cantonCode: string): Promise<Job[]> {
 if (typeof cantonCode !== 'string' || cantonCode.length === 0) {
  throw new Error('[jobsService] fetchJobsForCanton: cantonCode must be a non-empty string');
 }

 const db = await openCantonCacheDb();

 // No IDB available — straight GET, no cache.
 if (db === null) {
  const { jobs } = await fetchShardDirect(cantonCode);
  return [...jobs];
 }

 const cached = await idbGet(db, cantonCode);

 // Cache hit with ETag → revalidate.
 if (cached && cached.etag) {
  try {
   const result = await revalidateWithEtag(cantonCode, cached.etag);
   if (result.status === 304) {
    return [...cached.jobs];
   }
   const fresh: CantonCacheRecord = {
    cantonCode,
    etag: result.etag ?? null,
    fetchedAt: Date.now(),
    jobs: result.jobs ?? [],
   };
   await idbPut(db, fresh);
   return [...fresh.jobs];
  } catch (err: unknown) {
   // Network failure on revalidate → serve stale cache (bounded staleness
   // is preferred to a broken UI).
   // eslint-disable-next-line no-console
   console.warn('[jobsService] revalidate failed, serving stale cache', err);
   return [...cached.jobs];
  }
 }

 // Cache miss (or cached without ETag) → fresh GET.
 const { jobs, etag } = await fetchShardDirect(cantonCode);
 const record: CantonCacheRecord = {
  cantonCode,
  etag,
  fetchedAt: Date.now(),
  jobs,
 };
 await idbPut(db, record);
 return [...jobs];
}

/**
 * Fetch multiple canton shards in parallel and concatenate the results.
 *
 * @param cantonCodes  List of canton codes to fetch in parallel. Defaults to
 *                     {@link DEFAULT_AGGREGATE_CANTONS} (`['TI','GR','VS']`)
 *                     for backward-compat with the legacy "Italian-speaking
 *                     cantons" SPA behavior.
 * @param options      Optional flags. Set `deduplicate: true` to drop jobs
 *                     whose fingerprint (`fingerprint` field, falling back to
 *                     `id`, then `url`) appears more than once across shards.
 *
 * Each shard is fetched independently — a partial failure on one canton does
 * NOT abort the others (Promise.allSettled-style behavior). Failed shards log
 * a warning and contribute 0 jobs to the result.
 */
export async function fetchAggregatedJobs(
 cantonCodes: ReadonlyArray<string> = DEFAULT_AGGREGATE_CANTONS,
 options: FetchAggregatedJobsOptions = {},
): Promise<Job[]> {
 const settled = await Promise.allSettled(
  cantonCodes.map((code) => fetchJobsForCanton(code)),
 );
 const merged: Job[] = [];
 settled.forEach((result, idx) => {
  if (result.status === 'fulfilled') {
   merged.push(...result.value);
  } else {
   // eslint-disable-next-line no-console
   console.warn(
    `[jobsService] aggregated fetch failed for canton "${cantonCodes[idx]}"`,
    result.reason,
   );
  }
 });
 if (!options.deduplicate) {
  return merged;
 }
 const seen = new Set<string>();
 const deduped: Job[] = [];
 for (const job of merged) {
  const fp = jobFingerprint(job);
  if (fp === null) {
   // Cannot fingerprint — keep it (better duplicate than data loss).
   deduped.push(job);
   continue;
  }
  if (seen.has(fp)) continue;
  seen.add(fp);
  deduped.push(job);
 }
 return deduped;
}

/**
 * D11 — referrer-aware default canton resolution.
 *
 * Returns:
 *   - `'TI'` when `document.referrer` contains the substring `'frontaliere'`
 *     (the visitor came from the Italian-speaking frontaliere funnel and
 *     should land on the Ticino shard immediately).
 *   - {@link AGGREGATE_CANTON_CODE} otherwise (uncertain intent → load the
 *     multi-canton aggregate shard).
 *
 * The decision is cached in `sessionStorage` so subsequent in-session
 * navigations stay stable even after the referrer is lost (e.g. after a
 * client-side route push). Falls back to live evaluation when sessionStorage
 * is unavailable.
 */
export function getDefaultCantonForVisit(): string {
 // SSR / non-DOM environment: aggregate is the safe default.
 if (typeof window === 'undefined' || typeof document === 'undefined') {
  return AGGREGATE_CANTON_CODE;
 }

 // Try cached decision first.
 try {
  const cached = window.sessionStorage?.getItem(SESSION_DEFAULT_CANTON_KEY);
  if (cached) return cached;
 } catch {
  // sessionStorage blocked — fall through to live eval.
 }

 const referrer = typeof document.referrer === 'string' ? document.referrer : '';
 const decision = referrer.toLowerCase().includes('frontaliere')
  ? 'TI'
  : AGGREGATE_CANTON_CODE;

 try {
  window.sessionStorage?.setItem(SESSION_DEFAULT_CANTON_KEY, decision);
 } catch {
  // Ignore — quota / disabled storage; decision stays correct for this call.
 }
 return decision;
}

// --------------------------------------------------------------------------
// Backward-compat: monolithic `public/data/jobs.json` loader
// --------------------------------------------------------------------------

/**
 * @deprecated  D9: monolithic `public/data/jobs.json` is being phased out in
 *              favor of per-canton shards. Migrate consumers to
 *              {@link fetchJobsForCanton} or {@link fetchAggregatedJobs}.
 *
 * Provided as a thin pass-through so legacy callers (chatbotTools,
 * newsletterPreview, seoService, JobBoard fallback path) keep working during
 * the rollout window. Bypasses the IDB cache entirely.
 */
export async function fetchAllJobs(): Promise<Job[]> {
 const res = await fetch('/data/jobs.json');
 if (!res.ok) {
  throw new Error(`[jobsService] fetchAllJobs: HTTP ${res.status}`);
 }
 const data = (await res.json()) as unknown;
 if (!Array.isArray(data)) {
  throw new Error('[jobsService] fetchAllJobs: payload is not an array');
 }
 return data as Job[];
}

// --------------------------------------------------------------------------
// Internals
// --------------------------------------------------------------------------

function jobFingerprint(job: Job): string | null {
 const fp = job['fingerprint'];
 if (typeof fp === 'string' && fp.length > 0) return fp;
 const id = job['id'];
 if (typeof id === 'string' && id.length > 0) return id;
 if (typeof id === 'number') return String(id);
 const url = job['url'];
 if (typeof url === 'string' && url.length > 0) return url;
 return null;
}
