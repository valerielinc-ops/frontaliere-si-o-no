// W0-B: a build plugin that cannot read the job dataset must fail the build, not
// carry on with 0 jobs (run 43520109946, 2026-11-14: weekly-employers and
// orphan-query-landings logged "failed to parse jobs.json", went on with 0 jobs
// and reported degraded=false).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatasetReadError, readJobsArrayStrict } from '../build-plugins/shared/readJobsDatasetStrict';
import { weeklyEmployersPlugin } from '../build-plugins/weeklyEmployersPlugin';
import { orphanQueryLandingPlugin } from '../build-plugins/orphanQueryLandingPlugin';
import { aggregateNursingJobs, _resetNursingJobsAggregateCache } from '../build-plugins/nursingJobsAggregate';
import { aggregateCareerLandings, _resetCareerJobsAggregateCache } from '../build-plugins/careerJobsAggregate';
import { aggregateAllCities } from '../build-plugins/cityJobsAggregate';

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
