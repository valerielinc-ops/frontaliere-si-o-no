import { resolveJobCanton } from './cantonSection';

interface ArchiveCandidate {
  canton?: string;
  location?: string;
  company?: string;
  slug?: string;
  expired?: boolean;
}

/** Bounded canton-specific pools; historical vacancies never become alternatives. */
export function buildArchiveJobRecommendations<T extends ArchiveCandidate>(jobs: readonly T[]) {
  const companyJobs = new Map<string, T[]>();
  const cantonJobs = new Map<string, T[]>();
  for (const job of jobs) {
    if (job.expired) continue;
    const canton = resolveJobCanton(job);
    const pool = cantonJobs.get(canton) || [];
    if (pool.length < 50) pool.push(job);
    cantonJobs.set(canton, pool);
    const company = String(job.company || '').toLowerCase();
    if (!company) continue;
    const key = `${canton}:${company}`;
    const employerPool = companyJobs.get(key) || [];
    if (employerPool.length < 5) employerPool.push(job);
    companyJobs.set(key, employerPool);
  }
  const recent = (offset: number, excludeSlug: string, canton: string): T[] => {
    const pool = cantonJobs.get(canton) || [];
    const result: T[] = [];
    for (let i = 0; i < pool.length && result.length < 5; i++) {
      const job = pool[(Math.abs(offset) + i) % pool.length];
      if (job.slug !== excludeSlug) result.push(job);
    }
    return result;
  };
  return { companyJobs, cantonJobs, recent };
}
