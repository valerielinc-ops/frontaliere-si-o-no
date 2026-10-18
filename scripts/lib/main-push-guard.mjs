#!/usr/bin/env node
/**
 * Fail-closed guard for automated writes to a repository's main branch.
 *
 * A normal fast-forward push protects the ref, but it does not say anything
 * about the tree being fast-forwarded.  A sparse or otherwise incomplete
 * checkout can therefore publish a commit that contains only the file the
 * writer happened to materialise.  This guard checks the candidate against
 * the exact base used to build it before publishing it, and carries that base
 * into an explicit force-with-lease so a concurrent writer cannot be hidden
 * by a stale local ref.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { isInvokedDirectly } from './is-invoked-directly.mjs';

export const DEFAULT_MIN_TREE_RATIO = 0.5;
export const DEFAULT_PUSH_TIMEOUT_SECONDS = 180;

function optionValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${option} needs a value`);
  return value;
}

export function parseArgs(argv = []) {
  const options = {
    branch: 'main',
    candidate: 'HEAD',
    remote: 'origin',
    checkOnly: false,
    push: false,
    minTreeRatio: DEFAULT_MIN_TREE_RATIO,
    timeoutSeconds: DEFAULT_PUSH_TIMEOUT_SECONDS,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--repo') options.repo = optionValue(argv, index++, arg);
    else if (arg.startsWith('--repo=')) options.repo = arg.slice('--repo='.length);
    else if (arg === '--base') options.base = optionValue(argv, index++, arg);
    else if (arg.startsWith('--base=')) options.base = arg.slice('--base='.length);
    else if (arg === '--candidate') options.candidate = optionValue(argv, index++, arg);
    else if (arg.startsWith('--candidate=')) options.candidate = arg.slice('--candidate='.length);
    else if (arg === '--branch') options.branch = optionValue(argv, index++, arg);
    else if (arg.startsWith('--branch=')) options.branch = arg.slice('--branch='.length);
    else if (arg === '--remote') options.remote = optionValue(argv, index++, arg);
    else if (arg.startsWith('--remote=')) options.remote = arg.slice('--remote='.length);
    else if (arg === '--min-tree-ratio') options.minTreeRatio = Number(optionValue(argv, index++, arg));
    else if (arg.startsWith('--min-tree-ratio=')) options.minTreeRatio = Number(arg.slice('--min-tree-ratio='.length));
    else if (arg === '--timeout-seconds') options.timeoutSeconds = Number(optionValue(argv, index++, arg));
    else if (arg.startsWith('--timeout-seconds=')) options.timeoutSeconds = Number(arg.slice('--timeout-seconds='.length));
    else if (arg === '--check-only') options.checkOnly = true;
    else if (arg === '--push') options.push = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown option: ${arg}`);
  }

  if (!options.help && !options.repo) throw new Error('--repo is required');
  if (!options.help && !options.base) throw new Error('--base is required');
  if (!options.help && options.branch !== 'main') {
    throw new Error(`main-push-guard only accepts --branch main, got ${options.branch}`);
  }
  if (!options.help && options.checkOnly === options.push) {
    throw new Error('choose exactly one of --check-only or --push');
  }
  if (!Number.isFinite(options.minTreeRatio) || options.minTreeRatio <= 0 || options.minTreeRatio > 1) {
    throw new Error(`--min-tree-ratio must be > 0 and <= 1, got ${options.minTreeRatio}`);
  }
  if (!Number.isSafeInteger(options.timeoutSeconds) || options.timeoutSeconds <= 0) {
    throw new Error(`--timeout-seconds must be a positive integer, got ${options.timeoutSeconds}`);
  }
  return options;
}

class MainPushDeadlineError extends Error {}

function operationDeadline(timeoutSeconds) {
  return performance.now() + (timeoutSeconds * 1000);
}

function remainingTimeout(deadline, operation) {
  const remaining = Math.floor(deadline - performance.now());
  if (remaining <= 0) throw new MainPushDeadlineError(`main push deadline exceeded before ${operation}`);
  return remaining;
}

function git(repo, args, {
  deadline,
  operation = `git ${args[0]}`,
  stdio = ['ignore', 'pipe', 'pipe'],
  env = process.env,
} = {}) {
  try {
    return execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      // A production checkout contains tens of thousands of paths. Keep the
      // complete tree enumeration bounded without letting Node's 1 MiB default
      // turn a valid candidate into an infrastructure failure.
      maxBuffer: 64 * 1024 * 1024,
      timeout: remainingTimeout(deadline, operation),
      killSignal: 'SIGTERM',
      stdio,
      env: { ...env, GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' },
    });
  } catch (error) {
    if (error instanceof MainPushDeadlineError
      || error?.code === 'ETIMEDOUT'
      || error?.signal === 'SIGTERM') {
      throw new MainPushDeadlineError(`main push deadline exceeded during ${operation}`);
    }
    throw error;
  }
}

function gitRef(repo, ref, deadline) {
  try {
    return git(repo, ['rev-parse', '--verify', `${ref}^{commit}`], {
      deadline,
      operation: `resolving ${ref}`,
    }).trim();
  } catch (error) {
    if (error instanceof MainPushDeadlineError) throw error;
    throw new Error(`cannot resolve commit ref '${ref}' in ${repo}`);
  }
}

function treeEntryCount(repo, ref, deadline) {
  let output;
  try {
    output = git(repo, ['ls-tree', '-r', '-z', '--full-tree', '--name-only', ref], {
      deadline,
      operation: `inspecting tree ${ref}`,
    });
  } catch (error) {
    if (error instanceof MainPushDeadlineError) throw error;
    throw new Error(`cannot inspect tree '${ref}' in ${repo}`);
  }
  if (!output.trim()) return 0;
  return output.split('\0').filter(Boolean).length;
}

function isAncestor(repo, baseSha, candidateSha, deadline) {
  const result = spawnSync('git', ['-C', repo, 'merge-base', '--is-ancestor', baseSha, candidateSha], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: remainingTimeout(deadline, 'proving ancestry'),
    killSignal: 'SIGTERM',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' },
  });
  if (result.error?.code === 'ETIMEDOUT' || result.signal === 'SIGTERM') {
    throw new MainPushDeadlineError('main push deadline exceeded during ancestry proof');
  }
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(`cannot prove ancestry ${baseSha} -> ${candidateSha}: ${(result.stderr || '').trim() || 'git error'}`);
}

/**
 * Validate a candidate without changing refs or pushing anything.
 *
 * @returns {{baseSha: string, candidateSha: string, baseEntries: number, candidateEntries: number, minimumEntries: number}}
 */
