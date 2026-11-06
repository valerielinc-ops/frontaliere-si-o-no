#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const CRAWL_EVENTS_REFRESH_TITLE = 'chore(data): refresh crawl events';
export const CRAWL_EVENTS_REFRESH_BRANCH = 'chore/crawl-events-refresh';

function isRefreshBranch(branch) {
  return branch === CRAWL_EVENTS_REFRESH_BRANCH
    || /^chore\/crawl-events-refresh-\d+-\d+$/u.test(branch);
}

/**
 * Continue only the newest still-open events refresh PR. Closed or merged
 * refreshes must not make a later crawl reuse their branch; that branch can
 * contain source slices which the new crawl deliberately did not carry.
 */
export function selectCrawlEventsRefreshBranch({
  pullRequests,
  repository,
  runId,
  runAttempt = '1',
}) {
  if (!Array.isArray(pullRequests)) throw new TypeError('pullRequests must be an array');
  if (typeof repository !== 'string' || !repository.includes('/')) {
    throw new TypeError('repository must be owner/name');
  }
  if (!/^\d+$/u.test(String(runId)) || !/^\d+$/u.test(String(runAttempt))) {
    throw new TypeError('runId and runAttempt must be numeric');
  }

  const candidates = pullRequests
    .filter((pr) => pr?.title === CRAWL_EVENTS_REFRESH_TITLE)
    .filter((pr) => pr?.headRepository?.nameWithOwner === repository)
    .filter((pr) => isRefreshBranch(pr?.headRefName))
    .sort((left, right) => {
      const byCreated = String(right.createdAt || '').localeCompare(String(left.createdAt || ''));
      return byCreated || Number(right.number || 0) - Number(left.number || 0);
    });
  const latest = candidates[0];

  if (latest?.state === 'OPEN') {
    return {
      branch: latest.headRefName,
      requireNewBranch: false,
      requireExistingBranch: true,
      reason: `continuing open PR #${latest.number}`,
    };
  }

  if (latest) {
    return {
      branch: `${CRAWL_EVENTS_REFRESH_BRANCH}-${runId}-${runAttempt}`,
      requireNewBranch: true,
      requireExistingBranch: false,
      reason: `latest refresh PR #${latest.number} is ${latest.mergedAt ? 'merged' : 'closed'}`,
    };
  }

  return {
    branch: CRAWL_EVENTS_REFRESH_BRANCH,
    requireNewBranch: false,
    requireExistingBranch: false,
    reason: 'no refresh PR history found',
  };
}

function readOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!['--repository', '--run-id', '--run-attempt'].includes(flag) || !value) {
      throw new Error('Usage: select-crawl-events-refresh-branch.mjs --repository owner/name --run-id N --run-attempt N');
    }
    options[flag.slice(2).replace(/-([a-z])/gu, (_match, letter) => letter.toUpperCase())] = value;
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    const pullRequests = JSON.parse(await new Promise((resolve, reject) => {
      let input = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => { input += chunk; });
      process.stdin.on('end', () => resolve(input));
      process.stdin.on('error', reject);
    }));
    const result = selectCrawlEventsRefreshBranch({
      ...readOptions(process.argv.slice(2)),
      pullRequests,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
