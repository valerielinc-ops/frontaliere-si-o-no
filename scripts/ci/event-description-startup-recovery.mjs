export const EVENT_DESCRIPTION_WORKFLOW_PATH = '.github/workflows/event-description-rewrite.yml';
export const EVENT_DESCRIPTION_PLAN_JOB = 'plan';

/**
 * A failed run can contain only skipped dependent jobs when Actions fails
 * before it allocates a runner for the root `plan` job. Those jobs have no
 * steps, so there is no in-workflow reporter that can run. Keep this predicate
 * narrower than "failed run": a real job failure must stay visible and must
 * not be replayed automatically.
 */
export function isUnstartedEventDescriptionRun(jobs) {
  if (!Array.isArray(jobs)) return false;
  if (jobs.length === 0) return true;
  if (jobs.some((job) => job?.name === EVENT_DESCRIPTION_PLAN_JOB)) return false;
  return jobs.every((job) => (
    job?.conclusion === 'skipped'
    && Array.isArray(job?.steps)
    && job.steps.length === 0
  ));
}

/**
 * Only replay a first-attempt production run from this workflow. A rerun keeps
 * the same run id and advances `run_attempt`, which makes the bound durable.
 */
export function isEventDescriptionRunCandidate(run) {
  return run?.conclusion === 'failure'
    && run?.path === EVENT_DESCRIPTION_WORKFLOW_PATH
    && run?.head_branch === 'main'
    && ['schedule', 'workflow_dispatch'].includes(run?.event)
    && Number.isSafeInteger(run?.run_attempt)
    && run.run_attempt === 1;
}

/**
 * Replaying an older run after a newer main run exists could put an obsolete
 * event-rewrite snapshot behind the newer run. The Actions run id is the
 * durable ordering key exposed by the API.
 */
export function hasNewerEventDescriptionRun(run, workflowRuns) {
  if (!Array.isArray(workflowRuns) || !Number.isSafeInteger(run?.id)) return true;
  return workflowRuns.some((candidate) => (
    Number.isSafeInteger(candidate?.id)
    && candidate.id > run.id
    && candidate.head_branch === 'main'
    && candidate.path === EVENT_DESCRIPTION_WORKFLOW_PATH
  ));
}

export function shouldRetryEventDescriptionRun({ run, jobs, workflowRuns } = {}) {
  if (!isEventDescriptionRunCandidate(run)) return false;
  if (!isUnstartedEventDescriptionRun(jobs)) return false;
  return !hasNewerEventDescriptionRun(run, workflowRuns);
}
