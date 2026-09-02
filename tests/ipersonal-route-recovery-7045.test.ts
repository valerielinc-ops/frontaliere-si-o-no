// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { archiveRemovedJobsToSlice } from '../scripts/lib/expired-jobs-archive.mjs';
import { IPERSONAL_7045_LOST_ROUTES } from './fixtures/ipersonal-7045-routes';

type Job = {
  id?: string;
  url?: string;
  slug?: string;
  slugByLocale?: Record<string, string>;
  previousSlugs?: string[];
  previousSlugsByLocale?: Record<string, string[]>;
};

function routeSet(job: Job) {
  return new Set([
    job.slug,
    ...Object.values(job.slugByLocale ?? {}),
    ...(job.previousSlugs ?? []),
    ...Object.values(job.previousSlugsByLocale ?? {}).flat(),
  ].filter((value): value is string => typeof value === 'string' && value.length > 0));
}

function routeOwners(jobs: Job[]) {
  const owners = new Map<string, number>();
  for (const job of jobs) {
    for (const route of routeSet(job)) owners.set(route, (owners.get(route) ?? 0) + 1);
  }
  return owners;
}

function incidentRemovedJobs() {
  // The incident had 15 removed jobs, 3 of which were already archived.
  const ownerCount = 15 - 3;
  const routesByOwner = Array.from({ length: ownerCount }, () => [] as string[]);
  IPERSONAL_7045_LOST_ROUTES.forEach((route, index) => {
    routesByOwner[index % ownerCount].push(route);
  });
  return routesByOwner.map((routes, index) => ({
      id: `incident-removed-${index}`,
      url: `https://jobs.example.invalid/incident-removed-${index}/`,
      slug: routes[0],
      previousSlugs: routes.slice(1),
    }));
}

function syntheticJob(kind: 'removed' | 'fresh', index: number): Job {
  return {
    id: `incident-${kind}-${index}`,
    url: `https://jobs.example.invalid/incident-${kind}-${index}/`,
    slug: `incident-${kind}-${index}`,
  };
}

function assertRetirementAccounting(removed: Job[], activeAfter: Job[], archivedAfter: Job[]) {
  const expectedRoutes = new Set(removed.flatMap((job) => [...routeSet(job)]));
  const ownersAfter = routeOwners([...activeAfter, ...archivedAfter]);
  const routesLost = [...expectedRoutes].filter((route) => !ownersAfter.has(route));
  const routeCollisions = [...expectedRoutes].filter((route) => (ownersAfter.get(route) ?? 0) > 1);
  const metrics = {
    removed: removed.length,
    archived: archivedAfter.length,
    routesLost: routesLost.length,
    routeCollisions: routeCollisions.length,
  };
  if (routesLost.length > 0 || routeCollisions.length > 0) {
    throw new Error(
      `retirement accounting failed: removed=${metrics.removed} archived=${metrics.archived} `
      + `routesLost=${metrics.routesLost} routeCollisions=${metrics.routeCollisions}`,
    );
  }
  return metrics;
}

describe('iPersonal route recovery for issue 7045', () => {
  it('fails closed on the causal 15-removed/3-archived shape and recovers idempotently', () => {
    const recovered = incidentRemovedJobs();
    expect(recovered).toHaveLength(12);
    const alreadyAccounted = Array.from({ length: 3 }, (_, index) => syntheticJob('removed', index));
    const removed = [...recovered, ...alreadyAccounted];
    const fresh = Array.from({ length: 15 }, (_, index) => syntheticJob('fresh', index));
    const archiveDir = mkdtempSync(join(tmpdir(), 'ipersonal-7045-'));
    const archiveFile = join(archiveDir, 'ipersonal.json');
    try {
      expect(archiveRemovedJobsToSlice(alreadyAccounted, 'ipersonal', { dir: archiveDir })).toBe(3);
      const partialArchive = JSON.parse(readFileSync(archiveFile, 'utf8')) as Job[];
      expect(() => assertRetirementAccounting(removed, fresh, partialArchive)).toThrow(
        'removed=15 archived=3 routesLost=22 routeCollisions=0',
      );

      expect(archiveRemovedJobsToSlice(removed, 'ipersonal', { dir: archiveDir })).toBe(12);
      const completeArchive = JSON.parse(readFileSync(archiveFile, 'utf8')) as Job[];
      expect(assertRetirementAccounting(removed, fresh, completeArchive)).toEqual({
        removed: 15,
        archived: 15,
        routesLost: 0,
        routeCollisions: 0,
      });

      const firstCompleteSnapshot = readFileSync(archiveFile, 'utf8');
      expect(archiveRemovedJobsToSlice(removed, 'ipersonal', { dir: archiveDir })).toBe(0);
      expect(readFileSync(archiveFile, 'utf8')).toBe(firstCompleteSnapshot);
    } finally {
      rmSync(archiveDir, { recursive: true, force: true });
    }
  });
});
