#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  decideMainPushTestReuse,
  latestPullRequestTestRun,
  testedMergeTreeFromAnnotations,
} from './lib/main-push-test-reuse.mjs';
import { VITEST_EXECUTION_JOB_NAME } from './lib/constants.mjs';

const GH_TIMEOUT_MS = 15_000;
const GH_MAX_BUFFER = 16 * 1024 * 1024;

function ghJson(endpoint, fields = []) {
  const result = spawnSync('gh', [
    'api', '-X', 'GET', endpoint, ...fields,
  ], {
    encoding: 'utf8',
    env: process.env,
    maxBuffer: GH_MAX_BUFFER,
    timeout: GH_TIMEOUT_MS,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`gh api exited with ${result.status}`);
  return JSON.parse(result.stdout);
}

function writeOutput(reuse, reason) {
  const safeReason = String(reason).replace(/[\r\n]/g, ' ').slice(0, 200);
  const output = `reuse=${reuse}\nreason=${safeReason}\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output);
  console.log(`Main push Vitest reuse: ${reuse} (${safeReason})`);
}

function gitTreeSha(commitSha) {
  return execFileSync('git', ['rev-parse', `${commitSha}^{tree}`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: GH_TIMEOUT_MS,
  }).trim();
}

async function main() {
  let decision = { reuse: false, reason: 'reuse evidence unavailable' };
  try {
    const repository = process.env.GITHUB_REPOSITORY;
    const pushSha = process.env.GITHUB_SHA;
    const eventPath = process.env.GITHUB_EVENT_PATH;
    if (!/^[^/]+\/[^/]+$/.test(repository || '') || !pushSha || !eventPath) {
      writeOutput(false, 'required GitHub push context is unavailable');
      return;
    }

    const event = JSON.parse(readFileSync(eventPath, 'utf8'));
    if (event.before === '0000000000000000000000000000000000000000') {
      writeOutput(false, 'initial push has no prior tree to verify');
      return;
    }
    const pushTreeSha = gitTreeSha(pushSha);
    const pullRequests = ghJson(`repos/${repository}/commits/${pushSha}/pulls`, ['-f', 'per_page=100']);
    if (!Array.isArray(pullRequests) || pullRequests.length > 10) {
      writeOutput(false, 'associated PR response is incomplete or unexpectedly large');
      return;
    }

    for (const associatedPullRequest of pullRequests) {
      const pullRequestNumber = associatedPullRequest?.number;
      const associatedHeadSha = associatedPullRequest?.head?.sha;
      if (!Number.isSafeInteger(pullRequestNumber) || !associatedHeadSha
        || associatedPullRequest.merge_commit_sha !== pushSha) continue;

      // The commit-to-PR association response omits `changed_files` (and is
      // intentionally treated as a compact summary). Fetch the canonical PR
      // before requiring its complete file count or using any merge evidence.
      const pullRequest = ghJson(`repos/${repository}/pulls/${pullRequestNumber}`);
      if (pullRequest?.number !== pullRequestNumber
        || pullRequest?.state !== 'closed' || !pullRequest.merged_at
        || pullRequest.merge_commit_sha !== pushSha
        || pullRequest.head?.sha !== associatedHeadSha) continue;
      if (!Number.isInteger(pullRequest.changed_files) || pullRequest.changed_files > 100) continue;

      const changedFiles = ghJson(`repos/${repository}/pulls/${pullRequest.number}/files`, ['-f', 'per_page=100']);
      if (!Array.isArray(changedFiles) || changedFiles.length !== pullRequest.changed_files) continue;
      const workflowRuns = ghJson(
        `repos/${repository}/actions/workflows/tests.yml/runs`,
        ['-f', `head_sha=${pullRequest.head.sha}`, '-f', 'event=pull_request', '-f', 'per_page=100'],
      );
      const latestRun = latestPullRequestTestRun(workflowRuns, pullRequest.head.sha);
      const jobsResponse = latestRun
        ? ghJson(`repos/${repository}/actions/runs/${latestRun.id}/jobs`, ['-f', 'per_page=100'])
        : null;
      const jobsComplete = jobsResponse?.total_count === jobsResponse?.jobs?.length;
      const vitestJob = jobsComplete
        ? jobsResponse.jobs.find((job) => job?.name === VITEST_EXECUTION_JOB_NAME)
        : null;
      const annotationPages = vitestJob
        ? ghJson(`repos/${repository}/check-runs/${vitestJob.id}/annotations`, [
          '-f', 'per_page=100', '--paginate', '--slurp',
        ])
        : null;
      const testedTreeSha = testedMergeTreeFromAnnotations(annotationPages);

      decision = decideMainPushTestReuse({
        pushSha,
        pushSize: event.size,
        pushCommits: event.commits,
        pullRequest,
        pushTreeSha,
        testedTreeSha,
        changedFiles,
        latestRun,
        jobs: jobsComplete ? jobsResponse.jobs : null,
      });
      if (decision.reuse) break;
    }
  } catch (error) {
    decision = {
      reuse: false,
      reason: `verification failed open (${error?.message || String(error)})`,
    };
  }
  writeOutput(decision.reuse, decision.reason);
}

await main();
