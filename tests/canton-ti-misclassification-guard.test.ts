/**
 * Canton TI-misclassification regression guard.
 *
 * A non-TI job must NOT be emitted under the Ticino section. The canton is the
 * URL section (`/cerca-lavoro-ticino/<slug>/` etc.), the sitemap shard, and the
 * JobPosting `addressRegion`, so a Bern job tagged canton="TI" gets a wrong-
 * canton URL, lands in `sitemap-jobs-ticino.xml`, ships `addressRegion:"TI"` in
 * its structured data, and — being buried in deep TI pagination — trips the
 * `audit:max-bfs-depth` gate (the 2026-06 validate-dist regression).
 *
 * Root cause: the canton pin ledger is keyed by `buildStableJobIdentity`, which
 * resolves to the apply URL. Crawlers that reuse one listing URL across postings
 * (galenica → `https://jobs.galenica.com/it/jobs`) collide to a single identity,
 * so one early TI pin froze ~220 non-TI jobs (Bern/Vaud/Zürich…) onto the TI
 * section even though their own location confidently resolves elsewhere. The fix
 * in assemble-jobs-dataset.mjs makes a confident location-inference authoritative
 * over a conflicting pin; this guard fails CI if that regresses.
 *
 * Reads the CI-assembled data/jobs.json (gitignored, rebuilt before vitest by
 * tests.yml — same dependency as tests/canton-empty-canton-guard.test.ts).
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
  addressRegion?: string;
  url?: string;
}

const DATA_JOBS_PATH = path.resolve(__dirname, '..', 'data', 'jobs.json');
const jobs: Job[] = JSON.parse(fs.readFileSync(DATA_JOBS_PATH, 'utf-8'));

describe('canton-ti-misclassification-guard', () => {
  it('jobs.json exists and is a non-empty array', () => {
    expect(Array.isArray(jobs)).toBe(true);
    expect(jobs.length).toBeGreaterThan(0);
  });

  it('no canton=TI job has a location that confidently resolves to a non-TI canton', () => {
    const offenders: string[] = [];
    for (const job of jobs) {
      if (String(job.canton || '').toUpperCase() !== 'TI') continue;
      const loc = String(job.addressLocality || job.location || '').trim();
      if (loc.length < 2 || loc === 'CH') continue; // no usable location signal
      const inferred = inferAnyCanton(loc);
      if (inferred && inferred !== 'TI') {
        offenders.push(`loc="${loc}" inferable=${inferred} url=${(job.url || '').slice(0, 60)}`);
      }
    }
    expect(
      offenders.length,
      `Jobs tagged canton="TI" whose location resolves to another canton ` +
        `(a colliding pin must not override location-inference):\n` +
        offenders.slice(0, 20).join('\n'),
    ).toBe(0);
  });
});
