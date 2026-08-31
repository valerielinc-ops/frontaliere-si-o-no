// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listSliceFileNames } from '../../scripts/lib/crawler-slice-files.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const consumers = [
  ['assemble-jobs-dataset.mjs', 'listSliceFiles(d)'],
  ['mine-all-job-slugs.mjs', 'listSliceFileNames(dir)'],
  ['lib/prospector/sources/known-crawlers.mjs', 'listSliceFileNames(sliceDir)'],
  ['migrate-collapsed-job-ids.mjs', 'listSliceFileNames(dir)'],
  ['reconcile-job-slugs.mjs', 'listSliceFileNames(DATA_EXPIRED_SLICES_DIR)'],
  ['seed-url-first-seen-precise.mjs', 'listSliceFileNames(dir)'],
  ['sync-gsc-orphans.mjs', 'listSliceFileNames(crawlerDir)'],
  ['sync-gsc-orphans.mjs', 'listSliceFileNames(expiredCrawlerDir)'],
  ['sync-gsc-orphans.mjs', 'listSliceFileNames(bySliceDir)'],
] as const;

describe('crawler-slice listing siblings', () => {
  it.each(consumers)('%s delegates the slice listing through %s', (file, call) => {
    const source = readFileSync(path.join(ROOT, 'scripts', file), 'utf8');
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
        '.gitkeep',
      ]) {
        writeFileSync(path.join(dir, file), '{}');
      }
      expect(listSliceFileNames(dir)).toEqual(['alpha.json', 'zeta.json']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
