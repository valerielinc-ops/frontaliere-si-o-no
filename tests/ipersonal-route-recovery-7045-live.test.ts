// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { IPERSONAL_7045_LOST_ROUTES } from './fixtures/ipersonal-7045-routes';

const ROOT = resolve(import.meta.dirname, '..');
const ACTIVE_FILE = resolve(ROOT, 'data/jobs/by-crawler/ipersonal.json');
const EXPIRED_FILE = resolve(ROOT, 'data/jobs/expired/by-crawler/ipersonal.json');

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

function duplicateCount(values: Array<string | undefined>) {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.values()].filter((count) => count > 1).length;
}

describe('iPersonal live route recovery for issue 7045', () => {
  const active = (JSON.parse(readFileSync(ACTIVE_FILE, 'utf8')) as { jobs: Job[] }).jobs;
  const expired = JSON.parse(readFileSync(EXPIRED_FILE, 'utf8')) as Job[];

  it('restores every one of the 22 lost routes with one unambiguous owner', () => {
    const owners = routeOwners([...active, ...expired]);
    expect(IPERSONAL_7045_LOST_ROUTES).toHaveLength(22);
    expect(IPERSONAL_7045_LOST_ROUTES.filter((route) => !owners.has(route))).toEqual([]);
    expect(IPERSONAL_7045_LOST_ROUTES.filter((route) => owners.get(route) !== 1)).toEqual([]);
  });

  it('keeps the current generation structurally complete without identity collisions', () => {
    expect(active.length).toBeGreaterThan(0);
    expect(active.every(({ id, url, slug }) => Boolean(id && url && slug))).toBe(true);
    expect(duplicateCount(active.map(({ id }) => id))).toBe(0);
    expect(duplicateCount(active.map(({ url }) => url))).toBe(0);
    expect(duplicateCount([...active, ...expired].map(({ slug }) => slug))).toBe(0);
  });
});
