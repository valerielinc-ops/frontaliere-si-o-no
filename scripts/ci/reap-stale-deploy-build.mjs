/**
 * reap-stale-deploy-build.mjs — release a deploy build lock that outlives its
 * own six-hour job timeout.
 *
 * `deploy.yml` serialises the expensive build under `pages-build-run` with
 * `cancel-in-progress: false`. That protects a running build from a newer
 * push, but it also means a runner/API wedge can hold the lock forever. The
 * normal job timeout is supposed to be the bound; run 34972736506 showed that
 * an in-progress build can survive past that bound and leave every newer
 * commit pending.
 *
 * Safety contract:
 *   - inspect only the `deploy.yml` run list on `main`;
 *   - cancel only a run that is literally `in_progress` and has at least one
 *     live job whose latest start is older than the bounded threshold;
 *   - fail closed when the run or jobs cannot be read;
 *   - never cancel a queued/pending run or anything in `deploy-publish.yml`;
 *   - keep the caller best-effort so a reaper outage cannot hide the lag
 *     watchdog that follows it.
 */

import { pathToFileURL } from 'node:url';
import { githubApiHeaders } from '../lib/githubApiHeaders.mjs';

const API = 'https://api.github.com';
const DEFAULT_STALE_BUILD_MINUTES = 390;
const DEFAULT_WORKFLOW = 'deploy.yml';
const DEFAULT_BRANCH = 'main';

/**
 * Return the latest timestamp that proves a live build job is still active.
 * Using the latest live job (rather than the oldest run timestamp) avoids
 * cancelling a matrix run while GitHub is legitimately starting a new leg.
 */
export function latestLiveJobStartMs(run, jobs) {
  const liveJobs = Array.isArray(jobs)
    ? jobs.filter((job) => job?.status === 'in_progress')
    : [];
  if (liveJobs.length === 0) return null;
  const starts = liveJobs.map((job) => Date.parse(job?.started_at ?? ''));
  // A live job without its own start timestamp is not positively ageable.
  // Do not fall back to the run timestamp: that would turn partial API data
  // into permission to cancel an otherwise live build.
  if (starts.some((value) => !Number.isFinite(value))) return null;
  return Math.max(...starts);
}

/**
 * Select only deploy builds that are safe to reap.
 *
 * `jobsByRun` accepts either a Map keyed by run id or a plain object keyed by
 * the same id, which keeps the decision core easy to exercise in Vitest.
 */
export function selectStaleDeployBuildRuns(
  runs,
  jobsByRun,
  { nowMs, thresholdMinutes = DEFAULT_STALE_BUILD_MINUTES } = {},
) {
  if (!Array.isArray(runs) || !Number.isFinite(nowMs)) return [];
  if (!Number.isFinite(thresholdMinutes) || thresholdMinutes <= 0) return [];

  return runs.filter((run) => {
    if (run?.status !== 'in_progress') return false;
    const jobs = jobsByRun instanceof Map
      ? (jobsByRun.get(String(run.id)) ?? jobsByRun.get(run.id) ?? [])
      : (jobsByRun?.[String(run.id)] ?? []);
    const liveJobs = Array.isArray(jobs)
      ? jobs.filter((job) => job?.status === 'in_progress')
      : [];
    if (liveJobs.length === 0) return false;

    const startedMs = latestLiveJobStartMs(run, liveJobs);
    if (!Number.isFinite(startedMs)) return false;
    return nowMs - startedMs > thresholdMinutes * 60_000;
  });
}

export function staleDeployBuildAgeMinutes(run, jobs, nowMs) {
  const startedMs = latestLiveJobStartMs(run, jobs);
  if (!Number.isFinite(startedMs) || !Number.isFinite(nowMs)) return 0;
  return Math.max(0, Math.round((nowMs - startedMs) / 60_000));
}

function authToken() {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GH_TOKEN or GITHUB_TOKEN required');
  return token;
}

async function ghJson(urlPath) {
  const response = await fetch(`${API}${urlPath}`, {
    headers: githubApiHeaders(authToken()),
  });
  if (!response.ok) throw new Error(`GitHub API ${urlPath} → HTTP ${response.status}`);
  return response.json();
}

async function cancelRun(repo, runId) {
  const response = await fetch(`${API}/repos/${repo}/actions/runs/${runId}/cancel`, {
    method: 'POST',
    headers: githubApiHeaders(authToken()),
  });
  if (response.status === 202) return true;
  if (response.status === 409) {
    console.log(`  run ${runId}: already terminal (409) — build lock is free`);
    return true;
  }
  console.log(`::warning::Could not cancel stale deploy run ${runId} — HTTP ${response.status}`);
  return false;
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  const workflow = process.env.REAP_WORKFLOW || DEFAULT_WORKFLOW;
  const branch = process.env.REAP_BRANCH || DEFAULT_BRANCH;
  const parsed = Number(process.env.STALE_BUILD_MINUTES);
  const thresholdMinutes = Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_STALE_BUILD_MINUTES;
  const dryRun = process.env.REAP_DRY_RUN === '1';

  if (!repo) {
    console.warn('⚠️ GITHUB_REPOSITORY unset — stale deploy reaper skipped');
    return 0;
  }

  let runs;
  try {
    const body = await ghJson(
      `/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/runs?branch=${encodeURIComponent(branch)}&status=in_progress&per_page=50`,
    );
    runs = Array.isArray(body?.workflow_runs) ? body.workflow_runs : [];
  } catch (error) {
    console.log(`⚠️ Could not read ${workflow} in-progress runs: ${error.message} — not cancelling anything`);
    return 0;
  }

  const jobsByRun = new Map();
  for (const run of runs) {
    try {
      const body = await ghJson(`/repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`);
      jobsByRun.set(String(run.id), Array.isArray(body?.jobs) ? body.jobs : []);
    } catch (error) {
      // Missing job evidence is a hard no-cancel. The next hourly tick can try
      // again without turning an API blip into a destructive action.
      console.log(`⚠️ Could not read jobs for run ${run.id}: ${error.message} — leaving it alone`);
      jobsByRun.set(String(run.id), []);
    }
  }

  const nowMs = Date.now();
  const stale = selectStaleDeployBuildRuns(runs, jobsByRun, { nowMs, thresholdMinutes });
  console.log('── stale deploy build reaper ──');
  console.log(`In-progress ${workflow} runs on ${branch}: ${runs.length} (threshold ${thresholdMinutes} min)`);

  if (stale.length === 0) {
    console.log('✅ No stale in-progress deploy build — leaving the build lock untouched.');
    return 0;
  }

  for (const run of stale) {
    const jobs = jobsByRun.get(String(run.id)) || [];
    const age = staleDeployBuildAgeMinutes(run, jobs, nowMs);
    console.log(
      `::warning::Deploy build run ${run.id} (${run.head_sha?.slice(0, 8) ?? '?'}) has held the build lock for ${age} min — cancelling it to release newer builds.`,
    );
    if (!dryRun) await cancelRun(repo, run.id);
  }

  if (dryRun) console.log(`REAP_DRY_RUN=1 — would cancel ${stale.length} stale deploy build run(s)`);
  else console.log(`Requested cancellation for ${stale.length} stale deploy build run(s).`);
  return 0;
}

const invokedDirectly = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (invokedDirectly) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.log(`::error::[reap-stale-deploy-build] Fatal: ${error.stack || error.message}`);
      process.exit(1);
    });
}
