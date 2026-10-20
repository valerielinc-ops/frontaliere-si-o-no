/**
 * Invariants of the `pages-deploy` publish queue.
 *
 * Every defect pinned here was live and shipped green. `deploy-publish.yml` went
 * 0 success across its 300 most recent runs (2026-08-01T20:25Z →
 * 2026-08-07T05:40Z, last success 2026-07-27T22:15Z) while CI stayed quiet: the
 * runs that were destroyed ended `cancelled` or `skipped`, neither of which
 * turns anything red, and the run holding the queue never reached a conclusion
 * at all. The Pages upload now owns the queue lock independently from the
 * long dist validator. There is no test-suite signal for "the publish queue is jammed", so
 * these assertions are the only thing standing between a plausible-looking edit
 * and another ten silent days.
 *
 * Two independent mechanisms, two groups of assertions:
 *   1) no-op `workflow_run` runs must not contend for the shared group, or they
 *      evict real publishes on arrival;
 *   2) the unwedger must only ever cancel runs that have not started executing,
 *      or it becomes the cause of the errored-latch outage it exists to avoid.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import YAML from 'yaml';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cancelVerdict,
  gateEntryMs,
  parkedAtPagesGate,
  selectWedgedRuns,
  wedgeAgeMinutes,
  // @ts-expect-error — plain .mjs, no type declarations
} from '../scripts/ci/unwedge-pages-deploy-queue.mjs';

const read = (p: string) => readFileSync(resolve(p), 'utf8');

describe('deploy-publish.yml — pages-deploy concurrency', () => {
  const workflow = read('.github/workflows/deploy-publish.yml');
  const document = YAML.parse(workflow) as any;
  const deploy = document.jobs.deploy;
  const group = deploy.concurrency?.group ?? '';

  it('routes no-op runs (upstream build not successful) to a per-run group', () => {
    // `workflow_run: types: [completed]` fires for CANCELLED builds too, and
    // deploy.yml's own newest-wins lock cancels 121 of 141 builds per 48 h
    // (#5251). Those runs skip every job — 200 of the last 300 runs here — but a
    // run joins its concurrency group BEFORE any job `if:` is evaluated, and an
    // arrival into a full group (1 running + 1 pending) cancels the pending
    // member. Measured 2026-08-06: no-op 31100260885 arrived 12:10:14, killed
    // pending run 31100206740 at 12:10:15, then skipped at 12:14:48.
    expect(group).toContain('workflow_run.conclusion');
    expect(group).toContain("'success'");
    // …and the fallback must be unique per run, not another shared constant.
    expect(group).toContain('github.run_id');
  });

  it('keeps the shared slot named pages-deploy for real publishes', () => {
    // Renaming the real branch of the expression would silently decouple this
    // workflow from any other holder of the same lock.
    expect(group).toContain("'pages-deploy'");
  });

  it('never cancels an in-flight publish', () => {
    // cancel-in-progress: true would "fix" the queue by killing
    // actions/deploy-pages mid-upload. Bursts of cancelled deployments latch
    // Pages into status=errored and freeze the site on an old build (prod
    // outage 2026-06-05); the workflow carries a whole "Reset Pages errored
    // state" step to dig out of exactly that.
    expect(deploy.concurrency?.['cancel-in-progress']).toBe(false);
  });

  it('does not let dist validation hold the Pages or post-deploy lock', () => {
    // The validator can legitimately use the full five-hour budget. It must
    // queue only other validators, while Pages and side-effects keep draining.
    expect(document.concurrency).toBeUndefined();
    expect(document.jobs['validate-dist'].concurrency.group).toContain('dist-validation');
    expect(document.jobs['validate-dist'].concurrency.group).not.toContain('pages-deploy');
    expect(document.jobs.publish.concurrency.group).toContain('pages-post-deploy');
    expect(document.jobs.publish.concurrency.group).not.toContain('pages-deploy');
    expect(document.jobs.publish.concurrency['cancel-in-progress']).toBe(false);
  });

  it('keeps the recovery workflow on the same job-scoped Pages lock', () => {
    const restore = YAML.parse(read('.github/workflows/restore-from-artifact.yml')) as any;
    expect(restore.concurrency).toBeUndefined();
    expect(restore.jobs.deploy.concurrency.group).toContain('pages-deploy');
    expect(restore.jobs.deploy.concurrency.group).toContain('validate-source-build.result');
    expect(restore.jobs.deploy.concurrency['cancel-in-progress']).toBe(false);
  });
});

describe('pages-publish-lag-watchdog.yml — unwedge wiring', () => {
  const workflow = read('.github/workflows/pages-publish-lag-watchdog.yml');

  it('invokes the unwedger', () => {
    // Without this the watchdog can only describe the stall it is watching.
    expect(workflow).toContain('scripts/ci/unwedge-pages-deploy-queue.mjs');
  });

  it('declares actions: write, without which the cancel silently 403s', () => {
    expect(workflow).toMatch(/^\s*actions:\s*write\b/m);
  });

  it('unwedges before measuring lag, so a freed queue can drain this tick', () => {
    // Compare the STEP declarations, not the first textual mention: the header
    // comment names check-pages-publish-lag.mjs long before either step.
    const unwedgeIdx = workflow.indexOf('- name: Unwedge the pages-deploy queue');
    const checkIdx = workflow.indexOf('- name: Check publish lag');
    expect(unwedgeIdx).toBeGreaterThan(-1);
    expect(checkIdx).toBeGreaterThan(unwedgeIdx);
  });

  it('cannot suppress the lag check when it breaks', () => {
    const stepIdx = workflow.indexOf('Unwedge the pages-deploy queue');
    const step = workflow.slice(stepIdx, workflow.indexOf('scripts/ci/unwedge-pages-deploy-queue.mjs'));
    expect(step).toMatch(/continue-on-error:\s*true/);
  });
});

describe('selectWedgedRuns', () => {
  const NOW = Date.parse('2026-08-07T06:00:00Z');
  const at = (iso: string, status: string, id = 1, head_branch = 'main') => ({ id, status, head_branch, created_at: iso });

  it('selects a run parked at the environment gate past the threshold', () => {
    // The real case: run 31118787881 entered `waiting` at 2026-08-06T16:09:08Z
    // and was still there 14 h later, past 2× the 360-min default job timeout —
    // which is the proof that `timeout-minutes` does not apply to a job waiting
    // on an environment.
    const runs = [at('2026-08-06T16:09:08Z', 'waiting', 31118787881)];
    expect(selectWedgedRuns(runs, { nowMs: NOW }).map((r: { id: number }) => r.id)).toEqual([31118787881]);
  });

  it('NEVER selects a run that is executing, however long it has run', () => {
    // The load-bearing assertion. A healthy publish takes 57-83 min end to end
    // (ten measured successes) and its deploy job may spend a further 330 min in
    // the extended server-side Pages poll, so "old" is not evidence of a wedge.
    // Cancelling an executing run is what causes the outage class this script
    // exists to avoid.
    const old = '2026-08-01T00:00:00Z'; // ~6 days
    for (const status of ['in_progress', 'queued', 'pending', 'completed', 'requested']) {
      expect(selectWedgedRuns([at(old, status)], { nowMs: NOW })).toEqual([]);
    }
  });

  it('leaves a freshly-gated run alone', () => {
    // A healthy run clears the gate in 4-6 s, but the threshold has to tolerate
    // the worst observed transit (7 m 28 s, run 30310076907).
    expect(selectWedgedRuns([at('2026-08-07T05:50:00Z', 'waiting')], { nowMs: NOW })).toEqual([]);
  });

  it('honours an explicit threshold in both directions', () => {
    const runs = [at('2026-08-07T05:00:00Z', 'waiting')]; // 60 min old
    expect(selectWedgedRuns(runs, { nowMs: NOW, thresholdMinutes: 30 })).toHaveLength(1);
    expect(selectWedgedRuns(runs, { nowMs: NOW, thresholdMinutes: 90 })).toHaveLength(0);
  });

  it('fails CLOSED on an unreadable or missing timestamp', () => {
    // Opposite direction to the lag watchdog it ships with, on purpose: a
    // missed unwedge costs one more hour of an already-visible stall, a wrong
    // cancel destroys a live publish.
    expect(selectWedgedRuns([{ id: 1, status: 'waiting', created_at: 'not-a-date' }], { nowMs: NOW })).toEqual([]);
    expect(selectWedgedRuns([{ id: 2, status: 'waiting' }], { nowMs: NOW })).toEqual([]);
  });

  it('tolerates a malformed API response instead of throwing', () => {
    expect(selectWedgedRuns(undefined as never, { nowMs: NOW })).toEqual([]);
    expect(selectWedgedRuns([null as never], { nowMs: NOW })).toEqual([]);
  });
});

// Same four defects the review of the corpus twin found (nanakokyobashi-rgb/
// frontaliere-articles#2017, review 5376724637): the run's ref, the time the
// run reached the gate, its state at the moment of the cancel, and a cancel
// or listing failure that ended green.
describe('cancelVerdict — decided on data re-read right before the cancel', () => {
  const NOW = Date.parse('2026-08-07T06:00:00Z');
  // Shapes of the real wedge, run 31118787881 (deploy entered `waiting` at
  // 2026-08-06T16:09:08Z, pending deployment on github-pages, no reviewers).
  const RUN = { id: 31118787881, status: 'waiting', head_branch: 'main', event: 'workflow_run', created_at: '2026-08-06T16:09:00Z' };
  const JOBS = [
    { name: 'validate-dist', status: 'completed', created_at: '2026-08-06T16:09:01Z' },
    { name: 'deploy', status: 'waiting', created_at: '2026-08-06T16:09:08Z' },
  ];
  const PENDING = [{ environment: { name: 'github-pages' }, wait_timer: 0, reviewers: [] }];
  const base = { run: RUN, jobs: JOBS, pendingDeployments: PENDING, nowMs: NOW };

  it('cancels the real wedge, aged from the gated job', () => {
    expect(gateEntryMs(JOBS)).toBe(Date.parse('2026-08-06T16:09:08Z'));
    expect(wedgeAgeMinutes(gateEntryMs(JOBS), NOW)).toBe(831);
    expect(cancelVerdict(base)).toMatchObject({ cancel: true, ageMinutes: 831 });
  });

  it('never selects or cancels a run of another ref', () => {
    expect(selectWedgedRuns([{ ...RUN, head_branch: 'feature' }], { nowMs: NOW })).toEqual([]);
    expect(cancelVerdict({ ...base, run: { ...RUN, head_branch: 'feature' } }).cancel).toBe(false);
  });

  it('ages a run from the gate, not from its creation', () => {
    // Created hours ago (queued behind the group or for a runner), gated 10 min ago.
    const run = { ...RUN, created_at: '2026-08-07T02:00:00Z' };
    const jobs = [{ name: 'deploy', status: 'waiting', created_at: '2026-08-07T05:50:00Z' }];
    expect(selectWedgedRuns([run], { nowMs: NOW })).toHaveLength(1);
    expect(cancelVerdict({ ...base, run, jobs })).toMatchObject({ cancel: false });
  });

  it('does not cancel a run that left the gate since the listing', () => {
    for (const status of ['in_progress', 'queued', 'completed']) {
      expect(cancelVerdict({ ...base, run: { ...RUN, status } }).cancel).toBe(false);
    }
  });

  it('requires a pending github-pages deployment and a readable gated job', () => {
    expect(parkedAtPagesGate(PENDING)).toBe(true);
    expect(parkedAtPagesGate([{ environment: { name: 'production' } }])).toBe(false);
    expect(cancelVerdict({ ...base, pendingDeployments: [] }).cancel).toBe(false);
    expect(cancelVerdict({ ...base, jobs: [{ status: 'waiting', created_at: 'not-a-date' }] }).cancel).toBe(false);
    expect(cancelVerdict({ ...base, jobs: [{ status: 'in_progress', created_at: '2026-08-06T16:09:08Z' }] }).cancel).toBe(false);
  });
});

describe('unwedge-pages-deploy-queue.mjs — exit status of the real script', () => {
  const RUN = { id: 31118787881, status: 'waiting', head_branch: 'main', created_at: '2026-08-06T16:09:00Z', head_sha: 'abcdef12' };
  const LIST = '/actions/workflows/deploy-publish.yml/runs';
  const wedged = (cancelStatus: number, run = RUN) => [
    { match: LIST, body: { workflow_runs: [RUN] } },
    { match: `/actions/runs/${RUN.id}/jobs`, body: { jobs: [{ status: 'waiting', created_at: '2026-08-06T16:09:08Z' }] } },
    { match: `/actions/runs/${RUN.id}/pending_deployments`, body: [{ environment: { name: 'github-pages' } }] },
    { match: `/actions/runs/${RUN.id}/cancel`, method: 'POST', status: cancelStatus },
    { match: `/actions/runs/${RUN.id}`, body: run },
  ];

  // The real script with `fetch` replaced: no network, no real token.
  function runScript(routes: unknown[]) {
    const dir = mkdtempSync(join(tmpdir(), 'unwedge-'));
    const mock = join(dir, 'mock-fetch.mjs');
    writeFileSync(mock, `
const routes = JSON.parse(process.env.MOCK_ROUTES);
globalThis.fetch = async (url, init = {}) => {
  const method = init.method || 'GET';
  const hit = routes.find((r) => (r.method || 'GET') === method && url.includes(r.match));
  process.stderr.write('CALL ' + method + ' ' + url + '\\n');
  if (!hit) return new Response('{}', { status: 404 });
  return new Response(JSON.stringify(hit.body ?? {}), { status: hit.status ?? 200 });
};
`);
    try {
      return spawnSync(process.execPath, ['--import', mock, resolve('scripts/ci/unwedge-pages-deploy-queue.mjs')], {
        env: { ...process.env, GH_TOKEN: 'test-token', MOCK_ROUTES: JSON.stringify(routes) },
        encoding: 'utf8',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('exits 0 when nothing is wedged', () => {
    const r = runScript([{ match: LIST, body: { workflow_runs: [] } }]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
  });

  it('exits 1 with ::error:: and cancels nothing on an unreadable or malformed listing', () => {
    for (const routes of [[{ match: LIST, status: 500 }], [{ match: LIST, body: { message: 'x' } }]]) {
      const r = runScript(routes);
      expect(r.status, r.stdout + r.stderr).toBe(1);
      expect(r.stdout).toMatch(/::error::Could not read deploy-publish\.yml runs/);
      expect(r.stderr).not.toMatch(/CALL POST/);
    }
  });

  it('cancels a proven wedge once, after re-reading it', () => {
    const r = runScript(wedged(202));
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const calls = r.stderr.split('\n').filter((l) => l.startsWith('CALL'));
    const post = calls.findIndex((l) => l.startsWith('CALL POST'));
    expect(post).toBeGreaterThan(calls.findIndex((l) => l.includes('/pending_deployments')));
    expect(calls.filter((l) => l.startsWith('CALL POST'))).toHaveLength(1);
  });

  it('exits 1 when GitHub refuses the cancel', () => {
    const r = runScript(wedged(403));
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout).toMatch(/::error::The pages-deploy queue may still be jammed/);
  });

  it('leaves alone a run that started between the listing and the re-read', () => {
    const r = runScript(wedged(202, { ...RUN, status: 'in_progress' }));
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stderr).not.toMatch(/CALL POST/);
  });
});
