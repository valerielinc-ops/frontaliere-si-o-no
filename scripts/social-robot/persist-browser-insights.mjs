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
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';
import { pushMainWithGuard } from '../lib/main-push-guard.mjs';
import { withSingleFlightLock } from '../lib/single-flight-lock.mjs';
import { sweepStaleFetchPacks } from '../lib/stale-fetch-pack-sweep.mjs';

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

function git(repo, args, { allowFailure = false, env } = {}) {
  try {
    execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      // The persistence flow only uses Git's success/failure, never stdout.
      // Ignore stdout so verbose hooks/progress cannot hit execFileSync's
      // 1 MiB default maxBuffer, but capture stderr so ENOSPC is classified
      // without hiding Git's diagnostic from the launchd log.
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: GIT_TIMEOUT_MS,
      killSignal: 'SIGTERM',
      ...(env ? { env: { ...process.env, ...env } } : {}),
    });
    return true;
  } catch (error) {
    if (error?.stderr) process.stderr.write(String(error.stderr));
    if (allowFailure) return null;
    throw error;
  }
}

function gitOutput(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: GIT_TIMEOUT_MS,
    killSignal: 'SIGTERM',
  }).trim();
}

/**
 * A failed fetch can leave a large tmp_pack_* behind. Git does not prune those
 * files itself, so clear only entries older than the shared safety threshold
 * before asking Git to create another Insights worktree. A live fetch keeps
 * updating its mtime and is never selected.
 */
function sweepRepositoryFetchPacks(repo) {
  try {
    const packDir = path.resolve(repo, gitOutput(repo, ['rev-parse', '--git-path', 'objects/pack']));
    const result = sweepStaleFetchPacks(packDir);
    if (result.removed > 0) {
      process.stderr.write(`🧹 removed ${result.removed} stale fetch pack(s), freeing ${result.bytes} bytes\n`);
    }
  } catch {
    // Storage recovery is best-effort; the persistence operation remains the
    // source of truth and must still fail closed if Git cannot proceed.
  }
}

function isStorageError(error) {
  const text = [error?.code, error?.message, error?.stderr, error?.stdout]
    .filter(Boolean)
    .map(String)
    .join(' ');
  return /\b(?:ENOSPC|No space left on device|disk full|not enough space)\b/i.test(text);
}

function removeStaleInsightWorktrees(root) {
  try {
    for (const name of readdirSync(root)) {
      if (!name.startsWith('.insights-worktree-')) continue;
      const candidate = path.join(root, name);
      if (statSync(candidate).isDirectory()) rmSync(candidate, { recursive: true, force: true });
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function safeError(error) {
  return String(error?.stderr || error?.message || error).replace(/\s+/gu, ' ').replace(/https?:\/\/[^\s]+/gu, '[remote]').slice(0, 280);
}

function mainPushGuardError(error) {
  const wrapped = new Error(`main push guard rejected the candidate: ${safeError(error)}`);
  wrapped.code = 'MAIN_PUSH_GUARD';
  return wrapped;
}

function pushMainCandidate(baseSha, worktree, gitFn) {
  // Tests inject a Git seam that has no real repository. Production always
  // uses the concrete Git function and therefore always runs the shared guard.
  if (gitFn !== git) {
    gitFn(worktree, [
      'push',
      `--force-with-lease=refs/heads/main:${baseSha}`,
      'origin',
      'HEAD:main',
    ], {
      env: { FRONTALIERE_AUTOMATED_DATA_PUSH: 'social-robot-insights' },
    });
    return;
  }
  try {
    pushMainWithGuard({
      repo: worktree,
      base: baseSha,
      candidate: 'HEAD',
      branch: 'main',
      timeoutSeconds: GIT_TIMEOUT_MS / 1000,
      env: { ...process.env, FRONTALIERE_AUTOMATED_DATA_PUSH: 'social-robot-insights' },
    });
  } catch (error) {
    const detail = safeError(error);
    // A non-descendant candidate can be based on a stale origin/main; the
    // outer bounded attempt loop refreshes the base and rebuilds the worktree.
    // Keep actual integrity/proof failures fatal.
    if (/candidate tree collapse|cannot resolve commit|cannot inspect tree|cannot prove ancestry/iu.test(detail)) {
      throw mainPushGuardError(error);
    }
    throw error;
  }
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
  removeStaleInsightWorktrees(root);
  gitFn(repo, ['worktree', 'prune'], { allowFailure: true });
  const worktree = mkdtempSync(path.join(root, '.insights-worktree-'));
  try {
    gitFn(repo, ['worktree', 'add', '--detach', '--no-checkout', worktree, 'origin/main']);
    gitFn(worktree, ['sparse-checkout', 'init', '--no-cone']);
    gitFn(worktree, ['sparse-checkout', 'set', DATA_PATH]);
    // A --no-checkout worktree starts with an empty index. sparse-checkout
    // configures its paths but does not seed that index, so stage only after
    // restoring the complete HEAD tree or the commit would delete every other
    // tracked file from main.
    gitFn(worktree, ['read-tree', '-mu', 'HEAD']);
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
  } catch (error) {
    if (isStorageError(error)) throw error;
    // A valid, slightly stale origin/main is still useful: the push below can
    // succeed if nobody advanced main, and a rejected push will request a
    // refresh on the next attempt.
    return false;
  }
}

function persistUnlocked({ repo, snapshot, dryRun, attempts, gitFn }) {
  let refreshBeforeAttempt = false;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    sweepRepositoryFetchPacks(repo);
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
      let baseSha;
      if (gitFn === git) {
        try {
          baseSha = gitOutput(repo, ['rev-parse', '--verify', 'refs/remotes/origin/main^{commit}']);
        } catch (error) {
          throw mainPushGuardError(error);
        }
      } else {
        // Keep injected Git seams deterministic without bypassing the lease
        // argument that production receives from the real remote ref.
        baseSha = String(gitFn(repo, ['rev-parse', '--verify', 'refs/remotes/origin/main^{commit}']) || '').trim();
      }
      try {
        pushMainCandidate(baseSha, result.worktree, gitFn);
        cleanupWorktree(repo, result.worktree, gitFn);
        return { status: 'pushed', attempt };
      } catch (error) {
        cleanupWorktree(repo, result.worktree, gitFn);
        if (isStorageError(error)) throw error;
        if (attempt === attempts) throw error;
        refreshBeforeAttempt = true;
      }
    } catch (error) {
      if (result?.worktree) cleanupWorktree(repo, result.worktree, gitFn);
      if (error?.code === 'MAIN_PUSH_GUARD') throw error;
      if (isStorageError(error)) throw error;
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
