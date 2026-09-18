import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BENCHMARK = path.join(ROOT, 'scripts/dev/bench-incremental-manifest-time.mjs');

describe('incremental manifest registration time', () => {
  it('measures the production-shaped bridge input below the 0.5 ms/page target', { timeout: 60_000 }, () => {
    const output = execFileSync(process.execPath, [BENCHMARK, '--json'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        INCREMENTAL_MANIFEST: '1',
        INCREMENTAL_MANIFEST_BENCH_PAGES: '2000',
        INCREMENTAL_MANIFEST_BENCH_POOL: '2162',
      },
    });
    const report = JSON.parse(output.trim());
    const { thirtyRelatedBaseline, before, canonicalBefore, after } = report;

    expect(report.pages).toBe(2_000);
    expect(report.bridgePages).toBe(2_000);
    expect(report.relatedPoolCount).toBe(2_162);
    expect(report.renderedRelatedCount).toBe(6);
    expect(report.estimatedRelatedCount).toBe(30);
    expect(report.realRecordBytes).toBeGreaterThanOrEqual(20_000);
    expect(report.realRecordBytes).toBeLessThanOrEqual(30_000);
    expect(report.realRelatedRecordBytes).toBeGreaterThanOrEqual(20_000);
    expect(report.recordPlus30DigestMs).toBeGreaterThan(0);
    expect(thirtyRelatedBaseline.manifestEntries).toBe(2_000);
    expect(before.manifestEntries).toBe(2_000);
    expect(canonicalBefore.manifestEntries).toBe(2_000);
    expect(after.manifestEntries).toBe(2_000);
    expect(before.msPerPage).toBeGreaterThan(after.msPerPage);
    expect(canonicalBefore.msPerPage).toBeGreaterThan(after.msPerPage);
    expect(before.cacheStats.computations.jobDigestComputations).toBeGreaterThanOrEqual(2_000);
    expect(after.msPerPage).toBeLessThanOrEqual(report.assertions.maxFixedMsPerPage);
    expect(after.projected100kMs).toBeLessThanOrEqual(report.assertions.maxFixedProjected100kMs);
    expect(after.cacheStats.jobDigestsById.entries).toBeLessThanOrEqual(7);
    expect(after.cacheStats.computations.jobDigestComputations).toBeLessThanOrEqual(7);
    expect(after.cacheStats.relatedJobProjectionsByKey.entries).toBeLessThanOrEqual(6);
    expect(after.cacheStats.computations.relatedProjectionComputations).toBeLessThanOrEqual(6);
  });
});
