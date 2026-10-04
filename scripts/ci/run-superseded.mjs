#!/usr/bin/env node
/**
 * Was this cancelled job superseded by a newer run of the same workflow?
 *
 * Why it exists (issue 5253). A workflow with `concurrency: cancel-in-progress:
 * true` cancels its running job as soon as a newer run of the same group is
 * queued. If its failure reporter runs on `cancelled()` (needed to report a
 * job TIMEOUT, which GitHub also marks `cancelled`), that ordinary hand-off is
 * reported as a failure and re-opens the canonical issue: run 37112269877 was
 * cancelled at 09:25:37Z by run 37112995632 (created 09:25:23Z) and issue 5253
 * was re-opened at 09:25:43Z.
 *
 * A newer run alone is only circumstantial: a job that timed out while a newer
 * run was already queued would look the same. So `superseded=true` requires
 * ALL of:
 *   (a) a run of the same workflow created AFTER this attempt started;
 *   (b) no job-timeout annotation on this job's check run (same signature the
 *       timeout monitor uses, imported from deploy-job-failure-signature.mjs);
 *   (c) this job is not near its own limit: elapsed < timeout-minutes − margin.
 * Every unreadable input yields `false`: when in doubt, report (fail-closed).
 *
 * The concurrency annotation GitHub writes on the check run ("Canceling since
 * a higher priority waiting request for <group> exists") is logged as a
 * confirmation only. It is readable on the completed run 37112269877, but it is
 * NOT a necessary condition: nothing guarantees it is already written while the
 * job's own `if: cancelled()` steps are still running.
 *
 * Usage in a workflow step (`if: cancelled()` explicit, otherwise the implicit
 * `success()` never runs it):
 *   env: GH_TOKEN, JOB_TIMEOUT_MINUTES (= the job's `timeout-minutes`)
 *   run: node scripts/ci/run-superseded.mjs
 * Writes `superseded=true|false` to $GITHUB_OUTPUT. Always exits 0.
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { findTimeoutAnnotation } from './lib/deploy-job-failure-signature.mjs';

/** Minutes before the job limit within which a cancellation counts as a timeout. */
export const TIMEOUT_MARGIN_MINUTES = 2;

/** "higher priority waiting request" — GitHub's concurrency cancellation annotation. */
export const CONCURRENCY_ANNOTATION_RE = /higher priority waiting request/i;

/**
 * Pure verdict. Never throws.
 *
 * @param {object} input
 * @param {number|string} input.runId           this run's id
 * @param {string} input.runStartedAt           this attempt's `run_started_at`
 * @param {Array|null} input.runs               recent runs of the same workflow (`workflow_runs`), null if unreadable
 * @param {Array|null} input.annotations        this job's check-run annotations, null if unreadable
 * @param {string|null} input.jobStartedAt      this job's `started_at`
 * @param {number|string} input.timeoutMinutes  the job's `timeout-minutes`
 * @param {number} [input.nowMs]
 * @param {number} [input.marginMinutes]
 * @returns {{superseded: boolean, reason: string, newerRunId: number|null, concurrencyAnnotation: boolean}}
 */
export function decideSuperseded({
  runId,
  runStartedAt,
  runs,
  annotations,
  jobStartedAt,
  timeoutMinutes,
  nowMs = Date.now(),
  marginMinutes = TIMEOUT_MARGIN_MINUTES,
}) {
  const verdict = (superseded, reason, newerRunId = null) => ({
    superseded,
    reason,
    newerRunId,
    concurrencyAnnotation: Array.isArray(annotations) && annotations.some((a) => CONCURRENCY_ANNOTATION_RE.test(
      [a?.message, a?.title].filter((v) => typeof v === 'string').join('\n'),
    )),
  });

  if (!Array.isArray(runs)) return verdict(false, 'runs-unreadable');
  if (!Array.isArray(annotations)) return verdict(false, 'annotations-unreadable');

  const startedMs = Date.parse(runStartedAt ?? '');
  if (!Number.isFinite(startedMs)) return verdict(false, 'run-start-unreadable');

  const self = String(runId ?? '');
  const newer = runs.find((r) => r && String(r.id) !== self && Date.parse(r.created_at ?? '') > startedMs);
  if (!newer) return verdict(false, 'no-newer-run');

  if (findTimeoutAnnotation(annotations)) return verdict(false, 'timeout-annotation', newer.id);

  const limit = Number(timeoutMinutes);
  if (!Number.isFinite(limit) || limit <= 0) return verdict(false, 'timeout-limit-unknown', newer.id);

  const jobStartMs = Date.parse(jobStartedAt ?? '');
  if (!Number.isFinite(jobStartMs)) return verdict(false, 'job-start-unreadable', newer.id);

  const elapsedMs = nowMs - jobStartMs;
  if (!(elapsedMs < (limit - marginMinutes) * 60_000)) return verdict(false, 'near-timeout-limit', newer.id);

  return verdict(true, 'superseded', newer.id);
}

/* ── CLI ─────────────────────────────────────────────────────────────── */

function ghJson(path) {
  try {
    return JSON.parse(execFileSync('gh', ['api', path], {
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }));
  } catch (err) {
    const detail = String(err?.stderr ?? err?.message ?? '').trim().split('\n')[0];
    console.log(`::warning::[run-superseded] gh api ${path} unreadable: ${detail || 'unknown error'}`);
    return null;
  }
}

function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  const runId = process.env.GITHUB_RUN_ID;
  const attempt = process.env.GITHUB_RUN_ATTEMPT || '1';
  const jobName = process.env.JOB_NAME || process.env.GITHUB_JOB;

  const run = repo && runId ? ghJson(`repos/${repo}/actions/runs/${runId}`) : null;
  const list = run?.workflow_id
    ? ghJson(`repos/${repo}/actions/workflows/${run.workflow_id}/runs?per_page=20`)
    : null;
  const jobs = run
    ? ghJson(`repos/${repo}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`)
    : null;
  const own = Array.isArray(jobs?.jobs) ? jobs.jobs.filter((j) => j?.name === jobName) : [];
  const job = own.length === 1 ? own[0] : null;
  const annotations = job?.check_run_url
    ? ghJson(`${job.check_run_url.replace(/^https:\/\/api\.github\.com\//, '')}/annotations?per_page=100`)
    : null;

  const result = decideSuperseded({
    runId,
    runStartedAt: run?.run_started_at,
    runs: Array.isArray(list?.workflow_runs) ? list.workflow_runs : null,
    annotations: Array.isArray(annotations) ? annotations : null,
    jobStartedAt: job?.started_at ?? null,
    timeoutMinutes: process.env.JOB_TIMEOUT_MINUTES,
  });

  console.log(`[run-superseded] superseded=${result.superseded} reason=${result.reason}`
    + ` newer_run=${result.newerRunId ?? '-'} concurrency_annotation=${result.concurrencyAnnotation}`
    + (job ? '' : ` (job "${jobName}" matched ${own.length} job(s))`));
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `superseded=${result.superseded}\n`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    main();
  } catch (err) {
    // Fail-closed: no output means the reporter's guard is not satisfied.
    console.log(`::warning::[run-superseded] ${err?.message ?? err}; reporting as usual.`);
  }
}
