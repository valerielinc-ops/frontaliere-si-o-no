export const WORKFLOW_RUN_LIST_RETRIES = 2;
export const WORKFLOW_RUN_LIST_RETRY_BASE_MS = 500;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function createdDateForRun(run) {
  const createdAt = Date.parse(String(run?.created_at || ''));
  return Number.isFinite(createdAt) ? new Date(createdAt).toISOString().slice(0, 10) : null;
}

/**
 * Read only the newest page: if the source run is absent because more than
 * one page of newer runs exists, that page itself proves the source is stale.
 * Retrying the bounded read covers transient GitHub gateway failures without
 * replaying the mutating rerun request.
 */
export async function listRecentWorkflowRunsWithRetry({
  github,
  repo,
  workflowId,
  branch = 'main',
  run,
  core,
  sleep = delay,
} = {}) {
  const request = {
    ...repo,
    workflow_id: workflowId,
    branch,
    per_page: 100,
  };
  const created = createdDateForRun(run);
  if (created) request.created = `>=${created}`;

  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await github.rest.actions.listWorkflowRuns(request);
      const workflowRuns = response?.data?.workflow_runs;
      return Array.isArray(workflowRuns) ? workflowRuns : null;
    } catch (error) {
      const status = Number(error?.status ?? error?.statusCode);
      const isTransientServerError = Number.isInteger(status) && status >= 500 && status < 600;
      if (!isTransientServerError || attempt >= WORKFLOW_RUN_LIST_RETRIES) throw error;

      const retryNumber = attempt + 1;
      const delayMs = WORKFLOW_RUN_LIST_RETRY_BASE_MS * retryNumber;
      core?.warning?.(
        `Transient GitHub run-list error (${status}); retrying ${retryNumber}/${WORKFLOW_RUN_LIST_RETRIES} in ${delayMs}ms.`,
      );
      await sleep(delayMs);
    }
  }
}
