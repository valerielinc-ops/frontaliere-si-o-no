/**
 * Canton empty-fill regression guard.
 *
 * A live job whose location is a recognizable Swiss place MUST carry a canton:
 * the canton is the URL section (`/cerca-lavoro-<canton>/<slug>/`), so a job
 * left with canton="" cannot be placed and orphans. assemble-jobs-dataset.mjs
 * historically computed the inferred canton but only APPLIED it when a canton
 * was already present (`if (inferred && job.canton && …)`), so jobs posted with
 * an inferable-but-canton-only location (e.g. UBS roles with location "Ticino")
 * kept canton="" and were then FROZEN empty by the pin ledger — a permanent
 * mis-placement / 404 source. The fix fills the canton from inference even when
 * it was empty; this guard fails CI if that regresses.
 *
 * Reads the CI-assembled data/jobs.json (gitignored, rebuilt before vitest by
 * tests.yml — same dependency as tests/job-locale-completeness.test.ts).
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
// @ts-expect-error — plain .mjs lib, no type declarations
import { inferAnyCanton } from '../scripts/lib/target-swiss-locations.mjs';

interface Job {
  canton?: string;
  addressLocality?: string;
  location?: string;
  url?: string;
}

const DATA_JOBS_PATH = path.resolve(__dirname, '..', 'data', 'jobs.json');
const jobs: Job[] = JSON.parse(fs.readFileSync(DATA_JOBS_PATH, 'utf-8'));

describe('canton-empty-canton-guard', () => {
  it('jobs.json exists and is a non-empty array', () => {
    expect(Array.isArray(jobs)).toBe(true);
    expect(jobs.length).toBeGreaterThan(0);
  });

  it('no live job has an empty canton when its location is inferable', () => {
    const offenders: string[] = [];
    for (const job of jobs) {
      const canton = String(job.canton || '').trim();
      if (canton) continue;
      const loc = String(job.addressLocality || job.location || '').trim();
      if (loc.length < 2 || loc === 'CH') continue; // no usable location signal
      const inferred = inferAnyCanton(loc);
      if (inferred) {
        offenders.push(`loc="${loc}" inferable=${inferred} url=${(job.url || '').slice(0, 60)}`);
      }
    }
    expect(
      offenders.length,
      `Jobs with empty canton but inferable location (assemble must fill these):\n` +
        offenders.slice(0, 20).join('\n'),
    ).toBe(0);
  });
});
