/**
 * Read the evidence of a failed deploy-family run (jobs + failure annotations)
 * through the `gh` CLI.
 *
 * One reader for both consumers: the build re-arm (`rearm-deploy-build.mjs`)
 * and the publish reconciler (`request-latest-publish.mjs`). It only reads and
 * hands the result to `classifyDeployFailure`, which looks at the failure
 * annotations alone (a warning quoting ECONNRESET never decides the class,
 * fix 3fde8f17).
 */

import { execFileSync } from 'node:child_process';

// execFileSync stops reading at `maxBuffer`, 1 MiB when it is not given, and
// throws ENOBUFS: that is how the request queue next door went blind (issue
// 12308). The listing here is already projected; the buffer is the second line.
const GH_MAX_BUFFER_BYTES = 32 * 1024 * 1024;

/** Job conclusions whose annotations are worth reading. */
export const EVIDENCE_JOB_CONCLUSIONS = Object.freeze(['failure', 'timed_out', 'cancelled']);
/** At most this many failed jobs have their annotations read per run. */
export const EVIDENCE_MAX_JOBS = 4;

export function gh(args) {
  return execFileSync('gh', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: GH_MAX_BUFFER_BYTES,
  }).trim();
}

export function ghJson(args) {
  const raw = gh(args);
  if (!raw) throw new Error(`empty GitHub API response for ${args.join(' ')}`);
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`invalid JSON from GitHub API for ${args.join(' ')}`);
  }
}

export function readJobAnnotations(job) {
  if (!job?.check_run_url) throw new Error(`job ${job?.id || '?'} has no check-run URL`);
  const raw = gh([
    'api',
    `${job.check_run_url}/annotations`,
    '--paginate',
    '--slurp',
  ]);
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed) && parsed.every((page) => Array.isArray(page))) return parsed.flat();
  throw new Error(`unreadable annotations for job ${job.id || '?'}`);
}

export function readRunJobs(repo, runId) {
  const payload = ghJson(['api', `repos/${repo}/actions/runs/${runId}/jobs?filter=latest&per_page=100`]);
  return Array.isArray(payload?.jobs) ? payload.jobs : [];
}

/**
 * Annotations of the failed jobs of one run. An unreadable annotation list
 * degrades to `[]` for that job (the classifier then says `unknown`), never to
 * an exception.
 *
 * @param {Array} jobs  jobs of the run, GitHub Actions API shape
 * @returns {Record<string, Array>} annotations by job id
 */
export function readFailedJobAnnotations(jobs, { maxJobs = EVIDENCE_MAX_JOBS } = {}) {
  const annotationsByJob = {};
  const failed = (Array.isArray(jobs) ? jobs : [])
    .filter((job) => job?.status === 'completed' && EVIDENCE_JOB_CONCLUSIONS.includes(String(job?.conclusion)))
    .slice(0, maxJobs);
  for (const job of failed) {
    try {
      annotationsByJob[String(job.id)] = readJobAnnotations(job);
    } catch {
      annotationsByJob[String(job.id)] = [];
    }
  }
  return annotationsByJob;
}
