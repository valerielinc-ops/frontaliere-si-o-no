const MAIN_SEED_WORKFLOW_PATHS = new Set([
  '.github/workflows/tests.yml',
  '.github/workflows/hourly-test-assemble-snapshot.yml',
]);

const defaultSleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const FULL_SHA = /^[0-9a-f]{40}$/i;

/**
 * Give an in-flight trusted main run a short window to publish the exact
 * content-addressed assembler cache before a PR pays for the same assembly.
 * The key hashes the inputs of one commit, so only a main run whose head is
 * `baseSha` (the base of the PR merge) can publish it. No wait is added when
 * `baseSha` is not a full commit SHA or no main run on that commit is in flight.
 */
export async function waitForMainAssembleCache({
  github,
  context,
  core,
  cacheKey,
  baseSha,
  timeoutMs = 60_000,
  intervalMs = 10_000,
  now = Date.now,
  sleep = defaultSleep,
}) {
  const setReady = (value) => core.setOutput('cache_ready', String(value));
  if (!cacheKey) {
    setReady(false);
    core.info('Assemble cache key is missing; continuing with the cold path.');
    return false;
  }

  if (!FULL_SHA.test(String(baseSha || ''))) {
    setReady(false);
    core.info('Merge base commit is unknown; no main run can be matched, continuing with the cold path.');
    return false;
  }
  const expectedSha = String(baseSha).toLowerCase();

  try {
    const { data: runs } = await github.rest.actions.listWorkflowRunsForRepo({
      owner: context.repo.owner,
      repo: context.repo.repo,
      branch: 'main',
      head_sha: expectedSha,
      per_page: 100,
    });
    const seedInFlight = runs.workflow_runs.some((run) => {
      const workflowPath = String(run.path || '').split('@')[0];
      return run.head_branch === 'main'
        && String(run.head_sha || '').toLowerCase() === expectedSha
        && ['queued', 'in_progress'].includes(run.status)
        && MAIN_SEED_WORKFLOW_PATHS.has(workflowPath);
    });
    if (!seedInFlight) {
      setReady(false);
      core.info('No trusted main assemble-cache seed is in flight for the merge base; continuing with the cold path.');
      return false;
    }

    const deadline = now() + timeoutMs;
    while (true) {
      const { data } = await github.rest.actions.getActionsCacheList({
        owner: context.repo.owner,
        repo: context.repo.repo,
        ref: 'refs/heads/main',
        key: cacheKey,
        per_page: 100,
      });
      if (data.actions_caches.some((cache) => cache.key === cacheKey)) {
        setReady(true);
        core.info(`The trusted main run published ${cacheKey}; retrying its exact cache.`);
        return true;
      }

      const remainingMs = deadline - now();
      if (remainingMs <= 0) break;
      await sleep(Math.min(intervalMs, remainingMs));
    }

    setReady(false);
    core.info(`The exact main cache was not published during the ${Math.ceil(timeoutMs / 1000)}-second wait; continuing with assembly.`);
    return false;
  } catch (error) {
    setReady(false);
    core.warning(`Could not wait for the main assemble cache: ${error.message}`);
    return false;
  }
}
