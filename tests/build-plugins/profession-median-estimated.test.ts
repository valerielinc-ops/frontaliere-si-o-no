/**
 * professionJobsAggregate — live-median provenance tests.
 *
 * The re-enrich pipeline persists `salarySource` on every job. Estimated
 * bands (sector medians) are near-identical for every job in a sector, so
 * including them collapses the "live median" to the same ~62k value for
 * every profession. These tests pin the new contract:
 *   1. `salarySource === 'estimated'` jobs are EXCLUDED from the median;
 *   2. fewer than 3 real salary values → `medianSalaryChf` is null;
 *   3. legacy records without `salarySource` keep the old behaviour.
 *
 * Dates are always relative to the test clock — never absolute (CLAUDE.md).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as np from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  aggregateProfessionJobs,
  _resetProfessionJobsAggregateCache,
} from '../../build-plugins/professionJobsAggregate';

const NOW = Date.now();
const DAY_MS = 86_400_000;
const daysAgo = (n: number): string => new Date(NOW - n * DAY_MS).toISOString();

interface FixtureJob {
  salaryMin: number;
  salaryMax: number;
  salarySource?: string;
}

let tmpDir: string | null = null;

afterEach(() => {
  _resetProfessionJobsAggregateCache();
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
});

/** Write a jobs.json fixture of nurse jobs (all match the `infermiere`
 * matcher, all canton TI) and return the aggregate snapshot for it. */
function snapshotFor(jobs: readonly FixtureJob[]) {
  tmpDir = fs.mkdtempSync(np.join(os.tmpdir(), 'prof-agg-'));
  fs.mkdirSync(np.join(tmpDir, 'data'), { recursive: true });
  const records = jobs.map((j, i) => ({
    id: `job-${i}`,
    slug: `infermiere-${i}`,
    title: `Infermiere diplomato ${i}`,
    company: `Clinica ${i}`,
    canton: 'TI',
    addressLocality: 'Lugano',
    postedDate: daysAgo(2),
    ...j,
  }));
  fs.writeFileSync(
    np.join(tmpDir, 'data', 'jobs.json'),
    JSON.stringify(records),
  );
  _resetProfessionJobsAggregateCache();
  return aggregateProfessionJobs(tmpDir, NOW).infermiere;
}

describe('professionJobsAggregate — estimated salaries excluded from median', () => {
  it('computes the median from real salaries only, ignoring estimated bands', () => {
    const snap = snapshotFor([
      // 3 real values → midpoints 80k / 90k / 100k → median 90k
      { salaryMin: 75000, salaryMax: 85000, salarySource: 'reported' },
      { salaryMin: 85000, salaryMax: 95000, salarySource: 'existing' },
      { salaryMin: 95000, salaryMax: 105000, salarySource: 'reported' },
      // Estimated bands (the 49.5k–75k sector default) must not drag it down.
      { salaryMin: 49500, salaryMax: 75000, salarySource: 'estimated' },
      { salaryMin: 49500, salaryMax: 75000, salarySource: 'estimated' },
      { salaryMin: 49500, salaryMax: 75000, salarySource: 'estimated' },
    ]);
    expect(snap.liveCount).toBe(6);
    expect(snap.medianSalaryChf).toBe(90000);
  });

  it('emits null when fewer than 3 real salary values remain', () => {
    const snap = snapshotFor([
      { salaryMin: 75000, salaryMax: 85000, salarySource: 'reported' },
      { salaryMin: 85000, salaryMax: 95000, salarySource: 'existing' },
      { salaryMin: 49500, salaryMax: 75000, salarySource: 'estimated' },
      { salaryMin: 49500, salaryMax: 75000, salarySource: 'estimated' },
      { salaryMin: 49500, salaryMax: 75000, salarySource: 'estimated' },
    ]);
    expect(snap.medianSalaryChf).toBeNull();
  });

  it('keeps legacy records without salarySource in the median (pre-flag behaviour)', () => {
    const snap = snapshotFor([
      { salaryMin: 75000, salaryMax: 85000 },
      { salaryMin: 85000, salaryMax: 95000 },
      { salaryMin: 95000, salaryMax: 105000 },
    ]);
    expect(snap.medianSalaryChf).toBe(90000);
  });
});
