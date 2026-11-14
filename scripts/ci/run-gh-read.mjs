#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  GITHUB_API_TRANSIENT_RETRY_BASE_MS,
  GITHUB_API_TRANSIENT_RETRIES,
  withTransientGithubApiRetry,
} from './lib/github-api-retry.mjs';

const MAX_BUFFER = 32 * 1024 * 1024;

function defaultExecute(args) {
  return execFileSync('gh', args, {
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * Run one read-only GitHub CLI query with the repository-wide bounded retry
 * contract. The caller still decides whether an exhausted read is fatal:
 * admission callers fail closed, while optional telemetry callers can fall
 * back to an empty observation.
 */
export function runGhRead(args, {
  execute = defaultExecute,
  sleep,
  retries = GITHUB_API_TRANSIENT_RETRIES,
  baseDelayMs = GITHUB_API_TRANSIENT_RETRY_BASE_MS,
  onRetry,
} = {}) {
  return withTransientGithubApiRetry(
    () => execute(args),
    {
      retries,
      baseDelayMs,
      sleep,
      onRetry: ({ attempt, maxRetries, delayMs, error }) => {
        onRetry?.({ attempt, maxRetries, delayMs, error });
        console.error(`GitHub read transient failure; retrying in ${delayMs} ms (attempt ${attempt}/${maxRetries}).`);
      },
    },
  );
}

function main() {
  const args = process.argv.slice(2);
  if (!args.length) throw new Error('usage: run-gh-read.mjs <gh arguments...>');
  process.stdout.write(runGhRead(args));
}

if ((() => {
  try {
    return process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
})()) {
  try {
    main();
  } catch (error) {
    const stderr = error?.stderr ? String(error.stderr) : '';
    if (stderr) process.stderr.write(stderr);
    else console.error(error?.message || error);
    process.exitCode = 1;
  }
}
