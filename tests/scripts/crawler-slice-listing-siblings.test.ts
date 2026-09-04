// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listSliceFileNames } from '../../scripts/lib/crawler-slice-files.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const consumers = [
  ['scripts/assemble-jobs-dataset.mjs', 'listSliceFiles(d)'],
  ['scripts/mine-all-job-slugs.mjs', 'listSliceFileNames(dir)'],
  ['scripts/lib/prospector/sources/known-crawlers.mjs', 'listSliceFileNames(sliceDir)'],
  ['scripts/migrate-collapsed-job-ids.mjs', 'listSliceFileNames(dir)'],
  ['scripts/reconcile-job-slugs.mjs', 'listSliceFileNames(DATA_EXPIRED_SLICES_DIR)'],
  ['scripts/seed-url-first-seen-precise.mjs', 'listSliceFileNames(dir)'],
  ['scripts/sync-gsc-orphans.mjs', 'listSliceFileNames(crawlerDir)'],
  ['scripts/sync-gsc-orphans.mjs', 'listSliceFileNames(expiredCrawlerDir)'],
  ['scripts/sync-gsc-orphans.mjs', 'listSliceFileNames(bySliceDir)'],
  ['build-plugins/orphanQueryLandingPlugin.ts', 'listSliceFileNames(sliceDir)'],
  ['build-plugins/weeklyEmployersPlugin.ts', 'listSliceFileNames(sliceDir)'],
  ['scripts/check-crawler-health.mjs', 'filter(isSliceFile)'],
  ['scripts/generate-crawler-companies.mjs', 'listSliceFileNames(SLICES_DIR)'],
  ['scripts/lib/job-mark-persistence.mjs', 'listSliceFileNames(byCrawler)'],
  ['scripts/lib/social-post-utils.mjs', 'listSliceFileNames(dir)'],
  ['scripts/send-newsletter.mjs', 'listSliceFileNames(fileURLToPath(slicesDir))'],
  ['scripts/update-swiss-medical-network-jobs.mjs', 'listSliceFileNames(dir)'],
] as const;

describe('crawler-slice listing siblings', () => {
  it.each(consumers)('%s delegates the slice listing through %s', (file, call) => {
    const source = readFileSync(path.join(ROOT, file), 'utf8');
    expect(source).toContain('crawler-slice-files.mjs');
    expect(source).toContain(call);
  });

  it('keeps real slices sorted while excluding cache and cleanup-orphan JSON', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'crawler-slice-siblings-'));
    try {
      for (const file of [
        'zeta.json',
        'alpha.json',
        'alpha-locale-cache.json',
        'alpha.json.cleanup-tmp.json',
        'acme-cache-solutions.json',
        'redis-cache.json',
        '.gitkeep',
      ]) {
        writeFileSync(path.join(dir, file), '{}');
      }
      expect(listSliceFileNames(dir)).toEqual([
        'acme-cache-solutions.json',
        'alpha.json',
        'redis-cache.json',
        'zeta.json',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
