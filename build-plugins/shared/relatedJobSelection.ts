export interface RelatedJobCandidate {
  readonly id?: unknown;
  readonly slug?: unknown;
  readonly category?: unknown;
  readonly location?: unknown;
}

type RelatedJobCacheEntry<T extends RelatedJobCandidate> = {
  readonly category: unknown;
  readonly location: unknown;
  readonly ownSlug: unknown;
  readonly selectionsBySeed: Map<number, T[]>;
};

/**
 * Index the active jobs once, then retain only the six related jobs used by
 * each rendered page. The complete category/location pool is rebuilt as a
 * short-lived array for a cache miss instead of being retained once per job.
 *
 * The cache key and first-record semantics match the old pool cache: jobs
 * sharing a stable ID use the first job's candidate pool, while each slug's
 * seed still selects its own deterministic six-item result.
 */
export function createRelatedJobSelector<T extends RelatedJobCandidate>(jobs: readonly T[]) {
  const byCategory = new Map<unknown, T[]>();
  const byLocation = new Map<unknown, T[]>();
  const sourceIndex = new WeakMap<object, number>();

  for (let index = 0; index < jobs.length; index += 1) {
    const job = jobs[index];
    sourceIndex.set(job as object, index);
    const categoryBucket = byCategory.get(job.category);
    if (categoryBucket) categoryBucket.push(job);
    else byCategory.set(job.category, [job]);

    const locationBucket = byLocation.get(job.location);
    if (locationBucket) locationBucket.push(job);
    else byLocation.set(job.location, [job]);
  }

  const cacheByStableId = new Map<string, RelatedJobCacheEntry<T>>();
  const cacheEntryFor = (job: T): RelatedJobCacheEntry<T> | null => {
    const stableId = String(job?.id ?? job?.slug ?? '');
    if (!stableId) return null;
    let entry = cacheByStableId.get(stableId);
    if (!entry) {
      entry = {
        category: job.category,
        location: job.location,
        ownSlug: job.slug,
        selectionsBySeed: new Map(),
      };
      cacheByStableId.set(stableId, entry);
    }
    return entry;
  };

  const candidatePoolFor = (job: T, entry = cacheEntryFor(job)): T[] => {
    const category = entry ? entry.category : job.category;
    const location = entry ? entry.location : job.location;
    const ownSlug = entry ? entry.ownSlug : job.slug;
    const seen = new Set<T>();
    const candidates: T[] = [];
    const addCandidates = (bucket?: T[]) => {
      if (!bucket) return;
      for (const candidate of bucket) {
        if (!candidate || candidate.slug === ownSlug || seen.has(candidate)) continue;
        seen.add(candidate);
        candidates.push(candidate);
      }
    };
    addCandidates(byCategory.get(category));
    addCandidates(byLocation.get(location));
    candidates.sort((a, b) =>
      (sourceIndex.get(a as object) ?? 0) - (sourceIndex.get(b as object) ?? 0),
    );
    return candidates;
  };

  const selectFromPool = (pool: T[], seed: number): T[] => {
    if (pool.length === 0) return [];
    const out: T[] = [];
    const seen = new Set<unknown>();
    const limit = Math.min(6, pool.length);
    for (let index = 0; index < limit; index += 1) {
      const candidate = pool[(seed + index * 2654435761) % pool.length];
      if (candidate && !seen.has(candidate.slug)) {
        seen.add(candidate.slug);
        out.push(candidate);
      }
    }
    for (let index = 0; out.length < limit && index < pool.length; index += 1) {
      const candidate = pool[index];
      if (candidate && !seen.has(candidate.slug)) {
        seen.add(candidate.slug);
        out.push(candidate);
      }
    }
    return out;
  };

  return {
    byCategory,
    byLocation,
    candidatePoolFor,
    select(job: T, seed: number, candidatePool?: T[]): T[] {
      const entry = cacheEntryFor(job);
      const cached = entry?.selectionsBySeed.get(seed);
      if (cached) return cached;
      const selected = selectFromPool(candidatePool ?? candidatePoolFor(job, entry), seed);
      entry?.selectionsBySeed.set(seed, selected);
      return selected;
    },
    get cacheSize(): number {
      return cacheByStableId.size;
    },
    clear(): void {
      cacheByStableId.clear();
      byCategory.clear();
      byLocation.clear();
    },
  };
}
