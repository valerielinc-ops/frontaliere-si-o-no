#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { withTransientGithubApiRetry } from './lib/github-api-retry.mjs';
import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';

export const SOURCE_RUN_JSON_FIELDS = 'event,headBranch,headSha,status,conclusion';

function validateRunId(value) {
  const runId = String(value ?? '').trim();
  if (!/^\d+$/u.test(runId)) throw new Error('source run ID is missing or malformed');
  return runId;
}

function validateRepository(value) {
  const repository = String(value ?? '').trim();
  if (!/^[^/\s]+\/[^/\s]+$/u.test(repository)) throw new Error('GitHub repository is missing or malformed');
  return repository;
}

export function sourceRunViewArgs(runId, repository) {
  return [
    'run',
    'view',
    validateRunId(runId),
    '--repo',
    validateRepository(repository),
    '--json',
    SOURCE_RUN_JSON_FIELDS,
  ];
}

function defaultRun(args) {
  return execFileSync('gh', args, {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Read the source run once the bounded transient GitHub retry policy succeeds. */
export function readWorkflowRunProvenance({
  runId,
  repository,
  run = defaultRun,
  retryOptions = {},
} = {}) {
  const args = sourceRunViewArgs(runId, repository);
  const raw = withTransientGithubApiRetry(
    () => run(args),
    {
      ...retryOptions,
      onRetry: (details) => {
        retryOptions.onRetry?.(details);
        console.warn(
          `Transient GitHub source-run read failure; retrying ${details.attempt}/${details.maxRetries} in ${details.delayMs}ms`,
        );
      },
    },
  );
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('source run response is not an object');
    }
    return parsed;
  } catch (error) {
    throw new Error(`source run response is invalid JSON: ${error.message}`);
  }
}

export function main(argv = process.argv.slice(2)) {
  const [runId, repository] = argv;
  if (argv.length !== 2) throw new Error('usage: read-workflow-run-provenance.mjs <run-id> <owner/repository>');
  process.stdout.write(`${JSON.stringify(readWorkflowRunProvenance({ runId, repository }))}\n`);
}

if (isInvokedDirectly(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
