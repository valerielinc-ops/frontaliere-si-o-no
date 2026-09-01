import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { mergePreserveLocaleData } from '../scripts/lib/dedicated-crawler-common.mjs';
import { archiveRemovedJobsToSlice } from '../scripts/lib/expired-jobs-archive.mjs';
import { assertCompleteIpersonalSnapshot } from '../scripts/lib/ipersonal-spec-runtime.mjs';
import { computeCrawlDiff, snapshotJobSlugs } from '../scripts/jobs-url-helper.mjs';

const LOCALES = ['it', 'de', 'fr', 'en'];

function richDescription(index: number) {
  return [
    `Questa descrizione autorevole numero ${index} presenta responsabilità, competenze e condizioni della vacancy con sufficiente dettaglio professionale.`,
    '• Gestire attività specialistiche e documentare i risultati in modo accurato.',
    '• Collaborare con il team e garantire standard qualitativi elevati.',
  ].join('\n');
}

function makeJob(crawlerKey: string, index: number, fresh = false) {
  const host = crawlerKey === 'ipersonal' ? 'med-ipersonal.ch' : 'ipersonal.ch';
  const slug = `${fresh ? 'fresh' : 'legacy'}-${crawlerKey}-role-${index}`;
  const description = richDescription(index);
  return {
    id: `${crawlerKey}-${index}`,
    url: `https://${host}/jobs/role-${index}/`,
    slug,
    slugByLocale: Object.fromEntries(LOCALES.map((locale) => [locale, `${slug}-${locale}`])),
    previousSlugs: [`${crawlerKey}-flat-history-${index}`],
    previousSlugsByLocale: Object.fromEntries(
      LOCALES.map((locale) => [locale, [`${crawlerKey}-${locale}-history-${index}`]]),
    ),
    company: crawlerKey === 'ipersonal' ? 'iPersonal AG' : 'MediPersonal',
    companyKey: crawlerKey,
    title: `Ruolo specialistico ${index}`,
    titleByLocale: { de: `Fachrolle ${index}` },
    description,
    descriptionByLocale: { de: description },
    sourceLang: 'de',
    location: 'Zürich',
    canton: 'ZH',
    crawledAt: '2026-08-31T12:00:00.000Z',
    postedDate: '2026-08-30',
  };
}

function markDiscovered<T extends object[]>(
  jobs: T,
  discoveredCount: number,
  { expectedSeedCount = 1, loadedSeedCount = expectedSeedCount } = {},
): T {
  Object.defineProperty(jobs, 'discoveredCount', { value: discoveredCount, enumerable: false });
  Object.defineProperty(jobs, 'expectedSeedCount', {
    value: expectedSeedCount,
    enumerable: false,
  });
  Object.defineProperty(jobs, 'loadedSeedCount', { value: loadedSeedCount, enumerable: false });
  return jobs;
}

function routeSet(job: Record<string, any>) {
  const routes = new Set<string>();
  for (const locale of LOCALES) {
    if (job.slug) routes.add(`${locale}/${job.slug}`);
    if (job.slugByLocale?.[locale]) routes.add(`${locale}/${job.slugByLocale[locale]}`);
    for (const slug of job.previousSlugs || []) routes.add(`${locale}/${slug}`);
    for (const slug of job.previousSlugsByLocale?.[locale] || []) routes.add(`${locale}/${slug}`);
  }
  return routes;
}

function expectRoutesPreserved(before: Record<string, any>, after: Record<string, any>) {
  const afterRoutes = routeSet(after);
  expect([...routeSet(before)].filter((route) => !afterRoutes.has(route))).toEqual([]);
}

