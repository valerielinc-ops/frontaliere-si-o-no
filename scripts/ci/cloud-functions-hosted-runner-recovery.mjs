import { listRecentWorkflowRunsWithRetry } from './lib/workflow-run-list-recovery.mjs';

export const DEPLOY_WORKFLOW_PATH = '.github/workflows/deploy-cloud-functions.yml';
export const DEPLOY_WORKFLOW_ID = 'deploy-cloud-functions.yml';
export const DEPLOY_JOB_NAME = 'deploy-functions';
export const HOSTED_RUNNER_ALLOCATION_MESSAGE =
  'The job was not acquired by Runner of type hosted even after multiple attempts';

export async function listRecentCloudFunctionsRuns({
  ...options
} = {}) {
  return listRecentWorkflowRunsWithRetry({
    ...options,
    workflowId: DEPLOY_WORKFLOW_ID,
  });
}

/**
 * Only production deploys from main are safe to replay automatically. A
 * rerun keeps the original SHA, and the attempt guard makes this recovery
 * bounded even when GitHub emits another completion event for the replay.
 */
export function isCloudFunctionsRunCandidate(run) {
  return ['failure', 'startup_failure'].includes(run?.conclusion)
    && run?.path === DEPLOY_WORKFLOW_PATH
    && run?.head_branch === 'main'
    && ['push', 'workflow_dispatch'].includes(run?.event)
    && Number.isSafeInteger(run?.run_attempt)
    && run.run_attempt === 1;
}

/**
 * GitHub can finish a workflow before creating its root job. An empty jobs
 * response is the strongest form of that signature; a future workflow shape
 * may expose only skipped dependents, which are equally unable to report or
 * recover the failure themselves. A real deploy job must stay visible and
 * must not be replayed by this startup recovery.
 */
export function isUnstartedCloudFunctionsRun(jobs) {
  if (!Array.isArray(jobs)) return false;
  if (jobs.length === 0) return true;
  if (jobs.some((job) => job?.name === DEPLOY_JOB_NAME)) return false;
  return jobs.every((job) => (
    job?.conclusion === 'skipped'
    && Array.isArray(job?.steps)
    && job.steps.length === 0
  ));
}

/**
 * A recovery replays the source SHA. Once another main deploy run exists, that
 * SHA is stale even if the newer run is still queued; replaying it could put an
 * older production state behind the newer deploy in the shared concurrency
 * group. The Actions run id is the durable ordering key returned by the API.
 */
export function hasNewerDeployRun(run, workflowRuns) {
  if (!Array.isArray(workflowRuns) || !Number.isSafeInteger(run?.id)) return true;
  return workflowRuns.some((candidate) => (
    Number.isSafeInteger(candidate?.id)
    && candidate.id > run.id
    && candidate.head_branch === 'main'
  ));
}

/**
 * GitHub represents a hosted-runner allocation failure as a cancelled job
 * with no steps and no runner. The annotation is the discriminant: a plain
 * cancelled job is commonly caused by concurrency and must not be replayed.
 */
export function isHostedRunnerAllocationFailure(job, annotations = []) {
  const runnerId = Number(job?.runner_id);
  const runnerWasNotAssigned = !Number.isFinite(runnerId) || runnerId === 0;
  return job?.name === DEPLOY_JOB_NAME
    && job?.conclusion === 'cancelled'
    && Array.isArray(job?.steps)
    && job.steps.length === 0
    && runnerWasNotAssigned
    && !job?.runner_name
    && annotations.some((annotation) => (
      String(annotation?.message || '').trim() === HOSTED_RUNNER_ALLOCATION_MESSAGE
    ));
}

/**
 * `annotationsByJob` is keyed by the check-run/job id so callers can fetch
 * annotations lazily through the Checks API without weakening the predicate.
 */
export function shouldRetryCloudFunctionsRun({ run, jobs, annotationsByJob, workflowRuns } = {}) {
  if (!isCloudFunctionsRunCandidate(run) || !Array.isArray(jobs)) return false;
  if (hasNewerDeployRun(run, workflowRuns)) return false;
  if (isUnstartedCloudFunctionsRun(jobs)) return true;
  return jobs.some((job) => isHostedRunnerAllocationFailure(
    job,
    annotationsByJob?.[String(job?.id)] || [],
  ));
}
