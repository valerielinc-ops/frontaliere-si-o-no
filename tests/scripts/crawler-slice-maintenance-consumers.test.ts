// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAudit } from '../../scripts/audit-job-content-plausibility.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const consumers = [
  ['scripts/audit-job-content-plausibility.mjs', 'filter(isSliceFile)'],
  ['scripts/audit-job-locations.mjs', 'listSliceFileNames(dir)'],
  ['scripts/audit-job-title-locale.mjs', 'listSliceFileNames(sliceDir)'],
  ['scripts/backfill-firstSeenAt.mjs', 'filter(isSliceFile)'],
  ['scripts/clean-expired-slice-source-copies.mjs', 'listSliceFileNames(dir)'],
  ['scripts/dev/repair-canton-only-label-pins.mjs', 'isSliceFile(f)'],
  ['scripts/dry-run-target-cantons-flip.mjs', 'isSliceFile(e.name)'],
  ['scripts/flag-wrong-locale-descriptions.mjs', 'listSliceFileNames(byCrawlerDir)'],
  ['scripts/reconcile-duplicate-stable-id-jobs.mjs', 'filter(isSliceFile)'],
  ['scripts/repair-quote-truncated-titles.mjs', 'listSliceFileNames(JOB_SLICE_DIR)'],
  ['scripts/repair-translations.mjs', 'readdirSync(JOBS_DIR).filter(isSliceFile)'],
  ['scripts/repair-translations.mjs', 'readdirSync(SUMMARIES_DIR).filter(isSliceFile)'],
  ['scripts/report-crawler-content-error.mjs', 'filter(isSliceFile)'],
] as const;

describe('crawler-slice maintenance and audit consumers', () => {
  it.each(consumers)('%s delegates the slice predicate through %s', (file, call) => {
    const source = readFileSync(path.join(ROOT, file), 'utf8');
    expect(source).toContain('crawler-slice-files.mjs');
    expect(source).toContain(call);
  });

  it('keeps audit totals limited to real crawler slices', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'crawler-slice-maintenance-'));
    const payload = (crawlerKey: string) => JSON.stringify({
      crawlerKey,
      jobs: [{ title: 'Software Engineer', description: 'Build and maintain production software systems.' }],
    });
    try {
      writeFileSync(path.join(dir, 'alpha.json'), payload('alpha'));
      writeFileSync(path.join(dir, 'alpha-locale-cache.json'), payload('cache-decoy'));
      writeFileSync(path.join(dir, 'alpha.json.cleanup-tmp.json'), payload('cleanup-decoy'));

      const report = runAudit({ dir });
      expect(report.scannedCrawlers).toBe(1);
      expect(report.scannedJobs).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
