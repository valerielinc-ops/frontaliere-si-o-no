/**
 * TI sector-hub canton-scope regression guard.
 *
 * /cerca-lavoro-ticino/{sector}/ pages are branded Ticino-only. Without a
 * canton filter, jobSectorPagesPlugin.ts counted/listed every canton in
 * Switzerland under a TI-branded URL — fixed alongside this test (same bug
 * class as #3232, previously fixed for employer hubs in jobsSeoPagesPlugin.ts).
 *
 * Reads the CI-assembled data/jobs.json (gitignored, rebuilt before vitest by
 * tests.yml — same dependency as canton-ti-misclassification-guard.test.ts).
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { resolveJobCanton } from '@/build-plugins/shared/cantonSection';
import { SECTOR_HUB_KEYS, countSectorJobsByLocale } from '@/build-plugins/jobSectorLanding';

const DATA_JOBS_PATH = path.resolve(__dirname, '..', 'data', 'jobs.json');
const jobs: Array<{ canton?: string; location?: string }> = JSON.parse(
  fs.readFileSync(DATA_JOBS_PATH, 'utf-8'),
);

describe('ti-sector-hub-canton-scope', () => {
  it('TI sector-hub counts reflect canton=TI jobs only, not all of Switzerland', () => {
    const tiJobs = jobs.filter((job) => resolveJobCanton(job) === 'TI');
    expect(tiJobs.length).toBeGreaterThan(0);
    expect(tiJobs.length).toBeLessThan(jobs.length);

    const tiCounts = countSectorJobsByLocale(tiJobs as never);
    const allChCounts = countSectorJobsByLocale(jobs as never);

    // At least one sector must show fewer TI-only matches than all-Switzerland
    // matches — proves the filter is load-bearing, not a no-op. If every
    // sector goes flat (tiCounts === allChCounts everywhere), the canton
    // filter has silently regressed back to counting the whole country.
    const narrowedSectors = SECTOR_HUB_KEYS.filter(
      (sector) => tiCounts.it[sector] < allChCounts.it[sector],
    );
    expect(
      narrowedSectors.length,
      'No sector shows a narrower TI-only count than all-Switzerland — the TI canton filter may have regressed',
    ).toBeGreaterThan(0);

    // No TI sector-hub count may exceed the total TI job pool.
    for (const sector of SECTOR_HUB_KEYS) {
      expect(
        tiCounts.it[sector],
        `${sector} TI-scoped count exceeds the total TI job pool`,
      ).toBeLessThanOrEqual(tiJobs.length);
    }
  });
});
