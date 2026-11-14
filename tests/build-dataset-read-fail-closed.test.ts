// W0-B: a build plugin that cannot read the job dataset must fail the build, not
// carry on with 0 jobs (run 43520109946, 2026-11-14: weekly-employers and
// orphan-query-landings logged "failed to parse jobs.json", went on with 0 jobs
// and reported degraded=false).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { jobsArrayFromParsed } from '../scripts/lib/read-large-json.mjs';
import { DatasetReadError, readJobsArrayStrict } from '../build-plugins/shared/readJobsDatasetStrict';
import { weeklyEmployersPlugin } from '../build-plugins/weeklyEmployersPlugin';
import { orphanQueryLandingPlugin } from '../build-plugins/orphanQueryLandingPlugin';
import { aggregateNursingJobs, _resetNursingJobsAggregateCache } from '../build-plugins/nursingJobsAggregate';
import { aggregateCareerLandings, _resetCareerJobsAggregateCache } from '../build-plugins/careerJobsAggregate';
import { aggregateAllCities } from '../build-plugins/cityJobsAggregate';
import { jobRecencyPagesPlugin } from '../build-plugins/jobRecencyPagesPlugin';
import { jobSectorPagesPlugin } from '../build-plugins/jobSectorPagesPlugin';
import { jobMarketSnapshotPlugin } from '../build-plugins/jobMarketSnapshotPlugin';
import { expiredJobsSplitPlugin } from '../build-plugins/expiredJobsSplitPlugin';
import { loadReportJobPanel } from '../build-plugins/shared/reportJobPanel';

