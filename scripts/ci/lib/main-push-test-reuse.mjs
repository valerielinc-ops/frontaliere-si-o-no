import { VITEST_EXECUTION_JOB_NAME } from './constants.mjs';

export const RELATED_VITEST_STEP_NAME = 'vitest related (PR diff)';
export const TESTED_MERGE_TREE_ANNOTATION_TITLE = 'CI tested merge tree';

const exactTestPolicyPaths = new Set([
  'package.json',
  'tests/agents-related-tests-recipe.test.ts',
  'tests/checkout-sparse-profiles.test.ts',
  'tests/ci-vitest-check-name.test.ts',
  'tests/dataset-test-partition.test.ts',
  'tests/run-related-tests-doc-contracts.test.ts',
  'tests/run-related-tests-selection.test.ts',
  'tests/run-related-tests-sparse.test.ts',
  'tests/scripts/main-push-test-reuse.test.ts',
  'tests/scripts/select-max-workers.test.ts',
  'package-lock.json',
  'vitest.config.ts',
]);

const testPolicyPathPrefixes = [
  '.github/actions/',
  '.github/workflows/',
  'scripts/ci/',
  'scripts/lib/',
];

function isTestPolicyPath(file) {
  return exactTestPolicyPaths.has(file)
    || testPolicyPathPrefixes.some((prefix) => file.startsWith(prefix));
}

export function hasTestPolicyChanges(files) {
  return Array.isArray(files) && files.some((entry) => {
    const paths = typeof entry === 'string'
      ? [entry]
      : [entry?.filename, entry?.previous_filename];
    return paths.some((file) => typeof file === 'string' && isTestPolicyPath(file));
  });
}

export function latestPullRequestTestRun({ total_count: totalCount, workflow_runs: runs }, headSha) {
  if (!Array.isArray(runs) || !Number.isInteger(totalCount) || totalCount !== runs.length) return null;

  const matching = runs.filter((run) => run?.event === 'pull_request' && run.head_sha === headSha);
  if (matching.length === 0) return null;
  if (matching.some((run) => !Number.isFinite(Date.parse(run.created_at)))) return null;

  return matching.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
}

export function successfulRelatedVitestJob(jobs) {
  const job = Array.isArray(jobs)
    ? jobs.find((candidate) => candidate?.name === VITEST_EXECUTION_JOB_NAME)
    : null;
  if (job?.status !== 'completed' || job.conclusion !== 'success') return null;

  const step = job.steps?.find((candidate) => candidate?.name === RELATED_VITEST_STEP_NAME);
  return step?.status === 'completed' && step.conclusion === 'success' ? job : null;
}

export function hasSuccessfulRelatedVitest(jobs) {
  return successfulRelatedVitestJob(jobs) !== null;
}

export function testedMergeTreeFromAnnotations(pages) {
  if (!Array.isArray(pages)) return null;
  const annotations = pages.every(Array.isArray) ? pages.flat() : pages;
  const markers = annotations.filter(
    (annotation) => annotation?.title === TESTED_MERGE_TREE_ANNOTATION_TITLE,
  );
  if (markers.length !== 1) return null;
  const match = /^tested-tree=([a-f\d]{40}|[a-f\d]{64})$/i.exec(markers[0]?.message || '');
  return match?.[1] ?? null;
}

export function decideMainPushTestReuse({
  pushSha,
  pushSize,
  pushCommits,
  pullRequest,
  pushTreeSha,
  testedTreeSha,
  changedFiles,
  latestRun,
  jobs,
}) {
  const reject = (reason) => ({ reuse: false, reason });
  if (pushSize !== 1 || !Array.isArray(pushCommits) || pushCommits.length !== 1
    || pushCommits[0]?.id !== pushSha) {
    return reject('push is not a single, fully represented commit');
  }
  if (!pullRequest || pullRequest.state !== 'closed' || !pullRequest.merged_at
    || pullRequest.merge_commit_sha !== pushSha || !pullRequest.head?.sha) {
    return reject('no merged PR is associated with this exact main commit');
  }
  const mergedAt = Date.parse(pullRequest.merged_at);
  if (!Number.isFinite(mergedAt)) return reject('merged PR timestamp is invalid');
  if (!Number.isInteger(pullRequest.changed_files) || !Array.isArray(changedFiles)
    || changedFiles.length !== pullRequest.changed_files) {
    return reject('PR file list is incomplete');
  }
  if (hasTestPolicyChanges(changedFiles)) return reject('PR changed test execution policy');
  if (!pushTreeSha || !testedTreeSha || pushTreeSha !== testedTreeSha) {
    return reject('main tree differs from the tree checked out by the PR run');
  }
  if (!latestRun || latestRun.event !== 'pull_request'
    || latestRun.head_sha !== pullRequest.head.sha
    || latestRun.status !== 'completed'
    || latestRun.conclusion !== 'success') {
    return reject('latest PR test run for this head is not successful');
  }
  const runCreatedAt = Date.parse(latestRun.created_at);
  if (!Number.isFinite(runCreatedAt) || runCreatedAt > mergedAt) {
    return reject('successful PR test run did not start before merge');
  }
  const vitestJob = successfulRelatedVitestJob(jobs);
  if (!vitestJob) {
    return reject('PR test run did not complete the required related Vitest step');
  }
  const vitestCompletedAt = Date.parse(vitestJob.completed_at);
  if (!Number.isFinite(vitestCompletedAt) || vitestCompletedAt > mergedAt) {
    return reject('required PR Vitest job did not finish before merge');
  }
  return { reuse: true, reason: 'exact PR-tested merge tree already passed the required Vitest run' };
}
