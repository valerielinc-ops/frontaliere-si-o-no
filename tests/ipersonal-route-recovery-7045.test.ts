// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { archiveRemovedJobsToSlice } from '../scripts/lib/expired-jobs-archive.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const ACTIVE_FILE = resolve(ROOT, 'data/jobs/by-crawler/ipersonal.json');
const EXPIRED_FILE = resolve(ROOT, 'data/jobs/expired/by-crawler/ipersonal.json');

const LOST_ROUTES = [
  'dipl-expertin-experte-anasthesiepflege-nds-80-100-in-rebstein-gesucht-8211-deine-expertise',
  'dipl-expertin-experte-anasthesiepflege-nds-80-100-in-rebstein-gesucht-deine-expertise-fur-hochste-patientensicherheit',
  'dipl-expertin-experte-anasthesiepflege-nds-80-100-in-rebstein-gesucht-deine-expertise-per-hochste-patientensicherheit-ipersonal-ag-rebstein',
  'dipl-expertin-experte-fur-notfallpflege-nds-80-100-in-goldach-gesucht-dein-fachwissen',
  'dipl-expertin-experte-intensivpflege-nds-80-100-fur-binningen-gesucht-dein-wissen-fur-eine',
  'dipl-expertin-experte-intensivpflege-nds-80-100-fur-neuenhof-gesucht-hochste-qualitat-in',
  'dipl-expertin-experte-intensivpflege-nds-80-100-fur-zofingen-gesucht-hochste-qualitat-in',
  'dipl-expertin-experte-intensivpflege-nds-80-100-in-olten-gesucht-hochste-pflegekompetenz',
  'dipl-expertin-experte-intensivpflege-nds-80-100-per-binningen-gesucht-dein-wissen-per-eine-optimale-patientenversorgung-ipersonal-ag-binningen',
  'dipl-expertin-experte-intensivpflege-nds-80-100-per-neuenhof-gesucht-hochste-qualitat-in-der-intensivpflege-ipersonal-ag-neuenhof',
  'dipl-expertin-experte-intensivpflege-nds-80-100-per-zofingen-gesucht-hochste-qualitat-in-der-intensivpflege-ipersonal-ag-zofingen',
  'dipl-expertin-experte-nds-notfallpflege-80-100-fur-samedan-gesucht-dein-fachwissen-fur',
  'dipl-expertin-experte-nds-notfallpflege-80-100-per-samedan-gesucht-dein-fachwissen-per-eine-schnelle-e-professionelle-versorgung-ipersonal-ag-samedan',
  'dipl-expertin-experte-per-notfallpflege-nds-80-100-in-goldach-gesucht-dein-fachwissen-rettet-leben-ipersonal-ag-goldach',
  'dipl-fachfrau-fachmann-operationstechnik-hf-80-100-in-aadorf-gesucht-deine-expertise-fur',
  'dipl-fachfrau-fachmann-operationstechnik-hf-80-100-in-aadorf-gesucht-deine-expertise-per-einen-reibungslosen-op-ablauf-ipersonal-ag-aadorf',
  'dipl-fachfrau-fachmann-operationstechnik-hf-80-100-in-bellikon-gesucht-deine-expertise-fur',
  'dipl-fachfrau-fachmann-operationstechnik-hf-80-100-in-bellikon-gesucht-deine-expertise-per-einen-reibungslosen-op-ablauf-ipersonal-ag-bellikon',
  'dipl-fachfrau-mann-operationstechnik-hf-80-100-fur-zurich-gesucht-spezialisiere-dich-auf',
  'dipl-fachfrau-mann-operationstechnik-hf-80-100-per-zurich-gesucht-spezialisiere-dich-auf-prazision-e-sicherheit-im-op-ipersonal-ag-zurich',
  'dipl-pflegefachfrau-pflegefachmann-uberwachungspflege-ndk-80-100-in-schinznach-gesucht',
  'dipl-pflegefachfrau-pflegefachmann-uberwachungspflege-ndk-80-100-in-st-moritz-gesucht',
].sort();

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

function duplicateCount(values: Array<string | undefined>) {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.values()].filter((count) => count > 1).length;
}

function routeOwners(jobs: Job[]) {
  const owners = new Map<string, number>();
  for (const job of jobs) {
    for (const route of routeSet(job)) owners.set(route, (owners.get(route) ?? 0) + 1);
  }
  return owners;
}

function incidentRemovedJobs(current: Job[]) {
  const routesByOwner = new Map<Job, string[]>();
  for (const route of LOST_ROUTES) {
    const matches = current.filter((job) => routeSet(job).has(route));
    if (matches.length !== 1) {
      throw new Error(`incident fixture lost unambiguous owner for ${route}`);
    }
    const routes = routesByOwner.get(matches[0]) ?? [];
    routes.push(route);
    routesByOwner.set(matches[0], routes);
  }
  return [...routesByOwner.values()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map((routes, index) => ({
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
  const active = (JSON.parse(readFileSync(ACTIVE_FILE, 'utf8')) as { jobs: Job[] }).jobs;
  const expired = JSON.parse(readFileSync(EXPIRED_FILE, 'utf8')) as Job[];

  it('restores every one of the 22 lost routes with one unambiguous owner', () => {
    const owners = routeOwners([...active, ...expired]);
    expect(LOST_ROUTES).toHaveLength(22);
    expect(LOST_ROUTES.filter((route) => !owners.has(route))).toEqual([]);
    expect(LOST_ROUTES.filter((route) => owners.get(route) !== 1)).toEqual([]);
  });

  it('keeps the current generation structurally complete without identity collisions', () => {
    expect(active.length).toBeGreaterThan(0);
    expect(active.every(({ id, url, slug }) => Boolean(id && url && slug))).toBe(true);
    expect(duplicateCount(active.map(({ id }) => id))).toBe(0);
    expect(duplicateCount(active.map(({ url }) => url))).toBe(0);
    expect(duplicateCount([...active, ...expired].map(({ slug }) => slug))).toBe(0);
  });

  it('fails closed on the causal 15-removed/3-archived shape and recovers idempotently', () => {
    const recovered = incidentRemovedJobs([...active, ...expired]);
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