export function inspectMainPushCandidate({
  repo,
  base,
  candidate = 'HEAD',
  minTreeRatio = DEFAULT_MIN_TREE_RATIO,
  timeoutSeconds = DEFAULT_PUSH_TIMEOUT_SECONDS,
  deadline,
} = {}) {
  if (!repo || !base || !candidate) throw new Error('repo, base and candidate are required');
  if (!Number.isFinite(minTreeRatio) || minTreeRatio <= 0 || minTreeRatio > 1) {
    throw new Error(`minTreeRatio must be > 0 and <= 1, got ${minTreeRatio}`);
  }
  if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new Error(`timeoutSeconds must be a positive integer, got ${timeoutSeconds}`);
  }
  const sharedDeadline = deadline ?? operationDeadline(timeoutSeconds);

  const baseSha = gitRef(repo, base, sharedDeadline);
  const candidateSha = gitRef(repo, candidate, sharedDeadline);
  if (!isAncestor(repo, baseSha, candidateSha, sharedDeadline)) {
    throw new Error(`candidate ${candidateSha} is not a descendant of base ${baseSha}; refusing a non-fast-forward main write`);
  }

  const baseEntries = treeEntryCount(repo, baseSha, sharedDeadline);
  const candidateEntries = treeEntryCount(repo, candidateSha, sharedDeadline);
  const minimumEntries = Math.max(1, Math.ceil(baseEntries * minTreeRatio));
  if (candidateEntries < minimumEntries) {
    throw new Error(
      `candidate tree collapse: base ${baseEntries} entries, candidate ${candidateEntries}; `
      + `minimum is ${minimumEntries} (${minTreeRatio * 100}% of base)`,
    );
  }

  return { baseSha, candidateSha, baseEntries, candidateEntries, minimumEntries };
}

/**
 * Validate and atomically publish a candidate against the captured base.
 * The lease is explicit even though the candidate is required to be a
 * descendant: it closes the race between reading origin/main and the push.
 */
export function pushMainWithGuard({
  repo,
  base,
  candidate = 'HEAD',
  remote = 'origin',
  branch = 'main',
  minTreeRatio = DEFAULT_MIN_TREE_RATIO,
  timeoutSeconds = DEFAULT_PUSH_TIMEOUT_SECONDS,
  env = process.env,
} = {}) {
  if (branch !== 'main') throw new Error(`main-push-guard only accepts branch main, got ${branch}`);
  if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new Error(`timeoutSeconds must be a positive integer, got ${timeoutSeconds}`);
  }

  const deadline = operationDeadline(timeoutSeconds);
  const inspection = inspectMainPushCandidate({
    repo,
    base,
    candidate,
    minTreeRatio,
    timeoutSeconds,
    deadline,
  });
  const lease = `refs/heads/${branch}:${inspection.baseSha}`;
  // A symbolic candidate such as HEAD may move while the inspection is in
  // progress. Push the SHA that was actually inspected, never re-resolve the
  // mutable ref when git constructs the refspec.
  const refspec = `${inspection.candidateSha}:refs/heads/${branch}`;
  try {
    const output = git(repo, [
      '-c', 'pack.window=0',
      '-c', 'pack.threads=1',
      'push', '--no-thin', '--no-verify',
      `--force-with-lease=${lease}`,
      remote, refspec,
    ], { deadline, operation: 'git push', env });
    return { ...inspection, output: output.trim() };
  } catch (error) {
    const detail = [error?.stdout, error?.stderr, error?.message]
      .filter(Boolean)
      .join('\n')
      .replace(/https:\/\/x-access-token:[^@\s]+@/gu, 'https://x-access-token:[REDACTED]@')
      .trim();
    throw new Error(`main push rejected: ${detail || 'git push failed'}`);
  }
}

function usage() {
  return [
    'node scripts/lib/main-push-guard.mjs --repo REPO --base BASE_SHA --candidate REF --check-only',
    'node scripts/lib/main-push-guard.mjs --repo REPO --base BASE_SHA --candidate REF --push',
  ].join('\n');
}

if (isInvokedDirectly(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
    } else if (options.checkOnly) {
      console.log(JSON.stringify(inspectMainPushCandidate(options)));
    } else {
      console.log(JSON.stringify(pushMainWithGuard(options)));
    }
  } catch (error) {
    console.error(`❌ main push guard: ${error?.message || error}`);
    process.exitCode = 1;
  }
}
