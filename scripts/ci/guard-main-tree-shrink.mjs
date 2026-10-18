#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

export const MIN_BASE_PATHS = 1_000;
export const MAX_REMAINING_RATIO = 0.01;
export const MIN_REMAINING_PATHS = 10;
export const DEFAULT_GUARDED_PUSH_TIMEOUT_MS = 120_000;

class FatalGuardError extends Error {}
const activeGitChildren = new Set();
let receivedSignal = null;

function fatalGuardError(message) {
  return new FatalGuardError(message);
}

function redactGitStderr(stderr) {
  return stderr
    .replace(/(https?:\/\/)[^/@\s]+@/giu, '$1[REDACTED]@')
    .replace(/([?&](?:access_token|token|password|key)=)[^&\s]+/giu, '$1[REDACTED]')
    .replace(/((?:authorization|password|token|secret)\s*[:=]\s*)(?:basic\s+|bearer\s+)?[^\s"']+/giu, '$1[REDACTED]');
}

function summarizeGitFailure(stderr = '') {
  const summaries = [];
  const patterns = [
    [/authentication failed/iu, 'Authentication failed'],
    [/invalid username or password/iu, 'Invalid username or password'],
    [/could not read username/iu, 'Could not read username'],
    [/support for password authentication/iu, 'Password authentication is unsupported'],
    [/permission denied|denied to|write access .* not granted/iu, 'Write permission denied'],
    [/HTTP 401|requested URL returned error: 401/iu, 'HTTP 401'],
    [/HTTP 403|requested URL returned error: 403|forbidden/iu, 'HTTP 403 Forbidden'],
    [/HTTP 404|repository not found/iu, 'HTTP 404 Repository not found'],
    [/couldn.t find remote ref|no such remote|does not appear to be a git repository/iu, 'Configured remote repository or ref is missing'],
    [/HTTP 429|requested URL returned error: 429|secondary rate limit|rate limit exceeded/iu, 'HTTP 429 rate limit exceeded'],
    [/GH013|GH006|repository rule violations|push declined/iu, 'Repository rule rejected the push'],
    [/does not contain the candidate|final remote main does not contain/iu, 'Final remote main does not contain the pushed commit'],
    [/could not resolve host/iu, 'Could not resolve host'],
    [/ETIMEDOUT|timed? out|time.?out/iu, 'Git operation timed out'],
  ];
  for (const [pattern, summary] of patterns) {
    if (pattern.test(stderr)) summaries.push(summary);
  }
  return summaries.length ? [...new Set(summaries)].join('; ') : 'Git command failed';
}

function isPermanentGitFailure(stderr = '') {
  if (/secondary rate limit|rate limit exceeded|HTTP 429|requested URL returned error: 429/iu.test(stderr)) return false;
  return /authentication failed|invalid username or password|could not read username|support for password authentication|HTTP 401|HTTP 403|HTTP 404|requested URL returned error: 40[134]|permission denied|denied to|write access .* not granted|repository not found|couldn.t find remote ref|no such remote|does not appear to be a git repository|GH013|GH006|repository rule violations|push declined/iu.test(stderr);
}

function expectedObjectIdLength(cwd) {
  const objectFormat = execFileSync('git', ['rev-parse', '--show-object-format'], {
    cwd,
    encoding: 'utf8',
  }).trim();
  if (objectFormat === 'sha1') return 40;
  if (objectFormat === 'sha256') return 64;
  throw new Error(`Unsupported Git object format: ${objectFormat}`);
}

export function evaluateTreeCounts(before, after) {
  if (!Number.isSafeInteger(before) || before < 0 || !Number.isSafeInteger(after) || after < 0) {
    throw new TypeError('Tree counts must be non-negative safe integers');
  }

  const remainingLimit = Math.max(MIN_REMAINING_PATHS, Math.floor(before * MAX_REMAINING_RATIO));
  const suspicious = before >= MIN_BASE_PATHS && after < before && after <= remainingLimit;
  return {
    before,
    after,
    removed: Math.max(0, before - after),
    remainingLimit,
    suspicious,
  };
}

export function countTrackedPaths(revision, cwd = process.cwd()) {
  const expectedLength = expectedObjectIdLength(cwd);
  if (typeof revision !== 'string' || revision.length !== expectedLength || !/^[0-9a-f]+$/i.test(revision)) {
    throw new TypeError(`Expected a full ${expectedLength}-character Git object ID, received: ${revision}`);
  }
  const output = execFileSync('git', ['ls-tree', '-r', '-z', '--name-only', revision], {
    cwd,
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
  });
  let count = 0;
  for (const byte of output) if (byte === 0) count++;
  return count;
}

function namedHexReference(reference, cwd) {
  for (const prefix of ['refs/heads', 'refs/tags']) {
    const candidate = `${prefix}/${reference}`;
    try {
      execFileSync('git', ['show-ref', '--verify', '--quiet', candidate], { cwd, stdio: 'ignore' });
      return candidate;
    } catch {
      // Keep checking the other explicit ref namespace.
    }
  }
  return null;
}

export function resolveCommitRevision(reference, cwd = process.cwd()) {
  const expectedLength = expectedObjectIdLength(cwd);
  let revisionReference = reference;
  if (/^[0-9a-f]+$/i.test(reference) && reference.length !== expectedLength) {
    revisionReference = namedHexReference(reference, cwd);
    if (!revisionReference) {
      throw new TypeError(`Expected a full ${expectedLength}-character Git object ID or a named ref, received: ${reference}`);
    }
  }
  const resolved = execFileSync('git', [
    'rev-parse',
    '--verify',
    '--end-of-options',
    `${revisionReference}^{commit}`,
  ], { cwd, encoding: 'utf8' }).trim();
  if (resolved.length !== expectedLength || !/^[0-9a-f]+$/i.test(resolved)) {
    throw new TypeError(`Expected a commit reference resolving to a full ${expectedLength}-character Git object ID, received: ${reference}`);
  }
  return resolved;
}

export function guardTreeShrink(beforeRevision, afterRevision, cwd = process.cwd()) {
  const before = countTrackedPaths(beforeRevision, cwd);
  const after = countTrackedPaths(afterRevision, cwd);
  return evaluateTreeCounts(before, after);
}

function signalProcessGroup(pid, signal) {
  if (!pid || process.platform === 'win32') return;
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

function terminateGitChild(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    try { child.kill('SIGKILL'); } catch { /* the child may have exited */ }
    return;
  }
  signalProcessGroup(child.pid, 'SIGKILL');
}

function processGroupExists(pid) {
  if (!pid || process.platform === 'win32') return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

async function waitForProcessGroupExit(pid) {
  if (!pid || process.platform === 'win32') return;
  const deadline = Date.now() + 500;
  while (processGroupExists(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (processGroupExists(pid)) {
    signalProcessGroup(pid, 'SIGKILL');
    const killDeadline = Date.now() + 500;
    while (processGroupExists(pid) && Date.now() < killDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  if (processGroupExists(pid)) throw new Error(`Git process group ${pid} did not stop`);
}

function installSignalForwarding() {
  const handlers = new Map();
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    const handler = () => {
      receivedSignal ??= signal;
      for (const child of activeGitChildren) terminateGitChild(child);
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  return () => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  };
}

function interruptedError() {
  const error = new Error(`Guarded main push interrupted by ${receivedSignal}`);
  error.code = 'GUARD_INTERRUPTED';
  return error;
}

function runGit(args, {
  cwd = process.cwd(),
  silent = false,
  timeoutMs = 10_000,
  captureStdout = false,
  captureStderr = false,
  allowAfterSignal = false,
  maxOutputBytes = 64 * 1024 * 1024,
} = {}) {
  if (receivedSignal && !allowAfterSignal) return Promise.reject(interruptedError());
  return new Promise((resolve, reject) => {
    const stderrChunks = [];
    const stdoutChunks = [];
    let stderrBytes = 0;
    let stdoutBytes = 0;
    let timedOut = false;
    let outputLimitExceeded = false;
    let settled = false;
    const child = spawn('git', args, {
      cwd,
      stdio: [
        'ignore',
        captureStdout ? 'pipe' : silent ? 'ignore' : 'inherit',
        silent || captureStderr ? 'pipe' : 'inherit',
      ],
      detached: process.platform !== 'win32',
    });
    activeGitChildren.add(child);

    const capture = (stream, chunks, currentBytes, isStderr) => {
      stream?.on('data', (chunk) => {
        const nextBytes = currentBytes() + chunk.length;
        const streamLimit = isStderr ? Math.min(maxOutputBytes, 16 * 1024 * 1024) : maxOutputBytes;
        if (nextBytes > streamLimit) {
          outputLimitExceeded = true;
          terminateGitChild(child);
          return;
        }
        chunks.push(chunk);
        if (isStderr) stderrBytes = nextBytes;
        else stdoutBytes = nextBytes;
      });
    };
    capture(child.stderr, stderrChunks, () => stderrBytes, true);
    capture(child.stdout, stdoutChunks, () => stdoutBytes, false);

    const getStderr = () => Buffer.concat(stderrChunks).toString('utf8');

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      activeGitChildren.delete(child);
      if (error) error.gitStderr ??= getStderr();
      if (error) reject(error);
      else resolve(result);
    };

    child.once('error', (cause) => {
      const error = new Error(`Unable to start Git: ${cause.message}`, { cause });
      finish(error);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      terminateGitChild(child);
    }, timeoutMs);

    child.once('close', (status, signal) => {
      (async () => {
        if (timedOut || (receivedSignal && !allowAfterSignal) || outputLimitExceeded) {
          await waitForProcessGroupExit(child.pid);
        }
        if (captureStderr && !silent) process.stderr.write(redactGitStderr(getStderr()));
        if (timedOut) {
          const error = new Error(`Git command timed out after ${timeoutMs}ms`);
          error.code = 'ETIMEDOUT';
          throw error;
        }
        if (receivedSignal && !allowAfterSignal) throw interruptedError();
        if (outputLimitExceeded) {
          const error = new Error(`Git command output exceeded ${maxOutputBytes} bytes`);
          error.code = 'ERR_OUTPUT_LIMIT';
          throw error;
        }
        const result = {
          status: status ?? 1,
          stderr: getStderr(),
          stdout: captureStdout ? Buffer.concat(stdoutChunks) : undefined,
          signal,
        };
        finish(null, silent || captureStdout || captureStderr ? result : result.status);
      })().catch((error) => {
        finish(error);
      });
    });
  });
}

async function isAncestor(ancestor, descendant, cwd, timeoutMs) {
  const result = await runGit(['merge-base', '--is-ancestor', ancestor, descendant], {
    cwd,
    silent: true,
    timeoutMs,
  });
  if (result.status > 1) throw new Error(`git merge-base failed with status ${result.status}`);
  return result.status === 0;
}

async function expectedObjectIdLengthForPush(cwd, timeoutMs) {
  const result = await runGit(['rev-parse', '--show-object-format'], {
    cwd, silent: true, captureStdout: true, timeoutMs,
  });
  if (result.status !== 0) throw new Error(`git rev-parse --show-object-format failed with status ${result.status}`);
  const objectFormat = result.stdout.toString('utf8').trim();
  if (objectFormat === 'sha1') return 40;
  if (objectFormat === 'sha256') return 64;
  throw new Error(`Unsupported Git object format: ${objectFormat}`);
}

async function resolveCommitRevisionForPush(reference, cwd, timeoutMs) {
  const expectedLength = await expectedObjectIdLengthForPush(cwd, timeoutMs);
  let revisionReference = reference;
  if (/^[0-9a-f]+$/i.test(reference) && reference.length !== expectedLength) {
    for (const prefix of ['refs/heads', 'refs/tags']) {
      const candidate = `${prefix}/${reference}`;
      const result = await runGit(['show-ref', '--verify', '--quiet', candidate], { cwd, silent: true, timeoutMs });
      if (result.status === 0) {
        revisionReference = candidate;
        break;
      }
    }
    if (revisionReference === reference) {
      throw new TypeError(`Expected a full ${expectedLength}-character Git object ID or a named ref, received: ${reference}`);
    }
  }
  const result = await runGit([
    'rev-parse', '--verify', '--end-of-options', `${revisionReference}^{commit}`,
  ], { cwd, silent: true, captureStdout: true, timeoutMs });
  if (result.status !== 0) throw new Error(`git rev-parse could not resolve the requested commit (status ${result.status})`);
  const resolved = result.stdout.toString('utf8').trim();
  if (resolved.length !== expectedLength || !/^[0-9a-f]+$/i.test(resolved)) {
    throw new TypeError(`Expected a commit reference resolving to a full ${expectedLength}-character Git object ID, received: ${reference}`);
  }
  return resolved;
}

async function countTrackedPathsForPush(revision, cwd, timeoutMs) {
  const expectedLength = await expectedObjectIdLengthForPush(cwd, timeoutMs);
  if (typeof revision !== 'string' || revision.length !== expectedLength || !/^[0-9a-f]+$/i.test(revision)) {
    throw new TypeError(`Expected a full ${expectedLength}-character Git object ID`);
  }
  const result = await runGit(['ls-tree', '-r', '-z', '--name-only', revision], {
    cwd, silent: true, captureStdout: true, timeoutMs,
  });
  if (result.status !== 0) throw new Error(`git ls-tree failed with status ${result.status}`);
  let count = 0;
  for (const byte of result.stdout) if (byte === 0) count++;
  return count;
}

async function guardTreeShrinkForPush(beforeRevision, afterRevision, cwd, timeoutMs) {
  const before = await countTrackedPathsForPush(beforeRevision, cwd, timeoutMs);
  const after = await countTrackedPathsForPush(afterRevision, cwd, timeoutMs);
  return evaluateTreeCounts(before, after);
}

function parsePushOptions(args) {
  const options = {
    remote: null,
    target: null,
    after: null,
    noThin: false,
    noVerify: false,
    gitConfig: [],
    timeoutMs: DEFAULT_GUARDED_PUSH_TIMEOUT_MS,
  };
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--no-thin') options.noThin = true;
    else if (argument === '--no-verify') options.noVerify = true;
    else if (argument === '--remote' || argument === '--target' || argument === '--after'
      || argument === '--git-config' || argument === '--timeout-ms') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw new TypeError(`Missing value for ${argument}`);
      index += 1;
      if (argument === '--remote') options.remote = value;
      else if (argument === '--target') options.target = value;
      else if (argument === '--after') options.after = value;
      else if (argument === '--timeout-ms') {
        if (!/^[1-9]\d*$/u.test(value) || !Number.isSafeInteger(Number(value))) {
          throw new TypeError('--timeout-ms must be a positive safe integer');
        }
        options.timeoutMs = Number(value);
      }
      else options.gitConfig.push(value);
    } else {
      throw new TypeError(`Unknown guarded-push option: ${argument}`);
    }
  }
  if (!options.remote || options.remote.startsWith('-')) throw new TypeError('A push remote is required');
  if (options.target !== 'main' && options.target !== 'refs/heads/main') {
    throw new TypeError('The guarded push target must be main');
  }
  if (!options.after) throw new TypeError('A candidate commit is required');
  for (const setting of options.gitConfig) {
    if (!/^[A-Za-z0-9][A-Za-z0-9./:-]*=/u.test(setting)) {
      throw new TypeError(`Invalid Git configuration setting: ${setting.split('=', 1)[0]}`);
    }
  }
  return options;
}

function withGitConfig(options, args) {
  const configured = [];
  for (const setting of options.gitConfig) configured.push('-c', setting);
  return [...configured, ...args];
}

async function pushMainSafely(options, cwd = process.cwd()) {
  const trackingRef = `refs/ci/main-tree-guard/${process.pid}-${randomBytes(8).toString('hex')}`;
  const targetRef = 'refs/heads/main';
  const deadline = Date.now() + options.timeoutMs;
  const remainingTimeoutMs = () => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`Guarded main push timed out after ${options.timeoutMs}ms`);
    return remaining;
  };
  const fetchRemoteMain = async (afterPush = false) => {
    let result;
    try {
      result = await runGit(withGitConfig(options, [
        'fetch', '--quiet', '--no-tags', '--no-write-fetch-head', options.remote,
        `+${targetRef}:${trackingRef}`,
      ]), { cwd, silent: true, timeoutMs: remainingTimeoutMs() });
    } catch (error) {
      if (error?.code === 'GUARD_INTERRUPTED') {
        throw fatalGuardError(`Guarded main push interrupted by ${receivedSignal}`);
      }
      const details = summarizeGitFailure(`${error?.gitStderr ?? ''} ${error?.message ?? ''}`);
      if (afterPush) {
        throw fatalGuardError(`Push succeeded, but final main could not be fetched for verification (${details})`);
      }
      if (isPermanentGitFailure(error?.gitStderr)) {
        throw fatalGuardError(`Unable to fetch main from the configured push remote (${details})`);
      }
      throw new Error(`Unable to fetch main from the configured push remote (${details})`);
    }
    if (result.status !== 0) {
      const details = summarizeGitFailure(result.stderr);
      if (afterPush) {
        throw fatalGuardError(`Push succeeded, but final main could not be fetched for verification (${details})`);
      }
      if (isPermanentGitFailure(result.stderr)) {
        throw fatalGuardError(`Unable to fetch main from the configured push remote (${details})`);
      }
      throw new Error(`Unable to fetch main from the configured push remote (${details})`);
    }
  };
  try {
    await fetchRemoteMain();

    let expected;
    let candidate;
    let checked;
    try {
      expected = await resolveCommitRevisionForPush(trackingRef, cwd, remainingTimeoutMs());
      candidate = await resolveCommitRevisionForPush(options.after, cwd, remainingTimeoutMs());
      if (!await isAncestor(expected, candidate, cwd, remainingTimeoutMs())) {
        throw new Error(`Remote main advanced beyond the candidate; rebase required (remote ${expected}, candidate ${candidate})`);
      }
      checked = await guardTreeShrinkForPush(expected, candidate, cwd, remainingTimeoutMs());
    } catch (error) {
      if (error instanceof FatalGuardError) throw error;
      if (error.message?.includes('Remote main advanced beyond the candidate')) throw error;
      throw fatalGuardError(`Unable to verify the candidate and remote main before push (${summarizeGitFailure(`${error?.gitStderr ?? ''} ${error?.message ?? ''}`)})`);
    }
    const checkedSummary = `main tree paths: ${checked.before} → ${checked.after} (removed ${checked.removed})`;
    if (checked.suspicious) {
      throw fatalGuardError(`Possible catastrophic main tree shrink: ${checkedSummary}; threshold leaves at most ${checked.remainingLimit} paths`);
    }

    const pushArgs = ['push', `--force-with-lease=${targetRef}:${expected}`];
    if (options.noThin) pushArgs.push('--no-thin');
    if (options.noVerify) pushArgs.push('--no-verify');
    pushArgs.push(options.remote, `${candidate}:${targetRef}`);
    const pushResult = await runGit(withGitConfig(options, pushArgs), {
      cwd, timeoutMs: remainingTimeoutMs(), captureStderr: true,
    });
    if (pushResult.status !== 0) {
      if (isPermanentGitFailure(pushResult.stderr)) {
        throw fatalGuardError(`Push to the configured remote was rejected (${summarizeGitFailure(pushResult.stderr)})`);
      }
      return pushResult.status;
    }

    await fetchRemoteMain(true);
    try {
      const final = await resolveCommitRevisionForPush(trackingRef, cwd, remainingTimeoutMs());
      if (!await isAncestor(candidate, final, cwd, remainingTimeoutMs())) {
        throw new Error(`Push returned success, but the final remote main does not contain the candidate (candidate ${candidate}, remote ${final})`);
      }
      const finalCheck = await guardTreeShrinkForPush(expected, final, cwd, remainingTimeoutMs());
      if (finalCheck.suspicious) {
        throw new Error(`Remote main shrank after the guarded push: ${finalCheck.before} → ${finalCheck.after} paths`);
      }
      console.log(`guarded main push: ${expected} → ${final}; ${checkedSummary}`);
      return 0;
    } catch (error) {
      if (error instanceof FatalGuardError) throw error;
      throw fatalGuardError(`Push succeeded, but final verification failed (${summarizeGitFailure(`${error?.gitStderr ?? ''} ${error?.message ?? ''}`)})`);
    }
  } finally {
    try {
      const cleanup = await runGit(['update-ref', '-d', trackingRef], {
        cwd, silent: true, timeoutMs: 5_000, allowAfterSignal: true,
      });
      if (cleanup.status !== 0) {
        console.error(`warning: could not remove temporary guarded-push ref (git update-ref exited ${cleanup.status})`);
      }
    } catch (error) {
      console.error(`warning: could not remove temporary guarded-push ref: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

async function main(args) {
  if (args[0] === '--push-main') {
    const removeSignalForwarding = installSignalForwarding();
    try {
      return await pushMainSafely(parsePushOptions(args));
    } catch (error) {
      const fatal = error instanceof FatalGuardError || error instanceof TypeError || error?.code === 'GUARD_INTERRUPTED';
      console.error(`error: [main-tree-guard] ${fatal ? 'MAIN_TREE_GUARD_FATAL: ' : ''}${error instanceof Error ? error.message : String(error)}`);
      return 1;
    } finally {
      removeSignalForwarding();
    }
  }

  if (args.length !== 4 || args[0] !== '--before' || args[2] !== '--after') {
    console.error('Usage: guard-main-tree-shrink.mjs --before <ref-or-object-id> --after <ref-or-object-id>\n'
      + '       guard-main-tree-shrink.mjs --push-main --remote <remote> --target main --after <commit> '
      + '[--timeout-ms <milliseconds>] [--no-thin] [--no-verify] [--git-config <key=value>]');
    return 2;
  }

  try {
    const before = resolveCommitRevision(args[1]);
    const after = resolveCommitRevision(args[3]);
    const result = guardTreeShrink(before, after);
    const summary = `main tree paths: ${result.before} → ${result.after} (removed ${result.removed})`;
    if (result.suspicious) {
      console.error(`::error::Possible catastrophic main tree shrink: ${summary}; threshold leaves at most ${result.remainingLimit} paths.`);
      return 1;
    }
    console.log(`tree-shrink guard: ${summary}`);
    return 0;
  } catch (error) {
    console.error(`::error::Unable to verify main tree size: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (process.argv[1]?.endsWith('/guard-main-tree-shrink.mjs')) {
  main(process.argv.slice(2)).then((status) => {
    process.exitCode = status;
  }).catch((error) => {
    console.error(`error: [main-tree-guard] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
