/**
 * The ghost gate must not lose routes.
 *
 * It used to delete the whole archive record after copying only its current and
 * flat slugs to the active job, so per-locale `previousSlugsByLocale` routes
 * left both datasets. A record may now leave only when the matched active job
 * holds every route it served. Per-locale history moves only when both records
 * name the same posting with their own URL or source identity.
 *
 * All fixtures are invented.
 */
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reconcileGhostExpired } from '../scripts/assemble-jobs-dataset.mjs';
import { localeRouteKeys } from '../scripts/lib/expired-jobs-archive.mjs';

const sliceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-keep-slices-'));
afterAll(() => fs.rmSync(sliceDir, { recursive: true, force: true }));

const POSTING = 'https://careers.example-garden.test/jobs/greenhouse-keeper/7f3c9a2e-5b41-4d8e-9c02-6a1b2c3d4e5f';
const OTHER = 'https://careers.example-garden.test/jobs/greenhouse-keeper/0b9d8c7a-1e2f-4a3b-8c9d-0e1f2a3b4c5d';
const LISTING = 'https://careers.example-garden.test/it/jobs';
const META = { title: 'Greenhouse Keeper', company: 'Example Garden', location: 'Exampletown' };
const SHARED_IT = 'serrista-example-garden-exampletown';

type Job = Record<string, any>;

function activeJob(overrides: Job = {}): Job {
  return {
    ...META,
    url: POSTING,
    slug: SHARED_IT,
    slugByLocale: { it: SHARED_IT, en: 'greenhouse-keeper-example-garden-exampletown' },
    ...overrides,
  };
}

function ghost(overrides: Job = {}): Job {
  return {
    ...META,
    slug: SHARED_IT,
    slugByLocale: { it: SHARED_IT, de: 'gewaechshausgaertner-example-garden' },
    previousSlugsByLocale: {
      de: ['alter-gaertner-example-garden'],
      fr: ['ancien-serriste-example-garden'],
    },
    previousSlugs: ['alter-gaertner-example-garden', 'ancien-serriste-example-garden', 'legacy-only-example-garden'],
    sourceIdentity: `url:${POSTING}`,
    expiredAt: '2026-01-10T00:00:00.000Z',
    ...overrides,
  };
}

const routesOf = (...groups: Job[][]) => new Set(groups.flat().flatMap((job) => [...localeRouteKeys(job)]));

function run(active: Job[], expired: Job[], dir = sliceDir) {
  const before = routesOf(active, expired);
  const result = reconcileGhostExpired(active, expired, { sliceDir: dir });
  const after = routesOf(active, result.cleanedExpired);
  // The invariant: no route served by the input leaves both datasets.
  expect([...before].filter((route) => !after.has(route))).toEqual([]);
  return result;
}

const holds = (job: Job, slug: string) => [...localeRouteKeys(job)].some((route) => route.endsWith(`:${slug}`));

describe('reconcileGhostExpired — routes survive the ghost gate', () => {
  it('moves each locale history to the same posting and then drops the record', () => {
    const active = activeJob();
    const result = run([active], [ghost()]);

    expect(result.cleanedExpired).toEqual([]);
    expect(active.previousSlugsByLocale.de).toContain('alter-gaertner-example-garden');
    expect(active.previousSlugsByLocale.fr).toEqual(['ancien-serriste-example-garden']);
    expect(active.previousSlugsByLocale.it ?? []).not.toContain('alter-gaertner-example-garden');
    // A slug with unknown locale stays served under all four.
    for (const locale of ['it', 'en', 'de', 'fr']) {
      expect(localeRouteKeys(active).has(`${locale}:legacy-only-example-garden`)).toBe(true);
    }
  });

  it('does not assign locale history proven only by the merge history, and keeps the record', () => {
    const active = activeJob();
    const record = ghost({
      sourceIdentity: `url:${OTHER}`,
      sourceIdentityHistory: [{ sourceIdentity: `url:${POSTING}` }],
    });
    const result = run([active], [record]);

    expect(result.cleanedExpired).toEqual([record]);
    expect(result.retainedGhostCount).toBe(1);
    expect(result.ghostCount).toBe(0);
    expect(holds(active, 'ancien-serriste-example-garden')).toBe(false);
    expect(holds(active, 'alter-gaertner-example-garden')).toBe(false);
  });

  it('does not treat a listing-page URL as the identity of one posting', () => {
    const active = activeJob({ url: LISTING });
    const record = ghost({ sourceIdentity: `url:${LISTING}` });
    const result = run([active], [record]);

    expect(result.cleanedExpired).toEqual([record]);
    expect(holds(active, 'ancien-serriste-example-garden')).toBe(false);
  });

  it('does not assign history when a third record names the same URL for another job', () => {
    const active = activeJob();
    const record = ghost();
    const third = {
      ...META, title: 'Orchard Foreman', slug: 'capo-frutteto-example-garden',
      slugByLocale: { it: 'capo-frutteto-example-garden' }, sourceIdentity: `url:${POSTING}`,
    };
    const result = run([active], [record, third]);

    expect(result.cleanedExpired).toContain(record);
    expect(holds(active, 'ancien-serriste-example-garden')).toBe(false);
  });

  it('never evicts a route when a bucket is full: the record keeps what does not fit', () => {
    const full = Array.from({ length: 20 }, (_, index) => `old-french-${index}-example-garden`);
    const active = activeJob({ previousSlugsByLocale: { fr: [...full] }, previousSlugs: [...full] });
    const record = ghost();
    const result = run([active], [record]);

    expect(active.previousSlugsByLocale.fr).toEqual(full);
    expect(result.cleanedExpired).toEqual([record]);
  });

  it('keeps every record sharing a ghost identity while one of them holds an uncovered route', () => {
    const dir = fs.mkdtempSync(path.join(sliceDir, 'shared-'));
    const covered = ghost({
      id: 'shared-id', sourceIdentity: undefined, url: POSTING,
      slugByLocale: { it: SHARED_IT }, previousSlugs: [], previousSlugsByLocale: {},
    });
    const uncovered = {
      ...META, title: 'Orchard Foreman', url: POSTING, slug: 'capo-frutteto-example-garden',
      slugByLocale: { it: 'capo-frutteto-example-garden' }, expiredAt: '2026-01-09T00:00:00.000Z',
    };
    const file = path.join(dir, 'example-garden.json');
    fs.writeFileSync(file, JSON.stringify([covered, uncovered]));
    const result = run([activeJob()], [covered, uncovered], dir);

    expect(result.cleanedExpired).toHaveLength(2);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toHaveLength(2);
  });
});
