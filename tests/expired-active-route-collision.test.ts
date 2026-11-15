// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assembleExpiredJobs,
  normalizeAndPersistExpiredSlice,
  persistExpiredArchive,
  repairExpiredArchiveSlicesAgainstActive,
} from '../scripts/assemble-jobs-dataset.mjs';
import {
  archiveRemovedJobsToSlice,
  repairExpiredRoutesAgainstActive,
} from '../scripts/lib/expired-jobs-archive.mjs';

const COLLIDING_ROUTE = 'same-title-company-lugano';
const ACTIVE_URL = 'https://jobs.example.test/active-1';
const EXPIRED_URL = 'https://jobs.example.test/expired-2';

function activeJob() {
  return {
    id: 'active-1',
    url: ACTIVE_URL,
    slug: COLLIDING_ROUTE,
    slugByLocale: { it: COLLIDING_ROUTE, de: COLLIDING_ROUTE, en: 'active-en' },
    previousSlugs: ['active-old'],
  };
}

function expiredJob(sourceIdentity = `url:${EXPIRED_URL}`) {
  return {
    slug: COLLIDING_ROUTE,
    expiredAt: '2026-10-20T00:00:00.000Z',
    slugByLocale: { it: COLLIDING_ROUTE, de: COLLIDING_ROUTE, en: 'expired-en' },
    previousSlugs: [COLLIDING_ROUTE, 'expired-old'],
    previousSlugsByLocale: { it: [COLLIDING_ROUTE], de: [COLLIDING_ROUTE] },
    sourceIdentity,
  };
}

