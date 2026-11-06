import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The shared node_modules symlink can make Vitest resolve the project root to
// the workspace parent. Pin the generator's checkout analyzer to this repo so
// the test remains valid both locally and in the repository checkout used by CI.
process.env.CHECKOUT_ANALYZER_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

const {
  CRAWLER_GROUP_MAX_PARALLEL,
  JOB_TIMEOUT_MINUTES,
  crawlerWorkerWatchdogMinutes,
} = await import('../scripts/generate-crawler-group-workflows.mjs');

describe('crawler worker watchdog contract (#13803 FU-011)', () => {
  it('keeps an explicit target timeout below the job ceiling with one margin', () => {
    const targetTimeoutMinutes = 120;
    expect(crawlerWorkerWatchdogMinutes({ targetTimeoutMinutes })).toBe(targetTimeoutMinutes + 10);
    expect(crawlerWorkerWatchdogMinutes({ targetTimeoutMinutes: JOB_TIMEOUT_MINUTES })).toBe(
      JOB_TIMEOUT_MINUTES - 10,
    );
  });

  it('derives a bounded watchdog for measured and malformed durations', () => {
    expect(crawlerWorkerWatchdogMinutes({ durationMs: 20 * 60_000 })).toBe(60);
    expect(crawlerWorkerWatchdogMinutes({ durationMs: 1 })).toBe(30);
    expect(crawlerWorkerWatchdogMinutes({ durationMs: Number.NaN })).toBe(JOB_TIMEOUT_MINUTES - 10);
    expect(CRAWLER_GROUP_MAX_PARALLEL).toBeGreaterThan(0);
  });
});
