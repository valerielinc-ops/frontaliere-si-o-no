export const DEPLOY_WORKFLOW_PATH = '.github/workflows/deploy-cloud-functions.yml';
export const DEPLOY_JOB_NAME = 'deploy-functions';
export const HOSTED_RUNNER_ALLOCATION_MESSAGE =
  'The job was not acquired by Runner of type hosted even after multiple attempts';
export const FIRST_RUN_ATTEMPT = 1;

/**
 * Only production deploys from main are safe to replay automatically. A
 * rerun keeps the original SHA, and the attempt guard makes this recovery
 * bounded even when GitHub emits another completion event for the replay.
 */
export function isCloudFunctionsRunCandidate(run) {
  const attempt = Number(run?.run_attempt ?? FIRST_RUN_ATTEMPT);
  return run?.conclusion === 'failure'
    && run?.path === DEPLOY_WORKFLOW_PATH
    && run?.head_branch === 'main'
    && ['push', 'workflow_dispatch'].includes(run?.event)
    && Number.isSafeInteger(attempt)
    && attempt === FIRST_RUN_ATTEMPT;
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
export function shouldRetryCloudFunctionsRun({ run, jobs, annotationsByJob } = {}) {
  if (!isCloudFunctionsRunCandidate(run) || !Array.isArray(jobs)) return false;
  return jobs.some((job) => isHostedRunnerAllocationFailure(
    job,
    annotationsByJob?.[String(job?.id)] || [],
  ));
}
