import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  findMissingJobOgImageJobs,
  renderJobOgImages,
  type JobMinimal,
} from '../../build-plugins/jobOgImagesPlugin';
import {
  deferredJobOgImageFallbackUrl,
  parseJobOgRenderBudgetMs,
  sortJobsForOgRender,
} from '../../build-plugins/shared/jobOgRenderBudget.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-og-budget-'));
  tempDirs.push(dir);
  return dir;
}

function job(slug: string, postedDate: string): JobMinimal {
  return {
    id: slug,
    slugByLocale: { it: slug },
    titleByLocale: { it: 'Tecnico amministrativo' },
    title: 'Tecnico amministrativo',
    company: 'Azienda di prova',
    location: 'Lugano',
    postedDate,
    datePosted: postedDate,
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('per-job OG render budget', () => {
  it('uses hits first, defers misses safely, protects deferred cache entries, and treats an unset budget as unlimited', async () => {
    const workspace = tempDir();
    const cacheRoot = path.join(workspace, 'cache');
    const cachedJob = job('cached-job', '2026-11-09T12:00:00Z');
    const deferredJob = job('deferred-job', '2026-11-08T12:00:00Z');
    const deferredCacheEntry = path.join(cacheRoot, 'deferred-job.top-001.no-logo.v0.webp');
    const unrelatedOldCacheEntry = path.join(cacheRoot, 'unrelated.top-001.no-logo.v0.webp');

    const initial = await renderJobOgImages(ROOT, [cachedJob], {
      outDir: path.join(workspace, 'initial-dist'),
      cacheRoot,
      budgetMs: null,
    });
    expect(initial.rendered).toBe(2);
    expect(initial.deferred).toBe(0);

    fs.writeFileSync(deferredCacheEntry, 'deferred old cache');
    fs.writeFileSync(unrelatedOldCacheEntry, 'unrelated old cache');
    const deferredDist = path.join(workspace, 'deferred-dist');
    const deferred = await renderJobOgImages(ROOT, [cachedJob, deferredJob], {
      outDir: deferredDist,
      cacheRoot,
      budgetMs: 0,
    });

    expect(deferred.hits).toBe(1);
    expect(deferred.deferred).toBe(1);
    expect(deferred.deferredSlugs).toEqual(['deferred-job']);
    expect(fs.existsSync(path.join(deferredDist, 'og/jobs/cached-job.webp'))).toBe(true);
    expect(fs.existsSync(path.join(deferredDist, 'og/jobs/deferred-job.webp'))).toBe(false);
    expect(fs.existsSync(path.join(deferredDist, 'og/jobs/archive-landing-card.webp'))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(cacheRoot, '.deferred-fallbacks.json'), 'utf8')))
      .toEqual(['deferred-job']);
    expect(deferredJobOgImageFallbackUrl(
      'jobs/deferred-job.webp',
      'https://cdn.example.test',
      new Set(['deferred-job']),
    )).toBe('https://cdn.example.test/og/jobs/archive-landing-card.webp');
    expect(fs.existsSync(deferredCacheEntry)).toBe(true);
    expect(fs.existsSync(unrelatedOldCacheEntry)).toBe(false);

    const missing = findMissingJobOgImageJobs(ROOT, [cachedJob, deferredJob], cacheRoot);
    expect(missing.jobs.map((entry) => entry.slugByLocale?.it)).toEqual(['deferred-job']);
    expect(missing.archiveMissing).toBe(false);

    const unlimitedBudget = parseJobOgRenderBudgetMs(undefined);
    expect(unlimitedBudget).toBeNull();
    const unlimited = await renderJobOgImages(ROOT, [job('unlimited-job', '2026-11-07T12:00:00Z')], {
      outDir: path.join(workspace, 'unlimited-dist'),
      cacheRoot,
      budgetMs: unlimitedBudget,
    });
    expect(unlimited.rendered).toBe(1);
    expect(unlimited.deferred).toBe(0);
    expect(fs.existsSync(path.join(workspace, 'unlimited-dist/og/jobs/unlimited-job.webp'))).toBe(true);
  });

  it('orders render misses newest-first with stable slug ties', () => {
    const jobs = [
      job('same-date-z', '2026-11-09T12:00:00Z'),
      job('newest', '2026-11-10T12:00:00Z'),
      job('same-date-a', '2026-11-09T12:00:00Z'),
      job('unknown-date', ''),
    ];
    const sorted = sortJobsForOgRender(jobs);
    expect(sorted.map((entry) => entry.slugByLocale?.it)).toEqual([
      'newest',
      'same-date-a',
      'same-date-z',
      'unknown-date',
    ]);

    const popularFirst = sortJobsForOgRender(jobs, {
      'same-date-z': 100,
      newest: 2,
    });
    expect(popularFirst.map((entry) => entry.slugByLocale?.it)).toEqual([
      'same-date-z',
      'newest',
      'same-date-a',
      'unknown-date',
    ]);
  });
});
