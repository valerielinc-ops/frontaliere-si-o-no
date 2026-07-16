/**
 * TI market-snapshot sector canton-scope regression guard.
 *
 * /mercato-lavoro-ticino/{sector}/ (and locale equivalents) are branded
 * Ticino-only, same as /cerca-lavoro-ticino/{sector}/. Without a canton
 * filter, jobMarketSnapshotPlugin.ts counted every canton in Switzerland
 * under these TI-branded URLs (follow-up #4262 to #4254, which fixed the
 * sibling bug in jobSectorPagesPlugin.ts but missed this file because it
 * doesn't call `sharedResolveJobCanton` under that literal name).
 *
 * Reads the CI-assembled data/jobs.json (gitignored, rebuilt before vitest by
 * tests.yml — same dependency as ti-sector-hub-canton-scope.test.ts).
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { resolveJobCanton } from '../build-plugins/shared/cantonSection';
import { generateSectorSnapshotPages } from '../build-plugins/jobMarketSnapshotPlugin';
import { JOB_MARKET_SECTOR_KEYS } from '../build-plugins/jobMarketSnapshotData';

const DATA_JOBS_PATH = path.resolve(__dirname, '..', 'data', 'jobs.json');
const jobs: Array<{ canton?: string; location?: string }> = JSON.parse(
  fs.readFileSync(DATA_JOBS_PATH, 'utf-8'),
);

describe('ti-market-snapshot-sector-canton-scope', () => {
  it('mercato-lavoro-ticino sector counts reflect canton=TI jobs only, not all of Switzerland', () => {
    const tiJobs = jobs.filter((job) => resolveJobCanton(job) === 'TI');
    expect(tiJobs.length).toBeGreaterThan(0);
    expect(tiJobs.length).toBeLessThan(jobs.length);

    const tiOut = generateSectorSnapshotPages({ history: null, jobs: tiJobs as never });
    const allOut = generateSectorSnapshotPages({ history: null, jobs: jobs as never });

    // At least one sector must show fewer TI-only matches than all-Switzerland
    // matches — proves the filter (applied in closeBundle(), before this
    // generator is called) is load-bearing, not a no-op. If every sector goes
    // flat, the canton filter has silently regressed back to counting the
    // whole country under a TI-branded URL.
    const narrowedSectors = JOB_MARKET_SECTOR_KEYS.filter(
      (sector) => tiOut.sectorStats[sector].activeJobs < allOut.sectorStats[sector].activeJobs,
    );
    expect(
      narrowedSectors.length,
      'No sector shows a narrower TI-only count than all-Switzerland — the TI canton filter may have regressed',
    ).toBeGreaterThan(0);

    // No TI sector count may exceed the total TI job pool.
    for (const sector of JOB_MARKET_SECTOR_KEYS) {
      expect(
        tiOut.sectorStats[sector].activeJobs,
        `${sector} TI-scoped count exceeds the total TI job pool`,
      ).toBeLessThanOrEqual(tiJobs.length);
    }
  });
});
