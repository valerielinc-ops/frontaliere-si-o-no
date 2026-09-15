import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  latestLiveJobStartMs,
  selectStaleDeployBuildRuns,
  staleDeployBuildAgeMinutes,
} from '../scripts/ci/reap-stale-deploy-build.mjs';

const NOW = Date.parse('2026-09-15T19:30:00Z');
const old = '2026-09-15T12:50:00Z';
const recent = '2026-09-15T19:00:00Z';
const run = (id: number, status = 'in_progress', created_at = old) => ({
  id,
  status,
  created_at,
  run_started_at: created_at,
  head_sha: `sha-${id}`,
});
const jobs = (started_at = old) => ([
  { id: 1, status: 'in_progress', started_at },
  { id: 2, status: 'in_progress', started_at },
]);

describe('reap-stale-deploy-build', () => {
  it('selects a live deploy build beyond the bounded timeout backstop', () => {
    const selected = selectStaleDeployBuildRuns(
      [run(34972736506)],
      new Map([['34972736506', jobs()]]),
      { nowMs: NOW, thresholdMinutes: 390 },
    );
    expect(selected.map((item) => item.id)).toEqual([34972736506]);
  });

  it('does not cancel a build still inside the threshold', () => {
    expect(selectStaleDeployBuildRuns(
      [run(2, 'in_progress', recent)],
      { 2: jobs(recent) },
      { nowMs: NOW, thresholdMinutes: 390 },
    )).toEqual([]);
  });

  it.each(['queued', 'pending', 'waiting', 'completed', 'cancelled'])('never selects %s runs', (status) => {
    expect(selectStaleDeployBuildRuns(
      [run(3, status)],
      { 3: jobs() },
      { nowMs: NOW, thresholdMinutes: 390 },
    )).toEqual([]);
  });

  it('fails closed when job evidence is missing or no job is live', () => {
    expect(selectStaleDeployBuildRuns([run(4)], {}, { nowMs: NOW, thresholdMinutes: 390 })).toEqual([]);
    expect(selectStaleDeployBuildRuns(
      [run(5)],
      { 5: [{ status: 'completed', started_at: old }] },
      { nowMs: NOW, thresholdMinutes: 390 },
    )).toEqual([]);
  });

  it('waits for a recently started matrix leg before cancelling', () => {
    expect(selectStaleDeployBuildRuns(
      [run(6)],
      { 6: [...jobs(old), { status: 'in_progress', started_at: recent }] },
      { nowMs: NOW, thresholdMinutes: 390 },
    )).toEqual([]);
  });

  it('uses the latest live job start as the age boundary', () => {
    const sourceRun = run(7);
    expect(latestLiveJobStartMs(sourceRun, [...jobs(old), { status: 'in_progress', started_at: recent }]))
      .toBe(Date.parse(recent));
    expect(staleDeployBuildAgeMinutes(sourceRun, jobs(), NOW)).toBe(400);
  });

  it('wires the reaper before the existing publish-gate unwedger', () => {
    const workflow = readFileSync(resolve('.github/workflows/pages-publish-lag-watchdog.yml'), 'utf8');
    const reap = workflow.indexOf('Reap stale deploy build lock');
    const unwedge = workflow.indexOf('Unwedge the pages-deploy queue');
    expect(reap).toBeGreaterThan(-1);
    expect(unwedge).toBeGreaterThan(reap);
    expect(workflow).toContain('node scripts/ci/reap-stale-deploy-build.mjs');
    expect(workflow).toContain("STALE_BUILD_MINUTES: '390'");
    expect(workflow).toMatch(/^\s*actions:\s*write\b/m);
  });
});