describe('repairExpiredRoutesAgainstActive', () => {
  it('disambiguates a distinct archive posting across current and historical routes', () => {
    const active = activeJob();
    const expired = expiredJob();

    const result = repairExpiredRoutesAgainstActive([expired], [active]);

    expect(result.changed).toBe(2);
    expect(result.repairedRoutes).toBe(2);
    expect(expired.slug).toMatch(/^same-title-company-lugano-[0-9a-f]{8}$/);
    expect(expired.slugByLocale.it).toBe(expired.slug);
    expect(expired.slugByLocale.de).toBe(expired.slug);
    expect(expired.previousSlugs).toEqual(['expired-old']);
    expect(expired.previousSlugsByLocale).toEqual({
      it: [expired.slug],
      de: [expired.slug],
      en: [COLLIDING_ROUTE],
      fr: [COLLIDING_ROUTE],
    });
    expect(active.slug).toBe(COLLIDING_ROUTE);
    expect(active.slugByLocale.de).toBe(COLLIDING_ROUTE);
  });

  it('repairs only the locale whose route collides with the active posting', () => {
    const active = { ...activeJob(), slugByLocale: { it: COLLIDING_ROUTE } };
    const expired = {
      ...expiredJob(`url:${EXPIRED_URL}`),
      slugByLocale: { it: COLLIDING_ROUTE, de: COLLIDING_ROUTE },
      previousSlugs: [],
      previousSlugsByLocale: { it: [COLLIDING_ROUTE], de: [COLLIDING_ROUTE] },
    };

    const result = repairExpiredRoutesAgainstActive([expired], [active]);

    expect(result.repairedRoutes).toBe(1);
    expect(expired.slugByLocale.it).not.toBe(COLLIDING_ROUTE);
    expect(expired.slugByLocale.de).toBe(COLLIDING_ROUTE);
    expect(expired.previousSlugsByLocale).toEqual({
      it: [expired.slug],
      de: [COLLIDING_ROUTE],
    });
  });

  it('is deterministic and idempotent for the same source identity', () => {
    const first = expiredJob();
    const second = expiredJob();

    repairExpiredRoutesAgainstActive([first], [activeJob()]);
    const secondResult = repairExpiredRoutesAgainstActive([second], [activeJob()]);
    const thirdResult = repairExpiredRoutesAgainstActive([second], [activeJob()]);

    expect(second.slug).toBe(first.slug);
    expect(second.slugByLocale).toEqual(first.slugByLocale);
    expect(second.previousSlugs).toEqual(first.previousSlugs);
    expect(secondResult.changed).toBe(2);
    expect(thirdResult.changed).toBe(0);
  });

  it('fails closed for same-posting or identity-less archive evidence', () => {
    const samePosting = expiredJob(`url:${ACTIVE_URL}`);
    const unknownPosting = expiredJob(null);

    expect(repairExpiredRoutesAgainstActive([samePosting], [activeJob()]).changed).toBe(0);
    expect(repairExpiredRoutesAgainstActive([unknownPosting], [activeJob()]).changed).toBe(0);
    expect(samePosting.slug).toBe(COLLIDING_ROUTE);
    expect(unknownPosting.slug).toBe(COLLIDING_ROUTE);
  });

  it('carries a legacy aggregate through route repair when no slices exist', () => {
    const root = mkdtempSync(join(tmpdir(), 'expired-legacy-route-'));
    try {
      const slicesDir = join(root, 'expired-slices');
      const aggregatePath = join(root, 'expired-jobs.json');
      const publicPath = join(root, 'public', 'data', 'expired-jobs.json');
      mkdirSync(slicesDir, { recursive: true });

      const active = {
        ...activeJob(),
        id: 'active-source-test',
        url: 'https://source.test/active',
      };
      const legacyExpired = expiredJob('url:expired');
      writeFileSync(aggregatePath, JSON.stringify([legacyExpired]));

      const assembledLegacy = assembleExpiredJobs({ sliceDir: slicesDir, aggregatePath });
      const repair = repairExpiredRoutesAgainstActive(assembledLegacy, [active]);
      persistExpiredArchive(repair.entries, { aggregatePath, publicPath });

      const persisted = JSON.parse(readFileSync(aggregatePath, 'utf8'));
      // large-dataset-read-ok: publicPath is a fixture file written by persistExpiredArchive into a tmp dir
      const published = JSON.parse(readFileSync(publicPath, 'utf8'));
      expect(persisted[0].slug).toMatch(/^same-title-company-lugano-[0-9a-f]{8}$/);
      expect(persisted[0].slug).not.toBe(COLLIDING_ROUTE);
      expect(published).toEqual(persisted);
      expect(published[0].slug).not.toBe(COLLIDING_ROUTE);
      expect(active.slug).toBe(COLLIDING_ROUTE);
      expect(repair.repairedRoutes).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('repairs an existing expired slice before a slice-only crawler commit', () => {
    const root = mkdtempSync(join(tmpdir(), 'expired-slice-only-route-'));
    try {
      const active = activeJob();
      const expired = expiredJob();
      const sliceDir = join(root, 'expired-slices');
      mkdirSync(sliceDir, { recursive: true });
      writeFileSync(join(sliceDir, 'ipersonal.json'), JSON.stringify([expired]));

      const added = archiveRemovedJobsToSlice([], 'ipersonal', {
        dir: sliceDir,
        activeJobs: [active],
      });

      const persisted = JSON.parse(
        readFileSync(join(sliceDir, 'ipersonal.json'), 'utf8'),
      );
      expect(added).toBe(0);
      expect(persisted[0].slug).toMatch(/^same-title-company-lugano-[0-9a-f]{8}$/);
      expect(persisted[0].slug).not.toBe(COLLIDING_ROUTE);
      expect(active.slug).toBe(COLLIDING_ROUTE);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('repairs distinct source postings in a persisted slice without merging their history', () => {
    const root = mkdtempSync(join(tmpdir(), 'expired-distinct-source-route-'));
    try {
      const sharedRoute = 'same-title-company-lugano';
      const entries = [
        {
          companyKey: 'example-company',
          sourceIdentity: 'url:https://jobs.example.test/newer',
          url: 'https://jobs.example.test/newer',
          slug: 'newer-posting',
          expiredAt: '2026-11-07T00:00:00.000Z',
          slugByLocale: { it: 'newer-posting', de: 'newer-posting-de' },
          previousSlugs: [sharedRoute],
          previousSlugsByLocale: { it: [sharedRoute] },
        },
        {
          companyKey: 'example-company',
          sourceIdentity: 'url:https://jobs.example.test/older',
          url: 'https://jobs.example.test/older',
          slug: 'older-posting',
          expiredAt: '2026-10-07T00:00:00.000Z',
          slugByLocale: { it: 'older-posting', de: 'older-posting-de' },
          previousSlugs: [sharedRoute],
          previousSlugsByLocale: { it: [sharedRoute] },
        },
      ];
      const slicePath = join(root, 'example-company.json');

      expect(normalizeAndPersistExpiredSlice(slicePath, entries, {
        source: 'test/issue-17512',
      })).toBe(1);

      const persisted = JSON.parse(readFileSync(slicePath, 'utf8'));
      expect(persisted).toHaveLength(2);
      const owners = persisted.flatMap((entry: Record<string, unknown>) => [
        ...(Array.isArray(entry.previousSlugs) ? entry.previousSlugs : []),
      ]).filter((route: string) => route === sharedRoute);
      expect(owners).toHaveLength(1);
      expect(normalizeAndPersistExpiredSlice(slicePath, entries, {
        source: 'test/issue-17512',
      })).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reconciles same-posting ghosts from the uncapped slice corpus', () => {
    const root = mkdtempSync(join(tmpdir(), 'expired-slice-ghost-cap-'));
    try {
      const active = {
        ...activeJob(),
        title: 'Same title',
        company: 'Example Company',
        location: 'Lugano',
      };
      const expired = {
        ...expiredJob(`url:${ACTIVE_URL}`),
        title: active.title,
        company: active.company,
        location: active.location,
        expiredAt: '2026-01-01T00:00:00.000Z',
      };
      const sliceDir = join(root, 'expired-slices');
      mkdirSync(sliceDir, { recursive: true });
      const filler = Array.from({ length: 5000 }, (_, index) => ({
        slug: `expired-filler-${index}`,
        expiredAt: '2026-10-20T00:00:00.000Z',
      }));
      writeFileSync(join(sliceDir, 'ipersonal.json'), JSON.stringify([...filler, expired]));

      const capped = assembleExpiredJobs({
        sliceDir,
        aggregatePath: join(root, 'expired-jobs.json'),
      });
      expect(capped).toHaveLength(5000);
      expect(capped?.some((job: Job) => job.slug === COLLIDING_ROUTE)).toBe(false);

      const result = repairExpiredArchiveSlicesAgainstActive([active], { sliceDir });
      const persisted = JSON.parse(
        readFileSync(join(sliceDir, 'ipersonal.json'), 'utf8'),
      );

      expect(result.ghostCount).toBe(1);
      expect(result.mergedSlugs).toBeGreaterThan(0);
      expect(persisted).toHaveLength(5000);
      expect(persisted.some((job: Job) => job.slug === COLLIDING_ROUTE)).toBe(false);
      expect(active.previousSlugs).toContain('expired-old');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('persists distinct expired-route repair before the live slice observer reads it', () => {
    const root = mkdtempSync(join(tmpdir(), 'expired-slice-internal-collapse-'));
    try {
      const sliceDir = join(root, 'expired-slices');
      mkdirSync(sliceDir, { recursive: true });
      const duplicateSlug = 'ipersonal-duplicate-route';
      const entries = [
        {
          companyKey: 'ipersonal',
          slug: duplicateSlug,
          slugByLocale: { it: duplicateSlug },
          previousSlugs: [],
          expiredAt: '2026-10-02T00:00:00.000Z',
          sourceIdentity: 'url:https://jobs.example.test/expired-older',
        },
        {
          companyKey: 'ipersonal',
          slug: duplicateSlug,
          slugByLocale: { it: duplicateSlug },
          previousSlugs: [],
          expiredAt: '2026-10-03T00:00:00.000Z',
          sourceIdentity: 'url:https://jobs.example.test/expired-newer',
        },
      ];
      writeFileSync(join(sliceDir, 'ipersonal.json'), JSON.stringify(entries));

      const result = repairExpiredArchiveSlicesAgainstActive([{
        url: ACTIVE_URL,
        slug: 'active-route',
        slugByLocale: { it: 'active-route' },
      }], { sliceDir });

      const persisted = JSON.parse(
        readFileSync(join(sliceDir, 'ipersonal.json'), 'utf8'),
      );
      expect(result.collapsedRoutes).toBe(0);
      expect(result.repairedRoutes).toBe(1);
      expect(persisted).toHaveLength(2);
      expect(persisted[0].slug).toBe(duplicateSlug);
      expect(persisted[1].slug).toMatch(new RegExp(`^${duplicateSlug}-[0-9a-f]{8}$`));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('persists distinct expired-route repair with an empty active assembly', () => {
    const root = mkdtempSync(join(tmpdir(), 'expired-slice-empty-active-collapse-'));
    try {
      const sliceDir = join(root, 'expired-slices');
      mkdirSync(sliceDir, { recursive: true });
      const duplicateSlug = 'ipersonal-empty-active-duplicate-route';
      const entries = [
        {
          companyKey: 'ipersonal',
          slug: duplicateSlug,
          slugByLocale: { it: duplicateSlug },
          previousSlugs: [],
          expiredAt: '2026-10-02T00:00:00.000Z',
          sourceIdentity: 'url:https://jobs.example.test/expired-empty-older',
        },
        {
          companyKey: 'ipersonal',
          slug: duplicateSlug,
          slugByLocale: { it: duplicateSlug },
          previousSlugs: [],
          expiredAt: '2026-10-03T00:00:00.000Z',
          sourceIdentity: 'url:https://jobs.example.test/expired-empty-newer',
        },
      ];
      writeFileSync(join(sliceDir, 'ipersonal.json'), JSON.stringify(entries));

      const result = repairExpiredArchiveSlicesAgainstActive([], { sliceDir });

      const persisted = JSON.parse(
        readFileSync(join(sliceDir, 'ipersonal.json'), 'utf8'),
      );
      expect(result.collapsedRoutes).toBe(0);
      expect(result.repairedRoutes).toBe(1);
      expect(persisted).toHaveLength(2);
      expect(persisted[0].slug).toBe(duplicateSlug);
      expect(persisted[1].slug).toMatch(new RegExp(`^${duplicateSlug}-[0-9a-f]{8}$`));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
