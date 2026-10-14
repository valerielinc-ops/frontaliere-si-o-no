#!/usr/bin/env node
/**
 * Persist the local Chrome Insights document on the site's main branch.
 *
 * The robot never commits from its possibly dirty checkout. Instead this
 * helper creates a tiny detached worktree from origin/main, changes exactly
 * data/instagram-insights.json and pushes that commit with a bounded
 * fast-forward retry. It is called by launchd after a read-only browser pass.
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';
import { withSingleFlightLock } from '../lib/single-flight-lock.mjs';

const DATA_PATH = 'data/instagram-insights.json';
const GIT_TIMEOUT_MS = 120_000;

function nextValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${option} needs a value`);
  return value;
}
export function parseArgs(argv = []) {
  const options = { dryRun: false, path: DATA_PATH };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--repo') options.repo = nextValue(argv, index++, '--repo');
    else if (arg.startsWith('--repo=')) options.repo = arg.slice('--repo='.length);
    else if (arg === '--snapshot') options.snapshot = nextValue(argv, index++, '--snapshot');
    else if (arg.startsWith('--snapshot=')) options.snapshot = arg.slice('--snapshot='.length);
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown option: ${arg}`);
  }
  if (!options.repo || !options.snapshot) throw new Error('--repo and --snapshot are required');
  return options;
}

function git(repo, args, { allowFailure = false } = {}) {
  try {
    execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      // The persistence flow only uses Git's success/failure, never stdout.
      // Ignore it so verbose hooks/progress cannot hit execFileSync's 1 MiB
      // default maxBuffer, but inherit stderr so diagnostics stay visible.
      stdio: ['ignore', 'ignore', 'inherit'],
      timeout: GIT_TIMEOUT_MS,
      killSignal: 'SIGTERM',
    });
    return true;
  } catch (error) {
    if (allowFailure) return null;
    throw error;
  }
}

function safeError(error) {
  return String(error?.stderr || error?.message || error).replace(/\s+/gu, ' ').replace(/https?:\/\/[^\s]+/gu, '[remote]').slice(0, 280);
}

function readSnapshot(file) {
  if (!existsSync(file)) throw new Error(`snapshot does not exist: ${file}`);
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.posts)) {
    throw new Error('snapshot must contain a posts array');
  }
  return parsed;
}

function cleanupWorktree(repo, worktree, gitFn = git) {
  if (!worktree) return;
  gitFn(repo, ['worktree', 'remove', '--force', worktree], { allowFailure: true });
  if (existsSync(worktree) && worktree.includes(`${path.sep}.insights-worktree-`)) {
    rmSync(worktree, { recursive: true, force: true });
  }
}

function materialize(repo, snapshot, { dryRun = false, gitFn = git } = {}) {
  const root = path.dirname(snapshot);
  const worktree = mkdtempSync(path.join(root, '.insights-worktree-'));
  try {
    gitFn(repo, ['worktree', 'add', '--detach', '--no-checkout', worktree, 'origin/main']);
    gitFn(worktree, ['sparse-checkout', 'init', '--no-cone']);
    gitFn(worktree, ['sparse-checkout', 'set', DATA_PATH]);
    mkdirSync(path.join(worktree, 'data'), { recursive: true });
    const destination = path.join(worktree, DATA_PATH);
    writeFileSync(destination, `${JSON.stringify(readSnapshot(snapshot), null, 2)}\n`, 'utf8');
    gitFn(worktree, ['add', '--', DATA_PATH]);
    const staged = gitFn(worktree, ['diff', '--cached', '--quiet', '--', DATA_PATH], { allowFailure: true });
    if (staged !== null) return { status: 'unchanged', worktree };
    if (dryRun) return { status: 'ready', worktree };
    gitFn(worktree, [
      '-c', 'user.name=frontaliere-mac-automation',
      '-c', 'user.email=automation@frontaliereticino.ch',
      'commit', '-m', 'chore(instagram): record browser Insights snapshot [skip ci]',
    ]);
    return { status: 'committed', worktree };
  } catch (error) {
    cleanupWorktree(repo, worktree, gitFn);
    throw error;
  }
}

function refreshMain(repo, gitFn) {
  try {
    gitFn(repo, [
      '-c', 'http.lowSpeedLimit=1000',
      '-c', 'http.lowSpeedTime=60',
      'fetch', '-q', 'origin', 'main',
    ]);
    return true;
  } catch {
    // A valid, slightly stale origin/main is still useful: the push below can
    // succeed if nobody advanced main, and a rejected push will request a
    // refresh on the next attempt.
    return false;
  }
}

function persistUnlocked({ repo, snapshot, dryRun, attempts, gitFn }) {
  let refreshBeforeAttempt = false;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (refreshBeforeAttempt) {
      refreshMain(repo, gitFn);
      refreshBeforeAttempt = false;
    }
    let result;
    try {
      result = materialize(repo, snapshot, { dryRun, gitFn });
      if (result.status !== 'committed') {
        cleanupWorktree(repo, result.worktree, gitFn);
        return { status: result.status, attempt };
      }
      try {
        gitFn(result.worktree, ['push', 'origin', 'HEAD:main']);
        cleanupWorktree(repo, result.worktree, gitFn);
        return { status: 'pushed', attempt };
      } catch (error) {
        cleanupWorktree(repo, result.worktree, gitFn);
        if (attempt === attempts) throw error;
        refreshBeforeAttempt = true;
      }
    } catch (error) {
      if (result?.worktree) cleanupWorktree(repo, result.worktree, gitFn);
      if (attempt === attempts) throw error;
      refreshBeforeAttempt = true;
    }
  }
  return { status: 'not-pushed' };
}

export function persistBrowserInsights({ repo, snapshot, dryRun = false, attempts = 3, gitFn = git } = {}) {
  readSnapshot(snapshot);
  const lockPath = path.join(path.dirname(snapshot), '.insights-persist.lock');
  const run = withSingleFlightLock(lockPath, () => persistUnlocked({ repo, snapshot, dryRun, attempts, gitFn }));
  return run.acquired ? run.value : { status: 'busy' };
}

function usage() {
  return 'node scripts/social-robot/persist-browser-insights.mjs --repo SITE_CHECKOUT --snapshot STATE_FILE [--dry-run]';
}

if (isInvokedDirectly(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) console.log(usage());
    else console.log(JSON.stringify(persistBrowserInsights(options)));
  } catch (error) {
    console.error(`❌ persist browser Insights: ${safeError(error)}`);
    process.exitCode = 1;
  }
}