let root: string;
const write = (rel: string, body: string) => {
  const target = path.join(root, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, body);
};
const runCloseBundle = (plugin: any) => plugin.closeBundle.call({});

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'dataset-fail-closed-'));
  _resetNursingJobsAggregateCache();
  _resetCareerJobsAggregateCache();
  // agent sessions export SKIP_* flags; the plugins must actually run here
  vi.stubEnv('SKIP_WEEKLY_EMPLOYERS', '');
  vi.stubEnv('SKIP_ORPHAN_LANDINGS', '');
  vi.stubEnv('SKIP_JOB_MARKET_SNAPSHOT', '');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('readJobsArrayStrict', () => {
  it('reads a healthy dataset', () => {
    write('data/jobs.json', JSON.stringify([{ id: 'a' }, { id: 'b' }]));
    expect(readJobsArrayStrict(root, 'test')).toHaveLength(2);
  });
  it('reads the { jobs: [...] } envelope as its inner array', () => {
    write('data/jobs.json', JSON.stringify({ jobs: [{ id: 'a' }] }));
    expect(readJobsArrayStrict(root, 'test')).toEqual([{ id: 'a' }]);
  });
  it.each([
    ['an empty object', '{}', 'object without a `jobs` array'],
    ['an object whose jobs is not an array', '{"jobs": 3}', 'object without a `jobs` array'],
    ['null', 'null', 'null'],
    ['a number', '42', 'number'],
    ['a string', '"jobs"', 'string'],
  ])('throws on a parsable but wrong-shaped dataset: %s (it used to read as 0 jobs)', (_name, body, shape) => {
    write('data/jobs.json', body);
    expect(() => readJobsArrayStrict(root, 'career-test')).toThrow(DatasetReadError);
    expect(() => readJobsArrayStrict(root, 'career-test')).toThrow(
      new RegExp(`\\[career-test\\] cannot read jobs\\.json: expected a JSON array or \\{ jobs: \\[\\.\\.\\.\\] \\}, got ${shape.replace(/[`.]/g, '\\$&')}`),
    );
  });
  it('does not wrap the shape error twice', () => {
    write('data/jobs.json', '{}');
    try { readJobsArrayStrict(root, 'x'); } catch (e: any) {
      expect(e.message.match(/cannot read/g)).toHaveLength(1);
      expect((e.cause as Error).message).toMatch(/expected a JSON array/);
    }
  });
  it('keeps a MISSING dataset as an empty corpus (fixture roots, shallow checkouts)', () => {
    expect(readJobsArrayStrict(root, 'test')).toEqual([]);
  });
  it('throws, naming the plugin, on an unparsable dataset', () => {
    write('data/jobs.json', '[{"id": "a"}, {"id":');
    expect(() => readJobsArrayStrict(root, 'weekly-test')).toThrow(DatasetReadError);
    expect(() => readJobsArrayStrict(root, 'weekly-test')).toThrow(/\[weekly-test\] cannot read jobs\.json.*refusing to continue with 0 jobs/);
  });
});

describe('plugins given an unreadable jobs.json', () => {
  beforeEach(() => {
    write('data/jobs.json', '{ this is not json');
  });

  it('weekly-employers throws instead of generating 0 pages', async () => {
    await expect(runCloseBundle(weeklyEmployersPlugin(root))).rejects.toThrow(/\[weekly-employers\] cannot read jobs\.json/);
  });

  it('orphan-query-landings throws instead of emitting 0 landings', async () => {
    write('data/gsc-orphan-queries-clusters.json', JSON.stringify({ clusters: [{}] }));
    await expect(runCloseBundle(orphanQueryLandingPlugin(root))).rejects.toThrow(/\[orphan-query-landings\] cannot read jobs\.json/);
  });

  it('the profession-family aggregates throw instead of returning empty snapshots', () => {
    expect(() => aggregateNursingJobs(root)).toThrow(/\[nursing-aggregate\] cannot read jobs\.json/);
    expect(() => aggregateCareerLandings(root)).toThrow(/\[career-aggregate\] cannot read jobs\.json/);
    expect(() => aggregateAllCities(root)).toThrow(/\[city-jobs-aggregate\] cannot read jobs\.json/);
  });
});

describe('weekly-employers with an unreadable crawler slice', () => {
  it('throws rather than silently dropping the slice', async () => {
    write('data/jobs.json', '[]');
    write('data/jobs/by-crawler/broken.json', '[{"slug":');
    await expect(runCloseBundle(weeklyEmployersPlugin(root))).rejects.toThrow(/\[weekly-employers\] cannot read broken\.json/);
  });
});

describe('the sibling plugins that used to log and carry on', () => {
  it('job-recency-pages, job-sector-pages, job-market-snapshot throw on an unreadable jobs.json', async () => {
    write('data/jobs.json', '{ not json');
    fs.mkdirSync(path.join(root, 'dist'), { recursive: true }); // job-market-snapshot returns early without it
    await expect(runCloseBundle(jobRecencyPagesPlugin(root))).rejects.toThrow(/\[job-recency-pages\] cannot read jobs\.json/);
    await expect(runCloseBundle(jobSectorPagesPlugin(root))).rejects.toThrow(/\[job-sector-pages\] cannot read jobs\.json/);
    await expect(runCloseBundle(jobMarketSnapshotPlugin(root))).rejects.toThrow(/\[job-market-snapshot\] cannot read jobs\.json/);
  });

  it('expired-jobs-split throws on an unreadable expired-jobs.json instead of writing 0 detail files', () => {
    write('data/expired-jobs.json', '[{"slug":');
    expect(() => runCloseBundle(expiredJobsSplitPlugin(root))).toThrow(/\[expired-jobs-split\] cannot read expired-jobs\.json/);
  });

  it('the annual/market report panel: missing = unavailable (null), unreadable = error, corrupt ROWS = unavailable', () => {
    expect(loadReportJobPanel(root, 2026)).toBeNull();
    write('data/jobs.json', '{ not json');
    expect(() => loadReportJobPanel(root, 2026)).toThrow(/\[report-job-panel\] cannot read jobs\.json/);
    write('data/jobs.json', JSON.stringify([{ canton: 7 }]));
    expect(loadReportJobPanel(root, 2026)).toBeNull();
  });
});

describe('a wrong-shaped jobs.json stops the plugins too, not just the shared reader', () => {
  it('the aggregates and the plugins that read the dataset themselves throw on {}', async () => {
    write('data/jobs.json', '{}');
    fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
    expect(() => aggregateNursingJobs(root)).toThrow(/\[nursing-aggregate\] cannot read jobs\.json/);
    expect(() => aggregateCareerLandings(root)).toThrow(/\[career-aggregate\] cannot read jobs\.json/);
    expect(() => aggregateAllCities(root)).toThrow(/\[city-jobs-aggregate\] cannot read jobs\.json/);
    await expect(runCloseBundle(jobRecencyPagesPlugin(root))).rejects.toThrow(/\[job-recency-pages\] cannot read jobs\.json: expected a JSON array/);
    await expect(runCloseBundle(jobSectorPagesPlugin(root))).rejects.toThrow(/\[job-sector-pages\] cannot read jobs\.json: expected a JSON array/);
    await expect(runCloseBundle(jobMarketSnapshotPlugin(root))).rejects.toThrow(/\[job-market-snapshot\] cannot read jobs\.json: expected a JSON array/);
  });
});

describe('scripts/snapshot-jobs-weekly.mjs accepts the same shapes as every strict reader', () => {
  const SCRIPT = path.resolve('scripts/snapshot-jobs-weekly.mjs');
  const run = (body: string) => {
    write('data/jobs.json', body);
    const res = spawnSync(process.execPath, [SCRIPT], {
      env: { PATH: process.env.PATH, JOBS_SNAPSHOT_ROOT: root },
      encoding: 'utf8',
    });
    const dir = path.join(root, 'data', 'jobs-snapshots-history');
    const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    return { res, files, dir };
  };

  it('{ "jobs": [...] } -> exit 0 and one row in the weekly snapshot', () => {
    const { res, files, dir } = run(JSON.stringify({ jobs: [{ company: 'Acme', slug: 'acme' }] }));
    expect(res.status, res.stderr).toBe(0);
    expect(files).toHaveLength(1);
    const snapshot = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
    expect(snapshot.jobs).toHaveLength(1);
    expect(snapshot.jobs[0]).toMatchObject({ slug: 'acme', employer: 'Acme' });
  });

  it('a plain array still works', () => {
    const { res, files } = run(JSON.stringify([{ company: 'Acme', slug: 'acme' }]));
    expect(res.status, res.stderr).toBe(0);
    expect(files).toHaveLength(1);
  });

  it.each(['{}', 'null', '42', '{"jobs":3}'])('%s -> exit != 0 and no snapshot written', (body) => {
    const { res, files } = run(body);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/cannot read jobs\.json: expected a JSON array or \{ jobs: \[\.\.\.\] \}, got /);
    expect(files).toEqual([]);
  });
});

describe('jobsArrayFromParsed (shared by the .mjs scripts)', () => {
  it('returns the array or the envelope, throws on anything else', () => {
    expect(jobsArrayFromParsed([1])).toEqual([1]);
    expect(jobsArrayFromParsed({ jobs: [2] })).toEqual([2]);
    for (const bad of [{}, null, 42, 'x', { jobs: {} }]) expect(() => jobsArrayFromParsed(bad)).toThrow(/expected a JSON array or \{ jobs: \[\.\.\.\] \}, got /);
  });
});
