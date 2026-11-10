// @vitest-environment node
/**
 * The crawledAt heartbeat contract (lib/job-observation-heartbeat.mjs).
 *
 * On 2026-11-10, 1.535 ACTIVE slice records in 39 crawler slices had no
 * crawledAt, because their crawlers never passed `observedJobs` to the slice
 * writer; cleanup-jobs skipped every one of them (`ts > 0`), so a vacancy closed
 * at the source stayed active. These cases pin both halves: the writer default
 * that stamps what a successful write observed, and the last-observation age
 * that cleanup-jobs applies to a record still without one.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SLICE_WRITER_HEARTBEAT_SOURCE,
  jobLastObservedAtMs,
  measureHeartbeatlessActiveJobs,
  stampWriterObservedCrawledAt,
} from '../../scripts/lib/job-observation-heartbeat.mjs';

const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();

type Job = Record<string, unknown>;

describe('stampWriterObservedCrawledAt (writer default observation)', () => {
  it('stamps every active row without a heartbeat and marks it as writer-owned', () => {
    const observedAt = new Date();
    const jobs: Job[] = [
      { id: 'a', url: 'https://jobs.example.test/a' },
      { id: 'b', url: 'https://jobs.example.test/b', crawledAt: 'not-a-date' },
    ];

    expect(stampWriterObservedCrawledAt(jobs, observedAt)).toBe(2);
    for (const job of jobs) {
      expect(job.crawledAt).toBe(observedAt.toISOString());
      expect(job.crawledAtSource).toBe(SLICE_WRITER_HEARTBEAT_SOURCE);
    }
  });

  it('refreshes a heartbeat the writer stamped on an earlier run', () => {
    const observedAt = new Date();
    const jobs: Job[] = [{ id: 'a', crawledAt: daysAgo(40), crawledAtSource: SLICE_WRITER_HEARTBEAT_SOURCE }];

    expect(stampWriterObservedCrawledAt(jobs, observedAt)).toBe(1);
    expect(jobs[0].crawledAt).toBe(observedAt.toISOString());
  });

  it('leaves a heartbeat its crawler sets at fetch time to that crawler', () => {
    const crawlerHeartbeat = daysAgo(40);
    const jobs: Job[] = [{ id: 'a', crawledAt: crawlerHeartbeat }];

    expect(stampWriterObservedCrawledAt(jobs, new Date())).toBe(0);
    expect(jobs[0].crawledAt).toBe(crawlerHeartbeat);
    expect(jobs[0]).not.toHaveProperty('crawledAtSource');
  });

  it('never stamps a row the crawler kept without seeing it (grace) or already expired', () => {
    const jobs: Job[] = [
      { id: 'grace', crawlerMissStreak: 1 },
      { id: 'expired', expiredAt: daysAgo(2) },
    ];

    expect(stampWriterObservedCrawledAt(jobs, new Date())).toBe(0);
    expect(jobs[0]).not.toHaveProperty('crawledAt');
    expect(jobs[1]).not.toHaveProperty('crawledAt');
  });
});

describe('jobLastObservedAtMs (cleanup-jobs age of a record)', () => {
  it('uses crawledAt when the record has one', () => {
    const crawledAt = daysAgo(3);
    expect(jobLastObservedAtMs({ crawledAt, firstSeenAt: daysAgo(200) })).toBe(Date.parse(crawledAt));
  });

  it('ages an active record without crawledAt by the later of first sighting and its slice write', () => {
    const sliceWrite = Date.now() - 70 * DAY;
    expect(jobLastObservedAtMs({ firstSeenAt: daysAgo(200) }, { sliceObservedAtMs: sliceWrite })).toBe(sliceWrite);
    const firstSeen = daysAgo(10);
    expect(jobLastObservedAtMs({ firstSeenAt: firstSeen }, { sliceObservedAtMs: sliceWrite })).toBe(Date.parse(firstSeen));
  });

  it('does not age an active record without crawledAt when its slice is unknown', () => {
    expect(jobLastObservedAtMs({ firstSeenAt: daysAgo(200) })).toBeNull();
  });

  it('ages a grace record without crawledAt by its first sighting only: the slice write did not see it', () => {
    const firstSeen = daysAgo(90);
    expect(jobLastObservedAtMs(
      { firstSeenAt: firstSeen, crawlerMissStreak: 1 },
      { sliceObservedAtMs: Date.now() },
    )).toBe(Date.parse(firstSeen));
  });

  it('returns null when no observation is known at all', () => {
    expect(jobLastObservedAtMs({ crawlerMissStreak: 1 })).toBeNull();
    expect(jobLastObservedAtMs(null)).toBeNull();
  });
});

describe('measureHeartbeatlessActiveJobs (observer: target 0)', () => {
  it('counts active records without crawledAt per crawler, excluding grace and expired rows', () => {
    const report = measureHeartbeatlessActiveJobs([
      { file: 'alpha.json', jobs: [{ id: 1 }, { id: 2, crawledAt: daysAgo(1) }, { id: 3, crawlerMissStreak: 2 }] },
      { file: 'beta.json', jobs: [{ id: 4 }, { id: 5 }, { id: 6, expiredAt: daysAgo(1) }] },
      { file: 'gamma.json', jobs: [{ id: 7, crawledAt: daysAgo(1) }] },
    ]);

    expect(report).toEqual({
      total: 7,
      active: 5,
      heartbeatless: 3,
      byCrawler: [
        { crawler: 'beta', heartbeatless: 2, active: 2 },
        { crawler: 'alpha', heartbeatless: 1, active: 2 },
      ],
    });
  });

  it('reads 0 after one default writer pass over every slice', () => {
    const slices = [
      { file: 'alpha.json', jobs: [{ id: 1 }, { id: 2, crawlerMissStreak: 1 }] as Job[] },
      { file: 'beta.json', jobs: [{ id: 3 }, { id: 4, crawledAt: daysAgo(5) }] as Job[] },
    ];
    for (const slice of slices) stampWriterObservedCrawledAt(slice.jobs, new Date());
    expect(measureHeartbeatlessActiveJobs(slices).heartbeatless).toBe(0);
  });
});

describe('scripts/measure-heartbeatless-active-jobs.mjs (reproducible measure, usable as a gate)', () => {
  const script = path.resolve(process.cwd(), 'scripts/measure-heartbeatless-active-jobs.mjs');

  function fixtureDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heartbeatless-measure-'));
    fs.writeFileSync(path.join(dir, 'alpha.json'), JSON.stringify({ crawlerKey: 'alpha', jobs: [{ id: 1 }, { id: 2, crawledAt: daysAgo(1) }] }));
    fs.writeFileSync(path.join(dir, 'beta.json'), JSON.stringify({ crawlerKey: 'beta', jobs: [{ id: 3, crawlerMissStreak: 1 }] }));
    fs.writeFileSync(path.join(dir, 'alpha-locale-cache.json'), JSON.stringify([{ id: 'scratch' }]));
    return dir;
  }

  it('prints the per-crawler count and fails only above --max', () => {
    const dir = fixtureDir();
    try {
      const json = spawnSync(process.execPath, [script, '--dir', dir, '--json'], { encoding: 'utf8' });
      expect(json.status, json.stderr).toBe(0);
      expect(JSON.parse(json.stdout)).toMatchObject({
        total: 3,
        active: 2,
        heartbeatless: 1,
        byCrawler: [{ crawler: 'alpha', heartbeatless: 1, active: 2 }],
      });

      expect(spawnSync(process.execPath, [script, '--dir', dir, '--max', '1'], { encoding: 'utf8' }).status).toBe(0);
      const gate = spawnSync(process.execPath, [script, '--dir', dir, '--max', '0'], { encoding: 'utf8' });
      expect(gate.status).toBe(1);
      expect(gate.stderr).toContain('1 active records without crawledAt');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
