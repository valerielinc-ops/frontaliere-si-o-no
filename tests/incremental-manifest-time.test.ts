import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BENCHMARK = path.join(ROOT, 'scripts/dev/bench-incremental-manifest-time.mjs');

describe('incremental manifest registration time', () => {
  it('keeps bridge pages on the canonical digest budget at 100k pages', { timeout: 60_000 }, () => {
    const output = execFileSync(process.execPath, [BENCHMARK, '--json'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        INCREMENTAL_MANIFEST: '1',
      },
    });
    const report = JSON.parse(output.trim());
    const { uniqueIdBaseline, sameIdBaseline, fixed } = report;

    expect(report.pages).toBe(100_000);
    expect(report.bridgePages).toBe(30_000);
    expect(uniqueIdBaseline.manifestEntries).toBe(100_000);
    expect(fixed.manifestEntries).toBe(100_000);
    expect(uniqueIdBaseline.cacheStats.jobDigestsById.entries).toBe(100_030);
    expect(fixed.cacheStats.jobDigestsById.entries).toBe(70_030);
    expect(uniqueIdBaseline.cacheStats.computations.jobDigestComputations).toBe(100_030);
    expect(sameIdBaseline.cacheStats.jobDigestsById.entries).toBe(70_030);
    expect(sameIdBaseline.cacheStats.computations.jobDigestComputations).toBe(100_030);
    expect(fixed.cacheStats.computations.jobDigestComputations).toBe(70_030);
    expect(fixed.cacheStats.relatedJobProjectionsByKey.entries).toBe(30);
    expect(fixed.cacheStats.computations.relatedProjectionComputations).toBe(30);
    expect(fixed.cacheStats.jobDigestsById.entries).toBeLessThanOrEqual(report.assertions.maxDigestEntries);
    expect(fixed.elapsedMs).toBeLessThanOrEqual(report.assertions.maxFixedMs);
  });
});
