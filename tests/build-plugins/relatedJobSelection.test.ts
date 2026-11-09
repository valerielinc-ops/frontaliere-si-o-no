import { describe, expect, it } from 'vitest';

import { createRelatedJobSelector } from '@/build-plugins/shared/relatedJobSelection';

type Job = {
  id?: string;
  slug?: string;
  category?: string;
  location?: string;
};

function legacySelector(jobs: Job[]) {
  const byCategory = new Map<unknown, Job[]>();
  const byLocation = new Map<unknown, Job[]>();
  const sourceIndex = new WeakMap<object, number>();
  for (let index = 0; index < jobs.length; index += 1) {
    const job = jobs[index];
    sourceIndex.set(job, index);
    const category = byCategory.get(job.category);
    if (category) category.push(job);
    else byCategory.set(job.category, [job]);
    const location = byLocation.get(job.location);
    if (location) location.push(job);
    else byLocation.set(job.location, [job]);
  }

  const poolsById = new Map<string, Job[]>();
  const poolFor = (job: Job): Job[] => {
    const stableId = String(job.id ?? job.slug ?? '');
    let pool = stableId ? poolsById.get(stableId) : undefined;
    if (!pool) {
      const seen = new Set<Job>();
      pool = [];
      const add = (candidates?: Job[]) => {
        if (!candidates) return;
        for (const candidate of candidates) {
          if (!candidate || candidate.slug === job.slug || seen.has(candidate)) continue;
          seen.add(candidate);
          pool!.push(candidate);
        }
      };
      add(byCategory.get(job.category));
      add(byLocation.get(job.location));
      pool.sort((a, b) => (sourceIndex.get(a) ?? 0) - (sourceIndex.get(b) ?? 0));
      if (stableId) poolsById.set(stableId, pool);
    }
    return pool;
  };
  const select = (job: Job, seed: number): Job[] => {
    const pool = poolFor(job);
    if (pool.length === 0) return [];
    const out: Job[] = [];
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
  return select;
}

describe('related job selection memory bound', () => {
  it('keeps the legacy order and seeded six-job selection', () => {
    const jobs: Job[] = Array.from({ length: 40 }, (_, index) => ({
      id: `job-${index}`,
      slug: `role-${index}`,
      category: index % 4 === 0 ? 'care' : 'retail',
      location: `city-${index % 7}`,
    }));
    const legacySelect = legacySelector(jobs);
    const selector = createRelatedJobSelector(jobs);

    for (const job of jobs) {
      const seed = job.slug!.length * 2654435761 >>> 0;
      expect(selector.select(job, seed)).toEqual(legacySelect(job, seed));
    }

    expect(selector.cacheSize).toBe(jobs.length);
    selector.clear();
    expect(selector.cacheSize).toBe(0);
    expect(selector.byCategory.size).toBe(0);
    expect(selector.byLocation.size).toBe(0);
  });

  it('preserves first-pool reuse for duplicate IDs with distinct slug seeds', () => {
    const first: Job = { id: 'same-id', slug: 'first', category: 'care', location: 'lugano' };
    const duplicate: Job = { id: 'same-id', slug: 'second', category: 'retail', location: 'bern' };
    const jobs: Job[] = [
      first,
      { id: 'care-neighbor', slug: 'care-neighbor', category: 'care', location: 'chur' },
      duplicate,
      { id: 'retail-neighbor', slug: 'retail-neighbor', category: 'retail', location: 'basel' },
      { id: 'lugano-neighbor', slug: 'lugano-neighbor', category: 'office', location: 'lugano' },
    ];
    const legacySelect = legacySelector(jobs);
    const selector = createRelatedJobSelector(jobs);

    for (const [job, seed] of [[first, 7], [duplicate, 19], [duplicate, 7]] as const) {
      expect(selector.select(job, seed)).toEqual(legacySelect(job, seed));
    }
    expect(selector.cacheSize).toBe(1);
  });
});