describe('iPersonal sister crawlers authoritative snapshots', () => {
  it.each([
    { crawlerKey: 'ipersonal', existingCount: 45, freshCount: 15, retiredCount: 30 },
    { crawlerKey: 'med-ipersonal', existingCount: 17, freshCount: 15, retiredCount: 2 },
  ])(
    'retires $crawlerKey $existingCount→$freshCount only after complete proof and preserves every route',
    ({ crawlerKey, existingCount, freshCount, retiredCount }) => {
      const existing = Array.from({ length: existingCount }, (_, index) => makeJob(crawlerKey, index));
      const fresh = markDiscovered(
        Array.from({ length: freshCount }, (_, index) => makeJob(crawlerKey, index, true)),
        freshCount,
      );

      expect(assertCompleteIpersonalSnapshot(fresh)).toBe(true);
      const merged = mergePreserveLocaleData(existing, structuredClone(fresh), {
        retainMissingJobs: false,
      });
      expect(merged).toHaveLength(freshCount);
      expect(merged.every((job) => job.crawlerMissStreak === undefined)).toBe(true);

      for (let index = 0; index < freshCount; index++) {
        const active = merged.find((job) => job.id === `${crawlerKey}-${index}`);
        expect(active).toBeDefined();
        expectRoutesPreserved(existing[index], active as Record<string, any>);
      }

      const second = mergePreserveLocaleData(merged, structuredClone(fresh), {
        retainMissingJobs: false,
      });
      expect(second).toEqual(merged);

      const diff = computeCrawlDiff(snapshotJobSlugs(existing), snapshotJobSlugs(merged));
      expect(diff.removedJobs).toHaveLength(retiredCount);
      const archiveDir = fs.mkdtempSync(path.join(os.tmpdir(), `${crawlerKey}-expired-`));
      try {
        expect(archiveRemovedJobsToSlice(diff.removedJobs, crawlerKey, { dir: archiveDir }))
          .toBe(retiredCount);
        const archived = JSON.parse(
          fs.readFileSync(path.join(archiveDir, `${crawlerKey}.json`), 'utf8'),
        );
        expect(archived).toHaveLength(retiredCount);
        for (const removed of diff.removedJobs) {
          const expired = archived.find((job: Record<string, any>) => job.slug === removed.slug);
          expect(expired).toBeDefined();
          expectRoutesPreserved(removed, expired);
        }
      } finally {
        fs.rmSync(archiveDir, { recursive: true, force: true });
      }
    },
  );

  it('fails closed when the source returns zero or only part of the attempted detail set', () => {
    expect(() => assertCompleteIpersonalSnapshot(markDiscovered([], 0))).toThrow(
      /no authoritative detail count/,
    );
    const partial = markDiscovered(
      Array.from({ length: 14 }, (_, index) => makeJob('ipersonal', index, true)),
      15,
    );
    expect(() => assertCompleteIpersonalSnapshot(partial)).toThrow(/parsed 14\/15/);
  });

  it('does not fail closed when the gap is fully explained by legitimate quality drops', () => {
    const partiallyFiltered = markDiscovered(
      Array.from({ length: 13 }, (_, index) => makeJob('ipersonal', index, true)),
      15,
    );
    Object.defineProperty(partiallyFiltered, 'qualityDroppedCount', {
      value: 2,
      enumerable: false,
    });
    expect(assertCompleteIpersonalSnapshot(partiallyFiltered)).toBe(true);
  });

  it('still fails closed when the gap exceeds the explained quality drops', () => {
    const partiallyFiltered = markDiscovered(
      Array.from({ length: 13 }, (_, index) => makeJob('ipersonal', index, true)),
      15,
    );
    Object.defineProperty(partiallyFiltered, 'qualityDroppedCount', {
      value: 1,
      enumerable: false,
    });
    expect(() => assertCompleteIpersonalSnapshot(partiallyFiltered)).toThrow(/parsed 13\/15/);
  });

  it('fails closed when a missing detail is explained by an HTTP/transport failure', () => {
    const partiallyFetched = markDiscovered(
      Array.from({ length: 13 }, (_, index) => makeJob('ipersonal', index, true)),
      15,
    );
    Object.defineProperty(partiallyFetched, 'qualityDroppedCount', { value: 1 });
    Object.defineProperty(partiallyFetched, 'detailFailureCount', { value: 1 });
    expect(() => assertCompleteIpersonalSnapshot(partiallyFetched)).toThrow(
      /detail fetch\/parse failure/,
    );
  });

  it.each([-1, 1.5, 16])('fails closed on malformed quality-drop accounting (%s)', (value) => {
    const batch = markDiscovered(
      Array.from({ length: 13 }, (_, index) => makeJob('ipersonal', index, true)),
      15,
    );
    Object.defineProperty(batch, 'qualityDroppedCount', { value });
    expect(() => assertCompleteIpersonalSnapshot(batch)).toThrow(/invalid quality-drop accounting/);
  });

  it.each([
    ['redirect collision', 'sourceIdentityCollisionCount'],
    ['unaccounted returned row', 'unaccountedReturnedCount'],
  ])('fails closed on %s instead of masking it as a quality drop', (_label, property) => {
    const batch = markDiscovered(
      Array.from({ length: 15 }, (_, index) => makeJob('ipersonal', index, true)),
      15,
    );
    Object.defineProperty(batch, property, { value: 1 });
    expect(() => assertCompleteIpersonalSnapshot(batch)).toThrow(/detail identity accounting mismatch/);
  });

  it.each([
    ['sourceIdentityCollisionCount', Number.NaN],
    ['unaccountedReturnedCount', -1],
  ])('fails closed on malformed %s evidence', (property, value) => {
    const batch = markDiscovered(
      Array.from({ length: 15 }, (_, index) => makeJob('ipersonal', index, true)),
      15,
    );
    Object.defineProperty(batch, property, { value });
    expect(() => assertCompleteIpersonalSnapshot(batch)).toThrow(/detail identity accounting mismatch/);
  });

  it('fails closed when any configured listing seed returns an empty body', () => {
    const partialSeedBatch = markDiscovered(
      Array.from({ length: 15 }, (_, index) => makeJob('ipersonal', index, true)),
      15,
      { expectedSeedCount: 2, loadedSeedCount: 1 },
    );
    expect(() => assertCompleteIpersonalSnapshot(partialSeedBatch)).toThrow(
      /loaded 1\/2 listing seeds/,
    );
  });

  it('keeps the authoritative retire opt-in limited to the two runners', () => {
    for (const runner of ['update-ipersonal-jobs.mjs', 'update-med-ipersonal-jobs.mjs']) {
      const source = fs.readFileSync(path.join(process.cwd(), 'scripts', runner), 'utf8');
      expect(source).toContain('validateAuthoritativeSnapshot: assertCompleteIpersonalSnapshot');
    }
    const template = fs.readFileSync(
      path.join(process.cwd(), 'scripts/lib/crawler-template.mjs'),
      'utf8',
    );
    expect(template).toContain('skipShrinkGuard: authoritativeSnapshotVerified');
    const fetchIndex = template.indexOf('parsedJobs = await fetchJobs()');
    const validationIndex = template.indexOf('evaluateAuthoritativeSnapshot(\n    parsedJobs');
    const mergeIndex = template.indexOf('mergePreserveLocaleData(companyExisting, parsedJobs');
    expect(fetchIndex).toBeGreaterThan(-1);
    expect(validationIndex).toBeGreaterThan(fetchIndex);
    expect(mergeIndex).toBeGreaterThan(validationIndex);
  });
});
