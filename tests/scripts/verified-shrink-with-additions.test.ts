/**
 * End-to-end replay of the convit-holding failure in crawler group 19
 * (run 36296653467): the source dropped 81 of 90 postings, all
 * 404 at their own URL, and listed new ones in the same crawl. The count
 * guard tripped, `verifyShrinkAgainstSource()` corroborated every removal,
 * and the retry write then died in the byte guard of `writeJsonAtomic`
 * ("ABORT write ... 79.2% shrink"), because the housekeeping proof only
 * accepted a next slice that was a strict subset of the previous one.
 *
 * The test drives the real writer on a temporary slice. It is ≥1 MB and its
 * path ends in `data/jobs/by-crawler/<key>.json`, so `writeJsonAtomic` arms
 * the same byte guard as in CI. Only `gh` and the expired-slice archive are
 * stubbed: the archive path would otherwise resolve outside the temporary
 * directory.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const execFileSyncMock = vi.hoisted(() => vi.fn((command: string, args: string[] = []) => {
  if (command === 'gh' && args[0] === 'issue' && args[1] === 'list') return '[]';
  return '';
}));
vi.mock('node:child_process', () => ({ execFileSync: execFileSyncMock }));

const archiveMock = vi.hoisted(() => vi.fn((jobs: unknown[]) => (Array.isArray(jobs) ? jobs.length : 0)));
vi.mock('../../scripts/lib/expired-jobs-archive.mjs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../scripts/lib/expired-jobs-archive.mjs')>()),
  archiveRemovedJobsToSlice: archiveMock,
}));

import { writeJobsCrawlerSliceVerified } from '../../scripts/assemble-jobs-dataset.mjs';

type Job = { id: string; url: string; title: string; company: string; location: string; description: string };

function job(code: string, descriptionChars: number): Job {
  return {
    id: `convit-${code}`,
    url: `https://careers.example.invalid/convit-holding-gmbh/job/${code}`,
    title: `Consulente previdenziale ${code}`,
    company: 'Convit Holding GmbH',
    location: 'Lugano',
    description: `Consulenza previdenziale per clienti privati in Ticino. `.repeat(Math.ceil(descriptionChars / 56)),
  };
}

const ENV_KEYS = ['SKIP_OWNERSHIP_GUARD', 'GITHUB_SHA', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'JOBS_HOUSEKEEPING_PROOF_DIR'] as const;

describe('writeJobsCrawlerSliceVerified — corroborated shrink that also adds jobs', () => {
  let dir: string;
  let slicePath: string;
  let crawlerKey: string;
  const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frontaliere-verified-additions-'));
    // Same trick as tests/scripts/shrink-guard-evidence.test.ts: a crawler key
    // relative to the real slice directory keeps every write in `dir`. The
    // `data/jobs/by-crawler/` suffix is what makes the byte guard apply.
    const sliceDir = path.resolve(__dirname, '../../data/jobs/by-crawler');
    slicePath = path.join(dir, 'data', 'jobs', 'by-crawler', 'convit-replay.json');
    fs.mkdirSync(path.dirname(slicePath), { recursive: true });
    crawlerKey = path.relative(sliceDir, slicePath.slice(0, -'.json'.length));
    if (path.join(sliceDir, `${crawlerKey}.json`) !== slicePath) {
      throw new Error('test slice escaped the temporary directory');
    }
    process.env.SKIP_OWNERSHIP_GUARD = '1';
    process.env.GITHUB_SHA = 'verified-additions-head';
    process.env.GITHUB_RUN_ID = 'verified-additions-run';
    process.env.GITHUB_RUN_ATTEMPT = '1';
    process.env.JOBS_HOUSEKEEPING_PROOF_DIR = path.join(dir, 'proofs');
    execFileSyncMock.mockClear();
    archiveMock.mockClear();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function seedPrior(jobs: Job[]) {
    fs.writeFileSync(slicePath, `${JSON.stringify({ crawlerKey, jobs }, null, 2)}\n`, 'utf8');
    expect(fs.statSync(slicePath).size).toBeGreaterThan(1_000_000);
  }

  it('persists the smaller slice when every removed job is gone at the source', async () => {
    const gone = Array.from({ length: 24 }, (_, i) => job(`gone${i}`, 50_000));
    const kept = [job('kept0', 4_000), job('kept1', 4_000)];
    const fresh = [job('new0', 4_000), job('new1', 4_000)];
    seedPrior([...gone, ...kept]);
    const goneUrls = new Set(gone.map((j) => j.url));

    const result = await writeJobsCrawlerSliceVerified(crawlerKey, [...kept, ...fresh], {
      validate: async (jobs: Array<{ id: string; url: string }>) => jobs.map((j) => (goneUrls.has(j.url)
        ? { id: j.id, valid: false, definitive: true, status: 404, reason: 'http-404' }
        : { id: j.id, valid: true, reason: 'ok' })),
    });

    expect(result).toMatchObject({ written: true, shrinkAccepted: true });
    const written = JSON.parse(fs.readFileSync(slicePath, 'utf8'));
    expect(written.jobs.map((j: Job) => j.url).sort()).toEqual([...kept, ...fresh].map((j) => j.url).sort());
    expect(archiveMock).toHaveBeenCalledTimes(1);
    expect((archiveMock.mock.calls[0][0] as Job[]).map((j) => j.url).sort()).toEqual([...goneUrls].sort());
  });

  it('still keeps the prior slice when one removed job is alive at the source', async () => {
    const gone = Array.from({ length: 24 }, (_, i) => job(`gone${i}`, 50_000));
    const kept = [job('kept0', 4_000), job('kept1', 4_000)];
    const fresh = [job('new0', 4_000), job('new1', 4_000)];
    seedPrior([...gone, ...kept]);
    const before = fs.readFileSync(slicePath, 'utf8');
    const stillLive = gone[0].url;

    await expect(writeJobsCrawlerSliceVerified(crawlerKey, [...kept, ...fresh], {
      validate: async (jobs: Array<{ id: string; url: string }>) => jobs.map((j) => (j.url === stillLive
        ? { id: j.id, valid: true, status: 200, reason: 'ok' }
        : { id: j.id, valid: false, definitive: true, status: 404, reason: 'http-404' })),
    })).rejects.toThrow();
    expect(fs.readFileSync(slicePath, 'utf8')).toBe(before);
  });
});
