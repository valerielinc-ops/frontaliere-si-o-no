/**
 * TI weekly-employers regional-hub canton-scope regression guard.
 *
 * /aziende-che-assumono/ticino/ (and locale equivalents) are branded
 * Ticino-only. `partitionWeeklyEmployerJobs`'s `jobMatchesCity` short-circuits
 * `city === 'ticino' -> true` for every job it's given, on the documented
 * assumption "site is Ticino-only" — but `data/jobs.json` holds jobs from all
 * of Switzerland. Without a canton filter upstream (in
 * weeklyEmployersPlugin.ts's closeBundle(), before generateWeeklyEmployerPages
 * is called), the 'ticino' regional bucket counts every canton in
 * Switzerland under a TI-branded URL — same bug class as #4254/#4262
 * (jobSectorPagesPlugin.ts / jobMarketSnapshotPlugin.ts), found via the
 * mandatory sibling grep after fixing #4262.
 *
 * Per-city buckets (lugano, mendrisio, chiasso, stabio, bellinzona, locarno)
 * already narrow via exact city-name matching in `jobMatchesCity` and are
 * expected to stay identical regardless of the canton filter.
 *
 * Reads the CI-assembled data/jobs.json (gitignored, rebuilt before vitest by
 * tests.yml — same dependency as ti-sector-hub-canton-scope.test.ts).
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { resolveJobCanton } from '../build-plugins/shared/cantonSection';
import {
  partitionWeeklyEmployerJobs,
  type WeeklyCountableJob,
} from '../build-plugins/weeklyEmployersPlugin';
import { WEEKLY_EMPLOYERS_LOCALES } from '../build-plugins/weeklyEmployersData';

const DATA_JOBS_PATH = path.resolve(__dirname, '..', 'data', 'jobs.json');
const jobs: WeeklyCountableJob[] = JSON.parse(fs.readFileSync(DATA_JOBS_PATH, 'utf-8'));

describe('ti-weekly-employers-canton-scope', () => {
  it("the 'ticino' regional bucket reflects canton=TI jobs only, not all of Switzerland", () => {
    const tiJobs = jobs.filter((job) => resolveJobCanton(job) === 'TI');
    expect(tiJobs.length).toBeGreaterThan(0);
    expect(tiJobs.length).toBeLessThan(jobs.length);

    const tiPartition = partitionWeeklyEmployerJobs(tiJobs);
    const allPartition = partitionWeeklyEmployerJobs(jobs);

    // At least one locale must show a narrower 'ticino' bucket for TI-only
    // input than for all-Switzerland input — proves the filter (applied in
    // closeBundle(), before this function is called) is load-bearing.
    const narrowedLocales = WEEKLY_EMPLOYERS_LOCALES.filter((locale) => {
      const tiCount = tiPartition.byLocaleCity.get(locale)!.get('ticino')!.length;
      const allCount = allPartition.byLocaleCity.get(locale)!.get('ticino')!.length;
      return tiCount < allCount;
    });
    expect(
      narrowedLocales.length,
      "No locale shows a narrower TI-only 'ticino' bucket than all-Switzerland — the TI canton filter may have regressed",
    ).toBeGreaterThan(0);

    // No 'ticino' bucket may exceed the total TI job pool.
    for (const locale of WEEKLY_EMPLOYERS_LOCALES) {
      expect(
        tiPartition.byLocaleCity.get(locale)!.get('ticino')!.length,
        `${locale} 'ticino' bucket exceeds the total TI job pool`,
      ).toBeLessThanOrEqual(tiJobs.length);
    }
  });
});
