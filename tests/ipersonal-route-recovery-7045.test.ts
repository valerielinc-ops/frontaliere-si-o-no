// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { archiveRemovedJobsToSlice } from '../scripts/lib/expired-jobs-archive.mjs';
import { computeCrawlDiff, snapshotJobSlugs } from '../scripts/jobs-url-helper.mjs';
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

  it('wires the real crawler-pipeline classifier (snapshotJobSlugs + computeCrawlDiff) into the same removed set assertRetirementAccounting assumes', () => {
    // assertRetirementAccounting above is a test-local reimplementation fed a
    // hand-authored `removed` array. This test instead runs the ACTUAL
    // functions runStandardCrawlerPipeline (scripts/lib/crawler-template.mjs,
    // used by update-ipersonal-jobs.mjs) calls before archiveRemovedJobsToSlice:
    // snapshotJobSlugs() to build before/after maps, then computeCrawlDiff() to
    // classify vacancies as removed — proving the live pipeline feeds the
    // archive the same set/shape this suite assumes, not just the reimplementation.
    const recovered = incidentRemovedJobs(); // 12 jobs — vanish upstream THIS run
    // 3 jobs archived by an EARLIER run: already gone from the active slice
    // before this run starts, so (unlike `recovered`) they must not appear in
    // this run's before-snapshot — only in the archive file from that prior run.
    const priorRunArchived = Array.from({ length: 3 }, (_, index) => ({
      id: `prior-run-archived-${index}`,
      url: `https://jobs.example.invalid/prior-run-archived-${index}/`,
      slug: `prior-run-archived-${index}`,
    }));
    const retainedFresh = Array.from({ length: 15 }, (_, index) => syntheticJob('fresh', index));

    const archiveDir = mkdtempSync(join(tmpdir(), 'ipersonal-7045-wiring-'));
    const archiveFile = join(archiveDir, 'ipersonal.json');
    try {
      expect(archiveRemovedJobsToSlice(priorRunArchived, 'ipersonal', { dir: archiveDir })).toBe(3);

      // THIS run's active slice (before-snapshot) still holds `recovered` (about
      // to vanish) plus the retained jobs — priorRunArchived is already gone,
      // exactly as production leaves it after the earlier run dropped it.
      const beforeSnapshot = snapshotJobSlugs([...retainedFresh, ...recovered]);
      const afterSnapshot = snapshotJobSlugs(retainedFresh);
      const diff = computeCrawlDiff(beforeSnapshot, afterSnapshot);

      expect(new Set(diff.removedJobs.map((job) => job.id))).toEqual(
        new Set(recovered.map((job) => job.id)),
      );

      expect(archiveRemovedJobsToSlice(diff.removedJobs, 'ipersonal', { dir: archiveDir })).toBe(12);
      const archived = JSON.parse(readFileSync(archiveFile, 'utf8')) as Job[];
      const removedAcrossRuns = [...recovered, ...priorRunArchived];
      expect(assertRetirementAccounting(removedAcrossRuns, retainedFresh, archived)).toEqual({
        removed: 15,
        archived: 15,
        routesLost: 0,
        routeCollisions: 0,
      });
    } finally {
      rmSync(archiveDir, { recursive: true, force: true });
    }
  });
});
